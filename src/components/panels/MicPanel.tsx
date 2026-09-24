/**
 * Microphone: test it, pick the devices, and set it up for a purpose.
 *
 * Three things on one page, in the order they are needed. First the devices
 * and a level meter — does anything arrive at all, and how loud. Then an
 * optional test recording to hear oneself. Then the calibration: say what the
 * recording is for, stay quiet for three seconds, talk for eight, and get the
 * cleaned result next to the raw one with a plain list of every step taken
 * and the values it used.
 *
 * The microphone is opened raw (no browser noise suppression, no automatic
 * gain) so the "without filters" really is without. Everything stays in this
 * tab; the microphone is released the moment the tool is left.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { decodeWithBrowser, playTestTone } from '../../lib/audio'
import { saveBytes } from '../../lib/download'
import { calibrate, PURPOSES, profileFor, type CalibrationResult, type MicPurpose } from '../../lib/micCalibrate'
import {
  describeMicError,
  listDevices,
  openMicrophone,
  outputSelectable,
  readLevels,
  setOutputDevice,
  type DeviceLists,
  type MicSession,
} from '../../lib/micInput'
import { encodeWav, type AudioData } from '../../lib/wav'
import { useAssetsOfKind, useSession } from '../../state/store'
import { AudioPreview } from '../AudioPreview'
import { ArrowRight, Button, Field, Notice, Progress, Select, Stat, Toggle } from '../ui/primitives'

const NOISE_SECONDS = 3
const SPEECH_SECONDS = 8
const PROBE_SECONDS = 15

const fmt = (value: number, digits = 1) =>
  Number.isFinite(value) && value > -150 ? value.toFixed(digits).replace('.', ',').replace('-', '−') : '—'

/* -------------------------------------------------------------------------- */

/**
 * A level meter that repaints itself.
 *
 * It writes to the DOM directly from its own animation frame: sixty React
 * renders a second for a bar that moves would cost more than the recording.
 */
