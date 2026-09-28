import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  promises as fs,
  type WriteStream,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request } from "express";
import { logger } from "../lib/logger";
import { analyzeAndSave } from "./highlights";

export type JobStatus =
  | "queued"
  | "validating"
  | "extracting_audio"
  | "transcribing"
  | "analyzing_highlights"
  | "completed"
  | "failed";

export type Transcript = {
  jobId?: string;
  language: string;
  durationSeconds: number | null;
  segments: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
    words: Array<{
      word: string;
      start: number;
      end: number;
      probability: number | null;
    }>;
  }>;
};

export type JobRecord = {
  id: string;
  filename: string;
  status: JobStatus;
  progress: number;
  durationSeconds: number | null;
  media: Record<string, unknown> | null;
  transcript: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  paths: {
    directory: string;
    input: string;
    audio: string;
    transcript: string;
    highlights: string;
  };
};

type ProbeResult = {
  format?: {
    duration?: string;
    format_name?: string;
    size?: string;
  };
  streams?: Array<{
    index?: number;
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    channels?: number;
    sample_rate?: string;
  }>;
};

const workspaceRoot = path.resolve(
  process.env.SHORTS_WORKSPACE_DIR ?? path.join(process.cwd(), "shorts-workspace"),
);
const maxUploadBytes = Number(process.env.SHORTS_MAX_UPLOAD_BYTES ?? 4 * 1024 ** 3);
function findPythonCommand() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const relativeCandidates =
    process.platform === "win32"
      ? [
          path.join(".pythonlibs", "Scripts", "python.exe"),
          path.join("..", "..", ".pythonlibs", "Scripts", "python.exe"),
        ]
      : [
          path.join(".pythonlibs", "bin", "python"),
          path.join("..", "..", ".pythonlibs", "bin", "python"),
        ];
  const candidate = relativeCandidates
    .map((relativePath) => path.resolve(process.cwd(), relativePath))
    .find((absolutePath) => existsSync(absolutePath));
  return candidate ?? (process.platform === "win32" ? "python" : "python3");
}

const pythonCommand = findPythonCommand();
const ffprobeCommand = process.env.FFPROBE_BIN ?? "ffprobe";
const ffmpegCommand = process.env.FFMPEG_BIN ?? "ffmpeg";
const whisperModel = process.env.WHISPER_MODEL ?? "small";
const transcriberScript =
  process.env.WHISPER_SCRIPT ??
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "media/transcribe.py",
  );

let queue = Promise.resolve();

function now() {
  return new Date().toISOString();
}

function publicJob(job: JobRecord) {
  const { paths: _paths, ...response } = job;
  return response;
}

function safeFilename(filename: string) {
  const normalized = filename
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/[^\w.\- ]/g, "_")
    .trim();
  return normalized || "upload.mp4";
}

async function writeJob(job: JobRecord) {
  const metadataPath = path.join(job.paths.directory, "job.json");
  const temporaryPath = `${metadataPath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(job, null, 2), "utf8");
  await fs.rename(temporaryPath, metadataPath);
}

async function setJob(job: JobRecord, changes: Partial<JobRecord>) {
  Object.assign(job, changes, { updatedAt: now() });
  await writeJob(job);
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  onStdout?: (line: string) => void,
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (onStdout) {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim()) onStdout(line.trim());
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Unable to start ${command}. Install it or set its *_BIN environment variable. ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(
          new Error(
            `${command} exited with code ${code ?? "unknown"}${stderr ? `: ${stderr.trim().slice(-1200)}` : ""}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function probeVideo(input: string) {
  const { stdout } = await runCommand(
    ffprobeCommand,
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      input,
    ],
    path.dirname(input),
  );
  const probe = JSON.parse(stdout) as ProbeResult;
  const streams = probe.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (!video) {
    throw new Error("The upload does not contain a readable video stream.");
  }
  if (!audio) {
    throw new Error("The video does not contain an audio stream to transcribe.");
  }

  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("The video duration could not be read.");
  }

  return {
    duration,
    format: probe.format?.format_name ?? null,
    sizeBytes: Number(probe.format?.size) || null,
    video: {
      codec: video.codec_name ?? null,
      width: video.width ?? null,
      height: video.height ?? null,
      frameRate: video.r_frame_rate ?? null,
    },
    audio: {
      codec: audio.codec_name ?? null,
      channels: audio.channels ?? null,
      sampleRate: audio.sample_rate ?? null,
    },
  };
}

