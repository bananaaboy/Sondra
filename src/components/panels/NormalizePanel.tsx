/**
 * Loudness measurement and normalisation.
 *
 * The measurement is a real BS.1770-4 implementation — K-weighting, 400 ms
 * gated blocks, 4× oversampled true peak — not a peak scan wearing a LUFS
 * label, so the numbers match what a broadcast meter would report.
 */

import { useRef, useState } from 'react'

import { saveBytes } from '../../lib/download'
import { formatDb, formatDuration, formatLufs } from '../../lib/format'
import { LOUDNESS_PRESETS, type GainPlan, type LoudnessReport } from '../../lib/loudness'
import { encodeWav } from '../../lib/wav'
import { measureLoudnessInWorker, normalizeInWorker } from '../../lib/workerClient'
import { withExtension } from '../../lib/format'
import { decodeAssetAudio, useDecodedAudio } from '../../hooks/useDecodedAudio'
import { createZip } from '../../lib/zip'
import { BatchFiles, useBatchSelection } from '../BatchFiles'
import { useActiveAsset, useSession } from '../../state/store'
import { AudioPreview } from '../AudioPreview'
import { FileDrop } from '../FileDrop'
import { Waveform } from '../Waveform'
import {
  ArrowRight,
  Badge,
  Button,
  Card,
  SectionHead,
  Field,
  Notice,
  Progress,
  Select,
  Slider,
  Stat,
  Toggle,
} from '../ui/primitives'

/** Horizontal LUFS gauge: measured value against the target. */
const BATCH_KINDS = ['audio', 'video'] as const

interface BatchRow {
  id: string
  name: string
  state: 'pending' | 'running' | 'done' | 'error'
  before?: number
  after?: number
  message?: string
}

const ROW_MARK: Record<BatchRow['state'], string> = { pending: '·', running: '●', done: '✓', error: '!' }

function LoudnessGauge({ report, target }: { report: LoudnessReport; target: number }) {
  const low = -40
  const high = 0
  const position = (value: number) => `${Math.max(0, Math.min(100, ((value - low) / (high - low)) * 100))}%`

  return (
    <div className="flex flex-col gap-[12px]">
      <div className="relative h-[28px] bg-ink/10">
        <div
          className="absolute inset-y-0 left-0 bg-ink/70"
          style={{ width: position(report.integratedLufs) }}
        />
        <div
          className="absolute inset-y-[-6px] w-[2px] bg-ink"
          style={{ left: position(target) }}
          aria-hidden
        />
      </div>
      <div className="flex justify-between text-micro text-muted">
        <span className="value">−40</span>
        <span className="value">Ziel {target} LUFS</span>
        <span className="value">0</span>
      </div>
    </div>
  )
}

function ReportGrid({ report }: { report: LoudnessReport }) {
  return (
    <div className="grid gap-[20px] rounded-card bg-raised p-[28px] sm:grid-cols-3">
      <Stat label="Integriert" value={formatLufs(report.integratedLufs)} emphasis />
      <Stat label="Loudness Range" value={`${report.loudnessRangeLu.toFixed(1)} LU`} />
      <Stat label="True Peak" value={`${report.truePeakDbtp.toFixed(2)} dBTP`} />
      <Stat label="Momentan max." value={formatLufs(report.momentaryMaxLufs)} />
      <Stat label="Kurzzeit max." value={formatLufs(report.shortTermMaxLufs)} />
      <Stat
        label="Sample Peak"
        value={`${report.samplePeakDbfs.toFixed(2)} dBFS`}
        note={formatDuration(report.durationSeconds)}
      />
    </div>
  )
}

