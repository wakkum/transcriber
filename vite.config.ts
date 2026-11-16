import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import csp from './electron/csp.cjs'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  plugins: [
    react(),
    {
      // the policy goes into the built page only: the dev server's hot reloading needs inline scripts
      name: 'content-security-policy',
      apply: 'build',
      transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' }],
    },
  ],
  // relative asset paths, so the same build works at a site root, under github.io/<repo>/, or from start.command
  base: './',
  // the app's own version, for the new-version notice (APP_VERSION overrides it, to test the notice)
  define: { __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? pkg.version) },
})
