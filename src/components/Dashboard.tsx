/**
 * The working surface: tool switcher, the tool, and the machine readout folded
 * away underneath it.
 */

import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react'

import { detectCapabilities, hasWebGpuAdapter, suggestedThreads } from '../lib/capabilities'
import { onServiceConnection, serviceConnection, type ServiceConnection } from '../lib/serviceState'
import { loadFfmpeg, onFfmpegStatus, type FfmpegStatus } from '../lib/ffmpegClient'
import type { ResolvedTheme } from '../lib/theme'
import { useSession } from '../state/store'
/*
 * Each tool is its own chunk, fetched when it is opened. The start screen used
 * to wait for all eleven — some 620 KB of script, parsed before the first
 * tile could be drawn. Once the page has settled the rest come down in the
 * background, so opening a tool later does not wait on the network either.
 */
const TOOLS = {
  downloader: () => import('./panels/DownloaderPanel').then((m) => ({ default: m.DownloaderPanel })),
  converter: () => import('./panels/ConverterPanel').then((m) => ({ default: m.ConverterPanel })),
  audio: () => import('./panels/AudioEditorPanel').then((m) => ({ default: m.AudioEditorPanel })),
  video: () => import('./panels/VideoPanel').then((m) => ({ default: m.VideoPanel })),
  images: () => import('./panels/ImagePanel').then((m) => ({ default: m.ImagePanel })),
  stems: () => import('./panels/StemsPanel').then((m) => ({ default: m.StemsPanel })),
  normalize: () => import('./panels/NormalizePanel').then((m) => ({ default: m.NormalizePanel })),
  sampler: () => import('./panels/SamplerPanel').then((m) => ({ default: m.SamplerPanel })),
  harmony: () => import('./panels/HarmonyPanel').then((m) => ({ default: m.HarmonyPanel })),
  mic: () => import('./panels/MicPanel').then((m) => ({ default: m.MicPanel })),
  subtitles: () => import('./panels/SubtitlesPanel').then((m) => ({ default: m.SubtitlesPanel })),
} satisfies Record<string, () => Promise<{ default: ComponentType<{ theme: ResolvedTheme }> | ComponentType }>>

const DownloaderPanel = lazy(TOOLS.downloader)
const ConverterPanel = lazy(TOOLS.converter)
const AudioEditorPanel = lazy(TOOLS.audio)
const VideoPanel = lazy(TOOLS.video)
const ImagePanel = lazy(TOOLS.images)
const StemsPanel = lazy(TOOLS.stems)
const NormalizePanel = lazy(TOOLS.normalize)
const SamplerPanel = lazy(TOOLS.sampler)
const HarmonyPanel = lazy(TOOLS.harmony)
const MicPanel = lazy(TOOLS.mic)
const SubtitlesPanel = lazy(TOOLS.subtitles)

/** Fetches every tool's chunk once the page is idle. */
function usePrefetchTools() {
  useEffect(() => {
    const load = () => Object.values(TOOLS).forEach((get) => void get().catch(() => undefined))
    let idle: number | null = null
    const timer = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(load, { timeout: 4000 })
      else load()
    }, 1500)
    return () => {
      window.clearTimeout(timer)
      if (idle !== null) window.cancelIdleCallback(idle)
    }
  }, [])
}

/** What stands in a tool's place for the moment its chunk is on its way. */
function ToolLoading() {
  return (
    <p role="status" className="py-[24px] text-small text-muted">
      Werkzeug wird geladen …
    </p>
  )
}
import { FileDrop } from './FileDrop'
import { Home } from './Home'
import { RestoreOffer } from './RestoreOffer'
import { PANELS } from './panelMeta'
import { Button, Card } from './ui/primitives'

/* -------------------------------------------------------------------------- */
/* Machine readout                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What this browser can do, and what the app has been doing.
 *
 * Both of these used to be full-width cards sitting under every tool on every
 * screen — a permanent reference table and an empty log, between the work and
 * the bottom of the page. Neither is needed while working and both are needed
 * when something goes wrong, which is the definition of a disclosure.
 */
