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
  ['bengali', 'Bengali'],
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
  // Bengali: a small model trained on Bengali (Apache-2.0, community)
  'shamim1122/whisper-small-bangla-onnx': 'b8430ee6d3da6fc074d77c5396969bc412a17f10',
  // Bengali.AI's competition-winning medium model, trained further on regional speech by OmiKhan (Apache-2.0), as ONNX by subtitleking
  'subtitleking/omikhan-bangla-whisper-medium-onnx': '5336931fdf158913747d8354fa3cfac1fd6d8e5e',
  // Translation: M2M100 (MIT) and NLLB-200 distilled (CC-BY-NC-4.0: non-commercial use only)
  'Xenova/m2m100_418M': '9c374f0b7aca709787cea97b047bfbbd1559d177',
  'Xenova/nllb-200-distilled-600M': '261c31d1a5732c67cdd16d80e8d6088507c7ccea',
  'onnx-community/pyannote-segmentation-3.0': '733a93b6473d019a773298e08cefa686894b1854',
  'onnx-community/wespeaker-voxceleb-resnet34-LM': '6a61a1833ff2583aabeba044f5c8221f00b67ceb',
};

export const SEGMENTATION_MODEL = 'onnx-community/pyannote-segmentation-3.0';
export const EMBEDDING_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';

const SIZES = { tiny: '~40 MB', base: '~80 MB', small: '~250 MB' };
const BY_QUALITY = { fast: 'tiny', balanced: 'base', accurate: 'small' } as const;

export type SpeechModel = {
  id: string;
  size: string;
  /** The language to pass (none for .en models). */
  language?: string;
  /** What makes this choice different, for the menu. */
  note?: string;
  /** Which compressed files to load, when the model's own default would be too big or unsupported. */
  dtype?: Record<string, string>;
  /** The model has no per-word timings: words get their sentence's time (see segments.ts). */
  segmentTimes?: boolean;
  /** Longest piece of audio to send at once (seconds), when 28 is too long for the language (see SPECIAL). */
  pieceSeconds?: number;
};

/**
 * Languages whose three choices are not the usual tiny, base and small. Stock Whisper below large writes
 * Bengali in the wrong script or not at all, and large-v3 is too big for the app's engines, so Bengali uses
 * models trained on Bengali. Bengali also takes about 20 tokens a second against Whisper's 448 per window,
 * so it is sent in pieces of 10 seconds (28 would not fit and the model loses its place and loops).
 */
const DIALECT: Omit<SpeechModel, 'language'> = { id: 'subtitleking/omikhan-bangla-whisper-medium-onnx', size: '~1.1 GB', note: 'medium trained on Bengali dialects', segmentTimes: true, pieceSeconds: 10, dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' } };
const SPECIAL: Record<string, Record<Quality, Omit<SpeechModel, 'language'>>> = {
  bengali: {
    fast: { id: 'shamim1122/whisper-small-bangla-onnx', size: '~290 MB', note: 'Bengali-trained small, can skip words', segmentTimes: true, pieceSeconds: 10, dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } },
    balanced: DIALECT,
    // nothing better runs in the app (large-v3 runs out of memory; large-v3-turbo was slower and worse)
    accurate: { ...DIALECT, note: 'same as Balanced, the best Bengali model available' },
  },
};

/** The model for a language and quality, its download size, and the language to pass (none for .en models). */
export function modelFor(language: string, quality: Quality): SpeechModel {
  if (!LANGUAGES.some((l) => l.id === language)) language = 'english'; // a stale or edited setting
  const special = SPECIAL[language]?.[quality];
  if (special) return { ...special, language };
  const size = BY_QUALITY[quality];
  if (language === 'english') return { id: `Xenova/whisper-${size}.en`, size: SIZES[size] };
  return { id: `Xenova/whisper-${size}`, size: SIZES[size], language };
}

/** The speech model that ships inside the desktop app (with the speaker models): see scripts/fetch-models.mjs. */
export const BUNDLED_SPEECH_MODEL = 'Xenova/whisper-base.en';
