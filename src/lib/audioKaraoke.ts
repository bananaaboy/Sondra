/**
 * Real-time Mid-Side Karaoke / Vocal Suppressor using Web Audio API.
 *
 * Suppresses center-panned vocals via phase cancellation (L - R) while preserving
 * low-end bass (< 130 Hz) and high-end air/reverb (> 7.5 kHz).
 */

export interface KaraokeProcessor {
  input: GainNode
  output: GainNode
  setEnabled: (enabled: boolean) => void
}

export function createKaraokeProcessor(context: AudioContext): KaraokeProcessor {
  const input = context.createGain()
  const output = context.createGain()

  // Direct bypass path
  const bypassGain = context.createGain()
  bypassGain.gain.value = 1

  // Effect path
  const effectGain = context.createGain()
  effectGain.gain.value = 0

  // 1. Bass preservation (< 130 Hz) so kick and bass remain punchy
  const bassFilter = context.createBiquadFilter()
  bassFilter.type = 'lowpass'
  bassFilter.frequency.value = 130
  bassFilter.Q.value = 0.707

  // 2. High preservation (> 7500 Hz) so hi-hats and room air remain
  const highFilter = context.createBiquadFilter()
  highFilter.type = 'highpass'
  highFilter.frequency.value = 7500
  highFilter.Q.value = 0.707

  // 3. Mid vocal cancellation path (130 Hz - 7500 Hz)
  const vocalHighpass = context.createBiquadFilter()
  vocalHighpass.type = 'highpass'
  vocalHighpass.frequency.value = 130

  const vocalLowpass = context.createBiquadFilter()
  vocalLowpass.type = 'lowpass'
  vocalLowpass.frequency.value = 7500

  // Split stereo channels
  const splitter = context.createChannelSplitter(2)
  const gainL = context.createGain()
  gainL.gain.value = 1.0
  const gainR = context.createGain()
  gainR.gain.value = -1.0 // Inverted right channel

  const diffMerger = context.createGain()
  diffMerger.gain.value = 0.8 // Level compensation for difference signal

  // Route bypass
  input.connect(bypassGain)
  bypassGain.connect(output)

  // Route effect path
  input.connect(effectGain)

  // Bass & treble straight to output
  effectGain.connect(bassFilter)
  bassFilter.connect(output)

  effectGain.connect(highFilter)
  highFilter.connect(output)

  // Vocal band phase subtraction:
  effectGain.connect(vocalHighpass)
  vocalHighpass.connect(vocalLowpass)
  vocalLowpass.connect(splitter)

  splitter.connect(gainL, 0)
  splitter.connect(gainR, 1)

  gainL.connect(diffMerger)
  gainR.connect(diffMerger)

  // Connect cancelled difference signal to output
  diffMerger.connect(output)

  const setEnabled = (enabled: boolean) => {
    const now = context.currentTime
    if (enabled) {
      bypassGain.gain.setTargetAtTime(0, now, 0.02)
      effectGain.gain.setTargetAtTime(1, now, 0.02)
    } else {
      bypassGain.gain.setTargetAtTime(1, now, 0.02)
      effectGain.gain.setTargetAtTime(0, now, 0.02)
    }
  }

  return { input, output, setEnabled }
}
