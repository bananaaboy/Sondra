/**
 * Writes the table the native media core (`native/sondra-media`) is tested against: for a spread of
 * settings, the FFmpeg arguments the web app builds. The Rust side must produce the same, so a
 * change to `convert.ts` that is not carried over fails the check instead of a person's file.
 *
 *   npm run native:golden
 */
import { mkdirSync, writeFileSync } from 'node:fs'

import { buildConvertArgs, DEFAULT_CONVERT, OUTPUT_FORMATS, rateFor, findFormat, type ConvertSettings } from '../src/lib/convert'
import { BUILT_IN_PRESETS, presetFor } from '../src/lib/convertPresets'
import { applyNormalization, DEFAULT_NORMALIZATION, measureLoudness } from '../src/lib/loudness'
import { istft, magnitudeOf, stft } from '../src/lib/fft'
import { detectAutoChop16, detectOnsets } from '../src/lib/onsets'
import { beatGrid, estimateTempo, snapToZeroCrossing } from '../src/lib/tempo'

const outDir = 'native/sondra-media/tests/golden'
mkdirSync(outDir, { recursive: true })

const cases: { name: string; settings: ConvertSettings }[] = []
const add = (name: string, settings: Partial<ConvertSettings>) =>
  cases.push({ name, settings: { ...DEFAULT_CONVERT, ...settings } })

for (const format of OUTPUT_FORMATS) {
  add(`${format.id}: Vorgaben`, { formatId: format.id })
  add(`${format.id}: Mono, 44,1 kHz, 128 k, ohne VBR`, {
    formatId: format.id,
    channels: 1,
    sampleRate: 44100,
    audioBitrateKbps: 128,
    useVariableBitrate: false,
    audioQuality: 5,
  })
  add(`${format.id}: 96 kHz verlangt`, { formatId: format.id, sampleRate: 96000, wavBitDepth: 16 })
  add(`${format.id}: Ausschnitt und Bild`, {
    formatId: format.id,
    trimStartSeconds: 1.5,
    trimEndSeconds: 9.25,
    videoHeight: 720,
    frameRate: 30,
    videoCrf: 30,
    videoPreset: 'veryfast',
    wavBitDepth: 32,
  })
  add(`${format.id}: Hochformat`, { formatId: format.id, videoFrame: 'vertical', frameRate: 30 })
}
// Every template, for what it makes of a video and of a sound file.
for (const preset of BUILT_IN_PRESETS) {
  for (const kind of ['video', 'audio'] as const) {
    const set = presetFor(preset, kind)
    if (set) add(`Vorlage ${preset.id} (${kind})`, set)
  }
}

const rows = cases.map(({ name, settings }) => ({
  name,
  settings,
  input: 'eingang.mkv',
  output: `ausgang.${findFormat(settings.formatId).extension}`,
  args: buildConvertArgs('eingang.mkv', `ausgang.${findFormat(settings.formatId).extension}`, settings),
}))

const rates = OUTPUT_FORMATS.flatMap((format) =>
  ['source', 8000, 22050, 32000, 44100, 48000, 88200, 96000].map((wanted) => ({
    format: format.id,
    wanted,
    got: rateFor(format, wanted as number | 'source'),
  })),
)

const presets = BUILT_IN_PRESETS.map(({ id, label, hint, video, audio }) => ({ id, label, hint, video: video ?? null, audio: audio ?? null }))

writeFileSync(`${outDir}/convert-args.json`, `${JSON.stringify({ rows, rates, presets }, null, 1)}\n`)
console.log(`${rows.length} Befehle, ${rates.length} Abtastraten`)

/* -- Lautheit: dieselben Signale, die der Rust-Teil nach denselben Formeln erzeugt ---------------- */

