/**
 * Mirroring an Android phone: its screen in a window of its own, with its
 * sound, and this computer's keyboard and mouse wired to it.
 *
 * What scrcpy does, without installing anything and with the explaining done
 * on the page: five steps to get a phone ready, one button to connect, then a
 * small window that can be pulled around. The technical side is
 * `lib/phoneMirror.ts`, the window is `phone/MirrorWindow.tsx`; this file is
 * the page around them — the steps, the state of the connection, the help.
 */

import { useEffect, useRef, useState } from 'react'

import { saveBytes } from '../../lib/download'
import {
  mirrorSupport,
  startMirror,
  MirrorError,
  type MirrorFailure,
  type MirrorQuality,
  type MirrorSession,
  type MirrorStep,
} from '../../lib/phoneMirror'
import { Button, Notice, Reveal, Select, Toggle } from '../ui/primitives'
import { MirrorWindow } from './phone/MirrorWindow'

const SETTINGS_KEY = 'sondra:spiegeln'

interface Settings {
  quality: MirrorQuality
  sound: boolean
}

function rememberedSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')
    if (saved && typeof saved === 'object') return { quality: saved.quality === 'sharp' ? 'sharp' : 'smooth', sound: saved.sound !== false }
    // The first fassung stored just the word.
    if (localStorage.getItem(SETTINGS_KEY) === 'sharp') return { quality: 'sharp', sound: true }
  } catch {
    /* only a preference */
  }
  return { quality: 'smooth', sound: true }
}

const STEPS: Array<{ title: string; text: string; where: 'Am Handy' | 'Hier' }> = [
  {
    where: 'Am Handy',
    title: 'Entwickleroptionen einschalten',
    text: 'Einstellungen → „Über das Telefon“ → siebenmal auf „Build-Nummer“ tippen (bei Samsung unter „Softwareinformationen“). Das Handy meldet: „Sie sind jetzt Entwickler“.',
  },
  {
    where: 'Am Handy',
    title: 'USB-Debugging einschalten',
    text: 'Einstellungen → System → Entwickleroptionen → „USB-Debugging“. Ohne diesen Schalter sieht der Browser das Handy nicht.',
  },
  {
    where: 'Am Handy',
    title: 'Mit einem Datenkabel anschliessen',
    text: 'Ein reines Ladekabel überträgt keine Daten. Fragt das Handy nach dem USB-Modus, wählen Sie „Dateien übertragen“.',
  },
  { where: 'Hier', title: 'Auf „Handy verbinden“ klicken', text: 'Der Browser zeigt eine Liste. Wählen Sie Ihr Handy und klicken Sie auf „Verbinden“.' },
  {
    where: 'Am Handy',
    title: 'Zulassen',
    text: 'Das Handy fragt „USB-Debugging zulassen?“. Haken bei „Immer von diesem Computer zulassen“ setzen, dann „Zulassen“. Danach erscheint das Fenster mit dem Bild.',
  },
]

/** How far the connection has come, as the number of steps that are done. */
const DONE_AFTER: Record<MirrorStep, number> = { select: 3, connect: 4, allow: 4, push: 5, start: 5 }

