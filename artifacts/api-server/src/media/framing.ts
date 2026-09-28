import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SubjectSample = { timeSeconds: number; centerX: number; centerY: number; confidence: number };
export type CropPoint = { timeSeconds: number; x: number; y: number };
export type FramingMode = "subject_tracking" | "center_crop";
export type FramingPlan = {
  mode: FramingMode;
  reason: string | null;
  confidence: number;
  sourceWidth: number;
  sourceHeight: number;
  cropWidth: number;
  cropHeight: number;
  x: number;
  y: number;
  points: CropPoint[];
};
export type SubjectDetectionResult = {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  expectedSampleCount: number;
  samples: SubjectSample[];
};

const targetAspect = 9 / 16;
const minimumConfidence = 0.45;
const minimumSampleCoverage = 0.3;
const smoothingTimeConstant = 1.1;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function computeCropWindow(width: number, height: number, centerX: number, centerY: number) {
  if (![width, height, centerX, centerY].every(Number.isFinite) || width < 2 || height < 2) throw new Error("Frame dimensions and crop center must be finite and positive.");
  let cropWidth: number;
  let cropHeight: number;
  if (width / height > targetAspect) {
    cropHeight = Math.floor(height / 2) * 2;
    cropWidth = Math.max(2, Math.floor((cropHeight * targetAspect) / 2) * 2);
  } else {
    cropWidth = Math.floor(width / 2) * 2;
    cropHeight = Math.max(2, Math.floor((cropWidth / targetAspect) / 2) * 2);
  }
  cropWidth = Math.min(cropWidth, Math.floor(width / 2) * 2);
  cropHeight = Math.min(cropHeight, Math.floor(height / 2) * 2);
  const maxX = Math.max(0, Math.floor((width - cropWidth) / 2) * 2);
  const maxY = Math.max(0, Math.floor((height - cropHeight) / 2) * 2);
  const x = clamp(Math.floor((centerX - cropWidth / 2) / 2) * 2, 0, maxX);
  const y = clamp(Math.floor((centerY - cropHeight / 2) / 2) * 2, 0, maxY);
  return { x, y, cropWidth, cropHeight };
}

export function smoothCropPoints(points: CropPoint[], width: number, height: number, timeConstant = smoothingTimeConstant): CropPoint[] {
  if (points.length === 0) return [];
  const centered = computeCropWindow(width, height, width / 2, height / 2);
  const maxX = Math.max(0, Math.floor((width - centered.cropWidth) / 2) * 2);
  const maxY = Math.max(0, Math.floor((height - centered.cropHeight) / 2) * 2);
  const bound = (value: number, max: number) => clamp(Math.floor(value / 2) * 2, 0, max);
  const ordered = [...points].sort((a, b) => a.timeSeconds - b.timeSeconds);
  const smoothed: CropPoint[] = [];
  for (const point of ordered) {
    const bounded = { x: bound(point.x, maxX), y: bound(point.y, maxY) };
    const previous = smoothed.at(-1);
    if (!previous) {
      smoothed.push({ ...point, x: bounded.x, y: bounded.y });
      continue;
    }
    const delta = Math.max(0, point.timeSeconds - previous.timeSeconds);
    const alpha = 1 - Math.exp(-delta / Math.max(0.01, timeConstant));
    const blended = { x: bound(previous.x + (bounded.x - previous.x) * alpha, maxX), y: bound(previous.y + (bounded.y - previous.y) * alpha, maxY) };
    smoothed.push({ ...point, x: blended.x, y: blended.y });
  }
  return smoothed;
}

function centerFallback(width: number, height: number, reason: string): FramingPlan {
  const safeWidth = Math.max(2, Math.floor(width / 2) * 2);
  const safeHeight = Math.max(2, Math.floor(height / 2) * 2);
  const crop = computeCropWindow(safeWidth, safeHeight, safeWidth / 2, safeHeight / 2);
  return { mode: "center_crop", reason, confidence: 0, sourceWidth: safeWidth, sourceHeight: safeHeight, ...crop, points: [] };
}

