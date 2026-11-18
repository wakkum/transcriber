// Working out who spoke when, around two small models (speaker segmentation and voice embeddings,
// run in diarize.worker.ts): speech is cut into windows of at most 10 s at pauses; the segmentation
// model says which of up to 3 local speakers talks in each frame of a window; each local speaker's
// own audio gets a voice embedding; clustering (cluster.ts) turns local speakers into people; and
// every word then takes the person talking over it.

import { cluster } from './cluster';

export type Span = { start: number; end: number };
/** A stretch where person `speaker` (0, 1, ...) is talking. Segments of different people may overlap. */
export type SpeakerSegment = Span & { speaker: number };

/** Auto mode: two voices closer than this (cosine distance of their embeddings) are one person. */
export const CLUSTER_THRESHOLD = 0.35;
/** Auto mode: a "speaker" with less speech than this in total is folded into the nearest real one. */
export const MIN_SPEAKER_SECONDS = 3;

/** The segmentation model's 7 classes: which local speakers (0 to 2) are talking. Class 0 is silence. */
export const POWERSET: number[][] = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]];

/** Per frame, a bit mask of the local speakers talking (bit s = speaker s), from the model's logits (frames x 7). */
export function frameMasks(logits: ArrayLike<ArrayLike<number>>): number[] {
  return Array.from({ length: logits.length }, (_, f) => {
    let best = 0;
    for (let c = 1; c < 7; c++) if (logits[f][c] > logits[f][best]) best = c;
    return POWERSET[best].reduce((m, s) => m | (1 << s), 0);
  });
}

/**
 * Windows of audio that cover the speech: each at most `max` seconds, cut in the biggest pause in
 * the second part of the window so no word is split, with `pad` of room on each side.
 * `words` are in time order.
 */
export function planWindows(words: Span[], duration: number, { max = 10, pad = 0.15, minLength = 1 } = {}): Span[] {
  const out: Span[] = [];
  let i = 0;
  while (i < words.length) {
    // the words that fit in this window
    let j = i;
    while (j + 1 < words.length && words[j + 1].end - words[i].start <= max - 2 * pad) j++;
    if (j + 1 < words.length) {
      // cut at the widest gap among the last 60% of the words that fit (not the first words: windows would get tiny)
      const from = i + Math.floor((j - i) * 0.4);
      const gaps = Array.from({ length: j - from + 1 }, (_, n) => words[from + n + 1].start - words[from + n].end);
      const widest = Math.max(...gaps);
      // among pauses about as wide as the widest, the latest (so windows come out long)
      const at = gaps.findLastIndex((g) => g >= widest - 0.02);
      const cut = from + at;
      const gap = widest;
      // keep a lone very long word whole; otherwise cut at the best gap, or after the last fitting word
      j = gap > 0.05 ? cut : j;
    }
    let start = Math.max(0, words[i].start - pad);
    let end = Math.min(duration, words[j].end + pad);
    if (end - start < minLength) {
      const mid = (start + end) / 2;
      start = Math.max(0, mid - minLength / 2);
      end = Math.min(duration, start + minLength);
    }
    out.push({ start, end });
    i = j + 1;
  }
  return out;
}

/**
 * The frames to build local speaker `s`'s voice embedding from: those where only `s` talks, or all
 * where `s` talks if too little is clean. Null when there is too little to judge a voice by.
 */
export function embeddingFrames(masks: number[], s: number, frameSeconds: number, { minClean = 0.8, minAny = 1.2 } = {}): number[] | null {
  const bit = 1 << s;
  const clean: number[] = [];
  const any: number[] = [];
  masks.forEach((m, f) => {
    if (!(m & bit)) return;
    any.push(f);
    if (m === bit) clean.push(f);
  });
  if (clean.length * frameSeconds >= minClean) return clean;
  return any.length * frameSeconds >= minAny ? any : null;
}

/** Runs of consecutive frames (as time spans) where local speaker `s` talks, joining gaps shorter than `joinGap` seconds. */
export function speakerRuns(masks: number[], s: number, frameSeconds: number, t0: number, joinGap = 0.25): Span[] {
  const bit = 1 << s;
  const out: Span[] = [];
  masks.forEach((m, f) => {
    if (!(m & bit)) return;
    const start = t0 + f * frameSeconds;
    const last = out.at(-1);
    if (last && start - last.end <= joinGap) last.end = start + frameSeconds;
    else out.push({ start, end: start + frameSeconds });
  });
  return out;
}

/** Renumber speakers in place so the one who talks first is 0, the next to join in is 1, and so on. `segments` are in time order. */
export function firstToTalkIsZero(segments: SpeakerSegment[]): SpeakerSegment[] {
  const order = new Map<number, number>();
  for (const s of segments) if (!order.has(s.speaker)) order.set(s.speaker, order.size);
  for (const s of segments) s.speaker = order.get(s.speaker)!;
  return segments;
}

/** The person talking over each word: the one whose segments overlap it most; nearest in time if none do. */
export function assignWords(words: Span[], segments: SpeakerSegment[]): number[] {
  if (!segments.length) return words.map(() => 0);
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  let from = 0;
  return words.map((w) => {
    // words come in time order, so the first segment that could still touch one only moves forward
    while (from < sorted.length - 1 && sorted[from].end < w.start - 30) from++;
    const score = new Map<number, number>();
    let nearest = sorted[from];
    let nearestGap = Infinity;
    for (let k = from; k < sorted.length && sorted[k].start < w.end + 30; k++) {
      const s = sorted[k];
      const overlap = Math.min(s.end, w.end) - Math.max(s.start, w.start);
      if (overlap > 0) score.set(s.speaker, (score.get(s.speaker) ?? 0) + overlap);
      const gap = Math.max(s.start - w.end, w.start - s.end, 0);
      if (gap < nearestGap) [nearest, nearestGap] = [s, gap];
    }
    if (!score.size) return nearest.speaker;
    return [...score].reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
  });
}

