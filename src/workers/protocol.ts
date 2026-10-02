/**
 * Message contracts shared by the main thread and the DSP workers.
 *
 * Audio crosses the boundary as planar Float32Arrays whose backing buffers are
 * transferred rather than copied, so handing a 10-minute stereo track to a
 * worker costs nothing beyond the structured-clone of the wrapper object.
 */

import type { LoudnessReport, NormalizationSettings } from '../lib/loudness'
import type { SeparationOptions, StemId } from '../lib/separation'
import type { Samples } from '../lib/wav'

export interface PlainAudio {
  channels: Samples[]
  sampleRate: number
}

export interface JobProgress {
  type: 'progress'
  id: number
  fraction: number
  note?: string
}

export interface JobError {
  type: 'error'
  id: number
  message: string
}

/* --- loudness worker ------------------------------------------------------ */

export type LoudnessRequest =
  | { type: 'measure'; id: number; audio: PlainAudio }
  | { type: 'normalize'; id: number; audio: PlainAudio; settings: NormalizationSettings }

export type LoudnessResponse =
  | JobProgress
  | JobError
  | { type: 'measured'; id: number; report: LoudnessReport }
  | {
      type: 'normalized'
      id: number
      audio: PlainAudio
      before: LoudnessReport
      after: LoudnessReport
      plan: import('../lib/loudness').GainPlan
    }

/* --- stems worker --------------------------------------------------------- */

export interface StemsRequest {
  type: 'separate'
  id: number
  audio: PlainAudio
  options: SeparationOptions
  /** Raw .onnx bytes. When absent the built-in DSP engine runs. */
  model: Uint8Array | null
  threads: number
  preferWebGpu: boolean
}

export type StemsResponse =
  | JobProgress
  | JobError
  | {
      type: 'separated'
      id: number
      stems: Record<StemId, PlainAudio>
      engine: 'dsp' | 'onnx'
      provider?: string
    }

/* --- sampler worker ------------------------------------------------------- */

export interface SamplerRequest {
  type: 'render'
  id: number
  audio: PlainAudio
  semitones: number
  stretchFactor: number
  preserveDuration: boolean
}

export type SamplerResponse = JobProgress | JobError | { type: 'rendered'; id: number; audio: PlainAudio }

/* --- harmony worker ------------------------------------------------------- */

export interface HarmonyRequest {
  type: 'analyse'
  id: number
  audio: PlainAudio
  /** Chord window in seconds. */
  chordWindow: number
  /** Run the pitch tracker too; it is the expensive half. */
  transcribe: boolean
  minimumClarity: number
  minimumNoteSeconds: number
  /** Snap note starts to this grid. 0 disables it. */
  quantizeSeconds: number
}

export type HarmonyResponse =
  | JobProgress
  | JobError
  | {
      type: 'analysed'
      id: number
      key: import('../lib/key').KeyEstimate
      chords: import('../lib/key').ChordSpan[]
      chroma: Float32Array
      notes: import('../lib/pitch').Note[]
    }

/* --- speech recognition worker ------------------------------------------- */

export interface TranscriptSegment {
  /** Seconds in the file. */
  start: number
  end: number
  text: string
}

export type TranscribeRequest =
  | {
      type: 'transcribe'
      id: number
      /** Mono, 16 kHz — what Whisper hears. */
      samples: Float32Array
      /** A Hugging Face model id, e.g. onnx-community/whisper-base. */
      model: string
      /** ISO 639-1, or `auto` to let the model decide. */
      language: string
    }
  | { type: 'cancel'; id: number }

export type TranscribeResponse =
  | { type: 'loading'; id: number; loaded: number; total: number }
  | { type: 'progress'; id: number; fraction: number; done: number }
  | { type: 'partial'; id: number; segments: TranscriptSegment[] }
  | { type: 'done'; id: number; segments: TranscriptSegment[] }
  | { type: 'error'; id: number; message: string; aborted: boolean }
