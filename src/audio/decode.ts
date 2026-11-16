// Any audio or video file to 16 kHz mono for Whisper. Mediabunny reads the container (MP4, MOV,
// WebM, MKV, MP3, WAV, Ogg, FLAC, ...) and decodes only the sound track with WebCodecs, a chunk at a
// time, so a long video is never loaded whole. The sound comes out in pieces of about half an hour,
// cut at the quietest moment near the end, so an hour or two of audio is never in memory at once.
// Files it can't read go through the browser's own decoder instead, which needs the whole file.
import { ALL_FORMATS, AudioSampleSink, BlobSource, EncodedPacketSink, Input } from 'mediabunny';
import { findHoles, MonoResampler } from '../engine/resample';
import { quietestPoint } from '../engine/speech';

export const WHISPER_SAMPLE_RATE = 16_000;
/** Roughly how long one piece is. */
export const PIECE_SECONDS = 30 * 60;

export class NoSoundError extends Error {
  constructor() {
    super('This file has no sound track.');
  }
}

/** One stretch of the recording. */
export type AudioPiece = {
  /** Where it starts in the recording, in seconds. */
  start: number;
  audio: Float32Array;
  /** 0 for the first. */
  index: number;
  /** The length of the whole recording in seconds, 0 when the file does not say. */
  total: number;
  last: boolean;
};

/** The fallback decoder holds the whole file and its decoded audio: refuse files likely to run out of memory. */
const FALLBACK_LIMIT = 1.5 * 1024 ** 3;

/**
 * The recording in pieces, one at a time as the caller asks for the next: a piece is only decoded
 * when wanted. `onProgress` gets how much of the file has been decoded (0 to 1).
 */
export async function* decodePieces(file: Blob, onProgress: (p: number) => void, signal: AbortSignal, pieceSeconds = PIECE_SECONDS): AsyncGenerator<AudioPiece> {
  let sawSound = false;
  try {
    for await (const piece of streamDecode(file, onProgress, signal, pieceSeconds)) {
      sawSound = true;
      yield piece;
    }
    return;
  } catch (err) {
    // pieces already handed out cannot be taken back: only a file that failed before any can use the fallback
    if (sawSound || err instanceof NoSoundError || signal.aborted) throw err;
    if (file.size > FALLBACK_LIMIT) throw new Error('This browser cannot decode the sound in this file. Try Chrome or Edge, or convert it to MP3 or M4A first.');
  }
  yield* cutUp(await browserDecode(file), pieceSeconds);
}

/** One long recording already in memory, cut into pieces at quiet moments. */
function* cutUp(all: Float32Array, pieceSeconds: number): Generator<AudioPiece> {
  const total = all.length / WHISPER_SAMPLE_RATE;
  const target = Math.round(pieceSeconds * WHISPER_SAMPLE_RATE);
  const margin = Math.round(Math.min(20, pieceSeconds / 3) * WHISPER_SAMPLE_RATE);
  const minTail = Math.min(600, pieceSeconds / 3);
  let at = 0;
  let index = 0;
  while (at < all.length) {
    let end = all.length;
    if (end - at > target && (all.length - at - target) / WHISPER_SAMPLE_RATE > minTail) {
      end = at + target - margin + quietestPoint(all.subarray(at + target - margin, at + target), WHISPER_SAMPLE_RATE);
    }
    yield { start: at / WHISPER_SAMPLE_RATE, audio: all.slice(at, end), index: index++, total, last: end >= all.length };
    at = end;
  }
}

async function* streamDecode(file: Blob, onProgress: (p: number) => void, signal: AbortSignal, pieceSeconds: number): AsyncGenerator<AudioPiece> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new NoSoundError();
    if (!(await track.canDecode())) throw new Error(`can't decode ${track.codec}`);
    const duration = await input.computeDuration();
    const target = Math.round(pieceSeconds * WHISPER_SAMPLE_RATE);
    const margin = Math.round(Math.min(20, pieceSeconds / 3) * WHISPER_SAMPLE_RATE);
    const minTail = Math.min(600, pieceSeconds / 3);
    let resampler: MonoResampler | null = null;
    let planes: Float32Array[] = [];
    // Holes (a late start, dropped packets) show in the packets' times, not in the decoded audio's
    const holes = findHoles(await timings(new EncodedPacketSink(track)));
    let hole = 0;
    let heard = 0; // seconds of decoded audio so far
    let given = 0; // samples already handed out in pieces
    let index = 0;
    for await (const sample of new AudioSampleSink(track).samples()) {
      try {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (!resampler) {
          resampler = new MonoResampler(sample.sampleRate, WHISPER_SAMPLE_RATE);
        }
        // put the silence back where the track had a hole, to keep the times in step with the video
        while (hole < holes.length && heard >= holes[hole].at - 1e-6) resampler.pushSilence(holes[hole++].gap);
        const n = sample.numberOfFrames;
        if (planes.length !== sample.numberOfChannels || planes[0].length < n)
          planes = Array.from({ length: sample.numberOfChannels }, () => new Float32Array(n));
        const views = planes.map((p, c) => {
          const view = p.subarray(0, n);
          sample.copyTo(view, { planeIndex: c, format: 'f32-planar' });
          return view;
        });
        resampler.push(views);
        heard += n / sample.sampleRate;
        if (duration > 0) onProgress(Math.min(1, (sample.timestamp + sample.duration) / duration));
      } finally {
        sample.close();
      }
      // a piece is full: cut it at the quietest moment of its last stretch, unless little is left to come
      const left = duration > 0 ? duration - (given + resampler.size) / WHISPER_SAMPLE_RATE : Infinity;
      if (resampler.size >= target && left > minTail) {
        const cut = resampler.size - margin + quietestPoint(resampler.tail(margin), WHISPER_SAMPLE_RATE);
        const audio = resampler.take(cut);
        // the consumer sends the audio to a worker, which empties it here: count it first
        const start = given;
        given += audio.length;
        yield { start: start / WHISPER_SAMPLE_RATE, audio, index: index++, total: duration, last: false };
      }
    }
    if (!resampler) throw new NoSoundError();
    const audio = resampler.finish();
    yield { start: given / WHISPER_SAMPLE_RATE, audio, index, total: duration, last: true };
  } finally {
    input.dispose();
  }
}

/** Every packet's time and length (reading the container only, nothing is decoded). */
async function timings(sink: EncodedPacketSink) {
  const out: { timestamp: number; duration: number }[] = [];
  for await (const p of sink.packets()) out.push({ timestamp: p.timestamp, duration: p.duration });
  return out;
}

/** The browser's decoder, straight to 16 kHz (it resamples to the context's rate). */
async function browserDecode(file: Blob): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, WHISPER_SAMPLE_RATE);
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error('The sound in this file could not be read. Try converting it to MP3, M4A or WAV first.');
  }
  const r = new MonoResampler(buffer.sampleRate, WHISPER_SAMPLE_RATE);
  r.push(Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)));
  return r.finish();
}
