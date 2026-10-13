/**
 * Media tagging utility using FFmpeg WebAssembly.
 * Embeds ID3v2/metadata tags (title, artist, album) and optional cover artwork
 * directly into audio files (MP3, M4A, FLAC, Opus, Ogg).
 */

import { runFfmpeg } from './ffmpegClient'

export interface MediaTags {
  title?: string | null
  artist?: string | null
  album?: string | null
  coverUrl?: string | null
  coverBytes?: Uint8Array | null
}

/**
 * Attempts to embed tags and cover art into an audio file.
 * Returns the tagged bytes, or original bytes on fallback.
 */
export async function tagAudioFile(
  bytes: Uint8Array,
  ext: string,
  tags: MediaTags,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const cleanExt = ext.replace(/^\./, '').toLowerCase()
  if (!['mp3', 'm4a', 'flac', 'opus', 'ogg'].includes(cleanExt)) {
    return bytes
  }

  let cover = tags.coverBytes ?? null
  if (!cover && tags.coverUrl) {
    try {
      const resp = await fetch(tags.coverUrl, { signal: AbortSignal.timeout(4000) })
      if (resp.ok) {
        cover = new Uint8Array(await resp.arrayBuffer())
      }
    } catch {
      // Ignore thumbnail fetch failure
    }
  }

  const hasMeta = Boolean(tags.title || tags.artist || tags.album || cover)
  if (!hasMeta) return bytes

  const inName = `input.${cleanExt}`
  const outName = `output.${cleanExt}`
  const inputFiles: Record<string, Uint8Array> = { [inName]: bytes }
  const args: string[] = ['-i', inName]

  if (cover && cover.byteLength > 0 && (cleanExt === 'mp3' || cleanExt === 'flac' || cleanExt === 'm4a')) {
    inputFiles['cover.jpg'] = cover
    args.push('-i', 'cover.jpg')
    args.push('-map', '0:a:0', '-map', '1:0')
    args.push('-c:v', 'copy', '-disposition:v:0', 'attached_pic')
  }

  args.push('-c:a', 'copy')

  if (tags.title) args.push('-metadata', `title=${tags.title}`)
  if (tags.artist) args.push('-metadata', `artist=${tags.artist}`)
  if (tags.album) args.push('-metadata', `album=${tags.album}`)

  args.push(outName)

  try {
    const res = await runFfmpeg({
      input: inputFiles,
      output: [outName],
      args,
      signal,
    })
    return res.files[outName] ?? bytes
  } catch {
    // If FFmpeg tagging fails (e.g. incompatible stream container), return unmodified bytes
    return bytes
  }
}
