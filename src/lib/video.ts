/**
 * Video operations, expressed as one FFmpeg invocation.
 *
 * Every edit here is a filter, and filters compose — so cutting, cropping,
 * straightening, scaling and changing the speed all happen in a single pass
 * rather than five. That matters more than it sounds: each extra pass is
 * another full decode and re-encode, which on a WebAssembly build is the
 * difference between a coffee and an afternoon.
 *
 * The order of the chain is fixed and not arbitrary. Cropping first means
 * everything downstream works on fewer pixels; scaling before the speed change
 * keeps the resampling off the interpolated frames; and `setpts` has to be last
 * because it rewrites timestamps the earlier filters still rely on.
 */

export type VideoContainer = 'mp4' | 'webm' | 'gif'

export interface VideoPreset {
  id: string
  label: string
  hint: string
  /** 0 keeps the source height. */
  height: number
  /** Constant Rate Factor — lower is better and bigger. */
  crf: number
}

export const VIDEO_PRESETS: VideoPreset[] = [
  { id: 'original', label: 'Original', hint: 'Auflösung unverändert, sichtbar verlustfrei', height: 0, crf: 18 },
  { id: 'high', label: 'Hohe Qualität', hint: 'Auflösung unverändert, deutlich kleiner', height: 0, crf: 22 },
  { id: '1080p', label: '1080p', hint: 'Full HD — der übliche Kompromiss', height: 1080, crf: 23 },
  { id: '720p', label: '720p', hint: 'Schnell und klein, gut für Messenger', height: 720, crf: 25 },
  { id: '480p', label: '480p', hint: 'Sehr klein, für Vorschau und E-Mail', height: 480, crf: 28 },
]

export interface VideoOps {
  /** Seconds. `end` of 0 means "to the end of the file". */
  start: number
  end: number
  crop: { x: number; y: number; width: number; height: number } | null
  rotate: 0 | 90 | 180 | 270
  flipH: boolean
  flipV: boolean
  /** 1 is unchanged; 0.5 is half speed, 2 is double. */
  speed: number
  mute: boolean
  container: VideoContainer
  preset: string
  /** Picture. Brightness is added (−0.3…0.3), contrast and saturation multiply. */
  brightness: number
  contrast: number
  saturation: number
  look: VideoLook
  sharpen: boolean
  denoise: boolean
  stabilize: boolean
  /** Seconds of the finished clip, picture and sound together. */
  fadeIn: number
  fadeOut: number
  /** Sound level change in dB. */
  volumeDb: number
  /** Bring the sound to −16 LUFS, the level most platforms play at. */
  loudnorm: boolean
  reverse: boolean
}

export type VideoLook = 'none' | 'mono' | 'sepia' | 'vivid' | 'warm' | 'cool'

export const VIDEO_LOOKS: { id: VideoLook; label: string }[] = [
  { id: 'none', label: 'Ohne' },
  { id: 'mono', label: 'Schwarzweiss' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'vivid', label: 'Lebendig' },
  { id: 'warm', label: 'Warm' },
  { id: 'cool', label: 'Kühl' },
]

/** The same look for the preview, as a CSS filter — close, not identical. */
export function previewFilter(ops: VideoOps): string {
  const parts = [
    `brightness(${(1 + ops.brightness * 1.6).toFixed(3)})`,
    `contrast(${ops.contrast.toFixed(3)})`,
    `saturate(${ops.saturation.toFixed(3)})`,
  ]
  if (ops.look === 'mono') parts.push('grayscale(1)')
  if (ops.look === 'sepia') parts.push('sepia(0.85)')
  if (ops.look === 'vivid') parts.push('saturate(1.35) contrast(1.08)')
  if (ops.look === 'warm') parts.push('sepia(0.18) saturate(1.1)')
  if (ops.look === 'cool') parts.push('hue-rotate(-8deg) saturate(0.95) brightness(1.02)')
  return parts.join(' ')
}