export function buildFramingPlan(width: number, height: number, durationSeconds: number, samples: SubjectSample[], expectedSampleCount = samples.length): FramingPlan {
  if (![width, height, durationSeconds].every(Number.isFinite) || width < 2 || height < 2 || durationSeconds <= 0) return centerFallback(Math.max(2, width || 2), Math.max(2, height || 2), "Invalid source video dimensions or duration.");
  const valid = samples.filter((sample) => Number.isFinite(sample.timeSeconds) && sample.timeSeconds >= 0 && sample.timeSeconds <= durationSeconds && Number.isFinite(sample.centerX) && Number.isFinite(sample.centerY) && Number.isFinite(sample.confidence) && sample.confidence >= minimumConfidence && sample.centerX >= 0 && sample.centerX <= 1 && sample.centerY >= 0 && sample.centerY <= 1).sort((a, b) => a.timeSeconds - b.timeSeconds);
  const coverage = valid.length / Math.max(1, expectedSampleCount);
  const confidence = valid.length ? valid.reduce((sum, sample) => sum + sample.confidence, 0) / valid.length : 0;
  if (valid.length < 2 || coverage < minimumSampleCoverage || confidence < minimumConfidence) {
    return centerFallback(width, height, valid.length < 2 ? "Fewer than two reliable subject detections." : "Subject tracking confidence or coverage was too low.");
  }

  const defaultCrop = computeCropWindow(width, height, width / 2, height / 2);
  const points: CropPoint[] = [{ timeSeconds: 0, x: defaultCrop.x, y: defaultCrop.y }];
  for (const sample of valid) {
    const crop = computeCropWindow(width, height, sample.centerX * width, sample.centerY * height);
    const point = { timeSeconds: sample.timeSeconds, x: crop.x, y: crop.y };
    if (sample.timeSeconds === 0) points[0] = point;
    else points.push(point);
  }
  if (points.at(-1)!.timeSeconds < durationSeconds) points.push({ timeSeconds: durationSeconds, x: points.at(-1)!.x, y: points.at(-1)!.y });
  const smoothed = smoothCropPoints(points, width, height);
  return { mode: "subject_tracking", reason: null, confidence, sourceWidth: width, sourceHeight: height, ...defaultCrop, points: smoothed };
}

function expression(points: CropPoint[], fps: number, axis: "x" | "y", max: number) {
  const frames = points.map((point) => ({ n: Math.max(0, Math.round(point.timeSeconds * fps)), value: point[axis] }));
  const unique = frames.filter((point, index) => index === frames.length - 1 || point.n < frames[index + 1].n);
  if (unique.length < 2) return String(unique[0]?.value ?? Math.floor(max / 2 / 2) * 2);
  let result = String(unique.at(-1)!.value);
  for (let index = unique.length - 2; index >= 0; index -= 1) {
    const left = unique[index];
    const right = unique[index + 1];
    const interpolated = `(${left.value}+(${right.value}-${left.value})*(n-${left.n})/${right.n - left.n})`;
    result = `if(lt(n,${right.n}),${interpolated},${result})`;
  }
  const maxEven = Math.max(0, Math.floor(max / 2) * 2);
  return `trunc(max(0,min(${maxEven},${result}))/2)*2`;
}

export function buildFramingFilter(plan: FramingPlan, fps: number, centerCropFilter: string) {
  if (plan.mode !== "subject_tracking" || plan.points.length < 2 || !Number.isFinite(fps) || fps <= 0) return centerCropFilter;
  const x = expression(plan.points, fps, "x", plan.sourceWidth - plan.cropWidth);
  const y = expression(plan.points, fps, "y", plan.sourceHeight - plan.cropHeight);
  return `crop=${plan.cropWidth}:${plan.cropHeight}:x='${x}':y='${y}',scale=1080:1920:flags=lanczos,setsar=1`;
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const trackerScript = process.env.SHORTS_SUBJECT_TRACKER_SCRIPT ?? path.resolve(moduleDirectory, path.basename(moduleDirectory) === "media" ? "track_subject.py" : "media/track_subject.py");

export async function detectSubjectSamples(source: string, start: number, end: number, pythonCommand: string, script = trackerScript): Promise<SubjectDetectionResult> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(pythonCommand, [script, "--input", source, "--start", String(start), "--end", String(end)], { cwd: path.dirname(source), shell: false, windowsHide: true });
    let output = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => reject(new Error(`Unable to start local subject detector: ${error.message}`)));
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(stderr.trim() || `Local subject detector exited with code ${code ?? "unknown"}.`)));
  });
  return JSON.parse(stdout) as SubjectDetectionResult;
}
