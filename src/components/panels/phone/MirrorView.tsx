/**
 * The phone, in the page and — on a button — in a window of its own.
 *
 * In the page it is part of the tab, like any other block: the picture, the
 * phone's buttons beside it, a title with the few things to do with it. It does
 * not float and cannot be pulled around: the page's edge would be its edge, and
 * a window that moves only up and down is worse than none. The button
 * „In einem eigenen Fenster öffnen“ puts it where it can stand anywhere: a real
 * window of the operating system — a Picture-in-Picture window in Chrome and
 * Edge (a window with a title bar and nothing else: no address bar, no tabs),
 * a plain window in the Windows app. Closing that window brings the phone back
 * into the page.
 *
 * Either way the picture is one canvas, created once by the page and moved
 * between the two (the decoder draws on that very canvas). Keys go to the
 * phone while the picture has the focus — it takes the focus itself when the
 * picture starts and when the pointer comes over it, so using it is all it
 * takes to connect keyboard and mouse. Ctrl+Alt+Esc hands the keyboard back.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'

import { IN_DESKTOP_APP } from '../../../lib/desktop'
import { isHidKey } from '../../../lib/hidKeyboard'
import type { MirrorSession, PhoneKey } from '../../../lib/phoneMirror'
import { ToolIcon } from '../../panelMeta'

const RAIL = 44
const PAD = 8
/** The name of the separate window when it is a plain one: opening it again reuses it. */
const OWN_WINDOW = 'sondra-handy'

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high))

/** How high the picture stands in the page: most of the screen, never less than a phone's worth. */
const pictureHeight = () => clamp(window.innerHeight - 300, 320, 760)

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
  /** A window with an arrow leaving it: out of the page. */
  out: <path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v3a1 1 0 01-1 1H3.5a1 1 0 01-1-1V5a1 1 0 011-1h3" />,
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

/* -- the phone itself: picture, buttons, keyboard and mouse ------------------------------------- */

interface BodyProps {
  canvas: HTMLCanvasElement
  session: MirrorSession | null
  keyboard: 'uhid' | 'sdk'
  audio: 'on' | 'off' | 'unavailable'
  muted: boolean
  onMuted: (muted: boolean) => void
  onShot: () => void
  onStop: () => void
  /** Where the picture stands: its size in pixels, or `fit` to fill the room it has. */
  size: { width: number; height: number } | 'fit'
  aspect: number
  /** In a window of its own the page's buttons for the window itself are the system's. */
  own: boolean
  note: string
  /** Called with the element the canvas stands in. */
  host: (element: HTMLDivElement | null) => void
}

