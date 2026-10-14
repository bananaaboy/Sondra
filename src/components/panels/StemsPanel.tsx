/**
 * Stem separation.
 *
 * Two engines, one panel. The built-in signal-processing separator needs nothing
 * but the file. An ONNX model — Demucs, Spleeter, anything the user has — can be
 * loaded on top and runs through WebGPU when the machine has it.
 */

import { useRef, useState } from 'react'

import { saveBytes } from '../../lib/download'
import { hasWebGpuAdapter, detectCapabilities, suggestedThreads } from '../../lib/capabilities'
import { formatBytes, withExtension } from '../../lib/format'
import { STEM_IDS, STEM_LABELS, toInstrumental, type StemId } from '../../lib/separation'
import { encodeWav, type AudioData } from '../../lib/wav'
import { holdScreenAwake } from '../../lib/wakeLock'
import { separateInWorker } from '../../lib/workerClient'
import { createZip } from '../../lib/zip'
import { useDecodedAudio } from '../../hooks/useDecodedAudio'
import { useActiveAsset, useSession } from '../../state/store'
import { AudioPreview } from '../AudioPreview'
import { FileDrop } from '../FileDrop'
import {
  ArrowRight,
  Badge,
  Button,
  Card,
  SectionHead,
  Field,
  Notice,
  Progress,
  Reveal,
  Select,
  Slider,
  Toggle,
} from '../ui/primitives'
import { ChoiceRow } from '../editor/EditorShell'

type Stems = Record<StemId, AudioData>

const SEPARATION_PRESETS = [
  {
    id: 'balanced',
    label: 'Ausgewogen',
    desc: 'Gesang, Beat und Begleitung gleich gewichtet — der Ausgangspunkt.',
    patch: { vocalFocus: 0.65, maskExponent: 2.8, fftSize: 4096, hopSize: 1024, timeKernel: 17, freqKernel: 17 },
  },
  {
    id: 'vocals',
    label: 'Gesang',
    desc: 'Schärfere Mitte, härtere Masken: weniger Begleitung im Gesang — und ein saubereres Instrumental für Karaoke.',
    patch: { vocalFocus: 0.85, maskExponent: 3.5, fftSize: 4096, hopSize: 1024, timeKernel: 17, freqKernel: 17 },
  },
  {
    id: 'rhythm',
    label: 'Rhythmus',
    desc: 'Kürzere Fenster, die Anschläge von Schlagzeug und Perkussion sauber halten.',
    patch: { vocalFocus: 0.5, maskExponent: 3.0, fftSize: 2048, hopSize: 512, timeKernel: 9, freqKernel: 9 },
  },
]

