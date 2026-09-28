import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { HighlightCandidate } from "./highlights";
import { buildClipArgs, centerCropFilter, clipFilePath, createClip, readClips, verticalOutput, type GeneratedClip } from "./clips";

function command(bin: string, args: string[], cwd: string) {
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

function candidate(start: number, end: number): HighlightCandidate {
  return { id: "candidate-1", jobId: "job-1", rank: 1, start, end, score: 80, text: "Synthetic test candidate.", reasons: [], signals: {} as HighlightCandidate["signals"], sourceSegmentIds: [], updatedAt: new Date().toISOString() };
}

async function waitForClip(directory: string, id: string): Promise<GeneratedClip> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const clip = (await readClips(directory)).find((item) => item.id === id);
    if (clip?.status === "ready" || clip?.status === "failed") return clip;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Clip generation did not finish within 30 seconds.");
}

test("clip extraction validates intervals, persists metadata, and creates a real vertical MP4", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shorts-clips-test-"));
  const jobDirectory = path.join(root, "job");
  const source = path.join(root, "synthetic-source.mp4");
  const ffmpeg = process.env.FFMPEG_BIN ?? "ffmpeg";
  const ffprobe = process.env.FFPROBE_BIN ?? "ffprobe";
  await (await import("node:fs/promises")).mkdir(jobDirectory, { recursive: true });
  try {
    await command(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=8", "-f", "lavfi", "-i", "sine=frequency=1000:duration=8", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", source], root);

    await t.test("candidate timestamps become the precise FFmpeg interval", () => {
      const args = buildClipArgs(source, path.join(root, "out.mp4"), 2.25, 5.25, false);
      assert.deepEqual(args.slice(0, 8), ["-y", "-ss", "2.250000", "-i", source, "-t", "3.000000", "-map"]);
    });
    await t.test("missing source and invalid timestamps are rejected", async () => {
      await assert.rejects(createClip("job-1", jobDirectory, path.join(root, "missing.mp4"), candidate(1, 2), 8), /source video no longer exists/);
      await assert.rejects(createClip("job-1", jobDirectory, source, candidate(2, 2), 8), /timestamps must be finite/);
      await assert.rejects(createClip("job-1", jobDirectory, source, candidate(-1, 2), 8), /timestamps must be finite/);
      await assert.rejects(createClip("job-1", jobDirectory, source, candidate(1, 9), 8), /exceeds the source video duration/);
    });
    await t.test("9:16 output uses deterministic center-crop settings", () => {
      const args = buildClipArgs(source, path.join(root, "vertical.mp4"), 2.25, 5.25, true);
      assert.deepEqual(verticalOutput, { width: 1080, height: 1920 });
      assert.equal(args[args.indexOf("-vf") + 1], centerCropFilter);
      assert.ok(args.includes("0:a?"), "original audio is mapped when present");
    });
    await t.test("real extraction preserves timestamps, audio, and persists generated metadata", async () => {
      const created = await createClip("job-1", jobDirectory, source, candidate(2.25, 5.25), 8);
      const clip = await waitForClip(jobDirectory, created.id);
      assert.equal(clip.status, "ready", clip.error ?? "clip should be ready");
      assert.equal(clip.progress, 100);
      assert.ok(Math.abs((clip.extractedDurationSeconds ?? 0) - 3) <= 0.08, `expected about 3 seconds, got ${clip.extractedDurationSeconds}`);
      assert.deepEqual([clip.width, clip.height], [1080, 1920]);
      assert.ok(clip.previewUrl?.endsWith("/preview"));
      assert.ok(clip.verticalUrl?.endsWith("/vertical"));
      const saved = (await readClips(jobDirectory)).find((item) => item.id === created.id);
      assert.deepEqual(saved, clip);
      const verticalFile = clipFilePath(jobDirectory, clip.id, "vertical");
      const details = JSON.parse(await command(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", verticalFile], jobDirectory)) as { format: { duration: string }; streams: Array<{ codec_type?: string; width?: number; height?: number }> };
      assert.deepEqual([details.streams.find((stream) => stream.codec_type === "video")?.width, details.streams.find((stream) => stream.codec_type === "video")?.height], [1080, 1920]);
      assert.ok(details.streams.some((stream) => stream.codec_type === "audio"), "generated clip retains audio");
      assert.ok(Math.abs(Number(details.format.duration) - 3) <= 0.08);
      assert.ok((await readFile(verticalFile)).byteLength > 1024);
    });
    await t.test("FFmpeg failure is persisted and partial files are cleaned", async () => {
      const created = await createClip("job-1", jobDirectory, source, candidate(1, 2), 8, { ffmpeg: "shorts-test-ffmpeg-that-does-not-exist", ffprobe });
      const clip = await waitForClip(jobDirectory, created.id);
      assert.equal(clip.status, "failed");
      assert.match(clip.error ?? "", /Unable to start/);
      assert.equal(clip.previewUrl, null);
      assert.equal(clip.verticalUrl, null);
      await assert.rejects(readFile(clipFilePath(jobDirectory, clip.id, "preview")), { code: "ENOENT" });
      assert.equal((await readClips(jobDirectory)).find((item) => item.id === clip.id)?.status, "failed");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
