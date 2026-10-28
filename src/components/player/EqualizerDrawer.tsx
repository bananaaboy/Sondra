/**
 * 5-Band Parametric Equalizer & Master Limiter Drawer.
 *
 * Provides:
 * - 5 parametric band sliders (-12 dB to +12 dB) with 80 Hz, 300 Hz, 1 kHz, 3.5 kHz, and 10 kHz
 * - Presets: Flat, Bass Boost, Vocal Clarity, Elektronisch, Höhen-Boost
 * - Master DynamicsCompressor soft limiter status indicator
 * - Bypass / Enable switch with smooth Web Audio gain transition
 * - Vertical rack faders with 0 dB reference line and horizontal slider mode
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react'

import {
  EQUALIZER_BANDS,
  EQUALIZER_PRESET_NAMES,
  EQUALIZER_PRESETS,
  type EqualizerPresetName,
  type FiveBandGains,
} from '../../lib/audio/equalizer'

export interface EqualizerDrawerProps {
  placement?: 'over' | 'below'
  enabled: boolean
  gains: FiveBandGains
  activePreset?: string
  onToggleEnabled: (enabled: boolean) => void
  onGainChange: (bandIndex: number, gain: number) => void
  onSelectPreset: (preset: EqualizerPresetName) => void
  onReset: () => void
  onClose: () => void
}

function matchesPreset(gains: FiveBandGains, presetGains: FiveBandGains): boolean {
  return gains.every((g, i) => Math.abs(g - presetGains[i]) < 0.1)
}

function formatDb(value: number): string {
  const rounded = Math.round(value * 2) / 2
  const prefix = rounded > 0 ? '+' : ''
  return `${prefix}${rounded.toFixed(rounded % 1 === 0 ? 0 : 1)} dB`
}

export function EqualizerDrawer({
  placement = 'over',
  enabled,
  gains,
  activePreset,
  onToggleEnabled,
  onGainChange,
  onSelectPreset,
  onReset,
  onClose,
}: EqualizerDrawerProps) {
  const box = useRef<HTMLDivElement>(null)
  const [viewMode, setViewMode] = useState<'rack' | 'list'>('rack')

  // Close on Escape or click outside
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (box.current && !box.current.contains(target) && !(target as HTMLElement).closest?.('[data-eq-toggle]')) {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [onClose])

  const currentMatchedPreset = EQUALIZER_PRESET_NAMES.find((name) =>
    matchesPreset(gains, EQUALIZER_PRESETS[name])
  )

  const isFlat = matchesPreset(gains, EQUALIZER_PRESETS['Flat'])

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
        role="region"
        aria-label="Parametrischer 5-Band Equalizer & Master Limiter"
        className={`pop flex flex-col overflow-hidden bg-stage text-stage-ink ${
          placement === 'over'
            ? 'max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-50 max-sm:max-h-[85vh] max-sm:w-full max-sm:rounded-t-[20px] max-sm:rounded-b-none max-sm:border-t max-sm:border-line max-sm:shadow-2xl sm:absolute sm:bottom-[68px] sm:right-[12px] sm:z-30 sm:w-[410px] sm:max-w-[calc(100%-24px)] sm:rounded-card sm:ring-1 sm:ring-inset sm:ring-stage-line sm:shadow-[0_18px_50px_-12px_rgb(0_0_0/0.7)]'
            : 'max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-50 max-sm:max-h-[85vh] max-sm:w-full max-sm:rounded-t-[20px] max-sm:rounded-b-none max-sm:border-t max-sm:border-line max-sm:shadow-2xl sm:relative sm:w-full sm:ml-auto sm:w-[410px] sm:rounded-card sm:ring-1 sm:ring-inset sm:ring-stage-line'
        }`}
      >
      {/* Drawer Header */}
      <div className="flex items-center justify-between gap-[8px] border-b border-stage-line/60 px-[16px] py-[10px]">
        <div className="flex min-w-0 items-center gap-[8px]">
          <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-pill bg-stage-line/60 text-stage-ink">
            <svg viewBox="0 0 20 20" className="h-[14px] w-[14px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 3v14M10 3v14M16 3v14" />
              <circle cx="4" cy="7" r="2" fill="currentColor" />
              <circle cx="10" cy="13" r="2" fill="currentColor" />
              <circle cx="16" cy="9" r="2" fill="currentColor" />
            </svg>
          </span>
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-[6px]">
              <span className="text-small font-semibold text-stage-ink">Equalizer</span>
              <span
                className="rounded-pill bg-stage-soft px-[6px] py-[1px] text-micro font-medium text-stage-accent ring-1 ring-inset ring-stage-line"
                title="Master DynamicsCompressorNode fängt Pegelspitzen ab -0.5 dBFS transparent ab"
              >
                Limiter aktiv
              </span>
            </div>
            <span className="text-micro text-stage-muted truncate">5-Band Parametrisch & Soft Limiter</span>
          </div>
        </div>

        <div className="flex items-center gap-[8px] shrink-0">
          {/* View mode toggle: Rack (faders) vs List (sliders) */}
          <button
            type="button"
            title={viewMode === 'rack' ? 'Zu Listenansicht wechseln' : 'Zu Fader-Rackansicht wechseln'}
            onClick={() => setViewMode((m) => (m === 'rack' ? 'list' : 'rack'))}
            className="press rounded-nav px-[6px] py-[3px] text-micro font-medium text-stage-muted hover:text-stage-ink ring-1 ring-inset ring-stage-line"
          >
            {viewMode === 'rack' ? 'Liste' : 'Fader'}
          </button>

          {/* Master Enable/Bypass Switch */}
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            title={enabled ? 'Equalizer ausschalten (Bypass)' : 'Equalizer einschalten'}
            onClick={() => onToggleEnabled(!enabled)}
            className="press flex items-center gap-[6px] rounded-pill px-[4px] py-[2px] text-micro font-medium text-stage-ink"
          >
            <span className={`flex h-[18px] w-[32px] shrink-0 items-center rounded-pill p-[2px] transition-colors duration-[var(--dur-fast)] ${enabled ? 'bg-stage-accent' : 'bg-stage-line'}`}>
              <span className={`h-[14px] w-[14px] rounded-pill bg-stage-ink transition-transform duration-[var(--dur-base)] ease-[var(--ease-settle)] ${enabled ? 'translate-x-[14px]' : ''}`} />
            </span>
          </button>

          {/* Close button */}
          <button
            type="button"
            aria-label="Equalizer schliessen"
            title="Schliessen"
            onClick={onClose}
            className="press grid h-[28px] w-[28px] place-items-center rounded-pill text-stage-muted hover:bg-stage-line/60 hover:text-stage-ink"
          >
            <svg viewBox="0 0 16 16" className="h-[14px] w-[14px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </div>

      {/* Preset Buttons Bar */}
      <div className="flex items-center gap-[5px] overflow-x-auto overscroll-contain px-[14px] py-[8px] border-b border-stage-line/40 scrollbar-none">
        <span className="text-micro font-medium text-stage-muted shrink-0 mr-[2px]">Preset:</span>
        {EQUALIZER_PRESET_NAMES.map((name) => {
          const isSelected = (activePreset === name && !currentMatchedPreset) || currentMatchedPreset === name
          return (
            <button
              key={name}
              type="button"
              onClick={() => onSelectPreset(name)}
              aria-pressed={isSelected}
              className={`press shrink-0 rounded-pill px-[9px] py-[4px] text-micro leading-none transition-colors duration-[var(--dur-fast)] ${
                isSelected
                  ? 'bg-stage-ink font-semibold text-stage'
                  : 'text-stage-ink ring-1 ring-inset ring-stage-line hover:bg-stage-soft'
              }`}
            >
              {name}
            </button>
          )
        })}
      </div>

      {/* Sliders Container: Rack Mode (5 vertical faders) or List Mode */}
      <div className={`p-[14px] transition-opacity duration-[var(--dur-fast)] ${enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
        {viewMode === 'rack' ? (
          <div className="flex flex-col gap-[6px]">
            <div className="grid grid-cols-5 gap-[6px] items-center">
              {EQUALIZER_BANDS.map((band, idx) => {
                const gain = gains[idx]
                const isZero = Math.abs(gain) < 0.1
                return (
                  <div key={band.id} className="flex flex-col items-center gap-[4px]">
                    <span className="text-micro font-medium text-stage-muted truncate w-full text-center" title={`${band.name} (${band.description})`}>
                      {band.name}
                    </span>

                    <button
                      type="button"
                      onClick={() => onGainChange(idx, 0)}
                      title={`${band.name} auf 0 dB zurücksetzen`}
                      className={`press value text-micro font-semibold tabular-nums rounded-[4px] px-[4px] py-[1px] transition-colors ${
                        !isZero ? 'text-stage-accent bg-stage-line/50' : 'text-stage-muted hover:text-stage-ink'
                      }`}
                    >
                      {formatDb(gain)}
                    </button>

                    <div className="relative flex h-[120px] w-full items-center justify-center py-[4px]">
                      {/* Center 0 dB guide line */}
                      <div className="pointer-events-none absolute inset-x-2 top-1/2 h-[1px] -translate-y-1/2 bg-stage-line/80 z-0" />
                      <input
                        type="range"
                        min={-12}
                        max={12}
                        step={0.5}
                        value={gain}
                        disabled={!enabled}
                        onChange={(e) => onGainChange(idx, Number(e.target.value))}
                        aria-label={`${band.name} ${band.displayFreq}`}
                        className="relative z-10 eq-slider-vertical"
                        style={{
                          writingMode: 'vertical-lr',
                          direction: 'rtl',
                          WebkitAppearance: 'slider-vertical',
                          width: '26px',
                          height: '112px',
                          cursor: enabled ? 'pointer' : 'default',
                          accentColor: 'var(--color-stage-accent)',
                        } as CSSProperties}
                      />
                    </div>

                    <span className="rounded-pill bg-stage-soft px-[5px] py-[1px] text-micro text-stage-ink font-mono font-medium">
                      {band.displayFreq}
                    </span>
                  </div>
                )
              })}
            </div>

            <div className="flex items-center justify-between text-micro text-stage-muted px-[4px] pt-[2px]">
              <span>+12 dB</span>
              <span className="text-stage-line font-medium">0 dB (Ref)</span>
              <span>-12 dB</span>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-[8px]">
            {EQUALIZER_BANDS.map((band, idx) => {
              const gain = gains[idx]
              return (
                <div key={band.id} className="flex flex-col gap-[3px]">
                  <div className="flex items-baseline justify-between text-small">
                    <span className="flex items-center gap-[6px]">
                      <span className="font-medium text-stage-ink">{band.name}</span>
                      <span className="rounded-pill bg-stage-soft px-[5px] py-[1px] text-micro text-stage-muted font-mono">
                        {band.displayFreq}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => onGainChange(idx, 0)}
                      title="Auf 0 dB zurücksetzen"
                      className="press value text-small font-semibold text-stage-accent hover:underline"
                    >
                      {formatDb(gain)}
                    </button>
                  </div>
                  <input
                    type="range"
                    min={-12}
                    max={12}
                    step={0.5}
                    value={gain}
                    disabled={!enabled}
                    onChange={(e) => onGainChange(idx, Number(e.target.value))}
                    aria-label={`${band.name} ${band.displayFreq}`}
                    style={{ '--color-ink': 'var(--color-stage-accent)' } as CSSProperties}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Drawer Footer */}
      <div className="flex items-center justify-between border-t border-stage-line/60 bg-stage-soft/40 px-[16px] py-[8px]">
        <div className="flex items-center gap-[6px] text-micro text-stage-muted">
          <span className="h-[6px] w-[6px] rounded-pill bg-stage-accent animate-pulse" />
          <span>Soft-Limiter schützt vor Übersteuerung</span>
        </div>

        <button
          type="button"
          disabled={isFlat}
          onClick={onReset}
          className="press rounded-nav px-[8px] py-[3px] text-micro font-medium text-stage-muted hover:text-stage-ink disabled:opacity-30 disabled:hover:text-stage-muted ring-1 ring-inset ring-stage-line"
        >
          Zurücksetzen
        </button>
      </div>
    </div>
    </>
  )
}
