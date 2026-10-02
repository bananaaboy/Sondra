/**
 * „Abspielen“ — a player for watching and listening, and for nothing else.
 *
 * The editors show a picture so it can be cut. This one shows it so it can be
 * watched: the picture as large as the column allows, a control bar that
 * gets out of the way in full screen, a list of what comes next, subtitles
 * from a file next to the film, and the place a film was left, offered again
 * the next time it is opened.
 *
 * Files are played where they lie (lib/player.ts): a picked or dropped file is
 * never read into memory or taken into the session, so a 4 GB film opens as
 * fast as a song. What the browser cannot decode gets a stand-in from FFmpeg,
 * read through WORKERFS — repacked when only the container is foreign, the
 * sound converted when only the sound is, encoded again at up to 720p when
 * the picture itself is.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

import { useIngestFiles } from '../../hooks/useIngest'
import { diskPath, probeDisk, runFfmpegOnDisk, unloadFfmpeg, type DiskFacts } from '../../lib/ffmpegClient'
import { formatBytes } from '../../lib/format'
import { NATIVE_CONTAINER, codecName, diskName, remedyFor, standJob, type Remedy } from '../../lib/playable'
import {
  PLAYER_ACCEPT,
  RATES,
  claimDrops,
  clock,
  isSubtitleFile,
  playerKind,
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
import { Mark } from '../AppShell'
import { ArrowRight, Button, Notice } from '../ui/primitives'

/* -------------------------------------------------------------------------- */
/* Icons — the project's own stroke set, 20 px                                 */
/* -------------------------------------------------------------------------- */

