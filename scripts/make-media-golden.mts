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
import { mixWithDucking, DEFAULT_DUCK } from '../src/lib/duck'
import { applyNormalization, DEFAULT_NORMALIZATION, measureLoudness } from '../src/lib/loudness'
import { istft, magnitudeOf, stft } from '../src/lib/fft'
import { detectAutoChop16, detectOnsets } from '../src/lib/onsets'
import { beatGrid, estimateTempo, snapToZeroCrossing } from '../src/lib/tempo'
import { chromagram, estimateTuning } from '../src/lib/chroma'
import { decodePrint, encodePrint, fingerprint, locate, longestShared, PRINT_FPS, PRINT_RATE, slice } from '../src/lib/introPrint'
import { estimateChords, estimateKey } from '../src/lib/key'
import { chordsToMidiNotes, writeMidi } from '../src/lib/midi'
import { DEFAULT_SEGMENTATION, midiName, segmentNotes, trackPitch } from '../src/lib/pitch'

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

/* -- Harmonie: Tonart, Akkorde, Tonhöhe, Noten, MIDI-Datei -------------------------------------- */

{
  const sr = 44100
  const midiToHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
  function tone(target: Float32Array, midi: number, from: number, to: number, level = 0.3) {
    const hz = midiToHz(midi)
    for (let i = from; i < to && i < target.length; i += 1) {
      const t = i / sr
      const fade = Math.min(1, Math.min(i - from, to - i) / (0.01 * sr))
      target[i] += level * fade * (Math.sin(2 * Math.PI * hz * t) + 0.4 * Math.sin(4 * Math.PI * hz * t) + 0.2 * Math.sin(6 * Math.PI * hz * t))
    }
  }
  function progression(tonic: number, mode: 'dur' | 'moll', seconds = 8) {
    const frames = sr * seconds
    const channel = new Float32Array(frames)
    const degrees = mode === 'dur' ? [0, 7, 9, 5] : [0, 8, 3, 10]
    const perChord = Math.floor(frames / degrees.length)
    degrees.forEach((degree, index) => {
      const from = index * perChord
      const to = from + perChord
      const root = 48 + ((tonic + degree) % 12)
      const quality = mode === 'dur' ? (index === 2 ? 3 : 4) : index === 0 ? 3 : 4
      tone(channel, root, from, to, 0.25)
      tone(channel, root + quality, from, to, 0.2)
      tone(channel, root + 7, from, to, 0.2)
      tone(channel, root + 12, from, to, 0.15)
    })
    return { channels: [channel], sampleRate: sr }
  }
  const round3 = (x: number) => Math.round(x * 1e6) / 1e6
  const keyOf = (name: string, audio: { channels: Float32Array[]; sampleRate: number }) => {
    const chroma = chromagram(audio)
    const k = estimateKey(chroma)
    return {
      name,
      tuning: name === 'C-Dur' ? estimateTuning(audio) : null,
      average: Array.from(chroma.average).map(round3),
      bass: Array.from(chroma.bass).map(round3),
      head: Array.from(chroma.head).map(round3),
      tail: Array.from(chroma.tail).map(round3),
      key: { tonic: k.tonic, mode: k.mode, label: k.label, camelot: k.camelot, confidence: round3(k.confidence), alternative: k.alternative, scores: k.scores.map((e) => ({ ...e, score: round3(e.score) })) },
      chords: estimateChords(chroma, 0.5).map((c) => ({ ...c, startSeconds: round3(c.startSeconds), endSeconds: round3(c.endSeconds) })),
    }
  }
  const keys = [
    keyOf('C-Dur', progression(0, 'dur')),
    keyOf('G-Dur', progression(7, 'dur')),
    keyOf('A-Moll', progression(9, 'moll')),
    keyOf('D-Moll', progression(2, 'moll')),
  ]
  const solo = new Float32Array(sr * 4)
  ;[60, 62, 64, 65, 67, 69, 71, 72].forEach((midi, index) => {
    const from = Math.round(index * 0.5 * sr)
    tone(solo, midi, from, from + Math.round(0.45 * sr), 0.4)
  })
  const soloChords = estimateChords(chromagram({ channels: [solo], sampleRate: sr }), 0.5)
  const withMelody = progression(0, 'dur')
  ;[72, 76, 74, 72, 71, 67, 69, 72, 74, 72, 71, 69, 67, 65, 64, 60].forEach((midi, index) => {
    const from = Math.round(index * 0.5 * sr)
    tone(withMelody.channels[0], midi, from, from + Math.round(0.45 * sr), 0.34)
  })
  const mixedChords = estimateChords(chromagram(withMelody), 0.5)

  const scale = [60, 62, 64, 65, 67, 69, 71, 72]
  const melody = new Float32Array(sr * 4)
  scale.forEach((midi, index) => {
    const from = Math.round(index * 0.4 * sr)
    tone(melody, midi, from, from + Math.round(0.35 * sr), 0.4)
  })
  const melodyAudio = { channels: [melody], sampleRate: sr }
  const frames = trackPitch(melodyAudio)
  const notes = segmentNotes(melodyAudio, frames, { ...DEFAULT_SEGMENTATION, minimumSeconds: 0.12 })
  const quantized = segmentNotes(melodyAudio, frames, { ...DEFAULT_SEGMENTATION, minimumSeconds: 0.12, quantizeSeconds: 0.125 })
  const pitchSample = [0, 10, 25, 40, 55, 100, 200, 300].filter((i) => i < frames.length).map((i) => ({ i, ...frames[i], hz: round3(frames[i].hz), clarity: round3(frames[i].clarity), timeSeconds: round3(frames[i].timeSeconds) }))
  const octaves = [40, 45, 52].map((midi) => {
    const n = sr * 1.5
    const channel = new Float32Array(n)
    const hz = midiToHz(midi)
    for (let i = 0; i < n; i += 1) {
      const t = i / sr
      const fade = Math.min(1, Math.min(i, n - i) / (0.02 * sr))
      channel[i] = 0.3 * fade * (Math.sin(2 * Math.PI * hz * t) + Math.sin(4 * Math.PI * hz * t) + 0.6 * Math.sin(6 * Math.PI * hz * t) + 0.4 * Math.sin(8 * Math.PI * hz * t))
    }
    const clip = { channels: [channel], sampleRate: sr }
    const found = segmentNotes(clip, trackPitch(clip), { ...DEFAULT_SEGMENTATION, minimumSeconds: 0.2 })
    return { midi, got: found[0]?.midi ?? 0, name: found[0] ? midiName(found[0].midi) : '' }
  })
  const midi = Array.from(writeMidi(notes, { bpm: 120, trackName: 'test' }))
  const midiNoName = Array.from(writeMidi(notes, { bpm: 0 }))
  const chordNotes = chordsToMidiNotes(keys[0].chords as never)
  writeFileSync(
    `${outDir}/harmony.json`,
    `${JSON.stringify(
      {
        keys,
        soloChords: soloChords.filter((c) => c.root !== null).length,
        mixedLabels: mixedChords.filter((c) => c.root !== null).map((c) => c.label),
        frameCount: frames.length,
        pitchSample,
        notes: notes.map((n) => ({ ...n, startSeconds: round3(n.startSeconds), endSeconds: round3(n.endSeconds) })),
        quantized: quantized.map((n) => ({ ...n, startSeconds: round3(n.startSeconds), endSeconds: round3(n.endSeconds) })),
        octaves,
        midi,
        midiNoName,
        chordNotes,
      },
      null,
      1,
    )}\n`,
  )
  console.log(`Harmonie: ${keys.map((k) => k.key.label).join(', ')} · ${notes.length} Noten · MIDI ${midi.length} Bytes`)
}

