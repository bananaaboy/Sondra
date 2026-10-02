/**
 * „Abspielen“ — a player for watching and listening, and for nothing else.
 *
 * The editors show a picture so it can be cut. This one shows it so it can be
 * watched: the picture owns the frame, the controls lie over it and step
 * aside while it plays, and everything that can be set — quality, tempo,
 * subtitles, sound track, picture, sound, what happens at the end — sits
 * behind one gear, the way every player people know does it.
 *
 * Four sizes: in the column next to the list, the cinema mode (wider, the
 * list goes underneath), filling the browser window without leaving it, and
 * the real full screen.
 *
 * Files are played where they lie (lib/player.ts): a picked or dropped file is
 * never read into memory or taken into the session, so a 4 GB film opens as
 * fast as a song. What the browser cannot decode gets a stand-in from FFmpeg,
 * read through WORKERFS; a lower quality or another sound track is made the
 * same way, while the film keeps playing.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

import { useIngestFiles } from '../../hooks/useIngest'
import { getAudioContext, resumeAudioContext } from '../../lib/audio'
import { diskPath, probeDisk, runFfmpegOnDisk, unloadFfmpeg, type DiskFacts, type StreamInfo } from '../../lib/ffmpegClient'
import { formatBytes } from '../../lib/format'
import { NATIVE_CONTAINER, browserPlaysAudio, codecName, diskName, remedyFor, standJob, type Remedy } from '../../lib/playable'
import {
  PLAYER_ACCEPT,
  QUALITY_STEPS,
  RATES,
  claimDrops,
  clock,
  isSubtitleFile,
  playerKind,
  rateLabel,
  rememberPlace,
  rememberSettings,
  rememberedPlace,
  rememberedSettings,
  stemOf,
  subtitleUrl,
  type PlayerItem,
  type PlayerSettings,
} from '../../lib/player'
import { holdScreenAwake } from '../../lib/wakeLock'
import { useSession, type Asset } from '../../state/store'
import { SettingsMenu, type Quality, type QualityState, type TrackState } from '../player/SettingsMenu'
import { ArrowRight, Button } from '../ui/primitives'

/* -------------------------------------------------------------------------- */
/* Icons — the project's own stroke set                                         */
/* -------------------------------------------------------------------------- */

