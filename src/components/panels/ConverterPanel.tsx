/**
 * Format conversion through FFmpeg WASM.
 *
 * The exact command is shown before it runs. That is partly a convenience for
 * people who know FFmpeg, and partly the point of the app: you can see there is
 * no network call in it.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import {
  BITRATES,
  buildConvertArgs,
  findFormat,
  OUTPUT_FORMATS,
  previewCommand,
  rateFor,
  sampleRatesFor,
  VIDEO_PRESETS,
} from '../../lib/convert'
import { saveBytes } from '../../lib/download'
import { loadFfmpeg, onFfmpegProgress, runFfmpeg, sanitize } from '../../lib/ffmpegClient'
import { formatBytes, withExtension } from '../../lib/format'
import { holdScreenAwake } from '../../lib/wakeLock'
import { createZip } from '../../lib/zip'
import { formatTimecode } from '../../lib/format'
import { decodeWithBrowser } from '../../lib/audio'
import { useDecodedAudio } from '../../hooks/useDecodedAudio'
import { kindFromMime, useActiveAsset, useSession } from '../../state/store'
import type { AssetKind } from '../../state/store'
import { AudioPreview } from '../AudioPreview'
import { BatchFiles, useBatchSelection } from '../BatchFiles'
import { FileDrop } from '../FileDrop'
import {
  ArrowRight,
  Button,
  Card,
  SectionHead,
  Field,
  Notice,
  Progress,
  Reveal,
  Select,
  Slider,
  Stat,
  Toggle,
} from '../ui/primitives'

/** The extension a file already carries, for the badge on the left. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : '—'
}

/**
 * One side of the conversion, as a block you can read at a glance.
 *
 * The format is the big word, because that is the thing being changed and the
 * thing someone is here to check. The file name sits under it, truncated from
 * the front is wrong for names that differ at the end, so it truncates at the
 * end with the full name in `title`.
 */
