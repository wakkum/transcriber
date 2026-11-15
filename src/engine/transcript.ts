// The transcript as text: words grouped into paragraphs, paragraphs cut into short timecoded lines
// (so the text stays linked to the recording), and the plain-text export. Word and PDF are in
// docx.ts and pdf.ts; all three share these paragraphs and lines.

/** A transcribed word with its start and end in the recording (seconds), and who said it once speakers are known. */
export type Word = { id: string; text: string; start: number; end: number; speaker?: string };
export type Para = { start: number; speaker?: string; words: Word[] };
/** One timecoded line of a paragraph. */
export type TextLine = { start: number; end: number; text: string };

export type ExportOptions = {
  /** Put the time each line starts in front of it. */
  timecodes: boolean;
  /** Speaker names by id: when given, each paragraph starts with its speaker's name. */
  speakerNames?: Record<string, string>;
};

/** The label to print over a paragraph, or null when speakers are not shown. */
export const speakerLabel = (p: Para, { speakerNames }: ExportOptions): string | null => (speakerNames && p.speaker != null ? (speakerNames[p.speaker] ?? '') || null : null);

const textOf = (words: { text: string }[]) => words.map((w) => w.text).join(' ');
export const endsSentence = (t: string) => /[.?!。؟]["')\]»”]?$/u.test(t);

/**
 * Words in paragraphs: a new one when the speaker changes, after a long pause, or at a sentence end once a paragraph is long.
 * `hardMax` also breaks unpunctuated speech (some languages come back without full stops).
 */
export function paragraphs(words: Word[], { pause = 1.5, softMax = 60, hardMax = 150 } = {}): Para[] {
  const out: Para[] = [];
  let cur: Para | null = null;
  for (const w of words) {
    const prev = cur?.words.at(-1);
    if (!cur || !prev || w.speaker !== prev.speaker || w.start - prev.end > pause || cur.words.length >= hardMax || (cur.words.length >= softMax && endsSentence(prev.text))) {
      cur = { start: w.start, speaker: w.speaker, words: [] };
      out.push(cur);
    }
    cur.words.push(w);
  }
  return out;
}

/**
 * A paragraph cut into lines of a sentence or a few seconds: a line ends after a sentence once it
 * has some length, at a pause, or when it is full (about two subtitle rows).
 */
export function lineGroups(words: Word[], { maxChars = 84, maxSeconds = 7, pause = 0.8, minChars = 24 } = {}): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) out.push(cur);
    cur = [];
  };
  for (const w of words) {
    const prev = cur.at(-1);
    if (prev && (textOf(cur).length + 1 + w.text.length > maxChars || w.start - prev.end > pause || w.end - cur[0].start > maxSeconds)) flush();
    cur.push(w);
    if (endsSentence(w.text) && textOf(cur).length >= minChars) flush();
  }
  flush();
  return out;
}

/** The lines of `lineGroups` as text with their times. */
export const splitLines = (words: Word[]): TextLine[] => lineGroups(words).map((g) => ({ start: g[0].start, end: g.at(-1)!.end, text: textOf(g) }));

/** A paragraph as rows for an export: one per line behind its timecode, or the whole text untimed. */
export function rowsOf(p: Para, { timecodes }: ExportOptions): { time?: string; text: string }[] {
  return timecodes ? splitLines(p.words).map((l) => ({ time: `[${timecode(l.start)}]`, text: l.text })) : [{ text: textOf(p.words) }];
}

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');

/** m:ss, or h:mm:ss from an hour. */
export const clock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};

/** hh:mm:ss, for a timecode in front of a line. */
export const timecode = (s: number) => `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;

/** Plain text: title, subtitle, then each paragraph, every line starting with its timecode. */
export function transcriptTxt(title: string, subtitle: string, paras: Para[], opts: ExportOptions): string {
  const out = [title, subtitle, ''];
  for (const p of paras) {
    const who = speakerLabel(p, opts);
    out.push(...(who ? [who] : []), ...rowsOf(p, opts).map((r) => (r.time ? `${r.time} ${r.text}` : r.text)), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** True when most letters are Arabic, Hebrew or another right-to-left script. */
export function isRtl(text: string): boolean {
  const rtl = text.match(/[֐-ࣿיִ-﷿ﹰ-﻿]/g)?.length ?? 0;
  const ltr = text.match(/\p{L}/gu)?.length ?? 0;
  return rtl > (ltr - rtl);
}

/** A file name without its extension. */
export const baseName = (name: string) => name.replace(/\.[^.]+$/, '') || name;
