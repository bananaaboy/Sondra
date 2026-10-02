/**
 * Making a file the browser will not play playable anyway.
 *
 * The video editor shows its picture through the browser's own player, and
 * that player knows a handful of codecs and containers. A film from a camera,
 * a TV recording or an old download often brings something else: an AVI, an
 * H.265 picture in Firefox, an AC-3 or DTS sound track that plays as silence.
 *
 * FFmpeg makes a stand-in for watching, reading the file through WORKERFS so
 * nothing is copied in first — and only does as much as is needed. A container
 * the browser does not know is repacked without touching picture or sound; a
 * sound track it cannot play is converted on its own; only a picture it cannot
 * decode is encoded again, small, because that is the slow one. The cut itself
 * is always made from the original.
 */

import type { DiskFacts, StreamInfo } from './ffmpegClient'

let tester: HTMLVideoElement | null = null
const canPlay = (type: string) => {
  tester ??= document.createElement('video')
  return tester.canPlayType(type) !== ''
}

/** Codecs as FFmpeg names them, checked against this browser. */
export function browserPlaysVideo(codec: string): boolean {
  switch (codec) {
    case 'h264':
      return canPlay('video/mp4; codecs="avc1.42E01E"')
    case 'vp8':
    case 'vp9':
      return canPlay(`video/webm; codecs="${codec}"`)
    case 'av1':
      return canPlay('video/mp4; codecs="av01.0.05M.08"')
    case 'hevc':
      // Edge, Safari and Chrome with a hardware decoder; never Firefox.
      return canPlay('video/mp4; codecs="hvc1.1.6.L93.B0"')
    default:
      return false
  }
}

export function browserPlaysAudio(codec: string): boolean {
  switch (codec) {
    case 'aac':
      return canPlay('audio/mp4; codecs="mp4a.40.2"')
    case 'mp3':
      return canPlay('audio/mpeg')
    case 'opus':
    case 'vorbis':
      return canPlay(`audio/webm; codecs="${codec}"`)
    case 'flac':
      return canPlay('audio/flac')
    case 'ac3':
      return canPlay('audio/mp4; codecs="ac-3"')
    case 'eac3':
      return canPlay('audio/mp4; codecs="ec-3"')
    default:
      return false
  }
}

/**
 * Containers the browser opens itself. A file in anything else that does
 * play is still looked at once: Chromium plays an MKV with a DTS track as
 * a silent film, without a word.
 */
export const NATIVE_CONTAINER = /\.(mp4|m4v|mov|webm)$/i

/**
 * How much has to be done.
 *
 * `repack`: picture and sound are fine, the container is not. `sound`: the
 * picture plays and the sound does not. `picture`: the picture has to be
 * encoded again. `null`: nothing — the browser plays it as it is.
 */
export type Remedy = 'repack' | 'sound' | 'picture'

export function remedyFor(facts: DiskFacts, browserFailed: boolean): Remedy | null {
  const video = facts.streams.find((stream) => stream.type === 'video')
  const audio = facts.streams.find((stream) => stream.type === 'audio')
  if (video && !browserPlaysVideo(video.codec)) return 'picture'
  if (audio && !browserPlaysAudio(audio.codec)) return 'sound'
  return browserFailed ? 'repack' : null
}

/** Picture codecs that go in WebM rather than MP4. */
const WEBM_PICTURE = new Set(['vp8', 'vp9', 'av1'])
const WEBM_SOUND = new Set(['opus', 'vorbis'])
const MP4_SOUND = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac'])

export interface StandJob {
  args: string[]
  output: string
  mime: string
}

/**
 * The FFmpeg job for a stand-in. The container follows the picture: VP8,
 * VP9 and AV1 go in WebM, which MP4 will not take VP8 into; everything else
 * in MP4. A sound track the chosen container cannot hold is converted along
 * the way, to Vorbis or AAC — not Opus: libopus takes the whole tab down in
 * this FFmpeg build (measured, also when run under Node).
 */
export interface StandOptions {
  /** Highest picture when it has to be encoded again. */
  maxHeight?: number
  /** x264 quality when it has to be encoded again; lower is better. */
  crf?: number
}

