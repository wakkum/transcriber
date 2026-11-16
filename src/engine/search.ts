// Finding text in a transcript: case, accents and punctuation are ignored, and a phrase matches words
// that follow each other. While typing, the first and last word of the phrase may match only part of
// a word ("progr" finds "program,"). Also replacing matches.

import { replaceWords } from './edit';
import type { Word } from './transcript';

/** Lowercase, no accents or marks (Arabic vowel signs too), letters and digits only. */
export const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Every place the query occurs, each as the ids of the words it covers, in reading order.
 * With `whole`, every word of the phrase must match completely (for replacing: "the" is not "then").
 */
export function findMatches(words: readonly { id: string; text: string }[], query: string, whole = false): string[][] {
  const tokens = query.split(/\s+/).map(normalize).filter(Boolean);
  if (!tokens.length) return [];
  const plain = words.map((w) => ({ id: w.id, key: normalize(w.text) })).filter((w) => w.key); // lone punctuation never matches
  const n = tokens.length;
  const fits = (key: string, t: string, k: number) => (whole ? key === t : n === 1 ? key.includes(t) : k === 0 ? key.endsWith(t) : k === n - 1 ? key.startsWith(t) : key === t);
  const out: string[][] = [];
  for (let i = 0; i + n <= plain.length; i++) {
    if (tokens.every((t, k) => fits(plain[i + k].key, t, k))) out.push(plain.slice(i, i + n).map((w) => w.id));
  }
  return out;
}

const edges = (first: string, last: string) => [/^[^\p{L}\p{N}]*/u.exec(first)![0], /[^\p{L}\p{N}]*$/u.exec(last)![0]];

/** One match replaced by `text`, keeping the punctuation just outside it ("program," becomes "show,"). Empty text deletes the words. */
export function replaceMatch(words: Word[], match: readonly string[], text: string, newId: () => string): Word[] {
  const [a, b] = [words.findIndex((w) => w.id === match[0]), words.findIndex((w) => w.id === match.at(-1))];
  if (a < 0 || b < a) return words;
  const ids = new Set(words.slice(a, b + 1).map((w) => w.id));
  const [lead, trail] = edges(words[a].text, words[b].text);
  return replaceWords(words, ids, text.trim() ? `${lead}${text.trim()}${trail}` : '', newId);
}

/** Every match replaced (from the end, so earlier ones keep their place). */
export function replaceAll(words: Word[], matches: readonly (readonly string[])[], text: string, newId: () => string): Word[] {
  return [...matches].reverse().reduce((acc, m) => replaceMatch(acc, m, text, newId), words);
}
