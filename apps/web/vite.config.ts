import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { libraryServer } from './server/library/plugin'

const config = defineConfig(({ mode }) => ({
  resolve: {
    tsconfigPaths: true,
    alias: [
      // onnxruntime-web's default build bundles its 25.6 MiB wasm as an asset,
      // over the Workers 25 MiB per-asset limit that `vite preview` (miniflare)
      // enforces at startup. The extern-wasm build leaves the wasm out, and
      // transformers.js then loads the matching version from jsDelivr.
      {
        find: /^onnxruntime-web\/webgpu$/,
        replacement: fileURLToPath(new URL('./node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs', import.meta.url)),
      },
    ],
  },
  // Served through the Cloudflare tunnel at videoeditor.rocstarrmedia.com. Vite
  // rejects any Host header it does not recognise, which is why the portal tile
  // got "Blocked request" while http://localhost:5173 worked fine.
  preview: {
    allowedHosts: ['videoeditor.rocstarrmedia.com'],
  },
  server: {
    allowedHosts: ['videoeditor.rocstarrmedia.com'],
  },
  // The Whisper captions worker imports ESM-only transformers.js / onnxruntime-web.
  worker: {
    format: 'es' as const,
  },
  plugins: [
    // Audio library (YouTube → audio) on /library/*. Before the Cloudflare
    // plugin, because it needs the real Node runtime, not the Workers emulator.
    libraryServer(),
    devtools(),
    mode === 'test' ? null : cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
}))

export default config
