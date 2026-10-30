/**
 * The bin of the folder page, to look into: what „Löschen“ put away, with
 * where it lay and when. On this device that is the folder
 * `Sondra-Papierkorb` inside the chosen folder, in Google Drive its own bin
 * of what Sondra made. From here a file goes back, or — on a click on
 * exactly that, asked once more — away for good.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { allowed, BIN_NAME, eraseFromBin, listBin, restoreFromBin, type BinItem, type DirectoryHandle } from '../../lib/folder'
import { formatBytes } from '../../lib/format'
import { eraseDriveFiles, listDriveTrash, untrashDriveFiles } from '../../lib/googleDrive'
import { Button, Dialog, Notice } from '../ui/primitives'

interface Row {
  key: string
  name: string
  size: number | null
  /** When it went in. */
  at: number | null
  /** The folder it lay in; empty for the top. */
  from: string
}

const dayOf = (ms: number) => new Date(ms).toLocaleDateString('de-CH', { day: 'numeric', month: 'short', year: 'numeric' })
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })

const fromOf = (path: string | undefined) => (path && path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

const plural = (count: number) => (count === 1 ? 'Datei' : 'Dateien')

export function FolderBin({
  handle,
  drive,
  onClose,
  onChanged,
}: {
  /** The chosen folder on this device. */
  handle?: DirectoryHandle
  /** Sondra's folder in Google Drive instead. */
  drive: boolean
  onClose: () => void
  /** Files went back or away: the page reads the folder again. */
  onChanged: () => void
}) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /** Local items by key, for the calls that need the whole item. */
  const [items, setItems] = useState<Map<string, BinItem>>(new Map())

  const load = useCallback(async () => {
    setProblem(null)
    try {
      if (drive) {
        const found = await listDriveTrash()
        setRows(found.map((file) => ({ key: file.id, name: file.name, size: file.size, at: file.at, from: '' })))
        setItems(new Map())
      } else if (handle) {
        const found = await listBin(handle)
        setRows(found.map((item) => ({ key: item.name, name: item.from ? item.from.slice(item.from.lastIndexOf('/') + 1) : item.name, size: item.size, at: item.at ?? item.modified, from: fromOf(item.from) })))
        setItems(new Map(found.map((item) => [item.name, item])))
      } else {
        setRows([])
      }
      setSelected(new Set())
      setAsking(false)
    } catch (error) {
      setRows([])
      setProblem(error instanceof Error ? error.message : 'Der Papierkorb liess sich nicht lesen.')
    }
  }, [drive, handle])

  useEffect(() => {
    void load()
  }, [load])

  const chosen = useMemo(() => (rows ?? []).filter((row) => selected.has(row.key)), [rows, selected])
  const total = useMemo(() => chosen.reduce((sum, row) => sum + (row.size ?? 0), 0), [chosen])
  const allChosen = rows !== null && rows.length > 0 && selected.size === rows.length

  const toggle = (key: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const finish = async (verb: string, done: number, failed: { reason: string; name: string }[]) => {
    await load()
    if (done > 0) onChanged()
    setNote(done > 0 ? `${done} ${plural(done)} ${verb}.` : null)
    if (failed.length > 0) setProblem(`${failed.length} nicht ${verb}: ${failed[0].name} — ${failed[0].reason}`)
  }

  /** Back where each lay. */
  const putBack = async () => {
    setBusy(true)
    setProblem(null)
    setNote(null)
    try {
      if (drive) {
        const result = await untrashDriveFiles(chosen.map((row) => row.key))
        const names = new Map(chosen.map((row) => [row.key, row.name]))
        await finish('zurückgelegt', result.done.length, result.failed.map((entry) => ({ reason: entry.reason, name: names.get(entry.id) ?? '' })))
      } else if (handle) {
        if (!(await allowed(handle, 'readwrite', true))) {
          setProblem('Der Browser hat das Ändern des Ordners nicht erlaubt — es wurde nichts zurückgelegt.')
          return
        }
        const result = await restoreFromBin(handle, chosen.flatMap((row) => items.get(row.key) ?? []))
        await finish('zurückgelegt', result.done.length, result.failed.map((entry) => ({ reason: entry.reason, name: entry.item.name })))
      }
    } finally {
      setBusy(false)
    }
  }

  /** Gone for good. */
  const eraseChosen = async () => {
    setBusy(true)
    setProblem(null)
    setNote(null)
    try {
      if (drive) {
        const result = await eraseDriveFiles(chosen.map((row) => row.key))
        const names = new Map(chosen.map((row) => [row.key, row.name]))
        await finish('gelöscht', result.done.length, result.failed.map((entry) => ({ reason: entry.reason, name: names.get(entry.id) ?? '' })))
      } else if (handle) {
        if (!(await allowed(handle, 'readwrite', true))) {
          setProblem('Der Browser hat das Ändern des Ordners nicht erlaubt — es wurde nichts gelöscht.')
          return
        }
        const result = await eraseFromBin(handle, chosen.flatMap((row) => items.get(row.key) ?? []))
        await finish('gelöscht', result.done.length, result.failed.map((entry) => ({ reason: entry.reason, name: entry.item.name })))
      }
    } finally {
      setBusy(false)
      setAsking(false)
    }
  }

  return (
    <Dialog open onClose={busy ? () => undefined : onClose} title="Papierkorb" size="lg">
      <div className="flex flex-col gap-[16px]">
        <p className="text-body leading-[1.55] text-prose">
          {drive ? (
            <>Was Sie aus dem Ordner „Sondra“ gelöscht haben, liegt im Papierkorb von Google Drive und bleibt dort 30 Tage. Von hier legen Sie es zurück oder löschen es endgültig.</>
          ) : (
            <>
              Was Sie in diesem Ordner gelöscht haben, liegt im Ordner <span className="font-semibold text-ink">{BIN_NAME}</span>. Von hier legen Sie es dorthin zurück, wo es lag, oder löschen es
              endgültig.
            </>
          )}
        </p>

        {rows === null ? (
          <p className="text-small text-prose" role="status">
            Liest den Papierkorb …
          </p>
        ) : rows.length === 0 ? (
          <p className="border-t border-line pt-[12px] text-body text-prose">Der Papierkorb ist leer.</p>
        ) : (
          <div className="flex flex-col">
            <label className="flex cursor-pointer items-center gap-[10px] border-t border-line py-[8px] text-small text-prose">
              <input
                type="checkbox"
                checked={allChosen}
                disabled={busy}
                onChange={() => setSelected(allChosen ? new Set() : new Set(rows.map((row) => row.key)))}
                className="h-[16px] w-[16px] accent-[var(--color-ink)]"
              />
              Alle {rows.length} wählen
            </label>
            <ul className="flex max-h-[min(46vh,420px)] flex-col overflow-y-auto">
              {rows.map((row) => (
                <li key={row.key} className="border-t border-line first:border-t-0">
                  <label className="flex cursor-pointer items-start gap-[10px] py-[8px]">
                    <input
                      type="checkbox"
                      checked={selected.has(row.key)}
                      disabled={busy}
                      onChange={() => toggle(row.key)}
                      className="mt-[3px] h-[16px] w-[16px] shrink-0 accent-[var(--color-ink)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="value block truncate text-small text-ink" title={row.name}>
                        {row.name}
                      </span>
                      <span className="block text-small text-prose">
                        {row.from ? `aus ${row.from} · ` : ''}
                        {row.at ? `gelöscht ${dayOf(row.at)}, ${timeOf(row.at)}` : 'gelöscht'}
                        {row.size !== null ? ` · ${formatBytes(row.size)}` : ''}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        {note ? (
          <p role="status" className="text-small text-prose">
            {note}
          </p>
        ) : null}
        {problem ? (
          <Notice tone="error" title="Hat nicht geklappt">
            {problem}
          </Notice>
        ) : null}

        {asking ? (
          <Notice tone="warn" title={`${chosen.length} ${plural(chosen.length)} endgültig löschen?`}>
            Zusammen {formatBytes(total)}. Dafür gibt es kein Zurück.
            <span className="mt-[10px] flex flex-wrap gap-[10px]">
              <Button type="button" disabled={busy} onClick={() => void eraseChosen()}>
                {busy ? 'Löscht …' : 'Endgültig löschen'}
              </Button>
              <Button type="button" variant="quiet" disabled={busy} onClick={() => setAsking(false)}>
                Abbrechen
              </Button>
            </span>
          </Notice>
        ) : (
          <div className="flex flex-wrap items-center gap-[10px]">
            <Button type="button" disabled={busy || chosen.length === 0} onClick={() => void putBack()}>
              {busy ? 'Arbeitet …' : chosen.length > 0 ? `${chosen.length} zurücklegen` : 'Zurücklegen'}
            </Button>
            <Button type="button" variant="quiet" disabled={busy || chosen.length === 0} onClick={() => setAsking(true)}>
              Endgültig löschen
            </Button>
            <span className="flex-1" />
            <Button type="button" variant="quiet" disabled={busy} onClick={onClose}>
              Schliessen
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  )
}
