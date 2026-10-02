/**
 * Recording the screen or a window, with the computer's sound, a microphone,
 * or both, into a video file.
 *
 * In a browser, getDisplayMedia shows the browser's own picker. In the app
 * there is no such picker, so the page lists the sources through the preload
 * (see `captureSources`) and tells the app which one to hand over before it
 * asks. Two sounds become one track through a small Web Audio mix, because a
 * recorder takes one audio track.
 *
 * MediaRecorder writes WebM without a duration or an index — a player then
 * cannot seek in it, and the video editor's timeline would have no end.
 * `finishRecording` remuxes it with FFmpeg (stream copy, seconds, no
 * re-encode) so the file is whole; if that fails the raw file still counts.
 */

import { APP_BRIDGE, type CaptureSource } from './desktop'
import { loadFfmpeg, runFfmpeg } from './ffmpegClient'

export type { CaptureSource }

/** True when this page can record the screen at all. */
export function canRecordScreen(): boolean {
  if (typeof navigator === 'undefined' || typeof MediaRecorder === 'undefined') return false
  if (APP_BRIDGE) return typeof APP_BRIDGE.captureSources === 'function'
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function'
}

/** In the app: the screens and windows to choose from. Null in a browser. */
export async function captureSources(): Promise<CaptureSource[] | null> {
  if (!APP_BRIDGE?.captureSources) return null
  return APP_BRIDGE.captureSources()
}

export interface RecordOptions {
  /** In the app: the source picked from `captureSources`. */
  sourceId?: string
  systemAudio: boolean
  microphone: boolean
  frameRate: 30 | 60
}

export interface ScreenRecording {
  /** Video plus the mixed sound, as it is being recorded. */
  stream: MediaStream
  /** What is actually being heard: system, microphone, both or none. */
  sound: { system: boolean; microphone: boolean }
  /** Resolves once with the recorded bytes when it stops. */
  done: Promise<{ bytes: Uint8Array; mime: string; seconds: number }>
  pause: () => void
  resume: () => void
  stop: () => void
  /** Bytes recorded so far, updated once a second. */
  onSize: (listener: (bytes: number, seconds: number) => void) => void
}

const CANDIDATES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']

function bitrate(frameRate: number): number {
  // Screens are mostly still text; this keeps it sharp at 1080p and 1440p
  // without an hour costing more than about two gigabytes.
  return frameRate === 60 ? 6_000_000 : 4_000_000
}

export async function startScreenRecording(options: RecordOptions): Promise<ScreenRecording> {
  if (APP_BRIDGE) {
    if (!options.sourceId || !APP_BRIDGE.pickCaptureSource) throw new Error('Bitte zuerst einen Bildschirm oder ein Fenster wählen.')
    await APP_BRIDGE.pickCaptureSource(options.sourceId, options.systemAudio)
  }
  const ask = (audio: boolean) =>
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: options.frameRate } }, audio })
  let display: MediaStream
  try {
    display = await ask(options.systemAudio)
  } catch (failure) {
    const refused = failure instanceof DOMException && failure.name === 'NotAllowedError'
    // A machine without a sound device cannot give loopback sound; the
    // picture alone is still worth having, and the panel says what is missing.
    if (refused || !options.systemAudio || !APP_BRIDGE) {
      throw refused ? new Error('Die Aufnahme wurde nicht freigegeben.') : failure
    }
    await APP_BRIDGE.pickCaptureSource?.(options.sourceId!, false)
    display = await ask(false)
  }

  let microphone: MediaStream | null = null
  if (options.microphone) {
    try {
      microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch {
      display.getTracks().forEach((track) => track.stop())
      throw new Error('Das Mikrofon wurde nicht freigegeben. Ohne Mikrofon aufnehmen oder den Zugriff erlauben.')
    }
  }

  const systemTracks = display.getAudioTracks()
  const micTracks = microphone?.getAudioTracks() ?? []
  let mixContext: AudioContext | null = null
  let audioTracks: MediaStreamTrack[] = []
  if (systemTracks.length && micTracks.length) {
    mixContext = new AudioContext()
    const sink = mixContext.createMediaStreamDestination()
    mixContext.createMediaStreamSource(new MediaStream(systemTracks)).connect(sink)
    mixContext.createMediaStreamSource(new MediaStream(micTracks)).connect(sink)
    audioTracks = sink.stream.getAudioTracks()
  } else {
    audioTracks = systemTracks.length ? systemTracks : micTracks
  }
  const stream = new MediaStream([...display.getVideoTracks(), ...audioTracks])

  const mime = CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? ''
  const recorder = new MediaRecorder(stream, {
    ...(mime ? { mimeType: mime } : {}),
    videoBitsPerSecond: bitrate(options.frameRate),
    audioBitsPerSecond: 160_000,
  })
  const chunks: Blob[] = []
  let size = 0
  let seconds = 0
  let ticking: number | null = null
  const listeners = new Set<(bytes: number, seconds: number) => void>()
  recorder.ondataavailable = (event) => {
    if (event.data.size) {
      chunks.push(event.data)
      size += event.data.size
    }
  }

  const release = () => {
    if (ticking !== null) window.clearInterval(ticking)
    display.getTracks().forEach((track) => track.stop())
    microphone?.getTracks().forEach((track) => track.stop())
    void mixContext?.close()
  }

  const done = new Promise<{ bytes: Uint8Array; mime: string; seconds: number }>((resolve, reject) => {
    recorder.onstop = async () => {
      release()
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' })
        resolve({ bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, seconds })
      } catch (failure) {
        reject(failure)
      }
    }
    recorder.onerror = () => {
      release()
      reject(new Error('Die Aufnahme ist abgebrochen.'))
    }
  })

  // Ending the share from the browser's own bar, or closing the recorded
  // window, ends the recording too.
  display.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (recorder.state !== 'inactive') recorder.stop()
  })

  recorder.start(1000)
  ticking = window.setInterval(() => {
    if (recorder.state === 'recording') seconds += 1
    listeners.forEach((listener) => listener(size, seconds))
  }, 1000)

  return {
    stream,
    sound: { system: systemTracks.length > 0, microphone: micTracks.length > 0 },
    done,
    pause: () => recorder.state === 'recording' && recorder.pause(),
    resume: () => recorder.state === 'paused' && recorder.resume(),
    stop: () => recorder.state !== 'inactive' && recorder.stop(),
    onSize: (listener) => listeners.add(listener),
  }
}

/**
 * A WebM a player can seek in: same streams, rewritten with a duration and
 * an index. Returns the input unchanged when FFmpeg cannot help.
 */
export async function finishRecording(bytes: Uint8Array): Promise<{ bytes: Uint8Array; fixed: boolean }> {
  try {
    await loadFfmpeg()
    const { files } = await runFfmpeg({
      input: { 'in.webm': bytes },
      output: ['out.webm'],
      args: ['-i', 'in.webm', '-map', '0', '-c', 'copy', 'out.webm'],
    })
    const out = files['out.webm']
    if (out && out.byteLength > 1024) return { bytes: out, fixed: true }
  } catch {
    /* the raw recording is still a recording */
  }
  return { bytes, fixed: false }
}
