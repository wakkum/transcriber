// Speakers of a transcript and the edits people make to them: names, giving words or a paragraph to
// someone else, merging two speakers that were really one person. Every function returns new
// arrays (and the same array when nothing changed), so the app can keep undo snapshots cheaply.
import type { Word } from './transcript';

export type Speaker = { id: string; name: string };

const lower = (s: string) => s.trim().toLocaleLowerCase();

/** A new speaker with the lowest "Speaker N" name not in use (so a merge never makes a name repeat). */
export function addSpeaker(speakers: Speaker[]): { speakers: Speaker[]; id: string } {
  const names = new Set(speakers.map((s) => lower(s.name)));
  const ids = new Set(speakers.map((s) => s.id));
  let n = 1;
  while (names.has(lower(`Speaker ${n}`))) n++;
  let k = 1;
  while (ids.has(`s${k}`)) k++;
  return { speakers: [...speakers, { id: `s${k}`, name: `Speaker ${n}` }], id: `s${k}` };
}

/** The speakers and their words from the person each word was given by identification (0, 1, 2...). */
export function fromIdentification(words: Word[], who: number[]): { words: Word[]; speakers: Speaker[] } {
  const count = who.length ? Math.max(...who) + 1 : 0;
  const speakers = Array.from({ length: count }, (_, i) => ({ id: `s${i + 1}`, name: `Speaker ${i + 1}` }));
  return { words: words.map((w, i) => ({ ...w, speaker: speakers[who[i]].id })), speakers };
}

/** Another speaker already called `name` (ignoring case and spaces at the ends), if any. */
export const nameTaken = (speakers: Speaker[], id: string, name: string) => speakers.find((s) => s.id !== id && lower(s.name) === lower(name));

/** `id` renamed; a blank name changes nothing. */
export function renameSpeaker(speakers: Speaker[], id: string, name: string): Speaker[] {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean || speakers.find((s) => s.id === id)?.name === clean) return speakers;
  return speakers.map((s) => (s.id === id ? { ...s, name: clean } : s));
}

/** The words with these ids given to `speaker`. */
export function assignTo(words: Word[], ids: ReadonlySet<string>, speaker: string): Word[] {
  if (!words.some((w) => ids.has(w.id) && w.speaker !== speaker)) return words;
  return words.map((w) => (ids.has(w.id) ? { ...w, speaker } : w));
}

/** Everything `from` said given to `into`, and `from` removed. */
export function mergeSpeakers(words: Word[], speakers: Speaker[], from: string, into: string): { words: Word[]; speakers: Speaker[] } {
  if (from === into) return { words, speakers };
  return { words: words.map((w) => (w.speaker === from ? { ...w, speaker: into } : w)), speakers: speakers.filter((s) => s.id !== from) };
}

/** The speakers who still have words, in their order (after giving words away, someone may have none left). */
export function usedSpeakers(speakers: Speaker[], words: Word[]): Speaker[] {
  const used = new Set(words.map((w) => w.speaker));
  const kept = speakers.filter((s) => used.has(s.id));
  return kept.length === speakers.length ? speakers : kept;
}

/** Display names by id, for exports. */
export const namesOf = (speakers: Speaker[]): Record<string, string> => Object.fromEntries(speakers.map((s) => [s.id, s.name]));