/* -- Vorspann am Ton: die Folgen aus verify-intro, mit denselben Zahlen ------------------------- */

{
  const RATE = PRINT_RATE
  const seconds = (n: number) => Math.round(n * RATE)
  function random(seed: number) {
    let state = seed >>> 0 || 1
    return () => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return (state >>> 0) / 4294967296
    }
  }
  function music(length: number, seed: number, gain = 0.3): Float32Array {
    const rand = random(seed)
    const out = new Float32Array(seconds(length))
    let at = 0
    while (at < out.length) {
      const span = seconds(0.25 + rand() * 0.25)
      const root = 110 * 2 ** (Math.floor(rand() * 24) / 12)
      const notes = [root, root * 1.26, root * 1.5, root * 2]
      for (let i = 0; i < span && at + i < out.length; i += 1) {
        const t = i / RATE
        let v = 0
        for (const f of notes) v += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)
        const beat = i < seconds(0.03) ? (rand() * 2 - 1) * 1.5 : 0
        out[at + i] = gain * (v / 6 + beat) * Math.exp(-t * 2)
      }
      at += span
    }
    return out
  }
  function talk(length: number, seed: number, gain = 0.25): Float32Array {
    const rand = random(seed)
    const out = new Float32Array(seconds(length))
    let last = 0
    for (let i = 0; i < out.length; i += 1) {
      const syllable = Math.max(0, Math.sin((2 * Math.PI * i) / seconds(0.21 + ((i / seconds(1.3)) % 1) * 0.1)))
      last = 0.85 * last + 0.15 * (rand() * 2 - 1)
      out[i] = gain * last * syllable * 3
    }
    return out
  }
  const join = (...parts: Float32Array[]) => {
    const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
    let at = 0
    for (const part of parts) {
      out.set(part, at)
      at += part.length
    }
    return out
  }
  const mix = (a: Float32Array, b: Float32Array, gainB = 1) => {
    const out = Float32Array.from(a)
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) out[i] += b[i] * gainB
    return out
  }
  const noisy = (signal: Float32Array, level: number, seed: number, gain = 1) => {
    const rand = random(seed)
    return signal.map((v) => v * gain + (rand() * 2 - 1) * level)
  }
  const silence = (length: number) => new Float32Array(seconds(length))
  const head = (signal: Float32Array) => signal.subarray(0, seconds(480))
  const opening = music(89, 7)
  const bgm = music(60, 99, 0.12)
  const episodes = {
    a: join(talk(37.37, 2), opening, mix(talk(400, 3), bgm, 1)),
    b: noisy(join(silence(0.4), opening, mix(talk(400, 4), bgm, 1)), 0.01, 5, 0.6),
    c: noisy(join(talk(123.45, 6), opening, talk(300, 8)), 0.02, 9, 0.8),
    d: join(talk(200, 10), music(200, 11)),
  }
  const a = fingerprint(head(episodes.a))
  const b = fingerprint(head(episodes.b))
  const shared = longestShared(a, b)!
  const kept = slice(a, shared.a, shared.frames)
  const text = encodePrint(kept)
  const c = fingerprint(head(episodes.c))
  const d = fingerprint(head(episodes.d))
  const found = locate(decodePrint(text)!, c)
  const silentE = fingerprint(head(join(silence(30), talk(300, 20))))
  const silentF = fingerprint(head(join(silence(30), talk(300, 21))))
  // The way the player hears it: 16-bit, as FFmpeg decodes it.
  const pcm = (signal: Float32Array) => Int16Array.from(head(signal), (v) => Math.max(-32767, Math.min(32767, Math.round(v * 32767))))
  const learnedShared = longestShared(fingerprint(pcm(episodes.a)), fingerprint(pcm(episodes.b)))
  const picks = [0, 1, 2, 100, 500, 1000, 2000, 3000, 4000, 4700]
  writeFileSync(
    `${outDir}/intro.json`,
    `${JSON.stringify(
      {
        frames: a.bits.length,
        words: picks.map((i) => ({ i, bits: a.bits[i], quiet: a.quiet[i] })),
        quietCount: a.quiet.reduce((n, q) => n + q, 0),
        shared,
        text,
        found,
        foundInD: locate(decodePrint(text)!, d),
        silentShared: longestShared(silentE, silentF),
        learnedShared,
        fps: PRINT_FPS,
      },
      null,
      1,
    )}\n`,
  )
  console.log(`Vorspann: ${shared.frames / PRINT_FPS} s bei ${shared.a / PRINT_FPS} / ${shared.b / PRINT_FPS}, wiedergefunden bei ${found?.at}`)
}


