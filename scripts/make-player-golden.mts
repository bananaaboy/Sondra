/**
 * Writes the table the native player logic (`native/sondra-player`) is tested against: the rules of the
 * website's player (`src/lib/player.ts`) run on their own, case after case. The Rust side must give the
 * same, value for value.
 *
 *   npm run native:golden
 */
import { mkdirSync, writeFileSync } from 'node:fs'

// The player keeps its conveniences in `localStorage`; here that is a table in memory.
const data = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, v),
  removeItem: (k: string) => void data.delete(k),
  clear: () => data.clear(),
  key: () => null,
  length: 0,
} as Storage

const player = await import('../src/lib/player')
const {
  chaptersText, cleanMarks, clock, isSubtitleFile, markName, minutesSeconds, neighbourMark, nextOffered, openingOffered, playerKind,
  rateLabel, rememberPlace, rememberedPlace, rememberedSettings, sleepFade, srtToVtt, stemOf, withMark, DEFAULT_SETTINGS, EQ_PRESETS, RATES, SKIPS, BOOSTS, OPENINGS, SLEEPS, QUALITY_STEPS,
} = player

const outDir = 'native/sondra-player/tests/golden'
mkdirSync(outDir, { recursive: true })

const names = [
  ['film.mp4', 'video/mp4'], ['FILM.MKV', ''], ['lied.FLAC', ''], ['ohne', ''], ['x.srt', ''], ['x.vtt', 'text/vtt'], ['a.b.c.avi', 'application/octet-stream'],
  ['song', 'audio/mpeg'], ['clip', 'video/webm'], ['x.m2ts', ''], ['x.mka', ''], ['x.aif', ''], ['x.aiff', ''], ['x.ogv', ''], ['x.oga', ''], ['x.txt', 'text/plain'], ['', ''],
  ['x.mp4.txt', ''], ['x.MP3', ''], ['.mkv', ''], ['x.3gp', ''], ['x.amr', ''], ['x.caf', ''], ['x.vob', ''], ['x.wmv', ''], ['x.mp5', ''],
]
const srts = [
  '1\n00:00:01,000 --> 00:00:02,500\nHallo\n',
  '﻿1\r\n0:00:01,000 --> 0:00:02,500\r\nZeile\r\n\r\n2\r\n00:01:02,003 --> 01:01:02,999\r\nNoch eine\r\n',
  'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nschon fertig\n',
  '   \n\n  WEBVTT \n\nx',
  '',
  'nur Text, 1,234 und 12:34:56,789 mittendrin',
  '1\r00:00:01,000 --> 00:00:02,000\rMac\r',
]

const settingsCases: unknown[] = [
  null, 'text', 5, [], {}, { volume: 0.3 }, { volume: 7 }, { volume: -1 }, { volume: 'laut' }, { volume: null }, { muted: true }, { muted: 1 }, { rate: 1.5 }, { rate: 1.2 }, { rate: '2' }, { rate: 3 },
  { captionSize: 'gross' }, { captionSize: 'riesig' }, { captionBackground: false }, { captionBackground: 0 }, { fit: 'cover' }, { fit: 'stretch' }, { brightness: 0.2 }, { brightness: 1.7 }, { contrast: 1.2 }, { saturation: 2.5 }, { saturation: -3 },
  { mirror: true }, { boost: 2 }, { boost: 4 }, { night: true }, { bassBoost: 20 }, { bassBoost: 6 },
  { eqLow: 5, eqMid: -4, eqHigh: 20 }, { eqLow: 5 }, { eqBand1: 3, eqLow: 9 }, { eqBand1: null, eqLow: 9 }, { eqBand1: 'x', eqLow: 9 }, { eqBand2: -13 }, { eqBand3: 2, eqMid: 7 }, { eqMid: 7 }, { eqBand4: 1 }, { eqBand5: null, eqHigh: -6 },
  { eqEnabled: false }, { eqEnabled: 0 }, { eqPreset: 'rock' }, { eqPreset: 5 }, { karaoke: true }, { visualizer: false }, { visualizerMode: 'wave' }, { visualizerMode: 'dots' }, { autoNext: false }, { repeat: 'liste' }, { repeat: 'immer' },
  { skip: 30 }, { skip: 7 }, { merkliste: false }, { skipOpening: false }, { opening: 85 }, { opening: 95 }, { opening: '90' },
  { volume: 0.5, muted: true, rate: 2, captionSize: 'klein', fit: 'fill', boost: 1.5, repeat: 'titel', skip: 5, opening: 120, unknown: 'ignored', eqPreset: 'vocal' },
]
const settings = settingsCases.map((saved) => {
  data.clear()
  data.set('sondra:abspielen', JSON.stringify(saved))
  return { saved, result: rememberedSettings() }
})
// A text that is no JSON at all, and nothing saved.
data.clear()
data.set('sondra:abspielen', '{kaputt')
const brokenSettings = rememberedSettings()
data.clear()
const emptySettings = rememberedSettings()

