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
  RATES,
  SKIPS,
  rateLabel,
  type CaptionSize,
  type Fit,
  type PlayerSettings,
  type Repeat,
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

export interface TrackState {
  status: 'unknown' | 'pending' | 'ready'
  tracks: string[]
  current: number
  making: boolean
}

type Page = 'main' | 'quality' | 'rate' | 'captions' | 'audio' | 'picture' | 'sound' | 'playback'

const TITLES: Record<Exclude<Page, 'main'>, string> = {
  quality: 'Qualität',
  rate: 'Tempo',
  captions: 'Untertitel',
  audio: 'Tonspur',
  picture: 'Bild',
  sound: 'Ton',
  playback: 'Wiedergabe',
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

const ROW = 'press flex w-full items-center gap-[12px] px-[16px] py-[10px] text-left text-small outline-none transition-colors duration-[var(--dur-fast)] hover:bg-stage-line/60 focus-visible:bg-stage-line/60 disabled:opacity-40'

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

export function SettingsMenu({
  kind,
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
  onClose,
}: {
  kind: 'video' | 'audio'
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
      ? `${quality.making.height}p wird erstellt`
      : quality.current === 'original'
        ? `Original${quality.sourceHeight ? ` · ${quality.sourceHeight}p` : ''}`
        : `${quality.current}p`
  const pictureTouched =
    settings.brightness !== 1 || settings.contrast !== 1 || settings.saturation !== 1 || settings.mirror || settings.fit !== 'contain'
  const soundValue = [settings.boost > 1 ? `${Math.round(settings.boost * 100)} %` : null, settings.night ? 'Nachtmodus' : null]
    .filter(Boolean)
    .join(' · ') || 'Normal'
  const playbackValue = settings.repeat !== 'aus' ? (settings.repeat === 'titel' ? 'Titel wiederholen' : 'Liste wiederholen') : settings.autoNext ? 'Automatisch weiter' : 'Anhalten am Ende'

  return (
    <div
      ref={box}
      role="menu"
      aria-label="Einstellungen"
      className="pop absolute bottom-[68px] right-[12px] z-30 flex max-h-[min(460px,calc(100%-84px))] w-[320px] max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-card bg-stage/95 text-stage-ink shadow-[0_18px_50px_-12px_rgb(0_0_0/0.7)] ring-1 ring-stage-line/70 backdrop-blur-md"
    >
      {page !== 'main' ? (
        <button type="button" onClick={() => setPage('main')} className={`${ROW} border-b border-stage-line/60 font-semibold`}>
          <Chevron back />
          <span>{TITLES[page]}</span>
        </button>
      ) : null}

      <div className="min-h-0 overflow-y-auto overscroll-contain py-[4px]">
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
          </>
        ) : null}

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
                disabled={Boolean(quality.making)}
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
            <Group>
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
          </>
        ) : null}
      </div>
    </div>
  )
}