const rate = 48000
const sine = (hz: number, peak: number, seconds: number) => {
  const out = new Float32Array(rate * seconds)
  for (let i = 0; i < out.length; i += 1) out[i] = peak * Math.sin((2 * Math.PI * hz * i) / rate)
  return out
}
const stereo = (c: Float32Array) => ({ channels: [c, new Float32Array(c)], sampleRate: rate })

// Noise with a slow swell, from an integer generator, so that both sides make the same samples.
function swell(seconds: number): Float32Array {
  const out = new Float32Array(rate * seconds)
  let state = 12345
  for (let i = 0; i < out.length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    const white = (state >>> 8) / 2 ** 24 * 2 - 1
    out[i] = 0.3 * (0.35 + 0.65 * Math.abs(Math.sin((2 * Math.PI * i) / (rate * 4)))) * white
  }
  return out
}

const padded = new Float32Array(rate * 24)
padded.set(sine(1000, 10 ** (-23 / 20), 8), 0)
const interSample = new Float32Array(rate)
for (let i = 0; i < interSample.length; i += 1) {
  const envelope = Math.min(1, Math.min(i, interSample.length - 1 - i) / 2000)
  interSample[i] = 0.5 * envelope * Math.sin((2 * Math.PI * 12000 * i) / rate + Math.PI / 4)
}
const music = { channels: [sine(220, 0.4, 6), sine(224, 0.4, 6)], sampleRate: rate }

const signals: { name: string; audio: { channels: Float32Array[]; sampleRate: number } }[] = [
  { name: 'stereo-1k-minus14', audio: stereo(sine(1000, 10 ** (-14 / 20), 8)) },
  { name: 'mono-1k-0', audio: { channels: [sine(1000, 1, 8)], sampleRate: rate } },
  { name: 'padded', audio: stereo(padded) },
  { name: 'inter-sample', audio: { channels: [interSample], sampleRate: rate } },
  { name: 'constant', audio: { channels: [new Float32Array(rate).fill(0.5)], sampleRate: rate } },
  { name: 'music', audio: music },
  { name: 'swell', audio: { channels: [swell(20)], sampleRate: rate } },
  { name: 'silence', audio: { channels: [new Float32Array(rate * 2)], sampleRate: rate } },
]
const finite = (x: number) => (Number.isFinite(x) ? x : null)
const loudness = signals.map(({ name, audio }) => {
  const r = measureLoudness(audio)
  return {
    name,
    report: {
      integratedLufs: finite(r.integratedLufs),
      loudnessRangeLu: finite(r.loudnessRangeLu),
      momentaryMaxLufs: finite(r.momentaryMaxLufs),
      shortTermMaxLufs: finite(r.shortTermMaxLufs),
      samplePeakDbfs: finite(r.samplePeakDbfs),
      truePeakDbtp: finite(r.truePeakDbtp),
      durationSeconds: r.durationSeconds,
    },
  }
})
const plans = [-23, -16, -9].flatMap((targetLufs) =>
  [false, true].map((useLimiter) => {
    const before = measureLoudness(music)
    const { audio, plan } = applyNormalization(music, before, { ...DEFAULT_NORMALIZATION, targetLufs, useLimiter })
    const after = measureLoudness(audio)
    return {
      targetLufs,
      useLimiter,
      requestedDb: plan.requestedDb,
      appliedDb: plan.appliedDb,
      reducedByCeiling: plan.reducedByCeiling,
      limiterEngaged: plan.limiterEngaged,
      predictedPeakDbtp: finite(plan.predictedPeakDbtp),
      afterIntegrated: finite(after.integratedLufs),
    }
  }),
)
writeFileSync(`${outDir}/loudness.json`, `${JSON.stringify({ loudness, plans }, null, 1)}\n`)
console.log(`${loudness.length} Signale, ${plans.length} Pläne`)

/* -- FFT: Kurzzeit-Spektrum desselben Rauschens, in Stichproben ---------------------------------- */

