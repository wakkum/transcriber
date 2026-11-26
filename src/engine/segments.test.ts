import { describe, expect, it } from 'vitest';
import { wordsFromSegments } from './segments';

describe('wordsFromSegments', () => {
  it('spreads the words of a segment over its time, by length, in order', () => {
    const w = wordsFromSegments([{ text: ' আমি আজ বাংলায় কথা ', start: 2, end: 8 }]);
    expect(w.map((x) => x.text)).toEqual(['আমি', 'আজ', 'বাংলায়', 'কথা']);
    expect(w[0].start).toBe(2);
    expect(w.at(-1)!.end).toBeLessThanOrEqual(8);
    for (let i = 1; i < w.length; i++) expect(w[i].start).toBeGreaterThanOrEqual(w[i - 1].end);
    expect(w[2].end - w[2].start).toBeGreaterThan(w[1].end - w[1].start);
  });
  it('handles several segments, empty ones and zero-length ones', () => {
    const w = wordsFromSegments([{ text: 'a b', start: 0, end: 1 }, { text: '  ', start: 1, end: 2 }, { text: 'c', start: 5, end: 5 }]);
    expect(w.map((x) => x.text)).toEqual(['a', 'b', 'c']);
    expect(w[2].start).toBe(5);
    expect(w[2].end).toBeGreaterThan(5);
  });
});
