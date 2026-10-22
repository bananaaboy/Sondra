/**
 * Finding the opening by ear (src/lib/introPrint.ts), checked on episodes
 * made up here: an opening melody behind cold opens of different lengths,
 * at another loudness, with noise over it; episodes that only share their
 * silence; and a piece of background music that comes back under other
 * dialogue, which must not win over the opening.
 *
 *   npm run verify:intro
 *
 * With `--wav <dir>` it also writes the episodes as WAV files, for the
 * browser test to turn into videos.
 */

import fs from 'node:fs'
import path from 'node:path'

import { decodePrint, encodePrint, fingerprint, locate, longestShared, PRINT_FPS, PRINT_RATE, slice } from '../src/lib/introPrint'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FEHL'}  ${label}${detail ? `  (${detail})` : ''}`)
}

/** A seeded generator, so every run hears the same episodes. */
function random(seed: number) {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

const RATE = PRINT_RATE
const seconds = (s: number) => Math.round(s * RATE)

/** Music: chords that change every quarter to half second, with a beat. */
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

/** Dialogue-like sound: noise in bursts, shaped like syllables. */
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

function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
function mix(a: Float32Array, b: Float32Array, gainB = 1): Float32Array {
  const out = Float32Array.from(a)
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) out[i] += b[i] * gainB
  return out
}
function noisy(signal: Float32Array, level: number, seed: number, gain = 1): Float32Array {
  const rand = random(seed)
  return signal.map((v) => v * gain + (rand() * 2 - 1) * level)
}
const silence = (length: number) => new Float32Array(seconds(length))
/** The first eight minutes, as the player decodes them. */
const head = (signal: Float32Array) => signal.subarray(0, seconds(480))

const OPENING = 89
const opening = music(OPENING, 7)
const bgm = music(60, 99, 0.12)

const episodes = {
  // Cold open of 37.37 s, then the opening.
  a: join(talk(37.37, 2), opening, mix(talk(400, 3), bgm, 1)),
  // The opening almost at once, quieter, with noise.
  b: noisy(join(silence(0.4), opening, mix(talk(400, 4), bgm, 1)), 0.01, 5, 0.6),
  // A long cold open; the opening a little dull and with more noise.
  c: noisy(join(talk(123.45, 6), opening, talk(300, 8)), 0.02, 9, 0.8),
  // No opening at all.
  d: join(talk(200, 10), music(200, 11)),
}

{
  const a = fingerprint(head(episodes.a))
  const b = fingerprint(head(episodes.b))
  check('Zehn Frames je Sekunde', Math.abs(a.bits.length - 480 * PRINT_FPS) < 15, String(a.bits.length))
  const started = performance.now()
  const shared = longestShared(a, b)
  const ms = Math.round(performance.now() - started)
  check('Gemeinsamer Vorspann gefunden', shared !== null, `${ms} ms`)
  if (shared) {
    const startA = shared.a / PRINT_FPS
    const startB = shared.b / PRINT_FPS
    const length = shared.frames / PRINT_FPS
    check('… in Folge A bei 37,4 s', Math.abs(startA - 37.37) <= 1, startA.toFixed(1))
    check('… in Folge B bei 0,4 s', Math.abs(startB - 0.4) <= 1, startB.toFixed(1))
    check(`… ${OPENING} s lang, nicht die Hintergrundmusik`, Math.abs(length - OPENING) <= 1, length.toFixed(1))

    // Kept as text with the series, and found again in other episodes.
    const kept = slice(a, shared.a, shared.frames)
    const text = encodePrint(kept)
    const back = decodePrint(text)
    check('Als Text und zurück: gleich', back !== null && back.bits.every((word, i) => word === kept.bits[i]) && back.quiet.every((q, i) => q === kept.quiet[i]), `${text.length} Zeichen`)
    const c = fingerprint(head(episodes.c))
    const found = locate(back!, c)
    check('In Folge C wiedergefunden', found !== null, found ? `Treffer ${Math.round(found.score * 100)} %` : '')
    if (found) check('… bei 123,5 s', Math.abs(found.at / PRINT_FPS - 123.45) <= 1, (found.at / PRINT_FPS).toFixed(1))
    const d = fingerprint(head(episodes.d))
    check('Folge D ohne Vorspann: nichts gefunden', locate(back!, d) === null)
  }
}

{
  // Two episodes that share only silence and nothing else.
  const e = fingerprint(head(join(silence(30), talk(300, 20))))
  const f = fingerprint(head(join(silence(30), talk(300, 21))))
  check('Nur gleiche Stille: kein Vorspann', longestShared(e, f) === null)
  check('Digitale Stille zählt als leise', e.quiet.subarray(5, 290).every((q) => q === 1))
}

{
  const broken = decodePrint('nicht-base64!')
  check('Kaputter Text: null statt Fehler', broken === null)
}

const wavDir = process.argv.includes('--wav') ? process.argv[process.argv.indexOf('--wav') + 1] : null
if (wavDir) {
  fs.mkdirSync(wavDir, { recursive: true })
  const write = (name: string, signal: Float32Array) => {
    const data = Buffer.alloc(44 + signal.length * 2)
    data.write('RIFF', 0)
    data.writeUInt32LE(36 + signal.length * 2, 4)
    data.write('WAVEfmt ', 8)
    data.writeUInt32LE(16, 16)
    data.writeUInt16LE(1, 20)
    data.writeUInt16LE(1, 22)
    data.writeUInt32LE(RATE, 24)
    data.writeUInt32LE(RATE * 2, 28)
    data.writeUInt16LE(2, 32)
    data.writeUInt16LE(16, 34)
    data.write('data', 36)
    data.writeUInt32LE(signal.length * 2, 40)
    for (let i = 0; i < signal.length; i += 1) data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(signal[i] * 32767))), 44 + i * 2)
    fs.writeFileSync(path.join(wavDir, `${name}.wav`), data)
  }
  write('folge-a', episodes.a)
  write('folge-b', episodes.b)
  write('folge-c', episodes.c)
  console.log(`WAV-Dateien in ${wavDir}`)
}

console.log(failures === 0 ? '\nAlles in Ordnung.' : `\n${failures} Prüfung(en) fehlgeschlagen.`)
process.exit(failures === 0 ? 0 : 1)
