/**
 * Mirroring an Android phone: its screen here, clicks and keys back to it.
 *
 * What scrcpy does, without installing anything and with the explaining done
 * on the page: five steps to get a phone ready, one button to connect, then
 * the picture with the few buttons a phone has. The technical side is
 * `lib/phoneMirror.ts`; this file is only the words and the buttons.
 */

import { useEffect, useRef, useState } from 'react'

import {
  mirrorSupport,
  startMirror,
  MirrorError,
  type MirrorFailure,
  type MirrorQuality,
  type MirrorSession,
  type MirrorStep,
  type PhoneKey,
} from '../../lib/phoneMirror'
import { saveBytes } from '../../lib/download'
import { Button, Card, Field, Notice, Progress, Reveal, Select } from '../ui/primitives'

const SETTINGS_KEY = 'sondra:spiegeln'

function rememberedQuality(): MirrorQuality {
  try {
    return localStorage.getItem(SETTINGS_KEY) === 'sharp' ? 'sharp' : 'smooth'
  } catch {
    return 'smooth'
  }
}

const STEPS: Array<[string, string]> = [
  [
    'Entwickleroptionen einschalten',
    'Öffnen Sie am Handy die Einstellungen, dann „Über das Telefon“, und tippen Sie siebenmal auf „Build-Nummer“ (bei Samsung unter „Softwareinformationen“). Das Handy meldet: „Sie sind jetzt Entwickler“.',
  ],
  [
    'USB-Debugging einschalten',
    'Einstellungen → System → Entwickleroptionen → „USB-Debugging“ einschalten. Der Schalter erlaubt dem Computer, das Handy zu bedienen; ohne ihn sieht der Browser das Handy nicht.',
  ],
  [
    'Handy mit einem Datenkabel anschliessen',
    'Ein reines Ladekabel überträgt keine Daten. Fragt das Handy nach dem USB-Modus, wählen Sie „Dateien übertragen“.',
  ],
  ['Auf „Handy verbinden“ klicken', 'Der Browser zeigt eine Liste. Wählen Sie Ihr Handy und klicken Sie auf „Verbinden“.'],
  [
    'Auf dem Handy zulassen',
    'Das Handy fragt „USB-Debugging zulassen?“. Setzen Sie den Haken bei „Immer von diesem Computer zulassen“, dann tippen Sie auf „Zulassen“. Danach erscheint sein Bild hier.',
  ],
]

const STEP_TEXT: Record<MirrorStep, string> = {
  select: 'Wählen Sie Ihr Handy in der Liste des Browsers',
  connect: 'Verbindung zum Handy wird aufgebaut',
  allow: 'Tippen Sie jetzt am Handy auf „Zulassen“ (Haken bei „Immer von diesem Computer zulassen“ setzen)',
  push: 'Das Programm für das Bild wird aufs Handy gelegt',
  start: 'Das Bild wird gestartet',
}

const FAILURE_TEXT: Record<MirrorFailure, string> = {
  cancelled: 'Es wurde kein Handy gewählt. Klicken Sie noch einmal auf „Handy verbinden“.',
  busy: 'Ein anderes Programm benutzt das Handy gerade. Beenden Sie adb, Android Studio, scrcpy und Programme des Herstellers (etwa Smart Switch), ziehen Sie das Kabel einmal ab und versuchen Sie es noch einmal.',
  refused: 'Das Handy hat den Computer nicht zugelassen. Stecken Sie das Kabel neu ein, klicken Sie auf „Handy verbinden“ und tippen Sie am Handy auf „Zulassen“.',
  server: 'Das Handy hat das Bild nicht gestartet. Möglich ist ein sehr altes Android (gebraucht wird Android 5 oder neuer) oder ein gesperrter Bildschirm: entsperren Sie das Handy und versuchen Sie es noch einmal.',
  'server-file': 'Die mitgelieferte Datei für das Handy ist beschädigt. Laden Sie Sondra neu; bleibt es so, melden Sie es bitte.',
  unknown: 'Die Verbindung ist fehlgeschlagen. Prüfen Sie Kabel und USB-Debugging und versuchen Sie es noch einmal.',
}

