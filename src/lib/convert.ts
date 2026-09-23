/**
 * Output formats and the FFmpeg argument lists behind them.
 *
 * Keeping the argument construction in one place — rather than scattered across
 * the UI — means the command shown in the log panel is literally the command
 * that ran, which makes the whole thing auditable.
 *
 * Every codec listed here was verified against the shipped `@ffmpeg/core` build;
 * nothing offers a format the core cannot actually produce.
 */

export type FormatKind = 'audio' | 'video' | 'image'

export interface ConvertSettings {
  formatId: string
  /** Constant bitrate in kbit/s, for the lossy codecs. */
  audioBitrateKbps: number
  /** 0 (best) to 9 (smallest) for the VBR codecs. */
  audioQuality: number
  useVariableBitrate: boolean
  sampleRate: number | 'source'
  channels: 1 | 2 | 'source'
  wavBitDepth: 16 | 24 | 32
  /** Constant Rate Factor — lower is better quality, larger file. */
  videoCrf: number
  videoPreset: string
  /** Target height in pixels; width follows the source aspect ratio. */
  videoHeight: number | 'source'
  frameRate: number | 'source'
  trimStartSeconds: number | null
  trimEndSeconds: number | null
}

export const DEFAULT_CONVERT: ConvertSettings = {
  formatId: 'mp3',
  audioBitrateKbps: 192,
  audioQuality: 2,
  useVariableBitrate: true,
  sampleRate: 'source',
  channels: 'source',
  wavBitDepth: 24,
  videoCrf: 23,
  videoPreset: 'medium',
  videoHeight: 'source',
  frameRate: 'source',
  trimStartSeconds: null,
  trimEndSeconds: null,
}

export interface OutputFormat {
  id: string
  label: string
  hint: string
  extension: string
  kind: FormatKind
  mime: string
  lossless: boolean
  /** Codec arguments, excluding input, trim, rate and channel handling. */
  codecArgs: (settings: ConvertSettings) => string[]
  /** Some formats replace the whole tail of the command (GIF's palette pass). */
  filterComplex?: (settings: ConvertSettings) => string[] | null
  /**
   * The sample rates the encoder accepts, where it does not accept all of
   * them. MP3 stops at 48 kHz and Opus only knows 48 kHz: asking LAME for
   * 96 kHz ended in „Specified sample rate 96000 is not supported".
   */
  sampleRates?: number[]
}

const bitrate = (settings: ConvertSettings) => `${settings.audioBitrateKbps}k`

