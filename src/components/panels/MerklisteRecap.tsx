/**
 * „Rückblick“ in the statistics: one year of watching, from the dates kept
 * with every episode ticked off. Plain figures and twelve bars — what was
 * watched, for how long, which month, which series — and, said once, since
 * when anything is dated at all.
 */

import { useMemo, useState } from 'react'

import { formatWatchMinutes, type SavedLinkItem } from '../../lib/merkliste'
import { recapYears, recordedSince, yearRecap } from '../../lib/recap'

const MONTH = new Intl.DateTimeFormat('de-CH', { month: 'short' })
const MONTH_LONG = new Intl.DateTimeFormat('de-CH', { month: 'long' })
const DAY = new Intl.DateTimeFormat('de-CH', { day: 'numeric', month: 'long' })

export function MerklisteRecap({ items }: { items: SavedLinkItem[] }) {
  const years = useMemo(() => recapYears(items), [items])
  const since = useMemo(() => recordedSince(items), [items])
  const [chosen, setChosen] = useState<number | null>(null)
  const year = chosen !== null && years.includes(chosen) ? chosen : (years[0] ?? new Date().getFullYear())
  const recap = useMemo(() => yearRecap(items, year), [items, year])

  if (years.length === 0) {
    return (
      <section aria-labelledby="rueckblick" className="flex flex-col gap-[8px] border-t border-line pt-[16px]">
        <h3 id="rueckblick" className="text-subheading text-ink">
          Rückblick
        </h3>
        <p className="max-w-[60ch] text-small leading-[1.55] text-prose">
          Noch nichts mit Datum. Eine Folge, die Sie in der Merkliste abhaken oder im Player zu Ende schauen, erscheint hier — mit dem Tag, an dem es war.
        </p>
      </section>
    )
  }

  const time = formatWatchMinutes(recap.minutes)
  const [y, m, d] = recap.busiestDay ? recap.busiestDay.day.split('-').map(Number) : [0, 0, 0]
  const peak = Math.max(1, ...recap.byMonth)
  return (
    <section aria-labelledby="rueckblick" className="flex flex-col gap-[16px] border-t border-line pt-[16px]">
      <div className="flex flex-wrap items-center justify-between gap-[10px]">
        <h3 id="rueckblick" className="text-subheading text-ink">
          Rückblick {year}
        </h3>
        {years.length > 1 ? (
          <div role="radiogroup" aria-label="Jahr" className="flex flex-wrap gap-[6px]">
            {years.map((entry) => (
              <button
                key={entry}
                type="button"
                role="radio"
                aria-checked={entry === year}
                onClick={() => setChosen(entry)}
                className={`press rounded-pill px-[12px] py-[5px] text-small font-medium transition-colors duration-[var(--dur-fast)] ${
                  entry === year ? 'bg-ink text-on-ink' : 'bg-panel-soft text-ink hover:bg-panel-mid'
                }`}
              >
                {entry}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {recap.episodes === 0 ? (
        <p className="text-small text-prose">In {year} wurde nichts mit Datum abgehakt.</p>
      ) : (
        <>
          <dl key={year} className="rise grid grid-cols-2 gap-x-[20px] gap-y-[14px] sm:grid-cols-4">
            <div className="flex flex-col gap-[2px]">
              <dt className="text-small text-prose">Folgen</dt>
              <dd className="value pop text-headline font-bold text-ink">{recap.episodes}</dd>
            </div>
            <div className="flex flex-col gap-[2px]">
              <dt className="text-small text-prose">Sehzeit</dt>
              <dd className="value pop text-headline font-bold text-ink" title={time.long}>
                {time.short}
              </dd>
            </div>
            <div className="flex flex-col gap-[2px]">
              <dt className="text-small text-prose">Stärkster Monat</dt>
              <dd className="text-body font-semibold text-ink">
                {recap.busiestMonth ? MONTH_LONG.format(new Date(year, recap.busiestMonth.month, 1)) : '—'}
                <span className="value ml-[6px] text-small font-normal text-prose">{recap.busiestMonth?.episodes} {recap.busiestMonth?.episodes === 1 ? 'Folge' : 'Folgen'}</span>
              </dd>
            </div>
            <div className="flex flex-col gap-[2px]">
              <dt className="text-small text-prose">Längste Serie von Tagen</dt>
              <dd className="text-body font-semibold text-ink">
                {recap.streak} {recap.streak === 1 ? 'Tag' : 'Tage'}
                {recap.busiestDay && recap.busiestDay.episodes > 1 ? (
                  <span className="mt-[2px] block text-small font-normal text-prose">
                    Am meisten an einem Tag: {recap.busiestDay.episodes} am {DAY.format(new Date(y, m - 1, d))}
                  </span>
                ) : null}
              </dd>
            </div>
          </dl>

          <div role="img" aria-label={`Folgen je Monat ${year}: ${recap.byMonth.map((count, index) => `${MONTH.format(new Date(year, index, 1))} ${count}`).join(', ')}`} className="grid grid-cols-12 items-end gap-[6px]">
            {recap.byMonth.map((count, index) => (
              <div key={index} className="flex flex-col items-center gap-[4px]">
                <span className="value text-micro text-prose">{count || ''}</span>
                <span
                  className="block w-full origin-bottom rounded-[3px] bg-ink"
                  style={{ height: `${Math.max(count ? 6 : 2, Math.round((count / peak) * 64))}px`, opacity: count ? 1 : 0.15 }}
                />
                <span className="text-micro text-prose">{MONTH.format(new Date(year, index, 1)).replace('.', '')}</span>
              </div>
            ))}
          </div>

          {recap.top.length > 0 ? (
            <ol className="rise-list flex flex-col">
              {recap.top.map((row, index) => (
                <li key={row.id} className="flex max-w-none items-baseline gap-[10px] border-t border-line py-[7px] first:border-t-0">
                  <span className="value w-[1.5ch] text-small text-prose">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-small font-semibold text-ink" title={row.title}>
                    {row.title}
                  </span>
                  <span className="value shrink-0 text-small text-prose">
                    {row.episodes} {row.episodes === 1 ? 'Folge' : 'Folgen'} · {formatWatchMinutes(row.minutes).short}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          {recap.finished > 0 ? (
            <p className="text-small text-prose">
              {recap.finished} {recap.finished === 1 ? 'Serie' : 'Serien'} {recap.finished === 1 ? 'wurde' : 'wurden'} in diesem Jahr fertig.
            </p>
          ) : null}
        </>
      )}
      {since ? (
        <p className="max-w-[64ch] text-micro leading-[1.5] text-prose">
          Mit Datum festgehalten seit dem {new Intl.DateTimeFormat('de-CH', { dateStyle: 'long' }).format(new Date(since))} — was davor abgehakt wurde, trägt kein Datum und zählt hier nicht.
        </p>
      ) : null}
    </section>
  )
}
