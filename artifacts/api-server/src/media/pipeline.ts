import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  promises as fs,
  type WriteStream,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request } from "express";
import { logger } from "../lib/logger";
import { analyzeAndSave, readAnalysis } from "./highlights";

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
  contentHash?: string;
  idempotencyKey?: string;
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
          path.join("..", "..", ".venv", "Scripts", "python.exe"),
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
export function getLocalPythonCommand() { return pythonCommand; }
const ffprobeCommand = process.env.FFPROBE_BIN ?? "ffprobe";
const ffmpegCommand = process.env.FFMPEG_BIN ?? "ffmpeg";
const whisperModel = process.env.WHISPER_MODEL ?? "small";
const jobWrites = new Map<string, Promise<void>>();
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const transcriberScript = process.env.WHISPER_SCRIPT ?? path.resolve(moduleDirectory, path.basename(moduleDirectory) === "media" ? "transcribe.py" : "media/transcribe.py");

const ffmpegThreads = Math.min(4, Math.max(1, Number(process.env.SHORTS_FFMPEG_THREADS) || 2));

function now() {
  return new Date().toISOString();
}

function publicJob(job: JobRecord) {
  const { paths: _paths, contentHash: _contentHash, idempotencyKey: _idempotencyKey, ...response } = job;
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
  const previous = jobWrites.get(job.id) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    Object.assign(job, changes, { updatedAt: now() });
    await writeJob(job);
  });
  jobWrites.set(job.id, operation);
  try { await operation; }
  finally { if (jobWrites.get(job.id) === operation) jobWrites.delete(job.id); }
}

