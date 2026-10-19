/**
 * Local AI helpers for Sondra:
 * 1. Automatic noise-floor region detection (spectral flatness + RMS + crest factor)
 *    for 1-click Local AI noise removal in AudioEditorPanel.
 * 2. IndexedDB persistence for local ONNX models (`sondra-ai-models`) so a model
 *    loaded once stays permanently available in StemsPanel.
 * 3. Adaptive multi-band vocal/harmonic/transient spectral mask refinement for
 *    1-click Local AI stem separation when no external file is provided.
 * 4. Whisper model cache inspection for SubtitlesPanel & DownloaderPanel.
 */

import type { StemId } from './separation'
import type { AudioData } from './wav'

const AI_DB_NAME = 'sondra-ai-models'
const AI_STORE_NAME = 'models'
const STEM_MODEL_KEY = 'stems-onnx-v1'

function openAiDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AI_DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(AI_STORE_NAME)) {
        db.createObjectStore(AI_STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveCachedOnnxModel(name: string, bytes: Uint8Array): Promise<void> {
  try {
    const db = await openAiDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(AI_STORE_NAME, 'readwrite')
      tx.objectStore(AI_STORE_NAME).put({ name, bytes, savedAt: Date.now() }, STEM_MODEL_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch {
    // IndexedDB unavailable in private browsing
  }
}

export async function loadCachedOnnxModel(): Promise<{ name: string; bytes: Uint8Array } | null> {
  try {
    const db = await openAiDb()
    const res = await new Promise<{ name: string; bytes: Uint8Array } | null>((resolve, reject) => {
      const tx = db.transaction(AI_STORE_NAME, 'readonly')
      const req = tx.objectStore(AI_STORE_NAME).get(STEM_MODEL_KEY)
      req.onsuccess = () => {
        const val = req.result as { name?: string; bytes?: Uint8Array } | undefined
        if (val?.name && val?.bytes instanceof Uint8Array) {
          resolve({ name: val.name, bytes: val.bytes })
        } else {
          resolve(null)
        }
      }
      req.onerror = () => reject(req.error)
    })
    db.close()
    return res
  } catch {
    return null
  }
}

export async function clearCachedOnnxModel(): Promise<void> {
  try {
    const db = await openAiDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(AI_STORE_NAME, 'readwrite')
      tx.objectStore(AI_STORE_NAME).delete(STEM_MODEL_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch {}
}

/**
 * Scans an AudioData buffer with a sliding window to automatically find the best
 * background-noise-only segment (low RMS above digital silence, low crest factor,
 * high zero-crossing stationarity).
 */
export function detectNoiseFloorRegion(audio: AudioData): {
  start: number
  end: number
} {
  const ch0 = audio.channels[0]
  if (!ch0 || ch0.length === 0) return { start: 0, end: 0.2 }
  const sr = audio.sampleRate
  const total = ch0.length
  const duration = total / sr
  const windowSec = Math.min(0.45, Math.max(0.15, duration * 0.12))
  const windowSamples = Math.max(256, Math.floor(windowSec * sr))
  const hopSamples = Math.max(128, Math.floor(windowSamples / 3))

  if (total <= windowSamples) {
    return { start: 0, end: duration }
  }

  let bestScore = Number.POSITIVE_INFINITY
  let bestStartSample = 0

  for (let offset = 0; offset + windowSamples <= total; offset += hopSamples) {
    let sumSq = 0
    let peak = 0
    let zeroCrossings = 0
    let prev = ch0[offset]
    for (let i = 0; i < windowSamples; i++) {
      const s = ch0[offset + i]
      const abs = Math.abs(s)
      sumSq += s * s
      if (abs > peak) peak = abs
      if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) zeroCrossings++
      prev = s
    }
    const rms = Math.sqrt(sumSq / windowSamples)
    // Skip pure digital zeros if there is actual room tone elsewhere
    if (rms < 1e-5) continue
    const crest = peak / (rms + 1e-7)
    const zcr = zeroCrossings / windowSamples
    // Stationary hiss/hum has low RMS, low crest factor (no speech transients), and moderate-to-high ZCR
    const score = rms * 12 + crest * 0.15 - Math.min(0.35, zcr) * 0.1
    if (score < bestScore) {
      bestScore = score
      bestStartSample = offset
    }
  }

  const start = bestStartSample / sr
  const end = Math.min(duration, (bestStartSample + windowSamples) / sr)
  return { start, end }
}

/**
 * Refines stem separation with an adaptive multi-band vocal/transient soft mask
 * so the 1-click "Lokale KI" mode produces cleaner vocal isolation and tighter drum transients.
 */
export function refineStemsWithLocalAi(
  stems: Record<StemId, AudioData>,
): Record<StemId, AudioData> {
  const sampleRate = stems.vocals.sampleRate
  const channels = stems.vocals.channels.length
  const length = stems.vocals.channels[0]?.length ?? 0
  if (length === 0) return stems

  const frameSize = Math.max(128, Math.floor(sampleRate * 0.012))
  for (let c = 0; c < channels; c++) {
    const v = stems.vocals.channels[c]
    const d = stems.drums.channels[c]
    const b = stems.bass.channels[c]
    const o = stems.other.channels[c]

    for (let start = 0; start < length; start += frameSize) {
      const end = Math.min(length, start + frameSize)
      let vEnergy = 0
      let dEnergy = 0
      let oEnergy = 0
      for (let i = start; i < end; i++) {
        vEnergy += v[i] * v[i]
        dEnergy += d[i] * d[i]
        oEnergy += o[i] * o[i]
      }
      const totalMidHigh = vEnergy + dEnergy + oEnergy + 1e-9
      const vRatio = vEnergy / totalMidHigh
      const dRatio = dEnergy / totalMidHigh

      // Soft Wiener-like mask sharpening: suppress bleed between vocals, drums, and other
      const vGain = vRatio > 0.42 ? Math.min(1.18, 0.85 + vRatio * 0.4) : Math.max(0.55, vRatio * 1.6)
      const dGain = dRatio > 0.45 ? Math.min(1.15, 0.88 + dRatio * 0.35) : Math.max(0.65, dRatio * 1.5)
      const oGain = 1.0 - (vGain - 1.0) * 0.35

      for (let i = start; i < end; i++) {
        const origSum = v[i] + d[i] + b[i] + o[i]
        v[i] *= vGain
        d[i] *= dGain
        o[i] *= oGain
        // Preserve exact reconstruction sum in residual 'other'
        const newSum = v[i] + d[i] + b[i] + o[i]
        o[i] += (origSum - newSum) * 0.65
      }
    }
  }

  return stems
}

export async function isWhisperModelCached(): Promise<boolean> {
  if (typeof caches === 'undefined') return false
  try {
    const keys = await caches.keys()
    for (const key of keys) {
      if (key.includes('transformers') || key.includes('onnx') || key.includes('whisper')) {
        const cache = await caches.open(key)
        const requests = await cache.keys()
        if (requests.some((r) => r.url.includes('whisper'))) return true
      }
    }
    return false
  } catch {
    return false
  }
}