const UNSUPPORTED_TEXT = {
  'android-app': 'Diese Funktion gibt es in der Android-App nicht: ein Handy kann hier kein anderes Handy spiegeln. Öffnen Sie Sondra an einem Computer.',
  'no-usb': 'Dieser Browser kann kein Handy über USB ansprechen. Öffnen Sie Sondra in Edge oder Chrome am Computer oder in der Windows-App.',
  'no-video': 'Dieser Browser kann das Bild des Handys nicht entschlüsseln. Aktualisieren Sie Edge oder Chrome und versuchen Sie es noch einmal.',
} as const

function Steps() {
  return (
    <ol className="grid gap-[16px] md:grid-cols-2 xl:grid-cols-3">
      {STEPS.map(([title, text], index) => (
        <li key={title} className="flex gap-[12px]">
          <span className="value mt-[2px] w-[20px] shrink-0 text-small text-muted">{index + 1}</span>
          <div className="min-w-0">
            <p className="text-small font-semibold text-ink">{title}</p>
            <p className="mt-[4px] text-small leading-[1.55] text-prose">{text}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}

function Help() {
  return (
    <ul className="flex max-w-[68ch] flex-col gap-[8px] text-small leading-[1.55] text-prose">
      <li>
        <span className="font-semibold text-ink">Das Handy steht nicht in der Liste.</span> Anderes Kabel und anderen USB-Anschluss
        versuchen, USB-Debugging prüfen, das Handy entsperren.
      </li>
      <li>
        <span className="font-semibold text-ink">„Ein anderes Programm benutzt das Handy“.</span> Es kann nur ein Programm zugleich auf das Handy
        zugreifen. Beenden Sie adb, Android Studio, scrcpy und Programme des Herstellers. Wer adb benutzt, gibt in der Konsole{' '}
        <code className="value">adb kill-server</code> ein.
      </li>
      <li>
        <span className="font-semibold text-ink">Windows gibt das Handy nicht frei.</span> Hier hilft meist der USB-Treiber des
        Herstellers (oder der „Google USB Driver“). Das ist ein Erfahrungswert, kein Teil der Anleitung des Browsers.
      </li>
      <li>
        <span className="font-semibold text-ink">Das Bild bleibt schwarz.</span> Banking-Apps und andere geschützte Fenster erlauben
        keine Aufnahme; Android zeigt sie hier schwarz. Das ist keine Störung.
      </li>
      <li>
        <span className="font-semibold text-ink">Der Zulassen-Dialog kommt nicht.</span> Ziehen Sie das Kabel ab, in den
        Entwickleroptionen „USB-Debugging-Autorisierungen widerrufen“ wählen und noch einmal verbinden.
      </li>
    </ul>
  )
}

const BUTTONS: Array<[PhoneKey | 'notifications', string]> = [
  ['back', 'Zurück'],
  ['home', 'Start'],
  ['recents', 'Übersicht'],
  ['volumeUp', 'Lauter'],
  ['volumeDown', 'Leiser'],
  ['power', 'Sperren / Aufwecken'],
  ['notifications', 'Benachrichtigungen'],
]

type Stage =
  | { kind: 'idle' }
  | { kind: 'working'; step: MirrorStep }
  | { kind: 'running'; name: string }

export function PhoneMirrorPanel() {
  const support = useRef(mirrorSupport()).current
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<MirrorSession | null>(null)
  const dragging = useRef(false)
  const abortRef = useRef<(() => void) | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [quality, setQuality] = useState<MirrorQuality>(rememberedQuality)
  const [failure, setFailure] = useState<{ failure: MirrorFailure; detail: string } | null>(null)
  const [ended, setEnded] = useState<string | null>(null)
  const [shape, setShape] = useState({ width: 9, height: 16 })

  // Leaving the tool lets go of the phone: the cable is the phone's, not ours.
  useEffect(
    () => () => {
      const session = sessionRef.current
      sessionRef.current = null
      void session?.stop()
      abortRef.current?.()
    },
    [],
  )

  if (!support.ok) {
    return (
      <Card tone="cream">
        <h2 className="display-md mt-[8px] mb-[12px]">Handy spiegeln</h2>
        <Notice tone="warn" title="Hier nicht möglich">
          {UNSUPPORTED_TEXT[support.why]}
        </Notice>
      </Card>
    )
  }

  const connect = async () => {
    const canvas = canvasRef.current
    if (!canvas) return
    setFailure(null)
    setEnded(null)
    setStage({ kind: 'working', step: 'select' })
    try {
      // Straight from the click: the browser opens its picker only then.
      const session = await startMirror({
        canvas,
        quality,
        onStep: (step) => setStage({ kind: 'working', step }),
        onAbort: (abort) => {
          abortRef.current = abort
        },
      })
      abortRef.current = null
      sessionRef.current = session
      setShape(session.size)
      session.onSize(setShape)
      setStage({ kind: 'running', name: session.deviceName })
      void session.closed.then((reason) => {
        if (sessionRef.current !== session) return
        sessionRef.current = null
        void session.stop()
        setEnded(reason)
        setStage({ kind: 'idle' })
      })
    } catch (error) {
      abortRef.current = null
      const known = error instanceof MirrorError ? error : new MirrorError('unknown', String(error))
      // Closing the picker is not a failure worth a message of its own beyond the hint.
      setFailure({ failure: known.failure, detail: known.detail })
      setStage({ kind: 'idle' })
    }
  }

  const stop = async () => {
    const session = sessionRef.current
    sessionRef.current = null
    setStage({ kind: 'idle' })
    await session?.stop()
  }

  const cancel = () => {
    abortRef.current?.()
  }

  const press = (what: PhoneKey | 'notifications') => {
    const session = sessionRef.current
    if (!session) return
    void (what === 'notifications' ? session.openNotifications() : session.key(what))
  }

  const shoot = async () => {
    const blob = await sessionRef.current?.screenshot()
    if (!blob) return
    const now = new Date()
    const pad = (value: number) => String(value).padStart(2, '0')
    saveBytes(blob, `Handy ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.png`, 'image/png')
  }

  // Pointer on the picture → touch on the phone. One finger, the primary
  // button; the picture is drawn in the phone's own shape, so a position in
  // the canvas is a position on the screen.
  const place = (event: React.PointerEvent | React.WheelEvent) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
  }
  const onDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    dragging.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    const { x, y } = place(event)
    void sessionRef.current?.touch('down', x, y)
  }
  const onMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging.current) return
    const { x, y } = place(event)
    void sessionRef.current?.touch('move', x, y)
  }
  const onUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging.current) return
    dragging.current = false
    const { x, y } = place(event)
    void sessionRef.current?.touch('up', x, y)
  }
  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const { x, y } = place(event)
    const clamp = (value: number) => Math.max(-1, Math.min(1, value))
    void sessionRef.current?.scroll(x, y, clamp(-event.deltaX / 100), clamp(-event.deltaY / 100))
  }

  const running = stage.kind === 'running'
  const working = stage.kind === 'working'

  return (
    <div className="flex flex-col gap-[16px]">
      <Card tone="cream">
        <h2 className="display-md mt-[8px] mb-[12px]">Handy spiegeln</h2>
        <p className="max-w-[68ch] text-small leading-[1.55] text-prose">
          Zeigt den Bildschirm Ihres Android-Handys hier. Sie klicken, wischen und tippen mit der Maus, und das Handy reagiert. Das Bild läuft nur
          über das USB-Kabel zu diesem Computer; es wird nichts hochgeladen.
        </p>

        {/* The picture. Always in the page — the picker must open straight
            from the click, and the canvas has to exist when the picture
            starts — but only seen once there is one. */}
        <div className={running ? 'mt-[20px] flex flex-col gap-[16px] lg:flex-row lg:items-start' : 'hidden'}>
          <canvas
            ref={canvasRef}
            aria-label="Bildschirm des Handys"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onWheel={onWheel}
            style={{ aspectRatio: `${shape.width} / ${shape.height}` }}
            className="max-h-[min(70vh,780px)] max-w-full touch-none cursor-pointer self-start bg-stage"
          />
          <div className="flex min-w-0 max-w-[360px] flex-col gap-[16px]">
            <p className="flex items-center gap-[10px] text-small text-prose" role="status">
              <span className="h-[10px] w-[10px] animate-pulse rounded-pill bg-ink" aria-hidden />
              Verbunden mit <span className="value text-ink">{stage.kind === 'running' ? stage.name : ''}</span>
            </p>
            <div className="grid grid-cols-2 gap-[8px]">
              {BUTTONS.map(([id, label]) => (
                <Button key={id} variant="quiet" size="sm" onClick={() => press(id)}>
                  {label}
                </Button>
              ))}
              <Button variant="quiet" size="sm" onClick={() => void shoot()}>
                Bildschirmfoto
              </Button>
            </div>
            <Button onClick={() => void stop()}>Beenden</Button>
            <p className="text-small leading-[1.55] text-muted">
              Klicken tippt, Ziehen wischt, das Mausrad scrollt. Tippen mit der Tastatur und der Ton des Handys sind noch nicht dabei. Banking-Apps
              und andere geschützte Fenster bleiben schwarz.
            </p>
          </div>
        </div>

        {!running ? (
          <>
            <div className="mt-[20px]">
              <Steps />
            </div>

            <div className="mt-[24px] grid max-w-[720px] gap-[16px] sm:grid-cols-[240px_1fr] sm:items-end">
              <Field label="Bildqualität">
                <Select
                  value={quality}
                  disabled={working}
                  onChange={(event) => {
                    const value = event.target.value === 'sharp' ? 'sharp' : 'smooth'
                    setQuality(value)
                    try {
                      localStorage.setItem(SETTINGS_KEY, value)
                    } catch {
                      /* only a preference */
                    }
                  }}
                >
                  <option value="smooth">Flüssig · empfohlen</option>
                  <option value="sharp">Scharf · Originalgrösse, mehr Last</option>
                </Select>
              </Field>
              <div className="flex flex-wrap items-center gap-[8px]">
                <Button onClick={() => void connect()} disabled={working}>
                  Handy verbinden
                </Button>
                {working ? (
                  <Button variant="quiet" onClick={cancel}>
                    Abbrechen
                  </Button>
                ) : null}
              </div>
            </div>
            {stage.kind === 'working' ? (
              <div className="mt-[16px] max-w-[560px]" role="status">
                <Progress value={null} label={STEP_TEXT[stage.step]} />
              </div>
            ) : null}
            <p className="mt-[16px] max-w-[68ch] text-small leading-[1.55] text-muted">
              Das Programm, das auf dem Handy das Bild liefert, ist scrcpy von Genymobile; es wird nur für die Dauer der Verbindung aufs Handy gelegt.
              Der Schlüssel, mit dem sich dieser Computer dem Handy ausweist, bleibt in diesem Browser.
            </p>
          </>
        ) : null}
      </Card>

      {failure && failure.failure !== 'cancelled' ? (
        <Notice tone="warn" title="Das hat nicht geklappt">
          <p>{FAILURE_TEXT[failure.failure]}</p>
          {failure.detail ? (
            <Reveal label="Technische Einzelheiten">
              <pre className="value max-h-[200px] overflow-auto whitespace-pre-wrap text-micro text-prose">{failure.detail}</pre>
            </Reveal>
          ) : null}
        </Notice>
      ) : null}
      {failure && failure.failure === 'cancelled' ? <Notice title="Kein Handy gewählt">{FAILURE_TEXT.cancelled}</Notice> : null}
      {ended ? <Notice title="Das Bild ist beendet">{ended} Klicken Sie auf „Handy verbinden“, um es wieder zu starten.</Notice> : null}

      <Card tone="mint">
        <Reveal label="Wenn es nicht klappt" defaultOpen={Boolean(failure && failure.failure !== 'cancelled')}>
          <Help />
        </Reveal>
      </Card>
    </div>
  )
}