{
  const signal = swell(3)
  const spec = stft(signal, 2048, 512)
  const mag = magnitudeOf(spec)
  const picks = [0, 1, 7, 100, 513, 1024]
  const frames = [0, 1, 40, spec.frames - 1]
  const samples = frames.flatMap((f) =>
    picks.map((b) => ({ frame: f, bin: b, re: spec.real[f * spec.bins + b], im: spec.imag[f * spec.bins + b], mag: mag[f * spec.bins + b] })),
  )
  const back = istft(spec)
  let worst = 0
  for (let i = 0; i < signal.length; i += 1) worst = Math.max(worst, Math.abs(back[i] - signal[i]))
  writeFileSync(
    `${outDir}/fft.json`,
    `${JSON.stringify({ frames: spec.frames, bins: spec.bins, padding: spec.padding, length: spec.length, samples, roundTripWorst: worst, backFirst: Array.from(back.slice(0, 8)), backLast: Array.from(back.slice(-8)) }, null, 1)}\n`,
  )
  console.log(`FFT: ${spec.frames} Bilder, Hin-und-zurück ${worst.toExponential(2)}`)
}

/* -- Tempo und Einsätze: ein Schlagzeug-Muster ohne Zufall --------------------------------------- */

{
  const sr = 44100
  // Like the one in verify-tempo, but the hat noise comes from an integer generator.
  const drums = (bpm: number, seconds: number, offsetSeconds = 0) => {
    const frames = Math.round(sr * seconds)
    const channel = new Float32Array(frames)
    const beat = 60 / bpm
    let state = 987654321
    for (let i = 0; i < frames; i += 1) {
      const t = i / sr - offsetSeconds
      if (t < 0) continue
      const inBeat = t % beat
      const inEighth = t % (beat / 2)
      let value = 0
      if (inBeat < 0.05) value += 0.9 * Math.sin(2 * Math.PI * 60 * inBeat) * Math.exp(-inBeat * 60)
      if (inEighth < 0.02) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        value += 0.35 * ((state >>> 8) / 2 ** 24 * 2 - 1) * Math.exp(-inEighth * 220)
      }
      value += 0.05 * Math.sin(2 * Math.PI * 220 * t)
      channel[i] = value
    }
    return { channels: [channel, new Float32Array(channel)], sampleRate: sr }
  }
  const cases = [
    { name: 'drums-90', bpm: 90, seconds: 8, offset: 0 },
    { name: 'drums-120', bpm: 120, seconds: 8, offset: 0 },
    { name: 'drums-128-offset', bpm: 128, seconds: 8, offset: 0.25 },
    { name: 'drums-174', bpm: 174, seconds: 8, offset: 0 },
  ]
  const tempo = cases.map((c) => ({ ...c, estimate: estimateTempo(drums(c.bpm, c.seconds, c.offset)) }))
  const held = new Float32Array(sr * 4)
  for (let i = 0; i < held.length; i += 1) held[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr)
  const heldEstimate = estimateTempo({ channels: [held], sampleRate: sr })
  const grids = [0.5, 1, 4].map((beats) => ({ beats, grid: beatGrid({ bpm: 120, offsetSeconds: 0.3, beatsPerSlice: beats, durationSeconds: 4 }) }))
  const sineWave = new Float32Array(sr)
  for (let i = 0; i < sineWave.length; i += 1) sineWave[i] = Math.sin((2 * Math.PI * 100 * i) / sr)
  const snaps = [0.1234, 0.777, 0.5].map((at) => ({ at, snapped: snapToZeroCrossing({ channels: [sineWave], sampleRate: sr }, at) }))
  const audio = drums(120, 4, 0)
  const onsets = detectOnsets(audio)
  const chop = detectAutoChop16(audio)
  writeFileSync(`${outDir}/tempo.json`, `${JSON.stringify({ tempo, held: heldEstimate, grids, snaps, onsets, chop }, null, 1)}\n`)
  console.log(`Tempo: ${tempo.map((t) => t.estimate.bpm).join(', ')} · ${onsets.length} Einsätze`)
}
