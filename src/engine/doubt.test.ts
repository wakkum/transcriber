import { describe, expect, it } from 'vitest';
import { doubtful, inventedStretch, sparseRecording } from './doubt';

const w = (text: string, start: number, dur = 0.4) => ({ text, start, end: start + dur });
const ok = (n: number) => Array(n).fill(1);

describe('doubtful words', () => {
  it('leaves normal speech alone', () => {
    const words = [w('Welcome', 0), w('back', 0.5), w('to', 1), w('the', 1.4), w('program.', 1.8)];
    expect(doubtful(words, ok(5))).toEqual([false, false, false, false, false]);
  });
  it('flags a word spoken over silence', () => {
    expect(doubtful([w('Thanks', 0), w('everyone', 1)], [0.9, 0.05])).toEqual([false, true]);
  });
  it('flags a word too fast to say', () => {
    expect(doubtful([w('extraordinarily', 0, 0.1), w('would', 1, 0.1)], ok(2))).toEqual([true, false]);
  });
  it('flags loops after the second time', () => {
    const words = ['I', 'know', 'you', 'you', 'you', 'you', 'you', 'go'].map((t, i) => w(t, i));
    expect(doubtful(words, ok(8))).toEqual([false, false, false, false, true, true, true, false]);
    const phrase = ['okay', 'so', 'the', 'thing', 'the', 'thing', 'the', 'thing', 'the', 'thing', 'is'].map((t, i) => w(t, i));
    const f = doubtful(phrase, ok(11));
    expect(f.slice(0, 6)).toEqual([false, false, false, false, false, false]);
    expect(f.slice(6, 10)).toEqual([true, true, true, true]);
    expect(f[10]).toBe(false);
  });
  it('does not call a few repeats a loop', () => {
    const words = ['no', 'no', 'no'].map((t, i) => w(t, i));
    expect(doubtful(words, ok(3))).toEqual([false, false, false]);
  });
});

describe('invented stretches', () => {
  const ws = (...t: string[]) => t.map((x, i) => w(x, i));
  it('drops a stock phrase over quiet or sparse sound', () => {
    expect(inventedStretch(ws('Thanks', 'for', 'watching!'), [0.5, 0.2, 0.1], 25)).toBe(true);
    expect(inventedStretch(ws('Thanks', 'for', 'watching!'), [0.9, 0.9, 0.9], 25)).toBe(true); // 3 words in 25 s is sparse
    expect(inventedStretch(ws('Thanks', 'for', 'watching!'), [0.9, 0.9, 0.9], 2)).toBe(false);
  });
  it('drops a stretch where every word is over near silence', () => {
    expect(inventedStretch(ws('Something', 'odd'), [0.05, 0.1], 5)).toBe(true);
  });
  it('keeps real speech, including a spoken "thank you"', () => {
    expect(inventedStretch(ws('Welcome', 'back', 'to', 'the', 'program'), [0.9, 0.8, 0.9, 0.9, 0.9], 3)).toBe(false);
    expect(inventedStretch(ws('Thank', 'you.'), [0.9, 0.9], 2)).toBe(false);
    expect(inventedStretch([], [], 5)).toBe(false);
  });
});

describe('sparse recordings', () => {
  it('calls a few words in a long file invented, but not a short clip or a real talk', () => {
    expect(sparseRecording(2, 40)).toBe(true);
    expect(sparseRecording(1, 5)).toBe(false);
    expect(sparseRecording(1, 3)).toBe(false);
    expect(sparseRecording(112, 39)).toBe(false);
    expect(sparseRecording(8, 600)).toBe(false);
    expect(sparseRecording(0, 40)).toBe(false);
  });
});
