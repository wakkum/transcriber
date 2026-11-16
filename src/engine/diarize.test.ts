import { describe, expect, it } from 'vitest';
import { assignWords, DEFAULT_SEPARATION, embeddingFrames, firstToTalkIsZero, frameMasks, joinVoices, labelVoices, noVoices, overlapFlags, overlapSpans, planWindows, SEPARATION_LEVELS, shiftVoices, smoothSpeakers, speakerRuns, type SpeakerSegment } from './diarize';

/** n words of 0.4 s each, `gap` apart, from `at`. */
const run = (n: number, at = 0, gap = 0.1) => Array.from({ length: n }, (_, i) => ({ start: at + i * (0.4 + gap), end: at + i * (0.4 + gap) + 0.4 }));

describe('frameMasks', () => {
  it('reads the powerset classes as bit masks of local speakers', () => {
    const hot = (c: number) => Array.from({ length: 7 }, (_, i) => (i === c ? 5 : 0));
    expect(frameMasks([hot(0), hot(1), hot(2), hot(3), hot(4), hot(5), hot(6)])).toEqual([0, 1, 2, 4, 3, 5, 6]);
  });
});

describe('planWindows', () => {
  it('covers all words in windows of at most 10 s, never splitting a word', () => {
    const words = run(60); // 30 s of speech
    const w = planWindows(words, 31);
    expect(w.length).toBeGreaterThanOrEqual(3);
    for (const win of w) expect(win.end - win.start).toBeLessThanOrEqual(10.001);
    for (const word of words) expect(w.some((win) => win.start <= word.start && win.end >= word.end)).toBe(true);
  });

  it('cuts at the widest pause in the later part of a window', () => {
    // 20 words, then a 1 s pause, then 5 more: the cut falls in the pause
    const words = [...run(16), ...run(6, 8.4 + 1.0)];
    const w = planWindows(words, 20);
    expect(w).toHaveLength(2);
    expect(w[0].end).toBeCloseTo(words[15].end + 0.15);
    expect(w[1].start).toBeCloseTo(words[16].start - 0.15);
  });

  it('keeps windows inside the file and at least a second long', () => {
    expect(planWindows([{ start: 0.1, end: 0.3 }], 0.5)).toEqual([{ start: 0, end: 0.5 }]);
    const [only] = planWindows([{ start: 5, end: 5.2 }], 30);
    expect(only.end - only.start).toBeCloseTo(1);
    expect(planWindows([], 10)).toEqual([]);
  });
});