export function StemsPanel() {
  const asset = useActiveAsset()
  const options = useSession((state) => state.separation)
  const setSeparation = useSession((state) => state.setSeparation)
  const activePreset =
    SEPARATION_PRESETS.find(
      (preset) =>
        options.vocalFocus === preset.patch.vocalFocus &&
        options.maskExponent === preset.patch.maskExponent &&
        options.fftSize === preset.patch.fftSize,
    ) ?? null
  const addAsset = useSession((state) => state.addAsset)
  const log = useSession((state) => state.log)
  const { audio, decode } = useDecodedAudio(asset)

  const caps = detectCapabilities()
  const [model, setModel] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const [preferWebGpu, setPreferWebGpu] = useState(caps.webgpu)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [stems, setStems] = useState<Stems | null>(null)
  const [instrumental, setInstrumental] = useState<AudioData | null>(null)
  const [engine, setEngine] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const modelInputRef = useRef<HTMLInputElement>(null)

  const run = async () => {
    if (!asset) return
    const controller = new AbortController()
    abortRef.current = controller
    // Separation on a long track runs for minutes; a sleeping machine would
    // suspend the tab and lose all of it.
    const releaseWakeLock = await holdScreenAwake()
    setRunning(true)
    setError(null)
    setStems(null)
    setInstrumental(null)

    try {
      const decoded = audio ?? (await decode())
      if (!decoded) return

      const gpu = preferWebGpu && (await hasWebGpuAdapter())
      const outcome = await separateInWorker(
        decoded,
        options,
        {
          model: model ? model.bytes.slice() : null,
          threads: suggestedThreads(caps),
          preferWebGpu: gpu,
        },
        (fraction, hint) => {
          setProgress(fraction)
          setNote(hint ?? null)
        },
        controller.signal,
      )

      setStems(outcome.stems)
      setInstrumental(toInstrumental(decoded, outcome.stems.vocals))
      setEngine(
        outcome.engine === 'onnx'
          ? `Neuronales Modell · ${outcome.provider === 'webgpu' ? 'WebGPU' : 'WASM'}`
          : 'Signalverarbeitung im Browser',
      )
      log('spuren', `Trennung abgeschlossen (${outcome.engine})`)
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError')) {
        const message = failure instanceof Error ? failure.message : String(failure)
        setError(message)
        log('spuren', message, 'error')
      }
    } finally {
      releaseWakeLock()
      setRunning(false)
      setProgress(null)
      setNote(null)
      abortRef.current = null
    }
  }

  /** All stems in one archive, rather than five separate save prompts. */
  const exportAll = () => {
    if (!stems) return
    const base = asset?.name.replace(/\.[^.]+$/, '') ?? 'audio'
    const files = STEM_IDS.map((id) => ({
      name: `${base}/${id}.wav`,
      data: encodeWav(stems[id], 24),
    }))
    if (instrumental) files.push({ name: `${base}/instrumental.wav`, data: encodeWav(instrumental, 24) })
    saveBytes(createZip(files), `${base}-stems.zip`, 'application/zip')
    log('spuren', `${files.length} Spuren als ZIP gespeichert`)
  }

  const exportStem = (id: StemId | 'instrumental', data: AudioData) => {
    const base = asset?.name ?? 'audio'
    const name = withExtension(`${base}_${id}`, 'wav')
    saveBytes(encodeWav(data, 24), name, 'audio/wav')
  }

  const keepStem = (id: StemId | 'instrumental', data: AudioData) => {
    const base = asset?.name ?? 'audio'
    const name = withExtension(`${base}_${id}`, 'wav')
    const bytes = encodeWav(data, 24)
    addAsset({
      name,
      bytes,
      mime: 'audio/wav',
      sizeBytes: bytes.byteLength,
      kind: 'audio',
      audio: data,
      durationSeconds: (data.channels[0]?.length ?? 0) / data.sampleRate,
      origin: 'derived',
    })
    log('spuren', `${name} in die Sitzung übernommen`)
  }

  const isMono = (audio?.channels.length ?? 2) < 2

  return (
    <div className="grid gap-[20px] lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex flex-col gap-[20px]">
        <Card tone="keylime">
          <h2 className="display-md mt-[8px] mb-[12px]">Gesang, Schlagzeug, Bass und Rest</h2>
          <details className="max-w-[60ch]">
            <summary className="cursor-pointer list-none text-small text-muted underline underline-offset-2 hover:text-ink">
              Wie die Trennung rechnet
            </summary>
            <p className="mt-[8px] text-small leading-[1.6] text-prose/85">
              Das eingebaute Verfahren trennt harmonische von perkussiven Anteilen über Medianfilter im
              Spektrogramm und schätzt den Gesang aus der Mittenkohärenz zwischen links und rechts. Vier
              Masken, die sich zu eins ergänzen — die Spuren addieren sich exakt zum Original zurück.
            </p>
          </details>

          {!asset ? (
            <div className="mt-[28px]">
              <FileDrop />
            </div>
          ) : (
            <>
              {isMono && audio ? (
                <div className="mt-[20px]">
                  <Notice tone="warn" title="Mono-Material">
                    Ohne Stereobild gibt es keine Mitteninformation, aus der sich der Gesang ableiten
                    ließe. Die Trennung stützt sich dann allein auf Frequenzbänder und
                    harmonisch/perkussiv — das Ergebnis ist deutlich grober.
                  </Notice>
                </div>
              ) : null}

              {/* Three ways to weight the separation, said in plain words with
                  what each does underneath. „Vocal-Fokus" and „Karaoke" were
                  the same numbers under two names and lit up together. */}
              <div className="mt-[20px] flex flex-col gap-[8px] border-t border-line pt-[10px]">
                <span className="text-small text-prose">Worauf es ankommt</span>
                <ChoiceRow
                  value={activePreset?.id ?? ''}
                  options={SEPARATION_PRESETS.map((preset) => ({ value: preset.id, label: preset.label, title: preset.desc }))}
                  onChange={(id) => {
                    const preset = SEPARATION_PRESETS.find((entry) => entry.id === id)
                    if (preset) setSeparation(preset.patch)
                  }}
                />
                <span className="text-small leading-[1.45] text-muted">
                  {activePreset ? activePreset.desc : 'Eigene Einstellung — siehe Feinjustierung.'}
                </span>
              </div>

              <Reveal label="Feinjustierung" className="mt-[12px]">
                <div className="grid gap-[20px] pb-[8px] pt-[4px] sm:grid-cols-2">
                  <Slider
                    label="Mittenschärfe"
                    display={options.vocalFocus.toFixed(2)}
                    min={0}
                    max={0.95}
                    step={0.05}
                    value={options.vocalFocus}
                    onChange={(event) => setSeparation({ vocalFocus: Number(event.target.value) })}
                  />
                  <Slider
                    label="Maskenhärte"
                    display={options.maskExponent.toFixed(1)}
                    min={1}
                    max={4.5}
                    step={0.1}
                    value={options.maskExponent}
                    onChange={(event) => setSeparation({ maskExponent: Number(event.target.value) })}
                  />
                  <Field label="Auflösung (FFT)" hint="Grösser trennt Töne feiner, kleiner schont Anschläge.">
                    <Select
                      value={options.fftSize}
                      onChange={(event) => {
                        const fftSize = Number(event.target.value)
                        setSeparation({ fftSize, hopSize: fftSize / 4 })
                      }}
                    >
                      <option value={2048}>2048 — transientenfreundlich (Beat / Drums)</option>
                      <option value={4096}>4096 — ausgewogen (Musik)</option>
                      <option value={8192}>8192 — feine Tonhöhen (Orchester / Solo)</option>
                    </Select>
                  </Field>
                  <Field label="Filterfenster" hint="Länge der Harmonisch-/Perkussiv-Filter.">
                    <Select
                      value={options.timeKernel}
                      onChange={(event) => {
                        const kernel = Number(event.target.value)
                        setSeparation({ timeKernel: kernel, freqKernel: kernel })
                      }}
                    >
                      <option value={9}>9 — schnell & knackig</option>
                      <option value={17}>17 — Standard</option>
                      <option value={31}>31 — gründlich</option>
                    </Select>
                  </Field>
                </div>
              </Reveal>

              <div className="mt-[28px] flex flex-wrap items-center gap-[12px]">
                <Button onClick={run} disabled={running}>
                  {running ? 'Wird getrennt…' : 'Spuren trennen'}
                  {!running ? <ArrowRight /> : null}
                </Button>
                {running ? (
                  <Button variant="quiet" onClick={() => abortRef.current?.abort()}>
                    Abbrechen
                  </Button>
                ) : null}
              </div>

              {running ? (
                <div className="mt-[16px]">
                  <Progress value={progress} label={note ?? 'Analyse'} />
                </div>
              ) : null}
            </>
          )}
        </Card>

        {error ? (
          <Notice tone="error" title="Trennung fehlgeschlagen">
            {error}
          </Notice>
        ) : null}

        {stems ? (
          <Card tone="slate">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <SectionHead>Spuren</SectionHead>
              <div className="flex flex-wrap items-center gap-[8px]">
                {engine ? <Badge>{engine}</Badge> : null}
                <Button size="sm" onClick={exportAll}>
                  Alle als ZIP
                </Button>
              </div>
            </div>

            <div className="mt-[16px] flex flex-col gap-[12px]">
              {STEM_IDS.map((id) => (
                <div key={id} className="rounded-card bg-raised p-[16px]">
                  <div className="mb-[12px] flex flex-wrap items-center justify-between gap-3">
                    <span className="text-subheading text-ink">{STEM_LABELS[id]}</span>
                    <div className="flex gap-[8px]">
                      <Button size="sm" variant="quiet" onClick={() => keepStem(id, stems[id])}>
                        Übernehmen
                      </Button>
                      <Button size="sm" onClick={() => exportStem(id, stems[id])}>
                        WAV
                      </Button>
                    </div>
                  </div>
                  {/* Gegen das Original umschaltbar: ob eine Trennung etwas
                      taugt, hört man nur im direkten Vergleich. */}
                  <AudioPreview
                    sources={
                      audio
                        ? [
                            { id: `${id}-stem`, label: STEM_LABELS[id], audio: stems[id] },
                            { id: `${id}-source`, label: 'Original', audio },
                          ]
                        : [{ id: `${id}-stem`, label: STEM_LABELS[id], audio: stems[id] }]
                    }
                  />
                </div>
              ))}

              {instrumental ? (
                <div className="rounded-card bg-raised p-[16px]">
                  <div className="mb-[12px] flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-subheading text-ink">Instrumental</span>
                      <span className="text-small text-muted">
                        Original minus Gesang — exakt, weil subtrahiert statt neu maskiert.
                      </span>
                    </div>
                    <div className="flex gap-[8px]">
                      <Button size="sm" variant="quiet" onClick={() => keepStem('instrumental', instrumental)}>
                        Übernehmen
                      </Button>
                      <Button size="sm" onClick={() => exportStem('instrumental', instrumental)}>
                        WAV
                      </Button>
                    </div>
                  </div>
                  <AudioPreview
                    sources={
                      audio
                        ? [
                            { id: 'instrumental', label: 'Instrumental', audio: instrumental },
                            { id: 'instrumental-source', label: 'Original', audio },
                          ]
                        : [{ id: 'instrumental', label: 'Instrumental', audio: instrumental }]
                    }
                  />
                </div>
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>

      <aside className="flex flex-col gap-[20px]">

        <Card tone="cream">
          <SectionHead>Neuronales Modell</SectionHead>
          <p className="mt-[8px] text-small leading-[1.55] text-prose/85">
            Optional. Ohne Modell rechnet das eingebaute Verfahren.
          </p>
          <details className="mt-[8px]">
            <summary className="cursor-pointer list-none text-small text-muted underline underline-offset-2 hover:text-ink">
              Warum keins mitgeliefert wird
            </summary>
            <p className="mt-[8px] text-small leading-[1.55] text-prose/85">
              Ein Demucs-Export wiegt Hunderte Megabyte, die sonst jeder Besuch herunterlädt. Ihr
              eigenes <code>.onnx</code> wird lokal ausgeführt und verlässt das Gerät nicht.
            </p>
          </details>

          <input
            ref={modelInputRef}
            type="file"
            accept=".onnx"
            className="sr-only"
            onChange={async (event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              const bytes = new Uint8Array(await file.arrayBuffer())
              setModel({ name: file.name, bytes })
              log('spuren', `Modell ${file.name} geladen (${formatBytes(bytes.byteLength)})`)
            }}
          />

          <div className="mt-[16px] flex flex-wrap gap-[8px]">
            <Button size="sm" variant="quiet" onClick={() => modelInputRef.current?.click()}>
              {model ? 'Anderes Modell' : 'Modell wählen'}
            </Button>
            {model ? (
              <Button size="sm" variant="ghost" onClick={() => setModel(null)}>
                Entfernen
              </Button>
            ) : null}
          </div>

          {model ? (
            <div className="mt-[16px] flex flex-wrap gap-[8px]">
              <Badge>{model.name}</Badge>
              <Badge>{formatBytes(model.bytes.byteLength)}</Badge>
            </div>
          ) : null}

          <div className="mt-[16px]">
            <Toggle
              label="WebGPU bevorzugen"
              hint={
                caps.webgpu
                  ? 'Deutlich schneller als WASM, wenn der Treiber mitspielt.'
                  : 'Dieser Browser bietet keine WebGPU-Schnittstelle an.'
              }
              checked={preferWebGpu}
              onChange={setPreferWebGpu}
              disabled={!caps.webgpu}
            />
          </div>
        </Card>
      </aside>
    </div>
  )
}
