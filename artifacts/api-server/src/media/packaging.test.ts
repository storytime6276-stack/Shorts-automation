import assert from "node:assert/strict";
import test from "node:test";
import { generateClipPackaging } from "./packaging";
import type { Transcript } from "./pipeline";

test("packaging uses a hook from the selected word-timed transcript and deterministic tags", () => {
  const transcript: Transcript = {
    language: "en", durationSeconds: 20,
    segments: [
      { id: 0, start: 0, end: 2, text: "Ignore this opening.", words: [{ word: "Ignore", start: 0, end: 0.5, probability: 1 }, { word: "this", start: 0.5, end: 1, probability: 1 }, { word: "opening.", start: 1, end: 2, probability: 1 }] },
      { id: 1, start: 5, end: 11, text: "Why did the old bridge disappear? The river changed the whole town.", words: [
        { word: "Why", start: 5, end: 5.4, probability: 1 }, { word: "did", start: 5.4, end: 5.7, probability: 1 }, { word: "the", start: 5.7, end: 6, probability: 1 }, { word: "old", start: 6, end: 6.4, probability: 1 }, { word: "bridge", start: 6.4, end: 6.9, probability: 1 }, { word: "disappear?", start: 6.9, end: 7.7, probability: 1 },
        { word: "The", start: 8, end: 8.2, probability: 1 }, { word: "river", start: 8.2, end: 8.7, probability: 1 }, { word: "changed", start: 8.7, end: 9.2, probability: 1 }, { word: "the", start: 9.2, end: 9.4, probability: 1 }, { word: "whole", start: 9.4, end: 9.8, probability: 1 }, { word: "town.", start: 9.8, end: 10.4, probability: 1 },
      ] },
    ],
  };
  const packaging = generateClipPackaging(transcript, 5, 10.5);
  assert.equal(packaging.status, "available");
  assert.equal(packaging.title, "Why did the old bridge disappear");
  assert.equal(packaging.description, "The river changed the whole town.");
  assert.ok(packaging.tags.includes("#shorts"));
  assert.ok(packaging.tags.includes("#bridge"));
  assert.ok(!`${packaging.title} ${packaging.description}`.includes("Ignore this opening"));
  assert.equal(JSON.stringify(packaging), JSON.stringify(generateClipPackaging(transcript, 5, 10.5)));
});

test("missing or out-of-range transcript text returns safe unavailable packaging", () => {
  const missing = generateClipPackaging(null, 0, 4);
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.title, null);
  assert.deepEqual(missing.tags, []);

  const empty = generateClipPackaging({ language: "en", durationSeconds: 4, segments: [] }, 0, 4);
  assert.equal(empty.status, "unavailable");
  assert.match(empty.error ?? "", /No transcript text/);
});
