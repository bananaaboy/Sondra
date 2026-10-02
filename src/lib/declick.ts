/**
 * Clicks and crackle out: vinyl ticks, a cable touched, a mouth click on a
 * microphone.
 *
 * A click is a few samples that jump where the waveform cannot: the second
 * difference of the signal spikes far above its local level. That level is a
 * median per block, so loud music raises the bar with it. Spikes close
 * together become one region; regions longer than a few milliseconds are left
 * alone, because that is a drum, a consonant or a pluck rather than damage.
 *
 * A region is filled by prediction: a linear predictor learned from the
 * samples just before it runs forward into the gap, one learned from just
 * after runs backward, and the two are crossfaded. For gaps this short that
 * is inaudible, where a straight line would sound dull or leave a step.
 * Channels are repaired at the same places, so a stereo click does not move.
 */

import type { AudioData, Samples } from './wav'

export type ClickStrength = 'sanft' | 'mittel' | 'stark'

const SETTINGS: Record<ClickStrength, { factor: number; maxMs: number }> = {
  sanft: { factor: 11, maxMs: 2 },
  mittel: { factor: 7.5, maxMs: 3 },
  stark: { factor: 5, maxMs: 5 },
}

const BLOCK = 2048
const ORDER = 16
const CONTEXT = 512

/** Median of |second difference| per block, from every fourth sample. */
function blockScale(diff: Float32Array): Float32Array {
  const blocks = Math.ceil(diff.length / BLOCK)
  const scale = new Float32Array(blocks)
  const picks: number[] = []
  for (let b = 0; b < blocks; b += 1) {
    picks.length = 0
    for (let i = b * BLOCK; i < Math.min(diff.length, (b + 1) * BLOCK); i += 4) picks.push(Math.abs(diff[i]))
    picks.sort((x, y) => x - y)
    scale[b] = picks.length ? picks[Math.floor(picks.length / 2)] : 0
  }
  return scale
}

/**
 * Prediction coefficients from `samples`, by least squares over the samples
 * themselves (the covariance method). The autocorrelation shortcut assumes a
 * long window; over a few hundred samples of a low note it returns a
 * predictor that cannot even follow a sine.
 */
function predictor(samples: Float32Array, order: number): Float64Array {
  const n = order
  const matrix = Array.from({ length: n }, () => new Float64Array(n + 1))
  for (let t = order; t < samples.length; t += 1) {
    for (let i = 0; i < n; i += 1) {
      const xi = samples[t - 1 - i]
      matrix[i][n] += xi * samples[t]
      for (let j = i; j < n; j += 1) matrix[i][j] += xi * samples[t - 1 - j]
    }
  }
  let trace = 0
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < i; j += 1) matrix[i][j] = matrix[j][i]
    trace += matrix[i][i]
  }
  const coefficients = new Float64Array(order + 1)
  if (trace <= 1e-12) return coefficients
  // A whisper of ridge keeps silence and pure tones from making it singular.
  for (let i = 0; i < n; i += 1) matrix[i][i] += (trace / n) * 1e-6
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let row = col + 1; row < n; row += 1) if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row
    ;[matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]]
    const lead = matrix[col][col]
    if (Math.abs(lead) < 1e-18) return coefficients
    for (let row = col + 1; row < n; row += 1) {
      const factor = matrix[row][col] / lead
      for (let k = col; k <= n; k += 1) matrix[row][k] -= factor * matrix[col][k]
    }
  }
  for (let row = n - 1; row >= 0; row -= 1) {
    let value = matrix[row][n]
    for (let k = row + 1; k < n; k += 1) value -= matrix[row][k] * coefficients[k + 1]
    coefficients[row + 1] = value / matrix[row][row]
  }
  return coefficients
}

/** Continues `history` (oldest first) by `count` samples. */
function extrapolate(history: Float32Array, coefficients: Float64Array, count: number): Float32Array {
  const order = coefficients.length - 1
  const buffer = new Float32Array(history.length + count)
  buffer.set(history)
  for (let n = history.length; n < buffer.length; n += 1) {
    let value = 0
    for (let j = 1; j <= order; j += 1) value += coefficients[j] * buffer[n - j]
    buffer[n] = value
  }
  return buffer.subarray(history.length)
}

