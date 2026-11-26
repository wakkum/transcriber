import { describe, expect, it } from 'vitest';
import { REVISIONS } from './models';
import { codeFor, current, paraKey, pieces, toTranslate, TRANSLATORS, type Translation } from './translate';
import type { Para } from './transcript';

const para = (id: string, ...words: string[]): Para => ({ start: 0, words: words.map((text, i) => ({ id: `${id}${i}`, text, start: i, end: i + 1 })) });

describe('translate', () => {
  it('pins every translation model and has codes for each language', () => {
    for (const t of TRANSLATORS) {
      expect(REVISIONS[t.model]).toMatch(/^[0-9a-f]{40}$/);
      expect(codeFor(t, 'bengali')).toBe(t.codes === 'm2m' ? 'bn' : 'ben_Beng');
    }
    expect(codeFor(TRANSLATORS[0], 'klingon')).toBeUndefined();
  });

  it('finds the paragraphs that are new or edited since translating', () => {
    const a = para('a', 'Hello', 'there.');
    const b = para('b', 'Bye.');
    const tr: Translation = { target: 'bengali', translator: 'standard', items: { [paraKey(a)]: { source: 'Hello there.', text: 'X' }, [paraKey(b)]: { source: 'Goodbye.', text: 'Y' } } };
    expect(toTranslate([a, b], tr)).toEqual([b]);
    expect(current([a, b], tr)).toEqual({ [paraKey(a)]: 'X' });
    expect(toTranslate([a, b], null)).toEqual([a, b]);
  });

  it('cuts text into pieces of whole sentences', () => {
    expect(pieces('One. Two. Three.', 100)).toEqual(['One. Two. Three.']);
    expect(pieces('One sentence here. Another one here.', 20)).toEqual(['One sentence here.', 'Another one here.']);
    expect(pieces('আমি ভালো আছি। তুমি কেমন আছো?', 20)).toHaveLength(2);
    // no full stops: about a line at a time
    expect(pieces('এক দুই তিন চার পাঁচ ছয় সাত আট নয় দশ এগারো বারো তেরো চোদ্দ পনেরো ষোলো সতেরো আঠারো উনিশ কুড়ি একুশ বাইশ তেইশ').every((p) => p.length <= 90)).toBe(true);
    const long = pieces('word '.repeat(199) + 'word.', 100);
    expect(long.every((p) => p.length <= 100)).toBe(true);
    expect(long.join(' ').split(' ')).toHaveLength(200);
  });
});
