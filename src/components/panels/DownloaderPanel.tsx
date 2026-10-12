/**
 * Getting something in from an address.
 *
 * This is the only screen in Sondra that talks to a server, and it says so
 * before it does anything — at the top, in the first sentence, not in a
 * footnote. Everything else in the app runs in the tab; this one step cannot,
 * because a browser is not permitted to fetch a video from a site that did not
 * invite it, and none of them invite it.
 *
 * The panel used to open on the configuration for that: which instance, which
 * key, which cookies, which of two services. All of it real and all of it
 * necessary for the hard cases — and all of it in front of somebody who only
 * wanted to paste a link. That panel is still here, complete, one click down
 * under "Mehr Wege". In front of it is the case that needs nothing at all:
 * paste, choose, download.
 */

import { useEffect, useRef, useState } from 'react'

import { IN_DESKTOP_APP } from '../../lib/desktop'
import { saveBytes } from '../../lib/download'
import { formatBytes, formatDuration } from '../../lib/format'
import {
  StudioError,
  downloadStream,
  filenameFor,
  resolveViaService,
  type StealthMode,
  type StudioResult,
  type StudioStream,
} from '../../lib/studio'
import { serviceConnection } from '../../lib/serviceState'
import { kindFromMime, useSession } from '../../state/store'
import { Button, Card, Notice, Progress, Reveal, TextInput } from '../ui/primitives'
import { AdvancedDownloader } from './DownloaderAdvanced'

/* -------------------------------------------------------------------------- */

/**
 * The one place where Sondra is not local, said loudly.
 *
 * The header used to carry this as a chip on every screen. That it is local
 * everywhere else goes without saying; the exception belongs where it happens,
 * big enough that nobody pastes an address without having read it.
 */
function NotLocalNotice() {
  return (
    <div role="note" className="rounded-card bg-panel-cool p-[20px] ring-2 ring-inset ring-ink sm:p-[24px]">
      <p className="flex items-start gap-[12px] text-ink">
        <svg viewBox="0 0 16 16" className="mt-[2px] h-6 w-6 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M8 1.6l6.2 10.8H1.8zM8 6.2v3.1M8 11.2h.01" />
        </svg>
        <span className="flex flex-col gap-[2px]">
          <span className="text-body font-bold leading-[1.3] sm:text-[1.25rem]">
            Achtung: Herunterladen läuft nicht lokal
          </span>
          <span className="text-small text-prose">
            Das ist das einzige Werkzeug, das Ihr Gerät verlässt. Alle anderen rechnen nur hier.
          </span>
        </span>
      </p>
      <ul className="mt-[12px] flex list-disc flex-col gap-[4px] pl-[52px] text-small leading-[1.5] text-prose">
        <li>
          Die Adresse, die Sie einfügen, geht an einen Dienst dieser Seite. Er schlägt dort nach und
          holt die Datei. Ihre eigenen Dateien sieht er nie.
        </li>
        <li>
          Die Datei läuft durch diesen Dienst zu Ihnen. Gespeichert wird sie dort nicht; alles
          Weitere — schneiden, umwandeln, trennen — passiert wieder hier im Tab.
        </li>
        <li>
          Das Ganze läuft über einen Proxy, und ich hafte dafür absolut nicht. Laden Sie nur
          herunter, was Sie herunterladen dürfen. Kopierschutz wird hier nicht umgangen.
        </li>
      </ul>
    </div>
  )
}

/**
 * The same place in the app, where the premise above is not true: the app
 * runs the service itself, on this machine, so nothing here goes through a
 * server of the site. Not `panel-cool`, which says "not local" and would be
 * wrong here — but the liability sentence stays, word for word.
 */
