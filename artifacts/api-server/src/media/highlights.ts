import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Transcript } from "./pipeline";

export type HighlightSignals = {
  hook: number;
  curiosity: number;
  emotionalInterest: number;
  completeness: number;
  keywordDensity: number;
  pacing: number;
  deadAir: number;
  repetition: number;
  contextDependency: number;
};

export type ScoredHighlight = {
  start: number;
  end: number;
  score: number;
  text: string;
  reasons: string[];
  signals: HighlightSignals;
  sourceSegmentIds: number[];
};

export type HighlightCandidate = ScoredHighlight & {
  id: string;
  jobId: string;
  rank: number;
  updatedAt: string;
};

export type HighlightAnalysis = {
  jobId: string;
  analyzedAt: string;
  candidates: HighlightCandidate[];
};

type Segment = Transcript["segments"][number];

const stopWords = new Set(
  "a an and are as at be because but by for from has have he her hers him his i if in is it its of on or our she so than that the their them there they this to was we were what when where which who why will with you your".split(
    " ",
  ),
);
const hookPatterns = [
  /^how\b/,
  /^why\b/,
  /^what if\b/,
  /^here(?:'s| is)\b/,
  /^this is\b/,
  /^the secret\b/,
  /^most people\b/,
  /^stop\b/,
  /^you need\b/,
  /^watch\b/,
  /^if you\b/,
  /^the reason\b/,
];
const curiosityPatterns = [
  /\?/,
  /\bhow\b/,
  /\bwhy\b/,
  /\bwhat if\b/,
  /\bimagine\b/,
  /\bsecret\b/,
  /\btruth\b/,
  /\bactually\b/,
  /\breveal(?:s|ed)?\b/,
];
const interestWords = new Set(
  "amazing breakthrough mistake surprising secret truth powerful impossible discover hidden urgent warning proven simple fastest biggest avoid win lose fail risk changed change important key critical".split(
    " ",
  ),
);
const contextStarters = new Set(
  "it this that they he she them these those and but so because then also".split(
    " ",
  ),
);
const payoffEndings = [
  /\.$/,
  /\?$/,
  /!$/,
  /\bthat(?:'s| is) why\b/,
  /\bthe key is\b/,
  /\bin other words\b/,
  /\bwhich means\b/,
  /\bso you can\b/,
];

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
}

function tokens(text: string) {
  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length > 1);
}

function contentTokens(text: string) {
  return tokens(text).filter((token) => !stopWords.has(token));
}

function buildBlocks(segments: Segment[]) {
  const ordered = [...segments].sort((a, b) => a.start - b.start);
  const blocks: Segment[][] = [];
  for (const segment of ordered) {
    const previous = blocks.at(-1)?.at(-1);
    if (!previous || segment.start - previous.end > 2.25) {
      blocks.push([segment]);
    } else {
      blocks.at(-1)?.push(segment);
    }
  }
  return blocks;
}

