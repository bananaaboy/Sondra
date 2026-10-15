/**
 * Parametric 5-Band Equalizer & Master Limiter using the Web Audio API.
 *
 * 100% local and offline audio processing rack with:
 * - Band 1: LowShelf at 80 Hz (Bässe)
 * - Band 2: Peaking at 300 Hz (Tiefmitten)
 * - Band 3: Peaking at 1000 Hz (Mitten)
 * - Band 4: Peaking at 3500 Hz (Präsenz)
 * - Band 5: HighShelf at 10000 Hz (Höhen/Air)
 * - Master DynamicsCompressorNode as soft limiter (prevents digital clipping)
 *
 * Presets:
 * - 'Flat'
 * - 'Bass Boost'
 * - 'Vocal Clarity'
 * - 'Elektronisch'
 * - 'Höhen-Boost'
 */

export type FiveBandGains = [number, number, number, number, number]

export const EQUALIZER_PRESET_NAMES = [
  'Flat',
  'Bass Boost',
  'Vocal Clarity',
  'Elektronisch',
  'Höhen-Boost',
] as const

export type EqualizerPresetName = (typeof EQUALIZER_PRESET_NAMES)[number]

export const EQUALIZER_PRESETS: Record<EqualizerPresetName, FiveBandGains> = {
  'Flat': [0, 0, 0, 0, 0],
  'Bass Boost': [6, 3, 0, 1, 2],
  'Vocal Clarity': [-2, -1, 2.5, 4.5, 2],
  'Elektronisch': [5, 2, -1.5, 2, 4.5],
  'Höhen-Boost': [-1, 0, 1, 3.5, 6],
}

export interface EqualizerBandConfig {
  readonly index: number
  readonly id: string
  readonly name: string
  readonly frequency: number
  readonly displayFreq: string
  readonly type: BiquadFilterType
  readonly description: string
}

export const EQUALIZER_BANDS: readonly EqualizerBandConfig[] = [
  { index: 0, id: 'band1', name: 'Bässe', frequency: 80, displayFreq: '80 Hz', type: 'lowshelf', description: 'Sub & Bass' },
  { index: 1, id: 'band2', name: 'Tiefmitten', frequency: 300, displayFreq: '300 Hz', type: 'peaking', description: 'Wärme & Fundament' },
  { index: 2, id: 'band3', name: 'Mitten', frequency: 1000, displayFreq: '1 kHz', type: 'peaking', description: 'Vocal- & Instrumentenkern' },
  { index: 3, id: 'band4', name: 'Präsenz', frequency: 3500, displayFreq: '3.5 kHz', type: 'peaking', description: 'Sprachverständlichkeit' },
  { index: 4, id: 'band5', name: 'Höhen/Air', frequency: 10000, displayFreq: '10 kHz', type: 'highshelf', description: 'Luft & Brillanz' },
] as const

export interface EqualizerRackOptions {
  initialGains?: FiveBandGains | number[]
  enabled?: boolean
}

export class EqualizerRack {
  readonly context: AudioContext
  readonly input: GainNode
  readonly output: GainNode

  readonly band1: BiquadFilterNode
  readonly band2: BiquadFilterNode
  readonly band3: BiquadFilterNode
  readonly band4: BiquadFilterNode
  readonly band5: BiquadFilterNode
  readonly bands: readonly [
    BiquadFilterNode,
    BiquadFilterNode,
    BiquadFilterNode,
    BiquadFilterNode,
    BiquadFilterNode,
  ]

  readonly limiter: DynamicsCompressorNode

  private readonly _bypassGain: GainNode
  private readonly _wetGain: GainNode
  private _enabled: boolean = true