// Where a file was left: the newest fifty stay.
data.clear()
const places: unknown[] = []
for (let i = 0; i < 60; i++) {
  rememberPlace({ name: `film ${i}.mkv`, size: 1000 + i }, 100.4 + i)
  places.push({ step: i, kept: rememberedPlace({ name: `film ${i}.mkv`, size: 1000 + i }), first: rememberedPlace({ name: 'film 0.mkv', size: 1000 }), tenth: rememberedPlace({ name: 'film 9.mkv', size: 1009 }), count: Object.keys(JSON.parse(data.get('sondra:abspielen:stellen') ?? '{}')).length })
}
rememberPlace({ name: 'film 30.mkv', size: 1030 }, 7.6)
rememberPlace({ name: 'film 31.mkv', size: 1031 }, null)
rememberPlace({ name: 'film 32.mkv', size: 1032 }, 0.4)
const placesEnd = {
  stored: JSON.parse(data.get('sondra:abspielen:stellen') ?? '{}'),
  thirty: rememberedPlace({ name: 'film 30.mkv', size: 1030 }),
  thirtyOne: rememberedPlace({ name: 'film 31.mkv', size: 1031 }),
  thirtyTwo: rememberedPlace({ name: 'film 32.mkv', size: 1032 }),
  nothing: rememberedPlace({ name: 'gibt es nicht', size: 1 }),
}
data.set('sondra:abspielen:stellen', JSON.stringify({ 'a|1': 'x', 'b|2': -3, 'c|3': 12 }))
const placesOdd = ['a|1', 'b|2', 'c|3', 'd|4'].map((k) => ({ key: k, seconds: rememberedPlace({ name: k.split('|')[0], size: Number(k.split('|')[1]) }) }))
data.set('sondra:abspielen:stellen', 'kein json')
const placesBroken = rememberedPlace({ name: 'a', size: 1 })

