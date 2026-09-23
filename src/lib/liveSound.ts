/**
 * The audio editor's sound, as a Web Audio graph.
 *
 * The same chain runs twice: live, on the shared AudioContext while a file
 * plays, so every slider is heard the moment it moves — and offline, in an
 * OfflineAudioContext, when the settings are written into the audio. Because
 * it is literally the same nodes with the same values, what was heard is what
 * ends up in the file.
 *
 * The filters are the RBJ biquads the JS versions use (a BiquadFilterNode's Q
 * for high- and low-pass is in dB, hence the conversion), the room is the same
 * generated impulse, the echo is the same feedback line. Only the compressor
 * is the browser's own: a DynamicsCompressorNode, which brings its own make-up.
 */

import type { AudioData } from './wav'

export interface SoundSettings {
  gainDb: number
  highpassHz: number | null
  lowpassHz: number | null
  bassDb: number
  trebleDb: number
  compressor: { thresholdDb: number; ratio: number } | null
  echo: { delayMs: number; feedback: number; mix: number } | null
  room: { seconds: number; mix: number } | null
}

export const NEUTRAL_SOUND: SoundSettings = {
  gainDb: 0,
  highpassHz: null,
  lowpassHz: null,
  bassDb: 0,
  trebleDb: 0,
  compressor: null,
  echo: null,
  room: null,
}

export const soundIsNeutral = (s: SoundSettings) =>
  s.gainDb === 0 && s.highpassHz === null && s.lowpassHz === null && s.bassDb === 0 && s.trebleDb === 0 &&
  !s.compressor && !s.echo && !s.room

/** How long the sound rings on after the input stops. */
export function tailSeconds(s: SoundSettings): number {
  let tail = 0
  if (s.echo) {
    const delay = s.echo.delayMs / 1000
    tail += Math.min(6, (delay * Math.log(0.001)) / Math.log(Math.max(0.05, s.echo.feedback)))
  }
  if (s.room) tail += s.room.seconds
  return tail
}

// Butterworth, fourth order, as two biquads — the same Qs as the JS filters.
const BUTTERWORTH_Q_DB = [20 * Math.log10(0.5412), 20 * Math.log10(1.3066)]

/** Decaying, decorrelated noise; the same room the offline reverb used. */
function roomImpulse(context: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = context.sampleRate
  const length = Math.max(1, Math.round(seconds * rate))
  const ir = context.createBuffer(2, length, rate)
  for (let c = 0; c < 2; c += 1) {
    const data = ir.getChannelData(c)
    let seed = 12345 + c * 999
    for (let i = 0; i < length; i += 1) {
      seed = (seed * 16807) % 2147483647
      data[i] = ((seed / 2147483647) * 2 - 1) * Math.exp((-6.9 * i) / length)
    }
  }
  return ir
}

const dbToGain = (db: number) => 10 ** (db / 20)

export class SoundChain {
  readonly input: GainNode
  private readonly context: BaseAudioContext
  private readonly output: AudioNode
  private readonly gain: GainNode
  private readonly highpass: BiquadFilterNode[]
  private readonly lowpass: BiquadFilterNode[]
  private readonly bass: BiquadFilterNode
  private readonly treble: BiquadFilterNode
  private readonly compressor: DynamicsCompressorNode
  private readonly echoSum: GainNode
  private readonly echoDelay: DelayNode
  private readonly echoFeedback: GainNode
  private readonly echoWet: GainNode
  private readonly roomSum: GainNode
  private roomConvolver: ConvolverNode | null = null
  private roomSeconds = 0
  private readonly roomWet: GainNode
  private wiredAs = ''
  private settings: SoundSettings = NEUTRAL_SOUND

