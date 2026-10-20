import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export const clipQaTolerances = { clipDurationSeconds: 0.25, audioVideoSeconds: 0.15 } as const;
export type QaCheckStatus = "passed" | "failed" | "skipped";
export type QaCheck = { id: string; label: string; status: QaCheckStatus; message: string; expected?: string | number; actual?: string | number | null };
export type ClipQaMedia = {
  formatName: string | null;
  formatDurationSeconds: number | null;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  videoDurationSeconds: number | null;
  videoFrameCount: number | null;
  audioCodec: string | null;
  audioDurationSeconds: number | null;
  audioPacketCount: number | null;
};
export type ClipQaReport = {
  status: "passed" | "failed";
  validatedAt: string;
  tolerances: typeof clipQaTolerances;
  checks: QaCheck[];
  media: ClipQaMedia | null;
};

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  duration_ts?: number;
  time_base?: string;
  nb_read_frames?: string;
  nb_frames?: string;
  nb_read_packets?: string;
  nb_packets?: string;
};
type ProbeOutput = { format?: { format_name?: string; duration?: string }; streams?: ProbeStream[] };
export type ClipQaOptions = {
  file: string;
  expectedDurationSeconds: number;
  audioRequired: boolean;
  captionsEnabled: boolean;
  captionCueCount: number;
  captionRenderCompleted: boolean;
  captionsFile: string;
  ffmpeg: string;
  ffprobe: string;
};