function scoreWindow(window: Segment[]): ScoredHighlight | null {
  const first = window[0];
  const last = window.at(-1);
  if (!first || !last) return null;
  const text = window.map((segment) => segment.text.trim()).filter(Boolean).join(" ");
  const allTokens = tokens(text);
  const content = contentTokens(text);
  const normalized = normalizeText(text);
  const duration = Math.max(0.01, last.end - first.start);
  if (duration < 5 || allTokens.length < 5) return null;

  const firstWords = normalizeText(first.text);
  const hook = clamp(
    hookPatterns.some((pattern) => pattern.test(firstWords))
      ? 1
      : firstWords.split(" ").length >= 4
        ? 0.15
        : 0,
  );
  const curiosityMatches = curiosityPatterns.reduce(
    (count, pattern) => count + (pattern.test(normalized) ? 1 : 0),
    0,
  );
  const curiosity = clamp(curiosityMatches / 3);
  const interestMatches = allTokens.filter((token) => interestWords.has(token)).length;
  const emotionalInterest = clamp(interestMatches / Math.max(5, allTokens.length * 0.12));
  const completeness = payoffEndings.some((pattern) => pattern.test(text.trim()))
    ? 1
    : /[.!?]["')\]]?$/.test(text.trim())
      ? 0.8
      : 0.35;
  const keywordDensity = clamp(content.length / Math.max(1, allTokens.length) / 0.55);
  const wordsPerSecond = allTokens.length / duration;
  const pacing =
    wordsPerSecond >= 1.25 && wordsPerSecond <= 3.6
      ? 1
      : wordsPerSecond >= 0.75 && wordsPerSecond <= 4.5
        ? 0.55
        : 0.15;
  const internalGaps = window
    .slice(1)
    .map((segment, index) => segment.start - window[index].end);
  const deadAir = clamp(
    internalGaps.filter((gap) => gap > 0.8).reduce((sum, gap) => sum + gap, 0) /
      Math.max(1, duration * 0.25),
  );
  const counts = new Map<string, number>();
  for (const token of content) counts.set(token, (counts.get(token) ?? 0) + 1);
  const repeatedTokens = [...counts.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count - 1, 0);
  const repetition = clamp(repeatedTokens / Math.max(1, content.length * 0.25));
  const firstToken = allTokens[0];
  const contextDependency =
    firstToken && contextStarters.has(firstToken) && !hook && !curiosity ? 0.9 : 0;

  const signals: HighlightSignals = {
    hook,
    curiosity,
    emotionalInterest,
    completeness,
    keywordDensity,
    pacing,
    deadAir,
    repetition,
    contextDependency,
  };
  const weightedScore =
    hook * 0.16 +
    curiosity * 0.13 +
    emotionalInterest * 0.12 +
    completeness * 0.15 +
    keywordDensity * 0.12 +
    pacing * 0.12 +
    (1 - deadAir) * 0.08 +
    (1 - repetition) * 0.06 +
    (1 - contextDependency) * 0.06;
  const score = Math.round(clamp(weightedScore) * 100);
  const reasons: string[] = [];
  if (hook >= 0.8) reasons.push("Opens with a direct hook or promise.");
  if (curiosity >= 0.3) reasons.push("Uses a question or curiosity cue.");
  if (emotionalInterest >= 0.35) reasons.push("Contains high-interest or emotional language.");
  if (completeness >= 0.8) reasons.push("Ends with a complete thought or payoff.");
  if (keywordDensity >= 0.55) reasons.push("Has a strong density of meaningful keywords.");
  if (pacing >= 0.9) reasons.push("Speech pacing fits a concise short-form clip.");
  if (deadAir >= 0.3) reasons.push("Penalized for noticeable silence between segments.");
  if (repetition >= 0.35) reasons.push("Penalized for repeated wording.");
  if (contextDependency >= 0.5) reasons.push("Penalized because the opening depends on earlier context.");
  if (reasons.length === 0) reasons.push("Balanced transcript range with usable pacing.");

  return {
    start: first.start,
    end: last.end,
    score,
    text,
    reasons,
    signals,
    sourceSegmentIds: window.map((segment) => segment.id),
  };
}

function overlapRatio(a: ScoredHighlight, b: ScoredHighlight) {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return overlap / Math.max(0.01, Math.min(a.end - a.start, b.end - b.start));
}

export function scoreTranscript(transcript: Transcript, maxCandidates = 8) {
  const candidates: ScoredHighlight[] = [];
  for (const block of buildBlocks(transcript.segments)) {
    for (let startIndex = 0; startIndex < block.length; startIndex += 1) {
      const window: Segment[] = [];
      for (
        let endIndex = startIndex;
        endIndex < Math.min(block.length, startIndex + 5);
        endIndex += 1
      ) {
        window.push(block[endIndex]);
        const scored = scoreWindow(window);
        if (scored) candidates.push(scored);
        if (scored && scored.end - scored.start >= 38) break;
      }
    }
  }

  const ranked = candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  const deduplicated: ScoredHighlight[] = [];
  for (const candidate of ranked) {
    const nearDuplicate = deduplicated.some(
      (kept) =>
        overlapRatio(kept, candidate) >= 0.55 ||
        (Math.abs(kept.start - candidate.start) <= 2 &&
          Math.abs(kept.end - candidate.end) <= 3),
    );
    if (!nearDuplicate) deduplicated.push(candidate);
    if (deduplicated.length >= maxCandidates) break;
  }
  return deduplicated;
}

export async function analyzeAndSave(
  jobId: string,
  transcript: Transcript,
  outputPath: string,
): Promise<HighlightAnalysis> {
  const analyzedAt = new Date().toISOString();
  const candidates: HighlightCandidate[] = scoreTranscript(transcript).map(
    (candidate, index) => ({
      ...candidate,
      id: randomUUID(),
      jobId,
      rank: index + 1,
      updatedAt: analyzedAt,
    }),
  );
  const analysis: HighlightAnalysis = { jobId, analyzedAt, candidates };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(analysis, null, 2), "utf8");
  await fs.rename(temporaryPath, outputPath);
  return analysis;
}

export async function readAnalysis(outputPath: string) {
  return JSON.parse(await fs.readFile(outputPath, "utf8")) as HighlightAnalysis;
}

export async function updateCandidate(
  outputPath: string,
  candidateId: string,
  start: number,
  end: number,
  duration: number | null,
) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error("Candidate start must be before candidate end.");
  }
  if (duration !== null && end > duration + 0.05) {
    throw new Error("Candidate end cannot exceed the video duration.");
  }
  const analysis = await readAnalysis(outputPath);
  const candidate = analysis.candidates.find((item) => item.id === candidateId);
  if (!candidate) return undefined;
  candidate.start = start;
  candidate.end = end;
  candidate.updatedAt = new Date().toISOString();
  const temporaryPath = `${outputPath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(analysis, null, 2), "utf8");
  await fs.rename(temporaryPath, outputPath);
  return candidate;
}