  constructor(context: BaseAudioContext, output: AudioNode, settings: SoundSettings) {
    this.context = context
    this.output = output
    this.input = context.createGain()
    this.gain = context.createGain()
    this.highpass = BUTTERWORTH_Q_DB.map((q) => {
      const node = context.createBiquadFilter()
      node.type = 'highpass'
      node.Q.value = q
      return node
    })
    this.lowpass = BUTTERWORTH_Q_DB.map((q) => {
      const node = context.createBiquadFilter()
      node.type = 'lowpass'
      node.Q.value = q
      return node
    })
    this.bass = context.createBiquadFilter()
    this.bass.type = 'lowshelf'
    this.bass.frequency.value = 120
    this.treble = context.createBiquadFilter()
    this.treble.type = 'highshelf'
    this.treble.frequency.value = Math.min(6000, context.sampleRate / 2 - 500)
    this.compressor = context.createDynamicsCompressor()
    this.compressor.knee.value = 6
    this.compressor.attack.value = 0.01
    this.compressor.release.value = 0.15
    this.echoSum = context.createGain()
    this.echoDelay = context.createDelay(1.5)
    this.echoFeedback = context.createGain()
    this.echoWet = context.createGain()
    this.roomSum = context.createGain()
    this.roomWet = context.createGain()
    this.update(settings)
  }

  /** Moves the values; rewires only when an effect comes or goes. */
  update(settings: SoundSettings) {
    this.settings = settings
    const set = (param: AudioParam, value: number) => {
      // Live, a short glide keeps a dragged slider from zipping; offline the
      // value simply is what it is from the first sample.
      if (this.context instanceof AudioContext) param.setTargetAtTime(value, this.context.currentTime, 0.015)
      else param.value = value
    }
    set(this.gain.gain, dbToGain(settings.gainDb))
    if (settings.highpassHz !== null) for (const node of this.highpass) set(node.frequency, settings.highpassHz)
    if (settings.lowpassHz !== null) {
      const top = Math.min(settings.lowpassHz, this.context.sampleRate / 2 - 100)
      for (const node of this.lowpass) set(node.frequency, top)
    }
    set(this.bass.gain, settings.bassDb)
    set(this.treble.gain, settings.trebleDb)
    if (settings.compressor) {
      set(this.compressor.threshold, settings.compressor.thresholdDb)
      set(this.compressor.ratio, settings.compressor.ratio)
    }
    if (settings.echo) {
      set(this.echoDelay.delayTime, settings.echo.delayMs / 1000)
      set(this.echoFeedback.gain, settings.echo.feedback)
      set(this.echoWet.gain, settings.echo.mix)
    }
    if (settings.room) {
      set(this.roomWet.gain, settings.room.mix * 0.5)
      // A new size is a new impulse, and a convolver takes its buffer once.
      if (!this.roomConvolver || this.roomSeconds !== settings.room.seconds) {
        this.roomConvolver?.disconnect()
        this.roomConvolver = this.context.createConvolver()
        this.roomConvolver.buffer = roomImpulse(this.context, settings.room.seconds)
        this.roomSeconds = settings.room.seconds
        this.wiredAs = ''
      }
    }
    this.wire()
  }

  private wire() {
    const s = this.settings
    const key = [s.highpassHz !== null, s.lowpassHz !== null, s.bassDb !== 0 || s.trebleDb !== 0, !!s.compressor, !!s.echo, !!s.room].join()
    if (key === this.wiredAs) return
    this.wiredAs = key
    for (const node of this.nodes()) node.disconnect()

    const chain: AudioNode[] = [this.input, this.gain]
    if (s.highpassHz !== null) chain.push(...this.highpass)
    if (s.lowpassHz !== null) chain.push(...this.lowpass)
    if (s.bassDb !== 0 || s.trebleDb !== 0) chain.push(this.bass, this.treble)
    if (s.compressor) chain.push(this.compressor)
    for (let i = 0; i < chain.length - 1; i += 1) chain[i].connect(chain[i + 1])
    let last = chain[chain.length - 1]

    if (s.echo) {
      last.connect(this.echoSum)
      last.connect(this.echoDelay)
      this.echoDelay.connect(this.echoFeedback).connect(this.echoDelay)
      this.echoDelay.connect(this.echoWet).connect(this.echoSum)
      last = this.echoSum
    }
    if (s.room && this.roomConvolver) {
      last.connect(this.roomSum)
      last.connect(this.roomConvolver).connect(this.roomWet).connect(this.roomSum)
      last = this.roomSum
    }
    last.connect(this.output)
  }

  private nodes(): AudioNode[] {
    return [
      this.input, this.gain, ...this.highpass, ...this.lowpass, this.bass, this.treble, this.compressor,
      this.echoSum, this.echoDelay, this.echoFeedback, this.echoWet, this.roomSum, this.roomWet,
      ...(this.roomConvolver ? [this.roomConvolver] : []),
    ]
  }

  dispose() {
    for (const node of this.nodes()) node.disconnect()
  }
}

