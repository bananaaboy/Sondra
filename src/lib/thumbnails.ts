/**
 * Small pictures for the folder page, made in the browser from the file
 * itself: a frame from the first sixth of a video, a picture scaled down,
 * and for sound its length. Two at a time, only for tiles on screen, kept
 * in memory for the visit — a folder of two hundred films is not decoded
 * two hundred times over.
 *
 * What the browser cannot decode (most AVI, H.265 in Firefox, HEIC) gets no
 * picture, and the tile says its format instead.
 */

export interface Thumbnail {
  /** An object URL of a small JPEG, or null when there is none. */
  url: string | null
  /** Seconds, for video and sound. */
  duration: number | null
}

const WIDTH = 360
const cache = new Map<string, Promise<Thumbnail>>()
const made = new Set<string>()
let running = 0
const waiting: (() => void)[] = []

const slot = () =>
  new Promise<void>((resolve) => {
    if (running < 2) {
      running += 1
      resolve()
    } else waiting.push(() => {
      running += 1
      resolve()
    })
  })
const release = () => {
  running -= 1
  waiting.shift()?.()
}

function canvasUrl(source: CanvasImageSource, width: number, height: number): Promise<string | null> {
  const scale = Math.min(1, WIDTH / Math.max(1, width))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) return Promise.resolve(null)
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve) =>
    canvas.toBlob((blob) => {
      if (!blob) return resolve(null)
      const url = URL.createObjectURL(blob)
      made.add(url)
      resolve(url)
    }, 'image/jpeg', 0.82),
  )
}

async function ofImage(file: File): Promise<Thumbnail> {
  try {
    // Scaled while decoding: a 24-megapixel photo never sits in memory whole.
    const bitmap = await createImageBitmap(file, { resizeWidth: WIDTH, resizeQuality: 'medium' })
    const url = await canvasUrl(bitmap, bitmap.width, bitmap.height)
    bitmap.close()
    return { url, duration: null }
  } catch {
    return { url: null, duration: null }
  }
}

/** Waits for one media event, or gives up. */
function once(element: HTMLMediaElement, event: string, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      element.removeEventListener(event, onEvent)
      element.removeEventListener('error', onError)
      window.clearTimeout(timer)
      resolve(ok)
    }
    const onEvent = () => done(true)
    const onError = () => done(false)
    const timer = window.setTimeout(() => done(false), timeout)
    element.addEventListener(event, onEvent)
    element.addEventListener('error', onError)
  })
}

async function ofMedia(file: File, video: boolean): Promise<Thumbnail> {
  const source = URL.createObjectURL(file)
  const element = document.createElement(video ? 'video' : 'audio')
  element.muted = true
  element.preload = 'metadata'
  element.src = source
  try {
    if (!(await once(element, 'loadedmetadata', 8000))) return { url: null, duration: null }
    const duration = Number.isFinite(element.duration) ? element.duration : null
    if (!video) return { url: null, duration }
    const player = element as HTMLVideoElement
    // Past a black opening second, before the credits of a short clip.
    player.currentTime = duration ? Math.min(Math.max(1, duration * 0.15), Math.max(0, duration - 0.5)) : 1
    if (!(await once(player, 'seeked', 8000)) || !player.videoWidth) return { url: null, duration }
    return { url: await canvasUrl(player, player.videoWidth, player.videoHeight), duration }
  } finally {
    element.removeAttribute('src')
    element.load()
    URL.revokeObjectURL(source)
  }
}

/** The picture and length of a file, made once per visit. */
export function thumbnailFor(file: File, kind: 'video' | 'audio' | 'image', key: string): Promise<Thumbnail> {
  const known = cache.get(key)
  if (known) return known
  const job = (async () => {
    await slot()
    try {
      return kind === 'image' ? await ofImage(file) : await ofMedia(file, kind === 'video')
    } finally {
      release()
    }
  })()
  cache.set(key, job)
  return job
}

/** Lets go of every picture made — on another folder. */
export function clearThumbnails(): void {
  for (const url of made) URL.revokeObjectURL(url)
  made.clear()
  cache.clear()
}
