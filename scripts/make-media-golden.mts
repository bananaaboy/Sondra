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
