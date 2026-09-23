/**
 * Microphone calibration: measure the room, then clean up a voice for a job.
 *
 * Two takes are recorded — a few seconds of silence and a few seconds of the
 * person talking, singing or playing — and everything is derived from them:
 * how loud the room is, how loud the voice is, whether the mains hum is in
 * there, and what the background sounds like bin by bin. The chain below is
 * then set from those numbers and from what the recording is for, and every
 * step reports what it did in words, with the values it used.
 *
 * Nothing touches the device. A web page cannot turn a microphone's input
 * gain up or down, so that part is a recommendation, stated as one.
 *
 * All of it runs on plain Float32Arrays in this tab.
 */

import { resampleAudio } from './edit'
import { stft, istft } from './fft'
import { applyNormalization, measureLoudness } from './loudness'
import type { AudioData, Samples } from './wav'

export type MicPurpose = 'podcast' | 'streaming' | 'meeting' | 'vocals' | 'instrument'

export interface PurposeProfile {
  id: MicPurpose
  label: string
  hint: string
  /** What to do during the second take. */
  prompt: string
  highpassHz: number | null
  /** Deepest cut the noise reduction may make, in dB. */
  noiseReductionDb: number
  /** How far pauses are pulled down by the gate, in dB; 0 turns it off. */
  gateRangeDb: number
  compressor: { ratio: number; belowSpeechDb: number; attackMs: number; releaseMs: number } | null
  targetLufs: number
  ceilingDbtp: number
}

export const PURPOSES: PurposeProfile[] = [
  {
    id: 'podcast',
    label: 'Podcast',
    hint: 'Stimme nah und ruhig, Pausen still, −16 LUFS wie bei Apple und Spotify',
    prompt: 'Sprechen Sie ganz normal, als würden Sie eine Folge aufnehmen.',
    highpassHz: 80,
    noiseReductionDb: 18,
    gateRangeDb: 12,
    compressor: { ratio: 3, belowSpeechDb: 8, attackMs: 8, releaseMs: 160 },
    targetLufs: -16,
    ceilingDbtp: -1,
  },
  {
    id: 'streaming',
    label: 'Streaming',
    hint: 'Stimme über Spiel und Musik, Tastatur und Lüfter weg, −14 LUFS',
    prompt: 'Sprechen Sie so, wie Sie im Stream sprechen — ruhig auch etwas lauter.',
    highpassHz: 90,
    noiseReductionDb: 20,
    gateRangeDb: 15,
    compressor: { ratio: 4, belowSpeechDb: 10, attackMs: 5, releaseMs: 120 },
    targetLufs: -14,
    ceilingDbtp: -1,
  },
  {
    id: 'meeting',
    label: 'Videocall',
    hint: 'Verständlichkeit vor Klang, Hintergrund so leise wie möglich',
    prompt: 'Sprechen Sie wie in einer Besprechung.',
    highpassHz: 110,
    noiseReductionDb: 24,
    gateRangeDb: 18,
    compressor: { ratio: 3, belowSpeechDb: 8, attackMs: 8, releaseMs: 180 },
    targetLufs: -18,
    ceilingDbtp: -1,
  },
  {
    id: 'vocals',
    label: 'Gesang',
    hint: 'Natürlich bleiben, nur Rumpeln und Rauschen weg, Platz für den Mix',
    prompt: 'Singen Sie eine Passage so laut, wie Sie später aufnehmen.',
    highpassHz: 75,
    noiseReductionDb: 8,
    gateRangeDb: 0,
    compressor: { ratio: 2, belowSpeechDb: 6, attackMs: 12, releaseMs: 220 },
    targetLufs: -18,
    ceilingDbtp: -1,
  },
  {
    id: 'instrument',
    label: 'Instrument',
    hint: 'Klang unangetastet, nur tiefes Rumpeln und Rauschen dezent weg',
    prompt: 'Spielen Sie etwas, auch die lauteste Stelle.',
    highpassHz: 30,
    noiseReductionDb: 6,
    gateRangeDb: 0,
    compressor: null,
    targetLufs: -18,
    ceilingDbtp: -1,
  },
]

export const profileFor = (id: MicPurpose): PurposeProfile =>
  PURPOSES.find((profile) => profile.id === id) ?? PURPOSES[0]

/* -------------------------------------------------------------------------- */
/* Measuring                                                                   */
/* -------------------------------------------------------------------------- */

