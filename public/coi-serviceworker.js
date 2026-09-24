/*
 * Service worker with two jobs.
 *
 * 1. Cross-origin isolation. On hosts that cannot set response headers (GitHub
 *    Pages, plain object storage), this re-emits every response with COOP and
 *    COEP attached, which flips `crossOriginIsolated` to true and unlocks
 *    SharedArrayBuffer — and with it the multi-threaded FFmpeg core.
 *
 * 2. Offline. An app whose whole claim is that it runs on your machine should
 *    not stop working when the network does. Same-origin responses are cached
 *    as they are fetched, and served from cache when the network is gone. The
 *    32 MB FFmpeg core is cached the first time it loads, so the second visit
 *    needs no network at all.
 *
 * Neither job inspects, stores or forwards request bodies, and nothing
 * cross-origin is ever cached — the extraction service's traffic passes
 * straight through.
 */

const CACHE = 'sondra-v1'

/**
 * Files handed over by another app's share sheet.
 *
 * A share arrives as a POST, which a page cannot read after the navigation it
 * triggers — so the worker takes the files out of the request, parks them here,
 * and redirects to the app, which collects them and empties the shelf again.
 * Kept apart from the asset cache so neither one clears the other.
 */
const SHARE_CACHE = 'sondra-share'

/**
 * The shell, by name. Hashed asset filenames are not knowable from here, so the
 * page reports those itself once the worker is in control (see the message
 * handler below). Without this, a visitor who loads the page once and then goes
 * offline would find nothing cached: the worker does not control the very
 * request that installed it.
 */
const SHELL = ['./', './index.html', './manifest.webmanifest', './fonts.css', './favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // One failure must not fail the whole install.
      await Promise.allSettled(SHELL.map((path) => cache.add(new Request(path, { cache: 'reload' }))))
      await self.skipWaiting()
    })(),
  )
})

/**
 * The page hands over the URLs it actually loaded — the hashed bundles, the
 * fonts, whatever the browser fetched before this worker existed.
 */
self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'precache' || !Array.isArray(data.urls)) return
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      const missing = []
      for (const url of data.urls) {
        if (typeof url !== 'string') continue
        if (new URL(url, self.location.href).origin !== self.location.origin) continue
        if (!(await cache.match(url))) missing.push(url)
      }
      await Promise.allSettled(missing.map((url) => cache.add(url)))
      await keepWholeBuild(cache)
    })(),
  )
})

/**
 * Every tool of the current build, and nothing of the old ones.
 *
 * Tools are loaded when opened, so a first visit alone left most of them
 * uncached and offline they would not open. `offline.json` lists this build's
 * files: all of them are fetched now, apart from the WebAssembly cores (cached
 * on first use), and any cached asset from an earlier build is deleted — each
 * deploy used to leave its bundles behind for good.
 */
async function keepWholeBuild(cache) {
  let list
  try {
    const response = await fetch(new URL('./offline.json', self.registration.scope), { cache: 'no-store' })
    if (!response.ok) return
    list = await response.json()
  } catch {
    return // offline, or an older build without the list
  }
  const base = new URL('./', self.registration.scope)
  const current = new Set([...(list.keep ?? []), ...(list.onDemand ?? [])].map((name) => new URL(name, base).href))
  const wanted = (list.keep ?? []).map((name) => new URL(name, base).href)
  const missing = []
  for (const url of wanted) if (!(await cache.match(url))) missing.push(url)
  await Promise.allSettled(missing.map((url) => cache.add(url)))
  for (const request of await cache.keys()) {
    if (request.url.startsWith(new URL('./assets/', base).href) && !current.has(request.url)) await cache.delete(request)
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older versions of the app.
      const names = await caches.keys()
      const keep = new Set([CACHE, SHARE_CACHE])
      await Promise.all(names.filter((name) => !keep.has(name)).map((name) => caches.delete(name)))
      await self.clients.claim()
    })(),
  )
})

/** Copies a response, adding the isolation headers. */
function isolate(response) {
  if (response.status === 0) return response // opaque; nothing to rewrite
  const headers = new Headers(response.headers)
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless')
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Takes the files out of a share and parks them for the app to collect.
 *
 * The redirect is what turns a POST into something the app can handle: the
 * browser follows it with a plain GET, the app starts normally, and the query
 * string tells it how many files are waiting.
 */
async function receiveShare(request) {
  const form = await request.formData()
  const files = form.getAll('media').filter((entry) => entry instanceof File)
  const cache = await caches.open(SHARE_CACHE)

  // Whatever an earlier share left behind is stale by now.
  for (const key of await cache.keys()) await cache.delete(key)

  for (const [index, file] of files.entries()) {
    await cache.put(
      new Request(`./shared/${index}`),
      new Response(file, {
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          // A Response carries no filename, so it travels as a header.
          'X-Filename': encodeURIComponent(file.name || `geteilt-${index}`),
        },
      }),
    )
  }

  const target = new URL('./', self.registration.scope)
  target.searchParams.set('shared', String(files.length))
  return Response.redirect(target.href, 303)
}

self.addEventListener('fetch', (event) => {
  const request = event.request

  // A cache-only request from another context is not ours to touch.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return

  const url = new URL(request.url)

  // A share sheet handing over a file. Answered before anything else, because
  // the body can only be read once and a redirect cannot be rewritten.
  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(request))
    return
  }
  const sameOrigin = url.origin === self.location.origin
  const cacheable = sameOrigin && request.method === 'GET'

  event.respondWith(
    (async () => {
      if (!cacheable) {
        // Cross-origin: pass through untouched, and never store it.
        return isolate(await fetch(request));
      }

      try {
        const response = await fetch(request)
        if (response.ok && response.status === 200) {
          // Cache a clone; the original still streams to the page.
          const copy = response.clone()
          void caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return isolate(response)
      } catch (error) {
        const cached = await caches.match(request)
        if (cached) return isolate(cached)
        // A navigation with nothing cached still deserves the app shell.
        if (request.mode === 'navigate') {
          const shell = await caches.match('./index.html')
          if (shell) return isolate(shell)
        }
        throw error
      }
    })(),
  )
})