const STEP_TEXT: Record<MirrorStep, string> = {
  select: 'Wählen Sie Ihr Handy in der Liste des Browsers',
  connect: 'Verbindung zum Handy wird aufgebaut',
  allow: 'Tippen Sie jetzt am Handy auf „Zulassen“',
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

/* -- pieces ------------------------------------------------------------------------------------- */

/** A computer and a phone, and the cable between them: what the page does, in one picture. */
function Illustration() {
  return (
    <svg viewBox="0 0 320 170" className="h-auto w-full text-ink" fill="none" role="img" aria-label="Ein Computer, ein Handy und das Kabel dazwischen">
      {/* the computer */}
      <rect x="14" y="22" width="168" height="104" rx="10" stroke="currentColor" strokeWidth="1.6" />
      <rect x="22" y="30" width="152" height="88" rx="5" fill="currentColor" opacity="0.07" />
      <path d="M72 126h52M98 126v12M76 138h44" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      {/* the phone's picture, in the computer's window */}
      <rect x="84" y="40" width="44" height="68" rx="6" stroke="currentColor" strokeWidth="1.4" fill="currentColor" fillOpacity="0.12" />
      <path d="M96 48h20M92 62h28M92 72h28M92 82h18" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.55" />
      {/* the phone */}
      <rect x="236" y="36" width="64" height="112" rx="12" stroke="currentColor" strokeWidth="1.6" />
      <path d="M258 44h20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M252 62h32M252 74h32M252 86h22" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.55" />
      <circle cx="268" cy="132" r="4" stroke="currentColor" strokeWidth="1.4" />
      {/* the cable */}
      <path d="M268 148c0 18-46 14-96 6-14-2.5-24-6-30-12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="1 5" />
      <circle cx="268" cy="148" r="2.5" fill="currentColor" />
    </svg>
  )
}

function Check() {
  return (
    <svg viewBox="0 0 16 16" className="h-[14px] w-[14px]" fill="none" aria-hidden>
      <path d="M3.5 8.4l3 3 6-6.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Steps({ done, active }: { done: number; active: number | null }) {
  return (
    <ol className="flex flex-col">
      {STEPS.map((step, index) => {
        const finished = index < done
        const current = index === active
        return (
          <li key={step.title} className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-[14px] border-t border-line py-[16px] first:border-t-0 first:pt-0">
            <span
              aria-hidden
              className={`value grid h-[28px] w-[28px] place-items-center rounded-pill text-small transition-colors duration-[var(--dur-base)] ${
                finished ? 'bg-ink text-on-ink' : current ? 'text-ink ring-2 ring-inset ring-ink' : 'text-prose ring-1 ring-inset ring-rule'
              }`}
            >
              {finished ? <Check /> : index + 1}
            </span>
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-[10px] text-body font-semibold leading-[1.35] text-ink">
                {step.title}
                <span className="text-micro font-normal text-muted">{step.where}</span>
              </p>
              <p className="mt-[4px] max-w-[60ch] text-small leading-[1.55] text-prose">{step.text}</p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function Help() {
  return (
    <ul className="flex max-w-[68ch] flex-col gap-[10px] text-small leading-[1.55] text-prose">
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
        <span className="font-semibold text-ink">Die Tasten schreiben falsche Buchstaben (y und z vertauscht).</span> Das Handy behandelt Sondra als
        USB-Tastatur und wendet sein eigenes Tastaturlayout an. Einstellungen → System → Tastatur → Physische Tastatur → Layout „Deutsch“ wählen.
      </li>
      <li>
        <span className="font-semibold text-ink">Kein Ton.</span> Den Ton gibt es ab Android 11. Das Handy selbst bleibt dabei stumm, solange es
        auf den Computer überträgt.
      </li>
      <li>
        <span className="font-semibold text-ink">Das Bild bleibt schwarz.</span> Banking-Apps und andere geschützte Fenster erlauben keine
        Aufnahme; Android zeigt sie hier schwarz. Das ist keine Störung.
      </li>
      <li>
        <span className="font-semibold text-ink">Der Zulassen-Dialog kommt nicht.</span> Ziehen Sie das Kabel ab, wählen Sie in den
        Entwickleroptionen „USB-Debugging-Autorisierungen widerrufen“ und verbinden Sie noch einmal.
      </li>
    </ul>
  )
}

const CONTROLS: Array<[string, string]> = [
  ['Klicken, Ziehen, Mausrad', 'tippen, wischen, scrollen'],
  ['Rechtsklick', 'Zurück'],
  ['Mittelklick', 'Start'],
  ['Tastatur', 'ins Fenster klicken, dann geht jede Taste ans Handy'],
  ['Strg + Alt + Esc', 'gibt die Tastatur an die Seite zurück'],
]

type Stage = { kind: 'idle' } | { kind: 'working'; step: MirrorStep } | { kind: 'running'; name: string }

/**
 * The tests of this tool bring a phone of their own: there is no ADB device in
 * a test run. A page sets this before it loads; nothing sets it otherwise.
 */
type Starter = typeof startMirror
const testStarter = (): Starter | undefined => (globalThis as { __sondraMirrorTest?: Starter }).__sondraMirrorTest

export function PhoneMirrorPanel() {
  const support = useRef(mirrorSupport()).current
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<MirrorSession | null>(null)
  const abortRef = useRef<(() => void) | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [settings, setSettings] = useState(rememberedSettings)
  const [failure, setFailure] = useState<{ failure: MirrorFailure; detail: string } | null>(null)
  const [ended, setEnded] = useState<string | null>(null)
  const [shape, setShape] = useState({ width: 9, height: 16 })
  const [keyboard, setKeyboard] = useState<'uhid' | 'sdk'>('uhid')
  const [audio, setAudio] = useState<'on' | 'off' | 'unavailable'>('off')
  const [muted, setMuted] = useState(false)
  const [recenter, setRecenter] = useState(0)

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

  const update = (next: Partial<Settings>) => {
    const merged = { ...settings, ...next }
    setSettings(merged)
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged))
    } catch {
      /* only a preference */
    }
  }

  const connect = async () => {
    const canvas = canvasRef.current
    if (!canvas) return
    setFailure(null)
    setEnded(null)
    setStage({ kind: 'working', step: 'select' })
    try {
      // Straight from the click: the browser opens its picker only then.
      const session = await (testStarter() ?? startMirror)({
        canvas,
        quality: settings.quality,
        sound: settings.sound,
        onStep: (step) => setStage({ kind: 'working', step }),
        onAbort: (abort) => {
          abortRef.current = abort
        },
      })
      abortRef.current = null
      sessionRef.current = session
      setShape(session.size)
      setKeyboard(session.keyboard)
      setAudio(session.audio)
      setMuted(false)
      session.onSize(setShape)
      session.onKeyboard(setKeyboard)
      session.onAudio(setAudio)
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

  const shoot = async () => {
    const blob = await sessionRef.current?.screenshot()
    if (!blob) return
    const now = new Date()
    const pad = (value: number) => String(value).padStart(2, '0')
    saveBytes(blob, `Handy ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.png`, 'image/png')
  }

  const running = stage.kind === 'running'
  const working = stage.kind === 'working'

  return (
    <div className="flex flex-col gap-[24px]">
      {!support.ok ? (
        <div>
          <h2 className="display-md mt-[8px] mb-[12px]">Handy spiegeln</h2>
          <Notice tone="warn" title="Hier nicht möglich">
            {UNSUPPORTED_TEXT[support.why]}
          </Notice>
        </div>
      ) : (
        <>
          <div className="grid gap-[32px] lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)] lg:gap-[48px]">
            <div className="min-w-0">
              <h2 className="display-md mt-[8px] mb-[12px]">Handy spiegeln</h2>
              <p className="mb-[24px] max-w-[60ch] text-body leading-[1.55] text-prose">
                Zeigt den Bildschirm Ihres Android-Handys in einem Fenster hier, mit Ton. Maus und Tastatur dieses Computers steuern das Handy. Das Bild
                läuft nur über das USB-Kabel; es wird nichts hochgeladen.
              </p>
              {running ? (
                <div className="rounded-card bg-panel-soft p-[20px] ring-1 ring-inset ring-line/70">
                  <p className="flex items-center gap-[10px] text-body font-semibold text-ink" role="status">
                    <span className="h-[10px] w-[10px] animate-pulse rounded-pill bg-ink" aria-hidden />
                    Verbunden mit {stage.name}
                  </p>
                  <p className="mt-[8px] max-w-[56ch] text-small leading-[1.55] text-prose">
                    Das Handy steht in einem Fenster über der Seite. Ziehen Sie es an der Titelleiste, die Größe ändern Sie an der Ecke unten rechts.
                  </p>
                  <dl className="mt-[16px] grid max-w-[560px] grid-cols-[minmax(0,180px)_1fr] gap-x-[16px] gap-y-[8px] border-t border-line pt-[16px] text-small">
                    {CONTROLS.map(([what, does]) => (
                      <div key={what} className="contents">
                        <dt className="font-semibold text-ink">{what}</dt>
                        <dd className="text-prose">{does}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-[16px] max-w-[56ch] text-small leading-[1.55] text-muted">
                    {keyboard === 'uhid'
                      ? 'Die Tastatur ist als USB-Tastatur am Handy angemeldet (UHID, wie scrcpy --keyboard=uhid): Tastenkombinationen und gehaltene Tasten gehen wie an einer echten Tastatur.'
                      : 'Das Handy hat die USB-Tastatur abgelehnt; Buchstaben und die wichtigsten Tasten gehen als Eingabe durch, Tastenkombinationen nicht.'}
                    {audio === 'unavailable' ? ' Ton gibt es erst ab Android 11.' : ''}
                  </p>
                  <div className="mt-[20px] flex flex-wrap gap-[8px]">
                    <Button variant="quiet" size="sm" onClick={() => setRecenter((count) => count + 1)}>
                      Fenster zurückholen
                    </Button>
                    <Button size="sm" onClick={() => void stop()}>
                      Beenden
                    </Button>
                  </div>
                </div>
              ) : (
                <Steps done={working ? DONE_AFTER[stage.step] : 0} active={working ? DONE_AFTER[stage.step] : null} />
              )}
            </div>

            {/* While the phone is connected its window floats where this stood. */}
            {running ? null : (
            <aside className="flex min-w-0 flex-col gap-[20px] self-start rounded-card bg-panel-soft p-[24px] ring-1 ring-inset ring-line/70 lg:mt-[8px]">
              <Illustration />
              <div className="flex flex-col gap-[12px]">
                <Button onClick={() => void connect()} disabled={working || running} className="w-full">
                  {running ? 'Verbunden' : working ? 'Wird verbunden …' : 'Handy verbinden'}
                </Button>
                {working ? (
                  <div className="flex items-center justify-between gap-[12px]" role="status">
                    <p className="min-w-0 text-small leading-[1.45] text-ink">{STEP_TEXT[stage.step]}</p>
                    <Button variant="ghost" size="sm" onClick={() => abortRef.current?.()}>
                      Abbrechen
                    </Button>
                  </div>
                ) : null}
              </div>
              <div className="grid gap-[14px] border-t border-line pt-[16px]">
                <Toggle
                  label="Ton übertragen"
                  hint="Ab Android 11. Das Handy bleibt dann stumm."
                  checked={settings.sound}
                  onChange={(value) => update({ sound: value })}
                />
                <label className="flex flex-col gap-[6px] text-small text-ink">
                  Bildqualität
                  <Select value={settings.quality} disabled={working || running} onChange={(event) => update({ quality: event.target.value === 'sharp' ? 'sharp' : 'smooth' })}>
                    <option value="smooth">Flüssig · empfohlen</option>
                    <option value="sharp">Scharf · Originalgröße, mehr Last</option>
                  </Select>
                </label>
              </div>
              <p className="border-t border-line pt-[16px] text-micro leading-[1.5] text-muted">
                Das Programm, das auf dem Handy das Bild liefert, ist scrcpy von Genymobile; es liegt nur für die Dauer der Verbindung auf dem Handy. Der Schlüssel,
                mit dem sich dieser Computer dem Handy ausweist, bleibt in diesem Browser.
              </p>
            </aside>
            )}
          </div>

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

          <Reveal label="Wenn es nicht klappt" defaultOpen={Boolean(failure && failure.failure !== 'cancelled')}>
            <Help />
          </Reveal>

          {/* The window: always in the page, so the canvas is there when the
              picture starts, and shown only while there is one. */}
          <MirrorWindow
            canvasRef={canvasRef}
            session={running ? sessionRef.current : null}
            name={stage.kind === 'running' ? stage.name : ''}
            shape={shape}
            keyboard={keyboard}
            audio={audio}
            muted={muted}
            onMuted={(value) => {
              setMuted(value)
              sessionRef.current?.setMuted(value)
            }}
            onStop={() => void stop()}
            onShot={() => void shoot()}
            recenter={recenter}
          />
        </>
      )}
    </div>
  )
}
