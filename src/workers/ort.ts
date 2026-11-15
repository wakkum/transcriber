// The speech engine (ONNX Runtime) ships inside the app: by default Transformers.js fetches it from
// a CDN, which would break offline use and send a request to a third party. Import this first.
import { env } from '@huggingface/transformers';
import { REVISIONS } from '../engine/models';

env.backends.onnx.wasm!.wasmPaths = {
  mjs: new URL('../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href,
  wasm: new URL('../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href,
};

// Transformers.js reads some files (a model's config.json) from the `main` branch even when a commit
// is requested. Point those at the pinned commit too, so no file comes from a branch that can change.
const plainFetch = env.fetch;
env.fetch = (input, init) => {
  const url = String(input);
  const m = /^(https:\/\/huggingface\.co\/(.+?)\/resolve\/)main(\/.*)$/.exec(url);
  const pinned = m && REVISIONS[m[2]];
  return plainFetch(pinned ? `${m[1]}${pinned}${m[3]}` : input, init);
};

// In the desktop app the base English speech model and the speaker models are inside the app, so the
// first run works offline. (Not in a browser: the dev server answers unknown paths with a page.)
if (self.location.protocol === 'app:') {
  env.allowLocalModels = true;
  env.localModelPath = '/models/';
}