export const OUTPUT_FORMATS: OutputFormat[] = [
  {
    id: 'mp3',
    label: 'MP3',
    hint: 'Überall abspielbar',
    extension: 'mp3',
    kind: 'audio',
    mime: 'audio/mpeg',
    lossless: false,
    codecArgs: (s) => [
      '-c:a',
      'libmp3lame',
      ...(s.useVariableBitrate ? ['-q:a', String(s.audioQuality)] : ['-b:a', bitrate(s)]),
    ],
    sampleRates: [22050, 32000, 44100, 48000],
  },
  {
    id: 'aac',
    label: 'AAC (M4A)',
    hint: 'Apple-Ökosystem',
    extension: 'm4a',
    kind: 'audio',
    mime: 'audio/mp4',
    lossless: false,
    codecArgs: (s) => ['-c:a', 'aac', '-b:a', bitrate(s), '-movflags', '+faststart'],
  },
  {
    id: 'opus',
    label: 'Opus',
    hint: 'Beste Qualität pro Bit',
    extension: 'opus',
    kind: 'audio',
    mime: 'audio/ogg',
    lossless: false,
    codecArgs: (s) => ['-c:a', 'libopus', '-b:a', bitrate(s), '-vbr', 'on'],
    sampleRates: [48000],
  },
  {
    id: 'vorbis',
    label: 'Ogg Vorbis',
    hint: 'Offenes Format',
    extension: 'ogg',
    kind: 'audio',
    mime: 'audio/ogg',
    lossless: false,
    codecArgs: (s) => ['-c:a', 'libvorbis', '-q:a', String(Math.max(0, 10 - s.audioQuality))],
  },
  {
    id: 'flac',
    label: 'FLAC',
    hint: 'Verlustfrei komprimiert',
    extension: 'flac',
    kind: 'audio',
    mime: 'audio/flac',
    lossless: true,
    codecArgs: () => ['-c:a', 'flac', '-compression_level', '8'],
  },
  {
    id: 'alac',
    label: 'ALAC (M4A)',
    hint: 'Verlustfrei, Apple',
    extension: 'm4a',
    kind: 'audio',
    mime: 'audio/mp4',
    lossless: true,
    codecArgs: () => ['-c:a', 'alac'],
  },
  {
    id: 'wav',
    label: 'WAV',
    hint: 'Unkomprimiert, für Schnitt',
    extension: 'wav',
    kind: 'audio',
    mime: 'audio/wav',
    lossless: true,
    codecArgs: (s) => [
      '-c:a',
      s.wavBitDepth === 16 ? 'pcm_s16le' : s.wavBitDepth === 24 ? 'pcm_s24le' : 'pcm_f32le',
    ],
  },
  {
    id: 'mp4',
    label: 'MP4 (H.264)',
    hint: 'Standard für Video',
    extension: 'mp4',
    kind: 'video',
    mime: 'video/mp4',
    lossless: false,
    codecArgs: (s) => [
      '-c:v',
      'libx264',
      '-crf',
      String(s.videoCrf),
      '-preset',
      s.videoPreset,
      // 4:2:0 is the only chroma layout every hardware decoder accepts.
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      bitrate(s),
      '-movflags',
      '+faststart',
    ],
  },
  {
    id: 'webm',
    label: 'WebM (VP9)',
    hint: 'Kleiner fürs Web',
    extension: 'webm',
    kind: 'video',
    mime: 'video/webm',
    lossless: false,
    codecArgs: (s) => [
      '-c:v',
      'libvpx-vp9',
      '-crf',
      String(s.videoCrf),
      // VP9 needs an explicit zero bitrate to run in constant-quality mode.
      '-b:v',
      '0',
      '-row-mt',
      '1',
      '-c:a',
      'libopus',
      '-b:a',
      bitrate(s),
    ],
    sampleRates: [48000],
  },
  {
    id: 'gif',
    label: 'GIF',
    hint: 'Kurze Schleifen',
    extension: 'gif',
    kind: 'image',
    mime: 'image/gif',
    lossless: false,
    codecArgs: () => [],
    filterComplex: (s) => {
      const fps = s.frameRate === 'source' ? 12 : s.frameRate
      const scale = s.videoHeight === 'source' ? 480 : s.videoHeight
      // One pass: build an optimal palette from the clip, then apply it.
      return [
        '-filter_complex',
        `fps=${fps},scale=-1:${scale}:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
        '-loop',
        '0',
      ]
    },
  },
]

export function findFormat(id: string): OutputFormat {
  const format = OUTPUT_FORMATS.find((f) => f.id === id)
  if (!format) throw new Error(`Unbekanntes Format: ${id}`)
  return format
}

/** Builds the complete argument list for one conversion. */
export function buildConvertArgs(
  inputName: string,
  outputName: string,
  settings: ConvertSettings,
): string[] {
  const format = findFormat(settings.formatId)
  const args: string[] = ['-i', inputName]

  // Output-side seeking: slower than seeking the input, but frame accurate,
  // which matters when someone trims to a beat.
  if (settings.trimStartSeconds !== null) args.push('-ss', settings.trimStartSeconds.toFixed(3))
  if (settings.trimEndSeconds !== null) args.push('-to', settings.trimEndSeconds.toFixed(3))

  const complex = format.filterComplex?.(settings) ?? null
  if (complex) {
    args.push(...complex, '-an')
  } else {
    if (format.kind === 'audio') args.push('-vn')

    const videoFilters: string[] = []
    if (format.kind === 'video') {
      if (settings.videoHeight !== 'source') {
        // -2 keeps the aspect ratio and rounds to an even width, which both
        // H.264 and VP9 require.
        videoFilters.push(`scale=-2:${settings.videoHeight}`)
      }
      if (settings.frameRate !== 'source') videoFilters.push(`fps=${settings.frameRate}`)
      if (videoFilters.length) args.push('-vf', videoFilters.join(','))
    }

    args.push(...format.codecArgs(settings))

    const rate = rateFor(format, settings.sampleRate)
    if (rate !== 'source') args.push('-ar', String(rate))
    if (settings.channels !== 'source') args.push('-ac', String(settings.channels))
  }

  args.push(outputName)
  return args
}

/** The same command, rendered the way you would type it into a shell. */
export function previewCommand(args: string[]): string {
  return `ffmpeg ${args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')}`
}

export const VIDEO_PRESETS = ['ultrafast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'veryslow']
export const SAMPLE_RATES = [22050, 32000, 44100, 48000, 96000]

/** The rates this format can be asked for, for the menu. */
export function sampleRatesFor(format: OutputFormat): number[] {
  return format.sampleRates ?? SAMPLE_RATES
}

/**
 * The rate actually passed to FFmpeg: the chosen one if the encoder takes it,
 * otherwise the nearest one it does. „Wie Quelle" stays as it is — FFmpeg
 * then picks the closest supported rate on its own.
 */
export function rateFor(format: OutputFormat, wanted: number | 'source'): number | 'source' {
  if (wanted === 'source' || !format.sampleRates || format.sampleRates.includes(wanted)) return wanted
  return format.sampleRates.reduce((best, rate) => (Math.abs(rate - wanted) < Math.abs(best - wanted) ? rate : best))
}
export const BITRATES = [64, 96, 128, 160, 192, 256, 320]