export const DEFAULT_VIDEO_OPS: VideoOps = {
  start: 0,
  end: 0,
  crop: null,
  rotate: 0,
  flipH: false,
  flipV: false,
  speed: 1,
  mute: false,
  container: 'mp4',
  preset: '1080p',
  brightness: 0,
  contrast: 1,
  saturation: 1,
  look: 'none',
  sharpen: false,
  denoise: false,
  stabilize: false,
  fadeIn: 0,
  fadeOut: 0,
  volumeDb: 0,
  loudnorm: false,
  reverse: false,
}

/** Whether anything in the picture or sound settings asks for re-encoding. */
function touchesContent(ops: VideoOps): boolean {
  return (
    ops.brightness !== 0 ||
    ops.contrast !== 1 ||
    ops.saturation !== 1 ||
    ops.look !== 'none' ||
    ops.sharpen ||
    ops.denoise ||
    ops.stabilize ||
    ops.fadeIn > 0 ||
    ops.fadeOut > 0 ||
    ops.volumeDb !== 0 ||
    ops.loudnorm ||
    ops.reverse
  )
}

const LOOK_FILTER: Record<VideoLook, string | null> = {
  none: null,
  mono: 'hue=s=0',
  sepia: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
  vivid: 'eq=saturation=1.35:contrast=1.08',
  warm: 'colorbalance=rs=.08:gs=.02:bs=-.08:rm=.06:bm=-.06',
  cool: 'colorbalance=rs=-.06:bs=.08:rm=-.04:bm=.06',
}

export function findPreset(id: string): VideoPreset {
  return VIDEO_PRESETS.find((preset) => preset.id === id) ?? VIDEO_PRESETS[2]
}

/**
 * `atempo` only accepts 0.5–2.0, so anything beyond is reached by chaining.
 *
 * Two halvings give a quarter, two doublings give four times — and chaining is
 * the documented way to do it, not a trick: each stage resamples cleanly where
 * one stage out of range would simply be rejected.
 */
function tempoChain(speed: number): string[] {
  const stages: number[] = []
  let remaining = speed
  while (remaining > 2) {
    stages.push(2)
    remaining /= 2
  }
  while (remaining < 0.5) {
    stages.push(0.5)
    remaining *= 2
  }
  if (Math.abs(remaining - 1) > 0.001) stages.push(remaining)
  return stages.map((stage) => `atempo=${stage.toFixed(4)}`)
}

export interface BuiltJob {
  args: string[]
  /** What the result should be called, extension included. */
  extension: string
  mime: string
  /** True when nothing was asked for that requires re-encoding. */
  copyOnly: boolean
}

/**
 * Turns the settings into an argument list.
 *
 * `-ss` before `-i` seeks by keyframe and is near-instant; after `-i` it is
 * frame-exact but decodes everything up to the cut. Exactness wins here,
 * because a cut that lands half a second off is the kind of thing people
 * notice immediately and blame on the tool.
 */
