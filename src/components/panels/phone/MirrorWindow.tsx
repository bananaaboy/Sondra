/**
 * The phone's window: a small floating window over the page, with the phone's
 * picture in it, the phone's buttons beside it, and this computer's keyboard
 * and mouse wired to it.
 *
 * It can be pulled around by its title bar and made larger or smaller at its
 * corner; where it stands and how large it is is remembered. Keys go to the
 * phone while the window has the focus — it takes the focus itself when the
 * picture starts and when the pointer comes over it, so using it is all it
 * takes to connect keyboard and mouse. Ctrl+Alt+Esc hands the keyboard back.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'

import { isHidKey } from '../../../lib/hidKeyboard'
import type { MirrorSession, PhoneKey } from '../../../lib/phoneMirror'
import { ToolIcon } from '../../panelMeta'

const STORE = 'sondra:spiegeln:fenster'
const TITLE_BAR = 44
const RAIL = 44
const PAD = 8
const MIN_HEIGHT = 240

interface Geometry {
  x: number
  y: number
  /** The picture's height in pixels; its width follows from the phone's shape. */
  h: number
}

function remembered(): Geometry | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null')
    if (saved && [saved.x, saved.y, saved.h].every((value) => typeof value === 'number' && Number.isFinite(value))) return saved
  } catch {
    /* only a preference */
  }
  return null
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high))

/** The window's width: the picture's, the rail beside it and the paddings. */
const widthFor = (height: number, aspect: number) => Math.round(height * aspect) + RAIL + PAD * 3

/** Keeps the title bar within reach: at least 80 px of the window stay on screen, and the bar never leaves the top. */
function keepInside(geometry: Geometry, aspect: number): Geometry {
  const h = clamp(geometry.h, MIN_HEIGHT, window.innerHeight - TITLE_BAR - 64)
  const width = widthFor(h, aspect)
  return { h, x: clamp(geometry.x, 80 - width, window.innerWidth - 80), y: clamp(geometry.y, 0, window.innerHeight - TITLE_BAR) }
}

function initial(aspect: number): Geometry {
  const h = clamp(Math.round(window.innerHeight * 0.62), 360, 640)
  return keepInside({ h, x: window.innerWidth - widthFor(h, aspect) - 32, y: 112 }, aspect)
}

/* -- icons: the project's own stroke set ------------------------------------------------------- */

const ICON = {
  back: <path d="M10 3L5 8l5 5" />,
  home: <path d="M2.6 7.2L8 2.6l5.4 4.6v5.6a.9.9 0 01-.9.9H3.5a.9.9 0 01-.9-.9z" />,
  recents: <path d="M3.5 3.5h9v9h-9z" />,
  volumeUp: <path d="M2 6.2v3.6h2.4L8 12.6V3.4L4.4 6.2zM10.6 5.6a3.4 3.4 0 010 4.8M12.6 3.8a6 6 0 010 8.4" />,
  volumeDown: <path d="M2 6.2v3.6h2.4L8 12.6V3.4L4.4 6.2zM10.6 5.6a3.4 3.4 0 010 4.8" />,
  power: <path d="M8 2v5.4M4.6 4.4a5 5 0 106.8 0" />,
  bell: <path d="M4.5 11V7.2a3.5 3.5 0 017 0V11l1 1.2h-9zM6.8 13.5a1.4 1.4 0 002.4 0" />,
  camera: <path d="M2 5h2.2l1-1.6h5.6l1 1.6H14v7.6H2zM8 10.8a2.1 2.1 0 100-4.2 2.1 2.1 0 000 4.2z" />,
  sound: <path d="M2 6.2v3.6h2.4L8 12.6V3.4L4.4 6.2zM10.6 5.6a3.4 3.4 0 010 4.8M12.6 3.8a6 6 0 010 8.4" />,
  mute: <path d="M2 6.2v3.6h2.4L8 12.6V3.4L4.4 6.2zM10.4 6l3.6 4M14 6l-3.6 4" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  phone: <path d="M5 1.8h6a1 1 0 011 1v10.4a1 1 0 01-1 1H5a1 1 0 01-1-1V2.8a1 1 0 011-1zM7 12h2" />,
}

function IconButton({ label, icon, onClick, active = false }: { label: string; icon: keyof typeof ICON; onClick: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`press grid h-[36px] w-[36px] shrink-0 place-items-center rounded-nav text-ink hover:bg-panel-soft focus-visible:bg-panel-soft ${active ? 'bg-panel-mid' : ''}`}
    >
      <ToolIcon>{ICON[icon]}</ToolIcon>
    </button>
  )
}

