import assert from "node:assert/strict";
import test from "node:test";
import { addPersistedMetadataCheck, assessClipQa, clipQaTolerances, type ClipQaMedia } from "./qa";

const options = { expectedDurationSeconds: 3, audioRequired: true, captionsEnabled: true, captionCueCount: 2, captionRenderCompleted: true };
const validMedia: ClipQaMedia = {
  formatName: "mov,mp4,m4a,3gp,3g2,mj2",
  formatDurationSeconds: 3.02,
  videoCodec: "h264", width: 1080, height: 1920, videoDurationSeconds: 3,
  videoFrameCount: 72, audioCodec: "aac", audioDurationSeconds: 3.02, audioPacketCount: 131,
};

test("QA passes valid MP4 streams, 1080x1920 geometry, synchronized duration, and rendered captions", () => {
  const result = assessClipQa(validMedia, options, { decodeError: null, captionDialogueCount: 2 });
  assert.equal(result.status, "passed");
  assert.ok(result.checks.every((item) => item.status !== "failed"));
  assert.equal(result.tolerances.audioVideoSeconds, 0.15);
  assert.equal(result.checks.find((item) => item.id === "captions")?.status, "passed");
  assert.equal(result.checks.find((item) => item.id === "ffmpeg_decode")?.status, "passed");
  assert.equal(addPersistedMetadataCheck(result, true, "metadata matches").checks.find((item) => item.id === "metadata_consistency")?.status, "passed");
  const mismatch = addPersistedMetadataCheck(result, false, "persisted dimensions differ");
  assert.equal(mismatch.status, "failed");
  assert.equal(mismatch.checks.find((item) => item.id === "metadata_consistency")?.status, "failed");
});

test("QA identifies individual resolution, audio sync, captions, and decode failures", () => {
  const media = { ...validMedia, width: 720, height: 1280, audioDurationSeconds: 2.7 };
  const result = assessClipQa(media, options, { decodeError: "invalid packet", captionDialogueCount: 1 });
  assert.equal(result.status, "failed");
  assert.equal(result.checks.find((item) => item.id === "resolution")?.status, "failed");
  assert.equal(result.checks.find((item) => item.id === "av_sync")?.status, "failed");
  assert.equal(result.checks.find((item) => item.id === "captions")?.status, "failed");
  assert.equal(result.checks.find((item) => item.id === "ffmpeg_decode")?.status, "failed");
});

test("QA skips audio and captions only when the existing controls say they are not required", () => {
  const silent = { ...validMedia, audioCodec: null, audioDurationSeconds: null, audioPacketCount: null };
  const result = assessClipQa(silent, { ...options, audioRequired: false, captionsEnabled: false, captionCueCount: 0, captionRenderCompleted: false }, { decodeError: null, captionDialogueCount: null });
  assert.equal(result.status, "passed");
  assert.equal(result.checks.find((item) => item.id === "audio_stream")?.status, "skipped");
  assert.equal(result.checks.find((item) => item.id === "av_sync")?.status, "skipped");
  assert.equal(result.checks.find((item) => item.id === "captions")?.status, "skipped");
});

test("QA fails when required source audio is missing from the generated artifact", () => {
  const silent = { ...validMedia, audioCodec: null, audioDurationSeconds: null, audioPacketCount: null };
  const result = assessClipQa(silent, options, { decodeError: null, captionDialogueCount: 2 });
  assert.equal(result.status, "failed");
  assert.equal(result.checks.find((item) => item.id === "audio_stream")?.status, "failed");
  assert.equal(result.checks.find((item) => item.id === "av_sync")?.status, "failed");
});

test("QA uses documented clip-duration and A/V tolerances and fails when exceeded", () => {
  assert.equal(clipQaTolerances.clipDurationSeconds, 0.25);
  const result = assessClipQa({ ...validMedia, videoDurationSeconds: 3.3 }, options, { decodeError: null, captionDialogueCount: 2 });
  assert.equal(result.status, "failed");
  assert.equal(result.checks.find((item) => item.id === "clip_duration")?.status, "failed");
  assert.equal(result.checks.find((item) => item.id === "av_sync")?.status, "failed");
});
