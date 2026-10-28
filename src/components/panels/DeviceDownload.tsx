/**
 * Downloading in the Android app as the Windows app does: yt-dlp on the
 * phone (`YtDlp.java`), for every site it knows, in full resolution.
 *
 * The downloader asks the app what lies behind a portal address and shows
 * it here: the picture, the title, the heights it comes in. „Laden“ hands
 * the job to the app, which writes the file into Downloads/Sondra; how far
 * it is, and where the file went, comes back as `ytdlp` events. The jobs are
 * kept in this module, not in the panel, so leaving the tool and coming back
 * still shows them — the download goes on in the app either way.
 */

import { useState, useSyncExternalStore } from 'react'

import { ANDROID_BRIDGE, type YtdlpEvent, type YtdlpInfo } from '../../lib/android'
import { formatDuration } from '../../lib/format'
import { Button, Card, Progress } from '../ui/primitives'

interface DeviceJob {
  job: string
  title: string
  label: string
  status: YtdlpEvent['status'] | 'starting'
  progress: number
  eta: number
  savedPath?: string
  error?: string
}

let jobs: DeviceJob[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())
const setJobs = (next: DeviceJob[]) => {
  jobs = next
  emit()
}

ANDROID_BRIDGE?.onYtdlp((event) => {
  if (!jobs.some((entry) => entry.job === event.job)) return
  setJobs(
    jobs.map((entry) =>
      entry.job === event.job
        ? {
            ...entry,
            status: event.status,
            progress: event.status === 'done' ? 100 : (event.progress ?? entry.progress),
            eta: event.eta ?? -1,
            savedPath: event.savedPath ?? entry.savedPath,
            error: event.error,
          }
        : entry,
    ),
  )
})

function useJobs(): DeviceJob[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => jobs,
  )
}

/** Portal addresses go to yt-dlp; AniWorld and its hosters keep Sondra's own extractors. */
const OWN_EXTRACTORS =
  /(?:^|\.)(?:aniworld\.(?:to|la)|s\.to|serienstream\.(?:to|sx)|voe\.sx|filemoon\.(?:sx|to|in|nl|wf)|vidmoly\.(?:to|me|net)|doodstream\.com|dood\.(?:to|so|ws|wf)|streamtape\.com|vidoza\.net)$/i

export function forDevice(url: string): boolean {
  if (!ANDROID_BRIDGE) return false
  try {
    return !OWN_EXTRACTORS.test(new URL(url).hostname)
  } catch {
    return false
  }
}

type Quality = { kind: 'video'; height: number } | { kind: 'audio'; format: 'm4a' | 'mp3' | 'opus' }

const AUDIO_CHOICES: { format: 'm4a' | 'mp3' | 'opus'; label: string }[] = [
  { format: 'm4a', label: 'Nur Ton (M4A)' },
  { format: 'mp3', label: 'Nur Ton (MP3)' },
]

const pill = (on: boolean) =>
  `press rounded-pill px-[12px] py-[6px] text-small font-medium ${
    on ? 'bg-ink font-semibold text-on-ink' : 'bg-raised text-prose ring-1 ring-inset ring-line hover:text-ink hover:ring-rule'
  }`