function PhoneBody({ canvas, session, keyboard, audio, muted, onMuted, onShot, onStop, size, aspect, own, note, host }: BodyProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [focused, setFocused] = useState(false)
  const [room, setRoom] = useState({ width: 0, height: 0 })

  // The room the picture has when it fills the window: the window's own size less the rail.
  useLayoutEffect(() => {
    const element = hostRef.current
    if (!element || size !== 'fit') return
    const measure = () => setRoom({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [size])

  const pixels =
    size === 'fit'
      ? room.width / Math.max(room.height, 1) > aspect
        ? { width: Math.round(room.height * aspect), height: room.height }
        : { width: room.width, height: Math.round(room.width / aspect) }
      : size
  useLayoutEffect(() => {
    canvas.style.display = 'block'
    canvas.style.width = `${pixels.width}px`
    canvas.style.height = `${pixels.height}px`
  }, [canvas, pixels.width, pixels.height])

  // The picture has started: take the focus, so the first key already goes to the phone.
  useEffect(() => {
    if (session) rootRef.current?.focus({ preventScroll: true })
  }, [session])

  /* -- mouse ----------------------------------------------------------------------------------- */

  const dragging = useRef(false)
  const at = (event: ReactPointerEvent | React.WheelEvent) => {
    const rect = canvas.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
  }
  const onDown = (event: ReactPointerEvent<HTMLDivElement>) => {
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
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    const { x, y } = at(event)
    void session?.touch('move', x, y)
  }
  const onUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    const { x, y } = at(event)
    void session?.touch('up', x, y)
  }
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const { x, y } = at(event)
    const limit = (value: number) => Math.max(-1, Math.min(1, value))
    void session?.scroll(x, y, limit(-event.deltaX / 100), limit(-event.deltaY / 100))
  }

  /* -- keyboard: while the window has the focus, every key is the phone's ----------------------- */

  const forward = (event: React.KeyboardEvent<HTMLDivElement>, down: boolean) => {
    // Only the window itself: a focused button inside it keeps Enter and Space.
    if (event.target !== event.currentTarget || !session) return
    if (down && event.ctrlKey && event.altKey && event.code === 'Escape') {
      event.preventDefault()
      event.currentTarget.blur()
      return
    }
    const usable =
      keyboard === 'uhid'
        ? isHidKey(event.code)
        : event.key.length === 1 || event.key.startsWith('Arrow') || ['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)
    if (!usable) return
    event.preventDefault()
    event.stopPropagation()
    void session.sendKey({ code: event.code, key: event.key, down, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey })
  }

  const press = (key: PhoneKey) => void session?.key(key)
  const sound = audio !== 'unavailable' && audio !== 'off'

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label="Handy"
      tabIndex={session ? 0 : -1}
      onKeyDown={(event) => forward(event, true)}
      onKeyUp={(event) => forward(event, false)}
      onFocus={(event) => event.target === event.currentTarget && setFocused(true)}
      onBlur={(event) => {
        if (event.target !== event.currentTarget) return
        setFocused(false)
        void session?.releaseKeys()
      }}
      onPointerEnter={() => {
        const doc = rootRef.current?.ownerDocument
        const active = doc?.activeElement
        if (doc && !rootRef.current?.contains(active ?? null) && (!active || active === doc.body)) rootRef.current?.focus({ preventScroll: true })
      }}
      className={`flex min-h-0 min-w-0 flex-col outline-none ${own ? 'h-full' : ''}`}
    >
      <div className={`flex min-h-0 gap-[8px] p-[8px] ${own ? 'flex-1' : ''}`}>
        <div
          ref={(element) => {
            hostRef.current = element
            host(element)
          }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onWheel={onWheel}
          onContextMenu={(event) => event.preventDefault()}
          className={`flex min-h-0 min-w-0 cursor-pointer touch-none items-center justify-center overflow-hidden rounded-nav bg-stage ${own ? 'flex-1' : 'shrink-0'}`}
          style={size === 'fit' ? undefined : { width: size.width, height: size.height }}
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
          {own ? (
            <>
              <span className="my-[6px] h-px w-[20px] bg-line" aria-hidden />
              {sound ? <IconButton label={muted ? 'Ton einschalten' : 'Ton ausschalten'} icon={muted ? 'mute' : 'sound'} onClick={() => onMuted(!muted)} /> : null}
              <IconButton label="Bildschirmfoto speichern" icon="camera" onClick={onShot} />
              <IconButton label="Beenden" icon="close" onClick={onStop} />
            </>
          ) : null}
        </div>
      </div>

      <p className="flex items-center gap-[8px] px-[12px] pb-[10px] text-micro leading-[1.4] text-muted" role="status">
        <span className={`h-[8px] w-[8px] shrink-0 rounded-pill ${focused ? 'bg-ink' : 'bg-rule'}`} aria-hidden />
        <span className="min-w-0">
          {note ||
            (focused
              ? `Tastatur verbunden (${keyboard === 'uhid' ? 'USB-Tastatur' : 'Eingabe'}) · Strg+Alt+Esc gibt sie zurück`
              : 'Ins Fenster klicken, dann gehen alle Tasten ans Handy')}
        </span>
      </p>
    </div>
  )
}

/* -- the view ---------------------------------------------------------------------------------- */

export interface MirrorViewProps {
  /** The one canvas the picture is drawn on; made by the page. */
  canvas: HTMLCanvasElement
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
  /** Told when the phone is in a window of its own and when it is back. */
  onOwnWindow: (open: boolean) => void
}

type PictureInPicture = { requestWindow(options?: { width?: number; height?: number }): Promise<Window> }

/** A copy of the page's look for a new window: the same sheets, the same theme. */
function dress(win: Window, fresh: boolean): HTMLElement {
  const doc = win.document
  // A plain window starts as „about:blank“ without a doctype; a Picture-in-Picture
  // window is a finished empty page already.
  if (!fresh) {
    doc.open()
    doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
    doc.close()
  }
  const base = doc.createElement('base')
  base.href = document.baseURI
  doc.head.appendChild(base)
  for (const attribute of [...document.documentElement.attributes]) doc.documentElement.setAttribute(attribute.name, attribute.value)
  doc.body.className = document.body.className
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) doc.head.appendChild(node.cloneNode(true))
  doc.body.style.margin = '0'
  const root = doc.createElement('div')
  root.style.height = '100vh'
  doc.body.appendChild(root)
  return root
}

export function MirrorView({ canvas, session, name, shape, keyboard, audio, muted, onMuted, onStop, onShot, onOwnWindow }: MirrorViewProps) {
  const aspect = shape.width / shape.height
  const [height, setHeight] = useState(pictureHeight)
  const [own, setOwn] = useState<{ win: Window; root: HTMLElement } | null>(null)
  const [note, setNote] = useState('')
  const [pageHost, setPageHost] = useState<HTMLDivElement | null>(null)
  const [ownHost, setOwnHost] = useState<HTMLDivElement | null>(null)
  const visible = Boolean(session)

  useLayoutEffect(() => {
    const onResize = () => setHeight(pictureHeight())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // The canvas stands in the page or in the window of its own.
  useLayoutEffect(() => {
    const target = own ? ownHost : pageHost
    if (target && canvas.parentNode !== target) target.appendChild(canvas)
  }, [canvas, own, ownHost, pageHost, visible])

  /* -- a window of its own ------------------------------------------------------------------- */

  const open = useCallback(async () => {
    if (own) {
      own.win.focus()
      return
    }
    const room = clamp(window.screen.availHeight - 200, 420, 780)
    const width = Math.round(room * aspect) + RAIL + PAD * 3
    const tall = room + 64
    let win: Window | null = null
    let fresh = false
    // Chrome and Edge: Picture-in-Picture for pages is a window with a title bar and
    // nothing else, which can be put anywhere on the desktop. The app (no address bar
    // in its windows anyway) and older browsers get a plain window.
    const pip = (window as unknown as { documentPictureInPicture?: PictureInPicture }).documentPictureInPicture
    if (pip && !IN_DESKTOP_APP) {
      try {
        win = await pip.requestWindow({ width, height: tall })
        fresh = true
      } catch {
        win = null
      }
    }
    if (!win) {
      win = window.open('', OWN_WINDOW, `popup=yes,width=${width},height=${tall + 40},left=${Math.max(0, window.screen.availWidth - width - 60)},top=40`)
    }
    if (!win) {
      // Not a failure of ours: the browser's own block on a window nobody asked for.
      setNote('Der Browser hat das neue Fenster blockiert. Erlauben Sie Pop-ups für diese Seite und versuchen Sie es noch einmal.')
      window.setTimeout(() => setNote(''), 8000)
      return
    }
    const opened = win
    const root = dress(opened, fresh)
    opened.document.title = name ? `Handy ${name}` : 'Handy'
    opened.addEventListener('pagehide', () => setOwn((current) => (current?.win === opened ? null : current)))
    opened.focus()
    setOwn({ win: opened, root })
    onOwnWindow(true)
  }, [aspect, name, onOwnWindow, own])

  // Back in the page: the window was closed.
  useEffect(() => {
    if (!own) onOwnWindow(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [own])

  // The phone is gone, or this page is: the window goes with it.
  useEffect(() => {
    if (!visible && own) own.win.close()
  }, [visible, own])
  useEffect(() => () => own?.win.close(), [own])
  useEffect(() => {
    const close = () => own?.win.close()
    window.addEventListener('pagehide', close)
    return () => window.removeEventListener('pagehide', close)
  }, [own])

  const width = Math.round(height * aspect) + RAIL + PAD * 3
  const common = { canvas, session, keyboard, audio, muted, onMuted, onShot, onStop, aspect, note }

  return (
    <>
      {own
        ? createPortal(
            <div className="flex h-full flex-col bg-raised text-ink">
              <PhoneBody {...common} own size="fit" host={setOwnHost} />
            </div>,
            own.root,
          )
        : null}

      {visible ? (
        <section
          aria-label={name ? `Handy ${name}` : 'Handy'}
          style={{ width: own ? undefined : width }}
          className="flex min-w-0 max-w-full flex-col self-start rounded-card bg-panel-soft ring-1 ring-inset ring-line/70"
        >
          <div className="flex h-[44px] shrink-0 items-center gap-[8px] border-b border-line pl-[12px] pr-[6px]">
            <span className="text-ink">
              <ToolIcon>{ICON.phone}</ToolIcon>
            </span>
            <span className="min-w-0 flex-1 truncate text-small font-semibold text-ink">{name || 'Handy'}</span>
            {own ? null : (
              <span className="flex items-center gap-[2px]">
                {audio !== 'unavailable' && audio !== 'off' ? (
                  <IconButton label={muted ? 'Ton einschalten' : 'Ton ausschalten'} icon={muted ? 'mute' : 'sound'} onClick={() => onMuted(!muted)} />
                ) : null}
                <IconButton label="Bildschirmfoto speichern" icon="camera" onClick={onShot} />
                <IconButton label="In einem eigenen Fenster öffnen" icon="out" onClick={() => void open()} />
                <IconButton label="Beenden" icon="close" onClick={onStop} />
              </span>
            )}
          </div>
          {own ? (
            <div className="flex flex-col items-start gap-[12px] p-[16px]">
              <p className="max-w-[40ch] text-small leading-[1.55] text-prose">
                Das Handy steht in einem eigenen Fenster. Schließen Sie es, bringt das Handy zurück in diese Seite.
              </p>
              <button
                type="button"
                onClick={() => own.win.close()}
                className="press rounded-nav bg-raised px-[12px] py-[8px] text-small font-medium text-ink ring-1 ring-inset ring-rule hover:bg-panel-soft"
              >
                Zurück in die Seite
              </button>
            </div>
          ) : (
            <PhoneBody {...common} own={false} size={{ width: Math.round(height * aspect), height }} host={setPageHost} />
          )}
        </section>
      ) : null}
    </>
  )
}
