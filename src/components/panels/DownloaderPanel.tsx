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

import { saveBytes } from '../../lib/download'
import { formatBytes, formatDuration } from '../../lib/format'
import {
  StudioError,
  downloadStream,
  filenameFor,
  resolveViaService,
  type StudioResult,
  type StudioStream,
} from '../../lib/studio'
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

/* -------------------------------------------------------------------------- */

export function DownloaderPanel() {
  const addAsset = useSession((state) => state.addAsset)
  const log = useSession((state) => state.log)

  const [url, setUrl] = useState('')
  const [looking, setLooking] = useState(false)
  const [result, setResult] = useState<StudioResult | null>(null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ loaded: number; total: number | null } | null>(null)
  /** What the last „Laden“ put into the session, so it can still be saved. */
  const [taken, setTaken] = useState<{ name: string; bytes: Uint8Array; mime: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  const look = async () => {
    const target = url.trim()
    if (!target) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLooking(true)
    setError(null)
    setResult(null)
    setTaken(null)
    try {
      const found = await resolveViaService(target, controller.signal)
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
      const name = filenameFor(result, stream)
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
      // Into the session only. Saving to disk is one click on the line below
      // and in the file menu — a download that also started a browser
      // download was one file too many for anyone who only wanted to edit it.
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

  return (
    <div className="flex flex-col gap-[16px]">
      <Card tone="cream">
        <h2 className="display-md mt-[8px] mb-[12px]">Ein Video oder Lied von einer Adresse</h2>

        <NotLocalNotice />

        <form
          className="mt-[16px] flex flex-col gap-[8px] sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault()
            void look()
          }}
        >
          <TextInput
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              // A new address makes the last answer stale. Leaving it up was
              // worse than showing nothing: somebody who had a failure here,
              // then pasted a different link, kept reading the old refusal as
              // a verdict on the new one — including „Es wurde keine Adresse
              // übergeben" sitting under a field with an address in it.
              setError(null)
              setResult(null)
              setProgress(null)
            }}
            placeholder="https://www.youtube.com/watch?v=… oder eine Adresse, die direkt auf eine Datei zeigt"
            inputMode="url"
            aria-label="Adresse zum Herunterladen"
            className="flex-1"
          />
          <Button type="submit" disabled={looking || url.trim().length === 0}>
            {looking ? 'Wird gesucht …' : 'Nachsehen'}
          </Button>
        </form>

        {/* Seven lines under the field on every visit, for a question most
            people only have once something did not work. The warning above
            stays in full — that one is binding — and the result names the
            path that answered, so the explanation can wait a click. */}
        <Reveal label="Welche Wege probiert werden" className="mt-[12px]">
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
          {error.code === 'youtube.sabr' || error.code === 'no-extractor' || error.code === 'youtube.signin' ? (
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
              <p className="truncate text-subheading text-ink">{result.title}</p>
              <p className="value mt-[2px] text-small text-muted">
                {[result.author, result.durationSeconds ? formatDuration(result.durationSeconds) : null]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {/* Which route answered. Not a detail: it decides the resolution
                  on offer, and it decides who saw the address. */}
              <p className="mt-[8px] text-small text-muted">
                {result.source === 'service'
                  ? 'Über den Dienst, den Sie verbunden haben'
                  : result.source === 'provider'
                    ? 'Über den hinterlegten Anbieter'
                    : result.source === 'youtube'
                    ? 'YouTube direkt · nur die Fassung mit Bild und Ton in einem'
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

      {/* The complete panel — instances, keys, cookies, playlists, full
          resolution — exactly as it was, just no longer the front door. */}
      <Reveal label="Optionen: eigener Dienst, Stream-Wege, yt-dlp auf dem eigenen Gerät">
        <AdvancedDownloader url={url} />
      </Reveal>
    </div>
  )
}
