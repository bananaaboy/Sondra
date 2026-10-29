/**
 * The player's settings, one gear away.
 *
 * A main list that says what is set — „Qualität: Original · 1080p“ — and a
 * page per subject behind it, the way every player people already know does
 * it. Nothing here interrupts what is playing: choosing a lower quality or
 * another sound track starts a conversion and the film keeps running until
 * the new version is ready.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

import {
  BOOSTS,
  DEFAULT_SETTINGS,
  EQ_PRESETS,
  OPENINGS,
  RATES,
  SKIPS,
  SLEEPS,
  chaptersText,
  clock,
  minutesSeconds,
  rateLabel,
  type CaptionSize,
  type Fit,
  type PlayerMark,
  type PlayerSettings,
  type Repeat,
  type SleepTimer,
} from '../../lib/player'

export type Quality = 'original' | number

export interface QualityState {
  current: Quality
  /** The film's own height, once known. */
  sourceHeight: number | null
  options: number[]
  /** A version being made: which, and how far. */
  making: { height: number; fraction: number } | null
  /** Why lower qualities cannot be offered yet. */
  note: string | null
}

/** The opening of the series this file belongs to, as the player knows it. */
export interface IntroState {
  /** The series' name, when the file is on the Merkliste. */
  series: string | null
  /** Openings learned for it by ear. */
  learned: number
  /** In this file: not looked for (none learned), being looked for, not there, or where. */
  here: 'off' | 'finding' | 'none' | { start: number; end: number }
  /** Another episode of the series in the list, to learn from. */
  partner: string | null
  /** What learning is doing right now. */
  step: string | null
  /** What came of the last try. */
  note: string | null
}

export interface TrackState {
  status: 'unknown' | 'pending' | 'ready'
  tracks: string[]
  current: number
  making: boolean
}

type Page = 'main' | 'quality' | 'rate' | 'captions' | 'audio' | 'picture' | 'sound' | 'playback' | 'opening' | 'marks'

const TITLES: Record<Exclude<Page, 'main'>, string> = {
  quality: 'Qualität',
  rate: 'Tempo',
  captions: 'Untertitel',
  audio: 'Tonspur',
  picture: 'Bild',
  sound: 'Ton',
  playback: 'Wiedergabe',
  opening: 'Vorspann',
  marks: 'Lesezeichen',
}

const FITS: { id: Fit; label: string; hint: string }[] = [
  { id: 'contain', label: 'Einpassen', hint: 'Ganzes Bild, Ränder wo nötig' },
  { id: 'cover', label: 'Füllen', hint: 'Fläche füllen, Ränder abschneiden' },
  { id: 'fill', label: 'Strecken', hint: 'Auf die Fläche ziehen' },
]
const SIZES: { id: CaptionSize; label: string }[] = [
  { id: 'klein', label: 'Klein' },
  { id: 'mittel', label: 'Mittel' },
  { id: 'gross', label: 'Gross' },
]
const REPEATS: { id: Repeat; label: string }[] = [
  { id: 'aus', label: 'Aus' },
  { id: 'titel', label: 'Diesen Titel' },
  { id: 'liste', label: 'Ganze Liste' },
]

const percent = (value: number) => `${Math.round(value * 100)} %`

function Chevron({ back = false }: { back?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="h-[14px] w-[14px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={back ? 'M10 3.5L5.5 8l4.5 4.5' : 'M6 3.5L10.5 8 6 12.5'} />
    </svg>
  )
}

