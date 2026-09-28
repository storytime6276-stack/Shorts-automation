import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Transcript } from "./pipeline";
import { buildCaptionRenderArgs, captionStyle, generateCaptionCues, makeAss, renderCaptionVideo, toAssTime } from "./captions";

function run(bin: string, args: string[], cwd: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(bin, args, { cwd, shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(stdout)) : reject(new Error(`${bin} failed: ${Buffer.concat(stderr).toString("utf8")}`)));
  });
}

test("caption time conversion rounds to ASS centiseconds", () => {
  assert.equal(toAssTime(0), "0:00:00.00");
  assert.equal(toAssTime(62.345), "0:01:02.35");
  assert.equal(toAssTime(3661.2), "1:01:01.20");
});

test("word-timed cues are preferred, segment fallback is per segment, and clip offsets are applied", () => {
  const transcript: Transcript = {
    language: "en", durationSeconds: 12,
    segments: [
      { id: 0, start: 4.7, end: 6.5, text: "How does this work?", words: [
        { word: "How", start: 4.7, end: 5.0, probability: 0.99 },
        { word: "does", start: 5.0, end: 5.25, probability: 0.99 },
        { word: "this", start: 5.3, end: 5.55, probability: 0.99 },
        { word: "work?", start: 5.6, end: 6.05, probability: 0.99 },
      ] },
      { id: 1, start: 6.4, end: 8.2, text: "A safe fallback cue.", words: [] },
    ],
  };
  const cues = generateCaptionCues(transcript, 5, 8);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 0);
  assert.ok(Math.abs(cues[0].end - 1.05) < 1e-9);
  assert.equal(cues[0].text, "does this work?");
  assert.ok(Math.abs(cues[1].start - 1.4) < 1e-9);
  assert.equal(cues[1].end, 3);
  assert.equal(cues[1].text, "A safe fallback cue.");
});

test("caption ASS uses portrait resolution and leaves a bottom safe zone", () => {
  const ass = makeAss([{ start: 0.125, end: 1.25, text: "Keep captions clear and readable." }]);
  assert.equal(captionStyle.width, 1080);
  assert.equal(captionStyle.height, 1920);
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
  assert.match(ass, /Style: Default,Arial,62,.*96,96,320,1/);
  assert.match(ass, /Dialogue: 0,0:00:00\.13,0:00:01\.25/);
  assert.match(buildCaptionRenderArgs("vertical.mp4", "captions.ass", "final.mp4").join(" "), /subtitles=captions\.ass/);
});

test("FFmpeg burns captions into a 1080x1920 MP4 and retains synchronized audio", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shorts-caption-render-test-"));
  const ffmpeg = process.env.FFMPEG_BIN ?? "ffmpeg";
  const ffprobe = process.env.FFPROBE_BIN ?? "ffprobe";
  const input = path.join(root, "vertical.mp4");
  const assFile = path.join(root, "captions.ass");
  const output = path.join(root, "captioned.mp4");
  try {
    await run(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=24:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", input], root);
    await writeFile(assFile, makeAss([{ start: 0.2, end: 1.6, text: "CAPTION BURN TEST" }]), "utf8");
    await renderCaptionVideo(input, assFile, output, ffmpeg);

    const metadata = JSON.parse((await run(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", output], root)).toString("utf8")) as { format: { duration: string }; streams: Array<{ codec_type?: string; width?: number; height?: number }> };
    const video = metadata.streams.find((stream) => stream.codec_type === "video");
    assert.deepEqual([video?.width, video?.height], [1080, 1920]);
    assert.ok(metadata.streams.some((stream) => stream.codec_type === "audio"));
    assert.ok(Math.abs(Number(metadata.format.duration) - 2) < 0.06);

    const captionPixels = await run(ffmpeg, ["-v", "error", "-ss", "0.8", "-i", output, "-vf", "crop=800:360:140:1400,format=gray", "-frames:v", "1", "-f", "rawvideo", "pipe:1"], root);
    assert.ok(captionPixels.some((pixel) => pixel > 200), "the safe-zone frame contains rendered bright caption pixels");
    assert.ok((await readFile(output)).byteLength > 2048);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("caption rendering failure removes partial final output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shorts-caption-failure-test-"));
  const input = path.join(root, "vertical.mp4");
  const assFile = path.join(root, "captions.ass");
  const output = path.join(root, "final.mp4");
  try {
    await writeFile(input, "source");
    await writeFile(assFile, makeAss([{ start: 0, end: 1, text: "test" }]));
    await writeFile(output, "partial output");
    await assert.rejects(renderCaptionVideo(input, assFile, output, "shorts-caption-renderer-that-does-not-exist"), /Unable to start/);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
