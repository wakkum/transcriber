// Any audio or video file to 16 kHz mono for Whisper. Mediabunny reads the container (MP4, MOV,
// WebM, MKV, MP3, WAV, Ogg, FLAC, ...) and decodes only the sound track with WebCodecs, a chunk at a
// time, so a long video is never loaded whole. Files it can't read go through the browser's own
// decoder instead, which needs the whole file in memory.
import { ALL_FORMATS, AudioSampleSink, BlobSource, EncodedPacketSink, Input } from 'mediabunny';
import { findHoles, MonoResampler } from '../engine/resample';

export const WHISPER_SAMPLE_RATE = 16_000;

export class NoSoundError extends Error {
  constructor() {
    super('This file has no sound track.');
  }
}

/** The fallback decoder holds the whole file and its decoded audio: refuse files likely to run out of memory. */
const FALLBACK_LIMIT = 1.5 * 1024 ** 3;

export async function decodeToMono(file: Blob, onProgress: (p: number) => void, signal: AbortSignal): Promise<Float32Array> {
  try {
    return await streamDecode(file, onProgress, signal);
  } catch (err) {
    if (err instanceof NoSoundError || signal.aborted) throw err;
    if (file.size > FALLBACK_LIMIT) throw new Error('This browser cannot decode the sound in this file. Try Chrome or Edge, or convert it to MP3 or M4A first.');
    return browserDecode(file);
  }
}

async function streamDecode(file: Blob, onProgress: (p: number) => void, signal: AbortSignal): Promise<Float32Array> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new NoSoundError();
    if (!(await track.canDecode())) throw new Error(`can't decode ${track.codec}`);
    const duration = await input.computeDuration();
    let resampler: MonoResampler | null = null;
    let planes: Float32Array[] = [];
    // Holes (a late start, dropped packets) show in the packets' times, not in the decoded audio's
    const holes = findHoles(await timings(new EncodedPacketSink(track)));
    let hole = 0;
    let heard = 0; // seconds of decoded audio so far
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
    }
    if (!resampler) throw new NoSoundError();
    return resampler.finish();
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
