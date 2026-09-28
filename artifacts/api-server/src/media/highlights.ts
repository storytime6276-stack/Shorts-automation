import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Transcript } from "./pipeline";

export type HighlightSignals = {
  hook: number;
  curiosity: number;
  emotionalInterest: number;
  argumentativeTurn: number;
  payoff: number;
  completeness: number;
  keywordDensity: number;
  conciseness: number;
  durationFit: number;
  pacing: number;
  deadAir: number;
  repetition: number;
  contextDependency: number;
  selfContained: number;
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
type TimedWord = NonNullable<Segment["words"]>[number];
type Utterance = {
  start: number;
  end: number;
  text: string;
  words: TimedWord[];
  segmentIds: number[];
};

const stopWords = new Set(
  "a an and are as at be because but by for from has have he her hers him his i if in is it its of on or our she so than that the their them there they this to was we were what when where which who why will with you your".split(
    " ",
  ),
);
const hookPatterns = [
  /^(?:why|how|what if|what happens when|what would happen if)\b/,
  /^(?:stop|don't|never|start|watch|listen)\b/,
  /^(?:most people|the biggest mistake|the truth about|the reason)\b/,
  /^(?:here(?:'s| is) the|the secret to|you need to know)\b/,
  /^(?:imagine|picture this|one simple change)\b/,
];
const contextStarters = new Set(
  "and but so because then it that they he she them these those this there also".split(
    " ",
  ),
);
const emotionalWords = new Set(
  "afraid angry anxious amazed beautiful brave calm confident curious devastated excited fear feared furious joyful love loved nervous relieved shocked terrified worried surprising unbelievable heartbreaking frustrating inspiring powerful impossible".split(
    " ",
  ),
);
const highInterestWords = new Set(
  "breakthrough mistake surprising secret truth powerful impossible discover hidden urgent warning proven simple fastest biggest avoid win lose fail risk changed change important key critical result answer reason".split(
    " ",
  ),
);
const openLoopPattern =
  /\b(secret|truth|reason|surprise|catch|mistake|problem|question|what happened|turns out|did you know|here is why|here's why|until)\b/i;
const contrastPattern =
  /\b(but|however|yet|instead|although|even though|on the other hand|the problem is|the catch is)\b/i;
const payoffPattern =
  /\b(that(?:'s| is) why|the key is|the answer is|which means|in other words|as a result|so you can|that gives you|the result is|finally|therefore)\b/i;
const terminalPunctuation = /[.!?]["')\]]?$/;

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string) {
  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length > 1);
}

function contentTokens(text: string) {
  return tokens(text).filter((token) => !stopWords.has(token));
}

function wordsToText(words: TimedWord[]) {
  const raw = words.map((word) => word.word);
  if (raw.some((word) => /^\s/.test(word))) return raw.join("").trim();
  return raw.reduce((text, word) => {
    const clean = word.trim();
    if (!clean) return text;
    const punctuation = /^[,.;:!?%)\]}]/.test(clean);
    return `${text}${text && !punctuation ? " " : ""}${clean}`;
  }, "");
}

function segmentUtterances(segment: Segment): Utterance[] {
  const validWords = (segment.words ?? [])
    .filter(
      (word) =>
        word.word.trim() &&
        Number.isFinite(word.start) &&
        Number.isFinite(word.end) &&
        word.start >= 0 &&
        word.end > word.start,
    )
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (validWords.length === 0) {
    const text = segment.text.trim();
    return text &&
      Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) &&
      segment.end > segment.start
      ? [
          {
            start: segment.start,
            end: segment.end,
            text,
            words: [],
            segmentIds: [segment.id],
          },
        ]
      : [];
  }

  const utterances: Utterance[] = [];
  let current: TimedWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    utterances.push({
      start: current[0].start,
      end: current.at(-1)!.end,
      text: wordsToText(current),
      words: current,
      segmentIds: [segment.id],
    });
    current = [];
  };

  for (const word of validWords) {
    const previous = current.at(-1);
    const pause = previous ? word.start - previous.end : 0;
    const utteranceDuration = current.length ? word.end - current[0].start : 0;
    if (current.length > 0 && (pause > 1.4 || utteranceDuration > 14)) flush();
    current.push(word);
    if (terminalPunctuation.test(word.word.trim())) flush();
  }
  flush();
  return utterances;
}

function buildUtterances(segments: Segment[]) {
  return segments
    .flatMap(segmentUtterances)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function scoreWindow(window: Utterance[]): ScoredHighlight | null {
  const first = window[0];
  const last = window.at(-1);
  if (!first || !last) return null;
  const text = window
    .map((unit) => unit.text.trim())
    .filter(Boolean)
    .join(" ");
  const allTokens = tokens(text);
  const content = contentTokens(text);
  const normalized = normalizeText(text);
  const duration = Math.max(0.01, last.end - first.start);
  if (duration < 5 || allTokens.length < 5) return null;

  const firstText = normalizeText(first.text);
  const lastText = window.at(-1)!.text.trim();
  const strongHook = hookPatterns.some((pattern) => pattern.test(firstText));
  const questionHook =
    /^(?:why|how|what|who|when|where)\b/.test(firstText) &&
    first.text.includes("?");
  const directAddress = /^(?:you|your|imagine|picture this)\b/.test(firstText);
  const hook = strongHook
    ? 1
    : questionHook
      ? 0.94
      : directAddress
        ? 0.72
        : 0.18;

  const startsWithOpenLoop =
    /^(?:why|how|what if|what happens|the reason|the secret|the truth|did you know)\b/.test(
      firstText,
    );
  const curiosity = clamp(
    (text.includes("?") ? 0.36 : 0) +
      (openLoopPattern.test(text) ? 0.36 : 0) +
      (startsWithOpenLoop ? 0.28 : 0) +
      (contrastPattern.test(text) ? 0.12 : 0),
  );

  const emotionalCount = new Set(
    allTokens.filter((token) => emotionalWords.has(token)),
  ).size;
  const interestCount = new Set(
    allTokens.filter((token) => highInterestWords.has(token)),
  ).size;
  const emotionalInterest = clamp(
    emotionalCount * 0.42 + Math.max(0, interestCount - emotionalCount) * 0.16,
  );
  const contrastCount = (
    normalized.match(
      /\b(but|however|yet|instead|although|because|therefore|so)\b/g,
    ) ?? []
  ).length;
  const argumentativeTurn = clamp(
    contrastCount * 0.38 + (contrastPattern.test(normalized) ? 0.25 : 0),
  );

  const endsCleanly = terminalPunctuation.test(lastText);
  const endsOnConnector =
    /\b(and|but|because|so|or|with|to|of|the|a|an)$/i.test(
      lastText.replace(/[.!?,;:]+$/, "").trim(),
    );
  const hasPayoff = payoffPattern.test(lastText);
  const payoff = hasPayoff
    ? 1
    : endsCleanly && (curiosity > 0.3 || argumentativeTurn > 0.3)
      ? 0.78
      : endsCleanly
        ? 0.55
        : 0.18;
  const completeness = endsOnConnector
    ? 0.12
    : endsCleanly
      ? hasPayoff
        ? 1
        : 0.82
      : 0.38;

  const keywordDensity = clamp(
    content.length / Math.max(1, allTokens.length) / 0.62,
  );
  const wordsPerSecond = allTokens.length / duration;
  const pacing =
    wordsPerSecond >= 1.55 && wordsPerSecond <= 3.5
      ? 1
      : wordsPerSecond < 1.55
        ? clamp(wordsPerSecond / 1.55)
        : clamp(1 - (wordsPerSecond - 3.5) / 3.5);
  const durationFit =
    duration < 15
      ? clamp((duration / 15) * 0.78)
      : duration <= 60
        ? 0.86 + 0.14 * (1 - Math.abs(duration - 32) / 32)
        : clamp(0.82 - (duration - 60) / 30);
  const conciseness = clamp(
    0.65 * pacing +
      0.35 * keywordDensity -
      (allTokens.length > 115 ? (allTokens.length - 115) / 300 : 0),
  );

  const timedWords = window
    .flatMap((unit) => unit.words)
    .sort((a, b) => a.start - b.start);
  const gaps =
    timedWords.length > 1
      ? [
          ...timedWords
            .slice(1)
            .map((word, index) =>
              Math.max(0, word.start - timedWords[index].end),
            ),
          ...window
            .slice(1)
            .flatMap((unit, index) =>
              !unit.words.length || !window[index].words.length
                ? [Math.max(0, unit.start - window[index].end)]
                : [],
            ),
        ]
      : window
          .slice(1)
          .map((unit, index) => Math.max(0, unit.start - window[index].end));
  const meaningfulGaps = gaps.filter((gap) => gap > 0.65);
  const longGap = Math.max(0, ...meaningfulGaps);
  const deadAir = clamp(
    meaningfulGaps.reduce((sum, gap) => sum + gap - 0.65, 0) /
      Math.max(1, duration * 0.18) +
      Math.max(0, longGap - 1.2) * 0.12,
  );

  const counts = new Map<string, number>();
  for (const token of content) counts.set(token, (counts.get(token) ?? 0) + 1);
  const repeatedWords = [...counts.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );
  const repeatedNgrams = new Set<string>();
  for (let index = 0; index <= content.length - 3; index += 1) {
    const phrase = content.slice(index, index + 3).join(" ");
    if (content.slice(0, index).join(" ").includes(phrase))
      repeatedNgrams.add(phrase);
  }
  const repetition = clamp(
    repeatedWords / Math.max(1, content.length * 0.28) +
      repeatedNgrams.size * 0.12,
  );

  const firstToken = allTokens[0];
  const contextDependency =
    firstToken &&
    contextStarters.has(firstToken) &&
    !strongHook &&
    !questionHook
      ? /^(?:it|that|they|he|she|them|these|those)\b/.test(firstText)
        ? 0.95
        : 0.78
      : /^(?:as i said|like i mentioned|the same thing)\b/.test(firstText)
        ? 0.85
        : 0;
  const selfContained = 1 - contextDependency;

  const signals: HighlightSignals = {
    hook,
    curiosity,
    emotionalInterest,
    argumentativeTurn,
    payoff,
    completeness,
    keywordDensity,
    conciseness,
    durationFit,
    pacing,
    deadAir,
    repetition,
    contextDependency,
    selfContained,
  };
  const weightedScore =
    hook * 0.14 +
    curiosity * 0.1 +
    emotionalInterest * 0.07 +
    argumentativeTurn * 0.08 +
    payoff * 0.12 +
    completeness * 0.08 +
    keywordDensity * 0.04 +
    conciseness * 0.09 +
    durationFit * 0.08 +
    pacing * 0.06 +
    selfContained * 0.04 -
    deadAir * 0.04 -
    repetition * 0.03 -
    contextDependency * 0.03;
  const score = Math.round(clamp(weightedScore) * 100);

  const reasons: string[] = [];
  if (hook >= 0.7)
    reasons.push("Opens with a direct question, promise, or instruction.");
  if (curiosity >= 0.45)
    reasons.push(
      "Uses a question or curiosity cue to create an information gap.",
    );
  if (emotionalInterest >= 0.4)
    reasons.push("Uses emotionally vivid or high-interest language.");
  if (argumentativeTurn >= 0.35)
    reasons.push("Contains a clear contrast, claim, or cause-and-effect turn.");
  if (payoff >= 0.75)
    reasons.push("Resolves the setup with a clear payoff or complete thought.");
  if (durationFit >= 0.85)
    reasons.push("Fits the preferred short-form duration range.");
  if (deadAir >= 0.25) reasons.push("Penalized for long pauses or dead air.");
  if (repetition >= 0.25) reasons.push("Penalized for repeated wording.");
  if (contextDependency >= 0.5)
    reasons.push("Penalized because the opening depends on missing context.");
  if (reasons.length === 0)
    reasons.push(
      "Balanced transcript range with usable pacing and a complete thought.",
    );

  return {
    start: first.start,
    end: last.end,
    score,
    text,
    reasons,
    signals,
    sourceSegmentIds: [...new Set(window.flatMap((unit) => unit.segmentIds))],
  };
}

function overlapRatio(a: ScoredHighlight, b: ScoredHighlight) {
  const overlap = Math.max(
    0,
    Math.min(a.end, b.end) - Math.max(a.start, b.start),
  );
  return overlap / Math.max(0.01, Math.min(a.end - a.start, b.end - b.start));
}

function tokenSimilarity(a: string, b: string) {
  const left = new Set(contentTokens(a));
  const right = new Set(contentTokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  const common = [...left].filter((token) => right.has(token)).length;
  return common / (left.size + right.size - common);
}

export function scoreTranscript(transcript: Transcript, maxCandidates = 8) {
  const utterances = buildUtterances(transcript.segments);
  const candidates: ScoredHighlight[] = [];
  for (let startIndex = 0; startIndex < utterances.length; startIndex += 1) {
    const window: Utterance[] = [];
    for (
      let endIndex = startIndex;
      endIndex < Math.min(utterances.length, startIndex + 16);
      endIndex += 1
    ) {
      const next = utterances[endIndex];
      const previous = window.at(-1);
      if (previous && next.start - previous.end > 2.5) break;
      window.push(next);
      const scored = scoreWindow(window);
      if (scored) candidates.push(scored);
      if (scored && scored.end - scored.start >= 65) break;
    }
  }

  const ranked = candidates.sort(
    (a, b) => b.score - a.score || a.start - b.start || a.end - b.end,
  );
  const deduplicated: ScoredHighlight[] = [];
  for (const candidate of ranked) {
    const nearDuplicate = deduplicated.some(
      (kept) =>
        overlapRatio(kept, candidate) >= 0.55 ||
        (Math.abs(kept.start - candidate.start) <= 2.5 &&
          Math.abs(kept.end - candidate.end) <= 4) ||
        (overlapRatio(kept, candidate) >= 0.2 &&
          tokenSimilarity(kept.text, candidate.text) >= 0.84),
    );
    if (!nearDuplicate) deduplicated.push(candidate);
    if (deduplicated.length >= Math.max(1, maxCandidates)) break;
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
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start
  ) {
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
