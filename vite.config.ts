import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * SharedArrayBuffer — required by the multi-threaded FFmpeg core and by the
 * threaded WASM backend of onnxruntime-web — is only exposed to documents that
 * are *cross-origin isolated*. That requires two response headers.
 *
 * `credentialless` is used instead of `require-corp` so that the Downloader can
 * still pull in cross-origin media that does not send a CORP header. Browsers
 * without `credentialless` support simply stay non-isolated, and the app falls
 * back to the single-threaded cores at runtime (see src/lib/capabilities.ts).
 */
const CROSS_ORIGIN_ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

function crossOriginIsolation(): Plugin {
  return {
    name: 'sondra:cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        Object.entries(CROSS_ORIGIN_ISOLATION).forEach(([k, v]) => res.setHeader(k, v))
        next()
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        Object.entries(CROSS_ORIGIN_ISOLATION).forEach(([k, v]) => res.setHeader(k, v))
        next()
      })
    },
  }
}

/**
 * `offline.json`: every file this build put under assets/. The service worker
 * reads it to keep the whole app — every tool, not only the ones opened on the
 * first visit — and to drop what earlier builds left in its cache. The
 * WebAssembly cores are listed apart: they are cached when a device first
 * uses one, not all three up front.
 */
function offlineList(): Plugin {
  return {
    name: 'sondra:offline-list',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((name) => name.startsWith('assets/') && !name.endsWith('.map'))
      this.emitFile({
        type: 'asset',
        fileName: 'offline.json',
        source: JSON.stringify({
          keep: files.filter((name) => !name.endsWith('.wasm')),
          onDemand: files.filter((name) => name.endsWith('.wasm')),
        }),
      })
    },
  }
}

export default defineConfig({
  // Relative base so the static build runs from any path, including
  // project sub-paths such as https://user.github.io/sondra/.
  base: './',
  plugins: [react(), tailwindcss(), crossOriginIsolation(), offlineList()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  worker: { format: 'es' },
  optimizeDeps: {
    // These ship their own workers and .wasm payloads; pre-bundling rewrites
    // the URLs they resolve at runtime and breaks them.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', 'onnxruntime-web'],
  },
  build: {
    target: 'es2022',
    // Never inline an asset as a data: URI. The multi-threaded FFmpeg core
    // spawns its pthread worker from `ffmpeg-core.worker.js`, which is small
    // enough to fall under the default inline limit — and a worker created
    // from a data: URL gets an opaque origin, so its import of the core is
    // blocked and the whole load fails.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          audio: ['wavesurfer.js', 'tone'],
        },
      },
    },
  },
})
