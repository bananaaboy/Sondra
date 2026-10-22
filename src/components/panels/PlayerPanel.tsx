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
import { EqualizerRack, EQUALIZER_PRESETS, type EqualizerPresetName } from '../../lib/audio/equalizer'
import { createKaraokeProcessor, type KaraokeProcessor } from '../../lib/audioKaraoke'
import { diskPath, probeDisk, runFfmpegOnDisk, unloadFfmpeg, type DiskFacts, type StreamInfo } from '../../lib/ffmpegClient'
import { formatBytes } from '../../lib/format'
import { NATIVE_CONTAINER, browserPlaysAudio, codecName, diskName, remedyFor, standJob, type Remedy } from '../../lib/playable'
import {
  PLAYER_ACCEPT,
  QUALITY_STEPS,
  RATES,
  claimDrops,
  isRemote,
  receivePlayerFiles,
  clock,
  isSubtitleFile,
  markName,
  marksFor,
  minutesSeconds,
  neighbourMark,
  nextOffered,
  openingOffered,
  playerKind,
  rateLabel,
  rememberPlace,
  rememberSettings,
  rememberedPlace,
  rememberedSettings,
  saveMarks,
  sleepFade,
  stemOf,
  subtitleUrl,
  withMark,
  type PlayerItem,
  type PlayerMark,
  type RemoteMedia,
  type PlayerSettings,
  type SleepTimer,
} from '../../lib/player'
import { holdScreenAwake } from '../../lib/wakeLock'
import { connectDrive, DRIVE_PROBLEM, DriveError, driveMediaUrl, driveReadable, readDriveFile } from '../../lib/googleDrive'
import { useSession, type Asset } from '../../state/store'
import { APP_BRIDGE, updateDiscordPresence } from '../../lib/desktop'
import { matchEpisode } from '../../lib/episodeMatch'
import { INTROS_KEPT, OPENING_MAX, OPENING_MIN, merkItems, updateMerkItem, useMerkliste } from '../../lib/merkliste'
import { decodeHead, findIntro, keepIntro, keptIntro, learnIntro, printTag, type FoundIntro } from '../../lib/introDetect'
import { EqualizerDrawer } from '../player/EqualizerDrawer'
import { SettingsMenu, type Quality, type QualityState, type TrackState } from '../player/SettingsMenu'
import { MerklisteTick } from '../player/MerklisteTick'
import { ArrowRight, Button, Dialog, Select } from '../ui/primitives'

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
    <path d="M11 5.5L6.5 10l4.5 4.5M16 5.5L11.5 10l4.5 4.5" />
  </Glyph>
)
const ForwardIcon = () => (
  <Glyph>
    <path d="M4 5.5L8.5 10 4 14.5M9 5.5L13.5 10 9 14.5" />
  </Glyph>
)
/** Skip marks: a bar and a triangle, the corners rounded by their own stroke. */
const PrevIcon = () => (
  <Glyph>
    <path d="M5.2 4.8v10.4" />
    <path d="M15.2 5.6v8.8L8.6 10z" fill="currentColor" />
  </Glyph>
)
const NextIcon = () => (
  <Glyph>
    <path d="M14.8 4.8v10.4" />
    <path d="M4.8 5.6v8.8l6.6-4.4z" fill="currentColor" />
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
    <path d="M8.8 8.2H7.2a1.8 1.8 0 00-1.8 1.8v0a1.8 1.8 0 001.8 1.8h1.6M14.6 8.2h-1.6a1.8 1.8 0 00-1.8 1.8v0a1.8 1.8 0 001.8 1.8h1.6" />
  </Glyph>
)
/** Six teeth, drawn around the centre — the old outline sat off it. */
const GearIcon = () => (
  <Glyph>
    <circle cx="10" cy="10" r="2.4" />
    <path d="M8.03 4.76L8.34 2.58A7.6 7.6 0 0 1 11.66 2.58L11.97 4.76A5.6 5.6 0 0 1 13.55 5.67L15.59 4.86A7.6 7.6 0 0 1 17.25 7.73L15.53 9.09A5.6 5.6 0 0 1 15.53 10.91L17.25 12.27A7.6 7.6 0 0 1 15.59 15.14L13.55 14.33A5.6 5.6 0 0 1 11.97 15.24L11.66 17.42A7.6 7.6 0 0 1 8.34 17.42L8.03 15.24A5.6 5.6 0 0 1 6.45 14.33L4.41 15.14A7.6 7.6 0 0 1 2.75 12.27L4.47 10.91A5.6 5.6 0 0 1 4.47 9.09L2.75 7.73A7.6 7.6 0 0 1 4.41 4.86L6.45 5.67A5.6 5.6 0 0 1 8.03 4.76Z" />
  </Glyph>
)
const PinIcon = ({ on = false }: { on?: boolean }) => (
  <Glyph filled={on}>
    <path d="M14 4l-4 4-2-2L6 8l2 2-4 4 1 1 4-4 2 2 2-2-2-2 4-4-1-1z" />
  </Glyph>
)
const BookmarkIcon = () => (
  <Glyph>
    <path d="M6 3.5h8a.8.8 0 01.8.8v12.2l-4.8-3.4-4.8 3.4V4.3a.8.8 0 01.8-.8z" />
    <path d="M10 6.5v4M8 8.5h4" />
  </Glyph>
)
const CameraIcon = () => (
  <Glyph>
    <path d="M3.5 7h3l1.5-2h4l1.5 2h3a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16.5 17h-13A1.5 1.5 0 0 1 2 15.5v-7A1.5 1.5 0 0 1 3.5 7z" />
    <circle cx="10" cy="12" r="2.8" />
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
    <rect x="2" y="5" width="16" height="10" rx="1.6" />
    <path d="M6 5v10M14 5v10" />
  </Glyph>
)
/** The browser window: a frame with its bar, and the picture growing into it — or shrinking back. */
const WindowIcon = ({ on }: { on: boolean }) => (
  <Glyph>
    <rect x="2.4" y="3.6" width="15.2" height="12.8" rx="2.2" />
    <path d="M2.4 7h15.2" />
    {on ? (
      <path d="M6 14l2.4-2M8.4 12H6.6M8.4 12v1.8M14 9.4l-2.4 2M11.6 11.4h1.8M11.6 11.4V9.6" />
    ) : (
      <path d="M7.2 13.6l5.6-4M7.2 13.6h2.2M7.2 13.6v-2.2M12.8 9.6h-2.2M12.8 9.6v2.2" />
    )}
  </Glyph>
)
const FullIcon = ({ on }: { on: boolean }) => (
  <Glyph>
    {on ? <path d="M7.5 3.5v4h-4M12.5 3.5v4h4M7.5 16.5v-4h-4M12.5 16.5v-4h4" /> : <path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" />}
  </Glyph>
)

const EqIcon = () => (
  <Glyph>
    <path d="M4 3.5v13M10 3.5v13M16 3.5v13" />
    <circle cx="4" cy="7" r="2" fill="currentColor" />
    <circle cx="10" cy="13" r="2" fill="currentColor" />
    <circle cx="16" cy="9.5" r="2" fill="currentColor" />
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
  eqToggle,
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  wideOnly?: boolean
  toggle?: string
  eqToggle?: string
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
      data-eq-toggle={eqToggle}
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

function SeekBar({
  time,
  duration,
  buffered,
  loopA,
  loopB,
  marks = [],
  onSeek,
}: {
  time: number
  duration: number
  buffered: number
  loopA?: number | null
  loopB?: number | null
  /** Bookmarks, as ticks over the bar; the hover time names one that is near. */
  marks?: PlayerMark[]
  onSeek: (seconds: number) => void
}) {
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
        {known && loopA !== null && loopA !== undefined ? (
          <div
            className="absolute inset-y-0 bg-stage-accent/40 ring-1 ring-stage-accent"
            style={{
              left: share(loopA),
              width:
                loopB !== null && loopB !== undefined && loopB > loopA
                  ? `${Math.min(100 - (loopA / duration) * 100, ((loopB - loopA) / duration) * 100)}%`
                  : '4px',
            }}
          />
        ) : null}
        {hover ? <div className="absolute inset-y-0 left-0 bg-white/30" style={{ width: hover.x }} /> : null}
        <div className="absolute inset-y-0 left-0 bg-stage-accent" style={{ width: share(time) }} />
      </div>
      {known
        ? marks.map((mark) => (
            <span
              key={mark.id}
              className="pointer-events-none absolute top-1/2 h-[12px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-pill bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.45)]"
              style={{ left: share(mark.at) }}
              aria-hidden
            />
          ))
        : null}
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
          {(() => {
            // Within a few pixels of a mark, its name.
            const near = marks.find((mark) => Math.abs((mark.at / duration) * hover.width - hover.x) <= 6)
            return near ? <span className="font-sans text-white/80"> · {markName(marks, near)}</span> : null
          })()}
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
  activeHeight?: number | null
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

function CoverPickerModal({ image, onClose }: { image: string; onClose: () => void }) {
  const list = merkItems()
  const [selectedId, setSelectedId] = useState<string>(() => list[0]?.id ?? '')
  const [saved, setSaved] = useState(false)

  const handleSave = () => {
    if (!selectedId) return
    updateMerkItem(selectedId, { cover: image, coverFrame: undefined })
    setSaved(true)
    setTimeout(() => {
      onClose()
    }, 1000)
  }

  return (
    <Dialog open onClose={onClose} title="Standbild als Merkliste-Cover übernehmen" size="md">
      <div className="flex flex-col gap-[14px]">
        <div className="flex justify-center overflow-hidden rounded-card bg-panel-mid p-[4px]">
          <img src={image} alt="Vorschau" className="max-h-[180px] w-auto rounded object-contain" />
        </div>
        {list.length === 0 ? (
          <p className="py-[8px] text-center text-small text-muted">
            Ihre Merkliste enthält noch keine Einträge.
          </p>
        ) : (
          <div className="flex flex-col gap-[6px]">
            <label className="text-small font-semibold text-ink">Serie auswählen:</label>
            <Select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className="w-full font-sans">
              {list.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="mt-[12px] flex items-center justify-between">
          <Button type="button" size="sm" variant="quiet" onClick={onClose}>
            Abbrechen
          </Button>
          {list.length > 0 ? (
            <Button type="button" size="sm" onClick={handleSave} disabled={saved}>
              {saved ? 'Gespeichert!' : 'Als Cover festlegen'}
            </Button>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}

export function PlayerPanel({ hidden = false }: { hidden?: boolean } = {}) {
  const sessionAssets = useSession((state) => state.assets)
  const setActiveAsset = useSession((state) => state.setActiveAsset)
  const setPanel = useSession((state) => state.setPanel)
  const log = useSession((state) => state.log)
  const { ingest } = useIngestFiles()

  const [items, setItems] = useState<PlayerItem[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const current = items.find((item) => item.id === currentId) ?? null

  const [settings, setSettings] = useState<PlayerSettings>(rememberedSettings)
  // The series the file is on the Merkliste, if any: its opening is its own.
  const merk = useMerkliste()
  const series = useMemo(() => (current ? matchEpisode(current.name, merk) : null), [current?.name, merk])
  const opening = series?.item.opening ?? settings.opening
  /** The openings learned for the series by ear, and a mark that changes when one is added. */
  const prints = useMemo(() => (series?.item.intros ?? []).map((entry) => entry.print), [series?.item.intros])
  const introTag = prints.length ? printTag(prints) : ''
  /** Where the series' opening sits in this file, once looked for. */
  const [introHere, setIntroHere] = useState<{ id: string; state: 'finding' | 'none' | FoundIntro } | null>(null)
  /** Learning an opening from two episodes: what it is doing, and what came of it. */
  const [introStep, setIntroStep] = useState<string | null>(null)
  const [introNote, setIntroNote] = useState<string | null>(null)
  const introSpan = introHere && introHere.id === currentId && typeof introHere.state === 'object' ? introHere.state : null
  const introFinding = introHere?.id === currentId && introHere.state === 'finding'
  /** „Vorspann überspringen“ used on this file: not offered again. */
  const [openingDone, setOpeningDone] = useState<string | null>(null)
  const [sleep, setSleep] = useState<SleepTimer | null>(null)
  /** This file's bookmarks, kept on this device by name and size. */
  const [marks, setMarks] = useState<PlayerMark[]>([])
  /** „Lesezeichen bei 12:34“, briefly, over the picture. */
  const [markNote, setMarkNote] = useState<{ key: number; text: string } | null>(null)
  /** What the sleep timer did, until playing starts again. */
  const [sleepNote, setSleepNote] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [sourceDimensions, setSourceDimensions] = useState<Record<string, { width: number; height: number }>>({})
  const masterDimensionsRef = useRef<Record<string, { width: number; height: number }>>({})
  const qualityCache = useRef<Map<string, Map<number, string>>>(new Map())
  const [failed, setFailed] = useState(false)
  /** A file from Drive that has to come whole first: how far, or why not. */
  const [fetching, setFetching] = useState<{ id: string; fraction: number | null; problem?: string; signIn?: boolean } | null>(null)
  /** Asks the effect below to try a file from Drive again, after signing in. */
  const [remoteTry, setRemoteTry] = useState(0)
  const [captions, setCaptions] = useState(-1)
  const [resume, setResume] = useState<number | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [theater, setTheater] = useState(false)
  const [fill, setFill] = useState(false)
  const [idle, setIdle] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [eqDrawerOpen, setEqDrawerOpen] = useState(false)
  const [remaining, setRemaining] = useState(false)
  const [loopA, setLoopA] = useState<number | null>(null)
  const [loopB, setLoopB] = useState<number | null>(null)
  const [coverPickerImage, setCoverPickerImage] = useState<string | null>(null)
  const [pinned, setPinned] = useState(false)

  const toggleAlwaysOnTop = async () => {
    if (APP_BRIDGE?.setAlwaysOnTop) {
      const next = !pinned
      const res = await APP_BRIDGE.setAlwaysOnTop(next)
      setPinned(res)
    }
  }

  const captureCurrentFrame = () => {
    const node = video()
    if (!node || node.videoWidth === 0 || node.videoHeight === 0) return
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 720 / Math.max(node.videoWidth, node.videoHeight))
    canvas.width = Math.round(node.videoWidth * scale)
    canvas.height = Math.round(node.videoHeight * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(node, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/webp', 0.9)
    setCoverPickerImage(dataUrl.startsWith('data:image/webp') ? dataUrl : canvas.toDataURL('image/jpeg', 0.9))
  }

  useEffect(() => {
    if (!current) return
    updateDiscordPresence({
      details: 'Wiedergabe',
      state: current.name,
      assets: {
        large_image: 'sondra',
        large_text: 'Sondra Player',
      },
      timestamps: {
        start: Math.floor(Date.now() / 1000),
      },
    })
    return () => {
      updateDiscordPresence(null)
    }
  }, [current?.name])

  useEffect(() => {
    setLoopA(null)
    setLoopB(null)
  }, [currentId])

  // Each file brings its own bookmarks.
  useEffect(() => {
    setMarks(current ? marksFor(current) : [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.name, current?.size])

  useEffect(() => {
    if (!markNote) return
    const timer = window.setTimeout(() => setMarkNote(null), 1800)
    return () => window.clearTimeout(timer)
  }, [markNote])

  const changeMarks = (next: PlayerMark[]) => {
    setMarks(next)
    if (current) saveMarks(current, next)
  }
  const addMark = () => {
    const at = videoRef.current?.currentTime ?? time
    const { marks: next, added } = withMark(marks, at)
    if (!added) {
      setMarkNote({ key: Date.now(), text: `Bei ${clock(at)} liegt schon ein Lesezeichen` })
      return
    }
    changeMarks(next)
    setMarkNote({ key: Date.now(), text: `Lesezeichen bei ${clock(added.at)}` })
  }
  const jumpMark = (direction: 1 | -1) => {
    const mark = neighbourMark(marks, videoRef.current?.currentTime ?? time, direction)
    if (mark) seek(mark.at)
    else setMarkNote({ key: Date.now(), text: marks.length ? (direction > 0 ? 'Kein Lesezeichen mehr danach' : 'Kein Lesezeichen davor') : 'Noch keine Lesezeichen — B setzt eins' })
  }

  const toggleLoopAB = () => {
    if (loopA === null) {
      setLoopA(time)
      log('abspielen', `A-B Loop: Startpunkt A bei ${clock(time)} gesetzt`)
    } else if (loopB === null) {
      if (time > loopA + 0.2) {
        setLoopB(time)
        log('abspielen', `A-B Loop: Endpunkt B bei ${clock(time)} gesetzt (Loop aktiv)`)
      } else {
        setLoopA(time)
        log('abspielen', `A-B Loop: Startpunkt A auf ${clock(time)} aktualisiert`)
      }
    } else {
      setLoopA(null)
      setLoopB(null)
      log('abspielen', 'A-B Loop deaktiviert')
    }
  }
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

  const setEqGain = useCallback(
    (bandIndex: number, gain: number) => {
      const clamped = Math.max(-12, Math.min(12, Math.round(gain * 2) / 2))
      const patch: Partial<PlayerSettings> = {}
      if (bandIndex === 0) {
        patch.eqBand1 = clamped
        patch.eqLow = clamped
      } else if (bandIndex === 1) {
        patch.eqBand2 = clamped
      } else if (bandIndex === 2) {
        patch.eqBand3 = clamped
        patch.eqMid = clamped
      } else if (bandIndex === 3) {
        patch.eqBand4 = clamped
      } else if (bandIndex === 4) {
        patch.eqBand5 = clamped
        patch.eqHigh = clamped
      }
      patch.eqPreset = 'Custom'
      updateSettings(patch)
    },
    [updateSettings],
  )

  const selectEqPreset = useCallback(
    (preset: EqualizerPresetName) => {
      const values = EQUALIZER_PRESETS[preset]
      if (values) {
        updateSettings({
          eqBand1: values[0],
          eqBand2: values[1],
          eqBand3: values[2],
          eqBand4: values[3],
          eqBand5: values[4],
          eqLow: values[0],
          eqMid: values[2],
          eqHigh: values[4],
          eqPreset: preset,
          eqEnabled: true,
        })
      }
    },
    [updateSettings],
  )

  const resetEq = useCallback(() => {
    selectEqPreset('Flat')
  }, [selectEqPreset])

  /* -- adding files ------------------------------------------------------------ */

  const addFiles = useCallback(
    async (list: (File | RemoteMedia)[], play: boolean) => {
      const media = list.filter((file) => playerKind(file))
      const subs = list.filter((file): file is File => !isRemote(file) && isSubtitleFile(file))
      const added: PlayerItem[] = media.map((file) => ({
        id: newId(),
        name: file.name || 'Datei',
        size: file.size,
        kind: playerKind(file)!,
        // From Drive: nothing here, it is streamed from there.
        source: isRemote(file) ? new Blob([]) : file,
        subtitles: [],
        ...(isRemote(file) ? { remote: file } : {}),
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

  // Files sent from elsewhere (the folder page): the whole list, or added to it.
  useEffect(() => {
    receivePlayerFiles(({ files, replace }) => {
      if (replace) {
        itemsRef.current = []
        currentIdRef.current = null
      }
      void addFiles(files, true)
    })
    return () => receivePlayerFiles(null)
  }, [addFiles])

  // While this tool is open, a drop anywhere on the window is the player's.
  useEffect(() => {
    if (hidden) {
      claimDrops(null)
      return
    }
    claimDrops((files) => void addFiles(files, true))
    return () => claimDrops(null)
  }, [addFiles, hidden])

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
      const isCached = Array.from(qualityCache.current.get(id)?.values() ?? []).includes(old.url ?? '')
      if (old.url && !isCached) URL.revokeObjectURL(old.url)
      const { [id]: _gone, ...rest } = value
      return rest
    })

  const remove = (id: string) => {
    qualityCache.current.get(id)?.forEach((url) => URL.revokeObjectURL(url))
    qualityCache.current.delete(id)
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
    const previous = versionsRef.current[item.id]
    const keepOld = previous?.url ?? null
    const currentActiveHeight = previous?.activeHeight ?? (previous?.url && previous?.fraction === 1 ? previous.height : null)
    setVersions((value) => ({
      ...value,
      [item.id]: {
        ...spec,
        itemId: item.id,
        fraction: 0.0001,
        started: true,
        activeHeight: currentActiveHeight,
        url: keepOld,
        error: null,
      },
    }))
    const started = performance.now()
    try {
      const name = diskName(item.name)
      const job = standJob(spec.remedy, found, diskPath(name), {
        maxHeight: spec.height ?? 720,
        crf: spec.height && spec.height <= 480 ? 28 : 26,
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
      if (spec.height) {
        let itemCache = qualityCache.current.get(item.id)
        if (!itemCache) {
          itemCache = new Map()
          qualityCache.current.set(item.id, itemCache)
        }
        itemCache.set(spec.height, url)
      }
      // The film keeps its place and keeps playing across the swap.
      const node = videoRef.current
      if (currentIdRef.current === item.id && node) {
        if (node.currentTime > 0) setResume(node.currentTime)
        wasPlaying.current = !node.paused
      }
      if (keepOld) {
        const isCached = Array.from(qualityCache.current.get(item.id)?.values() ?? []).includes(keepOld)
        if (!isCached) URL.revokeObjectURL(keepOld)
      }
      setVersions((value) => ({
        ...value,
        [item.id]: {
          ...spec,
          itemId: item.id,
          fraction: 1,
          started: false,
          activeHeight: spec.height,
          url,
          error: null,
        },
      }))
      setFailed(false)
      log('abspielen', `${item.name}: ${spec.height ? `${spec.height}p` : 'abspielbare Fassung'} bereit (${((performance.now() - started) / 1000).toFixed(1)} s)`)
    } catch (failure) {
      if (controller.signal.aborted) return
      const lines = (failure instanceof Error ? failure.message : String(failure)).split('\n').filter(Boolean)
      const message = (lines.length > 1 ? lines[lines.length - 1] : lines[0] ?? 'Unbekannter Fehler').replace(/\.$/, '')
      setVersions((value) => ({
        ...value,
        [item.id]: {
          ...spec,
          itemId: item.id,
          fraction: 0,
          started: false,
          activeHeight: currentActiveHeight,
          url: keepOld,
          error: message,
        },
      }))
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
      if (found.width && found.height) {
        const width = found.width
        const height = found.height
        masterDimensionsRef.current[item.id] = { width, height }
        setSourceDimensions((prev) => ({ ...prev, [item.id]: { width, height } }))
      }
      return found
    })
    probes.current.set(item.id, asked)
    return asked
  }

  /** When the browser cannot play a file, or plays it without sound. */
  const look = async (item: PlayerItem, browserFailed: boolean) => {
    // FFmpeg reads files on this device; one in Drive plays as the browser can.
    if (item.remote) return
    const found = await probe(item)
    if (!found) return
    if (browserFailed) {
      if (found.durationSeconds) setDuration((value) => value || found.durationSeconds || 0)
      if (found.width && found.height) {
        const width = found.width
        const height = found.height
        setSize({ width, height })
        setSourceDimensions((prev) => ({ ...prev, [item.id]: { width, height } }))
      }
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
    const remote = current.remote
    if (remote) {
      // Streamed where the service worker can; else fetched whole first, with its share shown.
      const id = current.id
      const controller = new AbortController()
      let made: string | null = null
      setOriginalUrl(null)
      setFetching(null)
      void (async () => {
        try {
          const stream = await driveMediaUrl(remote)
          if (controller.signal.aborted) return
          if (stream) return setOriginalUrl(stream)
          setFetching({ id, fraction: 0 })
          const bytes = await readDriveFile(remote.id, controller.signal, (loaded) =>
            setFetching({ id, fraction: remote.size > 0 ? Math.min(1, loaded / remote.size) : null }),
          )
          if (controller.signal.aborted) return
          made = URL.createObjectURL(new Blob([bytes as BlobPart], { type: remote.type }))
          setOriginalUrl(made)
          setFetching(null)
        } catch (error) {
          if (controller.signal.aborted) return
          const code = error instanceof DriveError ? error.code : 'failed'
          setFetching({ id, fraction: null, problem: DRIVE_PROBLEM[code], signIn: code === 'expired' || code === 'unauthorized' })
        }
      })()
      return () => {
        controller.abort()
        if (made) URL.revokeObjectURL(made)
      }
    }
    setFetching(null)
    const url = URL.createObjectURL(current.source)
    setOriginalUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [current?.id, current?.source, remoteTry])
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
      qualityCache.current.forEach((map) => map.forEach((url) => URL.revokeObjectURL(url)))
      qualityCache.current.clear()
      Object.values(versionsRef.current).forEach((entry) => entry.url && URL.revokeObjectURL(entry.url))
    },
    [],
  )

  /* -- sleep timer -------------------------------------------------------------------- */

  // Down over the last ten seconds, then paused; the volume set stays as it was.
  useEffect(() => {
    if (!sleep || !('until' in sleep)) return
    const tick = () => {
      const left = sleep.until - Date.now()
      setNow(Date.now())
      const node = videoRef.current
      if (node) node.volume = settings.volume * sleepFade(left)
      if (left > 0) return
      node?.pause()
      if (node) node.volume = settings.volume
      setSleep(null)
      setSleepNote(`Nach ${sleep.minutes} Minuten angehalten.`)
    }
    tick()
    const timer = window.setInterval(tick, 500)
    return () => {
      window.clearInterval(timer)
      if (videoRef.current) videoRef.current.volume = settings.volume
    }
  }, [sleep, settings.volume])

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

  // Equalizer, bass boost, karaoke, night mode and the visualizer's analyser,
  // through Web Audio. The visualizer belongs to a sound file's stage; a film
  // has its picture and does not route through the graph for it.
  const showVisualizer = settings.visualizer && current?.kind === 'audio'
  interface AudioNodes {
    node: HTMLVideoElement
    source: MediaElementAudioSourceNode
    bass: BiquadFilterNode
    equalizer: EqualizerRack
    karaoke: KaraokeProcessor
    squeeze: DynamicsCompressorNode
    gain: GainNode
    analyser: AnalyserNode
  }
  const graph = useRef<AudioNodes | null>(null)
  const visualizerCanvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const node = videoRef.current
    if (!node) return
    const eqActive =
      settings.eqEnabled &&
      (settings.eqBand1 !== 0 ||
        settings.eqBand2 !== 0 ||
        settings.eqBand3 !== 0 ||
        settings.eqBand4 !== 0 ||
        settings.eqBand5 !== 0)
    const wanted =
      settings.boost > 1 ||
      settings.night ||
      settings.bassBoost > 0 ||
      eqActive ||
      settings.eqLow !== 0 ||
      settings.eqMid !== 0 ||
      settings.eqHigh !== 0 ||
      settings.karaoke ||
      showVisualizer

    if (!wanted && graph.current?.node !== node) return
    try {
      if (graph.current?.node !== node) {
        const context = getAudioContext()
        const source = context.createMediaElementSource(node)

        const bass = context.createBiquadFilter()
        bass.type = 'lowshelf'
        bass.frequency.value = 90
        bass.gain.value = settings.bassBoost

        const equalizer = new EqualizerRack(context, {
          initialGains: [
            settings.eqBand1,
            settings.eqBand2,
            settings.eqBand3,
            settings.eqBand4,
            settings.eqBand5,
          ],
          enabled: settings.eqEnabled,
        })

        const karaoke = createKaraokeProcessor(context)
        karaoke.setEnabled(settings.karaoke)

        const squeeze = context.createDynamicsCompressor()
        squeeze.threshold.value = -32
        squeeze.knee.value = 18
        squeeze.ratio.value = 5
        squeeze.attack.value = 0.01
        squeeze.release.value = 0.35

        const gain = context.createGain()
        const analyser = context.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.8

        source.connect(bass)
        bass.connect(equalizer.input)
        equalizer.output.connect(karaoke.input)

        if (settings.night) {
          karaoke.output.connect(squeeze)
          squeeze.connect(gain)
        } else {
          karaoke.output.connect(gain)
        }

        gain.connect(analyser)
        analyser.connect(context.destination)

        graph.current = { node, source, bass, equalizer, karaoke, squeeze, gain, analyser }
        void resumeAudioContext()
      }

      const g = graph.current!
      g.bass.gain.value = settings.bassBoost
      g.equalizer.setEnabled(settings.eqEnabled)
      g.equalizer.setGains([
        settings.eqBand1,
        settings.eqBand2,
        settings.eqBand3,
        settings.eqBand4,
        settings.eqBand5,
      ])
      g.karaoke.setEnabled(settings.karaoke)
      g.gain.gain.value = settings.boost * (settings.night ? 1.6 : 1)

      g.karaoke.output.disconnect()
      g.squeeze.disconnect()
      if (settings.night) {
        g.karaoke.output.connect(g.squeeze)
        g.squeeze.connect(g.gain)
      } else {
        g.karaoke.output.connect(g.gain)
      }

      void resumeAudioContext()
    } catch {
      /* the browser declined; the element's own volume still works */
    }
  }, [
    settings.boost,
    settings.night,
    settings.bassBoost,
    settings.eqLow,
    settings.eqMid,
    settings.eqHigh,
    settings.eqBand1,
    settings.eqBand2,
    settings.eqBand3,
    settings.eqBand4,
    settings.eqBand5,
    settings.eqEnabled,
    settings.karaoke,
    showVisualizer,
    sourceUrl,
  ])

  // The visualizer draws on the sound stage at the canvas's own size, in the
  // stage's one colour. The analyser is read every frame rather than once:
  // a new title builds a new graph, and a captured one would go silent.
  // Paused it draws its resting floor once (again on a resize); out of
  // sight it does not draw at all.
  useEffect(() => {
    if (!showVisualizer || hidden) return
    const canvas = visualizerCanvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const styles = getComputedStyle(document.documentElement)
    const accent = styles.getPropertyValue('--color-stage-accent').trim() || '#8fe0a6'
    const rest = styles.getPropertyValue('--color-stage-line').trim() || '#515a5d'
    const mode = settings.visualizerMode ?? 'bars'
    let frequency = new Uint8Array(0)
    let wave = new Uint8Array(0)
    let frame = 0

    const render = () => {
      if (playing) frame = requestAnimationFrame(render)
      const ratio = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w === 0 || h === 0) return
      if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
        canvas.width = Math.round(w * ratio)
        canvas.height = Math.round(h * ratio)
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const analyser = graph.current?.analyser ?? null
      const live = playing && analyser !== null
      if (analyser && frequency.length !== analyser.frequencyBinCount) {
        frequency = new Uint8Array(analyser.frequencyBinCount)
        wave = new Uint8Array(analyser.frequencyBinCount)
      }
      if (live) {
        analyser.getByteFrequencyData(frequency)
        analyser.getByteTimeDomainData(wave)
      }
      ctx.fillStyle = live ? accent : rest
      ctx.strokeStyle = live ? accent : rest

      if (mode === 'wave') {
        ctx.lineWidth = 2
        ctx.lineJoin = 'round'
        ctx.beginPath()
        const points = Math.max(2, wave.length)
        for (let i = 0; i < points; i += 1) {
          const v = live ? (wave[i] - 128) / 128 : 0
          const x = (i / (points - 1)) * w
          const y = h / 2 + v * (h / 2 - 2)
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      } else if (mode === 'radial') {
        const bars = 48
        const radius = Math.min(w, h) * 0.22
        const reach = Math.min(w, h) / 2 - radius - 2
        ctx.lineWidth = 2.5
        ctx.lineCap = 'round'
        for (let i = 0; i < bars; i += 1) {
          const v = live ? frequency[Math.floor((i / bars) * frequency.length * 0.7)] / 255 : 0
          const angle = (i / bars) * Math.PI * 2 - Math.PI / 2
          const inner = radius
          const outer = radius + 3 + v * reach
          ctx.beginPath()
          ctx.moveTo(w / 2 + Math.cos(angle) * inner, h / 2 + Math.sin(angle) * inner)
          ctx.lineTo(w / 2 + Math.cos(angle) * outer, h / 2 + Math.sin(angle) * outer)
          ctx.stroke()
        }
      } else {
        // Bars from the floor, as many as fit at a steady pitch. The top of
        // the spectrum is mostly air; the lower seven tenths carry the music.
        const pitch = 8
        const bars = Math.max(8, Math.floor(w / pitch))
        const width = pitch - 3
        for (let i = 0; i < bars; i += 1) {
          const v = live ? frequency[Math.floor((i / bars) * frequency.length * 0.7)] / 255 : 0
          const height = Math.max(2, v * h * 0.86)
          ctx.beginPath()
          ctx.roundRect(i * pitch + (w - bars * pitch) / 2 + 1.5, h - height, width, height, [2, 2, 0, 0])
          ctx.fill()
        }
      }
    }

    render()
    const observer = playing ? null : new ResizeObserver(render)
    observer?.observe(canvas)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [showVisualizer, hidden, settings.visualizerMode, playing, current?.id])

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
  const skipOpening = () => {
    if (!current) return
    // Heard where it is: to its end. Else by the length set for the series.
    if (introSpan && time < introSpan.end) seek(introSpan.end)
    else skip(opening)
    setOpeningDone(current.id)
  }

  /** Another episode of the same series in the list, to learn the opening from: the next one first. */
  const introPartner = useMemo(() => {
    if (!current || !series) return null
    const at = items.findIndex((item) => item.id === current.id)
    const others = items.filter(
      (item) => item.id !== current.id && item.kind === 'video' && item.source.size > 0 && matchEpisode(item.name, merk)?.item.id === series.item.id,
    )
    return others.find((item) => items.indexOf(item) > at) ?? others.at(-1) ?? null
  }, [items, current, series, merk])

  const learnOpening = async () => {
    if (!current || !series || !introPartner || introStep) return
    const item = current
    const other = introPartner
    const seriesId = series.item.id
    setIntroNote(null)
    try {
      setIntroStep(`Hört „${item.name}“ an …`)
      const a = await decodeHead(item.source, item.name)
      setIntroStep(`Hört „${other.name}“ an …`)
      const b = await decodeHead(other.source, other.name)
      setIntroStep('Vergleicht die beiden …')
      const found = await learnIntro(a, b)
      if (!found) {
        setIntroNote('Die beiden Folgen haben in den ersten acht Minuten keinen gemeinsamen Vorspann.')
        return
      }
      let kept: string[] = []
      updateMerkItem(seriesId, (entry) => {
        const intros = [...(entry.intros ?? []), { print: found.print, seconds: found.seconds, learnedAt: Date.now() }].slice(-INTROS_KEPT)
        kept = intros.map((intro) => intro.print)
        // The fixed length follows, for episodes where it is not heard.
        return { intros, opening: Math.min(OPENING_MAX, Math.max(OPENING_MIN, Math.round(found.seconds))) }
      })
      keepIntro(item, kept, { start: found.a, end: found.a + found.seconds })
      keepIntro(other, kept, { start: found.b, end: found.b + found.seconds })
      setIntroNote(`Erkannt: ${minutesSeconds(found.seconds)} lang, in dieser Folge ab ${clock(found.a)}.`)
      log('abspielen', `Vorspann von „${series.item.title}“ erkannt (${minutesSeconds(found.seconds)}, aus ${item.name} und ${other.name})`)
    } catch (error) {
      setIntroNote(`Nicht erkannt: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    } finally {
      setIntroStep(null)
    }
  }
  const forgetOpenings = () => {
    if (!series) return
    updateMerkItem(series.item.id, { intros: undefined })
    setIntroNote('Vergessen. Es gilt wieder die feste Länge.')
  }

  // Where the series' opening is in this file: heard once, then kept per file.
  useEffect(() => {
    if (!current || current.kind !== 'video' || !settings.skipOpening || prints.length === 0 || current.source.size === 0) {
      setIntroHere(null)
      return
    }
    const kept = keptIntro(current, prints)
    if (kept) {
      setIntroHere({ id: current.id, state: kept })
      return
    }
    let cancelled = false
    const item = current
    const wanted = prints
    setIntroHere({ id: item.id, state: 'finding' })
    // A moment for the film to start before FFmpeg takes its turn. Not
    // aborted when the file changes: what it finds is kept for next time.
    const timer = window.setTimeout(() => {
      void decodeHead(item.source, item.name)
        .then((pcm) => findIntro(wanted, pcm))
        .then((found) => {
          keepIntro(item, wanted, found)
          if (!cancelled) setIntroHere({ id: item.id, state: found ?? 'none' })
        })
        .catch(() => {
          if (!cancelled) setIntroHere({ id: item.id, state: 'none' })
        })
    }, 1500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, introTag, settings.skipOpening])
  const chooseOpening = (seconds: number) => {
    // A series on the Merkliste keeps its own; anything else sets the default.
    if (series) updateMerkItem(series.item.id, { opening: seconds })
    else updateSettings({ opening: seconds })
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

  // How tall the frame is, for where the settings menu fits: over the picture
  // when there is room for it, underneath when the frame is a phone's strip.
  const [frameHeight, setFrameHeight] = useState(0)
  const hasCurrent = current !== null
  useEffect(() => {
    const node = frameRef.current
    if (!node) return
    const measure = () => setFrameHeight(node.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasCurrent])
  const menuBelow = !immersive && frameHeight > 0 && frameHeight < 400


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
    } else if (event.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight')) jumpMark(key === 'ArrowRight' ? 1 : -1)
    else if (key === 'b' || key === 'B') addMark()
    else if (key === 'ArrowLeft') skip(-settings.skip)
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
    else if (key === 's' || key === 'S') skipOpening()
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
    if (hidden) return
    const onKey = (event: KeyboardEvent) => keys.current(event)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hidden])

  // Electron global media shortcuts
  useEffect(() => {
    const app = (window as unknown as {
      sondraApp?: { onMediaAction?: (cb: (action: string) => void) => () => void }
    }).sondraApp
    if (!app?.onMediaAction) return
    const unbind = app.onMediaAction((action) => {
      if (action === 'toggle') toggle()
      else if (action === 'next') goTo(1)
      else if (action === 'prev') goTo(-1)
      else if (action === 'stop') {
        const n = video()
        if (n) {
          n.pause()
          n.currentTime = 0
        }
      }
    })
    return unbind
  }, [index, items.length])

  // Navigator mediaSession
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    if (!current) {
      navigator.mediaSession.playbackState = 'none'
      return
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.name.replace(/\.[^.]+$/, ''),
      artist: 'Sondra',
      album: 'Sondra Studio',
    })

    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'

    const handlePlay = () => void video()?.play().catch(() => undefined)
    const handlePause = () => video()?.pause()
    const handlePrev = () => goTo(-1)
    const handleNext = () => goTo(1)
    const handleSeekTo = (details: MediaSessionActionDetails) => {
      if (details.seekTime !== undefined) seek(details.seekTime)
    }
    const handleSeekBackward = (details: MediaSessionActionDetails) => {
      skip(-(details.seekOffset || settings.skip))
    }
    const handleSeekForward = (details: MediaSessionActionDetails) => {
      skip(details.seekOffset || settings.skip)
    }

    try {
      navigator.mediaSession.setActionHandler('play', handlePlay)
      navigator.mediaSession.setActionHandler('pause', handlePause)
      navigator.mediaSession.setActionHandler('previoustrack', handlePrev)
      navigator.mediaSession.setActionHandler('nexttrack', handleNext)
      navigator.mediaSession.setActionHandler('seekto', handleSeekTo)
      navigator.mediaSession.setActionHandler('seekbackward', handleSeekBackward)
      navigator.mediaSession.setActionHandler('seekforward', handleSeekForward)
    } catch {
      // not all actions supported
    }

    return () => {
      try {
        navigator.mediaSession.setActionHandler('play', null)
        navigator.mediaSession.setActionHandler('pause', null)
        navigator.mediaSession.setActionHandler('previoustrack', null)
        navigator.mediaSession.setActionHandler('nexttrack', null)
        navigator.mediaSession.setActionHandler('seekto', null)
        navigator.mediaSession.setActionHandler('seekbackward', null)
        navigator.mediaSession.setActionHandler('seekforward', null)
      } catch {
        // ignore
      }
    }
  }, [current, playing, settings.skip, index, items.length])

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    if (!current || duration <= 0) return
    try {
      if ('setPositionState' in navigator.mediaSession) {
        navigator.mediaSession.setPositionState({
          duration,
          playbackRate: settings.rate,
          position: Math.min(Math.max(0, time), duration),
        })
      }
    } catch {
      // ignore
    }
  }, [time, duration, settings.rate, current])

  /* -- the settings menu's view of things ----------------------------------------------------- */

  const info = current ? facts[current.id] : undefined
  const known = info && info !== 'pending' ? info : null
  const masterDim = current ? masterDimensionsRef.current[current.id] ?? sourceDimensions[current.id] : null
  const sourceHeight = masterDim?.height ?? known?.height ?? size?.height ?? videoRef.current?.videoHeight ?? null
  const activeHeight = version?.activeHeight ?? (version?.url && (!version.started || version.fraction === 1) ? version.height : null)
  const qualityState: QualityState = {
    current: version?.reason === 'chosen' && activeHeight ? activeHeight : 'original',
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

    // If item has a streamVariant matching this height, switch directly without re-encode
    if (quality !== 'original' && current.streamVariants) {
      const match = current.streamVariants.find((v) => v.height === quality)
      if (match) {
        jobAbort.current?.abort()
        keepPlace()
        setVersions((value) => ({
          ...value,
          [current.id]: {
            itemId: current.id,
            reason: 'chosen',
            remedy: 'picture',
            height: quality,
            activeHeight: quality,
            audioIndex: version?.audioIndex ?? 0,
            fraction: 1,
            started: false,
            url: match.url,
            error: null,
          },
        }))
        return
      }
    }

    const found = await probe(current)
    if (!found) return
    const audioStreams = found.streams.filter((stream) => stream.type === 'audio')
    const audioIndex = version?.audioIndex ?? 0
    if (quality === 'original') {
      if (audioIndex === 0 || audioStreams.length < 2) {
        jobAbort.current?.abort()
        if (versionsRef.current[current.id]?.reason === 'chosen') {
          keepPlace()
          dropVersion(current.id)
        }
        return
      }
      const codec = audioStreams[audioIndex]?.codec ?? ''
      return make(current, found, { reason: 'chosen', remedy: browserPlaysAudio(codec) && !failed ? 'repack' : 'sound', height: null, audioIndex })
    }

    const cachedUrl = qualityCache.current.get(current.id)?.get(quality)
    if (cachedUrl) {
      jobAbort.current?.abort()
      keepPlace()
      setVersions((value) => ({
        ...value,
        [current.id]: {
          itemId: current.id,
          reason: 'chosen',
          remedy: 'picture',
          height: quality,
          activeHeight: quality,
          audioIndex,
          fraction: 1,
          started: false,
          url: cachedUrl,
          error: null,
        },
      }))
      return
    }

    return make(current, found, { reason: 'chosen', remedy: 'picture', height: quality, audioIndex })
  }

  const chooseAudio = async (audioIndex: number) => {
    if (!current) return
    const found = await probe(current)
    if (!found) return
    const audioStreams = found.streams.filter((stream) => stream.type === 'audio')
    const height = version?.reason === 'chosen' ? version.height : null
    if (height) return make(current, found, { reason: 'chosen', remedy: 'picture', height, audioIndex })
    if (audioIndex === 0) {
      if (versionsRef.current[current.id]?.reason === 'chosen') {
        keepPlace()
        dropVersion(current.id)
      }
      return
    }
    const codec = audioStreams[audioIndex]?.codec ?? ''
    return make(current, found, { reason: 'chosen', remedy: browserPlaysAudio(codec) ? 'repack' : 'sound', height: null, audioIndex })
  }

  /* -- what the session holds that is not on the list yet ------------------------------------ */

  const fromSession = useMemo(
    () => sessionAssets.filter((asset) => (asset.kind === 'video' || asset.kind === 'audio') && !items.some((item) => item.assetId === asset.id)),
    [sessionAssets, items],
  )

  const [toEditor, setToEditor] = useState(false)
  const openInEditor = async () => {
    if (!current) return
    if (current.assetId) setActiveAsset(current.assetId)
    else if (current.source instanceof File) await ingest([current.source], 'aus dem Player übernommen')
    else if (current.remote) {
      // Editing needs the file here: fetched from Drive once.
      setToEditor(true)
      try {
        const bytes = await readDriveFile(current.remote.id)
        await ingest([new File([bytes as BlobPart], current.name, { type: current.remote.type })], 'aus Google Drive übernommen')
      } catch (error) {
        log('abspielen', `${current.name} nicht aus Google Drive geladen: ${error instanceof DriveError ? DRIVE_PROBLEM[error.code] : String(error)}`, 'warn')
        return
      } finally {
        setToEditor(false)
      }
    }
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
    if (hidden) return null
    // The same door as every other tool's — but this one never reads the
    // file into the session: it is played where it lies.
    return (
      <div className="flex flex-col gap-[24px]">
        {fileInputs}
        <div className="flex flex-col gap-[20px]">
          <div className="flex flex-wrap items-center justify-between gap-[12px] border-b border-line/50 pb-[14px]">
            <div>
              <h2 className="display-md">Medien direkt von der Festplatte abspielen</h2>
              <p className="mt-[2px] text-small text-muted">
                Selbst riesige 4K-Filme und Mehrkanal-Aufnahmen öffnen augenblicklich ohne Upload.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-[6px]">
              {['MP4', 'MKV', 'AVI', 'MOV', 'WEBM', 'MP3', 'FLAC', 'WAV'].map((fmt) => (
                <span key={fmt} className="rounded-pill bg-panel-soft px-[8px] py-[3px] text-micro font-semibold text-prose ring-1 ring-inset ring-line/60">
                  {fmt}
                </span>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-[20px] items-start">
            <div
              onDragEnter={(event) => {
                if (!event.dataTransfer.types.includes('Files')) return
                event.preventDefault()
                event.stopPropagation()
                setDragging(true)
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes('Files')) return
                event.preventDefault()
                event.stopPropagation()
                event.dataTransfer.dropEffect = 'copy'
                if (!dragging) setDragging(true)
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                setDragging(false)
              }}
              onDrop={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setDragging(false)
                if (event.dataTransfer.files.length) void addFiles(Array.from(event.dataTransfer.files), true)
              }}
              className={`flex flex-col items-center justify-center gap-[14px] rounded-card p-[36px] text-center transition-colors duration-[var(--dur-fast)] min-h-[220px] ${
                dragging ? 'bg-panel-mid ring-2 ring-inset ring-ink' : 'bg-panel-soft ring-1 ring-inset ring-line'
              }`}
            >
              <div className="grid size-[48px] place-items-center rounded-pill bg-raised ring-1 ring-line text-ink">
                <svg viewBox="0 0 20 20" className="size-[22px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 3h12v14H4zM8 7l6 3-6 3V7z" />
                </svg>
              </div>
              <div>
                <p className="text-body font-medium text-ink">Video oder Musik hierher ziehen</p>
                <p className="mt-[2px] text-small text-muted">Mehrere Dateien werden automatisch zu einer Wiedergabeliste kombiniert.</p>
              </div>
              <Button onClick={() => pickRef.current?.click()}>
                Dateien auswählen
                <ArrowRight />
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-[10px]">
              <div className="flex items-start gap-[12px] rounded-card bg-panel-soft/60 p-[12px] ring-1 ring-inset ring-line/50">
                <div className="grid size-[32px] shrink-0 place-items-center rounded-nav bg-raised ring-1 ring-line/70 text-ink">
                  <svg viewBox="0 0 20 20" className="size-[16px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M13 2L3 14h7v6l10-12h-7V2z" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-small font-semibold text-ink">Direktes Festplatten-Streaming</h4>
                  <p className="text-micro text-muted leading-relaxed">Kein Zwischenspeichern im RAM. Startet sofort ohne Ruckeln auch bei 50+ GB Dateien.</p>
                </div>
              </div>

              <div className="flex items-start gap-[12px] rounded-card bg-panel-soft/60 p-[12px] ring-1 ring-inset ring-line/50">
                <div className="grid size-[32px] shrink-0 place-items-center rounded-nav bg-raised ring-1 ring-line/70 text-ink">
                  <svg viewBox="0 0 20 20" className="size-[16px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M4 5h12v10H4zM7 9h6M7 12h4" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-small font-semibold text-ink">Automatische Untertitel</h4>
                  <p className="text-micro text-muted leading-relaxed">Begleitende .srt- oder .vtt-Dateien im selben Ordner werden automatisch verknüpft.</p>
                </div>
              </div>

              <div className="flex items-start gap-[12px] rounded-card bg-panel-soft/60 p-[12px] ring-1 ring-inset ring-line/50">
                <div className="grid size-[32px] shrink-0 place-items-center rounded-nav bg-raised ring-1 ring-line/70 text-ink">
                  <svg viewBox="0 0 20 20" className="size-[16px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M3 10h3M14 10h3M6 6h8v8H6z" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-small font-semibold text-ink">Equalizer, Tempo &amp; A-B Loop</h4>
                  <p className="text-micro text-muted leading-relaxed">Feinjustierung des Klangs, variable Abspielgeschwindigkeit und Schleifen-Marker.</p>
                </div>
              </div>
            </div>
          </div>
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
  const extension = /\.([a-z0-9]{2,5})$/i.exec(current.name)?.[1]?.toUpperCase() ?? null
  const meta = [
    extension,
    formatBytes(current.size),
    size ? `${size.width} × ${size.height}` : null,
    duration > 0 ? clock(duration) : null,
    known ? [codecName(known.videoCodec), codecName(known.audioCodec)].filter((value) => value !== 'unbekannt').join(' / ') || null : null,
    version?.url ? (version.height ? `${version.height}p` : 'umgewandelt') : null,
  ].filter(Boolean)
  const sideBySide = !theater

  const equalizerDrawer = (
    <EqualizerDrawer
      placement={menuBelow ? 'below' : 'over'}
      enabled={settings.eqEnabled}
      gains={[
        settings.eqBand1,
        settings.eqBand2,
        settings.eqBand3,
        settings.eqBand4,
        settings.eqBand5,
      ]}
      activePreset={settings.eqPreset}
      onToggleEnabled={(enabled) => updateSettings({ eqEnabled: enabled })}
      onGainChange={setEqGain}
      onSelectPreset={selectEqPreset}
      onReset={resetEq}
      onClose={() => setEqDrawerOpen(false)}
    />
  )

  const settingsMenu = (
    <SettingsMenu
      kind={current.kind}
      placement={menuBelow ? 'below' : 'over'}
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
      opening={{ seconds: opening, series: series?.item.title ?? null }}
      onOpening={chooseOpening}
      marks={marks}
      time={time}
      onAddMark={addMark}
      onSeekMark={(mark) => {
        seek(mark.at)
        setMenuOpen(false)
      }}
      onMarks={changeMarks}
      intro={{
        series: series?.item.title ?? null,
        learned: prints.length,
        here: prints.length === 0 ? 'off' : (introSpan ?? (introFinding ? 'finding' : 'none')),
        partner: introPartner?.name ?? null,
        step: introStep,
        note: introNote,
      }}
      onLearnIntro={() => void learnOpening()}
      onForgetIntros={forgetOpenings}
      sleep={sleep}
      now={now}
      onSleep={(choice) => {
        setSleepNote(null)
        setSleep(choice === null ? null : choice === 'end' ? { atEnd: true } : { until: Date.now() + choice * 60_000, minutes: choice })
      }}
      onClose={() => setMenuOpen(false)}
    />
  )

  const playlist = (
    <section aria-label="Wiedergabeliste" className="flex min-w-0 flex-col gap-[8px]">
      <div className="flex items-baseline justify-between gap-[12px] border-b border-line pb-[8px]">
        <h3 className="text-small font-semibold text-ink">Als Nächstes</h3>
        <span className="value text-small text-muted">
          {index + 1} / {items.length}
        </span>
      </div>
      <ol className="flex flex-col gap-[2px]">
        {items.map((item, at) => {
          const here = item.id === currentId
          return (
            <li key={item.id} className="group/item flex max-w-none items-center gap-[2px]">
              <button
                type="button"
                onClick={() => setCurrentId(item.id)}
                aria-current={here ? 'true' : undefined}
                className={`press flex min-w-0 flex-1 items-center gap-[12px] rounded-nav px-[8px] py-[6px] text-left text-small transition-colors duration-[var(--dur-fast)] ${
                  here ? 'bg-panel-soft' : 'hover:bg-panel-soft'
                }`}
              >
                <span
                  className={`grid h-[32px] w-[32px] shrink-0 place-items-center rounded-nav ${here ? 'bg-ink text-on-ink' : 'text-muted'}`}
                >
                  {here && playing ? (
                    <span className="flex h-[12px] items-center gap-[2px]" aria-hidden>
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
                className="press grid h-[32px] w-[32px] shrink-0 place-items-center rounded-nav text-muted opacity-70 hover:bg-panel-soft hover:text-ink hover:opacity-100 focus-visible:opacity-100 group-hover/item:opacity-100"
              >
                <svg viewBox="0 0 16 16" className="h-[14px] w-[14px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </li>
          )
        })}
      </ol>
      <Button size="sm" variant="quiet" className="self-start" onClick={() => pickRef.current?.click()}>
        Weitere Dateien
      </Button>
    </section>
  )

  // Playing on while another tool is open: a small stage of its own in the
  // corner — it floats over the sheet, so it carries the one shadow.
  const miniBar =
    hidden && current ? (
      <div className="fixed inset-x-[12px] bottom-[12px] z-50 flex items-center gap-[12px] rounded-card bg-stage p-[10px] text-stage-ink ring-1 ring-inset ring-stage-line elevate-lift sm:left-auto sm:right-[24px] sm:w-[400px]">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? 'Pause' : 'Abspielen'}
          className="press grid h-[40px] w-[40px] shrink-0 place-items-center rounded-pill bg-stage-ink text-stage hover:bg-stage-accent"
        >
          {playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
          <p className="truncate text-small font-semibold">{title}</p>
          <div className="h-[3px] w-full overflow-hidden rounded-pill bg-stage-line">
            <div className="h-full bg-stage-accent" style={{ width: `${duration > 0 ? (time / duration) * 100 : 0}%` }} />
          </div>
          <p className="value text-micro leading-none text-stage-muted">
            {clock(time)} / {clock(duration)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPanel('player')}
          className="press shrink-0 rounded-nav px-[12px] py-[8px] text-small text-stage-ink ring-1 ring-inset ring-stage-line hover:bg-stage-soft"
        >
          Öffnen
        </button>
      </div>
    ) : null

  return (
    <>
      {miniBar}
      <div className={hidden ? 'hidden' : 'flex flex-col gap-[16px]'}>
        {!hidden ? fileInputs : null}
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
        @media (max-width: 639px) {
          .sondra-player.controls-up video::-webkit-media-text-track-container {
            transform: translateY(-58px);
          }
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
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes('Files')) return
              event.preventDefault()
              event.stopPropagation()
              event.dataTransfer.dropEffect = 'copy'
            }}
            onDrop={(event) => {
              if (!event.dataTransfer.files.length) return
              event.preventDefault()
              event.stopPropagation()
              void addFiles(Array.from(event.dataTransfer.files), true)
            }}
            className={`sondra-player group/player isolate overflow-hidden text-white ${isVideo ? 'bg-black' : 'bg-stage'} ${controlsShown && isVideo ? 'controls-up' : ''} ${
              fullscreen ? 'relative h-screen' : fill ? 'fixed inset-0 z-[60] h-[100dvh]' : 'relative rounded-card elevate-lift'
            } ${!controlsShown ? 'cursor-none' : ''}`}
          >
            <div
              className={`relative flex items-center justify-center ${
                immersive ? 'h-full' : isVideo ? (theater ? 'aspect-video max-h-[82vh] w-full' : 'aspect-video max-h-[72vh] w-full') : 'h-[300px] sm:h-[360px]'
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
                  if (node.videoWidth > 0 && !version?.height) {
                    setSize({ width: node.videoWidth, height: node.videoHeight })
                    if (current) {
                      masterDimensionsRef.current[current.id] = { width: node.videoWidth, height: node.videoHeight }
                      setSourceDimensions((prev) => ({ ...prev, [current.id]: { width: node.videoWidth, height: node.videoHeight } }))
                    }
                  }
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
                  if (current.remote) {
                    // From Drive: a missing sign-in looks the same to the element as a file it cannot play.
                    const signIn = !driveReadable()
                    setFetching({
                      id: current.id,
                      fraction: null,
                      problem: signIn ? DRIVE_PROBLEM.expired : 'Diese Datei spielt der Browser nicht ab. Aus Drive spielt Sondra nur, was der Browser selbst kann — zum Umwandeln die Datei auf dieses Gerät laden.',
                      signIn,
                    })
                    return
                  }
                  if (version?.url) {
                    setVersions((value) => ({ ...value, [current.id]: { ...version, url: null, error: 'Auch die umgewandelte Fassung spielt dieser Browser nicht ab' } }))
                    return
                  }
                  setFailed(true)
                  void look(current, true)
                }}
                onPlay={() => {
                  setPlaying(true)
                  setSleepNote(null)
                  void resumeAudioContext()
                  wake()
                }}
                onPause={() => {
                  setPlaying(false)
                  rememberPlace(current, video()?.currentTime ?? null)
                }}
                onTimeUpdate={(event) => {
                  const node = event.currentTarget
                  setTime(node.currentTime)
                  if (loopA !== null && loopB !== null && loopB > loopA) {
                    if (node.currentTime >= loopB || node.currentTime < loopA) {
                      node.currentTime = loopA
                    }
                  }
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
                  if (sleep && 'atEnd' in sleep) {
                    setSleep(null)
                    setSleepNote('Am Ende des Titels angehalten.')
                  } else if (settings.repeat === 'titel') {
                    seek(0)
                    void video()?.play().catch(() => undefined)
                  } else if (index < items.length - 1 && (settings.autoNext || settings.repeat === 'liste')) {
                    goTo(1)
                  } else if (settings.repeat === 'liste' && items.length > 0) {
                    if (items.length > 1) {
                      setCurrentId(items[0].id)
                    } else {
                      seek(0)
                      void video()?.play().catch(() => undefined)
                    }
                  }
                }}
              >
                {current.subtitles.map((track, at) => (
                  <track key={track.url} kind="subtitles" src={track.url} label={track.label} srcLang="de" default={at === captions} />
                ))}
              </video>

              {/* A sound file: what plays, over its picture of the sound — the
                  visualizer, or the mark's five bars when that is switched off.
                  The bottom stays free for the controls. */}
              {!isVideo ? (
                <div className="pointer-events-none absolute inset-x-0 top-0 bottom-[84px] flex flex-col gap-[16px] px-[20px] pt-[20px] sm:px-[28px] sm:pt-[28px]">
                  <div className="relative grid min-h-0 flex-1 place-items-center">
                    {showVisualizer ? (
                      <canvas ref={visualizerCanvasRef} className="absolute inset-0 h-full w-full" aria-hidden />
                    ) : (
                      <span className="flex h-[56px] items-center gap-[7px]" aria-hidden>
                        {[0.55, 0.9, 1, 0.75, 0.45].map((height, bar) => (
                          <span
                            key={bar}
                            className={`w-[9px] rounded-pill ${playing ? 'eq-bar bg-stage-accent' : 'bg-stage-line'}`}
                            style={{ height: `${height * 100}%`, animationDelay: `${bar * 0.14}s` }}
                          />
                        ))}
                      </span>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-col gap-[2px]">
                    <p className="truncate text-subheading font-semibold text-stage-ink">{title}</p>
                    <p className="value truncate text-small text-stage-muted">{meta.join(' · ')}</p>
                  </div>
                </div>
              ) : null}

              {/* What was just pressed, for a moment, in the middle. */}
              {flash ? (
                <span
                  key={flash.key}
                  className="flash-out pointer-events-none absolute grid h-[56px] w-[56px] place-items-center rounded-pill bg-stage/80 text-stage-ink"
                  aria-hidden
                  onAnimationEnd={() => setFlash(null)}
                >
                  {flash.icon === 'play' ? <PlayIcon size={26} /> : flash.icon === 'pause' ? <PauseIcon size={26} /> : flash.icon === 'back' ? <BackIcon /> : <ForwardIcon />}
                </span>
              ) : null}

              {/* A bookmark set or not found, for a moment, top left. */}
              <span role="status" className="sr-only">
                {markNote?.text ?? ''}
              </span>
              {markNote ? (
                <span
                  key={markNote.key}
                  className="pop pointer-events-none absolute left-[12px] top-[12px] z-30 flex items-center gap-[8px] rounded-nav bg-stage/90 px-[12px] py-[7px] text-small text-stage-ink ring-1 ring-inset ring-white/15"
                  aria-hidden
                >
                  <BookmarkIcon />
                  {markNote.text}
                </span>
              ) : null}

              {/* Paused: one large way back in. A phone's bar already has its
                  play button right below, and the frame is too low for both. */}
              {!playing && !waiting && isVideo && sourceUrl && !failed && duration > 0 && !flash ? (
                <button
                  type="button"
                  aria-label="Abspielen"
                  onClick={toggle}
                  className="press absolute hidden h-[68px] w-[68px] place-items-center rounded-pill bg-stage/80 text-stage-ink ring-1 ring-inset ring-white/15 transition-[transform,background-color] duration-[var(--dur-fast)] hover:scale-105 hover:bg-stage sm:grid"
                >
                  <span className="translate-x-[2px]">
                    <PlayIcon size={28} />
                  </span>
                </button>
              ) : null}

              {fetching && fetching.id === current.id ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-[14px] bg-stage p-[24px] text-center" role="status">
                  {fetching.problem ? (
                    <>
                      <p className="text-body font-semibold">Aus Google Drive nicht geladen</p>
                      <p className="max-w-[46ch] text-small leading-[1.5] text-stage-muted">{fetching.problem}</p>
                      <button
                        type="button"
                        onClick={() => {
                          // The website's sign-in opens within this click; then the file again.
                          if (fetching.signIn) void connectDrive().then((ok) => ok && setRemoteTry((value) => value + 1))
                          else setRemoteTry((value) => value + 1)
                        }}
                        className="press rounded-nav bg-stage-ink px-[16px] py-[10px] text-small font-semibold text-stage hover:bg-stage-accent"
                      >
                        {fetching.signIn ? 'Drive anmelden' : 'Erneut versuchen'}
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="text-body font-semibold">
                        Lädt aus Google Drive
                        {fetching.fraction !== null ? <span className="value ml-[10px] text-stage-muted">{Math.round(fetching.fraction * 100)} %</span> : null}
                      </p>
                      <div className="h-[4px] w-full max-w-[300px] overflow-hidden rounded-pill bg-stage-line" aria-hidden>
                        <div className="h-full rounded-pill bg-stage-accent transition-[width] duration-[var(--dur-fast)]" style={{ width: `${(fetching.fraction ?? 0) * 100}%` }} />
                      </div>
                      <p className="max-w-[46ch] text-small leading-[1.5] text-stage-muted">
                        Dieser Browser kann nicht direkt aus Drive streamen; die Datei kommt deshalb ganz, bevor sie spielt.
                      </p>
                    </>
                  )}
                </div>
              ) : waiting ? (
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
                        className="press rounded-nav bg-stage-ink px-[16px] py-[10px] text-small font-semibold text-stage hover:bg-stage-accent"
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
                      <div className="h-[4px] w-full max-w-[300px] overflow-hidden rounded-pill bg-stage-line" aria-hidden>
                        <div className="h-full rounded-pill bg-stage-accent transition-[width] duration-[var(--dur-fast)]" style={{ width: `${version.fraction * 100}%` }} />
                      </div>
                      {known ? <p className="max-w-[46ch] text-small leading-[1.5] text-stage-muted">{STAND_TEXT[version.remedy].why(known)}</p> : null}
                      <button type="button" onClick={stopJob} className="press rounded-nav px-[14px] py-[8px] text-small ring-1 ring-inset ring-stage-line hover:bg-stage-soft">
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
                    className="press pointer-events-auto shrink-0 rounded-nav bg-stage/80 px-[12px] py-[8px] text-small ring-1 ring-inset ring-white/15 hover:bg-stage"
                  >
                    Zurück zur Seite <span className="value text-white/60">Esc</span>
                  </button>
                ) : null}
              </div>
            ) : null}

            {resume !== null && !waiting ? (
              <div className={`pop absolute left-[12px] z-10 flex items-center gap-[2px] rounded-nav bg-stage/90 p-[4px] text-small text-stage-ink ring-1 ring-inset ring-white/10 ${immersive ? 'top-[64px]' : 'top-[12px]'}`}>
                <button
                  type="button"
                  onClick={() => {
                    seek(resume)
                    setResume(null)
                    void video()?.play().catch(() => undefined)
                  }}
                  className="press rounded-[7px] px-[10px] py-[6px] hover:bg-white/10"
                >
                  Weiter bei <span className="value">{clock(resume)}</span>
                </button>
                <button type="button" onClick={() => setResume(null)} className="press rounded-[7px] px-[10px] py-[6px] text-stage-muted hover:bg-white/10 hover:text-stage-ink">
                  Von vorn
                </button>
              </div>
            ) : null}

            {version?.reason === 'chosen' && version.error && !version.started ? (
              <div
                className={`pop absolute right-[12px] z-10 flex max-w-[calc(100%-24px)] items-center gap-[10px] rounded-nav bg-stage/90 py-[4px] pl-[12px] pr-[4px] text-small text-stage-ink ring-1 ring-inset ring-white/10 ${immersive ? 'top-[64px]' : 'top-[12px]'}`}
                role="alert"
              >
                <span className="truncate">
                  {version.height ? `${version.height}p` : 'Tonspur'} nicht möglich: {version.error}
                </span>
                <button type="button" onClick={() => dropVersion(current.id)} className="press shrink-0 rounded-[7px] px-[10px] py-[6px] text-stage-muted hover:bg-white/10 hover:text-stage-ink">
                  Schliessen
                </button>
              </div>
            ) : null}

            {making && version?.reason === 'chosen' ? (
              <div
                className={`pop absolute right-[12px] z-10 flex items-center gap-[10px] rounded-nav bg-stage/90 py-[4px] pl-[12px] pr-[4px] text-small text-stage-ink ring-1 ring-inset ring-white/10 ${immersive ? 'top-[64px]' : 'top-[12px]'}`}
                role="status"
              >
                <span>
                  {version.height ? `${version.height}p wird erstellt` : 'Tonspur wird umgestellt'} <span className="value text-stage-muted">{Math.round(version.fraction * 100)} %</span>
                </span>
                <button type="button" onClick={stopJob} className="press rounded-[7px] px-[10px] py-[6px] text-stage-muted hover:bg-white/10 hover:text-stage-ink">
                  Abbrechen
                </button>
              </div>
            ) : null}

            {/* Over an episode: past the opening at its start, on to the next in
                the credits. Above the controls while they show, low otherwise. */}
            {settings.skipOpening &&
            isVideo &&
            !menuOpen &&
            // Heard: exactly while it plays, as often as it is reached. Not
            // heard: the first minutes, once, by the length set.
            (introSpan
              ? time >= introSpan.start - 1 && time < introSpan.end - 2
              : !introFinding && openingDone !== current.id && openingOffered(time, duration, opening)) ? (
              <button
                type="button"
                onClick={skipOpening}
                className={`pop absolute right-[12px] z-30 flex items-baseline gap-[8px] rounded-nav bg-stage/90 px-[14px] py-[9px] text-small font-semibold text-stage-ink ring-1 ring-inset ring-white/15 hover:bg-stage sm:right-[16px] ${
                  controlsShown ? 'bottom-[92px]' : 'bottom-[20px]'
                }`}
              >
                Vorspann überspringen
                <span className="value font-normal text-stage-muted">{minutesSeconds(introSpan ? Math.max(0, introSpan.end - time) : opening)}</span>
              </button>
            ) : settings.skipOpening && isVideo && !menuOpen && index < items.length - 1 && nextOffered(time, duration) ? (
              <button
                type="button"
                onClick={() => goTo(1)}
                title={items[index + 1]?.name}
                className={`pop absolute right-[12px] z-30 flex items-center gap-[6px] rounded-nav bg-stage/90 px-[14px] py-[9px] text-small font-semibold text-stage-ink ring-1 ring-inset ring-white/15 hover:bg-stage sm:right-[16px] ${
                  controlsShown ? 'bottom-[92px]' : 'bottom-[20px]'
                }`}
              >
                Nächste Folge
                <NextIcon />
              </button>
            ) : null}

            {/* The controls, over a scrim that keeps them legible on any picture. */}
            <div
              className={`absolute inset-x-0 bottom-0 z-20 flex flex-col gap-[2px] px-[10px] pb-[6px] pt-[56px] transition-opacity duration-[var(--dur-base)] sm:px-[16px] sm:pb-[10px] ${
                controlsShown ? 'opacity-100' : 'pointer-events-none opacity-0'
              }`}
              style={{ background: 'linear-gradient(to top, rgb(0 0 0 / 0.78), rgb(0 0 0 / 0.38) 55%, transparent)' }}
            >
              <SeekBar time={time} duration={duration} buffered={buffered} loopA={loopA} loopB={loopB} marks={marks} onSeek={seek} />
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
                      style={{ '--color-ink': 'var(--color-stage-ink)', width: 80, marginLeft: 6 } as CSSProperties}
                    />
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setRemaining((value) => !value)}
                  title="Zwischen Laufzeit und Restzeit wechseln"
                  className="press value ml-[2px] shrink-0 whitespace-nowrap rounded-pill px-[8px] py-[6px] text-small text-white hover:bg-white/10"
                >
                  {remaining ? `−${clock(Math.max(0, duration - time))}` : clock(time)}
                  <span className="text-white/70"> / {clock(duration)}</span>
                </button>

                {/* A–B: the first press marks the start, the second the end,
                    the third lets go. Two-handed practice, not an everyday
                    control — so not on a phone's narrow bar. */}
                <button
                  type="button"
                  onClick={toggleLoopAB}
                  data-own-focus
                  aria-pressed={loopA !== null && loopB !== null}
                  title={
                    loopA === null
                      ? 'Schleife A–B: hier beginnen'
                      : loopB === null
                        ? `Beginnt bei ${clock(loopA)} — hier enden lassen`
                        : `Schleife ${clock(loopA)}–${clock(loopB)} — beenden`
                  }
                  className="press relative ml-[2px] hidden h-[40px] shrink-0 items-center gap-[6px] rounded-pill px-[10px] text-small text-white outline-none transition-colors duration-[var(--dur-fast)] hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white sm:flex"
                >
                  <span className="font-semibold">{loopA !== null && loopB === null ? 'A …' : 'A–B'}</span>
                  {loopA !== null ? (
                    <span className="value hidden text-white/80 lg:inline">
                      {clock(loopA)}
                      {loopB !== null ? `–${clock(loopB)}` : ''}
                    </span>
                  ) : null}
                  {loopA !== null ? (
                    <span
                      className={`absolute bottom-[5px] left-1/2 h-[3px] w-[14px] -translate-x-1/2 rounded-pill ${loopB !== null ? 'bg-stage-accent' : 'bg-white/60'}`}
                      aria-hidden
                    />
                  ) : null}
                </button>
                <Control label="Lesezeichen setzen (B)" onClick={addMark} wideOnly>
                  <BookmarkIcon />
                </Control>

                <span className="flex-1" />

                {settings.rate !== 1 ? (
                  <span className="value mr-[4px] hidden rounded-pill px-[8px] py-[2px] text-small text-white ring-1 ring-inset ring-white/30 sm:inline">{rateLabel(settings.rate)}</span>
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
                <Control
                  label={eqDrawerOpen ? 'Equalizer schliessen' : 'Equalizer (5-Band)'}
                  active={
                    eqDrawerOpen ||
                    (settings.eqEnabled &&
                      (settings.eqBand1 !== 0 ||
                        settings.eqBand2 !== 0 ||
                        settings.eqBand3 !== 0 ||
                        settings.eqBand4 !== 0 ||
                        settings.eqBand5 !== 0))
                  }
                  eqToggle="ja"
                  onClick={() => {
                    setEqDrawerOpen((open) => {
                      if (!open && menuOpen) setMenuOpen(false)
                      return !open
                    })
                  }}
                >
                  <EqIcon />
                </Control>
                <Control
                  label="Einstellungen"
                  active={menuOpen}
                  toggle="ja"
                  onClick={() =>
                    setMenuOpen((value) => {
                      if (!value && eqDrawerOpen) setEqDrawerOpen(false)
                      return !value
                    })
                  }
                >
                  <span className={`grid place-items-center transition-transform duration-[var(--dur-base)] ${menuOpen ? 'rotate-45' : ''}`}>
                    <GearIcon />
                  </span>
                </Control>
                {isVideo ? (
                  <Control label="Standbild als Cover" onClick={captureCurrentFrame} wideOnly>
                    <CameraIcon />
                  </Control>
                ) : null}
                {isVideo && canPip ? (
                  <Control label="Bild im Bild" onClick={togglePip} wideOnly>
                    <PipIcon />
                  </Control>
                ) : null}
                {APP_BRIDGE?.setAlwaysOnTop ? (
                  <Control
                    label={pinned ? 'Immer im Vordergrund beenden' : 'Immer im Vordergrund'}
                    active={pinned}
                    onClick={() => void toggleAlwaysOnTop()}
                    wideOnly
                  >
                    <PinIcon on={pinned} />
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

            {eqDrawerOpen && !menuBelow ? equalizerDrawer : null}
            {menuOpen && !menuBelow ? settingsMenu : null}
          </div>

          {/* A frame too low for the menu — a phone, a sound file — opens it
              underneath instead of squeezing it between title and controls. */}
          {eqDrawerOpen && menuBelow ? equalizerDrawer : null}
          {menuOpen && menuBelow ? settingsMenu : null}

          {/* Under the picture: what it is, and where else it can go. A sound
              file already says its name on the stage. */}
          <div className={`flex flex-wrap items-start gap-[12px] ${isVideo ? 'justify-between' : 'justify-end'}`}>
            {isVideo ? (
              <div className="flex min-w-0 flex-col gap-[4px]">
                <h2 className="truncate text-subheading font-semibold text-ink" title={current.name}>
                  {title}
                </h2>
                <p className="value text-small text-muted">{meta.join(' · ')}</p>
              </div>
            ) : null}
            <Button size="sm" variant="quiet" disabled={toEditor} onClick={() => void openInEditor()}>
              {toEditor ? 'Lädt aus Drive …' : current.kind === 'audio' ? 'Im Ton-Editor öffnen' : 'Im Video-Editor öffnen'}
            </Button>
          </div>
          <MerklisteTick name={current.name} time={time} duration={duration} enabled={settings.merkliste} />
          {sleep || sleepNote ? (
            <p role="status" className="flex flex-wrap items-baseline gap-x-[10px] gap-y-[4px] text-small text-prose">
              <span className="font-semibold text-ink">Schlaf-Timer</span>
              {sleep ? (
                <>
                  <span>
                    {'atEnd' in sleep ? '— hält am Ende dieses Titels an.' : (
                      <>
                        — hält in <span className="value">{clock(Math.max(0, (sleep.until - now) / 1000))}</span> an.
                      </>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSleep(null)}
                    className="font-semibold text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
                  >
                    Aus
                  </button>
                </>
              ) : (
                <span>— {sleepNote}</span>
              )}
            </p>
          ) : null}
          {current.size > 1.5e9 ? (
            <p className="text-small text-muted">
              Der Editor nimmt die Datei in die Sitzung und damit in den Speicher — bei{' '}
              <span className="value">{formatBytes(current.size)}</span> kann das den Tab überfordern. Abspielen liest sie von der
              Festplatte.
            </p>
          ) : null}
        </div>

        {sideBySide ? <aside className="min-w-0">{playlist}</aside> : null}
      </div>

      {!sideBySide ? playlist : null}
      {sessionRow}
      {coverPickerImage ? <CoverPickerModal image={coverPickerImage} onClose={() => setCoverPickerImage(null)} /> : null}
    </div>
    </>
  )
}