/* -- Mischen: die Musik tritt zurück, wenn jemand spricht ----------------------------------------- */

{
  const sr = 8000
  // Speech-like bursts with a faint floor between them, from an integer generator.
  function voiceOf(seconds: number): Float32Array {
    const out = new Float32Array(sr * seconds)
    let state = 4242
    for (let i = 0; i < out.length; i += 1) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0
      const noise = ((state >>> 8) / 2 ** 24) * 2 - 1
      const t = i / sr
      const talking = (t % 1.7) < 0.9 || (t > 4.5 && t < 5.2)
      out[i] = 0.004 * noise + (talking ? 0.35 * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) : 0)
    }
    return out
  }
  const music = (hz: number, seconds: number) => {
    const out = new Float32Array(sr * seconds)
    for (let i = 0; i < out.length; i += 1) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / sr) + 0.3 * Math.sin((2 * Math.PI * hz * 1.5 * i) / sr)
    return out
  }
  const cases = [
    { name: 'standard', settings: DEFAULT_DUCK, voice: { channels: [voiceOf(7)], sampleRate: sr }, music: { channels: [music(220, 3), music(224, 3)], sampleRate: sr } },
    { name: 'empfindlich', settings: { ...DEFAULT_DUCK, sensitivity: 0.9, duckDb: 18, attackMs: 60, releaseMs: 900 }, voice: { channels: [voiceOf(7)], sampleRate: sr }, music: { channels: [music(330, 9)], sampleRate: sr } },
    { name: 'ohne-anlauf', settings: { ...DEFAULT_DUCK, leadIn: 0, tail: 0, loopMusic: false, musicDb: 0 }, voice: { channels: [voiceOf(6), voiceOf(6)], sampleRate: sr }, music: { channels: [music(440, 4)], sampleRate: sr } },
    { name: 'laut', settings: { ...DEFAULT_DUCK, musicDb: 6, duckDb: 0, tail: 1.5 }, voice: { channels: [voiceOf(5)], sampleRate: sr }, music: { channels: [music(110, 5), music(112, 5)], sampleRate: sr } },
  ].map((c) => {
    const r = mixWithDucking(c.voice, c.music, c.settings)
    const every = (a: Float32Array | number[], n: number) => Array.from(a).filter((_, i) => i % n === 0)
    return {
      name: c.name,
      settings: c.settings,
      voice: { channels: c.voice.channels.length, frames: c.voice.channels[0].length },
      music: { channels: c.music.channels.length, frames: c.music.channels[0].length },
      report: r.report,
      frames: r.audio.channels[0].length,
      left: every(r.audio.channels[0], 211),
      right: every(r.audio.channels[1], 211),
      voiceDb: every(r.voiceDb, 7),
      musicGainDb: every(r.musicGainDb, 7),
      outFrames: r.musicGainDb.length,
    }
  })
  writeFileSync(`${outDir}/duck.json`, `${JSON.stringify({ rate: sr, cases }, null, 1)}\n`)
  console.log(`Mischen: ${cases.map((c) => `${c.name} ${c.report.speechSeconds.toFixed(2)} s Sprache`).join(', ')}`)
}