export function DeviceDownload({
  url,
  info,
  preferAudio,
  maxHeight,
}: {
  url: string
  info: YtdlpInfo
  /** The downloader's own choice of „Ton“ or „Video“. */
  preferAudio: boolean
  /** The downloader's quality setting as a height, 0 for the best. */
  maxHeight: number
}) {
  const heights = info.heights.filter((h, i, all) => all.indexOf(h) === i)
  // „Beste“ unless the downloader's quality setting asks for less.
  const firstHeight = maxHeight > 0 ? (heights.find((h) => h <= maxHeight) ?? 0) : 0
  const [quality, setQuality] = useState<Quality>(() =>
    preferAudio || !info.video ? { kind: 'audio', format: 'm4a' } : { kind: 'video', height: firstHeight },
  )
  const [starting, setStarting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const start = async () => {
    if (!ANDROID_BRIDGE) return
    setStarting(true)
    setProblem(null)
    const label = quality.kind === 'audio' ? `Ton · ${quality.format.toUpperCase()}` : quality.height ? `Video · ${quality.height}p` : 'Video · beste'
    try {
      const answer = await ANDROID_BRIDGE.ytdlpDownload({
        url,
        mode: quality.kind,
        height: quality.kind === 'video' ? quality.height : 0,
        audioFormat: quality.kind === 'audio' ? quality.format : 'm4a',
        title: info.title,
      })
      if (!answer.ok || !answer.job) throw new Error(answer.error ?? 'Nicht gestartet')
      setJobs([{ job: answer.job, title: info.title || url, label, status: 'starting', progress: 0, eta: -1 }, ...jobs])
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStarting(false)
    }
  }

  return (
    <Card tone="keylime" className="rise">
      <div className="flex flex-col gap-[16px] sm:flex-row">
        {info.thumbnail ? (
          <img src={info.thumbnail} alt="" className="h-[86px] w-[152px] shrink-0 rounded-nav object-cover ring-1 ring-line" />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
          <p className="text-body font-semibold leading-snug text-ink">{info.title || url}</p>
          <p className="text-small text-prose">
            {[info.uploader, info.extractor, info.duration ? formatDuration(info.duration) : null].filter(Boolean).join(' · ')}
          </p>
          <p className="text-small text-prose">Lädt mit yt-dlp auf diesem Telefon, in voller Auflösung, nach Downloads/Sondra.</p>
        </div>
      </div>

      <div className="mt-[16px] flex flex-col gap-[10px] border-t border-line pt-[14px]">
        <div role="radiogroup" aria-label="Was laden" className="flex flex-wrap gap-[6px]">
          {info.video
            ? [0, ...heights.slice(0, 6)].map((height) => {
                const on = quality.kind === 'video' && quality.height === height
                return (
                  <button
                    key={`v${height}`}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setQuality({ kind: 'video', height })}
                    className={pill(on)}
                  >
                    {height === 0 ? 'Beste' : `${height}p`}
                  </button>
                )
              })
            : null}
          {AUDIO_CHOICES.map((choice) => {
            const on = quality.kind === 'audio' && quality.format === choice.format
            return (
              <button
                key={choice.format}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setQuality({ kind: 'audio', format: choice.format })}
                className={pill(on)}
              >
                {choice.label}
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap items-center gap-[12px]">
          <Button type="button" onClick={() => void start()} disabled={starting}>
            {starting ? 'Startet …' : 'Auf das Telefon laden'}
          </Button>
          {problem ? <span className="text-small text-ink">! {problem}</span> : null}
        </div>
      </div>
    </Card>
  )
}

/** The downloads running on the phone, and the ones just finished. */
export function DeviceJobs() {
  const list = useJobs()
  if (!list.length) return null
  return (
    <section aria-label="Auf dem Telefon" className="flex flex-col gap-[8px]">
      <h3 className="text-small font-semibold text-ink">Auf dem Telefon</h3>
      <ul className="flex flex-col">
        {list.map((entry) => (
          <li key={entry.job} className="flex max-w-none flex-col gap-[6px] border-t border-line py-[10px] first:border-t-0">
            <div className="flex items-baseline justify-between gap-[12px]">
              <span className="min-w-0 truncate text-small font-semibold text-ink" title={entry.title}>
                {entry.title}
              </span>
              <span className="shrink-0 text-small text-prose">{entry.label}</span>
            </div>
            {entry.status === 'running' || entry.status === 'starting' ? (
              <div className="flex items-center gap-[12px]">
                <div className="min-w-0 flex-1">
                  <Progress value={entry.progress > 0 ? entry.progress / 100 : null} />
                </div>
                <span className="value w-[5ch] text-right text-small text-ink">{entry.progress > 0 ? `${Math.round(entry.progress)} %` : ''}</span>
                <button
                  type="button"
                  onClick={() => void ANDROID_BRIDGE?.ytdlpCancel(entry.job)}
                  className="press text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
                >
                  Abbrechen
                </button>
              </div>
            ) : entry.status === 'done' ? (
              <p className="text-small text-prose">
                ● Gespeichert in <span className="value text-ink">{entry.savedPath ?? 'Downloads/Sondra'}</span>
              </p>
            ) : entry.status === 'cancelled' ? (
              <p className="text-small text-prose">Abgebrochen.</p>
            ) : (
              <p className="text-small text-ink">! {entry.error ?? 'Nicht geladen.'}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
