// Some models (the Bengali-trained small one) were exported without the attention data that gives
// each word its own time. They still give a start and end for every sentence or so, so the words
// of a segment share its time by their length: good enough to click a word and play near it.

export type Segment = { text: string; start: number; end: number };

/** The words of each segment, spread over the segment's time by length (a gap of a few hundredths between words). */
export function wordsFromSegments(segments: Segment[]): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  for (const seg of segments) {
    const tokens = seg.text.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const span = Math.max(seg.end - seg.start, 0.05 * tokens.length);
    const total = tokens.reduce((n, t) => n + t.length + 1, 0);
    let at = seg.start;
    for (const t of tokens) {
      const len = (span * (t.length + 1)) / total;
      out.push({ text: t, start: at, end: at + len * 0.92 });
      at += len;
    }
  }
  return out;
}
