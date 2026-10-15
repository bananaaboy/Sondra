/**
 * Transient detection for drum slicing.
 *
 * Uses derivative of RMS energy envelope and high-frequency energy flux
 * with adaptive local thresholding to detect sharp attacks and peaks in audio.
 */

export interface TransientOptions {
  maxSlices?: number
  sensitivity?: number
  minGapSeconds?: number
}

/**
 * Detects transient attack points in channel audio data.
 *
 * @param channelData Audio samples (mono or single channel).
 * @param sampleRate Sampling rate in Hz.
 * @param maxSlices Maximum number of transient slices to detect (default: 16).
 * @param sensitivity Transient detection sensitivity threshold (default: 1.5).
 * @returns Array of time offsets in seconds of detected transients, sorted chronologically.
 */
export function detectTransients(
  channelData: Float32Array,
  sampleRate: number,
  maxSlices = 16,
  sensitivity = 1.5,
): number[] {
  if (!channelData || channelData.length === 0 || sampleRate <= 0) {
    return [0]
  }

  const length = channelData.length
  // Hop size ~3ms to ~5ms for sharp attack resolution
  const hopSize = Math.max(32, Math.round(sampleRate * 0.003))
  // Window size ~10ms to ~15ms
  const frameSize = Math.max(hopSize * 2, Math.round(sampleRate * 0.012))

  if (length < frameSize) {
    return [0]
  }

  const frameCount = Math.floor((length - frameSize) / hopSize) + 1
  if (frameCount < 2) {
    return [0]
  }

  // Precompute Hann window to prevent spectral leakage and window-edge ripple
  const windowTable = new Float32Array(frameSize)
  for (let i = 0; i < frameSize; i += 1) {
    windowTable[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / frameSize))
  }

  // 1. Compute RMS energy and High-Frequency Content (HFC) for each frame
  const rms = new Float32Array(frameCount)
  const hfc = new Float32Array(frameCount)
  let peakRms = 0

  for (let f = 0; f < frameCount; f += 1) {
    const offset = f * hopSize
    let sumSq = 0
    let hfSumSq = 0
    let prev = offset > 0 ? channelData[offset - 1] : 0

    for (let i = 0; i < frameSize; i += 1) {
      const w = windowTable[i]
      const sample = channelData[offset + i] * w
      sumSq += sample * sample
      const diff = (channelData[offset + i] - prev) * w
      hfSumSq += diff * diff
      prev = channelData[offset + i]
    }

    const r = Math.sqrt(sumSq / frameSize)
    rms[f] = r
    if (r > peakRms) peakRms = r
    hfc[f] = Math.sqrt(hfSumSq / frameSize)
  }

  // 2. Compute energy flux / first-order positive difference (derivative of RMS & HFC envelope)
  const flux = new Float32Array(frameCount)
  let maxFlux = 0

  for (let f = 1; f < frameCount; f += 1) {
    const dRms = Math.max(0, rms[f] - rms[f - 1])
    const dHfc = Math.max(0, hfc[f] - hfc[f - 1])
    // Combined novelty curve emphasizing both wideband impact and high-frequency transient
    const val = dRms + 0.5 * dHfc
    flux[f] = val
    if (val > maxFlux) maxFlux = val
  }

  if (maxFlux < 1e-5 || peakRms < 1e-4) {
    // Virtually silent or completely constant signal
    return [0]
  }

  // 3. Adaptive thresholding and peak detection
  // Window radius for local average (~80-100ms)
  const windowRadius = Math.max(3, Math.round(0.08 / (hopSize / sampleRate)))
  const minGapSeconds = 0.05 // 50ms between drum hits
  const minGapFrames = Math.max(1, Math.round(minGapSeconds / (hopSize / sampleRate)))
  const minFluxThreshold = Math.max(1e-4, peakRms * 0.04, maxFlux * 0.04)

  interface Candidate {
    frame: number
    time: number
    score: number
  }

  const candidates: Candidate[] = []
  let lastPeakFrame = -minGapFrames

  for (let f = 1; f < frameCount - 1; f += 1) {
    const val = flux[f]
    // Local peak condition
    if (val <= flux[f - 1] || val < flux[f + 1]) continue

    // Local mean calculation
    const start = Math.max(0, f - windowRadius)
    const end = Math.min(frameCount, f + windowRadius + 1)
    let sum = 0
    for (let i = start; i < end; i += 1) {
      sum += flux[i]
    }
    const localMean = sum / (end - start)

    // Check sensitivity threshold and noise floor
    const ratio = localMean > 0 ? val / localMean : 0
    if (ratio >= sensitivity && val >= minFluxThreshold) {
      if (f - lastPeakFrame >= minGapFrames) {
        const time = (f * hopSize) / sampleRate
        candidates.push({
          frame: f,
          time,
          score: ratio * val,
        })
        lastPeakFrame = f
      } else if (candidates.length > 0 && val > flux[candidates[candidates.length - 1].frame]) {
        // Replace previous peak in same window if this one is stronger
        candidates[candidates.length - 1] = {
          frame: f,
          time: (f * hopSize) / sampleRate,
          score: ratio * val,
        }
        lastPeakFrame = f
      }
    }
  }

  // 4. Select top candidates up to maxSlices - 1, keeping 0 as the initial slice start
  // Filter out any candidates that are too close to 0 (within 30ms)
  const nonZeroCandidates = candidates.filter((c) => c.time >= 0.03)

  // Sort by score descending to pick the strongest transients
  nonZeroCandidates.sort((a, b) => b.score - a.score)
  const topCandidates = nonZeroCandidates.slice(0, Math.max(0, maxSlices - 1))

  // Collect cut points and add 0
  const chosenTimes = [0, ...topCandidates.map((c) => c.time)]
  chosenTimes.sort((a, b) => a - b)

  // Enforce minimum gap between chosen cuts
  const result: number[] = []
  for (const t of chosenTimes) {
    if (result.length === 0 || t - result[result.length - 1] >= 0.035) {
      result.push(Number(t.toFixed(4)))
    }
  }

  return result.slice(0, maxSlices)
}
