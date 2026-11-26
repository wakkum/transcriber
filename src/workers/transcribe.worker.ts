// Local Whisper transcription with word timestamps (Transformers.js), off the main thread.
// Only the stretches with sound are sent, in pieces of up to ~28 s (one Whisper window) cut in
// pauses (speech.ts speechPieces), so words and progress stream back every few seconds, long
// silences are skipped (Whisper invents words on silence), and no piece starts on a word.
import './ort';
import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { REVISIONS } from '../engine/models';
import { doubtful, inventedStretch, looping } from '../engine/doubt';
import { wordsFromSegments } from '../engine/segments';
import { quietestPoint, silenceThreshold, soundShare, speechEnd, speechPieces } from '../engine/speech';

export type TranscribeRequest = {
  /** 16 kHz mono samples. */
  audio: Float32Array;
  model: string;
  /** e.g. 'english'. Omit for English-only (.en) models. */
  language?: string;
  device: 'webgpu' | 'wasm';
  /** Which compressed files to load, for models that need a particular choice (the large one). */
  dtype?: Record<string, string>;
  /** The model gives times per sentence, not per word. */
  segmentTimes?: boolean;
  /** Longest piece to send at once (seconds): shorter for languages that take many tokens per second. */
  pieceSeconds?: number;
};

type Chunk = { text: string; timestamp: [number, number | null] };

export type RawWord = { text: string; start: number; end: number; doubt?: boolean };

/** Ask the worker to finish the piece it is on and hand the audio back. */
export type TranscribeControl = { type: 'stop' };

/**
 * The audio travels to the worker and comes back with `done` (or `error`), so the page never holds a
 * second copy of an hour of samples (230 MB). Word ends are trimmed here, where the audio is.
 */
export type TranscribeMessage =
  | { type: 'download'; progress: number; loaded: number; total: number }
  | { type: 'ready'; device: string }
  /** `dropped`: the text of a stretch left out because it looked invented over non-speech sound. */
  | { type: 'words'; words: RawWord[]; progress: number; dropped?: { text: string; at: number; words: RawWord[] } }
  | { type: 'done'; audio: Float32Array }
  | { type: 'error'; message: string; audio?: Float32Array };

const SR = 16_000;

const post = (m: TranscribeMessage) => self.postMessage(m, { transfer: 'audio' in m && m.audio ? [m.audio.buffer as ArrayBuffer] : [] });

let stopRequested = false;

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
let loadedKey = '';

function load(model: string, device: 'webgpu' | 'wasm', dtype?: Record<string, string>) {
  const key = `${model}|${device}|${JSON.stringify(dtype ?? null)}`;
  if (asr && key === loadedKey) return asr;
  loadedKey = key;
  asr = pipeline('automatic-speech-recognition', model, {
    device,
    revision: REVISIONS[model] ?? 'main',
    // WebGPU: full-precision encoder keeps timestamps stable; WASM: 8-bit for speed.
    dtype: (dtype ?? (device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8')) as never,
    progress_callback: (p: { status: string; progress?: number; loaded?: number; total?: number }) => {
      if (p.status === 'progress_total') {
        post({ type: 'download', progress: (p.progress ?? 0) / 100, loaded: p.loaded ?? 0, total: p.total ?? 0 });
      }
    },
  }) as Promise<AutomaticSpeechRecognitionPipeline>;
  return asr;
}

self.onmessage = async (e: MessageEvent<TranscribeRequest | TranscribeControl>) => {
  if ('type' in e.data) {
    stopRequested = true; // seen between pieces: messages are only handled while a piece is awaited
    return;
  }
  const { audio, model, language, device, dtype, segmentTimes, pieceSeconds } = e.data;
  stopRequested = false;
  try {
    const transcriber = await load(model, device, dtype);
    post({ type: 'ready', device });
    const duration = audio.length / SR;
    const silence = silenceThreshold(audio, SR);

    /** Whisper's words in from..to (seconds), with times in the recording. */
    const run = async (from: number, to: number) => {
      const out = await transcriber(audio.subarray(Math.round(from * SR), Math.round(to * SR)), {
        return_timestamps: segmentTimes ? true : 'word',
        chunk_length_s: 30,
        stride_length_s: 5,
        // Room for fast speech in a script that takes many tokens (Bengali: about 20 a second), but a
        // loop over a short sound stops early instead of filling Whisper's whole 448 tokens.
        max_new_tokens: Math.min(440, Math.ceil((to - from) * 40) + 24),
        ...(language ? { language, task: 'transcribe' } : {}),
      } as never);
      const raw: Chunk[] = (Array.isArray(out) ? out[0] : out).chunks ?? [];
      // a model without per-word times: each sentence's words share its time
      const chunks: Chunk[] = segmentTimes
        ? wordsFromSegments(raw.map((c) => ({ text: c.text, start: c.timestamp[0], end: c.timestamp[1] ?? to - from }))).map((w) => ({ text: w.text, timestamp: [w.start, w.end] as [number, number] }))
        : raw;
      return (
        chunks
          // Whisper emits stray punctuation-only "words" on silence (seen: a lone "." in 30 s of room noise)
          .filter((c) => /[\p{L}\p{N}]/u.test(c.text))
          .map((c) => {
            const start = from + c.timestamp[0];
            // the last word of a piece can come back without an end time
            const end = c.timestamp[1] == null ? Math.min(start + 0.4, to) : from + c.timestamp[1];
            // Whisper stretches a word's end over the pause after it: trim to where the sound stops
            return { text: c.text.trim(), start, end: speechEnd(audio, SR, start, Math.max(end, start + 0.02), silence) };
          })
      );
    };

    /** Transcribe from..to and send the words. A piece Whisper loops on is redone in two halves cut at a quiet moment; a short one is left out. */
    const piece = async (from: number, to: number, depth = 0): Promise<void> => {
      const words = await run(from, to);
      const text = words.map((w) => w.text).join(' ');
      if (looping(text) && to - from >= 4 && depth < 2) {
        const third = (to - from) / 3;
        const a = Math.round((from + third) * SR);
        const mid = (a + quietestPoint(audio.subarray(a, Math.round((to - third) * SR)), SR, 0.15)) / SR;
        await piece(from, mid, depth + 1);
        if (!stopRequested) await piece(mid, to, depth + 1);
        return;
      }
      const sound = words.map((w) => soundShare(audio, SR, w.start, w.end, silence));
      if (looping(text) || inventedStretch(words, sound, to - from)) {
        if (words.length) post({ type: 'words', words: [], progress: to / duration, dropped: { text, at: words[0].start, words } });
        return;
      }
      const flags = doubtful(words, sound, { timing: !segmentTimes });
      post({ type: 'words', words: words.map((w, i) => (flags[i] ? { ...w, doubt: true } : w)), progress: to / duration });
    };

    for (const [from, to] of speechPieces(audio, SR, silence, pieceSeconds ? { maxLen: pieceSeconds } : {})) {
      if (stopRequested) break;
      await piece(from, to);
    }
    post({ type: 'done', audio });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err), audio });
  }
};