describe('embeddingFrames', () => {
  const sec = 0.1;
  it('uses the frames where only that speaker talks', () => {
    const masks = [...Array(10).fill(1), ...Array(5).fill(3), ...Array(10).fill(2)];
    expect(embeddingFrames(masks, 0, sec, { minClean: 0.8, minAny: 1.2 })).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  it('falls back to overlapped frames, or gives up when there is too little', () => {
    const masks = [...Array(4).fill(1), ...Array(10).fill(3)];
    expect(embeddingFrames(masks, 0, sec, { minClean: 0.8, minAny: 1.2 })).toHaveLength(14);
    expect(embeddingFrames([1, 1, 0, 0], 0, sec)).toBeNull();
    expect(embeddingFrames([1, 1, 0, 0], 2, sec)).toBeNull();
  });
});

describe('speakerRuns', () => {
  it('joins short gaps and offsets by the window start', () => {
    const masks = [1, 1, 0, 1, 0, 0, 0, 0, 1, 1]; // 0.1 s frames
    expect(speakerRuns(masks, 0, 0.1, 5, 0.15).map((r) => [Math.round(r.start * 10) / 10, Math.round(r.end * 10) / 10])).toEqual([[5, 5.4], [5.8, 6]]);
  });
});

describe('assignWords', () => {
  const segs: SpeakerSegment[] = [
    { start: 0, end: 4, speaker: 0 },
    { start: 4, end: 8, speaker: 1 },
    { start: 3.9, end: 4.0, speaker: 2 }, // a brief overlap
  ];
  it('takes the speaker covering most of the word', () => {
    expect(assignWords([{ start: 1, end: 1.4 }, { start: 5, end: 5.4 }, { start: 3.7, end: 4.1 }], segs)).toEqual([0, 1, 0]);
  });
  it('uses the nearest segment for words outside every segment', () => {
    expect(assignWords([{ start: 8.5, end: 8.9 }, { start: 100, end: 100.4 }], segs)).toEqual([1, 1]);
    expect(assignWords([{ start: 0, end: 1 }], [])).toEqual([0]);
  });
});

describe('firstToTalkIsZero', () => {
  it('numbers speakers by who speaks first', () => {
    const segs = [{ start: 0, end: 1, speaker: 2 }, { start: 1, end: 2, speaker: 0 }, { start: 2, end: 3, speaker: 2 }, { start: 3, end: 4, speaker: 1 }];
    expect(firstToTalkIsZero(segs).map((s) => s.speaker)).toEqual([0, 1, 0, 2]);
  });
});

describe('smoothSpeakers', () => {
  it('removes a short single-word flip between the same speaker, but keeps real turns', () => {
    const words = run(6);
    expect(smoothSpeakers([0, 0, 1, 0, 0, 0], words)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(smoothSpeakers([0, 0, 1, 1, 0, 0], words)).toEqual([0, 0, 1, 1, 0, 0]);
    expect(smoothSpeakers([0, 1, 0], [{ start: 0, end: 1 }, { start: 1, end: 3 }, { start: 3, end: 4 }])).toEqual([0, 1, 0]);
  });
});

describe('overlap', () => {
  it('finds stretches where two or more talk, ignoring blips', () => {
    // frames of 0.1 s: 0 = silence, 1 = A, 3 = A and B talking, 2 = B
    const masks = [1, 1, 3, 3, 3, 2, 2, 1, 3, 1];
    expect(overlapSpans(masks, 0.1, 10)).toEqual([{ start: 10.2, end: 10.5 }]);
  });
  it('flags words that are mostly spoken over', () => {
    const words = [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }];
    expect(overlapFlags(words, [{ start: 1.4, end: 3 }])).toEqual([false, true, true]);
    expect(overlapFlags(words, [])).toEqual([false, false, false]);
  });
});

describe('voices', () => {
  const near = (x: number) => [1, x, 0, 0];
  const voices = {
    vectors: [near(0), near(0.05), near(1.2), near(1.25)],
    weights: [5, 5, 5, 5],
    runs: [[{ start: 0, end: 2 }], [{ start: 4, end: 6 }], [{ start: 2, end: 4 }], [{ start: 6, end: 8 }]],
    overlaps: [],
  };
  it('groups voices into people, the first to talk being 0', () => {
    const r = labelVoices(voices, { count: 2 });
    expect(r.people).toBe(2);
    expect(r.segments.map((s) => s.speaker)).toEqual([0, 1, 0, 1]);
  });
  it('a looser level merges what a stricter one keeps apart', () => {
    const strict = labelVoices(voices, { threshold: SEPARATION_LEVELS[0] });
    const loose = labelVoices(voices, { threshold: SEPARATION_LEVELS.at(-1) });
    expect(strict.people).toBeGreaterThanOrEqual(loose.people);
    expect(SEPARATION_LEVELS[DEFAULT_SEPARATION]).toBeGreaterThan(SEPARATION_LEVELS[0]);
  });
  it('shifts and joins the voices of separate parts', () => {
    const a = shiftVoices(voices, 100);
    expect(a.runs[0][0]).toEqual({ start: 100, end: 102 });
    const joined = joinVoices([voices, a]);
    expect(joined.vectors).toHaveLength(8);
    expect(joinVoices([noVoices(), noVoices()]).vectors).toEqual([]);
  });
});
