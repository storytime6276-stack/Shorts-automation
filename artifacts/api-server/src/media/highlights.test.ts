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

type TestLine = { start: number; end: number; text: string };

function transcriptFromLines(
  lines: TestLine[],
  durationSeconds?: number,
): Transcript {
  return {
    language: "en",
    durationSeconds:
      durationSeconds ?? Math.max(...lines.map((line) => line.end)) + 0.5,
    segments: lines.map((line, id) => {
      const words = line.text.match(/\S+/g) ?? [];
      const step = (line.end - line.start) / Math.max(1, words.length);
      return {
        id,
        start: line.start,
        end: line.end,
        text: line.text,
        words: words.map((word, index) => ({
          word,
          start: line.start + index * step,
          end: Math.min(line.end, line.start + index * step + step * 0.72),
          probability: 0.99,
        })),
      };
    }),
  };
}

function overlapRatio(
  a: { start: number; end: number },
  b: { start: number; end: number },
) {
  const overlap = Math.max(
    0,
    Math.min(a.end, b.end) - Math.max(a.start, b.start),
  );
  return overlap / Math.max(0.01, Math.min(a.end - a.start, b.end - b.start));
}

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
  assert.ok(
    first.every((candidate) => candidate.score >= 0 && candidate.score <= 100),
  );
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
        Math.max(
          0,
          Math.min(current.end, other.end) -
            Math.max(current.start, other.start),
        ) / Math.min(current.end - current.start, other.end - other.start);
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
  assert.ok(
    curiosityCandidate.reasons.some((reason) => reason.includes("curiosity")),
  );
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

test("strong opening hook and clear payoff earn high explainable component scores", () => {
  const transcript = transcriptFromLines(
    [
      { start: 0, end: 4.4, text: "Why do people remember some stories?" },
      {
        start: 4.6,
        end: 9.7,
        text: "The surprising truth is that emotion makes details stick.",
      },
      {
        start: 9.9,
        end: 15.2,
        text: "That is why a clear payoff makes a story memorable.",
      },
    ],
    16,
  );
  const candidate = scoreTranscript(transcript).find(
    (item) => item.sourceSegmentIds.length === 3,
  );

  assert.ok(candidate);
  assert.equal(candidate.signals.hook, 1);
  assert.ok(candidate.signals.curiosity >= 0.8);
  assert.equal(candidate.signals.payoff, 1);
  assert.equal(candidate.start, 0);
  assert.equal(candidate.end, transcript.segments[2].words.at(-1)?.end);
  assert.ok(candidate.reasons.some((reason) => reason.includes("payoff")));
});

test("weak context-dependent openings receive a strong context penalty", () => {
  const transcript = transcriptFromLines([
    { start: 0, end: 4.2, text: "And then it happened because of that." },
    { start: 4.35, end: 8.4, text: "It was there because they said so." },
    { start: 8.55, end: 12.4, text: "That changed everything for them." },
    { start: 12.55, end: 16.5, text: "Then they finally did it." },
  ]);
  const candidate = scoreTranscript(transcript).find(
    (item) => item.sourceSegmentIds[0] === 0,
  );

  assert.ok(candidate);
  assert.ok(candidate.signals.contextDependency >= 0.75);
  assert.ok(candidate.signals.selfContained <= 0.25);
  assert.ok(candidate.signals.hook < 0.7);
  assert.ok(
    candidate.reasons.some((reason) => reason.includes("missing context")),
  );
});

test("repetition and long pauses reduce candidate quality", () => {
  const repeated = transcriptFromLines([
    {
      start: 0,
      end: 4,
      text: "This really really repeats the same phrase again.",
    },
    {
      start: 5.8,
      end: 9.8,
      text: "We really really repeat the same phrase again.",
    },
    {
      start: 11.6,
      end: 15.6,
      text: "We really really repeat the same phrase again.",
    },
  ]);
  const clean = transcriptFromLines([
    {
      start: 0,
      end: 4,
      text: "One clear idea can change how people remember a story.",
    },
    {
      start: 5.8,
      end: 9.8,
      text: "A useful example shows why the method works well.",
    },
    {
      start: 11.6,
      end: 15.6,
      text: "That is why a small change makes a strong result.",
    },
  ]);
  const repeatedCandidate = scoreTranscript(repeated).find(
    (item) => item.start === 0,
  );
  const cleanCandidate = scoreTranscript(clean).find(
    (item) => item.start === 0,
  );

  assert.ok(repeatedCandidate);
  assert.ok(cleanCandidate);
  assert.ok(
    repeatedCandidate.signals.repetition > cleanCandidate.signals.repetition,
  );
  assert.ok(repeatedCandidate.signals.deadAir > 0.5);
  assert.ok(repeatedCandidate.score < cleanCandidate.score);
});

