import type { Transcript } from "./pipeline";

export type PackagingMetadata = {
  status: "available" | "unavailable" | "failed";
  title: string | null;
  description: string | null;
  tags: string[];
  error: string | null;
};

const stopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "because", "but", "by", "for", "from", "had", "has", "have", "he", "her", "his", "i", "in", "into", "is", "it", "its", "me", "my", "of", "on", "or", "our", "she", "so", "that", "the", "their", "them", "there", "they", "this", "to", "was", "we", "were", "what", "when", "where", "which", "who", "why", "with", "you", "your",
]);

function clipTranscriptText(transcript: Transcript, start: number, end: number) {
  const parts: string[] = [];
  for (const segment of transcript.segments ?? []) {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= start || segment.start >= end) continue;
    const words = (segment.words ?? [])
      .filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > start && word.start < end && word.word.trim())
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const text = words.length ? words.map((word) => word.word.trim()).join(" ") : segment.text.trim();
    if (text) parts.push(text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function sentences(text: string) {
  return text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
}

function hookStrength(sentence: string) {
  let score = 0;
  if (/\?/.test(sentence) || /^(why|how|what|who|when|where|which)\b/i.test(sentence)) score += 3;
  if (/\b(the truth|the secret|nobody|never|until|the reason|the moment|the mistake|what happened)\b/i.test(sentence)) score += 2;
  if (/\b(but|suddenly|turns out|I thought|I realized|the problem)\b/i.test(sentence)) score += 1;
  return score;
}

function trimAtWord(text: string, maximum: number) {
  if (text.length <= maximum) return text;
  const prefix = text.slice(0, maximum - 1);
  const boundary = prefix.lastIndexOf(" ");
  return `${(boundary > maximum * 0.55 ? prefix.slice(0, boundary) : prefix).trimEnd()}…`;
}

function transcriptTags(text: string) {
  const counts = new Map<string, number>();
  for (const raw of text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []) {
    const token = raw.toLowerCase().replace(/^[-']|[-']$/g, "");
    if (token.length < 3 || stopWords.has(token) || /^\d+$/.test(token) || token === "shorts") continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const keywords = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 5).map(([word]) => `#${word.replace(/[^\p{L}\p{N}]/gu, "")}`);
  return ["#shorts", ...keywords];
}

export function generateClipPackaging(transcript: Transcript | null | undefined, start: number, end: number): PackagingMetadata {
  if (!transcript || !Array.isArray(transcript.segments) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    return { status: "unavailable", title: null, description: null, tags: [], error: "A valid transcript and clip time range are required to create packaging." };
  }
  const sourceText = clipTranscriptText(transcript, start, end);
  if (!sourceText) return { status: "unavailable", title: null, description: null, tags: [], error: "No transcript text overlaps the selected clip." };

  const lines = sentences(sourceText);
  const titleIndex = lines.map((line, index) => ({ line, index, strength: hookStrength(line) }))
    .sort((a, b) => b.strength - a.strength || a.index - b.index)[0]?.index ?? 0;
  const title = trimAtWord(lines[titleIndex].replace(/[.!?]+$/g, ""), 80);
  const descriptionText = lines.filter((_line, index) => index !== titleIndex).join(" ") || sourceText;
  return {
    status: "available",
    title,
    description: trimAtWord(descriptionText, 240),
    tags: transcriptTags(sourceText),
    error: null,
  };
}

export function failedPackaging(error: unknown): PackagingMetadata {
  return { status: "failed", title: null, description: null, tags: [], error: error instanceof Error ? error.message : String(error) };
}