function LevelMeter({ analyser, compact = false }: { analyser: AnalyserNode; compact?: boolean }) {
  const barRef = useRef<HTMLDivElement>(null)
  const peakRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const buffer = new Float32Array(analyser.fftSize)
    let frame = 0
    let hold = -120
    let holdUntil = 0
    let lastText = 0
    const toPercent = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
    const paint = (now: number) => {
      const { rmsDb, peakDb } = readLevels(analyser, buffer)
      if (peakDb > hold || now > holdUntil) {
        hold = peakDb
        holdUntil = now + 1200
      }
      if (barRef.current) barRef.current.style.width = `${toPercent(rmsDb)}%`
      if (peakRef.current) {
        peakRef.current.style.left = `${toPercent(hold)}%`
        peakRef.current.dataset.over = hold > -1 ? 'true' : 'false'
      }
      if (textRef.current && now - lastText > 200) {
        lastText = now
        textRef.current.textContent = `${fmt(rmsDb)} dBFS · Spitze ${fmt(hold)}`
      }
      frame = requestAnimationFrame(paint)
    }
    frame = requestAnimationFrame(paint)
    return () => cancelAnimationFrame(frame)
  }, [analyser])

  return (
    <div className="flex flex-col gap-[6px]">
      <div
        className={`relative w-full overflow-hidden bg-panel-soft ${compact ? 'h-[10px]' : 'h-[16px]'}`}
        role="meter"
        aria-label="Eingangspegel"
        aria-valuemin={-60}
        aria-valuemax={0}
      >
        {/* The last six dB are the danger zone; marked, not coloured red — the
            palette has no red and needs none. */}
        <div aria-hidden className="absolute inset-y-0 right-0 w-[10%] bg-panel-mid" />
        <div ref={barRef} className="absolute inset-y-0 left-0 bg-ink transition-[width] duration-75" style={{ width: '0%' }} />
        <div
          ref={peakRef}
          aria-hidden
          className="absolute inset-y-0 w-[2px] -translate-x-[1px] bg-ink data-[over=true]:w-[4px]"
          style={{ left: '0%' }}
        />
      </div>
      <div className="flex items-baseline justify-between gap-[12px] text-micro text-muted">
        <span className="value">−60</span>
        <span ref={textRef} className="value text-small text-ink" aria-live="off" />
        <span className="value">0 dBFS</span>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

type Phase = 'choose' | 'noise' | 'speech' | 'working' | 'done'

export function MicPanel() {
  const addAsset = useSession((state) => state.addAsset)
  const log = useSession((state) => state.log)
  const audioAssets = useAssetsOfKind('audio')

  const [session, setSession] = useState<MicSession | null>(null)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [devices, setDevices] = useState<DeviceLists>({ inputs: [], outputs: [] })
  const [inputId, setInputId] = useState('')
  const [outputId, setOutputId] = useState('default')
  /** What the test tone found: the state of Sondra's sound, in numbers. */
  const [toneReport, setToneReport] = useState<string | null>(null)
  const [monitor, setMonitor] = useState(false)

  const [probe, setProbe] = useState<AudioData | null>(null)
  const [probing, setProbing] = useState<number | null>(null)
  const probeAbort = useRef<AbortController | null>(null)

  const [purpose, setPurpose] = useState<MicPurpose>('podcast')
  const [phase, setPhase] = useState<Phase>('choose')
  const [phaseProgress, setPhaseProgress] = useState(0)
  const [result, setResult] = useState<CalibrationResult | null>(null)
  const [calError, setCalError] = useState<string | null>(null)
  const calAbort = useRef<AbortController | null>(null)
  const [applyTo, setApplyTo] = useState('')
  const [applying, setApplying] = useState(false)

  const sessionRef = useRef<MicSession | null>(null)
  sessionRef.current = session

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await listDevices())
    } catch {
      /* the lists stay as they were */
    }
  }, [])

  const open = useCallback(
    async (deviceId?: string) => {
      setOpening(true)
      setError(null)
      try {
        sessionRef.current?.close()
        const next = await openMicrophone(deviceId || undefined)
        setSession(next)
        setInputId(next.deviceId)
        next.setMonitor(false)
        setMonitor(false)
        await refreshDevices()
        log('mikrofon', `${next.label} geöffnet, ${next.sampleRate} Hz, ohne Browser-Filter`)
      } catch (failure) {
        setSession(null)
        setError(describeMicError(failure))
      } finally {
        setOpening(false)
      }
    },
    [log, refreshDevices],
  )

  // Released on the way out: a microphone left open is a red dot in the
  // taskbar and a reason to distrust the whole app.
  useEffect(
    () => () => {
      probeAbort.current?.abort()
      calAbort.current?.abort()
      sessionRef.current?.close()
    },
    [],
  )

  useEffect(() => {
    const onChange = () => void refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange)
  }, [refreshDevices])

  const close = () => {
    probeAbort.current?.abort()
    calAbort.current?.abort()
    session?.close()
    setSession(null)
    setMonitor(false)
    log('mikrofon', 'Mikrofon ausgeschaltet')
  }

  const recordProbe = async () => {
    if (!session) return
    if (probing !== null) {
      probeAbort.current?.abort()
      return
    }
    const controller = new AbortController()
    probeAbort.current = controller
    setProbing(0)
    setProbe(null)
    const samples = await session.record(PROBE_SECONDS, (fraction) => setProbing(fraction), controller.signal)
    setProbing(null)
    if (samples.length > session.sampleRate * 0.3) setProbe({ channels: [samples], sampleRate: session.sampleRate })
  }

  const runCalibration = async () => {
    if (!session) return
    const controller = new AbortController()
    calAbort.current = controller
    setCalError(null)
    setResult(null)
    try {
      setPhase('noise')
      setPhaseProgress(0)
      // A breath between pressing the button and the silent take: the click
      // of the mouse should not end up in the room's noise profile.
      await new Promise((resolve) => setTimeout(resolve, 600))
      const noise = await session.record(NOISE_SECONDS, setPhaseProgress, controller.signal)
      if (controller.signal.aborted) throw new DOMException('abgebrochen', 'AbortError')

      setPhase('speech')
      setPhaseProgress(0)
      const speech = await session.record(SPEECH_SECONDS, setPhaseProgress, controller.signal)
      if (controller.signal.aborted) throw new DOMException('abgebrochen', 'AbortError')

      setPhase('working')
      await new Promise((resolve) => setTimeout(resolve, 30))
      const done = calibrate(noise, speech, session.sampleRate, purpose)
      setResult(done)
      setPhase('done')
      log(
        'mikrofon',
        `Eingestellt für ${profileFor(purpose).label}: Abstand ${fmt(done.before.snrDb)} → ${fmt(done.after.snrDb)} dB`,
      )
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') {
        setPhase('choose')
        return
      }
      setCalError(failure instanceof Error ? failure.message : String(failure))
      setPhase('choose')
    }
  }

  const keepProcessed = () => {
    if (!result) return
    const bytes = encodeWav(result.processed, 24)
    const name = `mikrofon-${purpose}-gefiltert.wav`
    addAsset({
      name,
      bytes,
      mime: 'audio/wav',
      sizeBytes: bytes.byteLength,
      kind: 'audio',
      audio: result.processed,
      durationSeconds: result.processed.channels[0].length / result.processed.sampleRate,
      origin: 'derived',
    })
    log('mikrofon', `${name} in die Sitzung übernommen`)
  }

  const applyToAsset = async () => {
    const asset = audioAssets.find((entry) => entry.id === applyTo)
    if (!asset || !result) return
    setApplying(true)
    setCalError(null)
    try {
      const source = asset.audio ?? (await decodeWithBrowser(asset.bytes.slice().buffer as ArrayBuffer))
      await new Promise((resolve) => setTimeout(resolve, 30))
      const cleaned = result.apply(source)
      const bytes = encodeWav(cleaned, 24)
      const name = `${asset.name.replace(/\.[^.]+$/, '')}-${purpose}.wav`
      addAsset({
        name,
        bytes,
        mime: 'audio/wav',
        sizeBytes: bytes.byteLength,
        kind: 'audio',
        audio: cleaned,
        durationSeconds: cleaned.channels[0].length / cleaned.sampleRate,
        origin: 'derived',
      })
      log('mikrofon', `Einstellung auf ${asset.name} angewendet → ${name}`)
    } catch (failure) {
      setCalError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setApplying(false)
    }
  }

  const profile = profileFor(purpose)
  const busy = phase === 'noise' || phase === 'speech' || phase === 'working'

  /* -- before the microphone is on ------------------------------------------ */

  if (!session) {
    return (
      <div className="flex max-w-[760px] flex-col gap-[16px]">
        <h2 className="display-md">Mikrofon testen und einstellen</h2>
        <p className="text-body leading-[1.55] text-prose">
          Hören, ob es ankommt und wie laut. Dann für Podcast, Stream, Videocall oder Musik einstellen:
          drei Sekunden Ruhe, acht Sekunden sprechen — Sondra misst den Raum, nimmt Rauschen und
          Brummen heraus und zeigt genau, was es getan hat.
        </p>
        <p className="text-small text-muted">Die Aufnahmen bleiben in diesem Tab. Nichts wird gesendet.</p>
        <div className="flex flex-wrap items-center gap-[8px]">
          <Button onClick={() => void open()} disabled={opening}>
            {opening ? 'Wird geöffnet…' : 'Mikrofon einschalten'}
            {!opening ? <ArrowRight /> : null}
          </Button>
          {/* The other direction needs no microphone: does Sondra's sound
              come out at all, and where. */}
          <Button variant="quiet" onClick={() => void playTestTone().then(setToneReport)}>
            Ausgang testen
          </Button>
        </div>
        {toneReport ? <p className="value text-small text-muted">{toneReport}</p> : null}
        {error ? (
          <Notice tone="error" title="Das Mikrofon liess sich nicht öffnen">
            {error}
          </Notice>
        ) : null}
      </div>
    )
  }

  /* -- with the microphone on ------------------------------------------------ */

  const canPickOutput = outputSelectable()

  return (
    <div className="grid max-w-[960px] grid-cols-[minmax(0,1fr)] gap-[32px]">
      {/* ---- devices and level ------------------------------------------- */}
      <section className="flex flex-col gap-[16px]">
        <div className="flex flex-wrap items-baseline justify-between gap-[12px]">
          <h2 className="display-md">Mikrofon</h2>
          <Button size="sm" variant="quiet" onClick={close}>
            Mikrofon ausschalten
          </Button>
        </div>

        <div className="grid gap-[16px] sm:grid-cols-2">
          <Field label="Eingang">
            <Select
              value={inputId}
              disabled={busy || opening}
              onChange={(event) => {
                setInputId(event.target.value)
                void open(event.target.value)
              }}
            >
              {devices.inputs.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>
                  {device.label || `Mikrofon ${index + 1}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Ausgang"
            hint={canPickOutput ? undefined : 'Dieser Browser spielt immer über das Standardgerät ab.'}
          >
            <Select
              value={outputId}
              disabled={!canPickOutput || devices.outputs.length === 0}
              onChange={async (event) => {
                const id = event.target.value
                setOutputId(id)
                try {
                  await setOutputDevice(id)
                  log('mikrofon', `Ausgabe auf ${event.target.selectedOptions[0]?.text ?? id}`)
                } catch (failure) {
                  setError(describeMicError(failure))
                }
              }}
            >
              {devices.outputs.length === 0 ? <option value="default">Standardgerät</option> : null}
              {devices.outputs.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>
                  {device.label || `Ausgang ${index + 1}`}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end gap-[8px] sm:col-span-2">
            <Button size="sm" variant="quiet" onClick={() => void playTestTone().then(setToneReport)}>
              Ausgang testen
            </Button>
            {toneReport ? <span className="value pb-[6px] text-small text-muted">{toneReport}</span> : null}
          </div>
        </div>

        <LevelMeter analyser={session.analyser} />

        <div className="grid gap-[16px] sm:grid-cols-2">
          <Toggle
            label="Mithören"
            hint="Sich selbst über den Ausgang hören. Nur mit Kopfhörern — über Lautsprecher pfeift es."
            checked={monitor}
            onChange={(value) => {
              setMonitor(value)
              session.setMonitor(value)
            }}
          />
          <div className="flex flex-col gap-[8px]">
            <div className="flex flex-wrap items-center gap-[8px]">
              <Button size="sm" variant={probing !== null ? 'primary' : 'quiet'} onClick={() => void recordProbe()} disabled={busy}>
                {probing !== null ? 'Probe beenden' : probe ? 'Neue Probe aufnehmen' : 'Probe aufnehmen'}
              </Button>
              <span className="text-small text-muted">bis {PROBE_SECONDS} Sekunden, zum Anhören</span>
            </div>
            {probing !== null ? <Progress value={probing} label="Nimmt auf" /> : null}
          </div>
        </div>
        {probe ? <AudioPreview sources={[{ id: 'probe', label: 'Probe', audio: probe }]} waveHeight={40} /> : null}

        {error ? (
          <Notice tone="error" title="Gerät">
            {error}
          </Notice>
        ) : null}
      </section>

      {/* ---- calibration ---------------------------------------------------- */}
      <section className="flex flex-col gap-[16px] border-t border-line pt-[24px]">
        <div className="flex flex-col gap-[4px]">
          <h3 className="text-subheading font-semibold text-ink">Einstellen</h3>
          <p className="text-small leading-[1.5] text-prose">
            Erst sagen, wofür. Das entscheidet, wie stark gefiltert wird: eine Stimme im Videocall darf
            gründlich gereinigt werden, ein Instrument soll klingen wie es klingt.
          </p>
        </div>

        <div role="radiogroup" aria-label="Wofür" className="grid grid-cols-1 gap-[8px] sm:grid-cols-2 lg:grid-cols-3">
          {PURPOSES.map((entry) => {
            const active = entry.id === purpose
            return (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={busy}
                onClick={() => {
                  setPurpose(entry.id)
                  setResult(null)
                  setPhase('choose')
                }}
                className={`press flex flex-col gap-[4px] rounded-card px-[16px] py-[14px] text-left transition-colors disabled:opacity-60 ${
                  active ? 'bg-ink text-on-ink' : 'bg-panel-soft text-ink hover:bg-panel-mid'
                }`}
              >
                <span className="text-body font-semibold">{entry.label}</span>
                <span className={`text-small leading-[1.4] ${active ? 'text-on-ink/85' : 'text-prose'}`}>{entry.hint}</span>
              </button>
            )
          })}
        </div>

        {phase === 'choose' || phase === 'done' ? (
          <div className="flex flex-wrap items-center gap-[12px]">
            <Button onClick={() => void runCalibration()}>
              {phase === 'done' ? 'Neu einstellen' : `Für ${profile.label} einstellen`}
              <ArrowRight />
            </Button>
            <span className="text-small text-muted">
              {NOISE_SECONDS} s Ruhe, dann {SPEECH_SECONDS} s {profile.id === 'instrument' ? 'spielen' : profile.id === 'vocals' ? 'singen' : 'sprechen'}
            </span>
          </div>
        ) : null}

        {phase === 'noise' || phase === 'speech' ? (
          <div className="flex flex-col gap-[12px] rounded-card bg-panel-soft p-[20px]" aria-live="polite">
            <p className="text-[1.25rem] font-semibold leading-[1.3] text-ink">
              {phase === 'noise' ? 'Jetzt bitte ruhig sein' : profile.id === 'instrument' ? 'Jetzt spielen' : profile.id === 'vocals' ? 'Jetzt singen' : 'Jetzt sprechen'}
            </p>
            <p className="text-body leading-[1.5] text-prose">
              {phase === 'noise'
                ? 'Nicht sprechen, nicht tippen, die Maus ruhen lassen. Gemessen wird, wie der Raum klingt, wenn niemand etwas sagt.'
                : profile.id === 'podcast' || profile.id === 'streaming' || profile.id === 'meeting'
                  ? `${profile.prompt} Zum Beispiel: „Heute teste ich mein Mikrofon. Es soll klar klingen, auch wenn es um mich herum nicht ganz still ist.“`
                  : profile.prompt}
            </p>
            <LevelMeter analyser={session.analyser} compact />
            <Progress
              value={phaseProgress}
              label={`noch ${Math.max(0, Math.ceil((1 - phaseProgress) * (phase === 'noise' ? NOISE_SECONDS : SPEECH_SECONDS)))} s`}
            />
            <div>
              <Button size="sm" variant="ghost" onClick={() => calAbort.current?.abort()}>
                Abbrechen
              </Button>
            </div>
          </div>
        ) : null}

        {phase === 'working' ? <Progress value={null} label="Wird ausgewertet…" /> : null}

        {calError ? (
          <Notice tone="error" title="Hat nicht geklappt">
            {calError}
          </Notice>
        ) : null}

        {phase === 'done' && result ? (
          <div className="flex flex-col gap-[24px]">
            <div className="flex flex-col gap-[8px]">
              <h4 className="text-body font-semibold text-ink">Vorher und nachher anhören</h4>
              <p className="text-small text-muted">
                Umschalten während des Abspielens — die Stelle bleibt dieselbe.
              </p>
              <AudioPreview
                sources={[
                  { id: 'ohne', label: 'Ohne Filter', audio: result.raw },
                  { id: 'mit', label: 'Mit Filtern', audio: result.processed },
                ]}
              />
            </div>

            <div className="grid gap-x-[32px] gap-y-[0px] sm:grid-cols-2">
              <Stat
                label="Abstand Stimme zu Hintergrund"
                note="je grösser, desto klarer"
                value={`${fmt(result.before.snrDb)} → ${fmt(result.after.snrDb)}`}
                unit="dB"
                emphasis
              />
              <Stat
                label="Hintergrund"
                note="Grundrauschen in der Ruhe-Aufnahme"
                value={`${fmt(result.before.noiseFloorDb)} → ${fmt(result.after.noiseFloorDb)}`}
                unit="dBFS"
              />
              <Stat label="Stimme" value={`${fmt(result.before.speechDb)} → ${fmt(result.after.speechDb)}`} unit="dBFS" />
              <Stat label="Lautheit danach" value={fmt(result.after.lufs)} unit="LUFS" />
              <Stat label="Lauteste Stelle vorher" value={fmt(result.before.peakDb)} unit="dBFS" />
              <Stat
                label="Netzbrummen"
                value={result.before.humHz ? `${result.before.humHz} Hz` : 'keines'}
              />
            </div>

            <div className="flex flex-col gap-[12px]">
              <h4 className="text-body font-semibold text-ink">Was gemacht wurde</h4>
              <ol className="flex flex-col gap-[12px]">
                {result.steps.map((step, index) => (
                  <li key={step.title} className="flex gap-[12px] border-t border-line pt-[12px]">
                    <span className="value w-[2ch] shrink-0 text-small text-muted">{index + 1}</span>
                    <span className="flex min-w-0 flex-col gap-[2px]">
                      <span className="text-small font-semibold text-ink">{step.title}</span>
                      <span className="text-small leading-[1.5] text-prose">{step.detail}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            {result.advice.length > 0 ? (
              <div className="flex flex-col gap-[12px]">
                <h4 className="text-body font-semibold text-ink">Am Gerät selbst</h4>
                <p className="text-small text-muted">
                  Den Eingangspegel des Mikrofons kann eine Seite nicht verstellen — das geht nur am Gerät
                  oder in Windows.
                </p>
                {result.advice.map((entry) => (
                  <Notice key={entry.title} tone={entry.tone} title={entry.title}>
                    {entry.text}
                  </Notice>
                ))}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-[8px]">
              <Button size="sm" onClick={keepProcessed}>
                In die Sitzung übernehmen
              </Button>
              <Button
                size="sm"
                variant="quiet"
                onClick={() => saveBytes(encodeWav(result.processed, 24), `mikrofon-${purpose}-gefiltert.wav`, 'audio/wav')}
              >
                Mit Filtern als WAV
              </Button>
              <Button
                size="sm"
                variant="quiet"
                onClick={() => saveBytes(encodeWav(result.raw, 24), `mikrofon-${purpose}-roh.wav`, 'audio/wav')}
              >
                Ohne Filter als WAV
              </Button>
            </div>

            {audioAssets.length > 0 ? (
              <div className="flex flex-col gap-[8px] border-t border-line pt-[16px]">
                <h4 className="text-body font-semibold text-ink">Auf eine Aufnahme anwenden</h4>
                <p className="text-small text-muted">
                  Dieselben Filter für eine längere Aufnahme vom selben Mikrofon im selben Raum.
                </p>
                <div className="flex flex-wrap items-center gap-[8px]">
                  <Select value={applyTo} onChange={(event) => setApplyTo(event.target.value)} className="max-w-[360px]">
                    <option value="">Aufnahme wählen …</option>
                    {audioAssets.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.name}
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" disabled={!applyTo || applying} onClick={() => void applyToAsset()}>
                    {applying ? 'Rechnet…' : 'Anwenden'}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  )
}