export function NormalizePanel() {
  const asset = useActiveAsset()
  const settings = useSession((state) => state.normalization)
  const setNormalization = useSession((state) => state.setNormalization)
  const addAsset = useSession((state) => state.addAsset)
  const log = useSession((state) => state.log)
  const { audio, decode, status: decodeStatus } = useDecodedAudio(asset)

  const [busy, setBusy] = useState<'idle' | 'measuring' | 'normalizing'>('idle')
  const [progress, setProgress] = useState<number | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [before, setBefore] = useState<LoudnessReport | null>(null)
  const [after, setAfter] = useState<LoudnessReport | null>(null)
  const [plan, setPlan] = useState<GainPlan | null>(null)
  const [result, setResult] = useState<Uint8Array | null>(null)
  const [processed, setProcessed] = useState<import('../../lib/wav').AudioData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const [batch, setBatch] = useState(false)
  const selection = useBatchSelection(BATCH_KINDS)
  const [rows, setRows] = useState<BatchRow[] | null>(null)
  const [archive, setArchive] = useState<Uint8Array<ArrayBuffer> | null>(null)

  /** Measures and normalises every ticked file in turn; one ZIP of WAVs. */
  const normalizeBatch = async () => {
    const chosen = selection.selected
    if (chosen.length === 0) return
    const controller = new AbortController()
    abortRef.current = controller
    setBusy('normalizing')
    setError(null)
    setArchive(null)
    setRows(chosen.map((entry) => ({ id: entry.id, name: entry.name, state: 'pending' })))
    const mark = (id: string, patch: Partial<BatchRow>) =>
      setRows((current) => current?.map((row) => (row.id === id ? { ...row, ...patch } : row)) ?? null)
    const produced: { name: string; data: Uint8Array }[] = []
    try {
      for (const [index, entry] of chosen.entries()) {
        if (controller.signal.aborted) break
        mark(entry.id, { state: 'running' })
        setNote(`${index + 1} von ${chosen.length}: ${entry.name}`)
        try {
          const decoded = await decodeAssetAudio(entry)
          const outcome = await normalizeInWorker(decoded, settings, (fraction) => setProgress(fraction), controller.signal)
          produced.push({ name: withExtension(entry.name, 'wav'), data: encodeWav(outcome.audio, 24) })
          mark(entry.id, { state: 'done', before: outcome.before.integratedLufs, after: outcome.after.integratedLufs })
        } catch (failure) {
          if (controller.signal.aborted) break
          // One file the decoder refuses should not stop the other nine.
          const message = failure instanceof Error ? failure.message.split('\n')[0] : String(failure)
          mark(entry.id, { state: 'error', message })
          log('normalisierung', `${entry.name}: ${message}`, 'error')
        }
      }
      if (produced.length > 0) {
        setArchive(createZip(produced))
        log('normalisierung', `${produced.length} von ${chosen.length} Dateien normalisiert`)
      }
    } finally {
      setBusy('idle')
      setProgress(null)
      setNote(null)
      abortRef.current = null
    }
  }

  const reset = () => {
    setAfter(null)
    setPlan(null)
    setResult(null)
    setProcessed(null)
    setError(null)
  }

  const measure = async () => {
    if (!asset) return
    const controller = new AbortController()
    abortRef.current = controller
    setBusy('measuring')
    reset()
    try {
      const decoded = audio ?? (await decode())
      if (!decoded) return
      const report = await measureLoudnessInWorker(
        decoded,
        (fraction, hint) => {
          setProgress(fraction)
          setNote(hint ?? null)
        },
        controller.signal,
      )
      setBefore(report)
      log('normalisierung', `Gemessen: ${formatLufs(report.integratedLufs)}, ${report.truePeakDbtp.toFixed(2)} dBTP`)
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError')) {
        const message = failure instanceof Error ? failure.message : String(failure)
        setError(message)
        log('normalisierung', message, 'error')
      }
    } finally {
      setBusy('idle')
      setProgress(null)
      setNote(null)
      abortRef.current = null
    }
  }

  const normalize = async () => {
    if (!asset) return
    const controller = new AbortController()
    abortRef.current = controller
    setBusy('normalizing')
    reset()
    try {
      const decoded = audio ?? (await decode())
      if (!decoded) return
      const outcome = await normalizeInWorker(
        decoded,
        settings,
        (fraction, hint) => {
          setProgress(fraction)
          setNote(hint ?? null)
        },
        controller.signal,
      )
      setBefore(outcome.before)
      setAfter(outcome.after)
      setPlan(outcome.plan)
      setProcessed(outcome.audio)
      // 24-bit keeps the gain move clean without doubling the file size.
      setResult(encodeWav(outcome.audio, 24))
      log(
        'normalisierung',
        `${formatDb(outcome.plan.appliedDb)} angewandt → ${formatLufs(outcome.after.integratedLufs)}`,
      )
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError')) {
        const message = failure instanceof Error ? failure.message : String(failure)
        setError(message)
        log('normalisierung', message, 'error')
      }
    } finally {
      setBusy('idle')
      setProgress(null)
      setNote(null)
      abortRef.current = null
    }
  }

  const running = busy !== 'idle'

  return (
    <div className="grid gap-[20px] lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex flex-col gap-[20px]">
        <Card tone="keylime">
          <h2 className="display-md mt-[8px] mb-[12px]">So laut wie im Radio</h2>
          <details className="max-w-[60ch]">
            <summary className="cursor-pointer list-none text-small text-muted underline underline-offset-2 hover:text-ink">
              Wie gemessen wird
            </summary>
            <p className="mt-[8px] text-small leading-[1.6] text-prose/85">
              Gemessen wird die integrierte Lautheit mit K-Bewertung und zweistufigem Gate, dazu die
              Loudness Range und der True Peak bei vierfacher Überabtastung. Die Rechnung läuft in einem
              Web Worker, damit die Oberfläche bedienbar bleibt.
            </p>
          </details>

          {!asset ? (
            <div className="mt-[28px]">
              <FileDrop />
            </div>
          ) : (
            <>
              <div className="mt-[28px] bg-panel-soft p-[20px]">
                <Waveform audio={audio} height={84} />
              </div>

              <div className="mt-[20px] grid gap-[16px] sm:grid-cols-2">
                <Field label="Verfahren">
                  <Select
                    value={settings.mode}
                    onChange={(event) =>
                      setNormalization({ mode: event.target.value as 'lufs' | 'peak' })
                    }
                  >
                    <option value="lufs">Lautheit (LUFS)</option>
                    <option value="peak">Spitzenpegel (dBFS)</option>
                  </Select>
                </Field>

                <Field label="Vorgabe">
                  <Select
                    value={
                      LOUDNESS_PRESETS.find(
                        (preset) =>
                          preset.lufs === settings.targetLufs &&
                          preset.ceiling === settings.truePeakCeilingDbtp,
                      )?.id ?? 'custom'
                    }
                    onChange={(event) => {
                      const preset = LOUDNESS_PRESETS.find((p) => p.id === event.target.value)
                      if (preset) {
                        setNormalization({
                          targetLufs: preset.lufs,
                          truePeakCeilingDbtp: preset.ceiling,
                        })
                      }
                    }}
                  >
                    <option value="custom">Eigene Werte</option>
                    {LOUDNESS_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label} · {preset.lufs} LUFS
                      </option>
                    ))}
                  </Select>
                </Field>

                {/* The method and the preset are real choices; these refine
                   them. Folded, because a preset that is about to be adjusted
                   by hand is not much of a preset. */}
                <details className="sm:col-span-2 rounded-card bg-panel-soft p-[16px]">
                  <summary className="cursor-pointer list-none text-small font-semibold text-ink">
                    Feineinstellungen
                    <span className="ml-[8px] font-normal text-muted">
                      Zielwert, Grenze und wie Spitzen behandelt werden
                    </span>
                  </summary>
                  <div className="mt-[16px] flex flex-col gap-[20px]">
                  <div className="sm:col-span-2 grid gap-[20px] sm:grid-cols-2">
                    {settings.mode === 'lufs' ? (
                      <Slider
                        label="Zielwert"
                        display={`${settings.targetLufs} LUFS`}
                        min={-31}
                        max={-6}
                        step={0.5}
                        value={settings.targetLufs}
                        onChange={(event) => setNormalization({ targetLufs: Number(event.target.value) })}
                      />
                    ) : (
                      <Slider
                        label="Zielwert"
                        display={`${settings.targetPeakDbfs} dBFS`}
                        min={-12}
                        max={0}
                        step={0.1}
                        value={settings.targetPeakDbfs}
                        onChange={(event) => setNormalization({ targetPeakDbfs: Number(event.target.value) })}
                      />
                    )}
                    <Slider
                      label="True-Peak-Grenze"
                      display={`${settings.truePeakCeilingDbtp} dBTP`}
                      min={-6}
                      max={0}
                      step={0.1}
                      value={settings.truePeakCeilingDbtp}
                      onChange={(event) =>
                        setNormalization({ truePeakCeilingDbtp: Number(event.target.value) })
                      }
                    />
                  </div>

                  <Toggle
                    label="Übersteuerung verhindern"
                    hint="Nimmt die Verstärkung zurück, statt die Grenze zu überschreiten."
                    checked={settings.preventClipping}
                    onChange={(value) => setNormalization({ preventClipping: value })}
                  />
                  <Toggle
                    label="Limiter statt Rücknahme"
                    hint="Hält den Zielwert und begrenzt nur die Spitzen. Lauter, aber ein Eingriff."
                    checked={settings.useLimiter}
                    onChange={(value) => setNormalization({ useLimiter: value })}
                  />
                  </div>
                </details>
              </div>

              <div className="mt-[20px] flex flex-col gap-[12px]">
                <Toggle
                  label="Mehrere Dateien auf einmal"
                  hint="Jede gewählte Datei auf denselben Zielwert bringen, Ergebnis als ZIP mit WAV-Dateien."
                  checked={batch}
                  onChange={(value) => {
                    setBatch(value)
                    setRows(null)
                    setArchive(null)
                  }}
                />
                {batch ? <BatchFiles selection={selection} disabled={running} /> : null}
              </div>

              <div className="mt-[28px] flex flex-wrap items-center gap-[12px]">
                {batch ? (
                  <Button onClick={() => void normalizeBatch()} disabled={running || selection.selected.length === 0}>
                    {running
                      ? 'Läuft…'
                      : `${selection.selected.length} ${selection.selected.length === 1 ? 'Datei' : 'Dateien'} normalisieren`}
                    {!running ? <ArrowRight /> : null}
                  </Button>
                ) : (
                  <>
                    <Button onClick={normalize} disabled={running}>
                      {busy === 'normalizing' ? 'Läuft…' : 'Messen und normalisieren'}
                      {!running ? <ArrowRight /> : null}
                    </Button>
                    <Button variant="quiet" onClick={measure} disabled={running}>
                      {busy === 'measuring' ? 'Wird gemessen…' : 'Nur messen'}
                    </Button>
                  </>
                )}
                {running ? (
                  <Button variant="ghost" onClick={() => abortRef.current?.abort()}>
                    Abbrechen
                  </Button>
                ) : null}
              </div>

              {running || decodeStatus === 'decoding' ? (
                <div className="mt-[16px]">
                  <Progress value={progress} label={note ?? 'Wird dekodiert'} />
                </div>
              ) : null}
            </>
          )}
        </Card>

        {error ? (
          <Notice tone="error" title="Fehlgeschlagen">
            {error}
          </Notice>
        ) : null}

        {batch && rows ? (
          <Card tone="slate">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <SectionHead>Stapel</SectionHead>
              <span className="value text-small text-muted">
                {rows.filter((row) => row.state === 'done').length} von {rows.length} fertig
              </span>
            </div>
            <ul className="mt-[16px] flex flex-col">
              {rows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-baseline gap-x-[12px] gap-y-[2px] border-t border-line py-[8px] first:border-t-0">
                  <span aria-hidden className={`value w-[14px] shrink-0 text-center text-small ${row.state === 'running' ? 'pulse-dot text-ink' : 'text-muted'}`}>
                    {ROW_MARK[row.state]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-small text-prose">{row.name}</span>
                  {row.before !== undefined && row.after !== undefined ? (
                    <span className="value shrink-0 text-small text-ink">
                      {formatLufs(row.before)} → {formatLufs(row.after)}
                    </span>
                  ) : null}
                  {row.message ? <span className="w-full pl-[26px] text-small text-muted">{row.message}</span> : null}
                </li>
              ))}
            </ul>
            {archive ? (
              <div className="mt-[20px]">
                <Button onClick={() => saveBytes(archive, `sondra-normalisiert-${rows.length}.zip`, 'application/zip')}>
                  Alle als ZIP speichern
                  <ArrowRight />
                </Button>
              </div>
            ) : null}
          </Card>
        ) : null}

        {!batch && before ? (
          <Card tone="slate">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <SectionHead>{after ? 'Vorher' : 'Messung'}</SectionHead>
              {after ? null : <Badge>{settings.targetLufs} LUFS angestrebt</Badge>}
            </div>
            <div className="mt-[16px]">
              <ReportGrid report={before} />
            </div>
            <div className="mt-[20px] rounded-card bg-raised p-[28px]">
              <LoudnessGauge report={before} target={settings.targetLufs} />
            </div>
          </Card>
        ) : null}

        {!batch && after && plan ? (
          <Card tone="sage">
            <SectionHead>Nachher</SectionHead>
            <div className="mt-[16px]">
              <ReportGrid report={after} />
            </div>

            <div className="mt-[20px] flex flex-wrap gap-[8px]">
              <Badge tone="forest">{formatDb(plan.appliedDb)} angewandt</Badge>
              {plan.reducedByCeiling ? (
                <Badge>
                  Von {formatDb(plan.requestedDb)} zurückgenommen, um die True-Peak-Grenze zu halten
                </Badge>
              ) : null}
              {plan.limiterEngaged ? <Badge>Limiter hat eingegriffen</Badge> : null}
            </div>

            {processed && audio ? (
              <div className="mt-[20px] rounded-card bg-raised p-[16px]">
                <p className="mb-[12px] text-small font-semibold text-ink">
                  Anhören
                </p>
                {/* Umschalten hält die Abspielposition — anders lässt sich ein
                    Pegeleingriff nicht beurteilen. */}
                <AudioPreview
                  sources={[
                    { id: 'after', label: 'Nachher', audio: processed },
                    { id: 'before', label: 'Vorher', audio },
                  ]}
                />
              </div>
            ) : null}

            {result ? (
              <div className="mt-[20px] flex flex-wrap gap-[12px]">
                <Button
                  onClick={() => saveBytes(result, withExtension(asset?.name ?? 'audio', 'wav'), 'audio/wav')}
                >
                  Als WAV speichern
                  <ArrowRight />
                </Button>
                <Button
                  variant="quiet"
                  onClick={() => {
                    const name = `normalisiert_${withExtension(asset?.name ?? 'audio', 'wav')}`
                    addAsset({
                      name,
                      bytes: result,
                      mime: 'audio/wav',
                      sizeBytes: result.byteLength,
                      kind: 'audio',
                      audio: null,
                      durationSeconds: null,
                      origin: 'derived',
                    })
                    log('normalisierung', `${name} in die Sitzung übernommen`)
                  }}
                >
                  In die Sitzung übernehmen
                </Button>
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>

      <aside className="flex flex-col gap-[20px]">
        <Card tone="cream">
          <SectionHead>Zielwerte</SectionHead>
          <dl className="mt-[16px] flex flex-col gap-[12px] text-small">
            {LOUDNESS_PRESETS.map((preset) => (
              <div key={preset.id} className="flex items-baseline justify-between gap-3">
                <dt className="text-prose/85">{preset.label}</dt>
                <dd className="value shrink-0 text-ink">{preset.lufs} LUFS</dd>
              </div>
            ))}
          </dl>
        </Card>
      </aside>
    </div>
  )
}
