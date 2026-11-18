import { describe, expect, it } from 'vitest';
import { deleteWords, replaceWords, wordsFromText, textOf, toEndOfTurn, wholeSentences } from './edit';
import type { Word } from './transcript';

const w = (id: string, text: string, start: number, speaker?: string): Word => ({ id, text, start, end: start + 1, ...(speaker ? { speaker } : {}) });
const words = [w('a', 'Hello', 0, 's1'), w('b', 'there.', 1, 's1'), w('c', 'How', 2, 's2'), w('d', 'are', 3, 's2'), w('e', 'you?', 4, 's2'), w('f', 'Fine.', 5, 's1')];
const ids = (...x: string[]) => new Set(x);
const texts = (x: Word[]) => x.map((v) => v.text).join(' ');
let n = 0;
const newId = () => `n${n++}`;

describe('edit several words', () => {
  it('deletes a selection', () => {
    expect(texts(deleteWords(words, ids('c', 'd', 'e')))).toBe('Hello there. Fine.');
  });
  it('widens to whole sentences', () => {
    expect(wholeSentences(words, ids('d'))).toEqual(['c', 'd', 'e']);
    expect(wholeSentences(words, ids('b', 'c'))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(wholeSentences(words, ids('f'))).toEqual(['f']);
    expect(wholeSentences(words, ids())).toEqual([]);
  });
  it('reads the selection back as text', () => {
    expect(textOf(words, ids('c', 'd', 'e'))).toBe('How are you?');
  });
  it('keeps times and speakers when only the words change', () => {
    const r = replaceWords(words, ids('c', 'd', 'e'), 'Why are they', newId);
    expect(texts(r)).toBe('Hello there. Why are they Fine.');
    expect(r[2]).toMatchObject({ id: 'c', start: 2, speaker: 's2' });
  });
  it('shares the time of the stretch when the count changes', () => {
    const r = replaceWords(words, ids('c', 'd', 'e'), 'Okay then', newId);
    expect(texts(r)).toBe('Hello there. Okay then Fine.');
    const [x, y] = r.slice(2, 4);
    expect(x.start).toBe(2);
    expect(y.end).toBe(5);
    expect(x.end).toBeCloseTo(y.start);
    expect(x.speaker).toBe('s2');
  });
  it('turns one word into several, and empty text into a deletion', () => {
    expect(texts(replaceWords(words, ids('a'), 'Well hello', newId))).toBe('Well hello there. How are you? Fine.');
    expect(texts(replaceWords(words, ids('c', 'd'), '  ', newId))).toBe('Hello there. you? Fine.');
  });
  it('carries a selection to the end of the speaker turn', () => {
    expect(toEndOfTurn(words, ids('c'))).toEqual(['c', 'd', 'e']);
    expect(toEndOfTurn(words, ids('d', 'e'))).toEqual(['d', 'e']);
    expect(toEndOfTurn(words, ids('a'))).toEqual(['a', 'b']);
    expect(toEndOfTurn(words, ids())).toEqual([]);
  });
});

describe('typed-in text', () => {
  it('spreads words over the time, in order, by length', () => {
    let n = 0;
    const r = wordsFromText('Good evening everyone', 0, 10, () => `t${n++}`);
    expect(r.map((x) => x.text)).toEqual(['Good', 'evening', 'everyone']);
    expect(r[0].start).toBe(0);
    expect(r.at(-1)!.end).toBeLessThanOrEqual(10);
    expect(r[1].start).toBeGreaterThan(r[0].end - 1e-9);
    expect(r[2].end - r[2].start).toBeGreaterThan(r[0].end - r[0].start);
  });
  it('leaves a longer pause where a blank line is', () => {
    const r = wordsFromText('One two\n\nThree four', 0, 20, () => 'x');
    expect(r).toHaveLength(4);
    expect(r[2].start - r[1].end).toBeGreaterThan(1.5);
  });
  it('gives nothing for empty text', () => {
    expect(wordsFromText('  \n ', 0, 10, () => 'x')).toEqual([]);
  });
});
