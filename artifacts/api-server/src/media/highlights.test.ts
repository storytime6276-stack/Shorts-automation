import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Transcript } from "./pipeline";
import {
  analyzeAndSave,
  readAnalysis,
  scoreTranscript,
  updateCandidate,
} from "./highlights";

test("highlight scoring is deterministic for the same transcript", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/highlight-transcript.json", import.meta.url),
      "utf8",
    ),
  ) as Transcript;

  const first = scoreTranscript(fixture);
  const second = scoreTranscript(fixture);

  assert.deepEqual(first, second);
  assert.ok(first.length > 0);
  assert.ok(first.every((candidate) => candidate.score >= 0 && candidate.score <= 100));
  assert.ok(first.every((candidate) => candidate.reasons.length > 0));
});

test("candidate ranges combine adjacent transcript segments and avoid near duplicates", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/highlight-transcript.json", import.meta.url),
      "utf8",
    ),
  ) as Transcript;

  const candidates = scoreTranscript(fixture, 8);
  const combined = candidates.find(
    (candidate) =>
      candidate.sourceSegmentIds.includes(0) &&
      candidate.sourceSegmentIds.includes(1),
  );

  assert.ok(combined);
  assert.ok(combined.end - combined.start > 5);
  for (let index = 0; index < candidates.length; index += 1) {
    for (let next = index + 1; next < candidates.length; next += 1) {
      const current = candidates[index];
      const other = candidates[next];
      const overlap =
        Math.max(0, Math.min(current.end, other.end) - Math.max(current.start, other.start)) /
        Math.min(current.end - current.start, other.end - other.start);
      assert.ok(overlap < 0.55);
    }
  }
});

test("curiosity and dead-air signals affect reasons", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/highlight-transcript.json", import.meta.url),
      "utf8",
    ),
  ) as Transcript;
  const candidates = scoreTranscript(fixture, 8);
  const curiosityCandidate = candidates.find((candidate) =>
    candidate.text.includes("Why does this work"),
  );

  assert.ok(curiosityCandidate);
  assert.ok(curiosityCandidate.reasons.some((reason) => reason.includes("curiosity")));
});

test("analysis persists candidates and timestamp edits", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/highlight-transcript.json", import.meta.url),
      "utf8",
    ),
  ) as Transcript;
  const directory = await mkdtemp(path.join(os.tmpdir(), "shorts-highlights-"));
  const outputPath = path.join(directory, "highlights.json");

  try {
    const analysis = await analyzeAndSave(
      "00000000-0000-4000-8000-000000000001",
      fixture,
      outputPath,
    );
    assert.ok(analysis.candidates.length > 0);
    const saved = await readAnalysis(outputPath);
    assert.deepEqual(saved, analysis);

    const original = saved.candidates[0];
    const updated = await updateCandidate(
      outputPath,
      original.id,
      original.start + 0.25,
      original.end - 0.25,
      fixture.durationSeconds,
    );
    assert.equal(updated?.start, original.start + 0.25);
    assert.equal(updated?.end, original.end - 0.25);
    assert.notEqual(updated?.updatedAt, original.updatedAt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});