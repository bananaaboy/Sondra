/**
 * Decodes an asset to planar floats, on demand.
 *
 * The browser's own decoder is tried first because it is hardware accelerated
 * and already present. FFmpeg is the fallback for the containers browsers
 * refuse — and the first fallback pays for loading the core, so it is worth
 * telling the user which path ran.
 */

import { useCallback, useEffect, useState } from 'react'

import { decodeWithBrowser } from '../lib/audio'
import { decodeToWav } from '../lib/ffmpegClient'
import { decodeWav, type AudioData } from '../lib/wav'
import { useSession, type Asset } from '../state/store'

export type DecodeStatus = 'idle' | 'decoding' | 'ready' | 'error'

export interface DecodeState {
  audio: AudioData | null
  status: DecodeStatus
  error: string | null
  /** Which decoder produced the result. */
  via: 'browser' | 'ffmpeg' | null
  decode: () => Promise<AudioData | null>
}

/**
 * Decodes in progress, shared by every hook instance.
 *
 * A per-instance guard was not enough: the header's file menu and the open
 * tool both decode the same file, and each finished with its own copy. The
 * second copy replaced the first in the session, and the audio editor took
 * that as a new file — resetting itself and dropping whatever had just been
 * cut. One decode per asset, whoever asks.
 */
const pending = new Map<string, Promise<AudioData | null>>()

/**
 * Decodes one asset outside any component — for batches, which walk through
 * files no panel has open. Browser first, FFmpeg for what it refuses. The
 * result is not stored on the asset: ten decoded tracks would hold several
 * times the session's size in memory for nothing.
 */
export async function decodeAssetAudio(asset: Asset): Promise<AudioData> {
  if (asset.audio) return asset.audio
  try {
    return await decodeWithBrowser(asset.bytes.slice().buffer as ArrayBuffer)
  } catch {
    return decodeWav(await decodeToWav(asset.bytes, asset.name))
  }
}

export function useDecodedAudio(asset: Asset | null): DecodeState {
  const updateAsset = useSession((state) => state.updateAsset)
  const log = useSession((state) => state.log)

  const [status, setStatus] = useState<DecodeStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [via, setVia] = useState<'browser' | 'ffmpeg' | null>(null)
  useEffect(() => {
    setError(null)
    setVia(null)
    setStatus(asset?.audio ? 'ready' : asset && pending.has(asset.id) ? 'decoding' : 'idle')
  }, [asset?.id, asset?.audio])

  const decode = useCallback(async (): Promise<AudioData | null> => {
    if (!asset) return null
    if (asset.audio) return asset.audio
    const running = pending.get(asset.id)
    if (running) {
      setStatus('decoding')
      const audio = await running
      setStatus(audio ? 'ready' : 'error')
      return audio
    }

    const task = (async () => {
      setStatus('decoding')
      setError(null)
      try {
        let audio: AudioData
        try {
          const source = asset.bytes.slice()
          audio = await decodeWithBrowser(source.buffer as ArrayBuffer)
          setVia('browser')
          log('decode', `${asset.name} über den Browser dekodiert`)
        } catch {
          log('decode', `${asset.name}: Browser lehnt das Format ab, FFmpeg übernimmt`, 'warn')
          const wav = await decodeToWav(asset.bytes, asset.name)
          audio = decodeWav(wav)
          setVia('ffmpeg')
        }

        updateAsset(asset.id, {
          audio,
          durationSeconds: (audio.channels[0]?.length ?? 0) / audio.sampleRate,
        })
        setStatus('ready')
        return audio
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure)
        setError(message)
        setStatus('error')
        log('decode', `${asset.name}: ${message}`, 'error')
        return null
      } finally {
        pending.delete(asset.id)
      }
    })()

    pending.set(asset.id, task)
    return task
  }, [asset, log, updateAsset])

  return { audio: asset?.audio ?? null, status, error, via, decode }
}