async function hashFile(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function validTranscript(value: unknown): value is Transcript {
  const transcript = value as Partial<Transcript> | null;
  return !!transcript && typeof transcript.language === "string" && Array.isArray(transcript.segments)
    && transcript.segments.every((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && typeof segment.text === "string" && Array.isArray(segment.words));
}

async function readReusableTranscript(file: string) {
  try {
    const transcript: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return validTranscript(transcript) ? transcript : null;
  } catch { return null; }
}

async function readReusableAnalysis(file: string, jobId: string) {
  try {
    const analysis = await readAnalysis(file);
    return analysis.jobId === jobId && Array.isArray(analysis.candidates) ? analysis : null;
  } catch { return null; }
}

export async function readReusableArtifacts(job: JobRecord) {
  const transcript = await readReusableTranscript(job.paths.transcript);
  const analysis = transcript ? await readReusableAnalysis(job.paths.highlights, job.id) : null;
  return { transcript, analysis };
}

async function hasValidAudio(file: string, cwd: string) {
  try {
    const { stdout } = await runCommand(ffprobeCommand, ["-v", "error", "-show_entries", "stream=codec_type", "-show_entries", "format=duration", "-print_format", "json", file], cwd);
    const probe = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }>; format?: { duration?: string } };
    return probe.streams?.some((stream) => stream.codec_type === "audio") === true && Number(probe.format?.duration) > 0;
  } catch { return false; }
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

    const reusable = await readReusableArtifacts(job);
    let transcript = reusable.transcript;
    if (!transcript) {
      const audioValid = await hasValidAudio(job.paths.audio, job.paths.directory);
      if (!audioValid) {
        await setJob(job, { status: "extracting_audio", progress: 25 });
        await fs.rm(job.paths.audio, { force: true });
        await runCommand(ffmpegCommand, ["-y", "-i", job.paths.input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-threads", String(ffmpegThreads), job.paths.audio], job.paths.directory);
      }

      await setJob(job, { status: "transcribing", progress: 45 });
      await runCommand(pythonCommand, [transcriberScript, "--input", job.paths.audio, "--output", job.paths.transcript, "--model", whisperModel], job.paths.directory, async (line) => {
        try {
          const event = JSON.parse(line) as { type?: string; progress?: number };
          if (event.type === "progress" && typeof event.progress === "number") {
            await setJob(job, { status: "transcribing", progress: Math.min(99, Math.max(45, 45 + event.progress * 0.5)) });
          }
        } catch { /* Ignore non-JSON progress output from the local runtime. */ }
      });
      transcript = await readReusableTranscript(job.paths.transcript);
      if (!transcript) throw new Error("Transcription finished without a valid persisted transcript.");
    }
    const wordCount = transcript.segments.reduce(
      (count, segment) => count + segment.words.length,
      0,
    );
    await setJob(job, { transcript: { language: transcript.language, segmentCount: transcript.segments.length, wordCount, path: "transcript.json" } });
    let analysis = reusable.analysis;
    if (!analysis) {
      await setJob(job, { status: "analyzing_highlights", progress: 90 });
      analysis = await analyzeAndSave(job.id, transcript, job.paths.highlights);
    }

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
  private queue = Promise.resolve();
  private registration = Promise.resolve();
  private readonly contentHashes = new Map<string, string>();
  private readonly idempotencyKeys = new Map<string, string>();
  private readonly workspace: string;
  private readonly processor: (job: JobRecord) => Promise<void>;
  readonly ready: Promise<void>;

  constructor(workspace = workspaceRoot, processor = processJob) {
    this.workspace = workspace;
    this.processor = processor;
    this.ready = this.load();
  }

  private enqueue(job: JobRecord) {
    this.queue = this.queue.then(() => this.processor(job)).catch(async (error) => {
      await setJob(job, { status: "failed", progress: 100, error: error instanceof Error ? error.message : String(error) });
    });
  }

  async waitForIdle() { await this.queue; }

  private async load() {
    await fs.mkdir(this.workspace, { recursive: true });
    const entries = await fs.readdir(this.workspace, { withFileTypes: true });
    const interrupted: JobRecord[] = [];
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
          try {
            const metadataPath = path.join(this.workspace, entry.name, "job.json");
            const job = JSON.parse(await fs.readFile(metadataPath, "utf8")) as JobRecord;
            job.paths.highlights ??= path.join(job.paths.directory, "highlights.json");
            if (job.status !== "completed" && job.status !== "failed") {
              job.status = "queued";
              job.progress = Math.min(95, job.progress);
              job.error = null;
              job.updatedAt = now();
              await writeJob(job);
              interrupted.push(job);
            }
            this.jobs.set(job.id, job);
            if (job.contentHash) this.contentHashes.set(job.contentHash, job.id);
            if (job.idempotencyKey) this.idempotencyKeys.set(job.idempotencyKey, job.id);
          } catch {
            // Ignore incomplete job directories.
          }
        }));
    interrupted.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).forEach((job) => this.enqueue(job));
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
    const directory = path.join(this.workspace, id);
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
    const contentHash = await hashFile(input);
    const rawIdempotencyKey = request.header("Idempotency-Key")?.trim();
    const idempotencyKey = rawIdempotencyKey && rawIdempotencyKey.length <= 200 ? rawIdempotencyKey : undefined;
    const previousRegistration = this.registration;
    let releaseRegistration!: () => void;
    const registrationDone = new Promise<void>((resolve) => { releaseRegistration = resolve; });
    this.registration = previousRegistration.then(() => registrationDone);
    await previousRegistration;
    try {
      const duplicateId = (idempotencyKey ? this.idempotencyKeys.get(idempotencyKey) : undefined) ?? this.contentHashes.get(contentHash);
      if (duplicateId) {
        await fs.rm(directory, { recursive: true, force: true });
        const existing = this.jobs.get(duplicateId);
        if (existing) return publicJob(existing);
      }
      job.contentHash = contentHash;
      job.idempotencyKey = idempotencyKey;
      this.jobs.set(id, job);
      await writeJob(job);
      this.contentHashes.set(contentHash, id);
      if (idempotencyKey) this.idempotencyKeys.set(idempotencyKey, id);
      this.enqueue(job);
      return publicJob(job);
    } finally {
      releaseRegistration();
    }
  }

  async retry(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.status !== "failed") return undefined;
    await setJob(job, { status: "queued", progress: 0, error: null });
    this.enqueue(job);
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
