// Correcting several words at once: delete a selection, retype it, or widen it to the whole sentence.
import type { Word } from './transcript';

const SENTENCE_END = /[.!?…؟。！？]["'”’)\]]*$/u;

/** Positions of the first and last selected word, or null when nothing is selected. */
function block(words: readonly Word[], ids: ReadonlySet<string>): [number, number] | null {
  let a = -1;
  let b = -1;
  words.forEach((w, i) => {
    if (!ids.has(w.id)) return;
    if (a < 0) a = i;
    b = i;
  });
  return a < 0 ? null : [a, b];
}

/** The selection widened to whole sentences (a sentence ends at a word closing with . ! ? or the like). */
export function wholeSentences(words: readonly Word[], ids: ReadonlySet<string>): string[] {
  const r = block(words, ids);
  if (!r) return [];
  let [a, b] = r;
  while (a > 0 && !SENTENCE_END.test(words[a - 1].text)) a--;
  while (b < words.length - 1 && !SENTENCE_END.test(words[b].text)) b++;
  return words.slice(a, b + 1).map((w) => w.id);
}

export function deleteWords(words: Word[], ids: ReadonlySet<string>): Word[] {
  return words.filter((w) => !ids.has(w.id));
}

/** The text of the selected stretch, as it reads. */
export function textOf(words: readonly Word[], ids: ReadonlySet<string>): string {
  return words.filter((w) => ids.has(w.id)).map((w) => w.text).join(' ');
}

/**
 * Replace the selected stretch with `text`. The same number of words keeps every word's time and speaker;
 * otherwise the new words share the stretch's time by their length, and take the speaker who was talking
 * at about that point. Empty text deletes the stretch.
 */
export function replaceWords(words: Word[], ids: ReadonlySet<string>, text: string, newId: () => string): Word[] {
  const r = block(words, ids);
  if (!r) return words;
  const [a, b] = r;
  const old = words.slice(a, b + 1);
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  let next: Word[];
  if (tokens.length === old.length) next = old.map((w, i) => ({ ...w, text: tokens[i], doubt: undefined }));
  else if (!tokens.length) next = [];
  else {
    const [from, to] = [old[0].start, old.at(-1)!.end];
    const weight = tokens.map((t) => t.length + 1);
    const total = weight.reduce((x, y) => x + y, 0);
    let at = from;
    next = tokens.map((t, i) => {
      const start = at;
      at += ((to - from) * weight[i]) / total;
      const speaker = old[Math.min(old.length - 1, Math.floor((i / tokens.length) * old.length))].speaker;
      return { id: newId(), text: t, start, end: i === tokens.length - 1 ? to : at, ...(speaker ? { speaker } : {}) };
    });
  }
  return [...words.slice(0, a), ...next, ...words.slice(b + 1)];
}

/** The selection carried on to the end of the speaker's turn: "from this word on, someone else is talking". */
export function toEndOfTurn(words: readonly Word[], ids: ReadonlySet<string>): string[] {
  const r = block(words, ids);
  if (!r) return [];
  const [a, last] = r;
  let b = last;
  while (b < words.length - 1 && words[b + 1].speaker === words[last].speaker) b++;
  return words.slice(a, b + 1).map((w) => w.id);
}

/**
 * Words typed in by hand for a stretch with no recognised speech: spread over [from, to] by their length,
 * so clicking a word plays roughly the right place. A blank line starts a new paragraph (a pause longer
 * than the one that splits paragraphs is left there).
 */
export function wordsFromText(text: string, from: number, to: number, newId: () => string, paragraphGap = 2): Word[] {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim().split(/\s+/).filter(Boolean)).filter((b) => b.length);
  const chars = blocks.flat().reduce((n, t) => n + t.length + 1, 0);
  if (!chars) return [];
  const gaps = (blocks.length - 1) * paragraphGap;
  const speech = Math.max(to - from - gaps, 0.5 * chars * 0.05);
  let at = from;
  const out: Word[] = [];
  blocks.forEach((block, b) => {
    for (const t of block) {
      const len = (speech * (t.length + 1)) / chars;
      out.push({ id: newId(), text: t, start: at, end: at + len * 0.9 });
      at += len;
    }
    if (b < blocks.length - 1) at += paragraphGap;
  });
  return out;
}
