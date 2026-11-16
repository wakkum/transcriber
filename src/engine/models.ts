// Which Whisper model to download for a language and a speed/accuracy choice. English has its own
// smaller, more accurate models (.en); every other language uses the multilingual ones.

export type Quality = 'fast' | 'balanced' | 'accurate';

export const QUALITIES: { id: Quality; label: string }[] = [
  { id: 'fast', label: 'Fastest' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'accurate', label: 'Most accurate' },
];

/** Whisper's language names (what the model expects), with a label. English first, then A to Z. */
export const LANGUAGES: { id: string; label: string }[] = [
  ['english', 'English'],
  ['arabic', 'Arabic'],
  ['chinese', 'Chinese'],
  ['dutch', 'Dutch'],
  ['french', 'French'],
  ['german', 'German'],
  ['greek', 'Greek'],
  ['hebrew', 'Hebrew'],
  ['hindi', 'Hindi'],
  ['indonesian', 'Indonesian'],
  ['italian', 'Italian'],
  ['japanese', 'Japanese'],
  ['korean', 'Korean'],
  ['malay', 'Malay'],
  ['persian', 'Persian'],
  ['polish', 'Polish'],
  ['portuguese', 'Portuguese'],
  ['russian', 'Russian'],
  ['spanish', 'Spanish'],
  ['swahili', 'Swahili'],
  ['swedish', 'Swedish'],
  ['tagalog', 'Tagalog'],
  ['turkish', 'Turkish'],
  ['ukrainian', 'Ukrainian'],
  ['urdu', 'Urdu'],
].map(([id, label]) => ({ id, label }));

/**
 * Exact versions (Hugging Face commits) of every model: the files are fetched by these, not from
 * a branch that can change, so the same app always gets the same models. To update one, look up
 * its new commit on the model page and re-check the results.
 */
export const REVISIONS: Record<string, string> = {
  'Xenova/whisper-tiny.en': '79fb389fc764e7c395bd330e9531d9d32ada7049',
  'Xenova/whisper-base.en': '95bf40a508535962c6483ead40270b2e32267508',
  'Xenova/whisper-small.en': 'fa16a75f5d91e83ecb6a2ccb690f14d91ef00ca4',
  'Xenova/whisper-tiny': '5332fcc35e32a33b86612b9a57a89be7906102b1',
  'Xenova/whisper-base': '64da57285918e20ea79ea5c88eed7197933abaa8',
  'Xenova/whisper-small': '2d67713f236afa48a18992566e7647f6ca848e13',
  'onnx-community/pyannote-segmentation-3.0': '733a93b6473d019a773298e08cefa686894b1854',
  'onnx-community/wespeaker-voxceleb-resnet34-LM': '6a61a1833ff2583aabeba044f5c8221f00b67ceb',
};

export const SEGMENTATION_MODEL = 'onnx-community/pyannote-segmentation-3.0';
export const EMBEDDING_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';

const SIZES = { tiny: '~40 MB', base: '~80 MB', small: '~250 MB' };
const BY_QUALITY = { fast: 'tiny', balanced: 'base', accurate: 'small' } as const;

/** The model for a language and quality, its download size, and the language to pass (none for .en models). */
export function modelFor(language: string, quality: Quality): { id: string; size: string; language?: string } {
  if (!LANGUAGES.some((l) => l.id === language)) language = 'english'; // a stale or edited setting
  const size = BY_QUALITY[quality];
  if (language === 'english') return { id: `Xenova/whisper-${size}.en`, size: SIZES[size] };
  return { id: `Xenova/whisper-${size}`, size: SIZES[size], language };
}

/** The speech model that ships inside the desktop app (with the speaker models): see scripts/fetch-models.mjs. */
export const BUNDLED_SPEECH_MODEL = 'Xenova/whisper-base.en';
