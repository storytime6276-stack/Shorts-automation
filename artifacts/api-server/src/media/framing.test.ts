import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFramingFilter, buildFramingPlan, computeCropWindow, smoothCropPoints, type SubjectSample } from "./framing";
import { centerCropFilter, verticalOutput } from "./clips";

function run(bin: string, args: string[], cwd: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${bin} failed: ${stderr}`)));
  });
}

test("crop calculation produces a centered 9:16 crop and respects source boundaries", () => {
  const centered = computeCropWindow(1920, 1080, 960, 540);
  assert.equal(centered.cropHeight, 1080);
  assert.ok(Math.abs(centered.cropWidth / centered.cropHeight - 9 / 16) < 0.002);
  assert.equal(centered.x % 2, 0);
  assert.equal(centered.x, Math.floor((1920 - centered.cropWidth) / 4) * 2);

  const rightEdge = computeCropWindow(1920, 1080, 1920, 1080);
  const bottomEdge = computeCropWindow(1080, 1920, 1080, 1920);
  assert.ok(rightEdge.x + rightEdge.cropWidth <= 1920);
  assert.ok(rightEdge.y + rightEdge.cropHeight <= 1080);
  assert.ok(bottomEdge.x + bottomEdge.cropWidth <= 1080);
  assert.ok(bottomEdge.y + bottomEdge.cropHeight <= 1920);
  assert.deepEqual(bottomEdge, computeCropWindow(1080, 1920, 1080, 1920));
});

test("crop coordinate smoothing reduces sudden movement deterministically", () => {
  const raw = [{ timeSeconds: 0, x: 656, y: 0 }, { timeSeconds: 1, x: 1314, y: 0 }];
  const first = smoothCropPoints(raw, 1920, 1080);
  const second = smoothCropPoints(raw, 1920, 1080);
  assert.deepEqual(first, second);
  assert.ok(first[1].x - first[0].x < raw[1].x - raw[0].x);
  assert.ok(first[1].x > first[0].x);
});

test("low-confidence or sparse tracking falls back to the existing center crop", () => {
  const oneDetection: SubjectSample[] = [{ timeSeconds: 0.5, centerX: 0.2, centerY: 0.5, confidence: 0.95 }];
  const plan = buildFramingPlan(1920, 1080, 5, oneDetection, 5);
  assert.equal(plan.mode, "center_crop");
  assert.match(plan.reason ?? "", /two reliable/);
  assert.equal(buildFramingFilter(plan, 30, centerCropFilter), centerCropFilter);

  const weak = buildFramingPlan(1920, 1080, 5, [
    { timeSeconds: 0, centerX: 0.2, centerY: 0.5, confidence: 0.4 },
    { timeSeconds: 2, centerX: 0.25, centerY: 0.5, confidence: 0.42 },
  ], 5);
  assert.equal(weak.mode, "center_crop");
});

test("reliable detections make a smoothed, clamped tracking plan", () => {
  const samples: SubjectSample[] = [
    { timeSeconds: 0, centerX: 0.25, centerY: 0.5, confidence: 0.8 },
    { timeSeconds: 1, centerX: 0.55, centerY: 0.5, confidence: 0.9 },
    { timeSeconds: 2, centerX: 0.98, centerY: 0.5, confidence: 0.85 },
  ];
  const plan = buildFramingPlan(1920, 1080, 3, samples, 3);
  assert.equal(plan.mode, "subject_tracking");
  assert.ok(plan.points.every((point) => point.x >= 0 && point.x + plan.cropWidth <= 1920 && point.x % 2 === 0));
  assert.ok(plan.points.every((point) => point.y >= 0 && point.y + plan.cropHeight <= 1080 && point.y % 2 === 0));
  assert.ok(plan.confidence >= 0.8);
  assert.notEqual(buildFramingFilter(plan, 24, centerCropFilter), centerCropFilter);
});

test("FFmpeg renders the tracked crop as synchronized 1080x1920 video", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shorts-framing-render-test-"));
  const ffmpeg = process.env.FFMPEG_BIN ?? "ffmpeg";
  const ffprobe = process.env.FFPROBE_BIN ?? "ffprobe";
  const input = path.join(root, "moving-subject.mp4");
  const output = path.join(root, "tracked-vertical.mp4");
  try {
    await run(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", input], root);
    const plan = buildFramingPlan(640, 360, 2, [
      { timeSeconds: 0, centerX: 0.2, centerY: 0.5, confidence: 0.9 },
      { timeSeconds: 1, centerX: 0.8, centerY: 0.5, confidence: 0.9 },
      { timeSeconds: 2, centerX: 0.85, centerY: 0.5, confidence: 0.9 },
    ], 3);
    const filter = buildFramingFilter(plan, 24, centerCropFilter);
    await run(ffmpeg, ["-y", "-i", input, "-vf", filter, "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", output], root);
    const probe = JSON.parse(await run(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", output], root)) as { format: { duration: string }; streams: Array<{ codec_type?: string; width?: number; height?: number }> };
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    assert.deepEqual([video?.width, video?.height], [verticalOutput.width, verticalOutput.height]);
    assert.ok(probe.streams.some((stream) => stream.codec_type === "audio"));
    assert.ok(Math.abs(Number(probe.format.duration) - 2) < 0.06);
    assert.ok((await readFile(output)).byteLength > 2048);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