const toDb = (power: number) => (power > 1e-20 ? 10 * Math.log10(power) : -200)
const dbToGain = (db: number) => 10 ** (db / 20)
const round1 = (value: number) => Math.round(value * 10) / 10
// German decimals and a real minus sign, as everywhere else in the interface.
const fmt = (value: number) =>
  (value > 0 ? `+${round1(value).toFixed(1)}` : round1(value).toFixed(1)).replace('.', ',').replace('-', '−')
const fmtAbs = (value: number) => round1(value).toFixed(1).replace('.', ',').replace('-', '−')

/** Mean square per frame, in dB. */
function frameLevels(samples: Float32Array, rate: number, frameMs = 50): number[] {
  const size = Math.max(1, Math.round((rate * frameMs) / 1000))
  const levels: number[] = []
  for (let start = 0; start + size <= samples.length; start += size) {
    let sum = 0
    for (let i = start; i < start + size; i += 1) sum += samples[i] * samples[i]
    levels.push(toDb(sum / size))
  }
  return levels
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return -200
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}

export interface MicMeasurement {
  /** RMS of the silent take, dBFS. */
  noiseFloorDb: number
  /** RMS over the frames where somebody was actually talking, dBFS. */
  speechDb: number
  peakDb: number
  /** Samples at or above −0.1 dBFS. */
  clipped: number
  snrDb: number
  humHz: 50 | 60 | null
}

/** Mains hum shows as a narrow peak at 50 or 60 Hz and its first overtone. */
function detectHum(noise: Float32Array, rate: number): 50 | 60 | null {
  const size = 16384
  if (noise.length < size) return null
  const spec = stft(noise, size, size / 2)
  const average = new Float64Array(spec.bins)
  for (let f = 0; f < spec.frames; f += 1) {
    for (let b = 0; b < spec.bins; b += 1) {
      const re = spec.real[f * spec.bins + b]
      const im = spec.imag[f * spec.bins + b]
      average[b] += Math.sqrt(re * re + im * im)
    }
  }
  const binHz = rate / size
  const strength = (hz: number) => {
    const bin = Math.round(hz / binHz)
    let peak = 0
    for (let b = bin - 1; b <= bin + 1; b += 1) peak = Math.max(peak, average[b] ?? 0)
    const around: number[] = []
    for (let b = bin - 12; b <= bin + 12; b += 1) if (Math.abs(b - bin) > 3 && average[b]) around.push(average[b])
    around.sort((a, b) => a - b)
    const floor = around[Math.floor(around.length / 2)] || 1e-12
    return 20 * Math.log10(peak / floor)
  }
  for (const hz of [50, 60] as const) {
    if (strength(hz) > 12 && strength(hz * 2) > 6) return hz
  }
  return null
}

export function measureTakes(noise: Float32Array, speech: Float32Array, rate: number): MicMeasurement {
  // The first quarter second of a take often carries the click of the start.
  const skip = Math.round(rate * 0.25)
  const quiet = noise.subarray(Math.min(skip, noise.length))
  const noiseLevels = frameLevels(quiet, rate)
  // The median frame: a single cough in the silent take does not set the floor.
  const noiseFloorDb = percentile(noiseLevels, 0.5)

  const speechLevels = frameLevels(speech.subarray(Math.min(skip, speech.length)), rate)
  const loudest = percentile(speechLevels, 0.98)
  const threshold = Math.max(noiseFloorDb + 10, loudest - 30)
  const active = speechLevels.filter((level) => level > threshold)
  const speechDb = active.length
    ? toDb(active.reduce((sum, level) => sum + 10 ** (level / 10), 0) / active.length)
    : -200

  let peak = 0
  let clipped = 0
  for (let i = 0; i < speech.length; i += 1) {
    const value = Math.abs(speech[i])
    if (value > peak) peak = value
    if (value >= 0.9886) clipped += 1
  }

  return {
    noiseFloorDb,
    speechDb,
    peakDb: 20 * Math.log10(Math.max(peak, 1e-10)),
    clipped,
    snrDb: speechDb - noiseFloorDb,
    humHz: detectHum(quiet, rate),
  }
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                     */
/* -------------------------------------------------------------------------- */

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** RBJ cookbook high-pass. */
function highpass(rate: number, hz: number, q: number): Biquad {
  const w = (2 * Math.PI * hz) / rate
  const alpha = Math.sin(w) / (2 * q)
  const cos = Math.cos(w)
  const a0 = 1 + alpha
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  }
}

