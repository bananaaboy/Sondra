/**
 * The picture editor.
 *
 * This used to be a form: a preview on top and every control in the tool
 * underneath it, in one column, all the time. Cropping meant dragging a
 * rectangle you could not adjust afterwards; checking a colour change meant
 * scrolling back up; and the twenty settings that had nothing to do with what
 * you were doing right now were on screen anyway.
 *
 * Now it is an editor. The picture holds the middle of the screen and never
 * moves. The rail on the left says what you are doing — crop, straighten,
 * size, colour, sharpness, export — and the column on the right holds the
 * controls for that one thing and nothing else. Everything is live: there is
 * no "apply", because the picture on the stage already *is* the result, drawn
 * by the very same code that writes the file.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { saveBytes } from '../../lib/download'
import { formatBytes } from '../../lib/format'
import {
  DEFAULT_IMAGE_OPS,
  IMAGE_FORMATS,
  extensionFor,
  outputSize,
  paintImage,
  processImage,
  readImage,
  rotatedSize,
  type ImageFormat,
  type ImageOps,
} from '../../lib/image'
import { createZip } from '../../lib/zip'
import { useActiveAssetOfKind, useAssetsOfKind, useSession } from '../../state/store'
import { FileDrop } from '../FileDrop'
import { IMAGE_ACCEPT } from '../../hooks/useIngest'
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
  IconBatch,
  IconColor,
  IconCrop,
  IconExport,
  IconSharpen,
  IconSize,
  IconTransform,
} from '../editor/icons'
import { Button, Notice, Progress, Slider, TextInput, Toggle } from '../ui/primitives'

type ToolId = 'crop' | 'transform' | 'size' | 'color' | 'sharpen' | 'export' | 'batch'

const WIDTH_PRESETS = [
  { value: 0, label: 'Original' },
  { value: 3840, label: '4K' },
  { value: 1920, label: '1920' },
  { value: 1280, label: '1280' },
  { value: 800, label: '800' },
  { value: 400, label: '400' },
]

const ZOOMS = [0.25, 0.5, 1, 2, 4]

/* -------------------------------------------------------------------------- */

/** Decodes the selected file once and keeps the bitmap until it changes. */
function useBitmap(bytes: Uint8Array | null, mime: string) {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!bytes) {
      setBitmap(null)
      return
    }
    let cancelled = false
    let created: ImageBitmap | null = null
    setError(null)
    void readImage(bytes, mime)
      .then((next) => {
        if (cancelled) {
          next.close()
          return
        }
        created = next
        setBitmap((previous) => {
          // An ImageBitmap holds its pixels outside the JavaScript heap, so the
          // garbage collector is in no hurry about it. Close the old one.
          previous?.close()
          return next
        })
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
      created?.close()
    }
  }, [bytes, mime])

  return { bitmap, error }
}

/** The size the preview should be drawn at, given the room and the zoom. */
function fitted(
  output: { width: number; height: number },
  box: { width: number; height: number },
  zoom: number | 'fit',
) {
  if (box.width <= 0 || box.height <= 0) return { width: 0, height: 0, factor: 1 }
  const fit = Math.min(box.width / output.width, box.height / output.height, 1)
  const factor = zoom === 'fit' ? fit : zoom
  return {
    width: Math.max(1, Math.round(output.width * factor)),
    height: Math.max(1, Math.round(output.height * factor)),
    factor,
  }
}

function outputName(name: string, mime: string): string {
  const stem = name.replace(/\.[^.]+$/, '')
  return `${stem}.${extensionFor(mime)}`
}

/* -------------------------------------------------------------------------- */

