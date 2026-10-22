import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'
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

/**
 * `/.well-known/assetlinks.json`: the website vouches for the Android app
 * (`android/`), so Chrome shows it full screen instead of with an address
 * bar. Written only when `ANDROID_CERT_SHA256` names the signing key's
 * fingerprint(s) — the Android workflow prints it —, comma-separated.
 */
function assetLinks(fingerprints: string): Plugin {
  const list = fingerprints
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(entry))
  return {
    name: 'sondra:asset-links',
    apply: 'build',
    generateBundle() {
      if (list.length === 0) return
      this.emitFile({
        type: 'asset',
        fileName: '.well-known/assetlinks.json',
        source: JSON.stringify(
          [
            {
              relation: ['delegate_permission/common.handle_all_urls'],
              target: { namespace: 'android_app', package_name: 'ch.lizge.sondra', sha256_cert_fingerprints: list },
            },
          ],
          null,
          2,
        ),
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const clientId =
    env.VITE_GOOGLE_CLIENT_ID ||
    env.GOOGLE_CLIENT_ID ||
    env.VERCEL_GOOGLE_CLIENT_ID ||
    env.GOOGLE_DRIVE_CLIENT_ID ||
    process.env.VITE_GOOGLE_CLIENT_ID ||
    process.env.GOOGLE_CLIENT_ID ||
    process.env.VERCEL_GOOGLE_CLIENT_ID ||
    process.env.GOOGLE_DRIVE_CLIENT_ID ||
    ''
  const clientSecret =
    env.VITE_GOOGLE_CLIENT_SECRET ||
    env.GOOGLE_CLIENT_SECRET ||
    env.VERCEL_GOOGLE_CLIENT_SECRET ||
    env.GOOGLE_DRIVE_CLIENT_SECRET ||
    process.env.VITE_GOOGLE_CLIENT_SECRET ||
    process.env.GOOGLE_CLIENT_SECRET ||
    process.env.VERCEL_GOOGLE_CLIENT_SECRET ||
    process.env.GOOGLE_DRIVE_CLIENT_SECRET ||
    ''

  return {
    // Relative base so the static build runs from any path, including
    // project sub-paths such as https://user.github.io/sondra/.
    base: './',
    envPrefix: ['VITE_', 'GOOGLE_', 'VERCEL_'],
    define: {
      'import.meta.env.VITE_GOOGLE_CLIENT_ID': JSON.stringify(clientId),
      'import.meta.env.GOOGLE_CLIENT_ID': JSON.stringify(clientId),
      'import.meta.env.VITE_GOOGLE_CLIENT_SECRET': JSON.stringify(clientSecret),
      'import.meta.env.GOOGLE_CLIENT_SECRET': JSON.stringify(clientSecret),
    },
    plugins: [
      react(),
      tailwindcss(),
      crossOriginIsolation(),
      offlineList(),
      assetLinks(env.ANDROID_CERT_SHA256 || process.env.ANDROID_CERT_SHA256 || ''),
    ],
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
  }
})