test("word timestamps are preserved at candidate boundaries", () => {
  const transcript: Transcript = {
    language: "en",
    durationSeconds: 10,
    segments: [
      {
        id: 7,
        start: 1.25,
        end: 4.1,
        text: "How can small changes lead to a better result?",
        words: [
          { word: "How", start: 1.25, end: 1.54, probability: 0.99 },
          { word: "can", start: 1.58, end: 1.82, probability: 0.99 },
          { word: "small", start: 1.86, end: 2.2, probability: 0.99 },
          { word: "changes", start: 2.24, end: 2.66, probability: 0.99 },
          { word: "lead", start: 2.7, end: 2.98, probability: 0.99 },
          { word: "to", start: 3.02, end: 3.16, probability: 0.99 },
          { word: "a", start: 3.2, end: 3.29, probability: 0.99 },
          { word: "better", start: 3.33, end: 3.68, probability: 0.99 },
          { word: "result?", start: 3.72, end: 4.1, probability: 0.99 },
        ],
      },
      {
        id: 8,
        start: 4.3,
        end: 7.8,
        text: "Here is the simple reason.",
        words: [
          { word: "Here", start: 4.3, end: 4.65, probability: 0.99 },
          { word: "is", start: 4.69, end: 4.85, probability: 0.99 },
          { word: "the", start: 4.89, end: 5.02, probability: 0.99 },
          { word: "simple", start: 5.06, end: 5.42, probability: 0.99 },
          { word: "reason.", start: 6.35, end: 6.8, probability: 0.99 },
        ],
      },
    ],
  };
  const candidate = scoreTranscript(transcript).find((item) =>
    item.sourceSegmentIds.includes(8),
  );

  assert.ok(candidate);
  assert.equal(candidate.start, 1.25);
  assert.equal(candidate.end, 6.8);
  assert.deepEqual(candidate.sourceSegmentIds, [7, 8]);
});

test("ranked results remove overlapping and near-duplicate windows", () => {
  const transcript = transcriptFromLines([
    {
      start: 0,
      end: 4.5,
      text: "Most people miss the first important signal.",
    },
    {
      start: 4.65,
      end: 9,
      text: "The surprising truth is that small details matter.",
    },
    {
      start: 9.15,
      end: 13.5,
      text: "Here is the key idea that changes the outcome.",
    },
    {
      start: 13.65,
      end: 18,
      text: "Because clear examples help everyone understand.",
    },
    {
      start: 18.15,
      end: 22.5,
      text: "That is why the answer feels simple and useful.",
    },
    {
      start: 22.65,
      end: 27,
      text: "You can apply this result in your next project.",
    },
    {
      start: 27.15,
      end: 31.5,
      text: "The method works because it removes wasted steps.",
    },
    {
      start: 31.65,
      end: 36,
      text: "Finally, the result is faster and more reliable.",
    },
    {
      start: 50,
      end: 54.5,
      text: "What if one simple choice made your next decision easier?",
    },
    {
      start: 54.65,
      end: 59,
      text: "The surprising answer is that preparation prevents confusion.",
    },
    {
      start: 59.15,
      end: 63.5,
      text: "A clear example shows exactly how the method works.",
    },
    {
      start: 63.65,
      end: 68,
      text: "That is why a small plan creates a more reliable result.",
    },
  ]);
  const candidates = scoreTranscript(transcript, 8);

  assert.ok(candidates.length > 1);
  for (let index = 0; index < candidates.length; index += 1) {
    for (let next = index + 1; next < candidates.length; next += 1) {
      assert.ok(overlapRatio(candidates[index], candidates[next]) < 0.55);
    }
  }
  assert.deepEqual(
    candidates,
    [...candidates].sort(
      (a, b) => b.score - a.score || a.start - b.start || a.end - b.end,
    ),
  );
});

test("a self-contained hook and payoff rank above a context-dependent passage", () => {
  const transcript = transcriptFromLines([
    {
      start: 0,
      end: 4,
      text: "What if one small habit could change your whole morning?",
    },
    {
      start: 4.15,
      end: 8.4,
      text: "The surprising answer is that preparation removes stress.",
    },
    {
      start: 8.55,
      end: 13,
      text: "That is why a five-minute plan makes mornings calmer.",
    },
    { start: 22, end: 26, text: "And then it was there for the same reason." },
    {
      start: 26.15,
      end: 30.4,
      text: "They did it because they had already said so.",
    },
    { start: 30.55, end: 35, text: "That was how the thing finally changed." },
  ]);
  const candidates = scoreTranscript(transcript, 8);
  const strong = candidates.find((item) => item.start === 0);
  const dependent = candidates.find((item) => item.start >= 22);

  assert.ok(strong);
  assert.ok(dependent);
  assert.equal(candidates[0], strong);
  assert.ok(strong.score > dependent.score);
});