const rawMarks: unknown[] = [
  null, 'x', {}, [], [null], [{ at: 5 }], [{ at: 5, id: 'a', label: 'Anfang' }], [{ at: -1 }], [{ at: 'x' }], [{ at: Number.NaN }], [{ at: 3, id: 0 }], [{ at: 3, id: 7 }], [{ at: 3, id: '' }], [{ at: 3, id: true }], [{ at: 3.1234, id: null }],
  [{ at: 9, id: 'z' }, { at: 2, id: 'y' }, { at: 9, id: 'x2' }, { at: 2, id: 'y2' }], [{ at: 1, label: 5 }], [{ at: 1, label: 'x'.repeat(200) }], [5, 'a', { at: 4 }], [{ at: 0 }], [{ at: 1e9, id: 'big' }],
]
const marksClean = rawMarks.map((raw) => ({ raw, result: cleanMarks(raw) }))
const base = cleanMarks([{ at: 10, id: 'a', label: 'Vorspann' }, { at: 60, id: 'b', label: '' }, { at: 300, id: 'c', label: '  Abspann  ' }])
const realNow = Date.now
const realRandom = Math.random
Date.now = () => 1_700_000_000_000
Math.random = () => 0.5
const adds = [0, 10, 10.4, 10.9, 11.1, 59.6, 61, 299.5, 1000, -5, 12.34, 0.04, 3600.06].map((at) => ({ at, ...withMark(base, at) }))
Date.now = realNow
Math.random = realRandom
const neighbours = [0, 5, 10, 10.4, 12, 12.1, 61, 62.6, 300, 301, 1000].flatMap((time) => [1, -1].map((direction) => ({ time, direction, mark: neighbourMark(base, time, direction as 1 | -1) })))
const named = base.map((mark) => ({ id: mark.id, name: markName(base, mark) }))
const chapters = [[], base, [{ id: 'a', at: 0, label: '' }], [{ id: 'a', at: 0.5, label: 'Start' }], [{ id: 'a', at: 1, label: '' }], [{ id: 'a', at: 4000, label: 'Spät' }, { id: 'b', at: 5000, label: '' }]].map((marks) => ({ marks, text: chaptersText(marks as never) }))

const times = [0, 0.4, 1, 59.9, 60, 61, 90, 125.5, 359.9, 3599.4, 3600, 3661, 7325.9, 86400, -1, Number.NaN, Number.POSITIVE_INFINITY]
const clocks = times.map((t) => ({ t: Number.isNaN(t) ? 'NaN' : t === Infinity ? 'Infinity' : t, clock: clock(t), minutesSeconds: Number.isFinite(t) ? minutesSeconds(t) : null }))
const offers = { opening: [] as unknown[], next: [] as unknown[] }
for (const duration of [0, 100, 239.9, 240, 300, 1000, 1440, 2700, 7200, Number.NaN]) {
  for (const time of [-1, 0, 30, 79.9, 80, 100, 360, 600, duration / 3 - 1, duration - 61, duration - 150, duration - 151, duration - 180, duration - 0.5, duration - 0.4, duration]) {
    for (const opening of [60, 90, 150]) offers.opening.push({ time, duration, opening, offered: openingOffered(time, duration, opening) })
    offers.next.push({ time, duration, offered: nextOffered(time, duration) })
  }
}
const fades = [-5, 0, 1, 1000, 5000, 9999, 10_000, 10_001, 60_000].map((ms) => ({ ms, volume: sleepFade(ms) }))

const out = {
  constants: { RATES, SKIPS, BOOSTS, OPENINGS, SLEEPS, QUALITY_STEPS, EQ_PRESETS, DEFAULT_SETTINGS },
  kinds: names.map(([name, type]) => ({ name, type, kind: playerKind({ name, type }) ?? null, subtitle: isSubtitleFile({ name }), stem: stemOf(name) })),
  srt: srts.map((text) => ({ text, vtt: srtToVtt(text) })),
  settings,
  brokenSettings,
  emptySettings,
  places,
  placesEnd,
  placesOdd,
  placesBroken: placesBroken ?? null,
  marksClean,
  base,
  adds,
  neighbours,
  named,
  chapters,
  clocks: clocks.map((c) => ({ ...c, minutesSeconds: c.minutesSeconds ?? null })),
  offers,
  fades,
  rates: RATES.map((rate) => ({ rate, label: rateLabel(rate) })).concat([{ rate: 1.2, label: rateLabel(1.2) }, { rate: 0.25, label: rateLabel(0.25) }]),
}
writeFileSync(`${outDir}/player.json`, JSON.stringify(out) + '\n')
console.log(`Player: ${settings.length} Einstellungen, ${places.length} Stellen, ${marksClean.length + adds.length} Lesezeichen-Fälle`)