function Glyph({ children, filled = false }: { children: ReactNode; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-[18px] w-[18px]"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

const PlayIcon = () => (
  <Glyph filled>
    <path d="M6.5 4.3l9 5.7-9 5.7z" />
  </Glyph>
)
const PauseIcon = () => (
  <Glyph filled>
    <rect x="5.5" y="4" width="3.2" height="12" rx="1" />
    <rect x="11.3" y="4" width="3.2" height="12" rx="1" />
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
  <Glyph>
    <path d="M5 4.5v11M15.5 4.8L8 10l7.5 5.2z" />
  </Glyph>
)
const NextIcon = () => (
  <Glyph>
    <path d="M15 4.5v11M4.5 4.8L12 10l-7.5 5.2z" />
  </Glyph>
)
const VolumeIcon = ({ muted }: { muted: boolean }) => (
  <Glyph>
    <path d="M3.5 7.5h2.8L10.5 4v12l-4.2-3.5H3.5z" />
    {muted ? <path d="M13.5 7.5l3.5 5M17 7.5l-3.5 5" /> : <path d="M13.5 7.4a3.6 3.6 0 010 5.2M15.6 5.4a6.4 6.4 0 010 9.2" />}
  </Glyph>
)
const CaptionIcon = () => (
  <Glyph>
    <path d="M2.8 4.5h14.4v11H2.8zM5.6 10.4h3M10.6 10.4h3.8M5.6 12.8h5M12 12.8h2.4" />
  </Glyph>
)
const PipIcon = () => (
  <Glyph>
    <path d="M2.8 4.5h14.4v11H2.8zM10.4 10h5v4h-5z" />
  </Glyph>
)
const FullIcon = ({ on }: { on: boolean }) => (
  <Glyph>
    {on ? <path d="M7.5 3.5v4h-4M12.5 3.5v4h4M7.5 16.5v-4h-4M12.5 16.5v-4h4" /> : <path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" />}
  </Glyph>
)

/** A control on the stage: dark ground, light glyph, the stage's own ring on focus. */
function StageButton({
  label,
  onClick,
  active,
  disabled,
  wideOnly = false,
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  /** Left out of the bar on a phone, where the keys and the seek bar do it. */
  wideOnly?: boolean
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
      className={`press ${wideOnly ? 'hidden sm:grid' : 'grid'} h-[36px] w-[36px] shrink-0 place-items-center rounded-nav outline-none transition-colors duration-[var(--dur-fast)] focus-visible:ring-2 focus-visible:ring-stage-ink disabled:opacity-35 ${
        active ? 'bg-stage-ink text-stage' : 'text-stage-ink hover:bg-stage-line'
      }`}
    >
      {children}
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* The seek bar — a time surface, so square                                    */
/* -------------------------------------------------------------------------- */

function SeekBar({
  time,
  duration,
  buffered,
  onSeek,
}: {
  time: number
  duration: number
  buffered: number
  onSeek: (seconds: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ x: number; seconds: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const known = duration > 0 && Number.isFinite(duration)

  const at = (event: ReactPointerEvent) => {
    const box = ref.current?.getBoundingClientRect()
    if (!box || !known) return null
    const x = Math.min(box.width, Math.max(0, event.clientX - box.left))
    return { x, seconds: (x / box.width) * duration }
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
      className="group relative h-[18px] cursor-pointer touch-none outline-none focus-visible:ring-2 focus-visible:ring-stage-ink"
    >
      <div className="absolute inset-x-0 top-1/2 h-[4px] -translate-y-1/2 bg-stage-line/70 transition-[height] duration-[var(--dur-fast)] group-hover:h-[6px]">
        <div className="absolute inset-y-0 left-0 bg-stage-muted/45" style={{ width: known ? `${(buffered / duration) * 100}%` : 0 }} />
        <div className="absolute inset-y-0 left-0 bg-stage-ink" style={{ width: known ? `${(time / duration) * 100}%` : 0 }} />
      </div>
      {known ? (
        <div
          className="absolute top-1/2 h-[14px] w-[3px] -translate-x-1/2 -translate-y-1/2 bg-stage-ink"
          style={{ left: `${(time / duration) * 100}%` }}
          aria-hidden
        />
      ) : null}
      {hover ? (
        <span
          className="value pointer-events-none absolute bottom-[20px] -translate-x-1/2 rounded-nav bg-stage px-[8px] py-[4px] text-micro text-stage-ink ring-1 ring-stage-line"
          style={{ left: hover.x }}
          aria-hidden
        >
          {clock(hover.seconds)}
        </span>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* The panel                                                                   */
/* -------------------------------------------------------------------------- */

interface Stand {
  itemId: string
  remedy: Remedy
  fraction: number
  url: string | null
  error: string | null
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

let nextId = 0
const newId = () => `p${Date.now().toString(36)}${(nextId++).toString(36)}`

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
  const [idle, setIdle] = useState(false)
  const [facts, setFacts] = useState<Record<string, DiskFacts | 'pending'>>({})
  const [stand, setStand] = useState<Stand | null>(null)
  const [dragging, setDragging] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const pickRef = useRef<HTMLInputElement>(null)
  const subtitlePickRef = useRef<HTMLInputElement>(null)
  const standAbort = useRef<AbortController | null>(null)
  const lastSaved = useRef(0)
  const itemsRef = useRef(items)
  itemsRef.current = items

  const updateSettings = (patch: Partial<PlayerSettings>) =>
    setSettings((value) => {
      const next = { ...value, ...patch }
      rememberSettings(next)
      return next
    })

  /* -- adding files ----------------------------------------------------------- */

  const addFiles = useCallback(async (list: File[], play: boolean) => {
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
    // A subtitle file goes with the film of the same name; otherwise with
    // the one that is playing.
    const subtitleFor = async (pool: PlayerItem[], fallback: string | null) => {
      for (const file of subs) {
        const owner = pool.find((item) => stemOf(item.name) === stemOf(file.name).replace(/\.[a-z]{2,3}$/, '')) ?? pool.find((item) => item.id === fallback)
        if (!owner) continue
        owner.subtitles = [...owner.subtitles, { label: file.name.replace(/\.(srt|vtt)$/i, ''), url: await subtitleUrl(file) }]
      }
    }
    const pool = [...itemsRef.current.map((item) => ({ ...item })), ...added]
    await subtitleFor(pool, currentIdRef.current)
    if (media.length === 0 && subs.length === 0 && list.length > 0) {
      log('abspielen', `${list.length === 1 ? list[0].name : `${list.length} Dateien`} übersprungen — kein Video und kein Ton`, 'warn')
    }
    setItems(pool)
    if (subs.length > 0) setCaptions(0)
    if (added.length > 0 && (play || !currentIdRef.current)) setCurrentId(added[0].id)
  }, [log])

  const currentIdRef = useRef(currentId)
  currentIdRef.current = currentId

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

  const remove = (id: string) => {
    setItems((value) => {
      const gone = value.find((item) => item.id === id)
      gone?.subtitles.forEach((track) => URL.revokeObjectURL(track.url))
      const rest = value.filter((item) => item.id !== id)
      if (id === currentIdRef.current) {
        const index = value.findIndex((item) => item.id === id)
        setCurrentId(rest[Math.min(index, rest.length - 1)]?.id ?? null)
      }
      return rest
    })
  }

  /* -- the source ------------------------------------------------------------ */

  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!current) return setSourceUrl(null)
    if (stand?.itemId === current.id && stand.url) return setSourceUrl(stand.url)
    const url = URL.createObjectURL(current.source)
    setSourceUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [current?.id, current?.source, stand?.itemId, stand?.url])

  // A new item starts clean.
  useEffect(() => {
    setTime(0)
    setDuration(0)
    setBuffered(0)
    setSize(null)
    setFailed(false)
    setResume(null)
    lastSaved.current = 0
    if (stand && stand.itemId !== currentId) {
      standAbort.current?.abort()
      if (stand.url) URL.revokeObjectURL(stand.url)
      setStand(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId])

  // Leaving the tool lets go of everything it made.
  useEffect(
    () => () => {
      standAbort.current?.abort()
      itemsRef.current.forEach((item) => item.subtitles.forEach((track) => URL.revokeObjectURL(track.url)))
    },
    [],
  )

  /* -- settings on the element ------------------------------------------------ */

  useEffect(() => {
    const node = videoRef.current
    if (!node) return
    node.volume = settings.volume
    node.muted = settings.muted
    node.playbackRate = settings.rate
  }, [settings, sourceUrl])

  useEffect(() => {
    const node = videoRef.current
    if (!node) return
    Array.from(node.textTracks).forEach((track, index) => {
      track.mode = index === captions ? 'showing' : 'disabled'
    })
  }, [captions, sourceUrl, current?.subtitles.length])

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

  /* -- looking at what the browser cannot play -------------------------------- */

  const look = useCallback(
    async (item: PlayerItem, browserFailed: boolean) => {
      if (facts[item.id]) return
      setFacts((value) => ({ ...value, [item.id]: 'pending' }))
      const found = await probeDisk(item.source, diskName(item.name))
      setFacts((value) => ({ ...value, [item.id]: found }))
      if (found.durationSeconds && browserFailed) setDuration((value) => value || found.durationSeconds || 0)
      if (found.width && found.height && browserFailed) setSize({ width: found.width, height: found.height })
      const remedy = remedyFor(found, browserFailed)
      if (!remedy || currentIdRef.current !== item.id) return
      // Encoding a whole film again is long: that one waits to be asked.
      if (remedy === 'picture') {
        setStand({ itemId: item.id, remedy, fraction: 0, url: null, error: null })
        return
      }
      void makeStand(item, remedy, found)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [facts],
  )

  const makeStand = async (item: PlayerItem, remedy: Remedy, found: DiskFacts) => {
    standAbort.current?.abort()
    const controller = new AbortController()
    standAbort.current = controller
    setStand({ itemId: item.id, remedy, fraction: 0.0001, url: null, error: null })
    const started = performance.now()
    try {
      const name = diskName(item.name)
      const job = standJob(remedy, found, diskPath(name), { maxHeight: 720, crf: 23 })
      const { files } = await runFfmpegOnDisk({
        source: item.source,
        name,
        args: () => job.args,
        output: [job.output],
        signal: controller.signal,
        onProgress: (fraction) => setStand((value) => (value && !value.url ? { ...value, fraction: Math.max(0.0001, fraction) } : value)),
      })
      if (controller.signal.aborted) return
      const url = URL.createObjectURL(new Blob([files[job.output] as BlobPart], { type: job.mime }))
      const place = videoRef.current?.currentTime ?? 0
      setStand((value) => (value ? { ...value, fraction: 1, url } : value))
      setFailed(false)
      if (place > 0) setResume(place)
      log('abspielen', `${item.name}: abspielbar gemacht (${((performance.now() - started) / 1000).toFixed(1)} s)`)
    } catch (failure) {
      if (controller.signal.aborted) return
      const lines = (failure instanceof Error ? failure.message : String(failure)).split('\n').filter(Boolean)
      const message = (lines.length > 1 ? lines[lines.length - 1] : lines[0] ?? 'Unbekannter Fehler').replace(/\.$/, '')
      setStand((value) => (value ? { ...value, error: message } : value))
      log('abspielen', `${item.name}: nicht abspielbar — ${message}`, 'warn')
    } finally {
      if (standAbort.current === controller) standAbort.current = null
      void unloadFfmpeg().catch(() => undefined)
    }
  }

  const stopStand = () => {
    standAbort.current?.abort()
    standAbort.current = null
    setStand((value) => (value ? { ...value, fraction: 0, error: null } : value))
  }

  /* -- playback ----------------------------------------------------------------- */

  const video = () => videoRef.current
  const toggle = () => {
    const node = video()
    if (!node || !sourceUrl) return
    if (node.paused) void node.play().catch(() => undefined)
    else node.pause()
  }
  const seek = (seconds: number) => {
    const node = video()
    if (!node) return
    node.currentTime = Math.min(Math.max(0, seconds), duration || node.duration || 0)
    setTime(node.currentTime)
  }
  const skip = (delta: number) => seek((video()?.currentTime ?? 0) + delta)
  const index = items.findIndex((item) => item.id === currentId)
  const goTo = (offset: number) => {
    const next = items[index + offset]
    if (next) setCurrentId(next.id)
  }
  const fullscreenTarget = () => stageRef.current
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    else void fullscreenTarget()?.requestFullscreen?.().catch(() => undefined)
  }
  const canPip = typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled
  const togglePip = () => {
    const node = video()
    if (!node) return
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined)
    else void node.requestPictureInPicture?.().catch(() => undefined)
  }

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === stageRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // In full screen the bar steps aside while the film plays and nobody moves.
  const idleTimer = useRef<number | null>(null)
  const wake = () => {
    setIdle(false)
    if (idleTimer.current) window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => setIdle(true), 2600)
  }
  useEffect(() => () => {
    if (idleTimer.current) window.clearTimeout(idleTimer.current)
  }, [])
  const barHidden = fullscreen && playing && idle

  /* -- keys ----------------------------------------------------------------------- */

  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined)
  keys.current = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || !current) return
    const target = event.target as HTMLElement | null
    if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return
    if (target?.getAttribute('role') === 'tab' || target?.getAttribute('role') === 'slider') return
    const inStage = Boolean(stageRef.current?.contains(target)) || fullscreen
    const key = event.key
    let handled = true
    if (key === ' ' || key === 'k' || key === 'K') {
      if (key === ' ' && target?.tagName === 'BUTTON') return
      toggle()
    } else if (key === 'ArrowLeft') skip(-5)
    else if (key === 'ArrowRight') skip(5)
    else if (key === 'j' || key === 'J') skip(-10)
    else if (key === 'l' || key === 'L') skip(10)
    else if ((key === 'ArrowUp' || key === 'ArrowDown') && inStage) {
      updateSettings({ volume: Math.min(1, Math.max(0, settings.volume + (key === 'ArrowUp' ? 0.05 : -0.05))), muted: false })
    } else if (key === 'm' || key === 'M') updateSettings({ muted: !settings.muted })
    else if (key === 'f' || key === 'F') toggleFullscreen()
    else if ((key === 'c' || key === 'C') && current.subtitles.length > 0) setCaptions((value) => (value >= 0 ? -1 : 0))
    else if (key === 'n' || key === 'N') goTo(1)
    else if (key === 'p' || key === 'P') goTo(-1)
    else if ((key === ',' || key === '.') && video()?.paused) skip(key === ',' ? -1 / 30 : 1 / 30)
    else if (key === '<' || key === '>') {
      const at = RATES.indexOf(settings.rate)
      updateSettings({ rate: RATES[Math.min(RATES.length - 1, Math.max(0, at + (key === '>' ? 1 : -1)))] })
    } else if (/^[0-9]$/.test(key) && duration > 0) seek((Number(key) / 10) * duration)
    else handled = false
    if (handled) event.preventDefault()
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keys.current(event)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* -- what the session holds that is not on the list yet --------------------------- */

  const fromSession = useMemo(
    () =>
      sessionAssets.filter(
        (asset) => (asset.kind === 'video' || asset.kind === 'audio') && !items.some((item) => item.assetId === asset.id),
      ),
    [sessionAssets, items],
  )

  const openInEditor = async () => {
    if (!current) return
    if (current.assetId) {
      setActiveAsset(current.assetId)
    } else if (current.source instanceof File) {
      await ingest([current.source], 'aus dem Player übernommen')
    }
    setPanel(current.kind === 'audio' ? 'audio' : 'video')
  }

  /* -- render ----------------------------------------------------------------------- */

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

  const sessionRow = fromSession.length > 0 ? (
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
        <h2 className="display-md">Abspielen</h2>
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={() => setDragging(false)}
          className={`flex flex-col items-center gap-[16px] rounded-card px-[24px] py-[48px] text-center transition-colors duration-[var(--dur-fast)] ${
            dragging ? 'bg-panel-mid ring-2 ring-inset ring-ink' : 'field-glow'
          }`}
        >
          <Mark className="h-[40px] w-[40px] text-ink" />
          <div className="flex max-w-[34em] flex-col gap-[8px]">
            <p className="display-sm">Video oder Musik hierher ziehen</p>
            <p className="text-body text-prose">
              Auch grosse Filme: die Datei wird direkt von der Festplatte abgespielt, nicht hochgeladen und nicht in den
              Speicher geladen. Mehrere auf einmal werden eine Wiedergabeliste, eine .srt daneben wird zum Untertitel.
            </p>
          </div>
          <Button onClick={() => pickRef.current?.click()}>
            Dateien öffnen
            <ArrowRight />
          </Button>
        </div>
        {sessionRow}
      </div>
    )
  }

  const info = facts[current.id]
  const known = info && info !== 'pending' ? info : null
  const standHere = stand?.itemId === current.id ? stand : null
  const waitingStand = standHere && !standHere.url
  const subtitleLabel = current.subtitles[captions]?.label
  const factsLine = [
    formatBytes(current.size),
    size ? `${size.width} × ${size.height}` : null,
    duration > 0 ? clock(duration) : null,
    known ? [codecName(known.videoCodec), codecName(known.audioCodec)].filter((value) => value !== 'unbekannt').join(' / ') || null : null,
    standHere?.url ? 'umgewandelt' : null,
  ].filter(Boolean)

  return (
    <div className="flex flex-col gap-[20px]">
      {fileInputs}

      <div className="flex flex-wrap items-end justify-between gap-[12px]">
        <div className="flex min-w-0 flex-col gap-[4px]">
          <h2 className="display-md">Abspielen</h2>
          <p className="value truncate text-small text-ink" title={current.name}>
            {current.name}
          </p>
          <p className="value text-small text-muted">{factsLine.join(' · ')}</p>
        </div>
        <div className="flex flex-wrap gap-[8px]">
          <Button size="sm" variant="quiet" onClick={() => pickRef.current?.click()}>
            Dateien öffnen
          </Button>
          <Button size="sm" variant="quiet" onClick={() => subtitlePickRef.current?.click()}>
            Untertitel laden
          </Button>
          <Button size="sm" variant="quiet" onClick={() => void openInEditor()}>
            Bearbeiten
          </Button>
        </div>
      </div>

      {/* The stage: dark and neutral in both themes, square — a picture is
          judged on it, and in full screen it is the whole screen. */}
      <div
        ref={stageRef}
        onPointerMove={wake}
        onPointerDown={wake}
        className={`relative flex flex-col bg-stage text-stage-ink ${fullscreen ? 'h-screen' : 'elevate-lift'} ${barHidden ? 'cursor-none' : ''}`}
      >
        <div
          className={`relative flex items-center justify-center overflow-hidden ${
            fullscreen
              ? 'min-h-0 flex-1'
              : current.kind === 'video'
                ? 'aspect-video max-h-[70vh] sm:aspect-auto sm:h-[clamp(320px,62vh,780px)]'
                : 'h-[220px] sm:h-[260px]'
          }`}
          onClick={(event) => {
            if (event.target === event.currentTarget || event.target === videoRef.current) toggle()
          }}
          onDoubleClick={(event) => {
            if (event.target === videoRef.current && current.kind === 'video') toggleFullscreen()
          }}
        >
          <video
            key={sourceUrl ?? 'leer'}
            ref={videoRef}
            src={sourceUrl ?? undefined}
            preload="auto"
            playsInline
            autoPlay
            className={current.kind === 'video' ? 'h-full w-full object-contain' : 'hidden'}
            onLoadedMetadata={(event) => {
              const node = event.currentTarget
              node.volume = settings.volume
              node.muted = settings.muted
              node.playbackRate = settings.rate
              const length = Number.isFinite(node.duration) ? node.duration : 0
              setDuration(length)
              if (node.videoWidth > 0) setSize({ width: node.videoWidth, height: node.videoHeight })
              // Sound without a picture: the container is known, the picture's codec is not.
              const noPicture = current.kind === 'video' && node.videoWidth === 0
              if (noPicture || length === 0) {
                setFailed(true)
                void look(current, true)
                return
              }
              if (!NATIVE_CONTAINER.test(current.name)) void look(current, false)
              const place = resume ?? rememberedPlace(current)
              if (resume !== null) {
                node.currentTime = resume
                setResume(null)
              } else if (place && place > 15 && place < length - 15) {
                setResume(place)
              }
            }}
            onError={() => {
              if (standHere?.url) {
                setStand((value) => (value ? { ...value, url: null, error: 'Auch die umgewandelte Fassung spielt dieser Browser nicht ab' } : value))
                return
              }
              setFailed(true)
              void look(current, true)
            }}
            onPlay={() => setPlaying(true)}
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
              if (index < items.length - 1) goTo(1)
            }}
          >
            {current.subtitles.map((track, at) => (
              <track key={track.url} kind="subtitles" src={track.url} label={track.label} srcLang="de" default={at === captions} />
            ))}
          </video>

          {current.kind === 'audio' && !waitingStand ? (
            <div className="pointer-events-none flex max-w-[80%] flex-col items-center gap-[16px] text-center">
              <span className={`grid h-[72px] w-[72px] place-items-center rounded-card bg-stage-soft ${playing ? 'text-stage-ink' : 'text-stage-muted'}`}>
                <Mark className="h-[36px] w-[36px]" />
              </span>
              <p className="max-w-full truncate text-subheading font-semibold">{current.name.replace(/\.[^.]+$/, '')}</p>
            </div>
          ) : null}

          {waitingStand ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-[12px] p-[24px] text-center" role="status">
              {standHere.error ? (
                <>
                  <p className="text-small font-semibold">Diese Datei lässt sich hier nicht abspielen</p>
                  <p className="max-w-[46ch] text-small leading-[1.5] text-stage-muted">{standHere.error}.</p>
                </>
              ) : standHere.fraction === 0 ? (
                <>
                  <p className="text-small font-semibold">Dieser Browser kann das Bild nicht anzeigen</p>
                  <p className="max-w-[46ch] text-small leading-[1.5] text-stage-muted">
                    {known ? STAND_TEXT.picture.why(known) : ''}
                  </p>
                  <button
                    type="button"
                    onClick={() => known && void makeStand(current, 'picture', known)}
                    className="press rounded-nav bg-stage-ink px-[16px] py-[8px] text-small font-semibold text-stage hover:opacity-90"
                  >
                    Umwandeln und abspielen
                  </button>
                </>
              ) : (
                <>
                  <p className="text-small font-semibold">
                    {STAND_TEXT[standHere.remedy].doing}
                    <span className="value ml-[8px] text-stage-muted">{Math.round(standHere.fraction * 100)} %</span>
                  </p>
                  <div className="h-[3px] w-full max-w-[280px] bg-stage-line" aria-hidden>
                    <div className="h-full bg-stage-ink transition-[width] duration-[var(--dur-fast)]" style={{ width: `${standHere.fraction * 100}%` }} />
                  </div>
                  {known ? <p className="max-w-[46ch] text-small leading-[1.5] text-stage-muted">{STAND_TEXT[standHere.remedy].why(known)}</p> : null}
                  <button
                    type="button"
                    onClick={stopStand}
                    className="press rounded-nav px-[12px] py-[6px] text-small ring-1 ring-inset ring-stage-line hover:bg-stage-line"
                  >
                    Abbrechen
                  </button>
                </>
              )}
            </div>
          ) : failed && !standHere ? (
            <p className="absolute inset-0 grid place-items-center p-[24px] text-center text-small text-stage-muted" role="status">
              {info === 'pending' ? 'Datei wird geprüft …' : 'Diese Datei spielt der Browser nicht ab.'}
            </p>
          ) : null}

          {resume !== null && !waitingStand ? (
            <div className="absolute left-[12px] top-[12px] flex items-center gap-[4px] rounded-nav bg-stage/90 p-[4px] text-small ring-1 ring-stage-line">
              <button type="button" onClick={() => (seek(resume), setResume(null), void video()?.play().catch(() => undefined))} className="press rounded-nav px-[10px] py-[4px] hover:bg-stage-line">
                Weiter bei <span className="value">{clock(resume)}</span>
              </button>
              <button type="button" aria-label="Von vorn" title="Von vorn" onClick={() => setResume(null)} className="press grid h-[26px] w-[26px] place-items-center rounded-nav text-stage-muted hover:bg-stage-line">
                ×
              </button>
            </div>
          ) : null}
        </div>

        {/* The bar. */}
        <div
          className={`flex flex-col gap-[6px] bg-stage-soft px-[12px] pb-[8px] pt-[6px] transition-opacity duration-[var(--dur-base)] ${
            fullscreen ? 'absolute inset-x-0 bottom-0' : ''
          } ${barHidden ? 'pointer-events-none opacity-0' : 'opacity-100'}`}
        >
          <SeekBar time={time} duration={duration} buffered={buffered} onSeek={seek} />
          <div className="flex items-center gap-[4px]">
            <StageButton label="Vorheriges (P)" wideOnly onClick={() => goTo(-1)} disabled={index <= 0}>
              <PrevIcon />
            </StageButton>
            <StageButton label="10 Sekunden zurück (J)" wideOnly onClick={() => skip(-10)}>
              <BackIcon />
            </StageButton>
            <StageButton label={playing ? 'Pause (Leertaste)' : 'Abspielen (Leertaste)'} onClick={toggle} active>
              {playing ? <PauseIcon /> : <PlayIcon />}
            </StageButton>
            <StageButton label="10 Sekunden vor (L)" wideOnly onClick={() => skip(10)}>
              <ForwardIcon />
            </StageButton>
            <StageButton label="Nächstes (N)" wideOnly onClick={() => goTo(1)} disabled={index >= items.length - 1}>
              <NextIcon />
            </StageButton>
            <span className="value ml-[4px] min-w-0 truncate whitespace-nowrap text-small text-stage-ink sm:ml-[8px]">
              {clock(time)} <span className="text-stage-muted">/ {clock(duration)}</span>
            </span>

            <span className="flex-1" />

            <StageButton label={settings.muted ? 'Ton an (M)' : 'Stumm (M)'} onClick={() => updateSettings({ muted: !settings.muted })}>
              <VolumeIcon muted={settings.muted || settings.volume === 0} />
            </StageButton>
            <span className="hidden w-[84px] sm:block">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.muted ? 0 : settings.volume}
              aria-label="Lautstärke"
              onChange={(event) => updateSettings({ volume: Number(event.target.value), muted: false })}
              // The app's ruled slider, drawn in the stage's light ink instead
              // of the page's: its track and slug read `--color-ink`.
              style={{ '--color-ink': 'var(--color-stage-ink)' } as CSSProperties}
            />
            </span>
            <label className="relative ml-[4px] hidden sm:block">
              <span className="sr-only">Tempo</span>
              <select
                value={settings.rate}
                onChange={(event) => updateSettings({ rate: Number(event.target.value) })}
                className="value h-[32px] cursor-pointer appearance-none rounded-nav bg-transparent px-[8px] text-small text-stage-ink outline-none ring-1 ring-inset ring-stage-line hover:bg-stage-line focus-visible:ring-2 focus-visible:ring-stage-ink"
              >
                {RATES.map((rate) => (
                  <option key={rate} value={rate} className="bg-stage">
                    {rate}×
                  </option>
                ))}
              </select>
            </label>
            {current.subtitles.length > 0 ? (
              <StageButton
                label={captions >= 0 ? `Untertitel aus (C) — ${subtitleLabel}` : 'Untertitel an (C)'}
                active={captions >= 0}
                onClick={() => setCaptions((value) => (value >= 0 ? (value + 1 < current.subtitles.length ? value + 1 : -1) : 0))}
              >
                <CaptionIcon />
              </StageButton>
            ) : null}
            {current.kind === 'video' && canPip ? (
              <StageButton label="Bild im Bild" onClick={togglePip}>
                <PipIcon />
              </StageButton>
            ) : null}
            {current.kind === 'video' ? (
              <StageButton label={fullscreen ? 'Vollbild beenden (F)' : 'Vollbild (F)'} onClick={toggleFullscreen}>
                <FullIcon on={fullscreen} />
              </StageButton>
            ) : null}
          </div>
        </div>
      </div>

      {/* What comes next. */}
      <section className="flex flex-col">
        <div className="flex items-baseline justify-between gap-[12px] border-t-2 border-rule pb-[8px] pt-[16px]">
          <h3 className="text-small font-semibold text-ink">Wiedergabeliste</h3>
          <span className="value text-small text-muted">
            {index + 1} / {items.length}
          </span>
        </div>
        <ol className="flex flex-col">
          {items.map((item, at) => {
            const here = item.id === currentId
            return (
              <li key={item.id} className="flex max-w-none items-center gap-[8px] border-t border-line">
                <button
                  type="button"
                  onClick={() => setCurrentId(item.id)}
                  aria-current={here ? 'true' : undefined}
                  className={`press flex min-w-0 flex-1 items-center gap-[12px] rounded-nav px-[4px] py-[10px] text-left text-small ${
                    here ? 'font-semibold text-ink' : 'text-prose hover:bg-panel-soft'
                  }`}
                >
                  <span className={`value w-[3ch] shrink-0 text-right ${here ? 'text-ink' : 'text-muted'}`}>
                    {here && playing ? '▸' : at + 1}
                  </span>
                  <span className="truncate">{item.name}</span>
                  {item.subtitles.length > 0 ? <span className="shrink-0 text-muted">· Untertitel</span> : null}
                  <span className="value ml-auto shrink-0 text-muted">{formatBytes(item.size)}</span>
                </button>
                <button
                  type="button"
                  aria-label={`${item.name} aus der Liste nehmen`}
                  title="Aus der Liste nehmen"
                  onClick={() => remove(item.id)}
                  className="press grid h-[32px] w-[32px] shrink-0 place-items-center rounded-nav text-muted hover:bg-panel-soft hover:text-ink"
                >
                  <svg viewBox="0 0 16 16" className="h-[14px] w-[14px]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              </li>
            )
          })}
        </ol>
      </section>

      {sessionRow}

      {current.size > 1.5e9 ? (
        <Notice title="Bearbeiten lädt die ganze Datei">
          Abspielen liest die Datei von der Festplatte. „Bearbeiten“ nimmt sie in die Sitzung und damit in den Speicher —
          bei <span className="value">{formatBytes(current.size)}</span> kann das den Tab überfordern.
        </Notice>
      ) : null}
    </div>
  )
}