/** Whether the browser believes it has a network — offline the tools work, this one cannot. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}

function AppNotice() {
  return (
    <div role="note" className="rounded-card bg-panel-soft p-[20px] sm:p-[24px]">
      <p className="text-body font-bold leading-[1.3] text-ink sm:text-[1.25rem]">Herunterladen läuft über diesen Rechner</p>
      <ul className="mt-[12px] flex list-disc flex-col gap-[4px] pl-[20px] text-small leading-[1.5] text-prose">
        <li>
          Sondra fragt die Seite selbst, mit yt-dlp auf diesem Rechner. Kein fremder Server ist
          dazwischen; die Seite, von der Sie laden, sieht diesen Rechner.
        </li>
        <li>Die Datei landet in der Sitzung; alles Weitere passiert hier.</li>
        <li>
          Ich hafte dafür absolut nicht. Laden Sie nur herunter, was Sie herunterladen dürfen.
          Kopierschutz wird hier nicht umgangen.
        </li>
      </ul>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

interface BatchItem {
  url: string
  status: 'pending' | 'resolving' | 'ready' | 'downloading' | 'done' | 'error'
  result?: StudioResult
  selectedStreamId?: string
  error?: string
  progress?: { loaded: number; total: number | null } | null
  taken?: { name: string; bytes: Uint8Array; mime: string }
}

interface NetworkAdapter {
  id: string
  name: string
  address: string | null
}

export function DownloaderPanel() {
  const addAsset = useSession((state) => state.addAsset)
  const log = useSession((state) => state.log)

  const [url, setUrl] = useState('')
  const [stealthMode, setStealthMode] = useState<StealthMode>('off')
  const stealthModeRef = useRef<StealthMode>(stealthMode)
  stealthModeRef.current = stealthMode

  const [adapters, setAdapters] = useState<NetworkAdapter[]>([])
  const [selectedAdapter, setSelectedAdapter] = useState<string>('default')
  const [adapterLoading, setAdapterLoading] = useState(false)

  const fetchAdapters = async () => {
    setAdapterLoading(true)
    try {
      const conn = serviceConnection()
      const targetUrl = conn.endpoint
        ? `${conn.endpoint.replace(/\/$/, '')}/adapters`
        : IN_DESKTOP_APP
        ? 'http://localhost:9000/adapters'
        : '/api/adapters'
      const res = await fetch(targetUrl, { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        const data = (await res.json()) as { adapters?: NetworkAdapter[]; selected?: string }
        if (Array.isArray(data.adapters) && data.adapters.length > 0) {
          setAdapters(data.adapters)
          if (data.selected) setSelectedAdapter(data.selected)
        }
      }
    } catch {
      // Endpoint not reachable
    } finally {
      setAdapterLoading(false)
    }
  }

  useEffect(() => {
    void fetchAdapters()
  }, [])

  const changeAdapter = async (val: string) => {
    setSelectedAdapter(val)
    try {
      const conn = serviceConnection()
      const targetUrl = conn.endpoint
        ? `${conn.endpoint.replace(/\/$/, '')}/adapters`
        : IN_DESKTOP_APP
        ? 'http://localhost:9000/adapters'
        : '/api/adapters'
      await fetch(targetUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bindAddress: val === 'default' ? null : val }),
      })
      log(
        'netzwerk',
        val === 'default' ? 'Netzwerk: Automatisch (Windows-Standard)' : `Netzwerk gebunden an: ${val}`,
      )
    } catch (err) {
      log('netzwerk', `Adapter konnte nicht umgestellt werden: ${err}`, 'error')
    }
  }

  const [looking, setLooking] = useState(false)
  const [result, setResult] = useState<StudioResult | null>(null)
  const [batchEntries, setBatchEntries] = useState<BatchItem[] | null>(null)
  const batchEntriesRef = useRef<BatchItem[] | null>(null)
  batchEntriesRef.current = batchEntries

  const [batchBusy, setBatchBusy] = useState(false)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ loaded: number; total: number | null } | null>(null)
  /** What the last „Laden“ put into the session, so it can still be saved. */
  const [taken, setTaken] = useState<{ name: string; bytes: Uint8Array; mime: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const online = useOnline()

  useEffect(() => () => abortRef.current?.abort(), [])

  const look = async () => {
    const targets = url
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (targets.length === 0) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLooking(true)
    setError(null)
    setResult(null)
    setBatchEntries(null)
    setTaken(null)

    if (targets.length === 1) {
      try {
        const found = await resolveViaService(targets[0], controller.signal)
        setResult(found)
        log('holen', `${found.title} — ${found.streams.length} Spur(en) verfügbar`)
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        const studio = cause instanceof StudioError ? cause : null
        setError({
          code: studio?.code ?? 'unknown',
          message: studio?.message ?? (cause instanceof Error ? cause.message : String(cause)),
        })
        log('holen', studio?.message ?? String(cause), 'error')
      } finally {
        setLooking(false)
      }
      return
    }

    // Mehrere Adressen: Batch-Modus
    const initial: BatchItem[] = targets.map((u) => ({
      url: u,
      status: 'resolving',
    }))
    setBatchEntries(initial)

    try {
      await Promise.all(
        targets.map(async (target, i) => {
          try {
            const res = await resolveViaService(target, controller.signal)
            const bestStream = res.streams.find((s) => s.hasVideo && s.hasAudio) || res.streams[0]
            setBatchEntries((prev) =>
              prev
                ? prev.map((entry, idx) =>
                    idx === i
                      ? {
                          ...entry,
                          status: 'ready',
                          result: res,
                          selectedStreamId: bestStream?.id ?? res.streams[0]?.id,
                        }
                      : entry
                  )
                : null
            )
            log('holen', `${res.title} — bereit`)
          } catch (cause) {
            if (cause instanceof DOMException && cause.name === 'AbortError') return
            const msg =
              cause instanceof StudioError
                ? cause.message
                : cause instanceof Error
                ? cause.message
                : String(cause)
            setBatchEntries((prev) =>
              prev
                ? prev.map((entry, idx) =>
                    idx === i ? { ...entry, status: 'error', error: msg } : entry
                  )
                : null
            )
            log('holen', `Fehler bei ${target}: ${msg}`, 'error')
          }
        })
      )
    } finally {
      setLooking(false)
    }
  }

  const take = async (stream: StudioStream) => {
    if (!result) return
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(stream.label)
    setError(null)
    setTaken(null)
    setProgress({ loaded: 0, total: stream.bytes })
    try {
      const bytes = await downloadStream(stream, {
        signal: controller.signal,
        onProgress: setProgress,
      })
      const name = filenameFor(result, stream, { mode: stealthMode })
      addAsset({
        name,
        bytes,
        mime: stream.mime,
        sizeBytes: bytes.byteLength,
        kind: kindFromMime(stream.mime, name),
        audio: null,
        durationSeconds: result.durationSeconds,
        origin: 'download',
      })
      log('holen', `${name} geladen (${formatBytes(bytes.byteLength)})`)
      setTaken({ name, bytes, mime: stream.mime })
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      const studio = cause instanceof StudioError ? cause : null
      setError({
        code: studio?.code ?? 'unknown',
        message: studio?.message ?? (cause instanceof Error ? cause.message : String(cause)),
      })
      log('holen', studio?.message ?? String(cause), 'error')
    } finally {
      setBusy(null)
      setProgress(null)
      abortRef.current = null
    }
  }

  const takeBatchItem = async (index: number) => {
    const entry = batchEntriesRef.current?.[index]
    if (!entry || !entry.result) return
    const stream =
      entry.result.streams.find((s) => s.id === entry.selectedStreamId) ||
      entry.result.streams[0]
    if (!stream) return

    const controller = new AbortController()
    abortRef.current = controller

    setBatchEntries((prev) =>
      prev
        ? prev.map((e, idx) =>
            idx === index
              ? { ...e, status: 'downloading', progress: { loaded: 0, total: stream.bytes } }
              : e
          )
        : null
    )

    try {
      const bytes = await downloadStream(stream, {
        signal: controller.signal,
        onProgress: (p) => {
          setBatchEntries((prev) =>
            prev ? prev.map((e, idx) => (idx === index ? { ...e, progress: p } : e)) : null
          )
        },
      })
      const name = filenameFor(entry.result, stream, { mode: stealthModeRef.current })
      addAsset({
        name,
        bytes,
        mime: stream.mime,
        sizeBytes: bytes.byteLength,
        kind: kindFromMime(stream.mime, name),
        audio: null,
        durationSeconds: entry.result.durationSeconds,
        origin: 'download',
      })
      log('holen', `${name} geladen (${formatBytes(bytes.byteLength)})`)
      setBatchEntries((prev) =>
        prev
          ? prev.map((e, idx) =>
              idx === index
                ? {
                    ...e,
                    status: 'done',
                    progress: null,
                    taken: { name, bytes, mime: stream.mime },
                  }
                : e
            )
          : null
      )
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      const msg =
        cause instanceof StudioError
          ? cause.message
          : cause instanceof Error
          ? cause.message
          : String(cause)
      setBatchEntries((prev) =>
        prev
          ? prev.map((e, idx) =>
              idx === index ? { ...e, status: 'error', error: msg, progress: null } : e
            )
          : null
      )
      log('holen', `Fehler beim Laden von ${entry.result.title}: ${msg}`, 'error')
    }
  }

  const downloadAllBatch = async () => {
    if (!batchEntriesRef.current) return
    setBatchBusy(true)
    try {
      for (let i = 0; i < batchEntriesRef.current.length; i++) {
        if (abortRef.current?.signal.aborted) break
        const current = batchEntriesRef.current[i]
        if (current && current.status === 'ready') {
          await takeBatchItem(i)
        }
      }
    } finally {
      setBatchBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-[16px]">
      <Card tone="cream">
        <h2 className="display-md mt-[8px] mb-[12px]">Ein Video oder Lied von einer Adresse</h2>

        {IN_DESKTOP_APP ? <AppNotice /> : <NotLocalNotice />}

        {!online ? (
          <div className="mt-[16px]">
            <Notice tone="warn" title="Keine Internetverbindung">
              Herunterladen braucht das Netz. Alle anderen Werkzeuge rechnen auf diesem Gerät und gehen weiter.
            </Notice>
          </div>
        ) : null}

        <form
          className="mt-[16px] flex flex-col gap-[8px]"
          onSubmit={(event) => {
            event.preventDefault()
            void look()
          }}
        >
          <div className="flex flex-col gap-[8px] sm:flex-row">
            <TextInput
              value={url}
              onChange={(event) => {
                setUrl(event.target.value)
                setError(null)
                setResult(null)
                setBatchEntries(null)
                setProgress(null)
              }}
              placeholder="https://... oder mehrere Links mit Komma getrennt (z. B. Link 1, Link 2)"
              inputMode="url"
              aria-label="Adresse oder kommagetrennte Adressen zum Herunterladen"
              className="flex-1"
            />
            <Button type="submit" disabled={looking || url.trim().length === 0}>
              {looking ? 'Wird gesucht …' : 'Nachsehen'}
            </Button>
          </div>

          <div className="mt-[6px] flex flex-col gap-[6px]">
            <div className="flex flex-wrap items-center gap-[10px]">
              <label htmlFor="stealth-mode-select" className="text-small font-medium text-ink">
                Dateinamen-Verschleierung:
              </label>
              <select
                id="stealth-mode-select"
                value={stealthMode}
                onChange={(e) => setStealthMode(e.target.value as StealthMode)}
                className="rounded-nav border border-line bg-canvas px-[10px] py-[4px] text-small text-ink focus:border-ink focus:outline-none"
              >
                <option value="off">Aus (Originaltitel)</option>
                <option value="standard">Standard (media_xxx.mp4)</option>
                <option value="full_security">Maximale Sicherheit (reiner Hash-Code)</option>
                <option value="teams_office">Unauffällig (Teams & Office Dokument)</option>
              </select>
            </div>
            {stealthMode !== 'off' ? (
              <p className="text-small text-muted">
                {stealthMode === 'standard' && 'Muster: media_7a8b9c.mp4 — neutraler Standardname'}
                {stealthMode === 'full_security' && 'Muster: 7a8b9c0d1e2f.mp4 — minimaler Code ohne Wörter oder Zeitbezug'}
                {stealthMode === 'teams_office' && 'Muster: Teams_Meeting_Aufzeichnung_2026-10-12_A8F2.mp4 — wirkt wie ein regulärer Office-Download'}
              </p>
            ) : null}

            {(IN_DESKTOP_APP || adapters.length > 0) ? (
              <div className="mt-[4px] flex flex-col gap-[4px] border-t border-line/60 pt-[8px]">
                <div className="flex flex-wrap items-center gap-[10px]">
                  <label htmlFor="adapter-select" className="text-small font-medium text-ink">
                    Verbindung / Netzwerkkarte:
                  </label>
                  <select
                    id="adapter-select"
                    value={selectedAdapter}
                    disabled={adapterLoading || adapters.length === 0}
                    onChange={(e) => void changeAdapter(e.target.value)}
                    className="rounded-nav border border-line bg-canvas px-[10px] py-[4px] text-small text-ink focus:border-ink focus:outline-none"
                  >
                    {adapters.length === 0 ? (
                      <option value="default">Automatisch (Windows-Standard)</option>
                    ) : (
                      adapters.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))
                    )}
                  </select>
                  <button
                    type="button"
                    onClick={() => void fetchAdapters()}
                    disabled={adapterLoading}
                    title="Adapterliste aktualisieren"
                    className="cursor-pointer text-small text-muted underline hover:text-ink disabled:opacity-50"
                  >
                    {adapterLoading ? 'Sucht…' : 'Neu suchen'}
                  </button>
                </div>
                {selectedAdapter !== 'default' ? (
                  <p className="text-small text-muted">
                    Downloads laufen über diesen Adapter — Ethernet bleibt unberührt.
                  </p>
                ) : (
                  <p className="text-small text-muted">
                    Standard: Windows entscheidet die Route. Schalte den Handy-Hotspot ein und wähle ihn hier aus, um Downloads über Mobilfunk zu leiten.
                  </p>
                )}
              </div>
            ) : null}
          </div>
        </form>

        {/* Seven lines under the field on every visit, for a question most
            people only have once something did not work. The warning above
            stays in full — that one is binding — and the result names the
            path that answered, so the explanation can wait a click. */}
        <Reveal label="Welche Wege probiert werden" className="mt-[12px]">
          {IN_DESKTOP_APP ? (
            <p className="mb-[8px] text-small leading-[1.5] text-muted">
              In der App fragt Sondra zuerst ihren eigenen Dienst: yt-dlp auf diesem Rechner, in voller
              Auflösung und für die Portale, die yt-dlp kennt. Beim ersten Mal fragt sie, ob yt-dlp
              geladen werden soll. Geht das nicht, bleiben die Wege unten.
            </p>
          ) : null}
          <p className="text-small leading-[1.5] text-muted">
            Der Dienst versucht drei Wege in dieser Reihenfolge: einen Anbieter, falls für diese
            Installation einer hinterlegt ist; sonst YouTube direkt, was einem Server nur die Fassung
            mit Bild und Ton in einem gibt, in der Regel 360p; sonst jede Adresse, die schon auf eine
            Datei zeigt. Welcher Weg geantwortet hat, steht beim Ergebnis. Für volle Auflösung ohne
            Anbieter führt der Weg über das eigene Gerät; das steht weiter unten.
          </p>
        </Reveal>
      </Card>

      {error ? (
        <Notice tone="error" title="Hat nicht geklappt">
          <p>{error.message}</p>
          {!IN_DESKTOP_APP && (error.code === 'youtube.sabr' || error.code === 'no-extractor' || error.code === 'youtube.signin') ? (
            <p className="mt-[8px]">
              Unter <span className="text-ink">Mehr Wege</span> steht, wie Sie yt-dlp auf Ihrem
              Rechner starten. Das ist eine Datei und ein Doppelklick, und danach geht alles: volle
              Auflösung, ohne diesen Dienst.
            </p>
          ) : null}
        </Notice>
      ) : null}

      {result ? (
        <Card tone="keylime" className="rise">
          <div className="flex flex-col gap-[16px] sm:flex-row">
            {result.thumbnail ? (
              <img
                src={result.thumbnail}
                alt=""
                className="h-[86px] w-[152px] shrink-0 rounded-nav object-cover ring-1 ring-line"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="truncate text-subheading text-ink">
                {stealthMode !== 'off'
                  ? `[Verschleiert: ${filenameFor(result, result.streams[0], { mode: stealthMode })}]`
                  : result.title}
              </p>
              {stealthMode === 'off' ? (
                <p className="value mt-[2px] text-small text-muted">
                  {[result.author, result.durationSeconds ? formatDuration(result.durationSeconds) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : (
                <p className="mt-[2px] text-small text-muted">
                  Anonymisierter Dateiname: {filenameFor(result, result.streams[0], { mode: stealthMode })}
                </p>
              )}
              {/* Which route answered. Not a detail: it decides the resolution
                  on offer, and it decides who saw the address. */}
              <p className="mt-[8px] text-small text-muted">
                {result.source === 'service'
                  ? serviceConnection().info?.version.includes('in Sondra')
                    ? 'Über yt-dlp auf diesem Rechner'
                    : 'Über den Dienst, den Sie verbunden haben'
                  : result.source === 'provider'
                    ? 'Über den hinterlegten Anbieter'
                    : result.source === 'youtube'
                    ? 'YouTube direkt · nur die Fassung mit Bild und Ton in einem'
                    : result.source === 'aniworld'
                    ? 'AniWorld / SerienStream direkt'
                    : 'Direkte Datei-Adresse'}
              </p>
            </div>
          </div>

          <div className="mt-[16px] flex flex-col gap-[8px]">
            {result.streams.map((stream) => (
              <div
                key={stream.id}
                // A list of options, so a rule between them rather than a box
                // around each.
                className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px] border-t border-line px-[4px] py-[12px]"
              >
                <span className="min-w-0 flex-1 text-small text-ink">{stream.label}</span>
                <span className="value text-small text-muted">
                  {stream.ext.toUpperCase()}
                  {stream.bytes ? ` · ${formatBytes(stream.bytes)}` : ''}
                </span>
                <Button size="sm" disabled={busy !== null} onClick={() => void take(stream)}>
                  {busy === stream.label ? 'Lädt …' : 'Laden'}
                </Button>
              </div>
            ))}
          </div>

          {taken && !busy ? (
            <div className="rise mt-[16px] flex flex-wrap items-center gap-[12px] border-t border-line pt-[12px]" role="status">
              <span aria-hidden className="h-[8px] w-[8px] shrink-0 rounded-pill bg-ink" />
              <p className="min-w-0 flex-1 text-small text-ink">
                <span className="value">{taken.name}</span> ist in der Sitzung —{' '}
                <span className="text-muted">oben im Dateimenü, bereit für jedes Werkzeug.</span>
              </p>
              <Button size="sm" variant="quiet" onClick={() => saveBytes(taken.bytes, taken.name, taken.mime)}>
                Auch speichern
              </Button>
            </div>
          ) : null}

          {busy ? (
            <div className="mt-[16px] flex flex-col gap-[8px]">
              <Progress
                value={progress?.total ? progress.loaded / progress.total : null}
                label={
                  progress
                    ? `${formatBytes(progress.loaded)}${progress.total ? ` von ${formatBytes(progress.total)}` : ''}`
                    : 'läuft'
                }
              />
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="press self-start rounded-nav text-small text-ink underline underline-offset-2"
              >
                Abbrechen
              </button>
            </div>
          ) : null}
        </Card>
      ) : null}

      {batchEntries ? (
        <Card tone="keylime" className="rise">
          <div className="flex flex-wrap items-center justify-between gap-[12px] border-b border-line pb-[12px]">
            <div>
              <h3 className="text-subheading text-ink">Mehrfach-Download ({batchEntries.length} Links)</h3>
              <p className="mt-[2px] text-small text-muted">
                {batchEntries.filter((e) => e.status === 'done').length} von {batchEntries.length} geladen
                {batchEntries.filter((e) => e.status === 'error').length > 0
                  ? ` · ${batchEntries.filter((e) => e.status === 'error').length} fehlgeschlagen`
                  : ''}
                {stealthMode !== 'off'
                  ? ` · Verschleierung aktiv (${
                      stealthMode === 'standard'
                        ? 'Standard'
                        : stealthMode === 'full_security'
                        ? 'Maximale Sicherheit'
                        : 'Teams / Office'
                    })`
                  : ''}
              </p>
            </div>
            <div className="flex items-center gap-[8px]">
              {batchBusy ? (
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => {
                    abortRef.current?.abort()
                    setBatchBusy(false)
                  }}
                >
                  Abbrechen
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={
                  batchBusy ||
                  looking ||
                  !batchEntries.some((e) => e.status === 'ready')
                }
                onClick={() => void downloadAllBatch()}
              >
                {batchBusy ? 'Laden läuft …' : 'Alle herunterladen'}
              </Button>
            </div>
          </div>

          <div className="mt-[16px] flex flex-col gap-[12px]">
            {batchEntries.map((entry, index) => {
              const stream =
                entry.result?.streams.find((s) => s.id === entry.selectedStreamId) ||
                entry.result?.streams[0]

              return (
                <div
                  key={`${index}-${entry.url}`}
                  className="flex flex-col gap-[8px] rounded-nav border border-line bg-panel-soft p-[12px]"
                >
                  <div className="flex flex-wrap items-center justify-between gap-[8px]">
                    <div className="min-w-0 flex-1">
                      {entry.result ? (
                        <p className="truncate text-body font-medium text-ink">
                          {stealthMode !== 'off'
                            ? filenameFor(entry.result, stream || entry.result.streams[0], { mode: stealthMode })
                            : entry.result.title}
                        </p>
                      ) : (
                        <p className="truncate text-small font-mono text-muted">{entry.url}</p>
                      )}
                      {entry.result && stealthMode === 'off' ? (
                        <p className="value text-small text-muted">
                          {[entry.result.author, entry.result.durationSeconds ? formatDuration(entry.result.durationSeconds) : null]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-[8px]">
                      {entry.status === 'resolving' ? (
                        <span className="value text-small text-muted">Wird gesucht …</span>
                      ) : null}

                      {entry.status === 'ready' && entry.result ? (
                        <>
                          {entry.result.streams.length > 1 ? (
                            <select
                              value={entry.selectedStreamId}
                              disabled={batchBusy}
                              onChange={(e) => {
                                const val = e.target.value
                                setBatchEntries((prev) =>
                                  prev
                                    ? prev.map((item, idx) =>
                                        idx === index ? { ...item, selectedStreamId: val } : item
                                      )
                                    : null
                                )
                              }}
                              className="rounded-nav border border-line bg-canvas px-[8px] py-[4px] text-small text-ink focus:border-ink focus:outline-none"
                            >
                              {entry.result.streams.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.label} ({s.ext.toUpperCase()}{s.bytes ? ` · ${formatBytes(s.bytes)}` : ''})
                                </option>
                              ))}
                            </select>
                          ) : stream ? (
                            <span className="value text-small text-muted">
                              {stream.ext.toUpperCase()}
                              {stream.bytes ? ` · ${formatBytes(stream.bytes)}` : ''}
                            </span>
                          ) : null}

                          <Button
                            size="sm"
                            disabled={batchBusy}
                            onClick={() => void takeBatchItem(index)}
                          >
                            Laden
                          </Button>
                        </>
                      ) : null}

                      {entry.status === 'done' && entry.taken ? (
                        <div className="flex items-center gap-[8px]">
                          <span className="value text-small font-medium text-ink">In der Sitzung</span>
                          <Button
                            size="sm"
                            variant="quiet"
                            onClick={() => saveBytes(entry.taken!.bytes, entry.taken!.name, entry.taken!.mime)}
                          >
                            Speichern
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {entry.status === 'error' ? (
                    <p className="text-small text-prose font-medium text-ink">{entry.error}</p>
                  ) : null}

                  {entry.status === 'downloading' && entry.progress ? (
                    <Progress
                      value={entry.progress.total ? entry.progress.loaded / entry.progress.total : null}
                      label={`${formatBytes(entry.progress.loaded)}${
                        entry.progress.total ? ` von ${formatBytes(entry.progress.total)}` : ''
                      }`}
                    />
                  ) : null}
                </div>
              )
            })}
          </div>
        </Card>
      ) : null}

      {/* The complete panel — instances, keys, cookies, playlists, full
          resolution — exactly as it was, just no longer the front door. */}
      <Reveal label="Optionen: eigener Dienst, Stream-Wege, yt-dlp auf dem eigenen Gerät">
        <AdvancedDownloader url={url} />
      </Reveal>
    </div>
  )
}