function Glyph({ children, filled = false, size = 20 }: { children: ReactNode; filled?: boolean; size?: number }) {
  return (
    <svg
      viewBox="0 0 20 20"
      style={{ width: size, height: size }}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

const PlayIcon = ({ size }: { size?: number }) => (
  <Glyph filled size={size}>
    <path d="M6.2 3.9c0-.8.9-1.3 1.6-.9l8.6 5.4c.6.4.6 1.3 0 1.7l-8.6 5.4c-.7.4-1.6-.1-1.6-.9z" />
  </Glyph>
)
const PauseIcon = ({ size }: { size?: number }) => (
  <Glyph filled size={size}>
    <rect x="5" y="3.8" width="3.4" height="12.4" rx="1.1" />
    <rect x="11.6" y="3.8" width="3.4" height="12.4" rx="1.1" />
  </Glyph>
)
const BackIcon = () => (
  <Glyph>
    <path d="M9.5 6.2V3.6L5.4 7l4.1 3.4V7.8a4.6 4.6 0 11-4.4 6" />
  </Glyph>
)
const ForwardIcon = () => (
  <Glyph>
    <path d="M10.5 6.2V3.6L14.6 7l-4.1 3.4V7.8a4.6 4.6 0 104.4 6" />
  </Glyph>
)
const PrevIcon = () => (
  <Glyph filled>
    <rect x="4" y="4.5" width="2" height="11" rx="1" />
    <path d="M15.6 5.2c0-.7-.8-1.1-1.4-.7L8.2 9.2c-.5.4-.5 1.2 0 1.6l6 4.7c.6.4 1.4 0 1.4-.7z" />
  </Glyph>
)
const NextIcon = () => (
  <Glyph filled>
    <rect x="14" y="4.5" width="2" height="11" rx="1" />
    <path d="M4.4 5.2c0-.7.8-1.1 1.4-.7l6 4.7c.5.4.5 1.2 0 1.6l-6 4.7c-.6.4-1.4 0-1.4-.7z" />
  </Glyph>
)
const VolumeIcon = ({ level }: { level: number }) => (
  <Glyph>
    <path d="M3.5 7.5h2.8L10.5 4v12l-4.2-3.5H3.5z" />
    {level === 0 ? <path d="M13.5 7.5l3.5 5M17 7.5l-3.5 5" /> : <path d="M13.5 7.4a3.6 3.6 0 010 5.2" />}
    {level > 0.5 ? <path d="M15.6 5.4a6.4 6.4 0 010 9.2" /> : null}
  </Glyph>
)
const CaptionIcon = () => (
  <Glyph>
    <rect x="2.6" y="4.4" width="14.8" height="11.2" rx="2.4" />
    <path d="M8.4 8.6a2 2 0 100 2.8M14.2 8.6a2 2 0 100 2.8" />
  </Glyph>
)
const GearIcon = () => (
  <Glyph>
    <path d="M10 12.6a2.6 2.6 0 100-5.2 2.6 2.6 0 000 5.2z" />
    <path d="M16.2 11.8l1.2.9-1.6 2.8-1.4-.6a6 6 0 01-1.6.9l-.2 1.5H9.4l-.2-1.5a6 6 0 01-1.6-.9l-1.4.6-1.6-2.8 1.2-.9a6 6 0 010-1.8l-1.2-.9 1.6-2.8 1.4.6a6 6 0 011.6-.9l.2-1.5h3.2l.2 1.5a6 6 0 011.6.9l1.4-.6 1.6 2.8-1.2.9a6 6 0 010 1.8z" />
  </Glyph>
)
const PipIcon = () => (
  <Glyph>
    <rect x="2.6" y="4.4" width="14.8" height="11.2" rx="2.2" />
    <rect x="10" y="9.6" width="5" height="3.6" rx="0.8" fill="currentColor" stroke="none" />
  </Glyph>
)
const TheaterIcon = () => (
  <Glyph>
    <rect x="2" y="5.6" width="16" height="8.8" rx="2" />
  </Glyph>
)
/** The browser window: a frame with its bar, filled. */
const WindowIcon = ({ on }: { on: boolean }) => (
  <Glyph>
    <rect x="2.4" y="3.6" width="15.2" height="12.8" rx="2.2" />
    <path d="M2.4 7h15.2" />
    {on ? <path d="M8 9.6l-2 2 2 2M12 9.6l2 2-2 2" /> : <path d="M6 13.8l2.6-2.6M14 9.2l-2.6 2.6M6 13.8h2.2M6 13.8v-2.2M14 9.2h-2.2M14 9.2v2.2" />}
  </Glyph>
)
const FullIcon = ({ on }: { on: boolean }) => (
  <Glyph>
    {on ? <path d="M7.5 3.5v4h-4M12.5 3.5v4h4M7.5 16.5v-4h-4M12.5 16.5v-4h4" /> : <path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" />}
  </Glyph>
)

/** A control over the picture: no ground of its own until pointed at. */
function Control({
  label,
  onClick,
  active,
  disabled,
  wideOnly = false,
  toggle,
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  wideOnly?: boolean
  toggle?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      data-own-focus
      data-settings-toggle={toggle}
      className={`press ${wideOnly ? 'hidden sm:grid' : 'grid'} relative h-[40px] w-[40px] shrink-0 place-items-center rounded-pill text-white outline-none transition-colors duration-[var(--dur-fast)] hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white disabled:opacity-35 disabled:hover:bg-transparent`}
    >
      {children}
      {active ? <span className="absolute bottom-[5px] h-[3px] w-[14px] rounded-pill bg-stage-accent" aria-hidden /> : null}
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* The timeline over the picture                                               */
/* -------------------------------------------------------------------------- */

function SeekBar({ time, duration, buffered, onSeek }: { time: number; duration: number; buffered: number; onSeek: (seconds: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ x: number; seconds: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const known = duration > 0 && Number.isFinite(duration)
  const share = (value: number) => (known ? `${Math.min(100, (value / duration) * 100)}%` : '0%')

  const at = (event: ReactPointerEvent) => {
    const box = ref.current?.getBoundingClientRect()
    if (!box || !known) return null
    const x = Math.min(box.width, Math.max(0, event.clientX - box.left))
    return { x, seconds: (x / box.width) * duration, width: box.width }
  }

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      data-own-focus
      aria-label="Position"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration) || 0}
      aria-valuenow={Math.round(time)}
      aria-valuetext={`${clock(time)} von ${clock(duration)}`}
      aria-disabled={!known}
      onPointerDown={(event) => {
        const point = at(event)
        if (!point) return
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
        onSeek(point.seconds)
      }}
      onPointerMove={(event) => {
        const point = at(event)
        setHover(point)
        if (dragging && point) onSeek(point.seconds)
      }}
      onPointerUp={() => setDragging(false)}
      onPointerLeave={() => !dragging && setHover(null)}
      onKeyDown={(event) => {
        if (!known) return
        const step = { ArrowLeft: -5, ArrowRight: 5, PageDown: -60, PageUp: 60 }[event.key]
        if (step !== undefined) onSeek(Math.min(duration, Math.max(0, time + step)))
        else if (event.key === 'Home') onSeek(0)
        else if (event.key === 'End') onSeek(Math.max(0, duration - 1))
        else return
        event.preventDefault()
        event.stopPropagation()
      }}
      className="group/seek relative flex h-[20px] cursor-pointer touch-none items-center rounded-pill outline-none focus-visible:ring-2 focus-visible:ring-white"
    >
      <div className={`relative w-full overflow-hidden rounded-pill bg-white/25 transition-[height] duration-[var(--dur-fast)] ${dragging ? 'h-[7px]' : 'h-[4px] group-hover/seek:h-[7px]'}`}>
        <div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: share(buffered) }} />
        {hover ? <div className="absolute inset-y-0 left-0 bg-white/30" style={{ width: hover.x }} /> : null}
        <div className="absolute inset-y-0 left-0 bg-stage-accent" style={{ width: share(time) }} />
      </div>
      {known ? (
        <div
          className={`pointer-events-none absolute top-1/2 h-[15px] w-[15px] -translate-x-1/2 -translate-y-1/2 rounded-pill bg-white shadow-[0_1px_6px_rgb(0_0_0/0.5)] transition-transform duration-[var(--dur-fast)] ${
            dragging ? 'scale-100' : 'scale-0 group-hover/seek:scale-100 group-focus-visible/seek:scale-100'
          }`}
          style={{ left: share(time) }}
          aria-hidden
        />
      ) : null}
      {hover ? (
        <span
          className="value pointer-events-none absolute bottom-[26px] -translate-x-1/2 rounded-nav bg-black/80 px-[8px] py-[4px] text-small text-white"
          style={{ left: Math.min(Math.max(hover.x, 30), hover.width - 30) }}
          aria-hidden
        >
          {clock(hover.seconds)}
        </span>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* What a file contains, said plainly                                          */
/* -------------------------------------------------------------------------- */

const LANGUAGES: Record<string, string> = {
  ger: 'Deutsch', deu: 'Deutsch', eng: 'Englisch', fre: 'Französisch', fra: 'Französisch', ita: 'Italienisch',
  spa: 'Spanisch', por: 'Portugiesisch', jpn: 'Japanisch', rus: 'Russisch', tur: 'Türkisch', nld: 'Niederländisch',
  dut: 'Niederländisch', pol: 'Polnisch', kor: 'Koreanisch', chi: 'Chinesisch', zho: 'Chinesisch', ara: 'Arabisch',
}

function trackLabel(stream: StreamInfo): string {
  const parts = [stream.title, stream.language ? LANGUAGES[stream.language] ?? stream.language.toUpperCase() : null, codecName(stream.codec)]
  return `${stream.index + 1} · ${parts.filter(Boolean).join(' · ')}`
}

const STAND_TEXT: Record<Remedy, { doing: string; why: (facts: DiskFacts) => string }> = {
  repack: {
    doing: 'Wird umgepackt',
    why: () => 'Bild und Ton kann der Browser abspielen, die Hülle der Datei nicht. Sie wird getauscht, das dauert meist nur Sekunden.',
  },
  sound: {
    doing: 'Ton wird umgewandelt',
    why: (facts) =>
      `Den Ton (${codecName(facts.streams.find((s) => s.type === 'audio')?.codec ?? null)}) spielt dieser Browser nicht ab. Nur die Tonspur wird umgewandelt, das Bild bleibt, wie es ist.`,
  },
  picture: {
    doing: 'Wird für den Browser umgewandelt',
    why: (facts) =>
      `Das Bild (${codecName(facts.streams.find((s) => s.type === 'video')?.codec ?? null)}) kann dieser Browser nicht anzeigen. Es wird in höchstens 720p neu gerechnet — das dauert etwa so lange wie der Film selbst, oft länger.`,
  },
}

/** A version FFmpeg makes: the stand-in a file needs, or one that was chosen. */
interface Version {
  itemId: string
  reason: 'needed' | 'chosen'
  remedy: Remedy
  height: number | null
  audioIndex: number
  /** 0 while waiting to be asked (a slow encode), then the progress. */
  fraction: number
  started: boolean
  url: string | null
  error: string | null
}

type Spec = Pick<Version, 'reason' | 'remedy' | 'height' | 'audioIndex'>

let nextId = 0
const newId = () => `p${Date.now().toString(36)}${(nextId++).toString(36)}`

/* -------------------------------------------------------------------------- */
/* The panel                                                                   */
/* -------------------------------------------------------------------------- */

export function PlayerPanel() {
  const sessionAssets = useSession((state) => state.assets)
  const setActiveAsset = useSession((state) => state.setActiveAsset)
  const setPanel = useSession((state) => state.setPanel)
  const log = useSession((state) => state.log)
  const { ingest } = useIngestFiles()

  const [items, setItems] = useState<PlayerItem[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const current = items.find((item) => item.id === currentId) ?? null

  const [settings, setSettings] = useState<PlayerSettings>(rememberedSettings)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [captions, setCaptions] = useState(-1)
  const [resume, setResume] = useState<number | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [theater, setTheater] = useState(false)
  const [fill, setFill] = useState(false)
  const [idle, setIdle] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [remaining, setRemaining] = useState(false)
  const [flash, setFlash] = useState<{ key: number; icon: 'play' | 'pause' | 'back' | 'forward' } | null>(null)
  const [facts, setFacts] = useState<Record<string, DiskFacts | 'pending'>>({})
  const [versions, setVersions] = useState<Record<string, Version>>({})
  const [dragging, setDragging] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const pickRef = useRef<HTMLInputElement>(null)
  const subtitlePickRef = useRef<HTMLInputElement>(null)
  const jobAbort = useRef<AbortController | null>(null)
  const lastSaved = useRef(0)
  const wasPlaying = useRef(true)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const currentIdRef = useRef(currentId)
  currentIdRef.current = currentId
  const versionsRef = useRef(versions)
  versionsRef.current = versions

  const updateSettings = useCallback(
    (patch: Partial<PlayerSettings>) =>
      setSettings((value) => {
        const next = { ...value, ...patch }
        rememberSettings(next)
        return next
      }),
    [],
  )

  /* -- adding files ------------------------------------------------------------ */

  const addFiles = useCallback(
    async (list: File[], play: boolean) => {
      const media = list.filter((file) => playerKind(file))
      const subs = list.filter(isSubtitleFile)
      const added: PlayerItem[] = media.map((file) => ({
        id: newId(),
        name: file.name || 'Datei',
        size: file.size,
        kind: playerKind(file)!,
        source: file,
        subtitles: [],
      }))
      const pool = [...itemsRef.current.map((item) => ({ ...item })), ...added]
      // A subtitle file goes with the film of the same name (also „Film.de.srt“);
      // otherwise with the one that is playing.
      for (const file of subs) {
        const stem = stemOf(file.name)
        const owner =
          pool.find((item) => stemOf(item.name) === stem || stemOf(item.name) === stem.replace(/\.[a-z]{2,3}$/, '')) ??
          pool.find((item) => item.id === currentIdRef.current) ??
          added[0]
        if (owner) owner.subtitles = [...owner.subtitles, { label: file.name.replace(/\.(srt|vtt)$/i, ''), url: await subtitleUrl(file) }]
      }
      if (media.length === 0 && subs.length === 0 && list.length > 0) {
        log('abspielen', `${list.length === 1 ? list[0].name : `${list.length} Dateien`} übersprungen — kein Video und kein Ton`, 'warn')
      }
      setItems(pool)
      if (subs.length > 0) setCaptions(0)
      if (added.length > 0 && (play || !currentIdRef.current)) setCurrentId(added[0].id)
    },
    [log],
  )

  // While this tool is open, a drop anywhere on the window is the player's.
  useEffect(() => {
    claimDrops((files) => void addFiles(files, true))
    return () => claimDrops(null)
  }, [addFiles])

  const addAsset = (asset: Asset) => {
    const item: PlayerItem = {
      id: newId(),
      name: asset.name,
      size: asset.sizeBytes,
      kind: asset.kind === 'audio' ? 'audio' : 'video',
      source: asset.source ?? new Blob([asset.bytes as BlobPart], { type: asset.mime }),
      subtitles: [],
      assetId: asset.id,
    }
    setItems((value) => [...value, item])
    setCurrentId(item.id)
  }

  /* -- versions FFmpeg makes ------------------------------------------------------ */

  const dropVersion = (id: string) =>
    setVersions((value) => {
      const old = value[id]
      if (!old) return value
      if (old.url) URL.revokeObjectURL(old.url)
      const { [id]: _gone, ...rest } = value
      return rest
    })

  const remove = (id: string) => {
    const value = itemsRef.current
    value.find((item) => item.id === id)?.subtitles.forEach((track) => URL.revokeObjectURL(track.url))
    const rest = value.filter((item) => item.id !== id)
    setItems(rest)
    dropVersion(id)
    if (id === currentIdRef.current) {
      const at = value.findIndex((item) => item.id === id)
      setCurrentId(rest[Math.min(at, rest.length - 1)]?.id ?? null)
    }
  }

  const version = current ? versions[current.id] ?? null : null

  const make = async (item: PlayerItem, found: DiskFacts, spec: Spec) => {
    jobAbort.current?.abort()
    const controller = new AbortController()
    jobAbort.current = controller
    const keepOld = versionsRef.current[item.id]?.url ?? null
    setVersions((value) => ({ ...value, [item.id]: { ...spec, itemId: item.id, fraction: 0.0001, started: true, url: keepOld, error: null } }))
    const started = performance.now()
    try {
      const name = diskName(item.name)
      const job = standJob(spec.remedy, found, diskPath(name), {
        maxHeight: spec.height ?? 720,
        crf: spec.height && spec.height <= 480 ? 26 : 23,
        audioIndex: spec.audioIndex,
      })
      const { files } = await runFfmpegOnDisk({
        source: item.source,
        name,
        args: () => job.args,
        output: [job.output],
        signal: controller.signal,
        onProgress: (fraction) =>
          setVersions((value) => {
            const now = value[item.id]
            return now && now.started && now.fraction < 1 ? { ...value, [item.id]: { ...now, fraction: Math.max(0.0001, Math.min(0.999, fraction)) } } : value
          }),
      })
      if (controller.signal.aborted) return
      const url = URL.createObjectURL(new Blob([files[job.output] as BlobPart], { type: job.mime }))
      // The film keeps its place and keeps playing across the swap.
      const node = videoRef.current
      if (currentIdRef.current === item.id && node) {
        if (node.currentTime > 0) setResume(node.currentTime)
        wasPlaying.current = !node.paused
      }
      if (keepOld) URL.revokeObjectURL(keepOld)
      setVersions((value) => ({ ...value, [item.id]: { ...spec, itemId: item.id, fraction: 1, started: true, url, error: null } }))
      setFailed(false)
      log('abspielen', `${item.name}: ${spec.height ? `${spec.height}p` : 'abspielbare Fassung'} bereit (${((performance.now() - started) / 1000).toFixed(1)} s)`)
    } catch (failure) {
      if (controller.signal.aborted) return
      const lines = (failure instanceof Error ? failure.message : String(failure)).split('\n').filter(Boolean)
      const message = (lines.length > 1 ? lines[lines.length - 1] : lines[0] ?? 'Unbekannter Fehler').replace(/\.$/, '')
      setVersions((value) => ({ ...value, [item.id]: { ...spec, itemId: item.id, fraction: 0, started: false, url: keepOld, error: message } }))
      log('abspielen', `${item.name}: ${message}`, 'warn')
    } finally {
      if (jobAbort.current === controller) jobAbort.current = null
      void unloadFfmpeg().catch(() => undefined)
    }
  }

  const stopJob = () => {
    jobAbort.current?.abort()
    jobAbort.current = null
    const id = currentIdRef.current
    if (!id) return
    setVersions((value) => {
      const now = value[id]
      if (!now) return value
      if (now.reason === 'chosen' && !now.url) {
        const { [id]: _gone, ...rest } = value
        return rest
      }
      return { ...value, [id]: { ...now, started: false, fraction: now.url ? 1 : 0 } }
    })
  }

  /**
   * Asks FFmpeg what is in a file, once. A second caller while it runs waits
   * for the same answer — a quality chosen during the look is not lost.
   */
  const probes = useRef(new Map<string, Promise<DiskFacts>>())
  const probe = (item: PlayerItem): Promise<DiskFacts> => {
    const running = probes.current.get(item.id)
    if (running) return running
    setFacts((value) => ({ ...value, [item.id]: 'pending' }))
    const asked = probeDisk(item.source, diskName(item.name)).then((found) => {
      setFacts((value) => ({ ...value, [item.id]: found }))
      return found
    })
    probes.current.set(item.id, asked)
    return asked
  }

  /** When the browser cannot play a file, or plays it without sound. */
  const look = async (item: PlayerItem, browserFailed: boolean) => {
    const found = await probe(item)
    if (!found) return
    if (browserFailed) {
      if (found.durationSeconds) setDuration((value) => value || found.durationSeconds || 0)
      if (found.width && found.height) setSize({ width: found.width, height: found.height })
    }
    const remedy = remedyFor(found, browserFailed)
    if (!remedy || currentIdRef.current !== item.id || versionsRef.current[item.id]) return
    const spec: Spec = { reason: 'needed', remedy, height: null, audioIndex: 0 }
    // Encoding a whole film again is long: that one waits to be asked.
    if (remedy === 'picture') {
      setVersions((value) => ({ ...value, [item.id]: { ...spec, itemId: item.id, fraction: 0, started: false, url: null, error: null } }))
      return
    }
    void make(item, found, spec)
  }

  /* -- the source ------------------------------------------------------------------- */

  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!current) return setOriginalUrl(null)
    const url = URL.createObjectURL(current.source)
    setOriginalUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [current?.id, current?.source])
  const sourceUrl = version?.url ?? originalUrl

  // A new item starts clean.
  useEffect(() => {
    jobAbort.current?.abort()
    setTime(0)
    setDuration(0)
    setBuffered(0)
    setSize(null)
    setFailed(false)
    setResume(null)
    setMenuOpen(false)
    lastSaved.current = 0
    wasPlaying.current = true
  }, [currentId])

  // Leaving the tool lets go of everything it made.
  useEffect(
    () => () => {
      jobAbort.current?.abort()
      itemsRef.current.forEach((item) => item.subtitles.forEach((track) => URL.revokeObjectURL(track.url)))
      Object.values(versionsRef.current).forEach((entry) => entry.url && URL.revokeObjectURL(entry.url))
    },
    [],
  )

  /* -- settings on the element ------------------------------------------------------ */

  useEffect(() => {
    const node = videoRef.current
    if (!node) return
    node.volume = settings.volume
    node.muted = settings.muted
    node.playbackRate = settings.rate
  }, [settings.volume, settings.muted, settings.rate, sourceUrl])

  useEffect(() => {
    const node = videoRef.current
    if (!node) return
    Array.from(node.textTracks).forEach((track, at) => {
      track.mode = at === captions ? 'showing' : 'disabled'
    })
  }, [captions, sourceUrl, current?.subtitles.length])

  // Louder than 100 % and the night mode need the sound routed through Web
  // Audio — once per element, and only when asked for.
  const graph = useRef<{ node: HTMLVideoElement; source: MediaElementAudioSourceNode; squeeze: DynamicsCompressorNode; gain: GainNode } | null>(null)
  useEffect(() => {
    const node = videoRef.current
    if (!node) return
    const wanted = settings.boost > 1 || settings.night
    if (!wanted && graph.current?.node !== node) return
    try {
      if (graph.current?.node !== node) {
        const context = getAudioContext()
        const source = context.createMediaElementSource(node)
        const squeeze = context.createDynamicsCompressor()
        squeeze.threshold.value = -32
        squeeze.knee.value = 18
        squeeze.ratio.value = 5
        squeeze.attack.value = 0.01
        squeeze.release.value = 0.35
        const gain = context.createGain()
        squeeze.connect(gain).connect(context.destination)
        graph.current = { node, source, squeeze, gain }
        void resumeAudioContext()
      }
      const { source, squeeze, gain } = graph.current!
      source.disconnect()
      source.connect(settings.night ? squeeze : gain)
      // Night mode brings the quiet up after squeezing the loud down.
      gain.gain.value = settings.boost * (settings.night ? 1.6 : 1)
    } catch {
      /* the browser declined; the element's own volume still works */
    }
  }, [settings.boost, settings.night, sourceUrl])

  // A playing film keeps the screen awake.
  useEffect(() => {
    if (!playing || current?.kind !== 'video') return
    let release: (() => void) | null = null
    let gone = false
    void holdScreenAwake().then((free) => (gone ? free() : (release = free)))
    return () => {
      gone = true
      release?.()
    }
  }, [playing, current?.kind])

  /* -- playback ----------------------------------------------------------------------- */

  const video = () => videoRef.current
  const pulse = (icon: 'play' | 'pause' | 'back' | 'forward') => setFlash({ key: Date.now(), icon })
  const toggle = () => {
    const node = video()
    if (!node || !sourceUrl) return
    if (node.paused) {
      void node.play().catch(() => undefined)
      pulse('play')
    } else {
      node.pause()
      pulse('pause')
    }
  }
  const seek = (seconds: number) => {
    const node = video()
    if (!node) return
    node.currentTime = Math.min(Math.max(0, seconds), duration || node.duration || 0)
    setTime(node.currentTime)
  }
  const skip = (delta: number) => {
    seek((video()?.currentTime ?? 0) + delta)
    pulse(delta < 0 ? 'back' : 'forward')
  }
  const index = items.findIndex((item) => item.id === currentId)
  const goTo = (offset: number) => {
    const next = items[index + offset]
    if (next) setCurrentId(next.id)
  }
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    else void frameRef.current?.requestFullscreen?.().catch(() => undefined)
  }
  const canPip = typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled
  const togglePip = () => {
    const node = video()
    if (!node) return
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined)
    else void node.requestPictureInPicture?.().catch(() => undefined)
  }

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === frameRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // Filling the window: the page underneath stops scrolling, Escape leaves.
  useEffect(() => {
    if (!fill) return
    const root = document.documentElement
    const before = root.style.overflow
    root.style.overflow = 'hidden'
    root.classList.add('player-fill')
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.fullscreenElement) setFill(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      root.style.overflow = before
      root.classList.remove('player-fill')
      window.removeEventListener('keydown', onKey)
    }
  }, [fill])

  // The controls step aside while the film plays and nobody moves.
  const idleTimer = useRef<number | null>(null)
  const wake = () => {
    setIdle(false)
    if (idleTimer.current) window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => setIdle(true), 2600)
  }
  useEffect(() => () => {
    if (idleTimer.current) window.clearTimeout(idleTimer.current)
  }, [])
  const isVideo = current?.kind === 'video'
  const controlsShown = !isVideo || !playing || !idle || menuOpen
  const immersive = fullscreen || fill


  /* -- keys ------------------------------------------------------------------------------ */

  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined)
  keys.current = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || !current || menuOpen) return
    const target = event.target as HTMLElement | null
    if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return
    if (target?.getAttribute('role') === 'tab' || target?.getAttribute('role') === 'slider') return
    const inFrame = Boolean(frameRef.current?.contains(target)) || immersive
    const key = event.key
    let handled = true
    if (key === ' ' || key === 'k' || key === 'K') {
      if (key === ' ' && target?.tagName === 'BUTTON') return
      toggle()
    } else if (key === 'ArrowLeft') skip(-settings.skip)
    else if (key === 'ArrowRight') skip(settings.skip)
    else if (key === 'j' || key === 'J') skip(-10)
    else if (key === 'l' || key === 'L') skip(10)
    else if ((key === 'ArrowUp' || key === 'ArrowDown') && inFrame) {
      updateSettings({ volume: Math.min(1, Math.max(0, settings.volume + (key === 'ArrowUp' ? 0.05 : -0.05))), muted: false })
    } else if (key === 'm' || key === 'M') updateSettings({ muted: !settings.muted })
    else if (key === 'f' || key === 'F') toggleFullscreen()
    else if ((key === 'w' || key === 'W') && isVideo) setFill((value) => !value)
    else if ((key === 't' || key === 'T') && isVideo) setTheater((value) => !value)
    else if ((key === 'c' || key === 'C') && current.subtitles.length > 0) setCaptions((value) => (value >= 0 ? -1 : 0))
    else if (key === 'n' || key === 'N') goTo(1)
    else if (key === 'p' || key === 'P') goTo(-1)
    else if ((key === ',' || key === '.') && video()?.paused) seek((video()?.currentTime ?? 0) + (key === ',' ? -1 / 30 : 1 / 30))
    else if (key === '<' || key === '>') {
      const at = RATES.indexOf(settings.rate)
      updateSettings({ rate: RATES[Math.min(RATES.length - 1, Math.max(0, at + (key === '>' ? 1 : -1)))] })
    } else if (/^[0-9]$/.test(key) && duration > 0) seek((Number(key) / 10) * duration)
    else handled = false
    if (handled) {
      event.preventDefault()
      wake()
    }
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keys.current(event)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* -- the settings menu's view of things ----------------------------------------------------- */

  const info = current ? facts[current.id] : undefined
  const known = info && info !== 'pending' ? info : null
  const sourceHeight = known?.height ?? size?.height ?? null
  const qualityState: QualityState = {
    current: version?.reason === 'chosen' && version.height && (version.url || version.started) ? version.height : 'original',
    sourceHeight,
    options: sourceHeight ? QUALITY_STEPS.filter((height) => height < sourceHeight - 40) : [],
    making:
      version?.reason === 'chosen' && version.started && version.fraction < 1 && version.height ? { height: version.height, fraction: version.fraction } : null,
    note: !sourceHeight
      ? info === 'pending'
        ? 'Die Auflösung wird gelesen …'
        : null
      : sourceHeight <= 400
        ? 'Dieser Film ist schon klein; eine kleinere Fassung brächte nichts.'
        : null,
  }
  const audioTracks = known ? known.streams.filter((stream) => stream.type === 'audio') : []
  const trackState: TrackState = {
    status: known ? 'ready' : info === 'pending' ? 'pending' : 'unknown',
    tracks: audioTracks.map(trackLabel),
    current: version?.audioIndex ?? 0,
    making: Boolean(version?.started && version.fraction < 1),
  }

  const keepPlace = () => {
    const node = video()
    if (!node) return
    setResume(node.currentTime)
    wasPlaying.current = !node.paused
  }

  const chooseQuality = async (quality: Quality) => {
    if (!current) return
    const found = await probe(current)
    if (!found) return
    const audioIndex = version?.audioIndex ?? 0
    if (quality === 'original') {
      if (audioIndex === 0 || audioTracks.length < 2) {
        jobAbort.current?.abort()
        if (versionsRef.current[current.id]?.reason === 'chosen') {
          keepPlace()
          dropVersion(current.id)
        }
        return
      }
      const codec = audioTracks[audioIndex]?.codec ?? ''
      return make(current, found, { reason: 'chosen', remedy: browserPlaysAudio(codec) && !failed ? 'repack' : 'sound', height: null, audioIndex })
    }
    return make(current, found, { reason: 'chosen', remedy: 'picture', height: quality, audioIndex })
  }

  const chooseAudio = async (audioIndex: number) => {
    if (!current) return
    const found = await probe(current)
    if (!found) return
    const height = version?.reason === 'chosen' ? version.height : null
    if (height) return make(current, found, { reason: 'chosen', remedy: 'picture', height, audioIndex })
    if (audioIndex === 0) {
      if (versionsRef.current[current.id]?.reason === 'chosen') {
        keepPlace()
        dropVersion(current.id)
      }
      return
    }
    const codec = audioTracks[audioIndex]?.codec ?? ''
    return make(current, found, { reason: 'chosen', remedy: browserPlaysAudio(codec) ? 'repack' : 'sound', height: null, audioIndex })
  }

  /* -- what the session holds that is not on the list yet ------------------------------------ */

  const fromSession = useMemo(
    () => sessionAssets.filter((asset) => (asset.kind === 'video' || asset.kind === 'audio') && !items.some((item) => item.assetId === asset.id)),
    [sessionAssets, items],
  )

  const openInEditor = async () => {
    if (!current) return
    if (current.assetId) setActiveAsset(current.assetId)
    else if (current.source instanceof File) await ingest([current.source], 'aus dem Player übernommen')
    setPanel(current.kind === 'audio' ? 'audio' : 'video')
  }

  /* -- render ---------------------------------------------------------------------------------- */

  const fileInputs = (
    <>
      <input
        ref={pickRef}
        type="file"
        multiple
        accept={PLAYER_ACCEPT}
        className="sr-only"
        onChange={(event) => {
          if (event.target.files?.length) void addFiles(Array.from(event.target.files), true)
          event.target.value = ''
        }}
      />
      <input
        ref={subtitlePickRef}
        type="file"
        multiple
        accept=".srt,.vtt"
        className="sr-only"
        onChange={(event) => {
          if (event.target.files?.length) void addFiles(Array.from(event.target.files), false)
          event.target.value = ''
        }}
      />
    </>
  )

  const sessionRow =
    fromSession.length > 0 ? (
      <div className="flex flex-col gap-[8px]">
        <p className="text-small text-prose">Aus der Sitzung</p>
        <div className="flex flex-wrap gap-[8px]">
          {fromSession.map((asset) => (
            <button
              key={asset.id}
              type="button"
              onClick={() => addAsset(asset)}
              className="press flex max-w-full items-center gap-[8px] rounded-pill bg-panel-soft px-[14px] py-[8px] text-small text-ink hover:bg-panel-mid"
            >
              <span className="truncate">{asset.name}</span>
              <span className="value shrink-0 text-muted">{formatBytes(asset.sizeBytes)}</span>
            </button>
          ))}
        </div>
      </div>
    ) : null

  if (!current) {
    return (
      <div className="flex flex-col gap-[24px]">
        {fileInputs}
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={() => setDragging(false)}
          className={`relative flex min-h-[clamp(320px,52vh,560px)] flex-col items-center justify-center gap-[20px] overflow-hidden rounded-card bg-stage px-[24px] py-[48px] text-center text-stage-ink transition-shadow duration-[var(--dur-fast)] ${
            dragging ? 'ring-2 ring-inset ring-stage-accent' : ''
          }`}
        >
          {/* A soft light behind the call to action — the one colour on the
              stage, as elsewhere on it. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-60"
            style={{ background: 'radial-gradient(60% 70% at 50% 100%, color-mix(in srgb, var(--color-stage-accent) 22%, transparent), transparent 70%)' }}
          />
          <span className="relative grid h-[72px] w-[72px] place-items-center rounded-pill bg-white/10 text-white">
            <PlayIcon size={30} />
          </span>
          <div className="relative flex max-w-[36em] flex-col gap-[10px]">
            <h2 className="text-heading-sm font-bold tracking-[-0.015em] text-white">Video oder Musik hierher ziehen</h2>
            <p className="text-body text-stage-muted">
              Auch grosse Filme: direkt von der Festplatte abgespielt, nicht hochgeladen. Mehrere auf einmal werden eine
              Wiedergabeliste, eine .srt daneben der Untertitel.
            </p>
          </div>
          <button
            type="button"
            onClick={() => pickRef.current?.click()}
            className="press relative inline-flex items-center gap-[8px] rounded-pill bg-white px-[22px] py-[12px] text-body font-semibold text-stage hover:bg-stage-accent"
          >
            Dateien öffnen
            <ArrowRight />
          </button>
          <p className="relative text-small text-stage-muted">MP4 · MKV · AVI · MOV · WebM · MP3 · FLAC · WAV und mehr</p>
        </div>
        {sessionRow}
      </div>
    )
  }

  const waiting = version && version.reason === 'needed' && !version.url
  const making = version?.started && version.fraction < 1
  const captionLabels = current.subtitles.map((track) => track.label)
  const pictureFilter = `brightness(${settings.brightness}) contrast(${settings.contrast}) saturate(${settings.saturation})`
  const title = current.name.replace(/\.[^.]+$/, '')
  const meta = [
    formatBytes(current.size),
    size ? `${size.width} × ${size.height}` : null,
    duration > 0 ? clock(duration) : null,
    known ? [codecName(known.videoCodec), codecName(known.audioCodec)].filter((value) => value !== 'unbekannt').join(' / ') || null : null,
    version?.url ? (version.height ? `${version.height}p` : 'umgewandelt') : null,
  ].filter(Boolean)
  const sideBySide = !theater

  const playlist = (
    <section className="flex min-w-0 flex-col gap-[8px]">
      <div className="flex items-baseline justify-between gap-[12px]">
        <h3 className="text-small font-semibold text-ink">Als Nächstes</h3>
        <span className="value text-small text-muted">
          {index + 1} / {items.length}
        </span>
      </div>
      <ol className="flex flex-col gap-[4px]">
        {items.map((item, at) => {
          const here = item.id === currentId
          return (
            <li key={item.id} className="group/item flex max-w-none items-center">
              <button
                type="button"
                onClick={() => setCurrentId(item.id)}
                aria-current={here ? 'true' : undefined}
                className={`press flex min-w-0 flex-1 items-center gap-[12px] rounded-nav p-[8px] text-left text-small transition-colors duration-[var(--dur-fast)] ${
                  here ? 'bg-panel-mid' : 'hover:bg-panel-soft'
                }`}
              >
                <span className={`grid h-[36px] w-[36px] shrink-0 place-items-center rounded-nav ${here ? 'bg-ink text-on-ink' : 'bg-panel-soft text-ink'}`}>
                  {here && playing ? (
                    <span className="flex h-[14px] items-center gap-[2px]" aria-hidden>
                      {[0, 1, 2].map((bar) => (
                        <span key={bar} className="eq-bar h-full w-[3px] rounded-pill bg-current" style={{ animationDelay: `${bar * 0.18}s` }} />
                      ))}
                    </span>
                  ) : (
                    <span className="value">{at + 1}</span>
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={`truncate ${here ? 'font-semibold text-ink' : 'text-prose'}`}>{item.name.replace(/\.[^.]+$/, '')}</span>
                  <span className="value truncate text-muted">
                    {formatBytes(item.size)}
                    {item.subtitles.length > 0 ? ' · Untertitel' : ''}
                  </span>
                </span>
              </button>
              <button
                type="button"
                aria-label={`${item.name} aus der Liste nehmen`}
                title="Aus der Liste nehmen"
                onClick={() => remove(item.id)}
                className="press grid h-[32px] w-[32px] shrink-0 place-items-center rounded-pill text-muted opacity-60 hover:bg-panel-soft hover:text-ink hover:opacity-100 focus-visible:opacity-100 group-hover/item:opacity-100"
              >
                <svg viewBox="0 0 16 16" className="h-[14px] w-[14px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </li>
          )
        })}
      </ol>
      <button
        type="button"
        onClick={() => pickRef.current?.click()}
        className="press flex items-center justify-center gap-[8px] rounded-nav p-[10px] text-small text-ink ring-1 ring-inset ring-rule hover:bg-panel-soft"
      >
        + Weitere Dateien
      </button>
    </section>
  )

  return (
    <div className="flex flex-col gap-[16px]">
      {fileInputs}
      <style>{`
        .sondra-player video::cue {
          font-family: var(--font-sans);
          font-size: ${{ klein: '0.85em', mittel: '1.1em', gross: '1.45em' }[settings.captionSize]};
          line-height: 1.35;
          color: #fff;
          background: ${settings.captionBackground ? 'rgb(0 0 0 / 0.72)' : 'transparent'};
          text-shadow: ${settings.captionBackground ? 'none' : '0 1px 3px rgb(0 0 0 / 0.95), 0 0 8px rgb(0 0 0 / 0.8)'};
        }
        /* Subtitles step up while the controls show, so the bar never covers
           a line. Chromium draws them in this box; elsewhere they stay put. */
        .sondra-player video::-webkit-media-text-track-container {
          transition: transform var(--dur-base) var(--ease-out);
        }
        .sondra-player.controls-up video::-webkit-media-text-track-container {
          transform: translateY(-72px);
        }
      `}</style>

      <div className={`grid gap-[20px] ${sideBySide ? 'xl:grid-cols-[minmax(0,1fr)_340px]' : ''}`}>
        <div className="flex min-w-0 flex-col gap-[14px]">
          {/* The frame: the picture owns it, the controls lie over it. Filling
              the window it leaves the column and covers the page. */}
          <div
            ref={frameRef}
            onPointerMove={wake}
            onPointerDown={wake}
            onPointerLeave={() => playing && setIdle(true)}
            className={`sondra-player group/player isolate overflow-hidden bg-black text-white ${controlsShown && isVideo ? 'controls-up' : ''} ${
              fullscreen ? 'relative h-screen' : fill ? 'fixed inset-0 z-[60] h-[100dvh]' : 'relative rounded-card elevate-lift'
            } ${!controlsShown ? 'cursor-none' : ''}`}
          >
            <div
              className={`relative flex items-center justify-center ${
                immersive ? 'h-full' : isVideo ? (theater ? 'aspect-video max-h-[82vh] w-full' : 'aspect-video max-h-[72vh] w-full') : 'h-[300px] sm:h-[340px]'
              }`}
              onClick={(event) => {
                if (event.target !== event.currentTarget && event.target !== videoRef.current) return
                // On a touch screen the first tap shows the controls.
                if ((event.nativeEvent as PointerEvent).pointerType === 'touch' && !controlsShown) return wake()
                toggle()
              }}
              onDoubleClick={(event) => {
                if (event.target === videoRef.current && isVideo) toggleFullscreen()
              }}
            >
              <video
                key={sourceUrl ?? 'leer'}
                ref={videoRef}
                src={sourceUrl ?? undefined}
                preload="auto"
                playsInline
                autoPlay={wasPlaying.current}
                className={isVideo ? 'h-full w-full' : 'hidden'}
                style={{ objectFit: settings.fit, filter: pictureFilter, transform: settings.mirror ? 'scaleX(-1)' : undefined }}
                onLoadedMetadata={(event) => {
                  const node = event.currentTarget
                  node.volume = settings.volume
                  node.muted = settings.muted
                  node.playbackRate = settings.rate
                  const length = Number.isFinite(node.duration) ? node.duration : 0
                  setDuration(length)
                  if (node.videoWidth > 0 && !version?.height) setSize({ width: node.videoWidth, height: node.videoHeight })
                  // Sound without a picture: the container is known, the picture's codec is not.
                  const noPicture = isVideo && node.videoWidth === 0
                  if ((noPicture || length === 0) && !version?.url) {
                    setFailed(true)
                    void look(current, true)
                    return
                  }
                  if (!version && !NATIVE_CONTAINER.test(current.name)) void look(current, false)
                  if (resume !== null) {
                    node.currentTime = resume
                    setResume(null)
                    if (wasPlaying.current) void node.play().catch(() => undefined)
                    return
                  }
                  const place = rememberedPlace(current)
                  if (place && place > 15 && place < length - 15) setResume(place)
                }}
                onError={() => {
                  if (version?.url) {
                    setVersions((value) => ({ ...value, [current.id]: { ...version, url: null, error: 'Auch die umgewandelte Fassung spielt dieser Browser nicht ab' } }))
                    return
                  }
                  setFailed(true)
                  void look(current, true)
                }}
                onPlay={() => {
                  setPlaying(true)
                  wake()
                }}
                onPause={() => {
                  setPlaying(false)
                  rememberPlace(current, video()?.currentTime ?? null)
                }}
                onTimeUpdate={(event) => {
                  const node = event.currentTarget
                  setTime(node.currentTime)
                  if (node.buffered.length) setBuffered(node.buffered.end(node.buffered.length - 1))
                  if (Math.abs(node.currentTime - lastSaved.current) > 5) {
                    lastSaved.current = node.currentTime
                    rememberPlace(current, node.currentTime > 15 ? node.currentTime : null)
                  }
                }}
                onDurationChange={(event) => {
                  const length = event.currentTarget.duration
                  if (Number.isFinite(length) && length > 0) setDuration(length)
                }}
                onEnded={() => {
                  rememberPlace(current, null)
                  setPlaying(false)
                  if (settings.repeat === 'titel') {
                    seek(0)
                    void video()?.play().catch(() => undefined)
                  } else if (settings.autoNext && index < items.length - 1) {
                    goTo(1)
                  } else if (settings.repeat === 'liste' && items.length > 1) {
                    setCurrentId(items[0].id)
                  } else if (settings.repeat === 'liste') {
                    seek(0)
                    void video()?.play().catch(() => undefined)
                  }
                }}
              >
                {current.subtitles.map((track, at) => (
                  <track key={track.url} kind="subtitles" src={track.url} label={track.label} srcLang="de" default={at === captions} />
                ))}
              </video>

              {/* A sound file: the mark's five bars, moving while it plays. */}
              {!isVideo ? (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-[18px] px-[24px] text-center">
                  <div
                    aria-hidden
                    className="absolute inset-0 opacity-70"
                    style={{ background: 'radial-gradient(55% 75% at 50% 45%, color-mix(in srgb, var(--color-stage-accent) 20%, transparent), transparent 70%)' }}
                  />
                  <span className="relative flex h-[64px] items-center gap-[7px]" aria-hidden>
                    {[0.55, 0.9, 1, 0.75, 0.45].map((height, bar) => (
                      <span
                        key={bar}
                        className={`w-[10px] rounded-pill bg-stage-accent ${playing ? 'eq-bar' : ''}`}
                        style={{ height: `${height * 100}%`, animationDelay: `${bar * 0.14}s`, opacity: playing ? 1 : 0.55 }}
                      />
                    ))}
                  </span>
                  <p className="relative max-w-full truncate text-subheading font-semibold text-white">{title}</p>
                </div>
              ) : null}

              {/* What was just pressed, for a moment, in the middle. */}
              {flash ? (
                <span
                  key={flash.key}
                  className="flash-out pointer-events-none absolute grid h-[64px] w-[64px] place-items-center rounded-pill bg-black/50 text-white backdrop-blur-sm"
                  aria-hidden
                  onAnimationEnd={() => setFlash(null)}
                >
                  {flash.icon === 'play' ? <PlayIcon size={26} /> : flash.icon === 'pause' ? <PauseIcon size={26} /> : flash.icon === 'back' ? <BackIcon /> : <ForwardIcon />}
                </span>
              ) : null}

              {/* Paused: one large way back in. */}
              {!playing && !waiting && isVideo && sourceUrl && !failed && duration > 0 && !flash ? (
                <button
                  type="button"
                  aria-label="Abspielen"
                  onClick={toggle}
                  className="press absolute grid h-[76px] w-[76px] place-items-center rounded-pill bg-black/45 text-white ring-1 ring-white/25 backdrop-blur-md transition-transform duration-[var(--dur-fast)] hover:scale-105 hover:bg-black/60"
                >
                  <PlayIcon size={32} />
                </button>
              ) : null}

              {waiting ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-[14px] bg-stage p-[24px] text-center" role="status">
                  {version.error ? (
                    <>
                      <p className="text-body font-semibold">Diese Datei lässt sich hier nicht abspielen</p>
                      <p className="max-w-[46ch] text-small leading-[1.5] text-stage-muted">{version.error}.</p>
                    </>
                  ) : !version.started ? (
                    <>
                      <p className="text-body font-semibold">Dieser Browser kann das Bild nicht anzeigen</p>
                      <p className="max-w-[46ch] text-small leading-[1.5] text-stage-muted">{known ? STAND_TEXT.picture.why(known) : ''}</p>
                      <button
                        type="button"
                        onClick={() => known && void make(current, known, { reason: 'needed', remedy: 'picture', height: null, audioIndex: 0 })}
                        className="press rounded-pill bg-white px-[20px] py-[10px] text-small font-semibold text-stage hover:bg-stage-accent"
                      >
                        Umwandeln und abspielen
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="text-body font-semibold">
                        {STAND_TEXT[version.remedy].doing}
                        <span className="value ml-[10px] text-stage-muted">{Math.round(version.fraction * 100)} %</span>
                      </p>
                      <div className="h-[4px] w-full max-w-[300px] overflow-hidden rounded-pill bg-white/15" aria-hidden>
                        <div className="h-full rounded-pill bg-stage-accent transition-[width] duration-[var(--dur-fast)]" style={{ width: `${version.fraction * 100}%` }} />
                      </div>
                      {known ? <p className="max-w-[46ch] text-small leading-[1.5] text-stage-muted">{STAND_TEXT[version.remedy].why(known)}</p> : null}
                      <button type="button" onClick={stopJob} className="press rounded-pill px-[16px] py-[8px] text-small ring-1 ring-inset ring-white/30 hover:bg-white/10">
                        Abbrechen
                      </button>
                    </>
                  )}
                </div>
              ) : failed && !version ? (
                <p className="absolute inset-0 grid place-items-center bg-stage p-[24px] text-center text-small text-stage-muted" role="status">
                  {info === 'pending' ? 'Datei wird geprüft …' : 'Diese Datei spielt der Browser nicht ab.'}
                </p>
              ) : null}
            </div>

            {/* Top: the title when the player covers the page or the screen. */}
            {immersive ? (
              <div
                className={`pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-[16px] bg-gradient-to-b from-black/70 to-transparent px-[24px] pb-[40px] pt-[18px] transition-opacity duration-[var(--dur-base)] ${
                  controlsShown ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <p className="truncate text-subheading font-semibold">{title}</p>
                {fill && !fullscreen ? (
                  <button
                    type="button"
                    onClick={() => setFill(false)}
                    className="press pointer-events-auto shrink-0 rounded-pill bg-black/45 px-[14px] py-[6px] text-small ring-1 ring-white/20 backdrop-blur-md hover:bg-black/65"
                  >
                    Zurück zur Seite <span className="value text-white/60">Esc</span>
                  </button>
                ) : null}
              </div>
            ) : null}

            {resume !== null && !waiting ? (
              <div className={`pop absolute left-[14px] z-10 flex items-center gap-[2px] rounded-pill bg-black/65 p-[4px] text-small text-white ring-1 ring-white/15 backdrop-blur-md ${immersive ? 'top-[64px]' : 'top-[14px]'}`}>
                <button
                  type="button"
                  onClick={() => {
                    seek(resume)
                    setResume(null)
                    void video()?.play().catch(() => undefined)
                  }}
                  className="press rounded-pill px-[12px] py-[6px] hover:bg-white/15"
                >
                  Weiter bei <span className="value">{clock(resume)}</span>
                </button>
                <button type="button" onClick={() => setResume(null)} className="press rounded-pill px-[10px] py-[6px] text-white/75 hover:bg-white/15 hover:text-white">
                  Von vorn
                </button>
              </div>
            ) : null}

            {version?.reason === 'chosen' && version.error && !version.started ? (
              <div
                className={`pop absolute right-[14px] z-10 flex max-w-[calc(100%-28px)] items-center gap-[10px] rounded-pill bg-black/75 py-[6px] pl-[14px] pr-[6px] text-small text-white ring-1 ring-white/15 backdrop-blur-md ${immersive ? 'top-[64px]' : 'top-[14px]'}`}
                role="alert"
              >
                <span className="truncate">
                  {version.height ? `${version.height}p` : 'Tonspur'} nicht möglich: {version.error}
                </span>
                <button type="button" onClick={() => dropVersion(current.id)} className="press shrink-0 rounded-pill px-[10px] py-[2px] text-white/75 hover:bg-white/15 hover:text-white">
                  Schliessen
                </button>
              </div>
            ) : null}

            {making && version?.reason === 'chosen' ? (
              <div
                className={`pop absolute right-[14px] z-10 flex items-center gap-[10px] rounded-pill bg-black/65 py-[6px] pl-[14px] pr-[6px] text-small text-white ring-1 ring-white/15 backdrop-blur-md ${immersive ? 'top-[64px]' : 'top-[14px]'}`}
                role="status"
              >
                <span>
                  {version.height ? `${version.height}p wird erstellt` : 'Tonspur wird umgestellt'} <span className="value text-white/70">{Math.round(version.fraction * 100)} %</span>
                </span>
                <button type="button" onClick={stopJob} className="press rounded-pill px-[10px] py-[2px] text-white/75 hover:bg-white/15 hover:text-white">
                  Abbrechen
                </button>
              </div>
            ) : null}

            {/* The controls, over a scrim that keeps them legible on any picture. */}
            <div
              className={`absolute inset-x-0 bottom-0 z-20 flex flex-col gap-[2px] px-[10px] pb-[6px] pt-[56px] transition-opacity duration-[var(--dur-base)] sm:px-[16px] sm:pb-[10px] ${
                controlsShown ? 'opacity-100' : 'pointer-events-none opacity-0'
              }`}
              style={{ background: 'linear-gradient(to top, rgb(0 0 0 / 0.78), rgb(0 0 0 / 0.38) 55%, transparent)' }}
            >
              <SeekBar time={time} duration={duration} buffered={buffered} onSeek={seek} />
              <div className="flex items-center gap-[2px]">
                <Control label="Vorheriges (P)" onClick={() => goTo(-1)} disabled={index <= 0} wideOnly>
                  <PrevIcon />
                </Control>
                <Control label={playing ? 'Pause (Leertaste)' : 'Abspielen (Leertaste)'} onClick={toggle}>
                  {playing ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
                </Control>
                <Control label="Nächstes (N)" onClick={() => goTo(1)} disabled={index >= items.length - 1} wideOnly>
                  <NextIcon />
                </Control>
                <Control label={`${settings.skip} Sekunden zurück (←)`} onClick={() => skip(-settings.skip)} wideOnly>
                  <BackIcon />
                </Control>
                <Control label={`${settings.skip} Sekunden vor (→)`} onClick={() => skip(settings.skip)} wideOnly>
                  <ForwardIcon />
                </Control>

                {/* Volume: the slider opens beside the speaker on hover. */}
                <div className="group/vol flex items-center">
                  <Control label={settings.muted ? 'Ton an (M)' : 'Stumm (M)'} onClick={() => updateSettings({ muted: !settings.muted })}>
                    <VolumeIcon level={settings.muted ? 0 : settings.volume} />
                  </Control>
                  <span className="hidden w-0 overflow-hidden transition-[width] duration-[var(--dur-base)] ease-[var(--ease-settle)] focus-within:w-[92px] group-hover/vol:w-[92px] sm:block">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.muted ? 0 : settings.volume}
                      aria-label="Lautstärke"
                      onChange={(event) => updateSettings({ volume: Number(event.target.value), muted: false })}
                      style={{ '--color-ink': '#ffffff', width: 80, marginLeft: 6 } as CSSProperties}
                    />
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setRemaining((value) => !value)}
                  title="Zwischen Laufzeit und Restzeit wechseln"
                  className="press value ml-[4px] min-w-0 truncate rounded-pill px-[8px] py-[6px] text-small text-white hover:bg-white/10"
                >
                  {remaining ? `−${clock(Math.max(0, duration - time))}` : clock(time)}
                  <span className="text-white/60"> / {clock(duration)}</span>
                </button>

                <span className="flex-1" />

                {settings.rate !== 1 ? (
                  <span className="value mr-[4px] hidden rounded-pill bg-white/15 px-[8px] py-[2px] text-micro sm:inline">{rateLabel(settings.rate)}</span>
                ) : null}
                {isVideo ? (
                  <Control
                    label={current.subtitles.length ? (captions >= 0 ? 'Untertitel aus (C)' : 'Untertitel an (C)') : 'Untertitel laden'}
                    active={captions >= 0 && current.subtitles.length > 0}
                    onClick={() => (current.subtitles.length ? setCaptions((value) => (value >= 0 ? -1 : 0)) : subtitlePickRef.current?.click())}
                  >
                    <CaptionIcon />
                  </Control>
                ) : null}
                <Control label="Einstellungen" active={menuOpen} toggle="ja" onClick={() => setMenuOpen((value) => !value)}>
                  <span className={`grid place-items-center transition-transform duration-[var(--dur-base)] ${menuOpen ? 'rotate-45' : ''}`}>
                    <GearIcon />
                  </span>
                </Control>
                {isVideo && canPip ? (
                  <Control label="Bild im Bild" onClick={togglePip} wideOnly>
                    <PipIcon />
                  </Control>
                ) : null}
                {isVideo && !immersive ? (
                  <Control label={theater ? 'Normale Ansicht (T)' : 'Kinomodus (T)'} active={theater} onClick={() => setTheater((value) => !value)} wideOnly>
                    <TheaterIcon />
                  </Control>
                ) : null}
                {isVideo && !fullscreen ? (
                  <Control label={fill ? 'Fensterfüllend beenden (W, Esc)' : 'Fensterfüllend (W)'} active={fill} onClick={() => setFill((value) => !value)} wideOnly>
                    <WindowIcon on={fill} />
                  </Control>
                ) : null}
                {isVideo ? (
                  <Control label={fullscreen ? 'Vollbild beenden (F)' : 'Vollbild (F)'} onClick={toggleFullscreen}>
                    <FullIcon on={fullscreen} />
                  </Control>
                ) : null}
              </div>
            </div>

            {menuOpen ? (
              <SettingsMenu
                kind={current.kind}
                settings={settings}
                update={updateSettings}
                quality={qualityState}
                onQuality={(quality) => void chooseQuality(quality)}
                onProbe={() => void probe(current)}
                captions={{ tracks: captionLabels, current: captions }}
                onCaption={setCaptions}
                onLoadCaptions={() => subtitlePickRef.current?.click()}
                audio={trackState}
                onAudio={(at) => void chooseAudio(at)}
                onClose={() => setMenuOpen(false)}
              />
            ) : null}
          </div>

          {/* Under the picture: what it is, and where else it can go. */}
          <div className="flex flex-wrap items-start justify-between gap-[12px]">
            <div className="flex min-w-0 flex-col gap-[4px]">
              <h2 className="truncate text-subheading font-semibold text-ink" title={current.name}>
                {title}
              </h2>
              <p className="value text-small text-muted">{meta.join(' · ')}</p>
            </div>
            <div className="flex flex-wrap gap-[8px]">
              <Button size="sm" variant="quiet" onClick={() => pickRef.current?.click()}>
                Dateien öffnen
              </Button>
              <Button size="sm" variant="quiet" onClick={() => void openInEditor()}>
                Bearbeiten
              </Button>
            </div>
          </div>
          {current.size > 1.5e9 ? (
            <p className="text-small text-muted">
              „Bearbeiten“ nimmt die Datei in die Sitzung und damit in den Speicher — bei{' '}
              <span className="value">{formatBytes(current.size)}</span> kann das den Tab überfordern. Abspielen liest sie von der
              Festplatte.
            </p>
          ) : null}
        </div>

        {sideBySide ? <aside className="min-w-0">{playlist}</aside> : null}
      </div>

      {!sideBySide ? playlist : null}
      {sessionRow}
    </div>
  )
}
