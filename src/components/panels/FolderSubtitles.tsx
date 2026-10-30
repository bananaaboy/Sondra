/**
 * „Untertitel erzeugen“ under a selection in the folder: the speech model of
 * the browser listens to each film in turn and the result is written beside
 * it as `Name.srt`, where the player picks it up by itself.
 *
 * Said where it happens: the model (about 80 MB, 250 for the exact one) comes
 * from Hugging Face the first time and is kept; the sound itself never leaves
 * this device.
 */

import { useEffect, useRef, useState } from 'react'

import { listenTo, subtitleNameFor } from '../../lib/autoSubtitles'
import { saveBytes } from '../../lib/download'
import type { FolderFile } from '../../lib/folder'
import { formatBytes } from '../../lib/format'
import { isWhisperModelCached } from '../../lib/localAi'
import { SPEECH_LANGUAGES, SPEECH_MODELS } from '../../lib/transcribe'
import { Button, Dialog, Notice, Progress, Select } from '../ui/primitives'

const MODEL_KEY = 'sondra:sprachmodell'
const LANGUAGE_KEY = 'sondra:sprache'

const kept = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}
const keep = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Only a preference.
  }
}

type Row = { state: 'waiting' } | { state: 'working'; stage: string; fraction: number | null } | { state: 'done'; where: string } | { state: 'failed'; reason: string }

/** Writes `name` beside the film, or hands it over as a download where the browser lets nothing be written. */
async function place(film: FolderFile, srt: string): Promise<string> {
  const name = subtitleNameFor(film.name)
  const bytes = new TextEncoder().encode(srt)
  if (film.parent) {
    try {
      const handle = await film.parent.getFileHandle(name, { create: true })
      const out = await handle.createWritable?.()
      if (out) {
        await out.write(bytes)
        await out.close()
        return `${film.dir ? `${film.dir}/` : ''}${name}`
      }
    } catch {
      // Not allowed to write there: the download below.
    }
  }
  saveBytes(bytes, name, 'application/x-subrip')
  return `${name} (als Download)`
}

export function FolderSubtitles({ files, onClose, onWritten }: { files: FolderFile[]; onClose: () => void; onWritten: () => void }) {
  const [model, setModel] = useState(() => kept(MODEL_KEY, SPEECH_MODELS[0].id))
  const [language, setLanguage] = useState(() => kept(LANGUAGE_KEY, 'de'))
  const [rows, setRows] = useState<Row[]>(() => files.map(() => ({ state: 'waiting' })))
  const [running, setRunning] = useState(false)
  const [finished, setFinished] = useState(false)
  const [cached, setCached] = useState<boolean | null>(null)
  const abort = useRef<AbortController | null>(null)
  useEffect(() => {
    void isWhisperModelCached().then(setCached)
    return () => abort.current?.abort()
  }, [])
  const chosen = SPEECH_MODELS.find((entry) => entry.id === model) ?? SPEECH_MODELS[0]
  const patch = (index: number, row: Row) => setRows((current) => current.map((entry, at) => (at === index ? row : entry)))

  const start = async () => {
    const controller = new AbortController()
    abort.current = controller
    setRunning(true)
    setFinished(false)
    setRows(files.map(() => ({ state: 'waiting' })))
    let wrote = 0
    for (const [index, film] of files.entries()) {
      if (controller.signal.aborted) break
      patch(index, { state: 'working', stage: 'Liest die Tonspur …', fraction: null })
      try {
        const source = film.file
        if (!source) throw new Error('Die Datei liegt nicht auf diesem Gerät.')
        const { srt, cues } = await listenTo(source, film.name, {
          model,
          language,
          signal: controller.signal,
          onStage: (stage) =>
            patch(
              index,
              stage.kind === 'sound'
                ? { state: 'working', stage: 'Liest die Tonspur …', fraction: stage.fraction }
                : stage.kind === 'loading'
                  ? { state: 'working', stage: `Lädt das Sprachmodell … ${formatBytes(stage.loaded)}`, fraction: stage.total > 0 ? stage.loaded / stage.total : null }
                  : { state: 'working', stage: 'Hört zu …', fraction: stage.fraction },
            ),
        })
        patch(index, { state: 'done', where: `${await place(film, srt)} · ${cues} Zeilen` })
        wrote += 1
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          patch(index, { state: 'failed', reason: 'Abgebrochen.' })
          break
        }
        patch(index, { state: 'failed', reason: error instanceof Error ? error.message : String(error) })
      }
    }
    abort.current = null
    setRunning(false)
    setFinished(true)
    if (wrote > 0) onWritten()
  }

  return (
    <Dialog open onClose={running ? () => abort.current?.abort() : onClose} title="Untertitel erzeugen" size="md">
      <div className="flex flex-col gap-[16px]">
        <p className="text-body leading-[1.55] text-prose">
          Sondra hört {files.length === 1 ? 'die Datei' : `diese ${files.length} Dateien`} ab und schreibt neben jede einen Untertitel <span className="value text-ink">Name.srt</span>. Der Player nimmt ihn von selbst. Das Erkennen
          läuft auf diesem Gerät; der Ton verlässt es nicht.
        </p>
        {cached === false ? (
          <Notice title="Das Sprachmodell wird geladen">
            Beim ersten Mal kommt es von Hugging Face ({formatBytes(chosen.bytes)}) und bleibt danach auf diesem Gerät. Nur das Modell wird geladen, nichts von Ihren Dateien geht dorthin.
          </Notice>
        ) : null}
        <div className="grid gap-[12px] sm:grid-cols-2">
          <label className="flex flex-col gap-[4px]">
            <span className="text-small text-prose">Sprache im Ton</span>
            <Select
              value={language}
              disabled={running}
              onChange={(event) => {
                setLanguage(event.target.value)
                keep(LANGUAGE_KEY, event.target.value)
              }}
            >
              {SPEECH_LANGUAGES.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-[4px]">
            <span className="text-small text-prose">Genauigkeit</span>
            <Select
              value={model}
              disabled={running}
              onChange={(event) => {
                setModel(event.target.value)
                keep(MODEL_KEY, event.target.value)
              }}
            >
              {SPEECH_MODELS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <p className="text-small leading-[1.5] text-prose">{chosen.hint}</p>
        <ul className="flex max-h-[min(36dvh,320px)] flex-col overflow-y-auto">
          {files.map((film, index) => {
            const row = rows[index]
            return (
              <li key={film.path} className="flex max-w-none flex-col gap-[4px] border-t border-line py-[8px] first:border-t-0">
                <span className="value truncate text-small text-ink" title={film.path}>
                  {film.path}
                </span>
                {row.state === 'working' ? (
                  <>
                    <span className="text-small text-prose" aria-live="polite">
                      {row.stage}
                    </span>
                    <Progress value={row.fraction} />
                  </>
                ) : row.state === 'done' ? (
                  <span className="text-small text-prose">● {row.where}</span>
                ) : row.state === 'failed' ? (
                  <span className="text-small text-ink">! {row.reason}</span>
                ) : null}
              </li>
            )
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-[10px]">
          {finished ? (
            <Button type="button" onClick={onClose}>
              Fertig
            </Button>
          ) : (
            <Button type="button" disabled={running} onClick={() => void start()}>
              {running ? 'Hört zu …' : 'Beginnen'}
            </Button>
          )}
          {running ? (
            <Button type="button" variant="quiet" onClick={() => abort.current?.abort()}>
              Abbrechen
            </Button>
          ) : finished ? null : (
            <Button type="button" variant="quiet" onClick={onClose}>
              Schliessen
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  )
}
