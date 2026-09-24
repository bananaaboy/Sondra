/**
 * The microphone, opened raw.
 *
 * Browsers switch on echo cancellation, noise suppression and automatic gain
 * by default. For a test that is exactly wrong: the level meter would show
 * what the browser made of the voice, and the "before" of the calibration
 * would already be an "after". So all three are off, and what is recorded is
 * what the microphone delivers.
 *
 * Recording taps the signal with a tiny AudioWorklet and keeps the samples as
 * floats — no compression in between, nothing leaves the tab.
 */

import { getAudioContext, pinOutput, resumeAudioContext } from './audio'

export interface DeviceLists {
  inputs: MediaDeviceInfo[]
  outputs: MediaDeviceInfo[]
}

export async function listDevices(): Promise<DeviceLists> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return {
    inputs: devices.filter((device) => device.kind === 'audioinput'),
    outputs: devices.filter((device) => device.kind === 'audiooutput'),
  }
}

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: string }

/** Whether this browser can send Sondra's sound to a chosen output. */
export function outputSelectable(): boolean {
  return typeof (getAudioContext() as SinkContext).setSinkId === 'function'
}

/** Routes all of Sondra's playback to one output device. */
export async function setOutputDevice(deviceId: string): Promise<void> {
  const context = getAudioContext() as SinkContext
  if (context.setSinkId) await context.setSinkId(deviceId === 'default' ? '' : deviceId)
  // A device picked by hand is kept when others come and go.
  pinOutput(deviceId !== 'default' && deviceId !== '')
}

/** What went wrong opening the microphone, said so it can be acted on. */
export function describeMicError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return (
      'Der Zugriff aufs Mikrofon wurde nicht erlaubt. Im Browser über das Schloss links in der ' +
      'Adressleiste freigeben; in Windows unter Einstellungen → Datenschutz und Sicherheit → Mikrofon ' +
      'den Zugriff für Apps und Desktop-Apps einschalten.'
    )
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'Kein Mikrofon gefunden. Ist eines angeschlossen und in Windows nicht deaktiviert?'
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return (
      'Das Mikrofon ist belegt oder lässt sich nicht öffnen — oft hält ein anderes Programm es fest ' +
      '(Teams, Discord, OBS). Dort schliessen und noch einmal versuchen.'
    )
  }
  return error instanceof Error ? error.message : String(error)
}

const TAP_SOURCE = `
class SondraTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.port.postMessage(channel.slice(0))
    return true
  }
}
registerProcessor('sondra-tap', SondraTap)
`

const tapReady = new WeakMap<BaseAudioContext, Promise<void>>()

function loadTap(context: AudioContext): Promise<void> {
  let ready = tapReady.get(context)
  if (!ready) {
    const url = URL.createObjectURL(new Blob([TAP_SOURCE], { type: 'text/javascript' }))
    ready = context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
    tapReady.set(context, ready)
  }
  return ready
}

export interface MicSession {
  readonly sampleRate: number
  readonly analyser: AnalyserNode
  /** The label of the device actually in use. */
  readonly label: string
  readonly deviceId: string
  /** Hear yourself through the output — with headphones, or it feeds back. */
  setMonitor: (on: boolean) => void
  /**
   * Records up to `seconds`. Resolves early, with what was captured so far,
   * when `signal` aborts.
   */
  record: (seconds: number, onProgress?: (fraction: number) => void, signal?: AbortSignal) => Promise<Float32Array<ArrayBuffer>>
  close: () => void
}

export async function openMicrophone(deviceId?: string): Promise<MicSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  })
  await resumeAudioContext()
  const context = getAudioContext()
  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 2048
  source.connect(analyser)

  const monitor = context.createGain()
  monitor.gain.value = 0
  source.connect(monitor).connect(context.destination)

  const track = stream.getAudioTracks()[0]
  const settings = track?.getSettings() ?? {}

  let tap: AudioWorkletNode | null = null
  const listeners = new Set<(chunk: Float32Array) => void>()
  try {
    await loadTap(context)
    tap = new AudioWorkletNode(context, 'sondra-tap')
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => listeners.forEach((listener) => listener(event.data))
    // A worklet only runs while it is part of a graph that reaches the output;
    // a muted gain keeps it there without making a sound.
    const sink = context.createGain()
    sink.gain.value = 0
    source.connect(tap).connect(sink).connect(context.destination)
  } catch {
    tap = null
  }

  // Older engines without AudioWorklet: the deprecated processor still works.
  let processor: ScriptProcessorNode | null = null
  if (!tap) {
    processor = context.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (event) => {
      const chunk = new Float32Array(event.inputBuffer.getChannelData(0))
      listeners.forEach((listener) => listener(chunk))
    }
    const sink = context.createGain()
    sink.gain.value = 0
    source.connect(processor).connect(sink).connect(context.destination)
  }

  return {
    sampleRate: context.sampleRate,
    analyser,
    label: track?.label || 'Mikrofon',
    deviceId: settings.deviceId ?? deviceId ?? '',
    setMonitor: (on) => {
      monitor.gain.setTargetAtTime(on ? 1 : 0, context.currentTime, 0.02)
    },
    record: (seconds, onProgress, signal) =>
      new Promise((resolve) => {
        const wanted = Math.round(seconds * context.sampleRate)
        const chunks: Float32Array[] = []
        let have = 0
        const finish = () => {
          listeners.delete(listener)
          signal?.removeEventListener('abort', finish)
          const out = new Float32Array(Math.min(have, wanted))
          let at = 0
          for (const chunk of chunks) {
            const take = Math.min(chunk.length, out.length - at)
            out.set(chunk.subarray(0, take), at)
            at += take
            if (at >= out.length) break
          }
          resolve(out)
        }
        const listener = (chunk: Float32Array) => {
          chunks.push(chunk)
          have += chunk.length
          onProgress?.(Math.min(1, have / wanted))
          if (have >= wanted) finish()
        }
        listeners.add(listener)
        signal?.addEventListener('abort', finish)
      }),
    close: () => {
      listeners.clear()
      try {
        source.disconnect()
        monitor.disconnect()
        tap?.disconnect()
        processor?.disconnect()
      } catch {
        /* already gone */
      }
      stream.getTracks().forEach((each) => each.stop())
    },
  }
}

/** RMS and peak of what the analyser currently holds, in dBFS. */
export function readLevels(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): { rmsDb: number; peakDb: number } {
  analyser.getFloatTimeDomainData(buffer)
  let sum = 0
  let peak = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const value = buffer[i]
    sum += value * value
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
  }
  const rms = Math.sqrt(sum / buffer.length)
  return {
    rmsDb: rms > 1e-6 ? 20 * Math.log10(rms) : -120,
    peakDb: peak > 1e-6 ? 20 * Math.log10(peak) : -120,
  }
}
