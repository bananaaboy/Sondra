/**
 * Checks for key estimation and pitch tracking.
 *
 * The test material is synthesised from known notes, so a failure is a real
 * regression rather than a disagreement about what a recording is doing.
 *
 * Run with:  npm run verify:harmony
 */

import { chromagram } from '../src/lib/chroma.ts'
import { estimateChords, estimateKey } from '../src/lib/key.ts'
import { writeMidi } from '../src/lib/midi.ts'
import { DEFAULT_SEGMENTATION, midiName, segmentNotes, trackPitch } from '../src/lib/pitch.ts'

const sampleRate = 44100
let failures = 0

function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(40)} ${detail}`)
}

const midiToHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)

/** A tone with a few harmonics, so the chroma sees something instrument-like. */
function tone(target: Float32Array, midi: number, from: number, to: number, level = 0.3) {
  const hz = midiToHz(midi)
  for (let i = from; i < to && i < target.length; i += 1) {
    const t = i / sampleRate
    const fade = Math.min(1, Math.min(i - from, to - i) / (0.01 * sampleRate))
    target[i] +=
      level *
      fade *
      (Math.sin(2 * Math.PI * hz * t) + 0.4 * Math.sin(4 * Math.PI * hz * t) + 0.2 * Math.sin(6 * Math.PI * hz * t))
  }
}

/** A chord progression in a given key, as block chords. */
function progression(tonic: number, mode: 'dur' | 'moll', seconds = 8) {
  const frames = sampleRate * seconds
  const channel = new Float32Array(frames)
  // I–V–vi–IV in major, i–VI–III–VII in minor: the degrees that define a key.
  const degrees = mode === 'dur' ? [0, 7, 9, 5] : [0, 8, 3, 10]
  const third = mode === 'dur' ? 4 : 3
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
    void third
  })

  return { channels: [channel], sampleRate }
}

console.log('\nKey estimation')
for (const [tonic, mode, expected] of [
  // The label capitalises the mode as the noun it is ("C-Dur") since the
  // interface overhaul; these expectations had kept the old spelling.
  [0, 'dur', 'C-Dur'],
  [7, 'dur', 'G-Dur'],
  [9, 'moll', 'A-Moll'],
  [2, 'moll', 'D-Moll'],
] as const) {
  const estimate = estimateKey(chromagram(progression(tonic, mode)))
  const ok = estimate.label === expected
  check(`${expected}`, ok, `got ${estimate.label} (${estimate.camelot}), confidence ${estimate.confidence.toFixed(2)}`)
}

console.log('\nCamelot mapping')
const cMajor = estimateKey(chromagram(progression(0, 'dur')))
const aMinor = estimateKey(chromagram(progression(9, 'moll')))
check('C-dur is 8B', cMajor.camelot === '8B', cMajor.camelot)
check('A-moll is 8A (relative)', aMinor.camelot === '8A', aMinor.camelot)

console.log('\nChord labelling')
const chords = estimateChords(chromagram(progression(0, 'dur')), 0.5)
const labels = chords.map((span) => span.label).filter((label) => label !== '—')
check('C major progression names C', labels.includes('C'), labels.slice(0, 6).join(' → '))
check('and names the minor sixth', labels.some((label) => label === 'Am'), labels.join(' → '))

// A single melodic line has no harmony; labelling one chord per passing note
// looks confident and is nonsense.
const soloFrames = sampleRate * 4
const solo = new Float32Array(soloFrames)
;[60, 62, 64, 65, 67, 69, 71, 72].forEach((midi, index) => {
  const from = Math.round(index * 0.5 * sampleRate)
  tone(solo, midi, from, from + Math.round(0.45 * sampleRate), 0.4)
})
const soloChords = estimateChords(chromagram({ channels: [solo], sampleRate }), 0.5)
const named = soloChords.filter((span) => span.root !== null).length
check('a solo line reports no chords', named === 0, `${named} chords named`)

// The harder case: real material has a melody on top of the chords, and the
// melody is the loudest thing in it. The chords must still be found.
const withMelody = progression(0, 'dur')
;[72, 76, 74, 72, 71, 67, 69, 72, 74, 72, 71, 69, 67, 65, 64, 60].forEach((midi, index) => {
  const from = Math.round(index * 0.5 * sampleRate)
  tone(withMelody.channels[0], midi, from, from + Math.round(0.45 * sampleRate), 0.34)
})
const mixed = estimateChords(chromagram(withMelody), 0.5)
const mixedLabels = mixed.filter((span) => span.root !== null).map((span) => span.label)
check(
  'chords survive a melody on top',
  mixedLabels.length >= 3,
  mixedLabels.length ? mixedLabels.join(' → ') : 'none found',
)

console.log('\nPitch tracking')
// An ascending scale, one note every 0.4 s.
const scale = [60, 62, 64, 65, 67, 69, 71, 72]
const melodyFrames = sampleRate * 4
const melody = new Float32Array(melodyFrames)
scale.forEach((midi, index) => {
  const from = Math.round(index * 0.4 * sampleRate)
  tone(melody, midi, from, from + Math.round(0.35 * sampleRate), 0.4)
})
const audio = { channels: [melody], sampleRate }
const notes = segmentNotes(audio, trackPitch(audio), { ...DEFAULT_SEGMENTATION, minimumSeconds: 0.12 })
const detected = notes.map((note) => note.midi)
check('finds eight notes', notes.length === scale.length, `${notes.length}: ${detected.map(midiName).join(' ')}`)
check(
  'pitches are correct',
  scale.every((midi, index) => detected[index] === midi),
  detected.join(',') + ' vs ' + scale.join(','),
)
check(
  'timing is close',
  notes.every((note, index) => Math.abs(note.startSeconds - index * 0.4) < 0.05),
  notes.map((note) => note.startSeconds.toFixed(2)).join(' '),
)

console.log('\nOctave stability')
// A low note with strong harmonics is where autocorrelation trackers halve the
// frequency and report an octave too low.
for (const midi of [40, 45, 52]) {
  const frames = sampleRate * 1.5
  const channel = new Float32Array(frames)
  const hz = midiToHz(midi)
  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate
    const fade = Math.min(1, Math.min(i, frames - i) / (0.02 * sampleRate))
    // Deliberately harmonic-heavy: the second partial is as loud as the first.
    channel[i] =
      0.3 *
      fade *
      (Math.sin(2 * Math.PI * hz * t) +
        1.0 * Math.sin(4 * Math.PI * hz * t) +
        0.6 * Math.sin(6 * Math.PI * hz * t) +
        0.4 * Math.sin(8 * Math.PI * hz * t))
  }
  const clip = { channels: [channel], sampleRate }
  const found = segmentNotes(clip, trackPitch(clip), { ...DEFAULT_SEGMENTATION, minimumSeconds: 0.2 })
  const got = found[0]?.midi ?? 0
  check(`${midiName(midi)} with loud harmonics`, got === midi, `got ${got ? midiName(got) : 'nothing'}`)
}

console.log('\nMIDI file')
const midi = writeMidi(notes, { bpm: 120, trackName: 'test' })
const header = String.fromCharCode(...midi.subarray(0, 4))
const trackTag = String.fromCharCode(...midi.subarray(14, 18))
check('starts with MThd', header === 'MThd', header)
check('contains an MTrk chunk', trackTag === 'MTrk', trackTag)
check('ends with end-of-track', [...midi.subarray(-3)].join(',') === '255,47,0', [...midi.subarray(-3)].join(','))
check('one note-on per note', [...midi].filter((byte, i) => byte === 0x90 && i > 20).length >= notes.length, `${notes.length} notes`)

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
