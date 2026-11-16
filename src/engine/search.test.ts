import { describe, expect, it } from 'vitest';
import { findMatches, normalize, replaceAll, replaceMatch } from './search';

const words = 'Welcome back to the program, today my guest has spent twenty years studying the ocean. Café – the Ocean!'.split(' ').map((text, i) => ({ id: `w${i}`, text }));
const texts = (m: string[][]) => m.map((ids) => ids.map((id) => words.find((w) => w.id === id)!.text).join(' '));

describe('findMatches', () => {
  it('ignores case, punctuation and accents', () => {
    expect(texts(findMatches(words, 'OCEAN'))).toEqual(['ocean.', 'Ocean!']);
    expect(texts(findMatches(words, 'cafe'))).toEqual(['Café']);
  });
  it('finds part of a word while typing', () => {
    expect(texts(findMatches(words, 'progr'))).toEqual(['program,']);
  });
  it('finds phrases of consecutive words', () => {
    expect(texts(findMatches(words, 'the ocean'))).toEqual(['the ocean.', 'the Ocean!']);
    expect(texts(findMatches(words, 'back to the'))).toEqual(['back to the']);
    expect(findMatches(words, 'the today')).toEqual([]);
  });
  it('skips lone punctuation words and handles empty queries', () => {
    expect(findMatches(words, '')).toEqual([]);
    expect(findMatches(words, ' ?! ')).toEqual([]);
    expect(findMatches(words, 'cafe the')).toHaveLength(1);
  });
  it('normalizes Arabic marks away', () => {
    expect(normalize('مَرْحَبًا')).toBe(normalize('مرحبا'));
  });
});

describe('replace', () => {
  let n = 0;
  const newId = () => `r${n++}`;
  const w2 = 'We like the program, the programs and the Program.'.split(' ').map((text, i) => ({ id: `x${i}`, text, start: i, end: i + 1 }));
  const read = (x: typeof w2) => x.map((v) => v.text).join(' ');

  it('only matches whole words when asked', () => {
    expect(findMatches(w2, 'program', true)).toHaveLength(2);
    expect(findMatches(w2, 'program')).toHaveLength(3);
  });
  it('keeps the punctuation next to a replaced word', () => {
    const [m] = findMatches(w2, 'program', true);
    expect(read(replaceMatch(w2, m, 'show', newId))).toBe('We like the show, the programs and the Program.');
  });
  it('replaces every match, even when the number of words changes', () => {
    const all = findMatches(w2, 'the program', true);
    expect(read(replaceAll(w2, all, 'our show', newId))).toBe('We like our show, the programs and our show.');
    expect(read(replaceAll(w2, findMatches(w2, 'like', true), '', newId))).toBe('We the program, the programs and the Program.');
  });
});
