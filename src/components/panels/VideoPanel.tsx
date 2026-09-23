/**
 * The video editor.
 *
 * Same complaint as the picture tool, same answer. This was a preview card
 * with a column of settings under it and a second column of "things you can
 * also do" beside it — three regions competing for the same attention, and the
 * frame you were cutting shrinking as you scrolled towards the controls.
 *
 * Now the frame owns the middle, the timeline sits directly under it where a
 * cut belongs, the rail on the left names the job, and only that job's
 * settings are on the right. The rotation, the mirror and the crop are
 * previewed live with CSS on the video element itself, so the picture on
 * screen is the picture that comes out — FFmpeg is only asked at the end.
 *
 * Every edit still lands in a single FFmpeg pass (lib/video.ts), and a cut
 * that asks for nothing else copies the streams instead of re-encoding them:
 * minutes become seconds and the picture stays bit-for-bit the original.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { saveBytes } from '../../lib/download'
import { loadFfmpeg, onFfmpegProgress, probeMedia, runFfmpeg, sanitize } from '../../lib/ffmpegClient'
import { formatBytes, formatTimecode } from '../../lib/format'
import {
  DEFAULT_VIDEO_OPS,
  VIDEO_LOOKS,
  VIDEO_PRESETS,
  buildAudioExtraction,
  buildAudioReplacement,
  buildFrameGrab,
  buildVideoJob,
  previewFilter,
  type BuiltJob,
  type VideoContainer,
  type VideoOps,
} from '../../lib/video'
import { holdScreenAwake } from '../../lib/wakeLock'
import { kindFromMime, useActiveAssetOfKind, useAssetsOfKind, useSession } from '../../state/store'
import { FileDrop } from '../FileDrop'
import {
  ASPECTS,
  CropOverlay,
  FULL_RECT,
  mirrorRect,
  rectForAspect,
  rotateRect,
  type Rect,
} from '../editor/CropOverlay'
import { ChoiceRow, EditorShell, IconButton, ToolHeading, type EditorTool } from '../editor/EditorShell'
import {
  IconColor,
  IconCrop,
  IconExport,
  IconFade,
  IconHarvest,
  IconSize,
  IconSound,
  IconSpeed,
  IconTransform,
  IconTrim,
} from '../editor/icons'
import { Button, Notice, Progress, Select, Slider, Toggle } from '../ui/primitives'

type ToolId = 'trim' | 'crop' | 'transform' | 'look' | 'fade' | 'size' | 'speed' | 'audio' | 'harvest' | 'export'

interface Outcome {
  name: string
  bytes: Uint8Array
  mime: string
  kind: 'video' | 'audio' | 'image'
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4]

function useObjectUrl(bytes: Uint8Array | null, mime: string): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!bytes) return setUrl(null)
    const view = bytes.slice()
    const next = URL.createObjectURL(new Blob([view.buffer as ArrayBuffer], { type: mime }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [bytes, mime])
  return url
}

/* -------------------------------------------------------------------------- */
/* Timeline                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The cut, made where it can be seen.
 *
 * One clip, two handles and a playhead — not a multi-track timeline, which is
 * a different piece of software, but everything a single-clip edit needs. It
 * lives directly under the picture and stays there whichever tool is open,
 * because "where does this clip start" is a question you ask while doing
 * everything else, not only while the trim tool happens to be selected.
 */
