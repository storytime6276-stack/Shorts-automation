import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { HighlightCandidate } from "./highlights";
import type { Transcript } from "./pipeline";
import { generateCaptionCues, makeAss, renderCaptionVideo, type CaptionCue } from "./captions";

export type ClipStatus = "queued" | "extracting" | "preparing_vertical" | "rendering_captions" | "ready" | "failed";
export type CaptionStatus = "not_requested" | "queued" | "rendering" | "ready" | "unavailable" | "failed";
export type GeneratedClip = {
  id: string;
  candidateId: string;
  status: ClipStatus;
  progress: number;
  start: number;
  end: number;
  sourceDurationSeconds: number;
  extractedDurationSeconds: number | null;
  width: number | null;
  height: number | null;
  previewUrl: string | null;
  verticalUrl: string | null;
  finalUrl: string | null;
  captionsEnabled: boolean;
  captionStatus: CaptionStatus;
  captionCueCount: number;
  captionCues: CaptionCue[];
  captionError: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type ClipManifest = { clips: GeneratedClip[] };
const manifestWrites = new Map<string, Promise<void>>();
const ffmpeg = process.env.FFMPEG_BIN ?? "ffmpeg";
const ffprobe = process.env.FFPROBE_BIN ?? "ffprobe";
export const verticalOutput = { width: 1080, height: 1920 } as const;
export const centerCropFilter = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(in_w-1080)/2:(in_h-1920)/2,setsar=1";

function manifestPath(jobDirectory: string) {
  return path.join(jobDirectory, "clips.json");
}

async function saveManifest(jobDirectory: string, manifest: ClipManifest) {
  const target = manifestPath(jobDirectory);
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(manifest, null, 2), "utf8");
  await fs.rename(temporary, target);
}

export async function readClips(jobDirectory: string): Promise<GeneratedClip[]> {
  try {
    return ((JSON.parse(await fs.readFile(manifestPath(jobDirectory), "utf8")) as ClipManifest).clips ?? []);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => reject(new Error(`Unable to start ${command}: ${error.message}`)));
    child.on("close", (code) => code === 0 ? resolve(stderr) : reject(new Error(`${command} exited with code ${code ?? "unknown"}${stderr ? `: ${stderr.trim().slice(-1200)}` : ""}`)));
  });
}

async function probe(input: string, command = ffprobe) {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input], { cwd: path.dirname(input), shell: false, windowsHide: true });
    let output = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => reject(new Error(`Unable to start ${command}: ${error.message}`)));
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`ffprobe exited with code ${code ?? "unknown"}: ${stderr.trim()}`)));
  });
  return JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
}

function timestamp(value: number) { return value.toFixed(6); }

export function buildClipArgs(input: string, output: string, start: number, end: number, vertical: boolean) {
  const args = ["-y", "-ss", timestamp(start), "-i", input, "-t", timestamp(end - start), "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20"];
  if (vertical) args.push("-vf", centerCropFilter);
  args.push("-c:a", "aac", "-b:a", "160k", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", output);
  return args;
}

async function update(jobDirectory: string, clip: GeneratedClip, patch: Partial<GeneratedClip>) {
  const previous = manifestWrites.get(jobDirectory) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    Object.assign(clip, patch, { updatedAt: new Date().toISOString() });
    const clips = await readClips(jobDirectory);
    const index = clips.findIndex((item) => item.id === clip.id);
    if (index < 0) clips.push(clip); else clips[index] = clip;
    await saveManifest(jobDirectory, { clips });
  });
  manifestWrites.set(jobDirectory, operation);
  try {
    await operation;
  } finally {
    if (manifestWrites.get(jobDirectory) === operation) manifestWrites.delete(jobDirectory);
  }
}