export function buildVideoJob(
  ops: VideoOps,
  input: string,
  duration: number,
  source: { width: number; height: number } | null = null,
): BuiltJob {
  const preset = findPreset(ops.preset)
  const args: string[] = ['-i', input]

  const end = ops.end > 0 ? ops.end : duration
  const trimmed = ops.start > 0 || (ops.end > 0 && ops.end < duration - 0.001)
  /** Length of the kept part in the source's own time, before any speed change. */
  const span = Math.max(0.01, end - ops.start)

  const filters: string[] = []
  if (ops.reverse) filters.push('reverse')
  // Stabilising looks at the whole frame, so it runs before anything is cut
  // away or scaled down.
  if (ops.stabilize) filters.push('deshake')
  // Straighten first, crop second. That is the order people work in — you fix
  // a sideways clip and then decide what to keep — and it is the order the
  // editor's crop overlay draws in, so the rectangle on screen and the
  // rectangle in the filter graph mean the same thing. With crop first, a
  // 16:9 selection on a portrait clip came out 9:16.
  if (ops.rotate === 90) filters.push('transpose=1')
  if (ops.rotate === 180) filters.push('transpose=1,transpose=1')
  if (ops.rotate === 270) filters.push('transpose=2')
  if (ops.flipH) filters.push('hflip')
  if (ops.flipV) filters.push('vflip')
  if (ops.crop) {
    // FFmpeg wants pixels, and only even numbers survive 4:2:0 chroma. `iw`
    // and `ih` are the *filter's* input, which after the transposes above is
    // already the upright frame.
    const even = (value: string) => `trunc(${value}/2)*2`
    filters.push(
      `crop=${even(`iw*${ops.crop.width.toFixed(4)}`)}:${even(`ih*${ops.crop.height.toFixed(4)}`)}:` +
        `${even(`iw*${ops.crop.x.toFixed(4)}`)}:${even(`ih*${ops.crop.y.toFixed(4)}`)}`,
    )
  }
  // The obvious way to avoid upscaling is scale=-2:'min(720,ih)'. Two traps in
  // one expression: these arguments reach FFmpeg as an array, so the quotes are
  // literal characters that break the filter, and the comma inside min() is
  // what separates filters in a graph and would need escaping. Since the source
  // height is known here, the smaller of the two is simply worked out in
  // advance and the filter gets a plain number.
  if (preset.height > 0) {
    const height = source ? Math.min(preset.height, source.height) : preset.height
    // Odd heights have no valid 4:2:0 chroma plane.
    filters.push(`scale=-2:${Math.max(2, Math.round(height / 2) * 2)}`)
  }
  if (ops.denoise) filters.push('hqdn3d=3:2:4:3')
  if (ops.brightness !== 0 || ops.contrast !== 1 || ops.saturation !== 1) {
    filters.push(
      `eq=brightness=${ops.brightness.toFixed(3)}:contrast=${ops.contrast.toFixed(3)}:saturation=${ops.saturation.toFixed(3)}`,
    )
  }
  const look = LOOK_FILTER[ops.look]
  if (look) filters.push(look)
  if (ops.sharpen) filters.push('unsharp=5:5:0.8:3:3:0')
  // Fades are timed on the kept part, which the trim below has already moved
  // to start at zero, and before the speed change — hence the multiplication.
  if (ops.fadeIn > 0) filters.push(`fade=t=in:st=0:d=${(ops.fadeIn * ops.speed).toFixed(3)}`)
  if (ops.fadeOut > 0) {
    const length = Math.min(span, ops.fadeOut * ops.speed)
    filters.push(`fade=t=out:st=${Math.max(0, span - length).toFixed(3)}:d=${length.toFixed(3)}`)
  }
  if (ops.speed !== 1) filters.push(`setpts=${(1 / ops.speed).toFixed(5)}*PTS`)

  const untouched = filters.length === 0 && ops.speed === 1 && !touchesContent(ops)

  // A plain cut can copy the streams, and that path seeks with -ss/-to. The
  // moment anything is re-encoded, the cut becomes a trim filter at the head of
  // the graph instead: equally frame-exact, and it resets the clock to zero, so
  // fades, reversing and speed all work on the kept part and not on the file.
  const cutArgs = trimmed ? ['-ss', ops.start.toFixed(3), ...(end < duration - 0.001 ? ['-to', end.toFixed(3)] : [])] : []
  if (trimmed) filters.unshift(`trim=start=${ops.start.toFixed(3)}:end=${end.toFixed(3)}`, 'setpts=PTS-STARTPTS')

  const audioFilters: string[] = []
  if (trimmed) audioFilters.push(`atrim=start=${ops.start.toFixed(3)}:end=${end.toFixed(3)}`, 'asetpts=PTS-STARTPTS')
  if (ops.reverse) audioFilters.push('areverse')
  if (ops.fadeIn > 0) audioFilters.push(`afade=t=in:st=0:d=${(ops.fadeIn * ops.speed).toFixed(3)}`)
  if (ops.fadeOut > 0) {
    const length = Math.min(span, ops.fadeOut * ops.speed)
    audioFilters.push(`afade=t=out:st=${Math.max(0, span - length).toFixed(3)}:d=${length.toFixed(3)}`)
  }
  if (ops.volumeDb !== 0) audioFilters.push(`volume=${ops.volumeDb.toFixed(1)}dB`)
  if (ops.speed !== 1) audioFilters.push(...tempoChain(ops.speed))
  if (ops.loudnorm) audioFilters.push('loudnorm=I=-16:TP=-1.5:LRA=11')

  if (ops.container === 'gif') {
    // One palette for the whole clip, generated from the clip itself: the
    // default 216-colour web palette is what makes converted GIFs look like
    // they came from 1998.
    const width = source ? Math.min(640, source.width) : 640
    const chain = [...filters, 'fps=15', `scale=${Math.max(2, Math.round(width / 2) * 2)}:-2:flags=lanczos`].join(',')
    args.push('-filter_complex', `${chain},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`)
    args.push('-loop', '0')
    return { args, extension: 'gif', mime: 'image/gif', copyOnly: false }
  }

  // Nothing but a cut: copy the streams instead of re-encoding them. Minutes
  // become seconds, and the picture is bit-for-bit the original.
  if (ops.container === 'mp4' && untouched && trimmed && !ops.mute) {
    args.push(...cutArgs, '-c', 'copy', '-avoid_negative_ts', 'make_zero')
    return { args, extension: 'mp4', mime: 'video/mp4', copyOnly: true }
  }

  if (filters.length > 0) args.push('-vf', filters.join(','))

  if (ops.mute) {
    args.push('-an')
  } else if (audioFilters.length > 0) {
    args.push('-filter:a', audioFilters.join(','))
  }

  if (ops.container === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-crf', String(preset.crf + 8), '-b:v', '0', '-row-mt', '1')
    if (!ops.mute) args.push('-c:a', 'libopus', '-b:a', '128k')
    return { args, extension: 'webm', mime: 'video/webm', copyOnly: false }
  }

  // `medium`, not `veryfast`, and this is measured rather than taste. With
  // `-preset veryfast` this build of the WebAssembly x264 dies immediately in
  // a pthread entry point — "null function or function signature mismatch",
  // an error that names neither the preset nor the encoder. The same argument
  // list runs clean through a native FFmpeg, and the existing converter, which
  // offers `veryfast` in its own menu, does not crash on it but never returns
  // either. `medium` finishes the same job in ten seconds.
  args.push('-c:v', 'libx264', '-crf', String(preset.crf), '-preset', 'medium', '-pix_fmt', 'yuv420p')
  if (!ops.mute) args.push('-c:a', 'aac', '-b:a', '192k')
  args.push('-movflags', '+faststart')
  return { args, extension: 'mp4', mime: 'video/mp4', copyOnly: false }
}

