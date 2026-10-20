/**
 * Season and episode for the address in the downloader, as one control.
 *
 * It was a row of its own: a choice „Staffeln / Filme", a stepper for the
 * season, one for the episode, a switch „Ganze Staffel" and a button „Nächste
 * Folge" — five controls in five shapes for one position. Now the position is
 * one line, „Staffel 2 · Folge 5", with a step back and a step on either
 * side; a click on it opens the seasons and the episodes as numbers. When the
 * address is on the Merkliste, the episodes already seen are marked there.
 */

import { useEffect, useRef, useState } from 'react'

import { seasonProgress, seasonsOf, type SavedLinkItem } from '../../lib/merkliste'
import { Toggle } from '../ui/primitives'

function Chevron({ direction }: { direction: 'left' | 'right' | 'down' }) {
  const d = direction === 'left' ? 'M10 3.5L5.5 8l4.5 4.5' : direction === 'right' ? 'M6 3.5L10.5 8 6 12.5' : 'M4 6l4 4 4-4'
  return (
    <svg viewBox="0 0 16 16" className="size-[14px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}

export function EpisodePicker({
  kind,
  season,
  episode,
  merk,
  onChange,
}: {
  kind: 'series' | 'list'
  season: number
  episode: number | null
  /** The Merkliste entry for this address, if there is one. */
  merk?: SavedLinkItem
  /** `look` asks for the new position to be looked up straight away. */
  onChange: (season: number, episode: number | null, look: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Closes on a click anywhere else and on Escape, like every other popover.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const known = merk ? seasonsOf(merk) : []
  const merkSeason = known.find((entry) => entry.number === season)
  const unit = kind === 'list' ? 'Nr.' : season === 0 ? 'Film' : 'Folge'
  const label =
    kind === 'list'
      ? episode
        ? `Nr. ${episode}`
        : 'Ganze Liste'
      : season === 0
        ? episode
          ? `Film ${episode}`
          : 'Alle Filme'
        : episode
          ? `Staffel ${season} · Folge ${episode}`
          : `Staffel ${season} · alle Folgen`

  const seasonNumbers = (() => {
    const highest = Math.max(season, ...known.map((entry) => entry.number), 1)
    return Array.from({ length: highest + 1 }, (_, i) => i + 1)
  })()
  const episodeCount = merkSeason?.episodes ?? Math.max(24, (episode ?? 0) + 6)
  const last = merkSeason?.episodes ?? null

  const stepButton = 'press flex w-[36px] items-center justify-center text-ink hover:bg-panel-soft disabled:opacity-35'

  return (
    <div ref={rootRef} className="relative">
      <span className="inline-flex h-[36px] items-stretch overflow-hidden rounded-nav bg-raised ring-1 ring-inset ring-rule">
        <button
          type="button"
          aria-label={`Vorherige ${unit === 'Nr.' ? 'Nummer' : unit}`}
          disabled={episode === null || episode <= 1}
          onClick={() => episode && onChange(season, episode - 1, true)}
          className={stepButton}
        >
          <Chevron direction="left" />
        </button>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="press flex items-center gap-[8px] border-x border-line px-[14px] text-small text-ink hover:bg-panel-soft"
        >
          {label}
          <Chevron direction="down" />
        </button>
        <button
          type="button"
          aria-label={`Nächste ${unit === 'Nr.' ? 'Nummer' : unit}`}
          disabled={episode === null || (last !== null && episode >= last)}
          onClick={() => episode && onChange(season, episode + 1, true)}
          className={stepButton}
        >
          <Chevron direction="right" />
        </button>
      </span>

      {open ? (
        <div
          role="dialog"
          aria-label={kind === 'list' ? 'Stelle in der Liste wählen' : 'Staffel und Folge wählen'}
          className="rise absolute left-0 top-[calc(100%+6px)] z-30 flex w-[min(440px,calc(100vw-32px))] flex-col gap-[14px] rounded-card bg-raised p-[14px] shadow-lift ring-1 ring-line"
        >
          {kind === 'series' ? (
            <div className="flex flex-col gap-[8px]">
              <span className="text-small text-prose">Staffel</span>
              <div className="flex flex-wrap gap-[4px]">
                {seasonNumbers.map((number) => {
                  const entry = known.find((item) => item.number === number)
                  const done = entry ? seasonProgress(entry).complete : false
                  return (
                    <button
                      key={number}
                      type="button"
                      aria-pressed={season === number}
                      onClick={() => onChange(number, episode === null ? null : 1, false)}
                      className={`press value min-w-[36px] rounded-nav px-[8px] py-[7px] text-small ${
                        season === number
                          ? 'bg-ink text-on-ink'
                          : done
                            ? 'bg-panel-strong text-ink'
                            : 'bg-panel-soft text-prose ring-1 ring-inset ring-line hover:bg-panel-mid'
                      }`}
                      title={done ? 'Ganz gesehen' : undefined}
                    >
                      {number}
                    </button>
                  )
                })}
                <button
                  type="button"
                  aria-pressed={season === 0}
                  onClick={() => onChange(0, episode === null ? null : 1, false)}
                  className={`press rounded-nav px-[10px] py-[7px] text-small ${
                    season === 0 ? 'bg-ink text-on-ink' : 'bg-panel-soft text-prose ring-1 ring-inset ring-line hover:bg-panel-mid'
                  }`}
                >
                  Filme
                </button>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-[8px]">
            <span className="flex items-baseline justify-between gap-[12px] text-small text-prose">
              {kind === 'list' ? 'Nummer in der Liste' : season === 0 ? 'Film' : 'Folge'}
              {merkSeason ? (
                <span className="text-muted">
                  {merkSeason.watched.length} gesehen{merkSeason.episodes ? ` von ${merkSeason.episodes}` : ''}
                </span>
              ) : null}
            </span>
            <div className="grid max-h-[220px] grid-cols-[repeat(auto-fill,minmax(40px,1fr))] gap-[4px] overflow-y-auto pr-[2px]">
              {Array.from({ length: episodeCount }, (_, i) => i + 1).map((number) => {
                const seen = merkSeason?.watched.includes(number) ?? false
                const here = episode === number
                return (
                  <button
                    key={number}
                    type="button"
                    aria-pressed={here}
                    aria-label={`${unit} ${number}${seen ? ', gesehen' : ''}`}
                    onClick={() => {
                      onChange(season, number, true)
                      setOpen(false)
                    }}
                    className={`press value flex h-[34px] items-center justify-center rounded-nav text-small ${
                      here
                        ? 'bg-ink text-on-ink'
                        : seen
                          ? 'bg-panel-strong text-ink'
                          : 'bg-panel-soft text-prose ring-1 ring-inset ring-line hover:bg-panel-mid'
                    }`}
                  >
                    {number}
                  </button>
                )
              })}
            </div>
            {merkSeason ? (
              <span className="flex items-center gap-[8px] text-small text-muted">
                <span aria-hidden className="size-[12px] rounded-[3px] bg-panel-strong" /> gesehen laut Merkliste
              </span>
            ) : null}
          </div>

          <div className="border-t border-line pt-[10px]">
            <Toggle
              label={kind === 'list' ? 'Die ganze Liste laden' : season === 0 ? 'Alle Filme laden' : 'Die ganze Staffel laden'}
              checked={episode === null}
              onChange={(whole) => {
                onChange(season, whole ? null : 1, true)
                setOpen(false)
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
