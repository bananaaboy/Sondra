/**
 * Auto-Silence Trimmer
 *
 * Local and offline detection and removal of silent segments in audio buffers.
 * Detected silent regions are stripped, and surviving non-silent segments are
 * concatenated with smooth mini-crossfades (5ms) to eliminate boundary clicks.
 */

export interface SilenceRegion {
  start: number
  end: number
  duration: number
}

/**
 * Detects silent regions in an AudioBuffer where all channels remain below
 * `thresholdDb` for at least `minDurationMs`.
 *
 * @param buffer AudioBuffer to analyze
 * @param thresholdDb Silence threshold in dBFS (default: -45 dB)
 * @param minDurationMs Minimum silence duration in milliseconds (default: 300 ms)
 * @returns Array of detected silent regions with start, end, and duration in seconds
 */
export function detectSilenceRegions(
  buffer: AudioBuffer,
  thresholdDb = -45,
  minDurationMs = 300,
): Array<{ start: number; end: number; duration: number }> {
  const totalFrames = buffer.length
  const sampleRate = buffer.sampleRate
  const numChannels = buffer.numberOfChannels

  if (totalFrames === 0 || numChannels === 0 || sampleRate <= 0) {
    return []
  }

  // Convert dB threshold to linear amplitude: A = 10^(dB / 20)
  const thresholdLinear = thresholdDb <= -96 ? 0 : 10 ** (thresholdDb / 20)
  const minFrames = Math.max(1, Math.round((minDurationMs / 1000) * sampleRate))

  // 10ms analysis window balances transient catching and low-frequency robustness
  const windowSize = Math.max(1, Math.round(sampleRate * 0.01))

  // Cache channel float arrays for direct fast access
  const channels: Float32Array[] = []
  for (let c = 0; c < numChannels; c++) {
    channels.push(buffer.getChannelData(c))
  }

  const regions: SilenceRegion[] = []
  let quietStartFrame: number | null = null

  for (let at = 0; at < totalFrames; at += windowSize) {
    const end = Math.min(totalFrames, at + windowSize)
    let peak = 0

    // Measure peak absolute value across all channels in this window
    for (let c = 0; c < numChannels; c++) {
      const channelData = channels[c]
      for (let i = at; i < end; i++) {
        const absVal = Math.abs(channelData[i])
        if (absVal > peak) {
          peak = absVal
        }
      }
    }

    if (peak < thresholdLinear) {
      if (quietStartFrame === null) {
        quietStartFrame = at
      }
    } else if (quietStartFrame !== null) {
      const quietEndFrame = at
      if (quietEndFrame - quietStartFrame >= minFrames) {
        const startSec = quietStartFrame / sampleRate
        const endSec = quietEndFrame / sampleRate
        regions.push({
          start: startSec,
          end: endSec,
          duration: endSec - startSec,
        })
      }
      quietStartFrame = null
    }
  }

  // Handle silence persisting until the end of the buffer
  if (quietStartFrame !== null && totalFrames - quietStartFrame >= minFrames) {
    const startSec = quietStartFrame / sampleRate
    const endSec = totalFrames / sampleRate
    regions.push({
      start: startSec,
      end: endSec,
      duration: endSec - startSec,
    })
  }

  return regions
}

/**
 * Strips detected silent sections from an AudioBuffer and concatenates surviving
 * non-silent segments with 5ms mini-crossfades to prevent clicks.
 *
 * @param buffer Input AudioBuffer
 * @param audioContext BaseAudioContext / AudioContext used to allocate the new AudioBuffer
 * @param thresholdDb Silence threshold in dBFS (default: -45 dB)
 * @param minDurationMs Minimum silence duration in ms (default: 300 ms)
 * @returns A new AudioBuffer with silence removed
 */