  constructor(context: AudioContext, options?: EqualizerRackOptions) {
    this.context = context
    this.input = context.createGain()
    this.output = context.createGain()
    this._bypassGain = context.createGain()
    this._wetGain = context.createGain()

    const initialGains = options?.initialGains ?? [0, 0, 0, 0, 0]
    this._enabled = options?.enabled !== false

    // Band 1: LowShelf at 80 Hz (Bässe)
    this.band1 = context.createBiquadFilter()
    this.band1.type = 'lowshelf'
    this.band1.frequency.value = 80
    this.band1.gain.value = Math.max(-12, Math.min(12, initialGains[0] ?? 0))

    // Band 2: Peaking at 300 Hz (Tiefmitten)
    this.band2 = context.createBiquadFilter()
    this.band2.type = 'peaking'
    this.band2.frequency.value = 300
    this.band2.Q.value = 1.0
    this.band2.gain.value = Math.max(-12, Math.min(12, initialGains[1] ?? 0))

    // Band 3: Peaking at 1000 Hz (Mitten)
    this.band3 = context.createBiquadFilter()
    this.band3.type = 'peaking'
    this.band3.frequency.value = 1000
    this.band3.Q.value = 1.0
    this.band3.gain.value = Math.max(-12, Math.min(12, initialGains[2] ?? 0))

    // Band 4: Peaking at 3500 Hz (Präsenz)
    this.band4 = context.createBiquadFilter()
    this.band4.type = 'peaking'
    this.band4.frequency.value = 3500
    this.band4.Q.value = 1.0
    this.band4.gain.value = Math.max(-12, Math.min(12, initialGains[3] ?? 0))

    // Band 5: HighShelf at 10000 Hz (Höhen/Air)
    this.band5 = context.createBiquadFilter()
    this.band5.type = 'highshelf'
    this.band5.frequency.value = 10000
    this.band5.gain.value = Math.max(-12, Math.min(12, initialGains[4] ?? 0))

    this.bands = [this.band1, this.band2, this.band3, this.band4, this.band5] as const

    // Master DynamicsCompressorNode as soft limiter:
    // Fast attack and soft knee to transparently catch overs when EQ bands are boosted
    this.limiter = context.createDynamicsCompressor()
    this.limiter.threshold.value = -0.5
    this.limiter.knee.value = 4
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.003
    this.limiter.release.value = 0.1

    // Wet signal routing:
    // input -> band1 -> band2 -> band3 -> band4 -> band5 -> limiter -> _wetGain -> output
    this.input.connect(this.band1)
    this.band1.connect(this.band2)
    this.band2.connect(this.band3)
    this.band3.connect(this.band4)
    this.band4.connect(this.band5)
    this.band5.connect(this.limiter)
    this.limiter.connect(this._wetGain)
    this._wetGain.connect(this.output)

    // Dry/bypass routing:
    // input -> _bypassGain -> output
    this.input.connect(this._bypassGain)
    this._bypassGain.connect(this.output)

    this._updateBypassRouting(0)
  }

  private _updateBypassRouting(rampTime: number = 0.02): void {
    const now = this.context.currentTime
    if (this._enabled) {
      if (rampTime > 0) {
        this._bypassGain.gain.setTargetAtTime(0, now, rampTime)
        this._wetGain.gain.setTargetAtTime(1, now, rampTime)
      } else {
        this._bypassGain.gain.value = 0
        this._wetGain.gain.value = 1
      }
    } else {
      if (rampTime > 0) {
        this._bypassGain.gain.setTargetAtTime(1, now, rampTime)
        this._wetGain.gain.setTargetAtTime(0, now, rampTime)
      } else {
        this._bypassGain.gain.value = 1
        this._wetGain.gain.value = 0
      }
    }
  }

  setEnabled(enabled: boolean, rampTime: number = 0.02): void {
    this._enabled = enabled
    this._updateBypassRouting(rampTime)
  }

  isEnabled(): boolean {
    return this._enabled
  }

  setBandGain(bandIndex: number, gainDb: number, rampTime: number = 0.01): void {
    const clamped = Math.max(-12, Math.min(12, gainDb))
    const band = this.bands[bandIndex]
    if (band) {
      if (rampTime > 0) {
        band.gain.setTargetAtTime(clamped, this.context.currentTime, rampTime)
      } else {
        band.gain.value = clamped
      }
    }
  }

  setGains(gains: FiveBandGains | number[], rampTime: number = 0.01): void {
    for (let i = 0; i < 5; i++) {
      if (typeof gains[i] === 'number') {
        this.setBandGain(i, gains[i], rampTime)
      }
    }
  }

  getGains(): FiveBandGains {
    return [
      this.band1.gain.value,
      this.band2.gain.value,
      this.band3.gain.value,
      this.band4.gain.value,
      this.band5.gain.value,
    ]
  }

  applyPreset(preset: EqualizerPresetName, rampTime: number = 0.01): void {
    const values = EQUALIZER_PRESETS[preset]
    if (values) {
      this.setGains(values, rampTime)
    }
  }

  reset(rampTime: number = 0.01): void {
    this.setGains([0, 0, 0, 0, 0], rampTime)
  }

  disconnect(): void {
    try {
      this.input.disconnect()
      this.band1.disconnect()
      this.band2.disconnect()
      this.band3.disconnect()
      this.band4.disconnect()
      this.band5.disconnect()
      this.limiter.disconnect()
      this._wetGain.disconnect()
      this._bypassGain.disconnect()
      this.output.disconnect()
    } catch {
      /* ignore already disconnected */
    }
  }
}

export function createEqualizerRack(
  context: AudioContext,
  options?: EqualizerRackOptions
): EqualizerRack {
  return new EqualizerRack(context, options)
}