/** A smooth curve from the last good sample before to the first after. */
function bridge(channel: Samples, from: number, to: number) {
  const gap = to - from
  const left = from > 0 ? channel[from - 1] : (channel[to] ?? 0)
  const right = to < channel.length ? channel[to] : left
  for (let i = 0; i < gap; i += 1) {
    const t = (i + 1) / (gap + 1)
    const s = t * t * (3 - 2 * t)
    channel[from + i] = left + (right - left) * s
  }
}

function repair(channel: Samples, from: number, to: number) {
  const gap = to - from
  const before = channel.subarray(Math.max(0, from - CONTEXT), from)
  const after = channel.subarray(to, Math.min(channel.length, to + CONTEXT))
  if (before.length < ORDER * 2 || after.length < ORDER * 2) return bridge(channel, from, to)
  let ceiling = 0
  for (const value of before) ceiling = Math.max(ceiling, Math.abs(value))
  for (const value of after) ceiling = Math.max(ceiling, Math.abs(value))
  // A predictor that runs away from what surrounds the gap is not trusted:
  // a tone does not suddenly grow louder inside a two-millisecond hole.
  const sane = (values: Float32Array) => values.every((value) => Number.isFinite(value) && Math.abs(value) <= ceiling * 1.25 + 1e-4)
  const forward = extrapolate(before, predictor(before, ORDER), gap)
  const reversedAfter = after.slice().reverse()
  const backward = extrapolate(reversedAfter, predictor(reversedAfter, ORDER), gap).reverse()
  const forwardOk = sane(forward)
  const backwardOk = sane(backward)
  if (!forwardOk && !backwardOk) return bridge(channel, from, to)
  for (let i = 0; i < gap; i += 1) {
    const w = (i + 1) / (gap + 1)
    const a = forwardOk ? forward[i] : backward[i]
    const b = backwardOk ? backward[i] : forward[i]
    channel[from + i] = a * (1 - w) + b * w
  }
}

export function removeClicks(audio: AudioData, strength: ClickStrength): { audio: AudioData; repaired: number } {
  const { factor, maxMs } = SETTINGS[strength]
  const rate = audio.sampleRate
  const length = audio.channels[0]?.length ?? 0
  const margin = Math.max(2, Math.round(rate * 0.0001))
  const join = Math.round(rate * 0.001)
  const longest = Math.round((rate * maxMs) / 1000)

  // Where any channel jumps.
  const flagged = new Uint8Array(length)
  const diffs = audio.channels.map((channel) => {
    const diff = new Float32Array(length)
    for (let i = 2; i < length; i += 1) diff[i] = channel[i] - 2 * channel[i - 1] + channel[i - 2]
    const scale = blockScale(diff)
    for (let i = 2; i < length; i += 1) {
      const level = scale[Math.floor(i / BLOCK)]
      if (Math.abs(diff[i]) > factor * Math.max(level, 1e-5)) flagged[i] = 1
    }
    return diff
  })
  const near = Math.round(rate * 0.005)
  /**
   * A click stands out against the few milliseconds right around it, too. A
   * snare or a hiss is just as rough on both sides and is left alone.
   */
  const isolated = (from: number, to: number) =>
    diffs.some((diff) => {
      let peak = 0
      for (let k = from; k < to; k += 1) peak = Math.max(peak, Math.abs(diff[k]))
      const around: number[] = []
      for (let k = Math.max(2, from - near); k < from; k += 1) around.push(Math.abs(diff[k]))
      for (let k = to; k < Math.min(length, to + near); k += 1) around.push(Math.abs(diff[k]))
      if (around.length < 8) return true
      around.sort((x, y) => x - y)
      return peak > factor * Math.max(around[Math.floor(around.length / 2)], 1e-5)
    })

  // Flags into regions: widened a little, near ones joined, long ones dropped.
  const regions: [number, number][] = []
  let i = 0
  while (i < length) {
    if (!flagged[i]) {
      i += 1
      continue
    }
    let end = i
    let j = i
    while (j < length && j - end <= join) {
      if (flagged[j]) end = j
      j += 1
    }
    const from = Math.max(0, i - margin)
    const to = Math.min(length, end + margin + 1)
    if (to - from <= longest && isolated(from, to)) regions.push([from, to])
    i = j
  }

  const channels = audio.channels.map((channel) => {
    const copy = new Float32Array(channel)
    for (const [from, to] of regions) repair(copy, from, to)
    return copy
  })
  return { audio: { channels, sampleRate: rate }, repaired: regions.length }
}