export function stripSilence(
  buffer: AudioBuffer,
  audioContext: AudioContext,
  thresholdDb = -45,
  minDurationMs = 300,
): AudioBuffer {
  const regions = detectSilenceRegions(buffer, thresholdDb, minDurationMs)
  const sampleRate = buffer.sampleRate
  const totalFrames = buffer.length
  const numChannels = buffer.numberOfChannels

  if (regions.length === 0) {
    // No silence to strip — clone the original buffer
    const copy = audioContext.createBuffer(
      Math.max(1, numChannels),
      Math.max(1, totalFrames),
      sampleRate,
    )
    for (let c = 0; c < numChannels; c++) {
      copy.copyToChannel(buffer.getChannelData(c), c)
    }
    return copy
  }

  // Determine non-silent segments in frame indices
  interface Segment {
    start: number
    end: number
  }

  const segments: Segment[] = []
  let cursor = 0

  for (const region of regions) {
    const regStart = Math.max(0, Math.min(totalFrames, Math.round(region.start * sampleRate)))
    const regEnd = Math.max(regStart, Math.min(totalFrames, Math.round(region.end * sampleRate)))

    if (regStart > cursor) {
      segments.push({ start: cursor, end: regStart })
    }
    cursor = Math.max(cursor, regEnd)
  }

  if (cursor < totalFrames) {
    segments.push({ start: cursor, end: totalFrames })
  }

  // If the entire audio was silent, return a minimal 1-sample silent buffer
  if (segments.length === 0) {
    return audioContext.createBuffer(Math.max(1, numChannels), 1, sampleRate)
  }

  // 5ms mini-crossfade frames
  const nominalFade = Math.round(0.005 * sampleRate)

  // Calculate crossfade overlap at each boundary between segment i and i+1
  const fades: number[] = []
  for (let i = 0; i < segments.length - 1; i++) {
    const lenA = segments[i].end - segments[i].start
    const lenB = segments[i + 1].end - segments[i + 1].start
    // Cap fade to half of either segment so fades don't overlap across short segments
    const fade = Math.min(nominalFade, Math.floor(lenA / 2), Math.floor(lenB / 2))
    fades.push(Math.max(0, fade))
  }

  const totalSegmentFrames = segments.reduce((sum, s) => sum + (s.end - s.start), 0)
  const totalFadeOverlap = fades.reduce((sum, f) => sum + f, 0)
  const outputLength = Math.max(1, totalSegmentFrames - totalFadeOverlap)

  const outBuffer = audioContext.createBuffer(
    Math.max(1, numChannels),
    outputLength,
    sampleRate,
  )

  for (let c = 0; c < numChannels; c++) {
    const src = buffer.getChannelData(c)
    const dest = outBuffer.getChannelData(c)

    let outPos = 0
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const segLen = seg.end - seg.start
      const fadePrev = i > 0 ? fades[i - 1] : 0

      // Copy and crossfade segment into output
      for (let j = 0; j < segLen; j++) {
        const destIdx = outPos + j
        if (destIdx >= outputLength) break

        const sample = src[seg.start + j]
        if (j < fadePrev && fadePrev > 0) {
          // Equal linear crossfade with ending of preceding segment
          const ramp = j / fadePrev
          dest[destIdx] = dest[destIdx] * (1 - ramp) + sample * ramp
        } else {
          dest[destIdx] = sample
        }
      }

      // If the first segment was trimmed at the start of the file, apply a 5ms edge fade-in
      if (i === 0 && seg.start > 0) {
        const edgeFade = Math.min(nominalFade, Math.floor(segLen / 2))
        for (let j = 0; j < edgeFade; j++) {
          dest[j] *= j / edgeFade
        }
      }

      // If the last segment was trimmed at the end of the file, apply a 5ms edge fade-out
      if (i === segments.length - 1 && seg.end < totalFrames) {
        const edgeFade = Math.min(nominalFade, Math.floor(segLen / 2))
        for (let j = 0; j < edgeFade; j++) {
          const at = outPos + segLen - 1 - j
          if (at >= 0 && at < outputLength) {
            dest[at] *= j / edgeFade
          }
        }
      }

      const fadeNext = i < segments.length - 1 ? fades[i] : 0
      outPos += segLen - fadeNext
    }
  }

  return outBuffer
}
