import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Transcript } from "./pipeline";

export type CaptionCue = { start: number; end: number; text: string };

export const captionStyle = {
  width: 1080,
  height: 1920,
  marginLeft: 96,
  marginRight: 96,
  marginBottom: 320,
  fontSize: 62,
} as const;

function validTimedText(text: string, start: number, end: number) {
  return text.trim().length > 0 && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
}

function cleanCueText(text: string) {
  return text.replace(/[\\{}]/g, " ").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function endsSentence(text: string) { return /[.!?]["')\]]?$/.test(text.trim()); }

export function generateCaptionCues(transcript: Transcript, clipStart: number, clipEnd: number, options: { maxWords?: number; maxCharacters?: number } = {}): CaptionCue[] {
  if (!Number.isFinite(clipStart) || !Number.isFinite(clipEnd) || clipStart < 0 || clipEnd <= clipStart) throw new Error("Clip caption range must be finite, non-negative, and end after start.");
  const maxWords = Math.max(1, options.maxWords ?? 6);
  const maxCharacters = Math.max(8, options.maxCharacters ?? 38);
  const cues: CaptionCue[] = [];
  for (const segment of transcript.segments ?? []) {
    const words = (segment.words ?? []).filter((word) => validTimedText(word.word, word.start, word.end));
    if (words.length > 0) {
      const clippedWords = words.sort((a, b) => a.start - b.start || a.end - b.end)
        .filter((word) => word.end > clipStart && word.start < clipEnd)
        .map((word) => ({ start: Math.max(clipStart, word.start) - clipStart, end: Math.min(clipEnd, word.end) - clipStart, text: cleanCueText(word.word.trim()) }))
      .filter((word) => word.text && word.end > word.start);
      let group: typeof clippedWords = [];
      const flush = () => {
        if (!group.length) return;
        cues.push({ start: group[0].start, end: group[group.length - 1].end, text: group.map((word) => word.text).join(" ") });
        group = [];
      };
      for (const word of clippedWords) {
        const currentText = group.map((item) => item.text).join(" ");
        if (group.length && (group.length >= maxWords || currentText.length + word.text.length + 1 > maxCharacters || endsSentence(group[group.length - 1].text))) flush();
        group.push(word);
        if (endsSentence(word.text)) flush();
      }
      flush();
    } else if (validTimedText(segment.text, segment.start, segment.end)) {
      const start = Math.max(clipStart, segment.start);
      const end = Math.min(clipEnd, segment.end);
      const text = cleanCueText(segment.text);
      if (end > start && text) cues.push({ start: start - clipStart, end: end - clipStart, text });
    }
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function toAssTime(seconds: number) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const remainingSeconds = (centiseconds % 6_000) / 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${remainingSeconds.toFixed(2).padStart(5, "0")}`;
}

function wrapCaption(text: string, limit = 30) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > limit) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.join("\\N");
}

export function makeAss(cues: CaptionCue[]) {
  const header = `[Script Info]\nScriptType: v4.00+\nWrapStyle: 2\nScaledBorderAndShadow: yes\nPlayResX: ${captionStyle.width}\nPlayResY: ${captionStyle.height}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,${captionStyle.fontSize},&H00FFFFFF,&H0000FFFF,&H00101010,&H90000000,-1,0,1,4,1,2,${captionStyle.marginLeft},${captionStyle.marginRight},${captionStyle.marginBottom},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
  const events = cues.filter((cue) => validTimedText(cue.text, cue.start, cue.end)).map((cue) => `Dialogue: 0,${toAssTime(cue.start)},${toAssTime(cue.end)},Default,,0,0,0,,${wrapCaption(cleanCueText(cue.text))}`);
  return `${header}\n${events.join("\n")}\n`;
}

export function buildCaptionRenderArgs(input: string, assFile: string, output: string) {
  return ["-y", "-i", input, "-vf", `subtitles=${path.basename(assFile)}`, "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", "-movflags", "+faststart", output];
}

export async function renderCaptionVideo(input: string, assFile: string, output: string, ffmpeg = process.env.FFMPEG_BIN ?? "ffmpeg") {
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpeg, buildCaptionRenderArgs(input, assFile, output), { cwd: path.dirname(assFile), shell: false, windowsHide: true });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", (error) => reject(new Error(`Unable to start ${ffmpeg}: ${error.message}`)));
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Caption rendering failed with code ${code ?? "unknown"}${stderr ? `: ${stderr.trim().slice(-1200)}` : ""}`)));
    });
  } catch (error) {
    await fs.rm(output, { force: true });
    throw error;
  }
}