/** RBJ cookbook notch. */
function notch(rate: number, hz: number, q: number): Biquad {
  const w = (2 * Math.PI * hz) / rate
  const alpha = Math.sin(w) / (2 * q)
  const cos = Math.cos(w)
  const a0 = 1 + alpha
  return { b0: 1 / a0, b1: (-2 * cos) / a0, b2: 1 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 }
}

function runBiquad(input: Float32Array, f: Biquad): Samples {
  const out = new Float32Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i += 1) {
    const x = input[i]
    const y = f.b0 * x + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    out[i] = y
  }
  return out
}

/** Fourth-order Butterworth high-pass as two biquads: 24 dB per octave. */
function highpass24(input: Float32Array, rate: number, hz: number): Samples {
  return runBiquad(runBiquad(input, highpass(rate, hz, 0.5412)), highpass(rate, hz, 1.3066))
}

/* -------------------------------------------------------------------------- */
/* Spectral noise reduction                                                    */
/* -------------------------------------------------------------------------- */

const NR_FFT = 2048
const NR_HOP = 512

/** Average magnitude per bin of the silent take. */
export function noiseProfile(noise: Float32Array): Float32Array {
  const spec = stft(noise, NR_FFT, NR_HOP)
  const profile = new Float32Array(spec.bins)
  // The quietest two thirds of the frames: a stray click must not end up in
  // the profile and get subtracted from every word afterwards.
  const energies: { f: number; e: number }[] = []
  for (let f = 0; f < spec.frames; f += 1) {
    let e = 0
    for (let b = 0; b < spec.bins; b += 1) {
      const re = spec.real[f * spec.bins + b]
      const im = spec.imag[f * spec.bins + b]
      e += re * re + im * im
    }
    energies.push({ f, e })
  }
  energies.sort((a, b) => a.e - b.e)
  const keep = energies.slice(0, Math.max(1, Math.round(energies.length * 0.66)))
  for (const { f } of keep) {
    for (let b = 0; b < spec.bins; b += 1) {
      const re = spec.real[f * spec.bins + b]
      const im = spec.imag[f * spec.bins + b]
      profile[b] += Math.sqrt(re * re + im * im)
    }
  }
  for (let b = 0; b < spec.bins; b += 1) profile[b] /= keep.length
  return profile
}

/**
 * Spectral subtraction with a gain floor and smoothing.
 *
 * Each bin keeps the share of its energy that is not explained by the noise
 * profile, never less than the floor. The gains are smoothed across
 * neighbouring bins and over time, which is what keeps the leftover from
 * turning into the chirping "musical noise" of a naive subtraction.
 */
export function reduceNoise(input: Float32Array, profile: Float32Array, maxCutDb: number): Samples {
  const spec = stft(input, NR_FFT, NR_HOP)
  const floor = dbToGain(-maxCutDb)
  const oversubtract = 2
  const previous = new Float32Array(spec.bins).fill(1)
  const raw = new Float32Array(spec.bins)

  for (let f = 0; f < spec.frames; f += 1) {
    const offset = f * spec.bins
    for (let b = 0; b < spec.bins; b += 1) {
      const re = spec.real[offset + b]
      const im = spec.imag[offset + b]
      const magnitude = Math.sqrt(re * re + im * im) + 1e-12
      raw[b] = Math.max(floor, 1 - (oversubtract * profile[b]) / magnitude)
    }
    for (let b = 0; b < spec.bins; b += 1) {
      // Three bins wide in frequency, then quick to open and slower to close.
      const smooth = ((raw[b - 1] ?? raw[b]) + raw[b] + (raw[b + 1] ?? raw[b])) / 3
      const gain = smooth > previous[b] ? smooth : 0.6 * previous[b] + 0.4 * smooth
      previous[b] = gain
      spec.real[offset + b] *= gain
      spec.imag[offset + b] *= gain
    }
  }
  return istft(spec)
}

/* -------------------------------------------------------------------------- */
/* Dynamics                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A downward expander: below the threshold, pauses get quieter by up to
 * `rangeDb`. Holds open briefly after a word so endings are not clipped.
 */