async function processJob(job: JobRecord) {
  try {
    await setJob(job, {
      status: "validating",
      progress: 10,
      error: null,
    });
    const media = await probeVideo(job.paths.input);
    await setJob(job, {
      status: "validating",
      progress: 20,
      durationSeconds: media.duration,
      media,
    });

    await setJob(job, {
      status: "extracting_audio",
      progress: 25,
    });
    await runCommand(
      ffmpegCommand,
      [
        "-y",
        "-i",
        job.paths.input,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        job.paths.audio,
      ],
      job.paths.directory,
    );

    await setJob(job, {
      status: "transcribing",
      progress: 45,
    });
    await runCommand(
      pythonCommand,
      [
        transcriberScript,
        "--input",
        job.paths.audio,
        "--output",
        job.paths.transcript,
        "--model",
        whisperModel,
      ],
      job.paths.directory,
      async (line) => {
        try {
          const event = JSON.parse(line) as {
            type?: string;
            progress?: number;
          };
          if (event.type === "progress" && typeof event.progress === "number") {
            await setJob(job, {
              status: "transcribing",
              progress: Math.min(99, Math.max(45, 45 + event.progress * 0.5)),
            });
          }
        } catch {
          // Ignore non-JSON progress output from the local runtime.
        }
      },
    );
    const transcript = JSON.parse(
      await fs.readFile(job.paths.transcript, "utf8"),
    ) as Transcript;
    const wordCount = transcript.segments.reduce(
      (count, segment) => count + segment.words.length,
      0,
    );
    await setJob(job, {
      status: "analyzing_highlights",
      progress: 90,
    });
    const analysis = await analyzeAndSave(
      job.id,
      transcript,
      job.paths.highlights,
    );

    await setJob(job, {
      status: "completed",
      progress: 100,
      transcript: {
        language: transcript.language,
        segmentCount: transcript.segments.length,
        wordCount,
        path: "transcript.json",
        highlightCount: analysis.candidates.length,
        highlightsPath: "highlights.json",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setJob(job, {
      status: "failed",
      progress: 100,
      error: message,
    });
    logger.error({ jobId: job.id, err: error }, "Video processing failed");
  }
}

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.load();
  }

  private async load() {
    await fs.mkdir(workspaceRoot, { recursive: true });
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            const metadataPath = path.join(workspaceRoot, entry.name, "job.json");
            const job = JSON.parse(await fs.readFile(metadataPath, "utf8")) as JobRecord;
            job.paths.highlights ??= path.join(job.paths.directory, "highlights.json");
            if (job.status !== "completed" && job.status !== "failed") {
              job.status = "failed";
              job.progress = 100;
              job.error = "The server restarted before this job finished.";
              job.updatedAt = now();
              await writeJob(job);
            }
            this.jobs.set(job.id, job);
          } catch {
            // Ignore incomplete job directories.
          }
        }),
    );
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(publicJob);
  }

  get(id: string) {
    const job = this.jobs.get(id);
    return job ? publicJob(job) : undefined;
  }

  getRecord(id: string) {
    return this.jobs.get(id);
  }

  async create(filename: string, request: Request) {
    const id = randomUUID();
    const directory = path.join(workspaceRoot, id);
    const input = path.join(directory, "input", safeFilename(filename));
    const audio = path.join(directory, "audio.wav");
    const transcript = path.join(directory, "transcript.json");
    const highlights = path.join(directory, "highlights.json");
    const job: JobRecord = {
      id,
      filename: safeFilename(filename),
      status: "queued",
      progress: 0,
      durationSeconds: null,
      media: null,
      transcript: null,
      error: null,
      createdAt: now(),
      updatedAt: now(),
      paths: { directory, input, audio, transcript, highlights },
    };

    await fs.mkdir(path.dirname(input), { recursive: true });
    await this.writeUpload(request, input);
    this.jobs.set(id, job);
    await writeJob(job);
    queue = queue.then(() => processJob(job));
    return publicJob(job);
  }

  private async writeUpload(request: Request, destination: string) {
    const contentLength = Number(request.header("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxUploadBytes) {
      throw new Error(`Upload is larger than the ${Math.round(maxUploadBytes / 1024 ** 3)} GB limit.`);
    }

    await new Promise<void>((resolve, reject) => {
      const output: WriteStream = createWriteStream(destination, { flags: "wx" });
      let bytes = 0;
      let finished = false;
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        request.destroy();
        output.destroy();
        void fs.rm(destination, { force: true }).finally(() => reject(error));
      };
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxUploadBytes) {
          fail(new Error(`Upload is larger than the ${Math.round(maxUploadBytes / 1024 ** 3)} GB limit.`));
        }
      });
      request.on("error", fail);
      output.on("error", fail);
      output.on("finish", () => {
        if (finished) return;
        finished = true;
        resolve();
      });
      request.pipe(output);
    });
  }
}

export const jobStore = new JobStore();