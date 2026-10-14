/**
 * One conversion, made to finish.
 *
 * `convert.ts` says what to ask FFmpeg for; this decides how to ask so that
 * the answer is a file. Three things go wrong with a conversion in a tab, and
 * each has its own remedy here:
 *
 * 1. **The file is large.** Copying it into MEMFS costs its size twice over,
 *    and a long film then ends in „memory access out of bounds" before a frame
 *    is encoded. A file picked from disk is read where it lies (WORKERFS);
 *    only a file that exists solely in the session is copied.
 * 2. **The threaded core fails.** The pthread build has failure modes the
 *    plain core does not — it deadlocks on some x264 presets, for one. A crash
 *    or a silence there is tried once more on the single-threaded core,
 *    which is slower and almost always finishes.
 * 3. **FFmpeg refuses.** A corrupt file, a video with no sound asked for its
 *    sound. That is not retried; it is explained in a sentence, with what
 *    FFmpeg printed one click away.
 */

import { buildConvertArgs, findFormat, type ConvertSettings } from './convert'
import {
  FfmpegCrash,
  ffmpegStatus,
  loadFfmpeg,
  runFfmpeg,
  runFfmpegOnDisk,
  sanitize,
} from './ffmpegClient'
import { diskName } from './playable'

/** What a conversion reads: the session's bytes, and the picked file if there is one. */
export interface ConvertInput {
  name: string
  bytes: Uint8Array
  source?: Blob
}

/**
 * FFmpeg reports twice a second while it encodes. A minute and a half of
 * nothing is not a slow file, it is a core that will never answer.
 */
const STALL_SECONDS = 90

/** A failure, said in a sentence, with FFmpeg's own words kept for the curious. */
export class ConversionError extends Error {
  readonly detail: string
  constructor(message: string, detail: string) {
    super(message)
    this.name = 'ConversionError'
    this.detail = detail
  }
}

export interface ConvertOptions {
  signal?: AbortSignal
  /** Told when the first attempt failed and a second one starts. */
  onRetry?: (reason: string) => void
}

export interface ConvertOutcome {
  bytes: Uint8Array
  /** True when it took the single-threaded core to finish. */
  retried: boolean
}

export async function runConversion(
  entry: ConvertInput,
  settings: ConvertSettings,
  { signal, onRetry }: ConvertOptions = {},
): Promise<ConvertOutcome> {
  const format = findFormat(settings.formatId)
  const output = `out.${format.extension}`

  const attempt = async (): Promise<Uint8Array> => {
    if (entry.source && entry.source.size > 0) {
      const { files } = await runFfmpegOnDisk({
        source: entry.source,
        name: diskName(entry.name),
        args: (input) => buildConvertArgs(input, output, settings),
        output: [output],
        signal,
        stallSeconds: STALL_SECONDS,
      })
      return files[output]
    }
    const input = `in_${sanitize(entry.name)}`
    const { files } = await runFfmpeg({
      input: { [input]: entry.bytes },
      output: [output],
      args: buildConvertArgs(input, output, settings),
      signal,
      stallSeconds: STALL_SECONDS,
    })
    return files[output]
  }

  await loadFfmpeg()
  const threaded = ffmpegStatus().multiThreaded
  try {
    return { bytes: checked(await attempt()), retried: false }
  } catch (failure) {
    if (signal?.aborted || isAbort(failure)) throw failure
    // The plain core is a different build only where the threaded one ran.
    if (!(failure instanceof FfmpegCrash) || !threaded) throw explain(failure, format.label)
    onRetry?.(failure.hung ? 'FFmpeg reagierte nicht mehr' : 'FFmpeg ist abgestürzt')
    await loadFfmpeg({ singleThread: true })
    try {
      return { bytes: checked(await attempt()), retried: true }
    } catch (second) {
      if (signal?.aborted || isAbort(second)) throw second
      throw explain(second, format.label)
    }
  }
}

function checked(bytes: Uint8Array | undefined): Uint8Array {
  if (!bytes || bytes.byteLength === 0) {
    throw new ConversionError('FFmpeg ist fertig geworden, hat aber eine leere Datei geschrieben.', '')
  }
  return bytes
}

const isAbort = (failure: unknown) => failure instanceof DOMException && failure.name === 'AbortError'

/**
 * The first line a person reads. FFmpeg's own last lines stay in `detail`,
 * because they are what anyone who can help will ask for.
 */
export function explain(failure: unknown, label: string): ConversionError {
  if (failure instanceof ConversionError) return failure
  const text = failure instanceof Error ? failure.message : String(failure)
  const said = (pattern: RegExp) => pattern.test(text)

  let message: string
  if (failure instanceof FfmpegCrash) {
    message = failure.hung
      ? `Die Umwandlung nach ${label} ist stehen geblieben, auch im zweiten Anlauf. Ein anderes Zielformat geht meist — MP3 oder AAC für Ton, MP4 für Video.`
      : `Die Umwandlung nach ${label} ist im Rechenkern abgestürzt, auch im zweiten Anlauf. Ein anderes Zielformat geht meist — MP3 oder AAC für Ton, MP4 für Video.`
  } else if (said(/does not contain any stream|matches no streams|Output file .* does not contain/i)) {
    message = `Die Datei hat nichts, woraus ${label} werden kann — zum Beispiel ein Video ohne Tonspur, wenn nur der Ton behalten werden soll.`
  } else if (said(/Invalid data found when processing input|moov atom not found|could not find codec parameters/i)) {
    message = 'Die Datei ist beschädigt oder unvollständig — FFmpeg findet darin keinen lesbaren Anfang.'
  } else if (said(/Decoder .* not found|Unknown decoder|unsupported codec/i)) {
    message = 'In der Datei steckt ein Codec, den dieser Rechenkern nicht lesen kann.'
  } else if (said(/sample rate .* not supported|Specified sample rate/i)) {
    message = `${label} nimmt diese Abtastrate nicht an. Unter „Abtastrate" eine andere wählen oder „Wie Quelle" lassen.`
  } else if (said(/Cannot allocate memory|out of memory|memory access out of bounds/i)) {
    message = 'Für diese Datei hat der Arbeitsspeicher des Tabs nicht gereicht. Kürzer schneiden oder eine kleinere Auflösung wählen hilft.'
  } else {
    message = `Die Umwandlung nach ${label} hat nicht geklappt.`
  }
  return new ConversionError(message, text.trim())
}