function gate(input: Float32Array, rate: number, thresholdDb: number, rangeDb: number): { out: Samples; closedShare: number } {
  const out = new Float32Array(input.length)
  const attack = Math.exp(-1 / (rate * 0.002))
  const release = Math.exp(-1 / (rate * 0.12))
  const holdSamples = Math.round(rate * 0.08)
  const detector = Math.exp(-1 / (rate * 0.005))
  const threshold = dbToGain(thresholdDb)
  const floor = dbToGain(-rangeDb)
  let envelope = 0
  let gain = 1
  let hold = 0
  let closed = 0
  for (let i = 0; i < input.length; i += 1) {
    const level = Math.abs(input[i])
    envelope = level > envelope ? level : detector * envelope + (1 - detector) * level
    let target = 1
    if (envelope >= threshold) hold = holdSamples
    else if (hold > 0) hold -= 1
    else target = floor
    gain = target > gain ? attack * gain + (1 - attack) * target : release * gain + (1 - release) * target
    if (gain < 0.5) closed += 1
    out[i] = input[i] * gain
  }
  return { out, closedShare: input.length ? closed / input.length : 0 }
}

/** Feed-forward RMS compressor with a 6 dB soft knee. Reports its deepest cut. */
function compress(
  input: Float32Array,
  rate: number,
  thresholdDb: number,
  ratio: number,
  attackMs: number,
  releaseMs: number,
): { out: Samples; maxReductionDb: number } {
  const out = new Float32Array(input.length)
  const attack = Math.exp(-1 / (rate * attackMs * 0.001))
  const release = Math.exp(-1 / (rate * releaseMs * 0.001))
  const rms = Math.exp(-1 / (rate * 0.01))
  const knee = 6
  let power = 0
  let reduction = 0
  let maxReduction = 0
  for (let i = 0; i < input.length; i += 1) {
    power = rms * power + (1 - rms) * input[i] * input[i]
    const level = toDb(power)
    const over = level - thresholdDb
    let wanted = 0
    if (over > knee / 2) wanted = over * (1 - 1 / ratio)
    else if (over > -knee / 2) wanted = ((over + knee / 2) ** 2 / (2 * knee)) * (1 - 1 / ratio)
    reduction = wanted > reduction ? attack * reduction + (1 - attack) * wanted : release * reduction + (1 - release) * wanted
    if (reduction > maxReduction) maxReduction = reduction
    out[i] = input[i] * dbToGain(-reduction)
  }
  return { out, maxReductionDb: maxReduction }
}

/* -------------------------------------------------------------------------- */
/* The chain                                                                   */
/* -------------------------------------------------------------------------- */

export interface ChainStep {
  title: string
  detail: string
}

export interface ChainSettings {
  profile: PurposeProfile
  measurement: MicMeasurement
  noise: Float32Array
}

/**
 * Everything except the final loudness move, identical for every take it is
 * run on — so the silent take can go through it too and show what is left of
 * the room afterwards.
 */
