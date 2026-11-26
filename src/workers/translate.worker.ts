// Local translation (Transformers.js) of a transcript's paragraphs, off the main thread.
import './ort';
import { pipeline, type TranslationPipeline } from '@huggingface/transformers';
import { REVISIONS } from '../engine/models';
import { pieces } from '../engine/translate';

export type TranslateRequest = {
  model: string;
  /** The paragraphs to translate. */
  texts: string[];
  /** The model's codes for the spoken language and the wanted one. */
  from: string;
  to: string;
};

export type TranslateMessage =
  | { type: 'download'; progress: number }
  | { type: 'ready' }
  /** Paragraph `index` is done (`progress`: 0 to 1 overall). */
  | { type: 'item'; index: number; text: string; progress: number }
  | { type: 'done' }
  | { type: 'error'; message: string };

const post = (m: TranslateMessage) => self.postMessage(m);

self.onmessage = async (e: MessageEvent<TranslateRequest>) => {
  const { model, texts, from, to } = e.data;
  try {
    const files = new Map<string, { loaded: number; total: number }>();
    const translator = (await pipeline('translation', model, {
      device: 'wasm',
      dtype: 'q8',
      revision: REVISIONS[model] ?? 'main',
      progress_callback: (p: { status?: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status !== 'progress' || !p.file || !p.total) return;
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
        let loaded = 0;
        let total = 0;
        for (const f of files.values()) {
          loaded += f.loaded;
          total += f.total;
        }
        post({ type: 'download', progress: total ? loaded / total : 0 });
      },
    })) as TranslationPipeline;
    post({ type: 'ready' });
    const work = texts.map((t) => pieces(t));
    const all = work.reduce((n, w) => n + w.length, 0) || 1;
    let n = 0;
    for (let i = 0; i < texts.length; i++) {
      const out: string[] = [];
      for (const piece of work[i]) {
        const r = (await translator(piece, { src_lang: from, tgt_lang: to, max_new_tokens: 400 } as never)) as { translation_text: string }[];
        out.push(r[0]?.translation_text ?? '');
        n++;
      }
      post({ type: 'item', index: i, text: out.join(' ').trim(), progress: n / all });
    }
    post({ type: 'done' });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
