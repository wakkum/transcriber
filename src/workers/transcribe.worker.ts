// Local Whisper transcription with word timestamps (Transformers.js), off the main thread.
// Only the stretches with sound are sent, in pieces of up to ~28 s (one Whisper window) cut in
// pauses (speech.ts speechPieces), so words and progress stream back every few seconds, long
// silences are skipped (Whisper invents words on silence), and no piece starts on a word.
import './ort';
import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { REVISIONS } from '../engine/models';
import { doubtful, inventedStretch } from '../engine/doubt';
import { silenceThreshold, soundShare, speechEnd, speechPieces } from '../engine/speech';

export type TranscribeRequest = {
  /** 16 kHz mono samples. */
  audio: Float32Array;
  model: string;
  /** e.g. 'english'. Omit for English-only (.en) models. */
  language?: string;
  device: 'webgpu' | 'wasm';
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
  | { type: 'words'; words: RawWord[]; progress: number; dropped?: { text: string; at: number } }
  | { type: 'done'; audio: Float32Array }
  | { type: 'error'; message: string; audio?: Float32Array };

const SR = 16_000;

const post = (m: TranscribeMessage) => self.postMessage(m, { transfer: 'audio' in m && m.audio ? [m.audio.buffer as ArrayBuffer] : [] });

let stopRequested = false;

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
let loadedKey = '';

function load(model: string, device: 'webgpu' | 'wasm') {
  const key = `${model}|${device}`;
  if (asr && key === loadedKey) return asr;
  loadedKey = key;
  asr = pipeline('automatic-speech-recognition', model, {
    device,
    revision: REVISIONS[model] ?? 'main',
    // WebGPU: full-precision encoder keeps timestamps stable; WASM: 8-bit for speed.
    dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
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
  const { audio, model, language, device } = e.data;
  stopRequested = false;
  try {
    const transcriber = await load(model, device);
    post({ type: 'ready', device });
    const duration = audio.length / SR;
    const silence = silenceThreshold(audio, SR);
    for (const [from, to] of speechPieces(audio, SR, silence)) {
      if (stopRequested) break;
      const [a, b] = [Math.round(from * SR), Math.round(to * SR)];
      const offset = from;
      const out = await transcriber(audio.subarray(a, b), {
        return_timestamps: 'word',
        chunk_length_s: 30,
        stride_length_s: 5,
        ...(language ? { language, task: 'transcribe' } : {}),
      });
      const chunks: Chunk[] = (Array.isArray(out) ? out[0] : out).chunks ?? [];
      const words: RawWord[] = chunks
        // Whisper emits stray punctuation-only "words" on silence (seen: a lone "." in 30 s of room noise)
        .filter((c) => /[\p{L}\p{N}]/u.test(c.text))
        .map((c) => {
          const start = offset + c.timestamp[0];
          // the last word of a piece can come back without an end time
          const end = c.timestamp[1] == null ? Math.min(start + 0.4, to) : offset + c.timestamp[1];
          // Whisper stretches a word's end over the pause after it: trim to where the sound stops
          return { text: c.text.trim(), start, end: speechEnd(audio, SR, start, Math.max(end, start + 0.02), silence) };
        });
      const sound = words.map((w) => soundShare(audio, SR, w.start, w.end, silence));
      if (inventedStretch(words, sound, to - from)) {
        post({ type: 'words', words: [], progress: to / duration, dropped: { text: words.map((w) => w.text).join(' '), at: words[0].start } });
        continue;
      }
      const flags = doubtful(words, sound);
      post({ type: 'words', words: words.map((w, i) => (flags[i] ? { ...w, doubt: true } : w)), progress: to / duration });
    }
    post({ type: 'done', audio });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err), audio });
  }
};