function Timeline({
  duration,
  start,
  end,
  position,
  onChange,
  onSeek,
}: {
  duration: number
  start: number
  end: number
  position: number
  onChange: (next: { start: number; end: number }) => void
  onSeek: (seconds: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [grabbing, setGrabbing] = useState<'start' | 'end' | null>(null)

  const secondsAt = useCallback(
    (clientX: number) => {
      const box = ref.current?.getBoundingClientRect()
      if (!box || duration <= 0) return 0
      return Math.min(duration, Math.max(0, ((clientX - box.left) / box.width) * duration))
    },
    [duration],
  )

  useEffect(() => {
    if (!grabbing) return
    const move = (event: PointerEvent) => {
      const at = secondsAt(event.clientX)
      // The handles are not allowed to cross; a quarter second of clip is the
      // smallest thing worth keeping.
      if (grabbing === 'start') onChange({ start: Math.min(at, end - 0.25), end })
      else onChange({ start, end: Math.max(at, start + 0.25) })
    }
    const up = () => setGrabbing(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [grabbing, secondsAt, onChange, start, end])

  const percent = (seconds: number) => (duration > 0 ? (seconds / duration) * 100 : 0)

  return (
    <div className="px-[16px] py-[12px]">
      <div
        ref={ref}
        onPointerDown={(event) => {
          if (grabbing) return
          onSeek(secondsAt(event.clientX))
        }}
        className="relative h-[46px] w-full cursor-pointer touch-none select-none overflow-hidden bg-panel-soft"
      >
        <div className="absolute inset-y-0 left-0 bg-ink/10" style={{ width: `${percent(start)}%` }} />
        <div className="absolute inset-y-0 right-0 bg-ink/10" style={{ width: `${100 - percent(end)}%` }} />
        <div
          className="absolute inset-y-0 border-y-2 border-ink/40 bg-ink/5"
          style={{ left: `${percent(start)}%`, width: `${Math.max(0, percent(end) - percent(start))}%` }}
        />

        {(['start', 'end'] as const).map((side) => (
          <div
            key={side}
            role="slider"
            aria-label={side === 'start' ? 'Anfang' : 'Ende'}
            aria-valuenow={Math.round(side === 'start' ? start : end)}
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            tabIndex={0}
            onPointerDown={(event) => {
              event.stopPropagation()
              setGrabbing(side)
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 1 : 0.1
              const delta = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0
              if (!delta) return
              event.preventDefault()
              if (side === 'start') onChange({ start: Math.min(Math.max(0, start + delta), end - 0.25), end })
              else onChange({ start, end: Math.min(duration, Math.max(end + delta, start + 0.25)) })
            }}
            className="absolute inset-y-0 z-10 w-[14px] -translate-x-1/2 cursor-ew-resize"
            style={{ left: `${percent(side === 'start' ? start : end)}%` }}
          >
            <div className="mx-auto h-full w-[4px] bg-ink" />
          </div>
        ))}

        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-[2px] bg-ink-hover"
          style={{ left: `${percent(position)}%` }}
        />
      </div>

      <div className="mt-[8px] flex items-center justify-between text-small text-muted">
        <span className="value">{formatTimecode(start)}</span>
        <span className="value text-ink">Auswahl {formatTimecode(Math.max(0, end - start))}</span>
        <span className="value">{formatTimecode(end)}</span>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

export function VideoPanel() {
  const asset = useActiveAssetOfKind('video')
  const audioAssets = useAssetsOfKind('audio')
  const addAsset = useSession((state) => state.addAsset)
  const log = useSession((state) => state.log)

  const [ops, setOps] = useState<VideoOps>(DEFAULT_VIDEO_OPS)
  const [tool, setTool] = useState<ToolId>('trim')
  const [aspect, setAspect] = useState('free')
  const [duration, setDuration] = useState(0)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [position, setPosition] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [unplayable, setUnplayable] = useState(false)
  const [probing, setProbing] = useState(false)
  const [replacement, setReplacement] = useState('')

  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })

  const patch = (next: Partial<VideoOps>) => setOps((value) => ({ ...value, ...next }))

  const sourceUrl = useObjectUrl(asset?.bytes ?? null, asset?.mime || 'video/mp4')
  const outcomeUrl = useObjectUrl(outcome?.bytes ?? null, outcome?.mime ?? 'video/mp4')

  useEffect(() => onFfmpegProgress((fraction) => setProgress(fraction)), [])

  useEffect(() => {
    setOps(DEFAULT_VIDEO_OPS)
    setOutcome(null)
    setError(null)
    setDuration(0)
    setSize(null)
    setUnplayable(false)
    setAspect('free')
    setPosition(0)
  }, [asset?.id])

  /* -- how much room the stage has ---------------------------------------- */
  useLayoutEffect(() => {
    const node = stageRef.current
    if (!node) return
    const measure = () => setBox({ width: node.clientWidth - 24, height: node.clientHeight - 24 })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  /**
   * When the browser will not decode the file, ask FFmpeg instead.
   *
   * A Chromium build without H.264 — and this is common, it is the licensed
   * codec — reports a duration of zero and no error worth the name. Every
   * control that needs a length would then sit disabled with nothing to
   * explain it. FFmpeg is already here and knows the answer.
   */
  const probedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!asset || !unplayable || duration > 0) return
    // Guarded by a ref rather than a `probing` flag: a flag this effect sets
    // itself and also depends on re-runs the effect, whose cleanup cancels the
    // run still in flight — and "läuft…" then never clears.
    if (probedRef.current === asset.id) return
    probedRef.current = asset.id
    setProbing(true)
    void probeMedia(asset.bytes, asset.name)
      .then((facts) => {
        if (facts.durationSeconds) {
          setDuration(facts.durationSeconds)
          setOps((value) => ({ ...value, end: facts.durationSeconds ?? 0 }))
        }
        if (facts.width && facts.height) setSize({ width: facts.width, height: facts.height })
      })
      .finally(() => setProbing(false))
  }, [asset, unplayable, duration])

  /* -- the frame on screen -------------------------------------------------- */
  const turned = ops.rotate === 90 || ops.rotate === 270
  const source = size ?? { width: 16, height: 9 }
  // The frame the crop is drawn on is the *straightened* one: rotation happens
  // before cropping, both here and in the filter graph.
  const frame = turned ? { width: source.height, height: source.width } : source
  const fit =
    box.width > 0 && box.height > 0
      ? Math.min(box.width / frame.width, box.height / frame.height, 1.6)
      : 0
  const display = { width: Math.round(frame.width * fit), height: Math.round(frame.height * fit) }

  const cropping = tool === 'crop'
  const selectionEnd = ops.end > 0 ? ops.end : duration

  /* -- playback ------------------------------------------------------------- */
  const seek = (seconds: number) => {
    setPosition(seconds)
    if (videoRef.current) videoRef.current.currentTime = seconds
  }

  const togglePlay = () => {
    const node = videoRef.current
    if (!node) return
    if (node.paused) {
      // Playing always plays the selection, never the parts you just cut off.
      if (node.currentTime < ops.start - 0.05 || node.currentTime > selectionEnd) node.currentTime = ops.start
      void node.play()
    } else {
      node.pause()
    }
  }

  /* -- running -------------------------------------------------------------- */
  const run = async (
    build: (input: string) => BuiltJob,
    label: string,
    kind: Outcome['kind'],
    extraInputs: Record<string, Uint8Array> = {},
  ) => {
    if (!asset) return
    const controller = new AbortController()
    abortRef.current = controller
    const release = await holdScreenAwake()
    setRunning(true)
    setProgress(0)
    setError(null)
    setOutcome(null)
    setNote(label)

    try {
      await loadFfmpeg()
      const inputName = sanitize(`in_${asset.name}`)
      const built = build(inputName)
      const output = `out.${built.extension}`

      log('video', `ffmpeg ${built.args.join(' ')} ${output}`)
      const { files } = await runFfmpeg({
        input: { [inputName]: asset.bytes, ...extraInputs },
        output: [output],
        args: [...built.args, output],
        signal: controller.signal,
      })

      const bytes = files[output]
      if (!bytes || bytes.byteLength < 1024) {
        throw new Error(
          `Es kamen nur ${bytes?.byteLength ?? 0} Bytes heraus. Meist liegt das an einem Codec, ` +
            'den dieser FFmpeg-Aufbau nicht schreiben kann — ein anderes Zielformat hilft oft.',
        )
      }
      const name = sanitize(`${asset.name.replace(/\.[^.]+$/, '')}.${built.extension}`)
      setOutcome({ name, bytes, mime: built.mime, kind })
      log('video', `${name} fertig (${formatBytes(bytes.byteLength)})`)
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') return
      const message = failure instanceof Error ? failure.message : String(failure)
      setError(message)
      log('video', message, 'error')
    } finally {
      release()
      setRunning(false)
      setProgress(null)
      setNote(null)
      abortRef.current = null
    }
  }

  const keep = () => {
    if (!outcome) return
    addAsset({
      name: outcome.name,
      bytes: outcome.bytes,
      mime: outcome.mime,
      sizeBytes: outcome.bytes.byteLength,
      kind: kindFromMime(outcome.mime, outcome.name),
      audio: null,
      durationSeconds: null,
      origin: 'derived',
    })
    log('video', `${outcome.name} in die Sitzung übernommen`)
  }

  const setCrop = (rect: Rect) =>
    patch({ crop: rect.width >= 0.999 && rect.height >= 0.999 ? null : rect })

  const chooseAspect = (id: string) => {
    setAspect(id)
    const entry = ASPECTS.find((option) => option.id === id)
    if (!entry || entry.ratio === null) return
    setCrop(rectForAspect(entry.ratio, frame.width / frame.height, ops.crop ?? undefined))
  }

  const preview = useMemo(
    () =>
      buildVideoJob(ops, sanitize(`in_${asset?.name ?? 'video'}`), duration || 0, size).args.join(' '),
    [ops, asset?.name, duration, size],
  )

  /* -- nothing to edit ------------------------------------------------------ */
  if (!asset) {
    return (
      <div className="flex flex-col gap-[16px]">
        <FileDrop />
        <p className="text-center text-small text-muted">
          MP4, MOV, MKV, WebM und AVI. Gerechnet wird mit FFmpeg als WebAssembly, also auf Ihrem Gerät.
        </p>
      </div>
    )
  }

  const lookTouched =
    ops.brightness !== 0 || ops.contrast !== 1 || ops.saturation !== 1 || ops.look !== 'none' || ops.sharpen || ops.denoise || ops.stabilize
  const fadeTouched = ops.fadeIn > 0 || ops.fadeOut > 0
  const soundTouched = ops.mute || ops.volumeDb !== 0 || ops.loudnorm
  const touched =
    ops.crop !== null || ops.rotate !== 0 || ops.flipH || ops.flipV || ops.speed !== 1 || ops.reverse || lookTouched || fadeTouched || soundTouched
  const tools: EditorTool[] = [
    { id: 'trim', label: 'Schneiden', icon: IconTrim, touched: ops.start > 0 || (ops.end > 0 && ops.end < duration - 0.05) },
    { id: 'crop', label: 'Ausschnitt', icon: IconCrop, touched: ops.crop !== null },
    { id: 'transform', label: 'Drehen', icon: IconTransform, touched: ops.rotate !== 0 || ops.flipH || ops.flipV },
    { id: 'look', label: 'Bild', icon: IconColor, touched: lookTouched },
    { id: 'fade', label: 'Blenden', icon: IconFade, touched: fadeTouched },
    { id: 'size', label: 'Größe', icon: IconSize },
    { id: 'speed', label: 'Tempo', icon: IconSpeed, touched: ops.speed !== 1 || ops.reverse },
    { id: 'audio', label: 'Ton', icon: IconSound, touched: soundTouched },
    { id: 'harvest', label: 'Ernten', icon: IconHarvest },
    { id: 'export', label: 'Fertig', icon: IconExport },
  ]

  const ratio = ASPECTS.find((entry) => entry.id === aspect)?.ratio ?? null

  return (
    <div className="flex flex-col gap-[16px]">
      <EditorShell
        title={asset.name}
        subtitle={
          [
            size ? `${size.width} × ${size.height}` : probing ? 'wird geprüft …' : null,
            formatBytes(asset.sizeBytes),
            duration > 0 ? formatTimecode(duration) : null,
            touched ? 'bearbeitet' : null,
          ]
            .filter(Boolean)
            .join(' · ')
        }
        actions={
          <>
            <IconButton
              label="Alles zurücksetzen"
              onClick={() => {
                setOps({ ...DEFAULT_VIDEO_OPS, end: duration })
                setAspect('free')
              }}
            >
              <svg viewBox="0 0 20 20" className="h-[17px] w-[17px]" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 10a6 6 0 106-6 6 6 0 00-4.6 2.2M5.4 3.4v2.9h2.9" />
              </svg>
            </IconButton>
            <Button size="sm" disabled={running} onClick={() => setTool('export')} className="ml-[8px]">
              {running ? 'Läuft …' : 'Fertigstellen'}
            </Button>
          </>
        }
        tools={tools}
        tool={tool}
        onTool={(id) => setTool(id as ToolId)}
        stage={
          <div ref={stageRef} className="absolute inset-[16px] flex items-center justify-center">
            <div
              className="relative shrink-0 overflow-hidden rounded-[2px] bg-stage elevate-lift"
              style={{ width: display.width || '60%', height: display.height || 240 }}
            >
              <video
                ref={videoRef}
                src={sourceUrl ?? undefined}
                playsInline
                onLoadedMetadata={(event) => {
                  const node = event.currentTarget
                  if (Number.isFinite(node.duration) && node.duration > 0) {
                    setDuration(node.duration)
                    setOps((value) => ({ ...value, end: value.end || node.duration }))
                    setSize({ width: node.videoWidth, height: node.videoHeight })
                  } else {
                    setUnplayable(true)
                  }
                }}
                onError={() => setUnplayable(true)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTimeUpdate={(event) => {
                  const node = event.currentTarget
                  setPosition(node.currentTime)
                  // Preview the cut rather than the file: playback stops where
                  // the clip will end.
                  if (selectionEnd > 0 && node.currentTime >= selectionEnd - 0.02) {
                    node.pause()
                    node.currentTime = ops.start
                  }
                }}
                // The rotation and the mirror are shown by the browser rather
                // than computed by FFmpeg. It is the same transform, it costs
                // nothing, and it means the crop rectangle is dragged onto the
                // picture as it will actually be framed.
                className="absolute left-1/2 top-1/2 max-w-none"
                style={{
                  width: turned ? display.height : display.width,
                  height: turned ? display.width : display.height,
                  transform: `translate(-50%, -50%) rotate(${ops.rotate}deg) scale(${ops.flipH ? -1 : 1}, ${
                    ops.flipV ? -1 : 1
                  })`,
                  // Colour is previewed the same way: the browser's filter is
                  // close to FFmpeg's, and it answers while the slider moves.
                  filter: previewFilter(ops),
                }}
              />
              {cropping && display.width > 0 ? (
                <CropOverlay
                  rect={ops.crop ?? FULL_RECT}
                  onChange={setCrop}
                  sourceAspect={frame.width / frame.height}
                  ratio={ratio}
                />
              ) : null}
              {unplayable ? (
                <p className="absolute inset-0 grid place-items-center p-[16px] text-center text-small leading-[1.5] text-stage-muted">
                  Dieser Browser spielt die Datei nicht ab — der Schnitt geht trotzdem, nur ohne Bild.
                </p>
              ) : null}
            </div>
          </div>
        }
        stageOverlay={
          <>
            <IconButton label={playing ? 'Pause' : 'Abspielen'} onStage onClick={togglePlay}>
              {playing ? (
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden>
                  <rect x="5.5" y="4" width="3.2" height="12" rx="1" />
                  <rect x="11.3" y="4" width="3.2" height="12" rx="1" />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden>
                  <path d="M6.5 4.3l9 5.7-9 5.7z" />
                </svg>
              )}
            </IconButton>
            <span className="value px-[8px] text-small text-stage-ink">
              {formatTimecode(position)} / {formatTimecode(duration)}
            </span>
            <IconButton label="Ton im Vorhören" onStage active={!ops.mute} onClick={() => patch({ mute: !ops.mute })}>
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 7.5h2.8L11 4v12L6.8 12.5H4z" />
                {ops.mute ? <path d="M14 7.5l3.5 5M17.5 7.5l-3.5 5" /> : <path d="M14 7.6a3.5 3.5 0 010 4.8" />}
              </svg>
            </IconButton>
          </>
        }
        underStage={
          <Timeline
            duration={duration}
            start={ops.start}
            end={selectionEnd}
            position={position}
            onChange={({ start, end }) => patch({ start, end })}
            onSeek={seek}
          />
        }
        inspector={
          <VideoInspector
            tool={tool}
            ops={ops}
            patch={patch}
            duration={duration}
            selectionEnd={selectionEnd}
            position={position}
            frame={frame}
            aspect={aspect}
            chooseAspect={chooseAspect}
            turn={(degrees) =>
              patch({
                rotate: ((ops.rotate + degrees) % 360) as VideoOps['rotate'],
                crop: ops.crop ? rotateRect(ops.crop, degrees) : null,
              })
            }
            mirror={(axis) =>
              patch({
                [axis === 'h' ? 'flipH' : 'flipV']: !(axis === 'h' ? ops.flipH : ops.flipV),
                crop: ops.crop ? mirrorRect(ops.crop, axis) : null,
              })
            }
            running={running}
            audioAssets={audioAssets}
            replacement={replacement}
            setReplacement={setReplacement}
            run={run}
            command={preview}
          />
        }
        status={
          <>
            {running ? (
              <span className="w-[180px]">
                <Progress value={progress} label={note ?? 'läuft'} />
              </span>
            ) : (
              <span>{outcome ? `${outcome.name} — ${formatBytes(outcome.bytes.byteLength)}` : 'bereit'}</span>
            )}
            {running ? (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="press rounded-nav text-ink underline underline-offset-2"
              >
                Abbrechen
              </button>
            ) : null}
            <span className="ml-auto">Läuft auf diesem Gerät</span>
          </>
        }
      />

      {error ? (
        <Notice tone="error" title="Nicht gelungen">
          {error}
        </Notice>
      ) : null}

      {outcome ? (
        <div className="rise flex flex-col gap-[16px] rounded-card bg-raised p-[16px] ring-1 ring-inset ring-line sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Ergebnis</p>
            <p className="mt-[4px] truncate text-body text-ink">{outcome.name}</p>
            <p className="value text-small text-muted">
              {formatBytes(outcome.bytes.byteLength)}
              {asset.sizeBytes > 0 && outcome.kind === 'video'
                ? ` · ${Math.round((outcome.bytes.byteLength / asset.sizeBytes) * 100)} % der Quelle`
                : ''}
            </p>
          </div>
          {outcomeUrl && outcome.kind === 'image' ? (
            <img src={outcomeUrl} alt="" className="h-[64px] rounded-nav ring-1 ring-line" />
          ) : null}
          {outcomeUrl && outcome.kind === 'audio' ? (
            <audio src={outcomeUrl} controls className="w-full sm:w-[260px]" />
          ) : null}
          <div className="flex shrink-0 gap-[8px]">
            <Button size="sm" onClick={() => saveBytes(outcome.bytes, outcome.name, outcome.mime)}>
              Speichern
            </Button>
            <Button size="sm" variant="quiet" onClick={keep}>
              In die Sitzung
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* The right-hand column                                                       */
/* -------------------------------------------------------------------------- */

function VideoInspector({
  tool,
  ops,
  patch,
  duration,
  selectionEnd,
  position,
  frame,
  aspect,
  chooseAspect,
  turn,
  mirror,
  running,
  audioAssets,
  replacement,
  setReplacement,
  run,
  command,
}: {
  tool: ToolId
  ops: VideoOps
  patch: (next: Partial<VideoOps>) => void
  duration: number
  selectionEnd: number
  position: number
  frame: { width: number; height: number }
  aspect: string
  chooseAspect: (id: string) => void
  turn: (degrees: 90 | 270) => void
  mirror: (axis: 'h' | 'v') => void
  running: boolean
  audioAssets: { id: string; name: string; bytes: Uint8Array }[]
  replacement: string
  setReplacement: (id: string) => void
  run: (
    build: (input: string) => BuiltJob,
    label: string,
    kind: Outcome['kind'],
    extraInputs?: Record<string, Uint8Array>,
  ) => Promise<void>
  command: string
}) {
  if (tool === 'trim') {
    return (
      <>
        <ToolHeading title="Schneiden" hint="Am Balken unter dem Bild ziehen, oder hier auf den Abspielkopf setzen." />
        <div className="grid grid-cols-2 gap-[4px]">
          <Button size="sm" variant="quiet" onClick={() => patch({ start: Math.min(position, selectionEnd - 0.25) })}>
            Anfang hier
          </Button>
          <Button size="sm" variant="quiet" onClick={() => patch({ end: Math.max(position, ops.start + 0.25) })}>
            Ende hier
          </Button>
        </div>
        <div className="value rounded-nav bg-panel-soft px-[12px] py-[8px] text-small text-prose">
          {formatTimecode(ops.start)} – {formatTimecode(selectionEnd)}
          <span className="mt-[4px] block text-muted">
            {formatTimecode(Math.max(0, selectionEnd - ops.start))} von {formatTimecode(duration)}
          </span>
        </div>
        <Button
          size="sm"
          variant="quiet"
          disabled={ops.start === 0 && (ops.end === 0 || ops.end >= duration - 0.05)}
          onClick={() => patch({ start: 0, end: duration })}
        >
          Ganzes Video
        </Button>
        <p className="text-small leading-[1.45] text-muted">
          Ein reiner Schnitt kopiert die Spuren, statt sie neu zu rechnen — das dauert Sekunden statt
          Minuten und das Bild bleibt bitgenau das Original.
        </p>
      </>
    )
  }

  if (tool === 'crop') {
    return (
      <>
        <ToolHeading title="Ausschnitt" hint="Am Rahmen im Bild ziehen." />
        <ChoiceRow
          value={aspect}
          columns={3}
          onChange={chooseAspect}
          options={ASPECTS.map((entry) => ({ value: entry.id, label: entry.label }))}
        />
        <div className="value rounded-nav bg-panel-soft px-[12px] py-[8px] text-small text-prose">
          {ops.crop
            ? `${Math.round(ops.crop.width * frame.width)} × ${Math.round(ops.crop.height * frame.height)} px`
            : `Ganzes Bild — ${frame.width} × ${frame.height} px`}
        </div>
        <Button
          size="sm"
          variant="quiet"
          disabled={!ops.crop}
          onClick={() => {
            patch({ crop: null })
            chooseAspect('free')
          }}
        >
          Ausschnitt aufheben
        </Button>
      </>
    )
  }

  if (tool === 'transform') {
    return (
      <>
        <ToolHeading title="Drehen und spiegeln" hint="Für hochkant aufgenommene Handyvideos." />
        <div className="grid grid-cols-2 gap-[4px]">
          <Button size="sm" variant="quiet" onClick={() => turn(270)}>
            ↺ Links
          </Button>
          <Button size="sm" variant="quiet" onClick={() => turn(90)}>
            ↻ Rechts
          </Button>
        </div>
        <Toggle label="Waagrecht spiegeln" checked={ops.flipH} onChange={() => mirror('h')} />
        <Toggle label="Senkrecht spiegeln" checked={ops.flipV} onChange={() => mirror('v')} />
        <p className="text-small text-muted">Aktuell {ops.rotate}°.</p>
      </>
    )
  }

  if (tool === 'look') {
    const signed = (value: number) => `${value > 0 ? '+' : ''}${Math.round(value * 100)} %`
    return (
      <>
        <ToolHeading title="Bild" hint="Helligkeit, Farbe und Schärfe. Die Vorschau zeigt es sofort." />
        <Slider label="Helligkeit" min={-0.3} max={0.3} step={0.01} value={ops.brightness}
          display={signed(ops.brightness / 0.3)} onChange={(event) => patch({ brightness: Number(event.target.value) })} />
        <Slider label="Kontrast" min={0.5} max={1.8} step={0.01} value={ops.contrast}
          display={signed(ops.contrast - 1)} onChange={(event) => patch({ contrast: Number(event.target.value) })} />
        <Slider label="Sättigung" min={0} max={2.5} step={0.01} value={ops.saturation}
          display={signed(ops.saturation - 1)} onChange={(event) => patch({ saturation: Number(event.target.value) })} />
        <ToolHeading title="Look" hint="Kommt nach den Reglern dazu." />
        <ChoiceRow value={ops.look} columns={3} onChange={(value) => patch({ look: value })} options={VIDEO_LOOKS.map((entry) => ({ value: entry.id, label: entry.label }))} />
        <div className="h-px bg-line" />
        <Toggle label="Schärfen" hint="Für leicht weiche Handyaufnahmen." checked={ops.sharpen} onChange={(value) => patch({ sharpen: value })} />
        <Toggle label="Bildrauschen mindern" hint="Für dunkle Aufnahmen mit Griesel." checked={ops.denoise} onChange={(value) => patch({ denoise: value })} />
        <Toggle label="Verwackeln ausgleichen" hint="Beruhigt Aufnahmen aus der Hand. Rechnet merklich länger." checked={ops.stabilize} onChange={(value) => patch({ stabilize: value })} />
        {ops.brightness !== 0 || ops.contrast !== 1 || ops.saturation !== 1 || ops.look !== 'none' || ops.sharpen || ops.denoise || ops.stabilize ? (
          <Button size="sm" variant="ghost" onClick={() => patch({ brightness: 0, contrast: 1, saturation: 1, look: 'none', sharpen: false, denoise: false, stabilize: false })}>
            Bild zurücksetzen
          </Button>
        ) : null}
      </>
    )
  }

  if (tool === 'fade') {
    const clipLength = duration > 0 ? (selectionEnd - ops.start) / ops.speed : 0
    const most = Math.max(0.5, Math.min(10, clipLength / 2))
    return (
      <>
        <ToolHeading title="Blenden" hint="Bild aus Schwarz, Ton aus der Stille — und am Ende wieder hinein." />
        <Slider label="Einblenden" min={0} max={most} step={0.1} value={Math.min(ops.fadeIn, most)}
          display={ops.fadeIn > 0 ? `${ops.fadeIn.toFixed(1).replace('.', ',')} s` : 'aus'}
          onChange={(event) => patch({ fadeIn: Number(event.target.value) })} />
        <Slider label="Ausblenden" min={0} max={most} step={0.1} value={Math.min(ops.fadeOut, most)}
          display={ops.fadeOut > 0 ? `${ops.fadeOut.toFixed(1).replace('.', ',')} s` : 'aus'}
          onChange={(event) => patch({ fadeOut: Number(event.target.value) })} />
        <p className="text-small leading-[1.45] text-muted">
          Gemessen am fertigen Clip, also nach Schnitt und Tempo.
        </p>
      </>
    )
  }

  if (tool === 'size') {
    return (
      <>
        <ToolHeading title="Größe und Qualität" hint="Kleiner heißt hier: weniger Pixel und mehr Kompression." />
        <div className="flex flex-col gap-[4px]">
          {VIDEO_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => patch({ preset: preset.id })}
              aria-pressed={ops.preset === preset.id}
              className={`press rounded-nav px-[12px] py-[8px] text-left text-small ${
                ops.preset === preset.id
                  ? 'bg-ink text-on-ink'
                  : 'bg-panel-soft text-prose ring-1 ring-inset ring-line hover:bg-panel-mid'
              }`}
            >
              <span className="block font-semibold">{preset.label}</span>
              <span className={`block ${ops.preset === preset.id ? 'text-on-ink/75' : 'text-muted'}`}>
                {preset.hint}
              </span>
            </button>
          ))}
        </div>
        <p className="text-small leading-[1.45] text-muted">
          Kleiner als die Quelle wird nie hochskaliert — die Voreinstellung nimmt immer den kleineren
          der beiden Werte.
        </p>
      </>
    )
  }

  if (tool === 'speed') {
    return (
      <>
        <ToolHeading title="Tempo" hint="Bild und Ton bleiben zusammen; die Tonhöhe wandert mit." />
        <ChoiceRow
          value={ops.speed}
          columns={4}
          onChange={(value) => patch({ speed: value })}
          options={SPEEDS.map((speed) => ({ value: speed, label: `${speed}×` }))}
        />
        <Slider
          label="Feiner"
          min={0.25}
          max={4}
          step={0.05}
          value={ops.speed}
          display={`${ops.speed.toFixed(2)}×`}
          onChange={(event) => patch({ speed: Number(event.target.value) })}
        />
        <div className="value rounded-nav bg-panel-soft px-[12px] py-[8px] text-small text-prose">
          {duration > 0 ? formatTimecode((selectionEnd - ops.start) / ops.speed) : '—'}
          <span className="mt-[4px] block text-muted">Länge danach</span>
        </div>
        <Toggle
          label="Rückwärts abspielen"
          hint={
            duration > 90
              ? 'Braucht das ganze Stück im Speicher — bei langen Videos erst kürzen.'
              : 'Bild und Ton laufen von hinten nach vorn.'
          }
          checked={ops.reverse}
          onChange={(value) => patch({ reverse: value })}
        />
      </>
    )
  }

  if (tool === 'audio') {
    return (
      <>
        <ToolHeading title="Ton" hint="Stummschalten oder durch eine Aufnahme aus der Sitzung ersetzen." />
        <Toggle
          label="Ohne Ton speichern"
          hint="Die Tonspur fällt weg und die Datei wird spürbar kleiner."
          checked={ops.mute}
          onChange={(value) => patch({ mute: value })}
        />
        {!ops.mute ? (
          <>
            <Slider label="Lautstärke" min={-20} max={20} step={0.5} value={ops.volumeDb}
              display={ops.volumeDb === 0 ? 'unverändert' : `${ops.volumeDb > 0 ? '+' : ''}${ops.volumeDb.toFixed(1).replace('.', ',')} dB`}
              onChange={(event) => patch({ volumeDb: Number(event.target.value) })} />
            <Toggle
              label="Lautheit angleichen"
              hint="Auf −16 LUFS, wie YouTube, Instagram und die meisten Podcasts es abspielen."
              checked={ops.loudnorm}
              onChange={(value) => patch({ loudnorm: value })}
            />
          </>
        ) : null}
        <div className="h-px bg-line" />
        <ToolHeading title="Ton ersetzen" hint="Bild wird kopiert, nur der Ton wird neu geschrieben." />
        {audioAssets.length === 0 ? (
          <p className="text-small text-muted">
            In der Sitzung liegt noch keine Tonaufnahme. Öffnen Sie eine Datei, dann steht sie hier.
          </p>
        ) : (
          <>
            <Select value={replacement} onChange={(event) => setReplacement(event.target.value)}>
              <option value="">Auswählen …</option>
              {audioAssets.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              disabled={running || !replacement}
              onClick={() => {
                const chosen = audioAssets.find((entry) => entry.id === replacement)
                if (!chosen) return
                const name = sanitize(`snd_${chosen.name}`)
                void run(
                  (input) => buildAudioReplacement(input, name),
                  'Ton wird ersetzt',
                  'video',
                  { [name]: chosen.bytes },
                )
              }}
            >
              Ton ersetzen
            </Button>
          </>
        )}
      </>
    )
  }

  if (tool === 'harvest') {
    return (
      <>
        <ToolHeading
          title="Aus diesem Video"
          hint="Landet in der Sitzung und lässt sich danach mit den übrigen Werkzeugen weiterbearbeiten."
        />
        <div className="flex flex-col gap-[4px]">
          <Button size="sm" variant="quiet" disabled={running} onClick={() => void run((input) => buildAudioExtraction(input, 'copy'), 'Ton wird herausgelöst', 'audio')}>
            Ton herauslösen — unverändert
          </Button>
          <Button size="sm" variant="quiet" disabled={running} onClick={() => void run((input) => buildAudioExtraction(input, 'wav'), 'Ton wird gewandelt', 'audio')}>
            Ton als WAV
          </Button>
          <Button size="sm" variant="quiet" disabled={running} onClick={() => void run((input) => buildAudioExtraction(input, 'mp3'), 'Ton wird gewandelt', 'audio')}>
            Ton als MP3
          </Button>
          <Button size="sm" variant="quiet" disabled={running} onClick={() => void run((input) => buildFrameGrab(input, position), 'Einzelbild', 'image')}>
            Einzelbild bei {formatTimecode(position)}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            disabled={running}
            onClick={() => void run((input) => buildVideoJob({ ...ops, container: 'gif' }, input, duration, frame), 'GIF wird gebaut', 'image')}
          >
            Auswahl als GIF
          </Button>
        </div>
        <p className="text-small leading-[1.45] text-muted">
          Das GIF übernimmt Schnitt, Ausschnitt und Drehung — aber keinen Ton, und es wird auf 15
          Bilder pro Sekunde und 640 Pixel Breite gebracht.
        </p>
      </>
    )
  }

  const containers: { value: VideoContainer; label: string }[] = [
    { value: 'mp4', label: 'MP4' },
    { value: 'webm', label: 'WebM' },
    { value: 'gif', label: 'GIF' },
  ]

  return (
    <>
      <ToolHeading title="Fertigstellen" hint="Alles, was Sie eingestellt haben, in einem Durchgang." />
      <ChoiceRow
        value={ops.container}
        columns={3}
        onChange={(value) => patch({ container: value })}
        options={containers}
      />
      <p className="text-small leading-[1.45] text-muted">
        {ops.container === 'mp4'
          ? 'H.264 in MP4 — läuft überall, auch auf älteren Geräten.'
          : ops.container === 'webm'
            ? 'VP9 in WebM — kleiner bei gleicher Qualität, aber langsamer zu rechnen.'
            : 'GIF — ohne Ton, 15 Bilder pro Sekunde, für kurze Schnipsel.'}
      </p>
      <Button
        disabled={running || duration <= 0}
        onClick={() => void run((input) => buildVideoJob(ops, input, duration, frame), 'Video wird gerechnet', ops.container === 'gif' ? 'image' : 'video')}
      >
        {running ? 'Läuft …' : 'Jetzt rechnen'}
      </Button>
      <details className="group">
        <summary className="press inline-flex cursor-pointer list-none items-center gap-[8px] rounded-nav text-small text-muted hover:text-ink">
          FFmpeg-Befehl
        </summary>
        <pre className="mt-[8px] whitespace-pre-wrap break-all rounded-nav bg-panel-soft p-[8px] font-mono text-micro leading-[1.5] text-prose">
          ffmpeg {command}
        </pre>
      </details>
    </>
  )
}