/**
 * Undo single short words that took another speaker's label between two words of the same
 * speaker (a stray frame of overlap), which would otherwise split a paragraph in three.
 */
export function smoothSpeakers(speakers: number[], words: Span[], maxFlip = 0.45): number[] {
  const out = [...speakers];
  for (let i = 1; i + 1 < out.length; i++) {
    if (out[i - 1] === out[i + 1] && out[i] !== out[i - 1] && words[i].end - words[i].start <= maxFlip) out[i] = out[i - 1];
  }
  return out;
}

/** Stretches where two or more local speakers talk at once (runs shorter than `min` seconds are blips). */
export function overlapSpans(masks: number[], frameSeconds: number, t0: number, { min = 0.2, joinGap = 0.1 } = {}): Span[] {
  const both = (m: number) => (m & (m - 1)) !== 0; // more than one bit set
  const out: Span[] = [];
  masks.forEach((m, f) => {
    if (!both(m)) return;
    const start = t0 + f * frameSeconds;
    const last = out.at(-1);
    if (last && start - last.end <= joinGap) last.end = start + frameSeconds;
    else out.push({ start, end: start + frameSeconds });
  });
  return out.filter((o) => o.end - o.start >= min);
}

/** Stretches where the model hears someone talking at all (any local speaker). */
export function speechSpans(masks: number[], frameSeconds: number, t0: number, joinGap = 0.1): Span[] {
  const out: Span[] = [];
  masks.forEach((m, f) => {
    if (!m) return;
    const start = t0 + f * frameSeconds;
    const last = out.at(-1);
    if (last && start - last.end <= joinGap) last.end = start + frameSeconds;
    else out.push({ start, end: start + frameSeconds });
  });
  return out;
}

/** For each word, the share (0 to 1) of its time that falls in `speech` (in time order). Words over music or noise get about 0. */
export function speechShares(words: Span[], speech: Span[]): number[] {
  let from = 0;
  return words.map((w) => {
    while (from < speech.length && speech[from].end < w.start - 5) from++;
    let heard = 0;
    for (let k = from; k < speech.length && speech[k].start < w.end; k++) heard += Math.max(0, Math.min(speech[k].end, w.end) - Math.max(speech[k].start, w.start));
    return Math.min(1, heard / Math.max(w.end - w.start, 0.05));
  });
}

/** Which words are mostly (at least `share` of their time) spoken over by someone else. `overlaps` are in time order. */
export function overlapFlags(words: Span[], overlaps: Span[], share = 0.5): boolean[] {
  let from = 0;
  return words.map((w) => {
    while (from < overlaps.length && overlaps[from].end < w.start - 5) from++;
    let over = 0;
    for (let k = from; k < overlaps.length && overlaps[k].start < w.end; k++) over += Math.max(0, Math.min(overlaps[k].end, w.end) - Math.max(overlaps[k].start, w.start));
    return over > 0 && over >= share * Math.max(w.end - w.start, 0.05);
  });
}

/**
 * What the voice step finds before anyone is named: one voice vector per (stretch, local speaker), when
 * that speaker talks, and where people talk over each other. Kept so who-is-who can be redone at once.
 */
export type Voices = {
  vectors: number[][];
  /** Seconds of speech behind each vector. */
  weights: number[];
  /** When each vector's speaker talks. */
  runs: Span[][];
  overlaps: Span[];
  /** Where anyone talks, as heard by the segmentation model: words outside it are probably not speech. */
  speech: Span[];
};

export const noVoices = (): Voices => ({ vectors: [], weights: [], runs: [], overlaps: [], speech: [] });

/** The voices of one part of a recording, moved `dt` seconds later (parts are found separately, then joined). */
export function shiftVoices(v: Voices, dt: number): Voices {
  const move = (x: Span): Span => ({ start: x.start + dt, end: x.end + dt });
  return { vectors: v.vectors, weights: v.weights, runs: v.runs.map((r) => r.map(move)), overlaps: v.overlaps.map(move), speech: v.speech.map(move) };
}

export const joinVoices = (parts: Voices[]): Voices => ({
  vectors: parts.flatMap((p) => p.vectors),
  weights: parts.flatMap((p) => p.weights),
  runs: parts.flatMap((p) => p.runs),
  overlaps: parts.flatMap((p) => p.overlaps).sort((a, b) => a.start - b.start),
  speech: parts.flatMap((p) => p.speech).sort((a, b) => a.start - b.start),
});

/**
 * "Separate more" to "Merge more": the distance under which two voices are one person, from the
 * strictest (many people) to the loosest (few). The middle one is the default.
 */
export const SEPARATION_LEVELS = [0.2, 0.27, CLUSTER_THRESHOLD, 0.45, 0.55];
export const DEFAULT_SEPARATION = 2;

/** Who is who: group the voices into people (a fixed `count`, or found by `threshold`), as segments in time order. */
export function labelVoices(v: Voices, { count, threshold = CLUSTER_THRESHOLD }: { count?: number; threshold?: number } = {}): { segments: SpeakerSegment[]; people: number } {
  const labels = cluster(v.vectors, { count, threshold, minWeight: MIN_SPEAKER_SECONDS, weights: v.weights });
  const segments: SpeakerSegment[] = [];
  v.runs.forEach((runs, i) => runs.forEach((r) => segments.push({ ...r, speaker: labels[i] })));
  segments.sort((x, y) => x.start - y.start);
  firstToTalkIsZero(segments);
  return { segments, people: labels.length ? Math.max(...labels) + 1 : 1 };
}