function FormatBlock({
  badge,
  name,
  meta,
  measured = false,
  strong = false,
  selectable = false,
  open = false,
  className = '',
}: {
  badge: string
  name: string
  meta: string
  /** The meta line holds figures the machine found, so it is set in Courier. */
  measured?: boolean
  strong?: boolean
  /** Draws the chevron that says this block is the thing you change. */
  selectable?: boolean
  /** Turns the chevron over while the list is showing. */
  open?: boolean
  className?: string
}) {
  return (
    <div
      className={`flex min-w-0 flex-col gap-[4px] rounded-card p-[16px] ${
        strong ? 'bg-ink text-on-ink' : 'bg-panel-mid'
      } ${className}`}
    >
      <span
        className={`flex items-center justify-between gap-[8px] value text-subheading leading-[1.1] ${
          strong ? 'text-on-ink' : 'text-ink'
        }`}
      >
        <span className="truncate">{badge}</span>
        {selectable ? (
          <svg
            viewBox="0 0 16 16"
            aria-hidden
            className={`h-4 w-4 shrink-0 transition-transform duration-[var(--dur-fast)] ${
              open ? 'rotate-180' : ''
            }`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 6.5l4 4 4-4" />
          </svg>
        ) : null}
      </span>
      <span
        title={name}
        className={`truncate text-small ${strong ? 'text-on-ink/90' : 'text-prose'}`}
      >
        {name}
      </span>
      {/* `prose`, not `muted`: on this tint `muted` measured APCA Lc 59.3 in
          the dark theme against a Lc 60 floor for secondary text — the same
          trap the tool tiles fell into. The separation from the file name
          above comes from the typeface instead, which is the honest one here:
          a size and a duration were measured, a format's description was not. */}
      <span
        className={`text-small ${measured ? 'value' : ''} ${
          strong ? 'text-on-ink/70' : 'text-prose'
        }`}
      >
        {meta}
      </span>
    </div>
  )
}

interface TargetFormat {
  id: string
  label: string
  hint: string
}

/**
 * The target block, which opens its own list of formats.
 *
 * A listbox written out rather than a native `<select>`, because the one
 * thing a `<select>` will not let anyone style is the part that opens — and
 * that part is what is looked at while choosing. Everything the native
 * control gave away for free is therefore rebuilt on purpose: roles and
 * `aria-activedescendant` for the screen reader, arrows and Home/End to move,
 * Enter or Space to take, Escape to leave it as it was, letters to jump, a
 * click anywhere else to dismiss, and focus handed back to the block.
 */
function FormatPicker({
  value,
  groups,
  onChange,
  badge,
  name,
  meta,
  measured,
}: {
  value: string
  groups: { label: string; formats: TargetFormat[] }[]
  onChange: (id: string) => void
  badge: string
  name: string
  meta: string
  measured: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(value)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: '', at: 0 })

  /* Flat order is what the arrow keys walk; the groups are only a heading. */
  const flat = useMemo(() => groups.flatMap((group) => group.formats), [groups])

  useEffect(() => {
    if (open) setActive(value)
  }, [open, value])

  /* Keep the highlighted row in view when the keyboard walks past the edge. */
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector(`[data-id="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  /* A click anywhere else closes it. `pointerdown` rather than `click` so the
     list is gone before the thing underneath reacts. */
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const close = (restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  const commit = (id: string) => {
    onChange(id)
    close()
  }

  const step = (delta: number) => {
    const index = flat.findIndex((f) => f.id === active)
    const next = flat[Math.min(flat.length - 1, Math.max(0, (index === -1 ? 0 : index) + delta))]
    if (next) setActive(next.id)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        setOpen(true)
      }
      return
    }
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        close()
        break
      case 'ArrowDown':
        event.preventDefault()
        step(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        step(-1)
        break
      case 'Home':
        event.preventDefault()
        if (flat[0]) setActive(flat[0].id)
        break
      case 'End':
        event.preventDefault()
        if (flat.length) setActive(flat[flat.length - 1].id)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        commit(active)
        break
      case 'Tab':
        close(false)
        break
      default: {
        // Type-ahead: letters typed in quick succession jump to a label.
        if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return
        const now = Date.now()
        typed.current = {
          text: now - typed.current.at > 900 ? event.key : typed.current.text + event.key,
          at: now,
        }
        const hit = flat.find((f) => f.label.toLowerCase().startsWith(typed.current.text.toLowerCase()))
        if (hit) setActive(hit.id)
      }
    }
  }

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="zielformat-liste"
        aria-label="Zielformat"
        aria-activedescendant={open ? `zielformat-${active}` : undefined}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={onKeyDown}
        className="block w-full text-left"
      >
        <FormatBlock
          badge={badge}
          name={name}
          meta={meta}
          measured={measured}
          strong
          selectable
          open={open}
          className="h-full transition-colors duration-[var(--dur-fast)] hover:bg-ink-hover"
        />
      </button>

      {open ? (
        <div
          ref={listRef}
          id="zielformat-liste"
          role="listbox"
          aria-label="Zielformat"
          className="rise elevate-lift absolute left-0 right-0 top-[calc(100%+4px)] z-30 max-h-[320px] overflow-y-auto rounded-card bg-raised ring-1 ring-inset ring-rule"
        >
          {groups.map((group) => (
            <div key={group.label}>
              {/* Only worth a heading when there is more than one group — a
                  video has „Video" and „Nur den Ton behalten", audio has one. */}
              {groups.length > 1 ? (
                <div className="border-t border-line bg-panel-mid px-[12px] py-[6px] text-small font-semibold text-ink first:border-t-0">
                  {group.label}
                </div>
              ) : null}
              {group.formats.map((format) => {
                const chosen = format.id === value
                const highlighted = format.id === active
                return (
                  <div
                    key={format.id}
                    id={`zielformat-${format.id}`}
                    data-id={format.id}
                    role="option"
                    aria-selected={chosen}
                    onPointerEnter={() => setActive(format.id)}
                    onClick={() => commit(format.id)}
                    /* The highlight is `panel-soft`, not `panel-mid`: on
                       `panel-mid` the hint measured APCA Lc 59.3 in the dark
                       theme against a Lc 60 floor — the third time that exact
                       pairing has come up short in this design. On
                       `panel-soft` it is 60.7, and the group headings take
                       `panel-mid` so the two still read apart. */
                    className={`flex cursor-pointer items-baseline gap-[8px] border-t border-line px-[12px] py-[10px] first:border-t-0 ${
                      highlighted ? 'bg-panel-soft' : ''
                    }`}
                  >
                    {/* The mark says which one is in force; it keeps its column
                        so the labels stay on one axis. */}
                    <span className={`value w-[1ch] shrink-0 ${chosen ? 'text-ink' : 'text-transparent'}`}>
                      ●
                    </span>
                    <span className="value min-w-0 shrink-0 text-small text-ink">{format.label}</span>
                    <span className="min-w-0 flex-1 truncate text-small text-muted">{format.hint}</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * What goes in, and what comes out.
 *
 * Added because the panel changes shape with the source — audio gets audio
 * targets, a video gets both groups, an image gets sent elsewhere — and a
 * dropdown reading „MP3 — Überall abspielbar" never said which file it was
 * about. Both ends are named, so the answer to „was wird hier woraus" is on
 * the screen rather than inferred from the session list.
 *
 * The right-hand size is blank until something has actually been produced: a
 * guess here would be the one number in this app that was estimated rather
 * than measured.
 */
function Conversion({
  fromName,
  fromMeta,
  toName,
  toBadge,
  toMeta,
  toMeasured = false,
  value,
  groups,
  onChange,
}: {
  fromName: string
  fromMeta: string
  toName: string
  toBadge: string
  toMeta: string
  toMeasured?: boolean
  value: string
  groups: { label: string; formats: { id: string; label: string; hint: string }[] }[]
  onChange: (id: string) => void
}) {
  return (
    <div className="grid items-stretch gap-[8px] sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
      <FormatBlock badge={extensionOf(fromName)} name={fromName} meta={fromMeta} measured />
      <div className="flex items-center justify-center text-muted sm:px-[4px]">
        {/* Down on a phone, where the blocks stack; across on a wide screen. */}
        <svg viewBox="0 0 16 16" aria-hidden className="h-4 w-4 rotate-90 sm:rotate-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 8h11M9.5 4l4 4-4 4" />
        </svg>
        <span className="sr-only">wird zu</span>
      </div>
      {/* The target block *is* the picker, and the list it opens is drawn
          here rather than by the browser.

          It was a native `<select>` under a transparent layer first, which
          bought the phone's wheel, the keyboard and the screen reader for
          free — but the open list is chrome no stylesheet can reach, and it
          looked it. So this is a real listbox: same keyboard contract
          (arrows, Home/End, Enter, Escape, type-ahead), same roles, and a
          panel that belongs to the rest of the page. The shadow is allowed
          precisely here — it is one of the three things that genuinely float
          above the sheet. */}
      <FormatPicker
        value={value}
        groups={groups}
        onChange={onChange}
        badge={toBadge}
        name={toName}
        meta={toMeta}
        measured={toMeasured}
      />
    </div>
  )
}

interface Outcome {
  name: string
  bytes: Uint8Array
  mime: string
  sourceBytes: number
  elapsedMs: number
}

type QueueState = 'pending' | 'running' | 'done' | 'error'

interface QueueItem {
  id: string
  name: string
  state: QueueState
  outputBytes: number | null
  message?: string
}

const STATE_MARK: Record<QueueState, string> = {
  pending: '·',
  running: '▸',
  done: '✓',
  error: '✕',
}

export function ConverterPanel() {
  const asset = useActiveAsset()
  const settings = useSession((state) => state.convert)
  const setConvert = useSession((state) => state.setConvert)
  const addAsset = useSession((state) => state.addAsset)
  const setPanel = useSession((state) => state.setPanel)
  const log = useSession((state) => state.log)

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Batch mode: one settings pass applied to several files — the ones ticked
  // below, including any added for the batch in one pick.
  const [batch, setBatch] = useState(false)
  const [queue, setQueue] = useState<QueueItem[] | null>(null)
  const [archive, setArchive] = useState<Uint8Array<ArrayBuffer> | null>(null)
  // Decoded lazily from the result, so a video conversion does not pay for it.
  const [preview, setPreview] = useState<import('../../lib/wav').AudioData | null>(null)

  const format = useMemo(() => findFormat(settings.formatId), [settings.formatId])
  // What can become the target: sound from sound or video, pictures only from video.
  const batchKinds = useMemo<AssetKind[]>(() => (format.kind === 'audio' ? ['audio', 'video'] : ['video']), [format.kind])
  const selection = useBatchSelection(batchKinds)

  /**
   * What this file can sensibly become.
   *
   * The picker used to offer all ten formats whatever was open, so a PNG sat
   * in front of a target of „MP3" with a sample rate and a channel count
   * underneath it. Pressing the button then handed FFmpeg an image and asked
   * for an audio stream.
   *
   * A video may still become audio — dropping the picture is a real and
   * wanted conversion — so it keeps both groups. Audio may not become video:
   * there is no picture to invent.
   */
  const targetGroups = useMemo(() => {
    const audio = OUTPUT_FORMATS.filter((f) => f.kind === 'audio')
    if (asset?.kind === 'video') {
      return [
        { label: 'Video', formats: OUTPUT_FORMATS.filter((f) => f.kind !== 'audio') },
        { label: 'Nur den Ton behalten', formats: audio },
      ]
    }
    return [{ label: 'Audio', formats: audio }]
  }, [asset?.kind])

  const allowed = useMemo(
    () => new Set(targetGroups.flatMap((group) => group.formats.map((f) => f.id))),
    [targetGroups],
  )

  /* A target left over from the previous file is corrected rather than left to
     fail at run time: opening a WAV after an MP4 must not keep „MP4" set. */
  useEffect(() => {
    if (!asset || asset.kind === 'image') return
    if (!allowed.has(settings.formatId)) {
      setConvert({ formatId: asset.kind === 'video' ? 'mp4' : 'mp3' })
    }
  }, [asset, allowed, settings.formatId, setConvert])

  /* GIF is the one target with no audio stream at all, so every audio setting
     below is meaningless for it — as they all were for an image. */
  const targetHasAudio = format.kind === 'audio' || format.id === 'mp4' || format.id === 'webm'
  /* GIF carries no audio but does carry pictures, so it wants size and rate. */
  const targetIsMoving = format.kind === 'video' || format.id === 'gif'

  // Duration comes from a decode, which is worth doing only if the user opens
  // the trim controls — decoding a two-hour video to place a slider is absurd.
  const { audio, decode, status: decodeStatus } = useDecodedAudio(asset)
  const [trimOpen, setTrimOpen] = useState(false)
  const duration = asset?.durationSeconds ?? (audio ? audio.channels[0].length / audio.sampleRate : null)

  const command = useMemo(() => {
    if (!asset) return null
    const input = `in_${sanitize(asset.name)}`
    const output = `out.${format.extension}`
    return previewCommand(buildConvertArgs(input, output, settings))
  }, [asset, format.extension, settings])

  useEffect(() => onFfmpegProgress((fraction) => setProgress(fraction)), [])

  const convert = async () => {
    if (!asset) return
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setProgress(0)
    setError(null)
    setOutcome(null)
    setPreview(null)

    const started = performance.now()
    try {
      await loadFfmpeg()
      const inputName = `in_${sanitize(asset.name)}`
      const outputName = `out.${format.extension}`
      const args = buildConvertArgs(inputName, outputName, settings)
      log('konverter', `ffmpeg ${args.join(' ')}`)

      const { files } = await runFfmpeg({
        input: { [inputName]: asset.bytes },
        output: [outputName],
        args,
        signal: controller.signal,
      })

      const bytes = files[outputName]
      setOutcome({
        name: withExtension(asset.name, format.extension),
        bytes,
        mime: format.mime,
        sourceBytes: asset.sizeBytes,
        elapsedMs: performance.now() - started,
      })
      log('konverter', `${format.label} erzeugt — ${formatBytes(bytes.byteLength)}`)

      // Decode the output so it can be heard. A GIF has nothing to play; some
      // containers the browser writes it cannot read back, and that is worth
      // saying in the log rather than leaving the player mysteriously absent.
      setPreview(null)
      if (format.kind !== 'image') {
        try {
          setPreview(await decodeWithBrowser(bytes.slice().buffer as ArrayBuffer))
          // Decode the source as well, so the result can be compared against it
          // rather than only listened to. Cached on the asset, so this is paid
          // at most once.
          if (!audio) void decode()
        } catch (failure) {
          log(
            'konverter',
            `Vorschau nicht möglich: ${failure instanceof Error ? failure.message : String(failure)}`,
            'warn',
          )
        }
      }
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') {
        log('konverter', 'Abgebrochen', 'warn')
      } else {
        const message = failure instanceof Error ? failure.message : String(failure)
        setError(message)
        log('konverter', message, 'error')
      }
    } finally {
      setRunning(false)
      setProgress(null)
      abortRef.current = null
    }
  }

  /** Runs the current settings over every asset in the session, in order. */
  const convertBatch = async () => {
    const chosen = selection.selected
    if (chosen.length === 0) return
    const controller = new AbortController()
    abortRef.current = controller
    const releaseWakeLock = await holdScreenAwake()

    setRunning(true)
    setError(null)
    setOutcome(null)
    setArchive(null)
    setQueue(chosen.map((entry) => ({ id: entry.id, name: entry.name, state: 'pending', outputBytes: null })))

    const produced: { name: string; data: Uint8Array }[] = []
    const mark = (id: string, patch: Partial<QueueItem>) =>
      setQueue((current) => current?.map((item) => (item.id === id ? { ...item, ...patch } : item)) ?? null)

    try {
      await loadFfmpeg()
      for (const entry of chosen) {
        if (controller.signal.aborted) break
        mark(entry.id, { state: 'running' })
        const inputName = `in_${sanitize(entry.name)}`
        const outputName = `out.${format.extension}`
        try {
          const { files } = await runFfmpeg({
            input: { [inputName]: entry.bytes },
            output: [outputName],
            args: buildConvertArgs(inputName, outputName, settings),
            signal: controller.signal,
          })
          const bytes = files[outputName]
          produced.push({ name: withExtension(entry.name, format.extension), data: bytes })
          mark(entry.id, { state: 'done', outputBytes: bytes.byteLength })
        } catch (failure) {
          if (controller.signal.aborted) break
          // One bad file should not abandon the other nineteen.
          const message = failure instanceof Error ? failure.message.split('\n')[0] : String(failure)
          mark(entry.id, { state: 'error', message })
          log('konverter', `${entry.name}: ${message}`, 'error')
        }
      }

      if (produced.length > 0) {
        setArchive(createZip(produced.map((file) => ({ name: file.name, data: file.data }))))
        log('konverter', `${produced.length} von ${chosen.length} Dateien umgewandelt`)
      }
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      setError(message)
      log('konverter', message, 'error')
    } finally {
      releaseWakeLock()
      setRunning(false)
      setProgress(null)
      abortRef.current = null
    }
  }

  const isLossy = !format.lossless && format.kind !== 'image'
  const showVbr = format.id === 'mp3' || format.id === 'vorbis'

  return (
    <div className="grid max-w-[960px] grid-cols-[minmax(0,1fr)] gap-[20px]">
      <div className="flex flex-col gap-[20px]">
        <Card tone="keylime">
          <h2 className="display-md mt-[8px] mb-[12px]">In ein anderes Format bringen</h2>
          <details className="max-w-[56ch]">
            <summary className="cursor-pointer list-none text-small text-muted underline underline-offset-2 hover:text-ink">
              Wie das funktioniert
            </summary>
            <p className="mt-[8px] text-small leading-[1.6] text-prose/85">
              FFmpeg läuft als WebAssembly in einem Web Worker dieses Tabs. Die Datei wird in ein
              In-Memory-Dateisystem geschrieben, dort transkodiert und wieder ausgelesen — sie
              verlässt den Arbeitsspeicher Ihres Rechners zu keinem Zeitpunkt.
            </p>
          </details>

          {!asset ? (
            <div className="mt-[28px]">
              <FileDrop />
            </div>
          ) : asset.kind === 'image' ? (
            /* FFmpeg has no still-image target here — only GIF, which is
               pointless for a single frame. PNG, JPEG and WebP live in the
               images tool, which decodes on a canvas and shows the result
               before you save it. Saying so beats offering „MP3" for a PNG,
               which is what stood here. */
            <div className="mt-[28px] flex flex-col items-start gap-[12px]">
              <Notice tone="info">
                Dieses Werkzeug wandelt Ton und Video um. Für ein Bild macht das hier nichts
                Sinnvolles — PNG, JPEG und WebP stellt „Bildformat ändern" um, mit Vorschau.
              </Notice>
              <Button onClick={() => setPanel('images')}>
                Zu „Bildformat ändern"
                <ArrowRight />
              </Button>
            </div>
          ) : (
            <>
              <div className="mt-[28px]">
                <Conversion
                  fromName={asset.name}
                  fromMeta={[
                    formatBytes(asset.sizeBytes),
                    asset.durationSeconds ? formatTimecode(asset.durationSeconds) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  toName={withExtension(asset.name, format.extension)}
                  toBadge={format.label}
                  toMeta={
                    outcome
                      ? `${formatBytes(outcome.bytes.byteLength)} · ${Math.round(
                          (outcome.bytes.byteLength / outcome.sourceBytes) * 100,
                        )} % der Quelle`
                      : format.hint
                  }
                  toMeasured={outcome !== null}
                  value={settings.formatId}
                  groups={targetGroups}
                  onChange={(id) => setConvert({ formatId: id })}
                />
              </div>

              {/* Capped: on a wide monitor these stretched to 550px each, so a
                  menu reading „Wie Quelle" was half a metre across. The
                  conversion blocks above may use the full width — they are the
                  thing being looked at — but a form field has a natural size. */}
              <div className="mt-[20px] grid max-w-[860px] gap-[16px] sm:grid-cols-2">
                {targetHasAudio && isLossy && !showVbr ? (
                  <Field label="Audio-Bitrate">
                    <Select
                      value={settings.audioBitrateKbps}
                      onChange={(event) => setConvert({ audioBitrateKbps: Number(event.target.value) })}
                    >
                      {BITRATES.map((rate) => (
                        <option key={rate} value={rate}>
                          {rate} kbit/s
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}

                {targetHasAudio && showVbr ? (
                  <Field
                    label="Qualität"
                    hint={settings.useVariableBitrate ? 'Variable Bitrate, 0 = beste' : undefined}
                  >
                    <Select
                      value={settings.useVariableBitrate ? `q${settings.audioQuality}` : `b${settings.audioBitrateKbps}`}
                      onChange={(event) => {
                        const value = event.target.value
                        if (value.startsWith('q')) {
                          setConvert({ useVariableBitrate: true, audioQuality: Number(value.slice(1)) })
                        } else {
                          setConvert({ useVariableBitrate: false, audioBitrateKbps: Number(value.slice(1)) })
                        }
                      }}
                    >
                      <optgroup label="Variable Bitrate">
                        {[0, 2, 4, 6].map((q) => (
                          <option key={q} value={`q${q}`}>
                            VBR q{q}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Konstante Bitrate">
                        {BITRATES.map((rate) => (
                          <option key={rate} value={`b${rate}`}>
                            {rate} kbit/s
                          </option>
                        ))}
                      </optgroup>
                    </Select>
                  </Field>
                ) : null}

                {format.id === 'wav' ? (
                  <Field label="Bittiefe">
                    <Select
                      value={settings.wavBitDepth}
                      onChange={(event) =>
                        setConvert({ wavBitDepth: Number(event.target.value) as 16 | 24 | 32 })
                      }
                    >
                      <option value={16}>16 Bit PCM</option>
                      <option value={24}>24 Bit PCM</option>
                      <option value={32}>32 Bit Float</option>
                    </Select>
                  </Field>
                ) : null}

                {targetHasAudio ? (
                <Field label="Abtastrate">
                  <Select
                    value={String(rateFor(format, settings.sampleRate))}
                    onChange={(event) =>
                      setConvert({
                        sampleRate: event.target.value === 'source' ? 'source' : Number(event.target.value),
                      })
                    }
                  >
                    <option value="source">Wie Quelle</option>
                    {sampleRatesFor(format).map((rate) => (
                      <option key={rate} value={rate}>
                        {rate / 1000} kHz
                      </option>
                    ))}
                  </Select>
                </Field>
                ) : null}

                {targetHasAudio ? (
                <Field label="Kanäle">
                  <Select
                    value={String(settings.channels)}
                    onChange={(event) =>
                      setConvert({
                        channels: event.target.value === 'source' ? 'source' : (Number(event.target.value) as 1 | 2),
                      })
                    }
                  >
                    <option value="source">Wie Quelle</option>
                    <option value={1}>Mono</option>
                    <option value={2}>Stereo</option>
                  </Select>
                </Field>
                ) : null}

                {targetIsMoving ? (
                  <>
                    {format.kind === 'video' ? (
                    <Field label="Encoder-Preset" hint="Langsamer heißt kleiner bei gleicher Qualität.">
                      <Select
                        value={settings.videoPreset}
                        onChange={(event) => setConvert({ videoPreset: event.target.value })}
                      >
                        {VIDEO_PRESETS.map((preset) => (
                          <option key={preset} value={preset}>
                            {preset}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    ) : null}
                    <Field label="Höhe">
                      <Select
                        value={String(settings.videoHeight)}
                        onChange={(event) =>
                          setConvert({
                            videoHeight:
                              event.target.value === 'source' ? 'source' : Number(event.target.value),
                          })
                        }
                      >
                        <option value="source">
                          {format.id === 'gif' ? 'Wie Quelle (480p)' : 'Wie Quelle'}
                        </option>
                        {[2160, 1440, 1080, 720, 480, 360].map((height) => (
                          <option key={height} value={height}>
                            {height}p
                          </option>
                        ))}
                      </Select>
                    </Field>

                    {/* A GIF's size is decided by its frame rate as much as by
                        its height, and twelve frames is what it falls back to.
                        Hidden, that was a number nobody could reach. */}
                    {format.id === 'gif' ? (
                      <Field label="Bildrate" hint="Weniger Bilder heißt deutlich kleinere Datei.">
                        <Select
                          value={String(settings.frameRate)}
                          onChange={(event) =>
                            setConvert({
                              frameRate:
                                event.target.value === 'source' ? 'source' : Number(event.target.value),
                            })
                          }
                        >
                          <option value="source">Wie Quelle (12 fps)</option>
                          {[24, 20, 15, 12, 10, 8].map((fps) => (
                            <option key={fps} value={fps}>
                              {fps} fps
                            </option>
                          ))}
                        </Select>
                      </Field>
                    ) : null}

                    {format.kind === 'video' ? (
                    <div className="sm:col-span-2">
                      <Slider
                        label="CRF"
                        display={`${settings.videoCrf}`}
                        min={14}
                        max={40}
                        step={1}
                        value={settings.videoCrf}
                        onChange={(event) => setConvert({ videoCrf: Number(event.target.value) })}
                      />
                      <p className="mt-[8px] text-small text-muted">
                        Niedriger ist besser und größer. 18 gilt als sichtbar verlustfrei, 23 als guter
                        Kompromiss.
                      </p>
                    </div>
                    ) : null}
                  </>
                ) : null}
              </div>

              <div className="mt-[28px]">
                <Toggle
                  label="Zuschneiden"
                  hint="Nur einen Ausschnitt umwandeln. Bildgenau, weil am Ausgang gesucht wird."
                  checked={trimOpen}
                  onChange={(value) => {
                    setTrimOpen(value)
                    if (value && !duration) void decode()
                    if (!value) setConvert({ trimStartSeconds: null, trimEndSeconds: null })
                  }}
                />

                {trimOpen ? (
                  duration ? (
                    <div className="mt-[16px] grid gap-[20px] sm:grid-cols-2">
                      <Slider
                        label="Anfang"
                        display={formatTimecode(settings.trimStartSeconds ?? 0)}
                        min={0}
                        max={duration}
                        step={0.01}
                        value={settings.trimStartSeconds ?? 0}
                        onChange={(event) => {
                          const start = Number(event.target.value)
                          setConvert({
                            trimStartSeconds: start,
                            // Keep the end after the start, or ffmpeg writes nothing.
                            trimEndSeconds: Math.max(start + 0.1, settings.trimEndSeconds ?? duration),
                          })
                        }}
                      />
                      <Slider
                        label="Ende"
                        display={formatTimecode(settings.trimEndSeconds ?? duration)}
                        min={0}
                        max={duration}
                        step={0.01}
                        value={settings.trimEndSeconds ?? duration}
                        onChange={(event) => {
                          const end = Number(event.target.value)
                          setConvert({
                            trimEndSeconds: end,
                            trimStartSeconds: Math.min(end - 0.1, settings.trimStartSeconds ?? 0),
                          })
                        }}
                      />
                      <p className="value text-small text-muted sm:col-span-2">
                        Ausschnitt{' '}
                        {formatTimecode(
                          (settings.trimEndSeconds ?? duration) - (settings.trimStartSeconds ?? 0),
                        )}{' '}
                        von {formatTimecode(duration)}
                      </p>
                    </div>
                  ) : (
                    <p className="mt-[16px] text-small text-muted">
                      {decodeStatus === 'decoding' ? 'Länge wird ermittelt…' : 'Länge noch unbekannt.'}
                    </p>
                  )
                ) : null}
              </div>

              {command ? (
                <Reveal label="Welcher Befehl dabei läuft" className="mt-[20px]">
                  <pre className="whitespace-pre-wrap break-all rounded-card bg-panel-soft p-[16px] font-mono text-small leading-[1.6] text-prose">
                    <code>{command}</code>
                  </pre>
                </Reveal>
              ) : null}

              <div className="mt-[20px] flex flex-col gap-[12px]">
                <Toggle
                  label="Mehrere Dateien auf einmal"
                  hint="Dieselben Einstellungen nacheinander auf jede gewählte Datei anwenden, Ergebnis als ZIP."
                  checked={batch}
                  onChange={(value) => {
                    setBatch(value)
                    setQueue(null)
                    setArchive(null)
                  }}
                />
                {batch ? <BatchFiles selection={selection} disabled={running} /> : null}
              </div>

              <div className="mt-[20px] flex flex-wrap items-center gap-[12px]">
                <Button onClick={batch ? convertBatch : convert} disabled={running || (batch && selection.selected.length === 0)}>
                  {running
                    ? 'Läuft…'
                    : batch
                      ? `${selection.selected.length} ${selection.selected.length === 1 ? 'Datei' : 'Dateien'} umwandeln`
                      : 'Umwandeln'}
                  {!running ? <ArrowRight /> : null}
                </Button>
                {running ? (
                  <Button variant="quiet" onClick={() => abortRef.current?.abort()}>
                    Abbrechen
                  </Button>
                ) : null}
              </div>

              {running ? (
                <div className="mt-[16px]">
                  <Progress value={progress} label="Transkodierung" />
                </div>
              ) : null}
            </>
          )}
        </Card>

        {error ? (
          <Notice tone="error" title="Umwandlung fehlgeschlagen">
            <pre className="whitespace-pre-wrap font-mono text-small leading-[1.5]">{error}</pre>
          </Notice>
        ) : null}

        {queue ? (
          <Card tone="slate">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <SectionHead>Stapel</SectionHead>
              <span className="value text-small text-muted">
                {queue.filter((item) => item.state === 'done').length} von {queue.length} fertig
              </span>
            </div>

            <ul className="mt-[16px] flex flex-col gap-[8px]">
              {queue.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center gap-[12px] rounded-card bg-raised px-[16px] py-[12px]"
                >
                  <span
                    aria-hidden
                    className={`value w-[14px] shrink-0 text-center text-small ${
                      item.state === 'running' ? 'text-ink pulse-dot' : 'text-muted'
                    }`}
                  >
                    {STATE_MARK[item.state]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-body text-ink">{item.name}</span>
                  {item.outputBytes !== null ? (
                    <span className="value shrink-0 text-small text-muted">
                      {formatBytes(item.outputBytes)}
                    </span>
                  ) : null}
                  {item.message ? (
                    <span className="w-full text-small text-muted">{item.message}</span>
                  ) : null}
                </li>
              ))}
            </ul>

            {archive ? (
              <div className="mt-[20px]">
                <Button
                  onClick={() =>
                    saveBytes(archive, `sondra-${format.extension}-${queue.length}.zip`, 'application/zip')
                  }
                >
                  Alle als ZIP speichern ({formatBytes(archive.byteLength)})
                  <ArrowRight />
                </Button>
              </div>
            ) : null}
          </Card>
        ) : null}

        {outcome ? (
          <Card tone="slate">
            <SectionHead>Ergebnis</SectionHead>
            <div className="mt-[16px] grid gap-[20px] rounded-card bg-raised p-[28px] sm:grid-cols-3">
              <Stat label="Größe" value={formatBytes(outcome.bytes.byteLength)} emphasis />
              <Stat
                label="Gegenüber Quelle"
                value={`${Math.round((outcome.bytes.byteLength / outcome.sourceBytes) * 100)} %`}
                note={formatBytes(outcome.sourceBytes)}
              />
              <Stat label="Dauer" value={`${(outcome.elapsedMs / 1000).toFixed(1)} s`} />
            </div>
            {preview ? (
              <div className="mt-[16px] rounded-card bg-raised p-[16px]">
                <p className="mb-[12px] text-small font-semibold text-ink">
                  Anhören
                </p>
                <AudioPreview
                  sources={
                    audio
                      ? [
                          { id: 'result', label: format.label, audio: preview },
                          { id: 'source', label: 'Quelle', audio },
                        ]
                      : [{ id: 'result', label: format.label, audio: preview }]
                  }
                />
              </div>
            ) : null}

            <div className="mt-[16px] flex flex-wrap gap-[12px]">
              <Button onClick={() => saveBytes(outcome.bytes, outcome.name, outcome.mime)}>
                Speichern
                <ArrowRight />
              </Button>
              <Button
                variant="quiet"
                onClick={() => {
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
                  log('konverter', `${outcome.name} in die Sitzung übernommen`)
                }}
              >
                In die Sitzung übernehmen
              </Button>
            </div>
          </Card>
        ) : null}
      </div>

    </div>
  )
}