export function standJob(remedy: Remedy, facts: DiskFacts, input: string, { maxHeight = 480, crf = 28 }: StandOptions = {}): StandJob {
  // A sound file the browser cannot play (WMA, a bare AC-3) becomes AAC.
  if (!facts.streams.some((stream) => stream.type === 'video')) {
    return {
      args: ['-hide_banner', '-i', input, '-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k', 'vorschau.m4a'],
      output: 'vorschau.m4a',
      mime: 'audio/mp4',
    }
  }
  const head = ['-hide_banner', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn']
  if (remedy === 'picture' && !browserPlaysVideo('h264')) {
    // A browser without H.264 (Chromium as some Linux systems ship it) gets
    // VP8, which every one of them plays and which encodes fast enough.
    return {
      args: [
        ...head,
        '-vf', `scale=-2:'min(${maxHeight},ih)'`,
        '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M',
        '-c:a', 'libvorbis', '-q:a', '4', '-ac', '2',
        'vorschau.webm',
      ],
      output: 'vorschau.webm',
      mime: 'video/webm',
    }
  }
  if (remedy === 'picture') {
    // Small by default, because the editor only needs it to see the cut.
    // x264 always with -preset medium — faster presets crash this build.
    return {
      args: [
        ...head,
        '-vf', `scale=-2:'min(${maxHeight},ih)'`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-movflags', '+faststart', 'vorschau.mp4',
      ],
      output: 'vorschau.mp4',
      mime: 'video/mp4',
    }
  }
  const picture = firstOf(facts, 'video')?.codec ?? ''
  const sound = firstOf(facts, 'audio')?.codec ?? null
  const webm = WEBM_PICTURE.has(picture)
  const soundFits = sound === null || (webm ? WEBM_SOUND : MP4_SOUND).has(sound)
  const keepSound = remedy === 'repack' && soundFits && sound !== null && browserPlaysAudio(sound)
  const audio = keepSound || sound === null
    ? ['-c:a', 'copy']
    : webm
      ? ['-c:a', 'libvorbis', '-q:a', '4', '-ac', '2']
      : ['-c:a', 'aac', '-b:a', '160k', '-ac', '2']
  const output = webm ? 'vorschau.webm' : 'vorschau.mp4'
  return {
    args: [...head, '-c:v', 'copy', ...audio, ...(webm ? [] : ['-movflags', '+faststart']), output],
    output,
    mime: webm ? 'video/webm' : 'video/mp4',
  }
}

export const REMEDY_TEXT: Record<Remedy, { doing: string; why: (facts: DiskFacts) => string }> = {
  repack: {
    doing: 'Vorschau wird umgepackt',
    why: () => 'Bild und Ton kann der Browser abspielen, die Hülle der Datei nicht. Sie wird für die Vorschau getauscht; das dauert meist nur Sekunden.',
  },
  sound: {
    doing: 'Ton für die Vorschau wird umgewandelt',
    why: (facts) =>
      `Den Ton (${codecName(firstOf(facts, 'audio')?.codec ?? null)}) spielt dieser Browser nicht ab. Für die Vorschau wird nur die Tonspur umgewandelt; das Bild bleibt, wie es ist.`,
  },
  picture: {
    doing: 'Vorschau wird erstellt',
    why: (facts) =>
      `Das Bild (${codecName(firstOf(facts, 'video')?.codec ?? null)}) kann dieser Browser nicht anzeigen. Für die Vorschau wird eine kleine Fassung gerechnet; geschnitten wird trotzdem das Original.`,
  },
}

const firstOf = (facts: DiskFacts, type: StreamInfo['type']) => facts.streams.find((stream) => stream.type === type)

const CODEC_NAMES: Record<string, string> = {
  aac: 'AAC', mp3: 'MP3', ac3: 'AC-3', eac3: 'E-AC-3', dts: 'DTS', truehd: 'TrueHD', opus: 'Opus', vorbis: 'Vorbis',
  flac: 'FLAC', h264: 'H.264', hevc: 'H.265', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2',
  msmpeg4v3: 'DivX 3', wmv3: 'WMV', vc1: 'VC-1', wmav2: 'WMA', mp2: 'MP2', prores: 'ProRes',
}

export const codecName = (codec: string | null) => (codec ? CODEC_NAMES[codec] ?? codec.toUpperCase() : 'unbekannt')

/** A safe name with the right extension, for FFmpeg's view of the file. */
export function diskName(name: string): string {
  const extension = (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? 'mp4').toLowerCase()
  return `quelle.${extension}`
}