/**
 * Renders `audio` through the chain. `extend` lets echo and room ring out
 * past the end — for a whole file; a range has to keep its length.
 */
export async function renderSound(audio: AudioData, settings: SoundSettings, extend: boolean): Promise<AudioData> {
  const rate = audio.sampleRate
  const frames = audio.channels[0]?.length ?? 0
  const length = frames + (extend ? Math.round(tailSeconds(settings) * rate) : 0)
  // A room turns mono into stereo, as the offline reverb always did.
  const channelCount = settings.room ? Math.max(2, audio.channels.length) : audio.channels.length
  const context = new OfflineAudioContext(channelCount, Math.max(1, length), rate)
  const input = context.createBuffer(audio.channels.length, Math.max(1, frames), rate)
  audio.channels.forEach((channel, index) => input.copyToChannel(new Float32Array(channel), index))
  const source = context.createBufferSource()
  source.buffer = input
  const chain = new SoundChain(context, context.destination, settings)
  source.connect(chain.input)
  source.start()
  const rendered = await context.startRendering()
  const channels = Array.from({ length: channelCount }, (_, index) => {
    const data = new Float32Array(rendered.getChannelData(index))
    for (let i = 0; i < data.length; i += 1) data[i] = Math.max(-1, Math.min(1, data[i]))
    return data
  })
  return { channels, sampleRate: rate }
}

/* -------------------------------------------------------------------------- */
/* Pitch, live                                                                 */
/* -------------------------------------------------------------------------- */

// Two read heads sweep a short delay line at the new speed and cross-fade, so
// the pitch moves while the timing stays. Coarser than the phase vocoder that
// renders the final file — good enough to judge by, and it answers at once.
const SHIFTER_SOURCE = `
class SondraShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }]
  }
  constructor() {
    super()
    this.size = 32768
    this.lines = []
    this.write = 0
    this.phase = 0
    this.grain = Math.round(sampleRate * 0.07)
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0] || []
    const output = outputs[0]
    const ratio = parameters.ratio[0]
    const size = this.size
    const grain = this.grain
    while (this.lines.length < output.length) this.lines.push(new Float32Array(size))
    const frames = output[0].length
    const step = (1 - ratio) / grain
    for (let i = 0; i < frames; i += 1) {
      const w = this.write
      for (let c = 0; c < output.length; c += 1) {
        const src = input[c] || input[0]
        this.lines[c][w] = src ? src[i] : 0
      }
      if (ratio === 1) {
        for (let c = 0; c < output.length; c += 1) output[c][i] = this.lines[c][w]
      } else {
        const pa = this.phase
        const pb = (pa + 0.5) % 1
        const ga = Math.sin(Math.PI * pa) ** 2
        const gb = Math.sin(Math.PI * pb) ** 2
        const da = pa * grain + 1
        const db = pb * grain + 1
        for (let c = 0; c < output.length; c += 1) {
          const line = this.lines[c]
          output[c][i] = ga * this.read(line, w - da) + gb * this.read(line, w - db)
        }
        this.phase = (((pa + step) % 1) + 1) % 1
      }
      this.write = (w + 1) % size
    }
    return true
  }
  read(line, at) {
    const size = this.size
    const base = Math.floor(at)
    const frac = at - base
    const i0 = ((base % size) + size) % size
    const i1 = (i0 + 1) % size
    return line[i0] + (line[i1] - line[i0]) * frac
  }
}
registerProcessor('sondra-shifter', SondraShifter)
`

const shifterReady = new WeakMap<BaseAudioContext, Promise<boolean>>()

/** Loads the shifter once per context; false where worklets are missing. */
export function loadShifter(context: AudioContext): Promise<boolean> {
  let ready = shifterReady.get(context)
  if (!ready) {
    if (!context.audioWorklet) {
      ready = Promise.resolve(false)
    } else {
      const url = URL.createObjectURL(new Blob([SHIFTER_SOURCE], { type: 'text/javascript' }))
      ready = context.audioWorklet
        .addModule(url)
        .then(() => true, () => false)
        .finally(() => URL.revokeObjectURL(url))
    }
    shifterReady.set(context, ready)
  }
  return ready
}

export function createShifter(context: AudioContext): AudioWorkletNode {
  return new AudioWorkletNode(context, 'sondra-shifter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
}