export function ImagePanel() {
  const asset = useActiveAssetOfKind('image')
  const images = useAssetsOfKind('image')
  const addAsset = useSession((state) => state.addAsset)
  const log = useSession((state) => state.log)

  const { bitmap, error: decodeError } = useBitmap(asset?.bytes ?? null, asset?.mime ?? '')

  const [ops, setOps] = useState<ImageOps>(DEFAULT_IMAGE_OPS)
  const [tool, setTool] = useState<ToolId>('crop')
  const [aspect, setAspect] = useState('free')
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [compare, setCompare] = useState(false)

  // Undo is a list of whole settings objects. They are small, there are never
  // many, and the alternative — an inverse operation per control — is a class
  // of bug you can only find by trying every pair of edits in both orders.
  const [history, setHistory] = useState<ImageOps[]>([DEFAULT_IMAGE_OPS])
  const [step, setStep] = useState(0)

  const [result, setResult] = useState<{ bytes: Uint8Array; mime: string; width: number; height: number } | null>(
    null,
  )
  const [encoding, setEncoding] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })

  /* -- a new file starts a new document ----------------------------------- */
  useEffect(() => {
    setOps(DEFAULT_IMAGE_OPS)
    setHistory([DEFAULT_IMAGE_OPS])
    setStep(0)
    setAspect('free')
    setZoom('fit')
    setResult(null)
    setFailure(null)
  }, [asset?.id])

  /* -- how much room the stage has ---------------------------------------- */
  // Keyed on whether there is a picture at all: the stage only exists once
  // one is open. With an empty dependency list this ran once, against the
  // drop zone, found no stage, and never measured again — so a picture opened
  // in the tool was decoded, sized and then drawn at zero pixels.
  const hasPicture = Boolean(asset)
  useLayoutEffect(() => {
    const node = stageRef.current
    if (!node) return
    const measure = () => setBox({ width: node.clientWidth - 32, height: node.clientHeight - 32 })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasPicture])

  /* -- the picture on screen ----------------------------------------------- */
  // While the crop tool is open the stage has to show what is being thrown
  // away as well as what is being kept, so the crop is left out of the paint
  // and the overlay draws it instead.
  const cropping = tool === 'crop'
  const previewOps = useMemo<ImageOps>(
    () => (cropping ? { ...ops, crop: null, width: 0 } : compare ? { ...DEFAULT_IMAGE_OPS, format: ops.format } : ops),
    [ops, cropping, compare],
  )

  const frame = bitmap ? rotatedSize(bitmap, previewOps.rotate) : { width: 1, height: 1 }
  const painted = bitmap ? outputSize(bitmap, previewOps) : { width: 1, height: 1 }
  const display = fitted(painted, box, zoom)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !bitmap || display.width === 0) return
    // Draw at the size it is shown at, not at 24 megapixels: the redraw runs on
    // every slider tick and nobody can see the difference on a 700-pixel stage.
    // A little headroom so a zoom step does not look soft before the redraw.
    const budget = Math.max(display.width, display.height) * Math.min(2, window.devicePixelRatio || 1)
    try {
      paintImage(bitmap, previewOps, canvas, budget)
      setFailure(null)
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    }
  }, [bitmap, previewOps, display.width, display.height])

  /* -- the real file, measured rather than estimated ------------------------ */
  useEffect(() => {
    if (!bitmap) return
    setEncoding(true)
    const timer = window.setTimeout(() => {
      void processImage(bitmap, ops)
        .then((next) => {
          setResult(next)
          setFailure(null)
        })
        .catch((cause: unknown) => setFailure(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setEncoding(false))
    }, 400)
    return () => {
      window.clearTimeout(timer)
      setEncoding(false)
    }
  }, [bitmap, ops])

  /* -- undo ---------------------------------------------------------------- */
  // Recorded on a pause rather than on every change: dragging a slider is one
  // edit in the user's head, and should be one press of Ctrl+Z.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setHistory((previous) => {
        const current = previous[step]
        if (current && JSON.stringify(current) === JSON.stringify(ops)) return previous
        const next = [...previous.slice(0, step + 1), ops].slice(-40)
        setStep(next.length - 1)
        return next
      })
    }, 500)
    return () => window.clearTimeout(timer)
  }, [ops, step])

  const undo = useCallback(() => {
    setStep((current) => {
      const next = Math.max(0, current - 1)
      setOps(history[next])
      return next
    })
  }, [history])

  const redo = useCallback(() => {
    setStep((current) => {
      const next = Math.min(history.length - 1, current + 1)
      setOps(history[next])
      return next
    })
  }, [history])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  /* -- actions -------------------------------------------------------------- */
  const patch = (next: Partial<ImageOps>) => setOps((current) => ({ ...current, ...next }))

  const setCrop = (rect: Rect) =>
    patch({ crop: rect.width >= 0.999 && rect.height >= 0.999 ? null : rect })

  const chooseAspect = (id: string) => {
    setAspect(id)
    const entry = ASPECTS.find((option) => option.id === id)
    if (!entry || entry.ratio === null) return
    setCrop(rectForAspect(entry.ratio, frame.width / frame.height, ops.crop ?? undefined))
  }

  // The crop turns with the picture rather than being thrown away by it.
  const turn = (degrees: 90 | 270) =>
    patch({
      rotate: ((ops.rotate + degrees) % 360) as ImageOps['rotate'],
      crop: ops.crop ? rotateRect(ops.crop, degrees) : null,
    })

  const mirror = (axis: 'h' | 'v') =>
    patch({
      [axis === 'h' ? 'flipH' : 'flipV']: !(axis === 'h' ? ops.flipH : ops.flipV),
      crop: ops.crop ? mirrorRect(ops.crop, axis) : null,
    })

  const save = () => {
    if (!result || !asset) return
    saveBytes(result.bytes, outputName(asset.name, result.mime), result.mime)
    log('bilder', `${outputName(asset.name, result.mime)} gespeichert (${formatBytes(result.bytes.byteLength)})`)
  }

  const keep = () => {
    if (!result || !asset) return
    const name = outputName(asset.name, result.mime)
    addAsset({
      name,
      bytes: result.bytes,
      mime: result.mime,
      sizeBytes: result.bytes.byteLength,
      kind: 'image',
      audio: null,
      durationSeconds: null,
      origin: 'derived',
    })
    log('bilder', `${name} in die Sitzung übernommen (${formatBytes(result.bytes.byteLength)})`)
  }

  /**
   * The same settings over every picture in the session.
   *
   * The crop is deliberately left out: it is a rectangle drawn on one specific
   * picture, and applying it to a batch of differently shaped ones produces
   * nonsense. Everything else — size, orientation, colour, format — is a rule
   * rather than a gesture and travels fine.
   */
  const runBatch = async () => {
    if (images.length === 0) return
    setBusy('Stapel läuft')
    setBatch({ done: 0, total: images.length })
    const files: { name: string; bytes: Uint8Array }[] = []
    let before = 0
    let after = 0
    try {
      for (const [index, entry] of images.entries()) {
        const source = await readImage(entry.bytes, entry.mime)
        const produced = await processImage(source, { ...ops, crop: null })
        source.close()
        files.push({ name: outputName(entry.name, produced.mime), bytes: produced.bytes })
        before += entry.sizeBytes
        after += produced.bytes.byteLength
        setBatch({ done: index + 1, total: images.length })
      }
      saveBytes(createZip(files.map((file) => ({ name: file.name, data: file.bytes }))), 'bilder.zip', 'application/zip')
      log('bilder', `${files.length} Bilder verarbeitet — ${formatBytes(before)} → ${formatBytes(after)}`)
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
      setBatch(null)
    }
  }

  /* -- nothing to edit ------------------------------------------------------ */
  if (!asset) {
    return (
      <div className="flex flex-col gap-[16px]">
        <FileDrop accept={IMAGE_ACCEPT} prompt="Bild hierher ziehen — Foto, Grafik, Bildschirmfoto" />
        <p className="text-center text-small text-muted">
          JPEG, PNG, WebP, GIF und meist auch AVIF und HEIC. Alles wird hier im Tab gerechnet.
        </p>
      </div>
    )
  }

  /* -- the rail ------------------------------------------------------------- */
  const changed = (test: (value: ImageOps) => boolean) => test(ops)
  const tools: EditorTool[] = [
    { id: 'crop', label: 'Ausschnitt', icon: IconCrop, touched: changed((o) => o.crop !== null) },
    {
      id: 'transform',
      label: 'Drehen',
      icon: IconTransform,
      touched: changed((o) => o.rotate !== 0 || o.flipH || o.flipV),
    },
    { id: 'size', label: 'Größe', icon: IconSize, touched: changed((o) => o.width > 0) },
    {
      id: 'color',
      label: 'Farbe',
      icon: IconColor,
      touched: changed((o) => o.brightness !== 1 || o.contrast !== 1 || o.saturation !== 1),
    },
    { id: 'sharpen', label: 'Schärfe', icon: IconSharpen, touched: changed((o) => o.sharpen > 0 || o.blur > 0) },
    { id: 'export', label: 'Speichern', icon: IconExport },
    ...(images.length > 1 ? [{ id: 'batch' as const, label: 'Stapel', icon: IconBatch }] : []),
  ]

  const target = outputSize(bitmap ?? ({ width: 1, height: 1 } as ImageBitmap), ops)
  const ratio = ASPECTS.find((entry) => entry.id === aspect)?.ratio ?? null

  return (
    <div className="flex flex-col gap-[16px]">
      <EditorShell
        title={asset.name}
        subtitle={
          bitmap
            ? `${bitmap.width} × ${bitmap.height} px · ${formatBytes(asset.sizeBytes)} → ${target.width} × ${target.height} px${
                result ? ` · ${formatBytes(result.bytes.byteLength)}` : ''
              }`
            : 'wird geöffnet …'
        }
        actions={
          <>
            <IconButton label="Rückgängig (Strg+Z)" onClick={undo} disabled={step === 0}>
              <svg viewBox="0 0 20 20" className="h-[17px] w-[17px]" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M7 5L3.5 8.5 7 12M3.5 8.5H12a4.5 4.5 0 010 9h-1" />
              </svg>
            </IconButton>
            <IconButton label="Wiederholen (Strg+Umschalt+Z)" onClick={redo} disabled={step >= history.length - 1}>
              <svg viewBox="0 0 20 20" className="h-[17px] w-[17px]" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M13 5l3.5 3.5L13 12M16.5 8.5H8a4.5 4.5 0 000 9h1" />
              </svg>
            </IconButton>
            <IconButton
              label="Alles zurücksetzen"
              onClick={() => setOps({ ...DEFAULT_IMAGE_OPS, format: ops.format, quality: ops.quality })}
            >
              <svg viewBox="0 0 20 20" className="h-[17px] w-[17px]" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 10a6 6 0 106-6 6 6 0 00-4.6 2.2M5.4 3.4v2.9h2.9" />
              </svg>
            </IconButton>
            <Button size="sm" onClick={save} disabled={!result} className="ml-[8px]">
              Speichern
            </Button>
          </>
        }
        tools={tools}
        tool={tool}
        onTool={(id) => setTool(id as ToolId)}
        stage={
          <div ref={stageRef} className="absolute inset-[16px] flex items-center justify-center overflow-auto">
            {decodeError ? (
              <p className="max-w-[40ch] text-center text-small leading-[1.55] text-stage-muted">{decodeError}</p>
            ) : (
              <div
                className="relative shrink-0"
                style={{ width: display.width || undefined, height: display.height || undefined }}
              >
                <canvas
                  ref={canvasRef}
                  className="block h-full w-full rounded-[2px] elevate-lift"
                />
                {cropping && bitmap ? (
                  <CropOverlay
                    rect={ops.crop ?? FULL_RECT}
                    onChange={setCrop}
                    sourceAspect={frame.width / frame.height}
                    ratio={ratio}
                  />
                ) : null}
              </div>
            )}
          </div>
        }
        stageOverlay={
          <>
            <IconButton
              label="Kleiner"
              onStage
              onClick={() =>
                setZoom((current) => {
                  const now = current === 'fit' ? display.factor : current
                  return ZOOMS.filter((value) => value < now - 0.01).pop() ?? ZOOMS[0]
                })
              }
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                <path d="M5 10h10" />
              </svg>
            </IconButton>
            <button
              type="button"
              onClick={() => setZoom('fit')}
              className="value press px-[8px] py-[4px] text-small text-stage-ink hover:bg-stage-line"
              title="Einpassen"
            >
              {zoom === 'fit' ? 'Passend' : `${Math.round(display.factor * 100)} %`}
            </button>
            <IconButton
              label="Größer"
              onStage
              onClick={() =>
                setZoom((current) => {
                  const now = current === 'fit' ? display.factor : current
                  return ZOOMS.find((value) => value > now + 0.01) ?? ZOOMS[ZOOMS.length - 1]
                })
              }
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                <path d="M10 5v10M5 10h10" />
              </svg>
            </IconButton>
            <span className="mx-[2px] h-[18px] w-px bg-stage-line" aria-hidden />
            {/* Held down rather than toggled: a comparison you have to switch
                off again is one you forget you switched on. */}
            <button
              type="button"
              onPointerDown={() => setCompare(true)}
              onPointerUp={() => setCompare(false)}
              onPointerLeave={() => setCompare(false)}
              onKeyDown={(event) => event.key === ' ' && setCompare(true)}
              onKeyUp={() => setCompare(false)}
              disabled={cropping}
              className="press px-[8px] py-[4px] text-small text-stage-ink hover:bg-stage-line disabled:opacity-35"
              title="Gedrückt halten für das Original"
            >
              {compare ? 'Original' : 'Vergleichen'}
            </button>
          </>
        }
        inspector={
          <Inspector
            tool={tool}
            ops={ops}
            patch={patch}
            aspect={aspect}
            chooseAspect={chooseAspect}
            turn={turn}
            mirror={mirror}
            frame={frame}
            target={target}
            source={bitmap ? { width: bitmap.width, height: bitmap.height } : null}
            result={result}
            encoding={encoding}
            onSave={save}
            onKeep={keep}
            images={images.length}
            batch={batch}
            busy={busy}
            onBatch={() => void runBatch()}
          />
        }
        status={
          <>
            <span>
              {encoding ? 'wird gerechnet …' : result ? `${formatBytes(result.bytes.byteLength)} fertig` : '—'}
            </span>
            {result && asset.sizeBytes > 0 ? (
              <span className="value">
                {Math.round((result.bytes.byteLength / asset.sizeBytes) * 100)} % der Quelle
              </span>
            ) : null}
            <span className="ml-auto">Läuft auf diesem Gerät</span>
          </>
        }
      />

      {failure ? (
        <Notice tone="error" title="Nicht gelungen">
          {failure}
        </Notice>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* The right-hand column                                                       */
/* -------------------------------------------------------------------------- */

function Inspector({
  tool,
  ops,
  patch,
  aspect,
  chooseAspect,
  turn,
  mirror,
  frame,
  target,
  source,
  result,
  encoding,
  onSave,
  onKeep,
  images,
  batch,
  busy,
  onBatch,
}: {
  tool: ToolId
  ops: ImageOps
  patch: (next: Partial<ImageOps>) => void
  aspect: string
  chooseAspect: (id: string) => void
  turn: (degrees: 90 | 270) => void
  mirror: (axis: 'h' | 'v') => void
  frame: { width: number; height: number }
  target: { width: number; height: number }
  source: { width: number; height: number } | null
  result: { bytes: Uint8Array; mime: string; width: number; height: number } | null
  encoding: boolean
  onSave: () => void
  onKeep: () => void
  images: number
  batch: { done: number; total: number } | null
  busy: string | null
  onBatch: () => void
}) {
  if (tool === 'crop') {
    return (
      <>
        <ToolHeading title="Ausschnitt" hint="Am Rahmen ziehen, oder ein Seitenverhältnis wählen." />
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
        <ToolHeading title="Drehen und spiegeln" hint="Vierteldrehungen — verlustfrei, nichts wird neu berechnet." />
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

  if (tool === 'size') {
    return (
      <>
        <ToolHeading title="Größe" hint="Die Höhe folgt dem Seitenverhältnis." />
        <ChoiceRow
          value={ops.width}
          columns={3}
          onChange={(value) => patch({ width: value })}
          options={WIDTH_PRESETS.map((entry) => ({ value: entry.value, label: entry.label }))}
        />
        <label className="flex items-center gap-[8px]">
          <TextInput
            type="number"
            min={1}
            max={20000}
            value={ops.width || ''}
            placeholder={String(frame.width)}
            onChange={(event) => patch({ width: Math.max(0, Number(event.target.value) || 0) })}
            className="w-[110px]"
          />
          <span className="text-small text-muted">px breit</span>
        </label>
        <div className="value rounded-nav bg-panel-soft px-[12px] py-[8px] text-small text-prose">
          {target.width} × {target.height} px
          {source && target.width > frame.width ? (
            <span className="mt-[4px] block text-muted">
              Größer als die Quelle — das erfindet keine Details dazu.
            </span>
          ) : null}
        </div>
      </>
    )
  }

  if (tool === 'color') {
    const untouched = ops.brightness === 1 && ops.contrast === 1 && ops.saturation === 1
    return (
      <>
        <ToolHeading title="Farbe" hint="Wirkt sofort auf der Bühne." />
        <Slider
          label="Helligkeit"
          min={0.2}
          max={2}
          step={0.01}
          value={ops.brightness}
          display={`${Math.round(ops.brightness * 100)} %`}
          onChange={(event) => patch({ brightness: Number(event.target.value) })}
        />
        <Slider
          label="Kontrast"
          min={0.2}
          max={2}
          step={0.01}
          value={ops.contrast}
          display={`${Math.round(ops.contrast * 100)} %`}
          onChange={(event) => patch({ contrast: Number(event.target.value) })}
        />
        <Slider
          label="Sättigung"
          min={0}
          max={2}
          step={0.01}
          value={ops.saturation}
          display={ops.saturation === 0 ? 'Schwarzweiß' : `${Math.round(ops.saturation * 100)} %`}
          onChange={(event) => patch({ saturation: Number(event.target.value) })}
        />
        <div className="grid grid-cols-2 gap-[4px]">
          <Button size="sm" variant="quiet" onClick={() => patch({ saturation: 0 })}>
            Schwarzweiß
          </Button>
          <Button
            size="sm"
            variant="quiet"
            disabled={untouched}
            onClick={() => patch({ brightness: 1, contrast: 1, saturation: 1 })}
          >
            Zurücksetzen
          </Button>
        </div>
      </>
    )
  }

  if (tool === 'sharpen') {
    return (
      <>
        <ToolHeading title="Schärfe" hint="Schärfen hebt Kanten an, Weichzeichnen glättet sie." />
        <Slider
          label="Schärfen"
          min={0}
          max={1.5}
          step={0.05}
          value={ops.sharpen}
          display={ops.sharpen === 0 ? 'aus' : ops.sharpen.toFixed(2)}
          onChange={(event) => patch({ sharpen: Number(event.target.value) })}
        />
        <Slider
          label="Weichzeichnen"
          min={0}
          max={12}
          step={0.5}
          value={ops.blur}
          display={ops.blur === 0 ? 'aus' : `${ops.blur} px`}
          onChange={(event) => patch({ blur: Number(event.target.value) })}
        />
        <p className="text-small leading-[1.45] text-muted">
          In der Vorschau wirkt Schärfen etwas stärker als in der Datei: der Filter arbeitet dort auf
          weniger Pixeln.
        </p>
      </>
    )
  }

  if (tool === 'batch') {
    return (
      <>
        <ToolHeading
          title={`Stapel — ${images} Bilder`}
          hint="Dieselben Einstellungen auf alle Bilder der Sitzung, Ergebnis als ZIP."
        />
        <Notice tone="info">
          Der gezogene Ausschnitt bleibt außen vor — ein Rahmen, der auf diesem Bild passt, passt
          selten auf das nächste. Größe, Drehung, Farbe und Format gelten für alle.
        </Notice>
        {batch ? <Progress value={batch.done / batch.total} label={`${batch.done} von ${batch.total}`} /> : null}
        <Button onClick={onBatch} disabled={busy !== null}>
          {busy ? 'Läuft …' : 'Alle verarbeiten und als ZIP laden'}
        </Button>
      </>
    )
  }

  const format = IMAGE_FORMATS.find((entry) => entry.id === ops.format) ?? IMAGE_FORMATS[0]
  return (
    <>
      <ToolHeading title="Speichern" hint={format.hint} />
      <ChoiceRow
        value={ops.format}
        columns={3}
        onChange={(value) => patch({ format: value as ImageFormat })}
        options={IMAGE_FORMATS.map((entry) => ({ value: entry.id, label: entry.label }))}
      />
      {format.lossy ? (
        <Slider
          label="Qualität"
          min={0.3}
          max={1}
          step={0.01}
          value={ops.quality}
          display={`${Math.round(ops.quality * 100)} %`}
          onChange={(event) => patch({ quality: Number(event.target.value) })}
        />
      ) : (
        <p className="text-small text-muted">PNG ist verlustfrei — es gibt nichts einzustellen.</p>
      )}
      <div className="value rounded-nav bg-panel-soft px-[12px] py-[8px] text-small text-prose">
        {encoding ? 'wird gerechnet …' : result ? formatBytes(result.bytes.byteLength) : '—'}
        <span className="mt-[4px] block text-muted">
          {result ? `${result.width} × ${result.height} px` : 'gemessen, nicht geschätzt'}
        </span>
      </div>
      <div className="flex flex-col gap-[8px]">
        <Button onClick={onSave} disabled={!result}>
          Datei speichern
        </Button>
        <Button variant="quiet" size="sm" onClick={onKeep} disabled={!result}>
          In die Sitzung übernehmen
        </Button>
      </div>
      {/* A fact about the chosen format, not a setting — so it is written as
          one. A switch you cannot move is a worse way to say this. */}
      <p className="text-small leading-[1.45] text-muted">
        {ops.format === 'jpeg'
          ? 'JPEG kann keine Transparenz: durchsichtige Stellen werden weiß.'
          : 'Durchsichtige Stellen bleiben durchsichtig.'}
      </p>
    </>
  )
}