function cleanChain(
  input: Float32Array,
  rate: number,
  { profile, measurement, noise }: ChainSettings,
  noiseSpectrum: Float32Array,
  steps: ChainStep[] | null,
  gateThresholdDb: number | null,
): { out: Samples; compressorCutDb: number; closedShare: number } {
  let signal: Samples = new Float32Array(input)

  if (profile.highpassHz) {
    signal = highpass24(signal, rate, profile.highpassHz)
    steps?.push({
      title: `Tiefen unter ${profile.highpassHz} Hz entfernt`,
      detail: `Hochpass mit 24 dB pro Oktave: Trittschall, Tischklopfen, Luftzug und Rumpeln, die ${
        profile.id === 'instrument' ? 'das Instrument' : 'die Stimme'
      } nicht braucht.`,
    })
  }

  if (measurement.humHz) {
    const hz = measurement.humHz
    for (const harmonic of [hz, hz * 2, hz * 3]) signal = runBiquad(signal, notch(rate, harmonic, 30))
    steps?.push({
      title: `Netzbrummen bei ${hz} Hz entfernt`,
      detail: `In der Ruhe-Aufnahme stand ein schmaler Ton bei ${hz} und ${hz * 2} Hz — typisch für Strom, der ins Kabel streut. Drei schmale Kerbfilter bei ${hz}, ${hz * 2} und ${hz * 3} Hz nehmen ihn heraus, der Rest bleibt unberührt.`,
    })
  }

  if (profile.noiseReductionDb > 0) {
    signal = reduceNoise(signal, noiseSpectrum, profile.noiseReductionDb)
    steps?.push({
      title: `Hintergrundrauschen um bis zu ${profile.noiseReductionDb} dB gesenkt`,
      detail: `Spektral, anhand der ${fmtAbs(noise.length / rate)} Sekunden Ruhe: was dort zu hören war — Lüfter, Rauschen, Raum —, wird in jedem Frequenzband so weit abgezogen, wie es die Stimme nicht übertönt. Behutsam geglättet, damit kein Zirpen zurückbleibt.`,
    })
  }

  let closedShare = 0
  if (profile.gateRangeDb > 0 && gateThresholdDb !== null) {
    const gated = gate(signal, rate, gateThresholdDb, profile.gateRangeDb)
    signal = gated.out
    closedShare = gated.closedShare
    steps?.push({
      title: `Pausen um weitere ${profile.gateRangeDb} dB leiser`,
      detail: `Gate mit Schwelle ${fmtAbs(gateThresholdDb)} dBFS: öffnet in 2 ms, wenn Sie sprechen, bleibt 80 ms offen und schliesst dann weich — Atmer und Wortenden bleiben erhalten.`,
    })
  }

  let compressorCutDb = 0
  if (profile.compressor) {
    const { ratio, belowSpeechDb, attackMs, releaseMs } = profile.compressor
    const threshold = measurement.speechDb - belowSpeechDb
    const compressed = compress(signal, rate, threshold, ratio, attackMs, releaseMs)
    signal = compressed.out
    compressorCutDb = compressed.maxReductionDb
    steps?.push({
      title: `Kompressor ${ratio}:1 ab ${fmtAbs(threshold)} dBFS`,
      detail: `Laute Stellen werden um bis zu ${fmtAbs(compressed.maxReductionDb)} dB zurückgenommen, sodass leise und laute Passagen näher beieinander liegen (Ansprechzeit ${attackMs} ms, Rückstellzeit ${releaseMs} ms).`,
    })
  }

  return { out: signal, compressorCutDb, closedShare }
}

export interface CalibrationResult {
  processed: AudioData
  raw: AudioData
  steps: ChainStep[]
  before: MicMeasurement
  /** The same measurement on the processed takes. */
  after: { noiseFloorDb: number; speechDb: number; snrDb: number; lufs: number; truePeakDbtp: number }
  advice: { tone: 'info' | 'warn'; title: string; text: string }[]
  /** Re-usable on any other recording from the same microphone and room. */
  apply: (audio: AudioData) => AudioData
}