export interface MirrorWindowProps {
  canvasRef: RefObject<HTMLCanvasElement | null>
  session: MirrorSession | null
  /** The phone's name; empty while there is no picture. */
  name: string
  shape: { width: number; height: number }
  keyboard: 'uhid' | 'sdk'
  audio: 'on' | 'off' | 'unavailable'
  muted: boolean
  onMuted: (muted: boolean) => void
  onStop: () => void
  onShot: () => void
  /** Bumped by the page to bring the window back to its first place. */
  recenter: number
}

export function MirrorWindow({ canvasRef, session, name, shape, keyboard, audio, muted, onMuted, onStop, onShot, recenter }: MirrorWindowProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const aspect = shape.width / shape.height
  const [geometry, setGeometry] = useState<Geometry>(() => keepInside(remembered() ?? initial(aspect), aspect))
  const [focused, setFocused] = useState(false)
  const visible = Boolean(session)

  const place = useCallback(
    (next: Geometry) => {
      const kept = keepInside(next, aspect)
      setGeometry(kept)
      try {
        localStorage.setItem(STORE, JSON.stringify(kept))
      } catch {
        /* only a preference */
      }
    },
    [aspect],
  )

  // The phone turned, or the window of the browser changed: the picture's shape
  // and the screen's size both change what is a place the window may stand in.
  useLayoutEffect(() => {
    setGeometry((before) => keepInside(before, aspect))
    const onResize = () => setGeometry((before) => keepInside(before, aspect))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [aspect])

  useEffect(() => {
    if (recenter) place(initial(aspect))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recenter])

  // The picture has started: take the focus, so the first key already goes to the phone.
  useEffect(() => {
    if (visible) rootRef.current?.focus({ preventScroll: true })
  }, [visible])

  /* -- pulling and resizing ------------------------------------------------------------------ */

  const drag = useRef<{ kind: 'move' | 'size'; px: number; py: number; from: Geometry } | null>(null)
  const begin = (kind: 'move' | 'size') => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { kind, px: event.clientX, py: event.clientY, from: geometry }
  }
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current
    if (!current) return
    const dx = event.clientX - current.px
    const dy = event.clientY - current.py
    setGeometry(
      keepInside(
        current.kind === 'move' ? { ...current.from, x: current.from.x + dx, y: current.from.y + dy } : { ...current.from, h: current.from.h + Math.max(dy, dx / aspect) },
        aspect,
      ),
    )
  }
  const end = () => {
    if (!drag.current) return
    drag.current = null
    place(geometry)
  }

  /* -- the picture: mouse ---------------------------------------------------------------------- */

  const dragging = useRef(false)
  const at = (event: ReactPointerEvent | React.WheelEvent) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
  }
  const onDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    rootRef.current?.focus({ preventScroll: true })
    // Like scrcpy: right button is Back, middle button is Home.
    if (event.button === 2) return void session?.key('back')
    if (event.button === 1) {
      event.preventDefault()
      return void session?.key('home')
    }
    if (event.button !== 0) return
    dragging.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    const { x, y } = at(event)
    void session?.touch('down', x, y)
  }
  const onMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!dragging.current) return
    const { x, y } = at(event)
    void session?.touch('move', x, y)
  }
  const onUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!dragging.current) return
    dragging.current = false
    const { x, y } = at(event)
    void session?.touch('up', x, y)
  }
  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const { x, y } = at(event)
    const limit = (value: number) => Math.max(-1, Math.min(1, value))
    void session?.scroll(x, y, limit(-event.deltaX / 100), limit(-event.deltaY / 100))
  }

  /* -- keyboard: while the window has the focus, every key is the phone's ------------------- */

  const forward = (event: React.KeyboardEvent<HTMLDivElement>, down: boolean) => {
    // Only the window itself: a focused button inside it keeps Enter and Space.
    if (event.target !== event.currentTarget || !session) return
    if (down && event.ctrlKey && event.altKey && event.code === 'Escape') {
      event.preventDefault()
      event.currentTarget.blur()
      return
    }
    const usable = keyboard === 'uhid' ? isHidKey(event.code) : event.key.length === 1 || event.key.startsWith('Arrow') || ['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)
    if (!usable) return
    event.preventDefault()
    event.stopPropagation()
    void session.sendKey({ code: event.code, key: event.key, down, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey })
  }

  const press = (key: PhoneKey) => void session?.key(key)

  const width = widthFor(geometry.h, aspect)
  const canvasWidth = Math.round(geometry.h * aspect)

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={name ? `Handy ${name}` : 'Handy'}
      tabIndex={visible ? 0 : -1}
      onKeyDown={(event) => forward(event, true)}
      onKeyUp={(event) => forward(event, false)}
      onFocus={(event) => event.target === event.currentTarget && setFocused(true)}
      onBlur={(event) => {
        if (event.target !== event.currentTarget) return
        setFocused(false)
        void session?.releaseKeys()
      }}
      onPointerEnter={() => {
        const active = document.activeElement
        if (!rootRef.current?.contains(active) && (!active || active === document.body)) rootRef.current?.focus({ preventScroll: true })
      }}
      style={{ left: geometry.x, top: geometry.y, width }}
      className={`${visible ? 'fixed' : 'hidden'} z-40 flex flex-col rounded-card bg-raised outline-none elevate-lift ring-1 ring-inset ${focused ? 'ring-ink' : 'ring-line'}`}
    >
      {/* Title bar: the handle. Its buttons are not part of it. */}
      <div
        onPointerDown={begin('move')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        style={{ height: TITLE_BAR }}
        className="flex shrink-0 cursor-grab touch-none select-none items-center gap-[8px] border-b border-line pl-[12px] pr-[6px] active:cursor-grabbing"
      >
        <span className="text-ink">
          <ToolIcon>{ICON.phone}</ToolIcon>
        </span>
        <span className="min-w-0 flex-1 truncate text-small font-semibold text-ink">{name || 'Handy'}</span>
        <span onPointerDown={(event) => event.stopPropagation()} className="flex items-center gap-[2px]">
          {audio !== 'unavailable' && audio !== 'off' ? (
            <IconButton label={muted ? 'Ton einschalten' : 'Ton ausschalten'} icon={muted ? 'mute' : 'sound'} onClick={() => onMuted(!muted)} />
          ) : null}
          <IconButton label="Bildschirmfoto speichern" icon="camera" onClick={onShot} />
          <IconButton label="Beenden" icon="close" onClick={onStop} />
        </span>
      </div>

      <div className="flex gap-[8px] p-[8px]">
        <canvas
          ref={canvasRef}
          aria-label="Bildschirm des Handys"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onWheel={onWheel}
          onContextMenu={(event) => event.preventDefault()}
          style={{ width: canvasWidth, height: geometry.h }}
          className="block shrink-0 cursor-pointer touch-none rounded-nav bg-stage"
        />
        <div style={{ width: RAIL - PAD }} className="flex shrink-0 flex-col items-center gap-[2px]">
          <IconButton label="Zurück" icon="back" onClick={() => press('back')} />
          <IconButton label="Start" icon="home" onClick={() => press('home')} />
          <IconButton label="Übersicht der Apps" icon="recents" onClick={() => press('recents')} />
          <span className="my-[6px] h-px w-[20px] bg-line" aria-hidden />
          <IconButton label="Lauter" icon="volumeUp" onClick={() => press('volumeUp')} />
          <IconButton label="Leiser" icon="volumeDown" onClick={() => press('volumeDown')} />
          <span className="my-[6px] h-px w-[20px] bg-line" aria-hidden />
          <IconButton label="Benachrichtigungen" icon="bell" onClick={() => void session?.openNotifications()} />
          <IconButton label="Handy sperren oder aufwecken" icon="power" onClick={() => press('power')} />
        </div>
      </div>

      <p className="flex items-center gap-[8px] px-[12px] pb-[10px] text-micro leading-[1.4] text-muted" role="status">
        <span className={`h-[8px] w-[8px] shrink-0 rounded-pill ${focused ? 'bg-ink' : 'bg-rule'}`} aria-hidden />
        <span className="min-w-0">
          {focused
            ? `Tastatur verbunden (${keyboard === 'uhid' ? 'USB-Tastatur' : 'Eingabe'}) · Strg+Alt+Esc gibt sie zurück`
            : 'Ins Fenster klicken, dann gehen alle Tasten ans Handy'}
        </span>
      </p>

      {/* The corner that makes the window larger or smaller. */}
      <span
        role="separator"
        aria-label="Größe ändern"
        onPointerDown={begin('size')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        className="absolute bottom-0 right-0 h-[18px] w-[18px] cursor-nwse-resize touch-none"
      >
        <svg viewBox="0 0 18 18" className="h-full w-full text-muted" fill="none" aria-hidden>
          <path d="M16 6L6 16M16 11l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </span>
    </div>
  )
}