function MachineRow() {
  const [open, setOpen] = useState<'system' | 'log' | null>(null)
  const [webgpu, setWebgpu] = useState<boolean | null>(null)
  const [service, setService] = useState<ServiceConnection>(serviceConnection)
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus>({ loaded: false, multiThreaded: false, threads: 1 })
  const logs = useSession((state) => state.logs)
  const clearLogs = useSession((state) => state.clearLogs)
  const caps = detectCapabilities()

  useEffect(() => {
    void hasWebGpuAdapter().then(setWebgpu)
  }, [])
  // The core can be loaded from any panel, so the row listens rather than polls.
  useEffect(() => onFfmpegStatus(setFfmpeg), [])
  // Same for the extraction service: answered here, on every tab, rather than
  // only inside the panel that happens to own the connection.
  useEffect(() => onServiceConnection(setService), [])

  const entries = [
    {
      label: 'Mehrkern-Rechnen',
      value: caps.crossOriginIsolated ? 'aktiv' : 'aus',
      note: caps.crossOriginIsolated
        ? `FFmpeg darf ${suggestedThreads(caps)} von ${caps.cores} Kernen nutzen`
        : 'FFmpeg läuft auf einem Kern und ist damit langsamer',
    },
    {
      label: 'Grafikkarte',
      value: webgpu === null ? 'wird geprüft' : webgpu ? 'nutzbar' : 'nicht nutzbar',
      note: 'Beschleunigt das Trennen von Spuren',
    },
    {
      label: 'Direkt speichern',
      value: caps.fileSystemAccess ? 'möglich' : 'nicht möglich',
      note: caps.fileSystemAccess
        ? 'Große Downloads gehen direkt auf die Festplatte'
        : 'Downloads laufen erst durch den Arbeitsspeicher',
    },
    {
      label: 'Dienst für Portale',
      value: service.info ? 'verbunden' : service.searching ? 'wird gesucht' : 'aus',
      note: service.info
        ? `${(service.endpoint ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')} · ${
            service.info.services.includes('youtube') ? 'YouTube geht' : 'ohne YouTube'
          }`
        : service.searching
          ? 'wartet auf eine Instanz auf diesem Rechner'
          : 'nur für YouTube und ähnliche Portale nötig',
    },
    {
      label: 'FFmpeg',
      value: ffmpeg.loaded ? 'geladen' : 'noch nicht geladen',
      note: ffmpeg.loaded
        ? ffmpeg.multiThreaded
          ? `mehrfädig, ${ffmpeg.threads} Threads`
          : 'einfädig'
        : 'wird beim ersten Umwandeln geholt',
    },
  ]

  const tab = (id: 'system' | 'log', label: string, count?: number) => (
    <button
      type="button"
      onClick={() => setOpen((value) => (value === id ? null : id))}
      aria-expanded={open === id}
      className={`press flex items-center gap-[8px] px-[12px] py-[8px] text-small ${
        open === id ? 'bg-ink text-on-ink' : 'text-muted hover:bg-panel-soft hover:text-ink'
      }`}
    >
      {label}
      {count ? (
        <span
          className={`value px-[8px] text-micro ${
            open === id ? 'bg-on-ink/20' : 'bg-panel-mid text-ink'
          }`}
        >
          {count}
        </span>
      ) : null}
    </button>
  )

  return (
    <div className="mt-[4px]">
      <div className="flex flex-wrap items-center gap-[8px] border-t border-line pt-[12px]">
        <span className="mr-[4px] text-small text-muted">Unter der Haube</span>
        {tab('system', 'Dieses Gerät')}
        {tab('log', 'Protokoll', logs.length)}
        {!ffmpeg.loaded ? (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void loadFfmpeg()}>
            FFmpeg jetzt laden
          </Button>
        ) : null}
      </div>

      {open === 'system' ? (
        <dl className="rise mt-[12px] grid gap-[16px] rounded-card bg-raised p-[16px] ring-1 ring-inset ring-line sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((entry) => (
            <div key={entry.label} className="flex flex-col gap-[2px]">
              <dt className="text-small font-semibold text-muted">
                {entry.label}
              </dt>
              <dd className="text-body text-ink">{entry.value}</dd>
              <p className="text-small leading-[1.45] text-muted">{entry.note}</p>
            </div>
          ))}
        </dl>
      ) : null}

      {open === 'log' ? (
        <div className="rise mt-[12px] rounded-card bg-raised p-[16px] ring-1 ring-inset ring-line">
          {logs.length === 0 ? (
            <p className="text-small text-muted">Noch keine Einträge.</p>
          ) : (
            <>
              <div className="mb-[12px] flex justify-end">
                <button
                  type="button"
                  onClick={clearLogs}
                  className="press rounded-nav text-small text-muted underline-offset-2 hover:text-ink hover:underline"
                >
                  Leeren
                </button>
              </div>
              <ol className="flex max-h-[260px] flex-col gap-[8px] overflow-y-auto font-mono text-small leading-[1.5]">
                {logs
                  .slice()
                  .reverse()
                  .map((line) => (
                    <li key={line.id} className="flex gap-[12px]">
                      <span className="value shrink-0 text-muted">
                        {new Date(line.at).toLocaleTimeString('de-DE')}
                      </span>
                      <span className="shrink-0 text-ink">{line.scope}</span>
                      <span className={line.level === 'error' ? 'text-ink' : 'text-prose/85'}>
                        {line.message}
                      </span>
                    </li>
                  ))}
              </ol>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Empty states                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a tool shows before it has anything to work on.
 *
 * Five panels used to answer this question five times over, and each of them
 * twice on the same screen: a drop zone in the middle, a second one in the
 * sidebar, and the library saying "nothing loaded" underneath. Three ways to do
 * one thing, surrounded by settings for material that did not exist.
 */
function NothingLoaded({ label, summary }: { label: string; summary: string }) {
  const setPanel = useSession((state) => state.setPanel)

  return (
    <Card tone="cream" className="rise">
      <div className="flex max-w-[560px] flex-col items-start gap-[16px] sm:mx-auto sm:items-center sm:text-center">
        {/* The tool's name stood above this in small type — an eyebrow over
            the real heading, and the tab bar right above says the name
            already. The summary is the heading. */}
        <div>
          <h2 className="text-subheading font-semibold text-ink" aria-label={`${label}: ${summary}`}>
            {summary}
          </h2>
          <p className="mt-[8px] text-body leading-[1.55] text-prose/85">
            Dafür braucht es erst eine Datei. Alles, was Sie hinzufügen, bleibt auf diesem Gerät.
          </p>
        </div>

        <div className="w-full">
          <FileDrop />
        </div>

        <p className="text-small text-muted">
          Keine Datei zur Hand?{' '}
          <button
            type="button"
            onClick={() => setPanel('downloader')}
            className="press rounded-nav text-ink underline underline-offset-2"
          >
            Über eine Adresse herunterladen
          </button>
        </p>
      </div>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */

export function Dashboard({ theme }: { theme: ResolvedTheme }) {
  usePrefetchTools()
  const panel = useSession((state) => state.panel)
  const hasAssets = useSession((state) => state.assets.length > 0)
  const current = PANELS.find((entry) => entry.id === panel)
  // The start screen and the downloader never wait for a file: one is the menu
  // and the other is how files arrive. The three editors open on their own
  // drop zone, which is a better empty state than a generic one.
  const ready =
    hasAssets ||
    panel === 'start' ||
    panel === 'downloader' ||
    panel === 'video' ||
    panel === 'images' ||
    panel === 'audio' ||
    panel === 'mic'

  return (
    <section id="studio" className="shell flex flex-col gap-[16px] pb-[16px] pt-[24px] sm:pt-[32px]">
      <RestoreOffer />

      {/* Keyed on the panel so every switch replays the entrance rather than
          swapping content in place, which reads as a jump. */}
      <div key={panel} role="tabpanel" aria-label={current?.label} className="panel-root rise flex min-w-0 flex-col gap-[16px]">
        {!ready ? (
          <NothingLoaded label={current?.label ?? ''} summary={current?.summary ?? ''} />
        ) : (
          <Suspense fallback={<ToolLoading />}>
            {panel === 'start' ? <Home /> : null}
            {panel === 'downloader' ? <DownloaderPanel /> : null}
            {panel === 'converter' ? <ConverterPanel /> : null}
            {panel === 'audio' ? <AudioEditorPanel /> : null}
            {panel === 'video' ? <VideoPanel /> : null}
            {panel === 'images' ? <ImagePanel /> : null}
            {panel === 'stems' ? <StemsPanel /> : null}
            {panel === 'normalize' ? <NormalizePanel /> : null}
            {panel === 'sampler' ? <SamplerPanel theme={theme} /> : null}
            {panel === 'harmony' ? <HarmonyPanel /> : null}
            {panel === 'mic' ? <MicPanel /> : null}
            {panel === 'subtitles' ? <SubtitlesPanel /> : null}
          </Suspense>
        )}
      </div>

      <MachineRow />
    </section>
  )
}