export async function createClip(jobId: string, jobDirectory: string, source: string, candidate: HighlightCandidate, sourceDuration: number | null, transcript: Transcript, captionsEnabled = true, commands = { ffmpeg, ffprobe }): Promise<GeneratedClip> {
  if (!existsSync(source)) throw new Error("The source video no longer exists.");
  if (!Number.isFinite(candidate.start) || !Number.isFinite(candidate.end) || candidate.start < 0 || candidate.end <= candidate.start) throw new Error("Candidate timestamps must be finite, non-negative, and end after start.");
  const info = await probe(source, commands.ffprobe);
  const actualDuration = Number(info.format?.duration);
  if (!Number.isFinite(actualDuration) || actualDuration <= 0) throw new Error("The source video duration could not be read.");
  if (candidate.end > actualDuration + 0.05) throw new Error("Candidate end timestamp exceeds the source video duration.");
  const captionCues = captionsEnabled ? generateCaptionCues(transcript, candidate.start, candidate.end) : [];
  const id = randomUUID();
  const directory = path.join(jobDirectory, "clips", id);
  await fs.mkdir(directory, { recursive: true });
  const clip: GeneratedClip = {
    id, candidateId: candidate.id, status: "queued", progress: 0,
    start: candidate.start, end: candidate.end,
    sourceDurationSeconds: sourceDuration ?? actualDuration,
    extractedDurationSeconds: null, width: null, height: null,
    previewUrl: null, verticalUrl: null, finalUrl: null,
    captionsEnabled,
    captionStatus: !captionsEnabled ? "not_requested" : captionCues.length ? "queued" : "unavailable",
    captionCueCount: captionCues.length,
    captionCues,
    captionError: captionsEnabled && !captionCues.length ? "No timestamped transcript cues overlap this clip." : null,
    error: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await update(jobDirectory, clip, {});
  void generate(jobId, jobDirectory, source, directory, clip, commands);
  return clip;
}

async function generate(jobId: string, jobDirectory: string, source: string, directory: string, clip: GeneratedClip, commands: { ffmpeg: string; ffprobe: string }) {
  const preview = path.join(directory, "preview.mp4");
  const vertical = path.join(directory, "vertical.mp4");
  const captions = path.join(directory, "captions.ass");
  const final = path.join(directory, "final.mp4");
  let renderingCaptions = false;
  try {
    await update(jobDirectory, clip, { status: "extracting", progress: 10 });
    await run(commands.ffmpeg, buildClipArgs(source, preview, clip.start, clip.end, false), directory);
    await update(jobDirectory, clip, { status: "preparing_vertical", progress: 55 });
    await run(commands.ffmpeg, buildClipArgs(source, vertical, clip.start, clip.end, true), directory);
    if (clip.captionsEnabled && clip.captionCueCount > 0) {
      renderingCaptions = true;
      await update(jobDirectory, clip, { status: "rendering_captions", progress: 78, captionStatus: "rendering" });
      await fs.writeFile(captions, makeAss(clip.captionCues), "utf8");
      await renderCaptionVideo(vertical, captions, final, commands.ffmpeg);
      await update(jobDirectory, clip, { captionStatus: "ready", captionError: null });
    } else {
      await fs.copyFile(vertical, final);
    }
    const output = await probe(final, commands.ffprobe);
    const duration = Number(output.format?.duration);
    const video = output.streams?.find((stream) => stream.codec_type === "video");
    if (!video?.width || !video.height || video.width !== verticalOutput.width || video.height !== verticalOutput.height) throw new Error("FFmpeg did not produce the expected 1080x1920 vertical video.");
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("FFmpeg produced a vertical video with an invalid duration.");
    await update(jobDirectory, clip, { status: "ready", progress: 100, extractedDurationSeconds: duration, width: video.width, height: video.height, previewUrl: `/api/jobs/${jobId}/clips/${clip.id}/preview`, verticalUrl: `/api/jobs/${jobId}/clips/${clip.id}/vertical`, finalUrl: `/api/jobs/${jobId}/clips/${clip.id}/final`, captionStatus: clip.captionCueCount ? "ready" : clip.captionStatus, error: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await Promise.all([fs.rm(preview, { force: true }), fs.rm(vertical, { force: true }), fs.rm(final, { force: true }), fs.rm(captions, { force: true })]);
    await fs.rm(directory, { recursive: true, force: true });
    await update(jobDirectory, clip, { status: "failed", progress: 100, error: message, captionStatus: renderingCaptions ? "failed" : clip.captionStatus, captionError: renderingCaptions ? message : clip.captionError, previewUrl: null, verticalUrl: null, finalUrl: null });
  }
}

export function clipFilePath(jobDirectory: string, clipId: string, variant: "preview" | "vertical" | "final") {
  return path.join(jobDirectory, "clips", clipId, `${variant}.mp4`);
}
