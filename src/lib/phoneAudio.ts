/**
 * The phone's sound, played here.
 *
 * scrcpy's server captures what the phone plays (Android 11 and newer),
 * encodes it as Opus and sends it with the picture. Here the packets are
 * decoded with WebCodecs and put on a Web Audio timeline a little ahead of
 * "now": far enough that a late packet does not crackle, near enough that
 * sound and picture stay together. A chunk that arrives later than the
 * timeline has room for is dropped rather than queued — a growing delay is
 * worse than a missing blink.
 */

import type { ScrcpyMediaStreamPacket } from '@yume-chan/scrcpy'

/** How far ahead of the clock the first chunk is placed, in seconds. */
const HEAD_START = 0.05
/** More than this behind schedule and the backlog is let go. */
const MAX_LAG = 0.4

export class PhoneAudio {
  readonly #context: AudioContext
  readonly #gain: GainNode
  #decoder: AudioDecoder | null = null
  #next = 0
  #muted = false

  /** Created from a click: a browser starts an AudioContext only then. */
  constructor() {
    this.#context = new AudioContext({ latencyHint: 'interactive' })
    this.#gain = this.#context.createGain()
    this.#gain.connect(this.#context.destination)
    void this.#context.resume().catch(() => undefined)
  }

  get muted(): boolean {
    return this.#muted
  }

  setMuted(muted: boolean): void {
    this.#muted = muted
    // A short ramp: a hard cut from full level to zero clicks.
    this.#gain.gain.setTargetAtTime(muted ? 0 : 1, this.#context.currentTime, 0.015)
  }

  /** Decodes and plays packets until the stream ends. */
  async play(codec: string, stream: ReadableStream<ScrcpyMediaStreamPacket>): Promise<void> {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (value.type === 'configuration') {
          this.#configure(codec, value.data)
        } else if (this.#decoder?.state === 'configured') {
          this.#decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Number(value.pts ?? 0n), data: value.data }))
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  #configure(codec: string, description: Uint8Array): void {
    this.#decoder?.close()
    const decoder = new AudioDecoder({
      output: (data) => this.#schedule(data),
      error: () => undefined,
    })
    // scrcpy's Opus is always 48 kHz stereo; the identification header in the
    // configuration packet says so, and WebCodecs reads it from `description`.
    decoder.configure({ codec, sampleRate: 48000, numberOfChannels: 2, description })
    this.#decoder = decoder
  }

  #schedule(data: AudioData): void {
    try {
      const context = this.#context
      const channels = data.numberOfChannels
      const buffer = context.createBuffer(channels, data.numberOfFrames, data.sampleRate)
      for (let channel = 0; channel < channels; channel += 1) {
        const plane = new Float32Array(data.numberOfFrames)
        data.copyTo(plane, { planeIndex: channel, format: 'f32-planar' })
        buffer.copyToChannel(plane, channel)
      }
      const now = context.currentTime
      if (this.#next - now > MAX_LAG) return
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(this.#gain)
      const at = Math.max(this.#next, now + HEAD_START)
      source.start(at)
      this.#next = at + buffer.duration
    } finally {
      data.close()
    }
  }

  close(): void {
    try {
      this.#decoder?.close()
    } catch {
      /* already closed */
    }
    void this.#context.close().catch(() => undefined)
  }
}

/** True where the browser can decode what the phone sends. */
export const canPlayPhoneAudio = (): boolean => typeof AudioDecoder !== 'undefined' && typeof AudioContext !== 'undefined'
