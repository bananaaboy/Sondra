/**
 * Every converter format against the real FFmpeg core, in Node.
 *
 * The converter's argument lists are only as good as the WebAssembly build
 * that runs them, and that build has failures a native FFmpeg does not:
 * libopus takes the core down in stereo above complexity 4, VP9 never gets
 * past the first frame. Both shipped as menu entries that ended in „memory
 * access out of bounds". This runs each format, with the settings people
 * actually change, on inputs of the shapes people actually bring — and fails
 * if any of them does not produce a file.
 *
 * Each job runs in its own process, because a crash inside the core does not
 * throw: it takes the process with it, exactly as it takes a tab.
 *
 *   npm run verify:convert
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONVERT, OUTPUT_FORMATS, buildConvertArgs, type ConvertSettings } from '../src/lib/convert'
import { BUILT_IN_PRESETS, presetFor } from '../src/lib/convertPresets'

const CORE = path.resolve('node_modules/@ffmpeg/core/dist/umd')

/* -- one job, in a process of its own ------------------------------------- */

if (process.argv[2] === '--run') {
  const [dir, input, ...args] = process.argv.slice(3)
  // The UMD core believes it runs in a worker; a worker is what it gets told.
  const scope = globalThis as unknown as Record<string, unknown>
  scope.self = globalThis
  scope.location = { href: `file://${CORE}/` }
  const require = createRequire(import.meta.url)
  const createCore = require(path.join(CORE, 'ffmpeg-core.js'))
  const core = await createCore({
    locateFile: (file: string) => path.join(CORE, file),
    wasmBinary: fs.readFileSync(path.join(CORE, 'ffmpeg-core.wasm')),
    print: () => undefined,
    printErr: () => undefined,
  })
  if (input !== '-') core.FS.writeFile(input, fs.readFileSync(path.join(dir, input)))
  const code = core.exec(...args)
  const output = args[args.length - 1]
  let size = 0
  try {
    const data = core.FS.readFile(output) as Uint8Array
    fs.writeFileSync(path.join(dir, output), data)
    size = data.length
  } catch {
    /* nothing was written */
  }
  process.stdout.write(`${code} ${size}\n`)
  process.exit(0)
}

/* -- the matrix ----------------------------------------------------------- */

const script = fileURLToPath(import.meta.url)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sondra-convert-'))

function run(input: string, args: string[]): { ok: boolean; detail: string } {
  try {
    const line = execFileSync(process.execPath, [script, '--run', dir, input, ...args], {
      encoding: 'utf8',
      timeout: 240_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    const [code, size] = line.split(' ').map(Number)
    return { ok: code === 0 && size > 0, detail: `Code ${code}, ${size} Bytes` }
  } catch (failure) {
    const status = (failure as { status?: number }).status
    return { ok: false, detail: `abgestürzt (Prozess endete mit ${status ?? 'Signal'})` }
  }
}

const sine = (hz: number, rate: number, seconds: number) => `sine=frequency=${hz}:sample_rate=${rate}:duration=${seconds}`

// The shapes people bring: a phone video, a stereo song, a mono voice memo,
// and a film's surround track.
const INPUTS: { name: string; make: string[] }[] = [
  {
    name: 'film.mp4',
    make: ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3', '-f', 'lavfi', '-i', sine(440, 44100, 3), '-f', 'lavfi', '-i', sine(660, 44100, 3),
      '-filter_complex', '[1][2]amerge=inputs=2[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'medium', '-c:a', 'aac', '-ac', '2', 'film.mp4'],
  },
  {
    name: 'lied.wav',
    make: ['-f', 'lavfi', '-i', sine(330, 44100, 3), '-f', 'lavfi', '-i', sine(495, 44100, 3), '-filter_complex', '[0][1]amerge=inputs=2', 'lied.wav'],
  },
  { name: 'sprache.wav', make: ['-f', 'lavfi', '-i', sine(220, 22050, 3), 'sprache.wav'] },
  {
    name: 'raum.m4a',
    make: ['-f', 'lavfi', '-i', 'anoisesrc=duration=3:sample_rate=48000:amplitude=0.3', '-af', 'pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0', '-c:a', 'aac', 'raum.m4a'],
  },
]

const VARIANTS: [string, Partial<ConvertSettings>][] = [
  ['Standard', {}],
  ['Mono', { channels: 1 }],
  ['Ausschnitt', { trimStartSeconds: 0.5, trimEndSeconds: 2 }],
]

console.log(`Arbeitsordner ${dir}`)
for (const input of INPUTS) {
  const made = run('-', input.make)
  if (!made.ok) {
    console.error(`Eingabe ${input.name} liess sich nicht erzeugen: ${made.detail}`)
    process.exit(1)
  }
}

const failures: string[] = []
let count = 0
for (const input of INPUTS) {
  const video = input.name.endsWith('.mp4')
  for (const format of OUTPUT_FORMATS) {
    if (!video && format.kind !== 'audio') continue
    // Every format once; the settings that change the encoder's input on the
    // two everyday files.
    const variants = input.name === 'film.mp4' || input.name === 'lied.wav' ? VARIANTS : VARIANTS.slice(0, 1)
    for (const [label, patch] of variants) {
      const settings = { ...DEFAULT_CONVERT, ...patch, formatId: format.id }
      const output = `aus-${format.id}-${count}.${format.extension}`
      const result = run(input.name, buildConvertArgs(input.name, output, settings))
      count += 1
      const line = `${result.ok ? 'ok    ' : 'FEHLER'} ${input.name.padEnd(12)} → ${format.label.padEnd(12)} ${label.padEnd(11)} ${result.detail}`
      console.log(line)
      if (!result.ok) failures.push(line)
    }
  }
}

// The templates („Für WhatsApp“, „Instagram Reel“ …) exactly as a click sets them.
for (const input of INPUTS.filter((entry) => entry.name === 'film.mp4' || entry.name === 'lied.wav')) {
  const kind = input.name.endsWith('.mp4') ? 'video' : 'audio'
  for (const preset of BUILT_IN_PRESETS) {
    const patch = presetFor(preset, kind)
    if (!patch) continue
    const settings = { ...DEFAULT_CONVERT, ...patch }
    const format = OUTPUT_FORMATS.find((entry) => entry.id === settings.formatId)!
    const output = `vorlage-${preset.id}-${count}.${format.extension}`
    const result = run(input.name, buildConvertArgs(input.name, output, settings))
    count += 1
    const line = `${result.ok ? 'ok    ' : 'FEHLER'} ${input.name.padEnd(12)} → Vorlage ${preset.label.padEnd(17)} ${result.detail}`
    console.log(line)
    if (!result.ok) failures.push(line)
  }
}

fs.rmSync(dir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`\n${failures.length} von ${count} Umwandlungen ohne Datei:\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`\nAlle ${count} Umwandlungen haben eine Datei geliefert.`)