function Check({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={`h-[14px] w-[14px] shrink-0 ${on ? 'opacity-100' : 'opacity-0'}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  )
}

const ROW = 'press flex w-full min-h-[44px] sm:min-h-0 items-center gap-[12px] px-[16px] py-[10px] text-left text-small outline-none transition-colors duration-[var(--dur-fast)] hover:bg-stage-line/60 focus-visible:bg-stage-line/60 disabled:opacity-40'

function MainRow({ label, value, onClick, hidden = false }: { label: string; value: string; onClick: () => void; hidden?: boolean }) {
  if (hidden) return null
  return (
    <button type="button" className={ROW} onClick={onClick}>
      <span className="flex-1 text-stage-ink">{label}</span>
      <span className="max-w-[55%] truncate text-stage-muted">{value}</span>
      <span className="text-stage-muted">
        <Chevron />
      </span>
    </button>
  )
}

function Option({ label, hint, selected, onClick, disabled }: { label: ReactNode; hint?: string; selected: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={selected} disabled={disabled} className={ROW} onClick={onClick}>
      <Check on={selected} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={selected ? 'font-semibold text-stage-ink' : 'text-stage-ink'}>{label}</span>
        {hint ? <span className="text-micro leading-[1.4] text-stage-muted">{hint}</span> : null}
      </span>
    </button>
  )
}

function Switch({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (value: boolean) => void }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={on} className={ROW} onClick={() => onChange(!on)}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-stage-ink">{label}</span>
        {hint ? <span className="text-micro leading-[1.4] text-stage-muted">{hint}</span> : null}
      </span>
      <span className={`flex h-[20px] w-[34px] shrink-0 items-center rounded-pill p-[2px] transition-colors duration-[var(--dur-fast)] ${on ? 'bg-stage-accent' : 'bg-stage-line'}`}>
        <span className={`h-[16px] w-[16px] rounded-pill bg-stage-ink transition-transform duration-[var(--dur-base)] ease-[var(--ease-settle)] ${on ? 'translate-x-[14px]' : ''}`} />
      </span>
    </button>
  )
}

function Range({ label, value, display, min, max, step, onChange }: { label: string; value: number; display: string; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <label className="flex flex-col gap-[4px] px-[16px] py-[8px] text-small">
      <span className="flex items-baseline justify-between gap-[12px]">
        <span className="text-stage-ink">{label}</span>
        <span className="value text-stage-muted">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ '--color-ink': 'var(--color-stage-accent)' } as CSSProperties}
      />
    </label>
  )
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="border-t border-stage-line/60 py-[4px] first:border-t-0">
      {title ? <p className="px-[16px] pb-[2px] pt-[8px] text-micro text-stage-muted">{title}</p> : null}
      {children}
    </div>
  )
}

/**
 * The bookmarks of the file: a click on the time jumps there, the name is
 * typed in place, the cross takes one away. „Als Kapitel kopieren“ puts them
 * on the clipboard the way a YouTube description lists chapters.
 */
function MarksPage({
  marks,
  time,
  onAdd,
  onSeek,
  onChange,
}: {
  marks: PlayerMark[]
  time: number
  onAdd: () => void
  onSeek: (mark: PlayerMark) => void
  onChange: (marks: PlayerMark[]) => void
}) {
  const [copied, setCopied] = useState<'ja' | 'nein' | null>(null)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(chaptersText(marks))
      setCopied('ja')
    } catch {
      setCopied('nein')
    }
  }
  return (
    <>
      <button type="button" className={ROW} onClick={onAdd}>
        <span className="flex-1 text-stage-ink">Hier ein Lesezeichen setzen</span>
        <span className="value text-stage-muted">{clock(time)} · B</span>
      </button>
      {marks.length === 0 ? (
        <p className="px-[16px] py-[10px] text-small leading-[1.5] text-stage-muted">
          Noch keine. Lesezeichen bleiben bei dieser Datei auf diesem Gerät; Umschalt + ← und → springen von einem zum
          nächsten.
        </p>
      ) : (
        <Group>
          <ul>
            {marks.map((mark, index) => (
              <li key={mark.id} className="flex items-center gap-[6px] px-[10px] py-[4px]">
                <button
                  type="button"
                  onClick={() => onSeek(mark)}
                  title={`Zu ${clock(mark.at)} springen`}
                  className="press value shrink-0 rounded-nav px-[6px] py-[5px] text-small text-stage-accent outline-none hover:bg-stage-line/60 focus-visible:bg-stage-line/60"
                >
                  {clock(mark.at)}
                </button>
                <input
                  value={mark.label}
                  placeholder={`Lesezeichen ${index + 1}`}
                  aria-label={`Name für das Lesezeichen bei ${clock(mark.at)}`}
                  maxLength={120}
                  onChange={(event) =>
                    onChange(marks.map((entry) => (entry.id === mark.id ? { ...entry, label: event.target.value } : entry)))
                  }
                  className="min-w-0 flex-1 rounded-nav bg-transparent px-[6px] py-[5px] text-small text-stage-ink placeholder:text-stage-muted outline-none ring-1 ring-inset ring-transparent hover:ring-stage-line focus-visible:ring-stage-accent"
                />
                <button
                  type="button"
                  onClick={() => onChange(marks.filter((entry) => entry.id !== mark.id))}
                  aria-label={`Lesezeichen bei ${clock(mark.at)} entfernen`}
                  title="Entfernen"
                  className="press grid h-[28px] w-[28px] shrink-0 place-items-center rounded-pill text-stage-muted outline-none hover:bg-stage-line/60 hover:text-stage-ink focus-visible:bg-stage-line/60"
                >
                  <svg viewBox="0 0 16 16" className="h-[12px] w-[12px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </Group>
      )}
      {marks.length > 0 ? (
        <Group>
          <button type="button" className={ROW} onClick={() => void copy()}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-stage-ink">Als Kapitel kopieren</span>
              <span className="text-micro leading-[1.4] text-stage-muted">
                {copied === 'ja'
                  ? 'Kopiert — passt so in eine YouTube-Beschreibung.'
                  : copied === 'nein'
                    ? 'Der Browser lässt das Kopieren hier nicht zu.'
                    : 'Eine Zeile je Lesezeichen, beginnend bei 0:00'}
              </span>
            </span>
          </button>
        </Group>
      ) : null}
    </>
  )
}

export function SettingsMenu({
  kind,
  placement = 'over',
  settings,
  update,
  quality,
  onQuality,
  onProbe,
  captions,
  onCaption,
  onLoadCaptions,
  audio,
  onAudio,
  opening,
  onOpening,
  sleep,
  now,
  onSleep,
  marks,
  time,
  onAddMark,
  onSeekMark,
  onMarks,
  intro,
  onLearnIntro,
  onForgetIntros,
  onClose,
}: {
  kind: 'video' | 'audio'
  /** Over the picture, or underneath it when the frame is too low to hold it. */
  placement?: 'over' | 'below'
  settings: PlayerSettings
  update: (patch: Partial<PlayerSettings>) => void
  quality: QualityState
  onQuality: (quality: Quality) => void
  /** Ask FFmpeg what is in the file, for qualities and sound tracks. */
  onProbe: () => void
  captions: { tracks: string[]; current: number }
  onCaption: (index: number) => void
  onLoadCaptions: () => void
  audio: TrackState
  onAudio: (index: number) => void
  /** What „Vorspann überspringen“ jumps, and the series it is kept for, if the file is on the Merkliste. */
  opening: { seconds: number; series: string | null }
  onOpening: (seconds: number) => void
  sleep: SleepTimer | null
  /** The clock the sleep timer counts down against. */
  now: number
  /** Minutes, the end of the title, or off. */
  onSleep: (choice: number | 'end' | null) => void
  /** This file's bookmarks, where it is now, and what can be done with them. */
  marks: PlayerMark[]
  time: number
  onAddMark: () => void
  onSeekMark: (mark: PlayerMark) => void
  onMarks: (marks: PlayerMark[]) => void
  intro: IntroState
  onLearnIntro: () => void
  onForgetIntros: () => void
  onClose: () => void
}) {
  const [page, setPage] = useState<Page>('main')
  const box = useRef<HTMLDivElement>(null)

  // Escape goes back a page, then closes; a click elsewhere closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (page === 'main') onClose()
      else setPage('main')
    }
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (box.current && !box.current.contains(target) && !(target as HTMLElement).closest?.('[data-settings-toggle]')) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [page, onClose])

  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [page])

  const open = (next: Page) => {
    if (next === 'quality' || next === 'audio') onProbe()
    setPage(next)
  }

  const qualityValue =
    quality.making
      ? `${quality.making.height}p wird erstellt (${Math.round(quality.making.fraction * 100)} %)`
      : quality.current === 'original'
        ? `Original${quality.sourceHeight ? ` · ${quality.sourceHeight}p` : ''}`
        : `${quality.current}p`
  const pictureTouched =
    settings.brightness !== 1 || settings.contrast !== 1 || settings.saturation !== 1 || settings.mirror || settings.fit !== 'contain'
  const matchedPreset = EQ_PRESETS.find(
    (p) =>
      p.id !== 'flat' &&
      settings.bassBoost === p.bassBoost &&
      settings.eqLow === p.eqLow &&
      settings.eqMid === p.eqMid &&
      settings.eqHigh === p.eqHigh,
  )
  const soundValue = [
    settings.karaoke ? 'Karaoke' : null,
    matchedPreset ? matchedPreset.name : settings.bassBoost > 0 ? 'Bass-Boost' : null,
    settings.boost > 1 ? `${Math.round(settings.boost * 100)} %` : null,
    settings.night ? 'Nachtmodus' : null,
  ]
    .filter(Boolean)
    .join(' · ') || 'Normal'
  const openingValue = !settings.skipOpening
    ? 'Aus'
    : typeof intro.here === 'object'
      ? `${clock(intro.here.start)}–${clock(intro.here.end)}`
      : intro.here === 'finding'
        ? 'wird gesucht …'
        : minutesSeconds(opening.seconds)
  // Never more than was chosen: `now` ticks every few seconds and lags a fresh choice.
  const sleepLeft = sleep && 'until' in sleep ? Math.min(sleep.minutes, Math.max(1, Math.ceil((sleep.until - now) / 60_000))) : null
  const playbackValue = sleep
    ? 'atEnd' in sleep
      ? 'Schlaf-Timer: Ende des Titels'
      : `Schlaf-Timer: noch ${sleepLeft} Min.`
    : settings.repeat !== 'aus'
      ? settings.repeat === 'titel'
        ? 'Titel wiederholen'
        : 'Liste wiederholen'
      : settings.autoNext
        ? 'Automatisch weiter'
        : 'Anhalten am Ende'

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] sm:hidden"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={box}
        role="menu"
        aria-label="Einstellungen"
        className={`sheet flex flex-col overflow-hidden bg-stage text-stage-ink ${
          placement === 'over'
            ? 'max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-50 max-sm:max-h-[82vh] max-sm:w-full max-sm:rounded-t-[20px] max-sm:rounded-b-none max-sm:border-t max-sm:border-line max-sm:shadow-2xl sm:absolute sm:bottom-[68px] sm:right-[12px] sm:z-30 sm:max-h-[min(460px,calc(100%-84px))] sm:w-[340px] sm:max-w-[calc(100%-24px)] sm:rounded-card sm:ring-1 sm:ring-inset sm:ring-stage-line sm:shadow-[0_18px_50px_-12px_rgb(0_0_0/0.7)]'
            : 'max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-50 max-sm:max-h-[82vh] max-sm:w-full max-sm:rounded-t-[20px] max-sm:rounded-b-none max-sm:border-t max-sm:border-line max-sm:shadow-2xl sm:relative sm:w-full sm:ml-auto sm:w-[360px] sm:rounded-card sm:ring-1 sm:ring-inset sm:ring-stage-line'
        }`}
      >
        {/* Mobile handle & title header */}
        <div className="flex sm:hidden items-center justify-between border-b border-stage-line/50 px-[16px] py-[10px]">
          <span className="text-small font-semibold text-stage-ink">{page === 'main' ? 'Einstellungen' : TITLES[page]}</span>
          <button
            type="button"
            aria-label="Schliessen"
            onClick={onClose}
            className="press grid h-[32px] w-[32px] place-items-center rounded-pill text-stage-muted hover:bg-white/10 hover:text-stage-ink"
          >
            <svg viewBox="0 0 16 16" className="h-[14px] w-[14px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="3" x2="13" y2="13" />
              <line x1="13" y1="3" x2="3" y2="13" />
            </svg>
          </button>
        </div>

        {page !== 'main' ? (
          <button type="button" onClick={() => setPage('main')} className={`${ROW} border-b border-stage-line/60 font-semibold`}>
            <Chevron back />
            <span>Zurück zu Einstellungen</span>
          </button>
        ) : null}

        <div className="min-h-0 overflow-y-auto overscroll-contain py-[4px] pb-[calc(12px+env(safe-area-inset-bottom,0px))]">
        {page === 'main' ? (
          <>
            <MainRow label="Qualität" value={qualityValue} onClick={() => open('quality')} hidden={kind !== 'video'} />
            <MainRow label="Tempo" value={rateLabel(settings.rate)} onClick={() => open('rate')} />
            <MainRow label="Untertitel" value={captions.current >= 0 ? captions.tracks[captions.current] ?? 'An' : 'Aus'} onClick={() => open('captions')} hidden={kind !== 'video'} />
            <MainRow
              label="Tonspur"
              value={audio.status === 'ready' ? audio.tracks[audio.current] ?? '—' : audio.status === 'pending' ? 'wird geprüft …' : 'Standard'}
              onClick={() => open('audio')}
            />
            <MainRow label="Bild" value={pictureTouched ? 'Angepasst' : 'Original'} onClick={() => open('picture')} hidden={kind !== 'video'} />
            <MainRow label="Ton" value={soundValue} onClick={() => open('sound')} />
            <MainRow label="Wiedergabe" value={playbackValue} onClick={() => open('playback')} />
            <MainRow label="Vorspann" value={openingValue} onClick={() => open('opening')} hidden={kind !== 'video'} />
            <MainRow label="Lesezeichen" value={marks.length ? String(marks.length) : 'Keine'} onClick={() => open('marks')} />
          </>
        ) : null}

        {page === 'marks' ? <MarksPage marks={marks} time={time} onAdd={onAddMark} onSeek={onSeekMark} onChange={onMarks} /> : null}

        {page === 'quality' ? (
          <>
            <Option
              label={`Original${quality.sourceHeight ? ` · ${quality.sourceHeight}p` : ''}`}
              hint="Die Datei selbst, in voller Qualität"
              selected={quality.current === 'original'}
              onClick={() => onQuality('original')}
            />
            {quality.options.map((height) => (
              <Option
                key={height}
                label={
                  <>
                    {height}p
                    {quality.making?.height === height ? <span className="value ml-[8px] font-normal text-stage-muted">{Math.round(quality.making.fraction * 100)} %</span> : null}
                  </>
                }
                hint={height <= 480 ? 'Für langsame Rechner, schnell erstellt' : 'Leichter abzuspielen als das Original'}
                selected={quality.current === height}
                disabled={quality.making?.height === height}
                onClick={() => onQuality(height)}
              />
            ))}
            <p className="px-[16px] pb-[8px] pt-[6px] text-micro leading-[1.45] text-stage-muted">
              {quality.note ??
                'Eine Datei auf dem Gerät spielt immer in voller Qualität. Eine kleinere Fassung hilft, wenn das Bild ruckelt; sie wird hier gerechnet, der Film läuft solange weiter.'}
            </p>
          </>
        ) : null}

        {page === 'rate' ? (
          RATES.map((rate) => <Option key={rate} label={rateLabel(rate)} selected={settings.rate === rate} onClick={() => update({ rate })} />)
        ) : null}

        {page === 'captions' ? (
          <>
            <Group>
              <Option label="Aus" selected={captions.current < 0} onClick={() => onCaption(-1)} />
              {captions.tracks.map((label, index) => (
                <Option key={label + index} label={label} selected={captions.current === index} onClick={() => onCaption(index)} />
              ))}
              <button type="button" className={ROW} onClick={onLoadCaptions}>
                <span className="w-[14px]" />
                <span className="flex-1 text-stage-ink underline decoration-stage-line underline-offset-[3px]">Datei laden (.srt, .vtt) …</span>
              </button>
            </Group>
            <Group title="Grösse">
              {SIZES.map((size) => (
                <Option key={size.id} label={size.label} selected={settings.captionSize === size.id} onClick={() => update({ captionSize: size.id })} />
              ))}
            </Group>
            <Group>
              <Switch label="Dunkler Hintergrund" hint="Besser lesbar auf hellen Bildern" on={settings.captionBackground} onChange={(captionBackground) => update({ captionBackground })} />
            </Group>
          </>
        ) : null}

        {page === 'audio' ? (
          audio.status !== 'ready' ? (
            <p className="px-[16px] py-[12px] text-small text-stage-muted">Die Datei wird geprüft …</p>
          ) : (
            <>
              {audio.tracks.map((label, index) => (
                <Option key={label + index} label={label} selected={audio.current === index} disabled={audio.making} onClick={() => onAudio(index)} />
              ))}
              <p className="px-[16px] pb-[8px] pt-[6px] text-micro leading-[1.45] text-stage-muted">
                {audio.tracks.length > 1
                  ? audio.making
                    ? 'Die Tonspur wird umgestellt …'
                    : 'Eine andere Tonspur wird aus der Datei herausgelöst; das Bild bleibt, wie es ist.'
                  : 'Diese Datei hat eine Tonspur.'}
              </p>
            </>
          )
        ) : null}

        {page === 'picture' ? (
          <>
            <Group title="Grösse">
              {FITS.map((fit) => (
                <Option key={fit.id} label={fit.label} hint={fit.hint} selected={settings.fit === fit.id} onClick={() => update({ fit: fit.id })} />
              ))}
            </Group>
            <Group title="Anpassen">
              <Range label="Helligkeit" value={settings.brightness} display={percent(settings.brightness)} min={0.5} max={1.5} step={0.05} onChange={(brightness) => update({ brightness })} />
              <Range label="Kontrast" value={settings.contrast} display={percent(settings.contrast)} min={0.5} max={1.5} step={0.05} onChange={(contrast) => update({ contrast })} />
              <Range label="Sättigung" value={settings.saturation} display={percent(settings.saturation)} min={0} max={2} step={0.05} onChange={(saturation) => update({ saturation })} />
              <Switch label="Spiegeln" on={settings.mirror} onChange={(mirror) => update({ mirror })} />
            </Group>
            <Group>
              <button
                type="button"
                className={ROW}
                disabled={!pictureTouched}
                onClick={() =>
                  update({ fit: DEFAULT_SETTINGS.fit, brightness: 1, contrast: 1, saturation: 1, mirror: false })
                }
              >
                <span className="w-[14px]" />
                <span className="flex-1 text-stage-ink">Zurücksetzen</span>
              </button>
            </Group>
          </>
        ) : null}

        {page === 'sound' ? (
          <>
            <Group title="Verstärkung">
              {BOOSTS.map((boost) => (
                <Option
                  key={boost}
                  label={boost === 1 ? 'Normal' : `${Math.round(boost * 100)} %`}
                  hint={boost === BOOSTS[BOOSTS.length - 1] ? 'Kann verzerren' : undefined}
                  selected={settings.boost === boost}
                  onClick={() => update({ boost })}
                />
              ))}
            </Group>
            <Group title="Klang">
              <div className="flex flex-wrap gap-[6px] px-[16px] py-[8px]">
                {EQ_PRESETS.map((preset) => {
                  const active =
                    settings.bassBoost === preset.bassBoost &&
                    settings.eqLow === preset.eqLow &&
                    settings.eqMid === preset.eqMid &&
                    settings.eqHigh === preset.eqHigh
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() =>
                        update({
                          bassBoost: preset.bassBoost,
                          eqLow: preset.eqLow,
                          eqMid: preset.eqMid,
                          eqHigh: preset.eqHigh,
                        })
                      }
                      aria-pressed={active}
                      className={`press rounded-pill px-[10px] py-[5px] text-small leading-none transition-colors duration-[var(--dur-fast)] ${
                        active ? 'bg-stage-ink font-semibold text-stage' : 'text-stage-ink ring-1 ring-inset ring-stage-line hover:bg-stage-soft'
                      }`}
                    >
                      {preset.name}
                    </button>
                  )
                })}
              </div>
              <Range
                label="Bass-Boost"
                value={settings.bassBoost}
                display={settings.bassBoost > 0 ? `+${settings.bassBoost} dB` : 'Aus'}
                min={0}
                max={12}
                step={1}
                onChange={(bassBoost) => update({ bassBoost })}
              />
              <Range
                label="Tiefen (100 Hz)"
                value={settings.eqLow}
                display={`${settings.eqLow > 0 ? '+' : ''}${settings.eqLow} dB`}
                min={-12}
                max={12}
                step={1}
                onChange={(eqLow) => update({ eqLow })}
              />
              <Range
                label="Mitten (1 kHz)"
                value={settings.eqMid}
                display={`${settings.eqMid > 0 ? '+' : ''}${settings.eqMid} dB`}
                min={-12}
                max={12}
                step={1}
                onChange={(eqMid) => update({ eqMid })}
              />
              <Range
                label="Höhen (10 kHz)"
                value={settings.eqHigh}
                display={`${settings.eqHigh > 0 ? '+' : ''}${settings.eqHigh} dB`}
                min={-12}
                max={12}
                step={1}
                onChange={(eqHigh) => update({ eqHigh })}
              />
              <button
                type="button"
                className={ROW}
                disabled={settings.bassBoost === 0 && settings.eqLow === 0 && settings.eqMid === 0 && settings.eqHigh === 0}
                onClick={() => update({ bassBoost: 0, eqLow: 0, eqMid: 0, eqHigh: 0 })}
              >
                <span className="w-[14px]" />
                <span className="flex-1 text-stage-ink">Equalizer zurücksetzen</span>
              </button>
            </Group>
            <Group>
              <Switch
                label="Instrumental / Karaoke"
                hint="Dämpft die Stimme in der Mitte des Stereobilds — klappt bei vielen Studioaufnahmen"
                on={settings.karaoke}
                onChange={(karaoke) => update({ karaoke })}
              />
              {kind === 'audio' ? (
                <Switch
                  label="Visualizer"
                  hint="Zeigt auf der Bühne, was gerade klingt"
                  on={settings.visualizer}
                  onChange={(visualizer) => update({ visualizer })}
                />
              ) : null}
              {kind === 'audio' && settings.visualizer ? (
                <div className="flex items-center justify-between gap-[12px] px-[16px] pb-[10px] pt-[2px]">
                  <span className="text-small text-stage-muted">Darstellung</span>
                  <div className="flex gap-[4px]">
                    {([
                      { id: 'bars', label: 'Balken' },
                      { id: 'wave', label: 'Welle' },
                      { id: 'radial', label: 'Radial' },
                    ] as const).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => update({ visualizerMode: m.id })}
                        aria-pressed={settings.visualizerMode === m.id}
                        className={`press rounded-pill px-[10px] py-[5px] text-small leading-none transition-colors duration-[var(--dur-fast)] ${
                          settings.visualizerMode === m.id
                            ? 'bg-stage-ink font-semibold text-stage'
                            : 'text-stage-ink ring-1 ring-inset ring-stage-line hover:bg-stage-soft'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <Switch
                label="Nachtmodus"
                hint="Leise Stellen lauter, laute leiser — Dialoge verstehen, ohne die Nachbarn zu wecken"
                on={settings.night}
                onChange={(night) => update({ night })}
              />
            </Group>
          </>
        ) : null}

        {page === 'playback' ? (
          <>
            <Group>
              <Switch label="Automatisch weiter" hint="Nach dem Ende den nächsten Titel der Liste" on={settings.autoNext} onChange={(autoNext) => update({ autoNext })} />
              <Switch
                label="In der Merkliste abhaken"
                hint="Eine Folge, deren Dateiname auf der Merkliste steht, ab 90 % als gesehen"
                on={settings.merkliste}
                onChange={(merkliste) => update({ merkliste })}
              />
            </Group>
            <Group title="Wiederholen">
              {REPEATS.map((repeat) => (
                <Option key={repeat.id} label={repeat.label} selected={settings.repeat === repeat.id} onClick={() => update({ repeat: repeat.id })} />
              ))}
            </Group>
            <Group title="Sprung mit ← → und den Pfeilknöpfen">
              {SKIPS.map((skip) => (
                <Option key={skip} label={`${skip} Sekunden`} selected={settings.skip === skip} onClick={() => update({ skip })} />
              ))}
            </Group>
            <Group title="Schlaf-Timer">
              <Option label="Aus" selected={!sleep} onClick={() => onSleep(null)} />
              {SLEEPS.map((minutes) => {
                const on = Boolean(sleep && 'until' in sleep && sleep.minutes === minutes)
                return (
                  <Option
                    key={minutes}
                    label={`${minutes} Minuten`}
                    hint={on ? `noch ${sleepLeft} Min., zum Schluss leiser` : undefined}
                    selected={on}
                    onClick={() => onSleep(minutes)}
                  />
                )
              })}
              <Option label="Ende dieses Titels" selected={Boolean(sleep && 'atEnd' in sleep)} onClick={() => onSleep('end')} />
            </Group>
          </>
        ) : null}

        {page === 'opening' ? (
          <>
            <Group>
              <Switch
                label="Vorspann überspringen anbieten"
                hint="Während des Vorspanns ein Knopf auf dem Bild (S), im Abspann „Nächste Folge“ (N)"
                on={settings.skipOpening}
                onChange={(skipOpening) => update({ skipOpening })}
              />
            </Group>
            {settings.skipOpening ? (
              <>
                <Group title={intro.series ? `Am Ton erkennen — „${intro.series}“` : 'Am Ton erkennen'}>
                  <p className="px-[16px] pb-[6px] pt-[2px] text-small leading-[1.5] text-stage-muted" role="status">
                    {!intro.series
                      ? 'Geht für Serien auf der Merkliste: Sondra vergleicht zwei Folgen und findet den Vorspann danach in jeder weiteren, auch nach einem Cold Open.'
                      : intro.step
                        ? intro.step
                        : typeof intro.here === 'object'
                          ? `In dieser Folge von ${clock(intro.here.start)} bis ${clock(intro.here.end)}.`
                          : intro.here === 'finding'
                            ? 'Sucht den Vorspann in dieser Folge …'
                            : intro.here === 'none'
                              ? 'In dieser Folge nicht gefunden — es gilt die feste Länge unten.'
                              : 'Noch nicht erkannt. Sondra vergleicht dafür zwei Folgen und findet den Vorspann danach in jeder weiteren, auch nach einem Cold Open.'}
                  </p>
                  {intro.note && !intro.step ? <p className="px-[16px] pb-[6px] text-small leading-[1.5] text-stage-ink">{intro.note}</p> : null}
                  {intro.series && !intro.step ? (
                    intro.partner ? (
                      <button type="button" className={ROW} onClick={onLearnIntro}>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-stage-ink">{intro.learned > 0 ? 'Neuen Vorspann erkennen' : 'Vorspann erkennen'}</span>
                          <span className="truncate text-micro leading-[1.4] text-stage-muted">Vergleicht mit „{intro.partner}“</span>
                        </span>
                      </button>
                    ) : (
                      <p className="px-[16px] pb-[8px] text-micro leading-[1.4] text-stage-muted">
                        {intro.learned > 0 ? 'Für einen neuen Vorspann' : 'Dafür'} eine zweite Folge von „{intro.series}“ in die Liste nehmen.
                      </p>
                    )
                  ) : null}
                  {intro.learned > 0 && !intro.step ? (
                    <button type="button" className={ROW} onClick={onForgetIntros}>
                      <span className="flex-1 text-stage-ink">{intro.learned === 1 ? 'Erkannten Vorspann vergessen' : `${intro.learned} erkannte Vorspänne vergessen`}</span>
                    </button>
                  ) : null}
                </Group>
                <Group title={opening.series ? `Feste Länge für „${opening.series}“ — wenn nichts erkannt ist` : 'Feste Länge des Vorspanns'}>
                  {[...new Set([...OPENINGS, opening.seconds])].sort((a, b) => a - b).map((seconds) => (
                    <Option key={seconds} label={minutesSeconds(seconds)} selected={opening.seconds === seconds} onClick={() => onOpening(seconds)} />
                  ))}
                </Group>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
    </>
  )
}
