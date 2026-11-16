// Who spoke when, off the main thread (see engine/diarize.ts for the method). Two small models from
// Hugging Face, downloaded once: pyannote segmentation (6 MB) and a WeSpeaker voice embedding (26 MB).
// Both run on the WASM engine: the segmentation model does not support WebGPU.
import './ort';
import { AutoModel, AutoModelForAudioFrameClassification, AutoProcessor } from '@huggingface/transformers';
import { cluster } from '../engine/cluster';
import { EMBEDDING_MODEL, REVISIONS, SEGMENTATION_MODEL } from '../engine/models';
import { CLUSTER_THRESHOLD, embeddingFrames, firstToTalkIsZero, frameMasks, MIN_SPEAKER_SECONDS, planWindows, speakerRuns, type Span, type SpeakerSegment } from '../engine/diarize';

export type DiarizeRequest = {
  /** 16 kHz mono samples. */
  audio: Float32Array;
  /** Where the words are, in seconds. */
  words: Span[];
  /** How many people are talking, if the user said; otherwise found automatically. */
  speakers?: number;
};

/** Ask the worker to stop after the window it is on and hand the audio back. */
export type DiarizeControl = { type: 'stop' };

/** As in transcribe.worker.ts, the audio goes back with every final message. */
export type DiarizeMessage =
  | { type: 'download'; progress: number }
  | { type: 'progress'; progress: number }
  | { type: 'result'; segments: SpeakerSegment[]; speakers: number; audio: Float32Array }
  | { type: 'stopped'; audio: Float32Array }
  | { type: 'error'; message: string; audio?: Float32Array };

const SR = 16_000;
const MAX_EMBED_SECONDS = 12;

const post = (m: DiarizeMessage) => self.postMessage(m, { transfer: 'audio' in m && m.audio ? [m.audio.buffer as ArrayBuffer] : [] });

let stopRequested = false;

type Progress = { status: string; progress?: number };
const downloading = (part: number) => (p: Progress) => {
  if (p.status === 'progress_total') post({ type: 'download', progress: (part + (p.progress ?? 0) / 100) / 2 });
};

self.onmessage = async (e: MessageEvent<DiarizeRequest | DiarizeControl>) => {
  if ('type' in e.data) {
    stopRequested = true;
    return;
  }
  const { audio, words, speakers } = e.data;
  stopRequested = false;
  try {
    const opts = (part: number, id: string) => ({ device: 'wasm' as const, dtype: 'fp32' as const, revision: REVISIONS[id], progress_callback: downloading(part) });
    const rev = (id: string) => ({ revision: REVISIONS[id] });
    const [segModel, segProc] = await Promise.all([AutoModelForAudioFrameClassification.from_pretrained(SEGMENTATION_MODEL, opts(0, SEGMENTATION_MODEL)), AutoProcessor.from_pretrained(SEGMENTATION_MODEL, rev(SEGMENTATION_MODEL))]);
    const [embModel, embProc] = await Promise.all([AutoModel.from_pretrained(EMBEDDING_MODEL, opts(1, EMBEDDING_MODEL)), AutoProcessor.from_pretrained(EMBEDDING_MODEL, rev(EMBEDDING_MODEL))]);

    const windows = planWindows(words, audio.length / SR);
    const vectors: number[][] = [];
    const weights: number[] = [];
    const owner: { window: number; local: number }[] = [];
    const runs: Span[][][] = []; // per window, per local speaker

    for (let w = 0; w < windows.length; w++) {
      if (stopRequested) return post({ type: 'stopped', audio });
      const [a, b] = [Math.floor(windows[w].start * SR), Math.min(audio.length, Math.ceil(windows[w].end * SR))];
      try {
        // the segmentation model fails on empty or very short input (a word timed at the very end of the
        // file): pad to 1 s of silence
        const real = audio.subarray(a, b);
        const chunk = real.length >= SR ? real : Float32Array.from({ length: SR }, (_, i) => real[i] ?? 0);
        const { logits } = await segModel(await segProc(chunk));
        const masks = frameMasks((logits.tolist() as number[][][])[0]);
        const frameSeconds = chunk.length / SR / masks.length;
        runs.push([0, 1, 2].map((s) => speakerRuns(masks, s, frameSeconds, windows[w].start)));

        for (let s = 0; s < 3; s++) {
          const frames = embeddingFrames(masks, s, frameSeconds);
          if (!frames) continue;
          const per = chunk.length / masks.length;
          const parts = frames.map((f) => chunk.subarray(Math.floor(f * per), Math.floor((f + 1) * per)));
          const own = new Float32Array(Math.min(MAX_EMBED_SECONDS * SR, parts.reduce((n, p) => n + p.length, 0)));
          let at = 0;
          for (const p of parts) {
            if (at >= own.length) break;
            own.set(p.subarray(0, own.length - at), at);
            at += p.length;
          }
          const out = (await embModel(await embProc(own))) as Record<string, { data: Float32Array }>;
          const t = out.embeddings ?? out.last_hidden_state ?? Object.values(out)[0];
          vectors.push(Array.from(t.data));
          weights.push(own.length / SR);
          owner.push({ window: w, local: s });
        }
      } catch {
        // one bad stretch must not lose the speakers for the whole recording: leave it unlabelled
        runs[w] ??= [[], [], []];
      }
      post({ type: 'progress', progress: (w + 1) / windows.length });
    }

    const labels = cluster(vectors, { count: speakers, threshold: CLUSTER_THRESHOLD, minWeight: MIN_SPEAKER_SECONDS, weights });
    const segments: SpeakerSegment[] = [];
    owner.forEach(({ window, local }, i) => {
      for (const r of runs[window][local]) segments.push({ ...r, speaker: labels[i] });
    });
    segments.sort((x, y) => x.start - y.start);
    firstToTalkIsZero(segments);
    post({ type: 'result', segments, speakers: labels.length ? Math.max(...labels) + 1 : 1, audio });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err), audio });
  }
};
