// Downloads the models that ship inside the app, by exact commit, into models/ (not kept in git).
// Run by `npm run models`, and before every build. Files already present with the right size are kept.
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'models');
const COMMON = ['config.json', 'preprocessor_config.json'];
const MODELS = {
  'Xenova/whisper-base.en': ['95bf40a508535962c6483ead40270b2e32267508', [...COMMON, 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']],
  'onnx-community/pyannote-segmentation-3.0': ['733a93b6473d019a773298e08cefa686894b1854', [...COMMON, 'onnx/model.onnx']],
  'onnx-community/wespeaker-voxceleb-resnet34-LM': ['6a61a1833ff2583aabeba044f5c8221f00b67ceb', [...COMMON, 'onnx/model.onnx']],
};

async function retry(fn, what = '') {
  for (let i = 1; ; i++) {
    try {
      const r = await fn();
      if (r instanceof Response && !r.ok) throw new Error(`status ${r.status}`);
      return r;
    } catch (e) {
      if (i === 4) throw new Error(`${what} ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

for (const [id, [rev, files]] of Object.entries(MODELS)) {
  for (const file of files) {
    const url = `https://huggingface.co/${id}/resolve/${rev}/${file}`;
    const to = join(root, id, file);
    const have = await stat(to).then((s) => s.size, () => 0);
    const big = file.endsWith('.onnx'); // large files carry their true size in a header, small ones just are kept
    if (have > 0 && !big) continue;
    const head = await retry(() => fetch(url, { method: 'HEAD' }));
    const size = Number(head.headers.get('x-linked-size') ?? 0);
    if (have > 0 && have === size) continue;
    const bytes = await retry(async () => {
      const res = await fetch(url);
      const b = Buffer.from(await res.arrayBuffer());
      if (size && b.length !== size) throw new Error(`got ${b.length} bytes, expected ${size}`);
      return b;
    }, url);
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, bytes);
    console.log(`${id}/${file} (${(bytes.length / 1e6).toFixed(1)} MB)`);
  }
}
