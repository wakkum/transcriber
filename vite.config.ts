import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import csp from './electron/csp.cjs'

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
})