function invoke(command: string, args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => reject(new Error(`Unable to start ${command}: ${error.message}`)));
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited with code ${code ?? "unknown"}: ${stderr.trim().slice(-1200)}`)));
  });
}

function streamDuration(stream: ProbeStream | undefined): number | null {
  if (!stream) return null;
  const duration = Number(stream.duration);
  if (Number.isFinite(duration) && duration > 0) return duration;
  const ticks = Number(stream.duration_ts);
  const [numerator, denominator] = (stream.time_base ?? "").split("/").map(Number);
  const derived = ticks * numerator / denominator;
  return Number.isFinite(derived) && derived > 0 ? derived : null;
}

function positiveCount(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function check(id: string, label: string, passed: boolean | null, message: string, expected?: string | number, actual?: string | number | null): QaCheck {
  return { id, label, status: passed === null ? "skipped" : passed ? "passed" : "failed", message, ...(expected === undefined ? {} : { expected }), ...(actual === undefined ? {} : { actual }) };
}

export function assessClipQa(media: ClipQaMedia | null, options: Omit<ClipQaOptions, "file" | "captionsFile" | "ffmpeg" | "ffprobe">, validation: { probeError?: string | null; decodeError?: string | null; captionDialogueCount?: number | null }): ClipQaReport {
  const videoExists = !!media?.videoCodec && !!media.videoDurationSeconds && !!media.videoFrameCount;
  const audioExists = !!media?.audioCodec && !!media.audioDurationSeconds && !!media.audioPacketCount;
  const isMp4 = !!media?.formatName?.split(",").includes("mp4");
  const videoDurationAligned = !!media?.videoDurationSeconds && Math.abs(media.videoDurationSeconds - options.expectedDurationSeconds) <= clipQaTolerances.clipDurationSeconds;
  const formatDurationAligned = !!media?.formatDurationSeconds && Math.abs(media.formatDurationSeconds - options.expectedDurationSeconds) <= clipQaTolerances.clipDurationSeconds;
  const durationAligned = videoDurationAligned && formatDurationAligned;
  const avAligned = !!media?.audioDurationSeconds && !!media?.videoDurationSeconds && Math.abs(media.audioDurationSeconds - media.videoDurationSeconds) <= clipQaTolerances.audioVideoSeconds;
  const hasCaptions = options.captionCueCount > 0 && options.captionRenderCompleted && validation.captionDialogueCount === options.captionCueCount;
  const checks = [
    check("container", "Playable MP4 container", media ? isMp4 : false, validation.probeError ?? (isMp4 ? "FFprobe recognized an MP4 container." : `Expected MP4 format; found ${media?.formatName ?? "no readable container"}.`), "mp4", media?.formatName),
    check("video_stream", "Valid video stream", media ? videoExists : false, validation.probeError ?? (videoExists ? `${media.videoCodec} video stream has ${media.videoFrameCount} decoded frames.` : "A video codec, positive duration, and at least one readable frame are required."), "video stream with frames", media?.videoCodec),
    check("resolution", "Vertical output resolution", media ? media.width === 1080 && media.height === 1920 : false, media?.width === 1080 && media.height === 1920 ? "Output is exactly 1080×1920." : `Expected 1080×1920; found ${media?.width ?? "unknown"}×${media?.height ?? "unknown"}.`, "1080×1920", media ? `${media.width ?? "?"}×${media.height ?? "?"}` : null),
    check("audio_stream", "Required audio stream", options.audioRequired ? audioExists : null, options.audioRequired ? (audioExists ? `Audio stream ${media?.audioCodec} is present.` : "The source had audio, but the generated clip does not contain a readable audio stream.") : "Source audio was not required by the existing pipeline; this check is not applicable.", options.audioRequired ? "audio stream" : undefined, media?.audioCodec),
    check("clip_duration", "Clip duration", media ? durationAligned : false, !media?.videoDurationSeconds || !media.formatDurationSeconds ? "Container and video stream durations must both be readable." : durationAligned ? `Container and video duration are within ${clipQaTolerances.clipDurationSeconds}s of the selected clip range.` : `Expected ${options.expectedDurationSeconds.toFixed(3)}s ±${clipQaTolerances.clipDurationSeconds}s; found container ${media.formatDurationSeconds.toFixed(3)}s and video ${media.videoDurationSeconds.toFixed(3)}s.`, `${options.expectedDurationSeconds.toFixed(3)}s ±${clipQaTolerances.clipDurationSeconds}s`, media?.formatDurationSeconds),
    check("av_sync", "Audio/video duration alignment", media?.audioCodec ? avAligned : options.audioRequired ? false : null, media?.audioCodec ? (avAligned ? `Audio and video differ by no more than ${clipQaTolerances.audioVideoSeconds}s.` : `Audio/video difference exceeds ${clipQaTolerances.audioVideoSeconds}s or a stream duration is missing.`) : options.audioRequired ? "Audio is required but missing." : "No audio stream is present; alignment is not applicable.", media?.audioCodec ? `≤${clipQaTolerances.audioVideoSeconds}s` : undefined, media?.audioDurationSeconds && media.videoDurationSeconds ? `${Math.abs(media.audioDurationSeconds - media.videoDurationSeconds).toFixed(3)}s` : null),
    check("captions", "Burned-in captions", options.captionsEnabled ? hasCaptions : null, !options.captionsEnabled ? "Captions were disabled for this clip." : hasCaptions ? `${options.captionCueCount} caption cues were written and FFmpeg burn-in completed.` : `Captions were enabled but rendered cue metadata does not match: ${validation.captionDialogueCount ?? 0}/${options.captionCueCount} cues; render ${options.captionRenderCompleted ? "completed" : "did not complete"}.`, options.captionsEnabled ? options.captionCueCount : undefined, options.captionsEnabled ? validation.captionDialogueCount ?? 0 : undefined),
    check("ffmpeg_decode", "FFmpeg full-file decode", validation.decodeError === undefined || validation.decodeError === null, validation.decodeError ?? "FFmpeg decoded the complete output without errors."),
    check("ffmpeg_render", "FFmpeg rendering", validation.probeError ? false : true, validation.probeError ? `Artifact probing failed: ${validation.probeError}` : "Render pipeline produced an artifact for QA."),
  ];
  return { status: checks.some((item) => item.status === "failed") ? "failed" : "passed", validatedAt: new Date().toISOString(), tolerances: clipQaTolerances, checks, media };
}

export function addPersistedMetadataCheck(report: ClipQaReport, matchesArtifact: boolean, message: string): ClipQaReport {
  const metadataCheck = check("metadata_consistency", "Persisted metadata matches artifact", matchesArtifact, message);
  const checks = [...report.checks, metadataCheck];
  return { ...report, status: checks.some((item) => item.status === "failed") ? "failed" : "passed", checks };
}

export function failedClipQa(stage: string, error: unknown, captionsEnabled: boolean): ClipQaReport {
  const message = error instanceof Error ? error.message : String(error);
  const skipped = "Not run because the clip pipeline failed before final QA.";
  const checks = [
    check("container", "Playable MP4 container", null, skipped),
    check("video_stream", "Valid video stream", null, skipped),
    check("resolution", "Vertical output resolution", null, skipped, "1080×1920"),
    check("audio_stream", "Required audio stream", null, skipped),
    check("clip_duration", "Clip duration", null, skipped),
    check("av_sync", "Audio/video duration alignment", null, skipped),
    check("captions", "Burned-in captions", captionsEnabled ? false : null, captionsEnabled ? (stage === "caption rendering" ? `Caption rendering failed: ${message}` : skipped) : "Captions were disabled for this clip."),
    check("ffmpeg_decode", "FFmpeg full-file decode", null, skipped),
    check("ffmpeg_render", "FFmpeg rendering", false, `${stage} failed: ${message}`),
  ];
  return { status: "failed", validatedAt: new Date().toISOString(), tolerances: clipQaTolerances, checks, media: null };
}

export async function runClipQa(options: ClipQaOptions): Promise<ClipQaReport> {
  let media: ClipQaMedia | null = null;
  let probeError: string | null = null;
  let decodeError: string | null = null;
  let captionDialogueCount: number | null = null;
  const [probeResult, decodeResult, captionResult] = await Promise.allSettled([
    invoke(options.ffprobe, ["-v", "error", "-count_frames", "-count_packets", "-print_format", "json", "-show_format", "-show_streams", options.file], path.dirname(options.file)),
    invoke(options.ffmpeg, ["-hide_banner", "-v", "error", "-xerror", "-i", options.file, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"], path.dirname(options.file)),
    options.captionsEnabled ? fs.readFile(options.captionsFile, "utf8").then((source) => (source.match(/^Dialogue:/gm) ?? []).length) : Promise.resolve(null),
  ]);
  if (probeResult.status === "fulfilled") {
    try {
      const output = JSON.parse(probeResult.value.stdout) as ProbeOutput;
      const video = output.streams?.find((stream) => stream.codec_type === "video");
      const audio = output.streams?.find((stream) => stream.codec_type === "audio");
      media = {
        formatName: output.format?.format_name ?? null,
        formatDurationSeconds: Number.isFinite(Number(output.format?.duration)) ? Number(output.format?.duration) : null,
        videoCodec: video?.codec_name ?? null,
        width: Number.isFinite(Number(video?.width)) ? Number(video?.width) : null,
        height: Number.isFinite(Number(video?.height)) ? Number(video?.height) : null,
        videoDurationSeconds: streamDuration(video),
        videoFrameCount: positiveCount(video?.nb_read_frames ?? video?.nb_frames),
        audioCodec: audio?.codec_name ?? null,
        audioDurationSeconds: streamDuration(audio),
        audioPacketCount: positiveCount(audio?.nb_read_packets ?? audio?.nb_packets),
      };
    } catch (error) { probeError = `FFprobe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`; }
  } else probeError = probeResult.reason instanceof Error ? probeResult.reason.message : String(probeResult.reason);
  if (decodeResult.status === "rejected") decodeError = decodeResult.reason instanceof Error ? decodeResult.reason.message : String(decodeResult.reason);
  if (captionResult.status === "fulfilled") captionDialogueCount = captionResult.value;
  else if (options.captionsEnabled) captionDialogueCount = 0;
  return assessClipQa(media, options, { probeError, decodeError, captionDialogueCount });
}