export function calibrate(noise: Float32Array, speech: Float32Array, rate: number, purpose: MicPurpose): CalibrationResult {
  const profile = profileFor(purpose)
  const before = measureTakes(noise, speech, rate)
  if (before.speechDb < -70) {
    throw new Error('In der zweiten Aufnahme war nichts zu hören. Ist das richtige Mikrofon gewählt und nicht stummgeschaltet?')
  }
  const settings: ChainSettings = { profile, measurement: before, noise }
  const spectrum = noiseProfile(noise)

  // Where the gate opens: a little above what is left of the room once the
  // noise reduction has done its part, and well below the voice.
  const noiseCleaned = cleanChain(noise, rate, settings, spectrum, null, null)
  const residualFloor = percentile(frameLevels(noiseCleaned.out.subarray(Math.round(rate * 0.25)), rate), 0.9)
  const gateThresholdDb = Math.min(residualFloor + 8, before.speechDb - 18)

  const steps: ChainStep[] = []
  const speechClean = cleanChain(speech, rate, settings, spectrum, steps, gateThresholdDb)
  const noiseAfterChain = cleanChain(noise, rate, settings, spectrum, null, gateThresholdDb)

  // Loudness last, one gain for both takes so the comparison stays honest.
  const cleanAudio: AudioData = { channels: [speechClean.out], sampleRate: rate }
  const report = measureLoudness(cleanAudio)
  const { audio: normalized, plan } = applyNormalization(cleanAudio, report, {
    mode: 'lufs',
    targetLufs: profile.targetLufs,
    targetPeakDbfs: -1,
    truePeakCeilingDbtp: profile.ceilingDbtp,
    preventClipping: true,
    useLimiter: true,
  })
  const loudnessGain = dbToGain(plan.appliedDb)
  const noiseOut = noiseAfterChain.out.map((value) => value * loudnessGain)
  const speechOut = normalized.channels[0]
  const afterMeasure = measureTakes(noiseOut, speechOut, rate)
  const afterLoudness = measureLoudness(normalized)

  // The step reports what came out, measured — not what was aimed for. The
  // limiter can leave a short take a little under the target.
  const short = profile.targetLufs - afterLoudness.integratedLufs
  steps.push({
    title: `Auf ${fmtAbs(afterLoudness.integratedLufs)} LUFS gebracht`,
    detail: `Lautheit nach EBU R128 von ${fmtAbs(report.integratedLufs)} LUFS angehoben (${fmt(plan.appliedDb)} dB), Ziel ${fmtAbs(
      profile.targetLufs,
    )} LUFS, Spitzen unter ${fmtAbs(profile.ceilingDbtp)} dBTP.${
      plan.limiterEngaged
        ? short > 0.5
          ? ` Der Begrenzer hat einzelne Spitzen weich zurückgenommen, deshalb liegt das Ergebnis ${fmtAbs(short)} dB unter dem Ziel.`
          : ' Einzelne Spitzen hat der Begrenzer weich zurückgenommen.'
        : ''
    }`,
  })

  const advice: CalibrationResult['advice'] = []
  if (before.clipped > 0 || before.peakDb > -0.5) {
    advice.push({
      tone: 'warn',
      title: 'Übersteuert',
      text: `${before.clipped} Abtastwerte lagen am Anschlag. Das lässt sich nachträglich nicht reparieren: den Eingangspegel am Mikrofon oder in Windows (Einstellungen → System → Sound → Eingabe → Lautstärke) etwas senken und neu kalibrieren.`,
    })
  } else if (before.speechDb < -38) {
    advice.push({
      tone: 'warn',
      title: 'Sehr leise aufgenommen',
      text: `Die Stimme lag bei ${fmtAbs(before.speechDb)} dBFS. Nachträglich lauter machen hebt das Rauschen mit an — besser den Eingangspegel erhöhen (Windows: Einstellungen → System → Sound → Eingabe) oder näher ans Mikrofon.`,
    })
  } else if (before.peakDb < -12) {
    advice.push({
      tone: 'info',
      title: 'Etwas Luft nach oben',
      text: `Die lautesten Stellen lagen bei ${fmtAbs(before.peakDb)} dBFS. Ein paar dB mehr Eingangspegel verbessern den Abstand zum Rauschen, ohne zu übersteuern.`,
    })
  }
  if (before.snrDb < 20) {
    advice.push({
      tone: 'warn',
      title: 'Der Raum ist laut',
      text: `Nur ${fmtAbs(before.snrDb)} dB zwischen Stimme und Hintergrund. Die Filter holen viel heraus, aber näher ans Mikrofon, Fenster zu und Lüfter weg bringen mehr als jeder Filter.`,
    })
  } else if (before.snrDb >= 45) {
    advice.push({
      tone: 'info',
      title: 'Sehr ruhige Umgebung',
      text: `${fmtAbs(before.snrDb)} dB Abstand zwischen Stimme und Hintergrund — da mussten die Filter kaum eingreifen.`,
    })
  }

  // The noise profile belongs to the calibration's sample rate, so another
  // recording is brought to that rate first.
  const apply = (input: AudioData): AudioData => {
    const audio = input.sampleRate === rate ? input : resampleAudio(input, rate)
    const channels = audio.channels.map(
      (channel) => cleanChain(channel, rate, settings, spectrum, null, gateThresholdDb).out,
    )
    const cleaned: AudioData = { channels, sampleRate: rate }
    return applyNormalization(cleaned, measureLoudness(cleaned), {
      mode: 'lufs',
      targetLufs: profile.targetLufs,
      targetPeakDbfs: -1,
      truePeakCeilingDbtp: profile.ceilingDbtp,
      preventClipping: true,
      useLimiter: true,
    }).audio
  }

  return {
    processed: { channels: [speechOut], sampleRate: rate },
    raw: { channels: [new Float32Array(speech)], sampleRate: rate },
    steps,
    before,
    after: {
      noiseFloorDb: afterMeasure.noiseFloorDb,
      speechDb: afterMeasure.speechDb,
      snrDb: afterMeasure.speechDb - afterMeasure.noiseFloorDb,
      lufs: afterLoudness.integratedLufs,
      truePeakDbtp: afterLoudness.truePeakDbtp,
    },
    advice,
    apply,
  }
}
