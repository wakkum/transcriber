// The content security policy for the built app: only its own files, and Hugging Face for the one-time
// model download. Shared by the page (vite.config.ts adds it to index.html) and the desktop app
// (main.cjs sends it as a header, which also covers the workers).
module.exports = [
  "default-src 'self'",
  "script-src 'self' blob: 'wasm-unsafe-eval'", // blob: is how the speech engine loads its own module
  "style-src 'self' 'unsafe-inline'", // React sets style attributes
  "img-src 'self' data: blob:",
  "media-src 'self' blob:", // the player
  "font-src 'self'",
  "connect-src 'self' blob: data: https://huggingface.co https://*.huggingface.co https://*.hf.co",
  "worker-src 'self' blob:",
  "frame-src 'self' about: blob:", // the print frame
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
