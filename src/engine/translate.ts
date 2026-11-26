// Offline translation of a transcript, paragraph by paragraph: which translation model to use and
// which language codes it wants, how a paragraph is cut into pieces a model can take, and which
// paragraphs still need translating after the text was edited.
import type { Para } from './transcript';

export type Translator = { id: 'standard' | 'better'; label: string; model: string; size: string; note: string; licence: string; /** Language codes differ per model family. */ codes: 'm2m' | 'nllb' };

export const TRANSLATORS: Translator[] = [
  { id: 'standard', label: 'Standard', model: 'Xenova/m2m100_418M', size: '~630 MB', note: 'M2M100, 100 languages', licence: 'MIT', codes: 'm2m' },
  { id: 'better', label: 'Better', model: 'Xenova/nllb-200-distilled-600M', size: '~900 MB', note: 'NLLB-200, more accurate, non-commercial use only', licence: 'CC-BY-NC-4.0', codes: 'nllb' },
];

export const translatorFor = (id: string): Translator => TRANSLATORS.find((t) => t.id === id) ?? TRANSLATORS[0];

/** Language codes by Whisper language name: M2M100, then NLLB-200. */
const CODES: Record<string, [string, string]> = {
  english: ['en', 'eng_Latn'],
  arabic: ['ar', 'arb_Arab'],
  bengali: ['bn', 'ben_Beng'],
  chinese: ['zh', 'zho_Hans'],
  dutch: ['nl', 'nld_Latn'],
  french: ['fr', 'fra_Latn'],
  german: ['de', 'deu_Latn'],
  greek: ['el', 'ell_Grek'],
  hebrew: ['he', 'heb_Hebr'],
  hindi: ['hi', 'hin_Deva'],
  indonesian: ['id', 'ind_Latn'],
  italian: ['it', 'ita_Latn'],
  japanese: ['ja', 'jpn_Jpan'],
  korean: ['ko', 'kor_Hang'],
  malay: ['ms', 'zsm_Latn'],
  persian: ['fa', 'pes_Arab'],
  polish: ['pl', 'pol_Latn'],
  portuguese: ['pt', 'por_Latn'],
  russian: ['ru', 'rus_Cyrl'],
  spanish: ['es', 'spa_Latn'],
  swahili: ['sw', 'swh_Latn'],
  swedish: ['sv', 'swe_Latn'],
  tagalog: ['tl', 'tgl_Latn'],
  turkish: ['tr', 'tur_Latn'],
  ukrainian: ['uk', 'ukr_Cyrl'],
  urdu: ['ur', 'urd_Arab'],
};

/** The code a translator wants for a language (a Whisper language name), or undefined when it has none. */
export const codeFor = (t: Translator, language: string): string | undefined => CODES[language]?.[t.codes === 'm2m' ? 0 : 1];

/** A paragraph's translation, kept with the text it came from so edits show up as out of date. */
export type Translation = { target: string; translator: Translator['id']; items: Record<string, { source: string; text: string }> };

/** The key of a paragraph: its first word. */
export const paraKey = (p: Para) => p.words[0].id;
export const paraText = (p: Para) => p.words.map((w) => w.text).join(' ');

/** The paragraphs with no translation yet, or one made from text that has since been edited. */
export const toTranslate = (paras: Para[], tr: Translation | null | undefined): Para[] => paras.filter((p) => tr?.items[paraKey(p)]?.source !== paraText(p));

/** The translations that still match their paragraph, by paragraph key (what the page and the exports show). */
export function current(paras: Para[], tr: Translation | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of paras) {
    const item = tr?.items[paraKey(p)];
    if (item && item.source === paraText(p)) out[paraKey(p)] = item.text;
  }
  return out;
}

/**
 * A paragraph cut into pieces of whole sentences up to `max` characters (a model reads a few sentences at
 * a time well). Text with no full stops (Bengali often comes back without) goes in pieces of about one
 * transcript line: given a long unpunctuated run, the translation model drops its second half.
 */
export function pieces(text: string, max = 380): string[] {
  if (!/[.!?。؟।]/u.test(text)) max = Math.min(max, 90);
  const sentences = text.match(/[^.!?。؟।]+[.!?。؟।]*["')\]»”]*\s*/gu) ?? [text];
  const out: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  for (const s of sentences) {
    if (cur && cur.length + s.length > max) push();
    if (s.length > max) {
      // one very long sentence: cut it at spaces
      for (const word of s.split(/\s+/)) {
        if (cur && cur.length + word.length + 1 > max) push();
        cur += (cur ? ' ' : '') + word;
      }
    } else cur += s;
  }
  push();
  return out;
}