/** Pulls the audio out untouched where possible, re-encoded where not. */
export function buildAudioExtraction(input: string, format: 'copy' | 'wav' | 'mp3' | 'flac'): BuiltJob {
  const base = ['-i', input, '-vn']
  if (format === 'wav') return { args: [...base, '-c:a', 'pcm_s16le'], extension: 'wav', mime: 'audio/wav', copyOnly: false }
  if (format === 'mp3') return { args: [...base, '-c:a', 'libmp3lame', '-q:a', '2'], extension: 'mp3', mime: 'audio/mpeg', copyOnly: false }
  if (format === 'flac') return { args: [...base, '-c:a', 'flac'], extension: 'flac', mime: 'audio/flac', copyOnly: false }
  // Copy keeps whatever the video carried — usually AAC in an .m4a shell.
  return { args: [...base, '-c:a', 'copy'], extension: 'm4a', mime: 'audio/mp4', copyOnly: true }
}

/** A single frame as a PNG. */
export function buildFrameGrab(input: string, atSeconds: number): BuiltJob {
  return {
    args: ['-ss', atSeconds.toFixed(3), '-i', input, '-frames:v', '1'],
    extension: 'png',
    mime: 'image/png',
    copyOnly: false,
  }
}

/** Replaces the soundtrack, keeping the picture untouched. */
export function buildAudioReplacement(video: string, audio: string): BuiltJob {
  return {
    args: [
      '-i', video,
      '-i', audio,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      // The result ends with whichever of the two runs out first, rather than
      // freezing on a still frame or trailing silence.
      '-shortest',
      '-movflags', '+faststart',
    ],
    extension: 'mp4',
    mime: 'video/mp4',
    copyOnly: false,
  }
}
