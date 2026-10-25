/**
 * „Bis wohin?“ on a series' page: a point chosen in the series, and what it
 * takes to get there — episodes, time, the day at a pace, the pace for a day.
 *
 * The numbers come from `lib/watchPlan.ts`; this block only asks and reports.
 * How a figure was reached stands under it (episodes × length, minus the
 * opening, at the speed), so nothing here is a figure without its working.
 */

import { useEffect, useId, useMemo, useState } from 'react'

import { seasonName, seasonsOf, updateMerkItem, type MerkGoal, type SavedLinkItem } from '../../lib/merkliste'
import { minutesSeconds, rememberedSettings } from '../../lib/player'
import {
  dayLabel,
  dayText,
  decimal,
  finishAt,
  goalState,
  inLabel,
  lastPoint,
  lengthLabel,
  openingOf,
  paceFor,
  paceSetting,
  parseDay,
  pointLabel,
  recentPace,
  seasonEnd,
  standPoint,
  watchPlan,
  type PaceUnit,
  type PlanOptions,
  type PlanPoint,
  type PlanSeason,
  type WatchPlan,
} from '../../lib/watchPlan'
import { Button, Reveal, Select, TextInput, Toggle } from '../ui/primitives'
import { Stepper } from './merklisteShared'

const SPEEDS = [1, 1.25, 1.5, 1.75, 2]
const PREFS_KEY = 'sondra:merkliste:rechner'

interface Prefs {
  rate: number
  unit: PaceUnit
  speed: number
  skip: boolean
}

/** The last pace and options someone calculated with, on this device. */
function readPrefs(): Partial<Prefs> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null')
    return saved && typeof saved === 'object' ? (saved as Partial<Prefs>) : {}
  } catch {
    return {}
  }
}

function writePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // A convenience only: without storage the defaults come back next time.
  }
}

const samePoint = (a: PlanPoint | null | undefined, b: PlanPoint | null | undefined) =>
  Boolean(a && b && a.season === b.season && a.episode === b.episode)

const pillClass = (on: boolean) =>
  `press rounded-pill px-[11px] py-[4px] text-small ${
    on ? 'bg-ink font-semibold text-on-ink' : 'bg-raised text-prose ring-1 ring-inset ring-line hover:text-ink hover:ring-rule'
  }`

const linkClass = 'text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink'

/**
 * A figure in a sentence: the numbers in the face of things found, the words
 * around them in the face of the page — as `Stat` sets a value and its unit.
 */
function Figures({ text }: { text: string }) {
  const parts = text.split(/(\d+(?:[.,:’']\d+)*)/)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          <span key={i} className="value">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  )
}

/** „1 Folge“, „6 Folgen“; „2 Filme“, „63 Folgen, 2 Filme“ when films are among them. */
function episodesWord(count: number, films = 0): string {
  const filmWords = `${films} ${films === 1 ? 'Film' : 'Filme'}`
  if (films > 0 && films === count) return filmWords
  const regular = count - films
  return `${regular} ${regular === 1 ? 'Folge' : 'Folgen'}${films > 0 ? `, ${filmWords}` : ''}`
}

/** „1,4 Folgen am Tag“ from one a day, else „3 Folgen pro Woche“. */
function paceWords(perDay: number): string {
  if (perDay >= 1) return `${decimal(perDay)} ${perDay === 1 ? 'Folge' : 'Folgen'} am Tag`
  const perWeek = perDay * 7
  return `${decimal(perWeek)} ${perWeek === 1 ? 'Folge' : 'Folgen'} pro Woche`
}

export function WatchPlanner({ item, onSeason }: { item: SavedLinkItem; onSeason: (number: number, part: number) => void }) {
  const id = useId()
  const seasons = seasonsOf(item)
  const player = useMemo(() => rememberedSettings(), [])
  const opening = openingOf(item, player.opening)
  const measured = recentPace(item)

  // Starts at the goal kept on the series, else at its end.
  const fallback = item.goal ?? lastPoint(item) ?? seasonEnd(item) ?? standPoint(item)
  const [target, setTarget] = useState<PlanPoint>({ season: fallback.season, episode: fallback.episode })
  const [by, setBy] = useState(item.goal?.by ?? '')
  const [prefs, setPrefs] = useState<Prefs>(() => {
    const saved = readPrefs()
    const pace = measured ? paceSetting(measured.perDay) : null
    return {
      rate: pace?.rate ?? (typeof saved.rate === 'number' && saved.rate >= 1 ? Math.round(saved.rate) : 2),
      unit: pace?.unit ?? (saved.unit === 'week' ? 'week' : 'day'),
      speed: SPEEDS.includes(saved.speed as number) ? (saved.speed as number) : SPEEDS.includes(player.rate) ? player.rate : 1,
      skip: typeof saved.skip === 'boolean' ? saved.skip : player.skipOpening,
    }
  })
  const [fromStart, setFromStart] = useState(false)
  const change = (patch: Partial<Prefs>) =>
    setPrefs((current) => {
      const next = { ...current, ...patch }
      writePrefs(next)
      return next
    })

  // Another series opened in the same page: start over from its goal or end.
  useEffect(() => {
    const point = item.goal ?? lastPoint(item) ?? seasonEnd(item) ?? standPoint(item)
    setTarget({ season: point.season, episode: point.episode })
    setBy(item.goal?.by ?? '')
    setFromStart(false)
  }, [item.id])

  const options: PlanOptions = { from: fromStart ? 'start' : 'stand', speed: prefs.speed, skipOpening: prefs.skip ? opening.seconds : 0 }
  const targetSeason = seasons.find((season) => season.number === target.season) ?? seasons[0]
  const maxEpisode = targetSeason?.episodes ?? 9999
  // A season made shorter since the point was chosen pulls it back to its end.
  const point: PlanPoint = { season: targetSeason?.number ?? target.season, episode: Math.min(target.episode, maxEpisode) }
  const plan = watchPlan(item, point, options)
  const today = new Date()
  const finish = finishAt(plan.episodes, prefs.rate, prefs.unit, today)
  const byDay = parseDay(by)
  const needed = byDay ? paceFor(plan.episodes, plan.minutes, byDay, today) : null

  // Ends worth a click: this season's, and the whole series'.
  const ends: { label: string; point: PlanPoint }[] = []
  const thisEnd = seasonEnd(item)
  const allEnd = lastPoint(item)
  if (thisEnd && !samePoint(thisEnd, allEnd)) ends.push({ label: `Ende ${item.season === 0 ? 'der Filme' : `Staffel ${item.season}`}`, point: thisEnd })
  if (allEnd) ends.push({ label: 'Ganze Serie', point: allEnd })

  const goal = item.goal
  const goalHere = Boolean(goal && samePoint(goal, point) && (goal.by ?? '') === by)
  const keepGoal = () => {
    const next: MerkGoal = {
      season: point.season,
      episode: point.episode,
      ...(byDay ? { by } : {}),
      setAt: Date.now(),
      count: watchPlan(item, point, { ...options, from: 'stand' }).episodes,
    }
    updateMerkItem(item.id, { goal: next, updatedAt: Date.now() })
  }
  const dropGoal = () => updateMerkItem(item.id, { goal: undefined, updatedAt: Date.now() })

  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-[16px] rounded-card bg-panel-soft p-[16px] ring-1 ring-inset ring-line/70 sm:p-[20px]">
      <h3 id={`${id}-h`} className="text-subheading text-ink">
        Bis wohin?
      </h3>

      {/* The point: a season and an episode in it, or one of the ends. */}
      <div className="flex flex-col gap-[8px]">
        <div className="flex flex-wrap items-center gap-[8px]">
          <label htmlFor={`${id}-staffel`} className="text-small text-prose">
            Bis
          </label>
          <Select
            id={`${id}-staffel`}
            value={target.season}
            onChange={(event) => {
              const number = Number(event.target.value)
              const season = seasons.find((entry) => entry.number === number)
              setTarget({ season: number, episode: season?.episodes ?? Math.max(1, ...(season?.watched ?? [])) })
            }}
            className="!w-auto min-w-[8.5em]"
          >
            {seasons.map((season) => (
              <option key={season.number} value={season.number}>
                {seasonName(season)}
              </option>
            ))}
          </Select>
          <Stepper
            label={target.season === 0 ? 'Film' : 'Folge'}
            value={point.episode}
            max={maxEpisode}
            onChange={(episode) => setTarget({ ...point, episode })}
          />
          <span className="text-small text-prose">gesehen</span>
        </div>
        {ends.length ? (
          <div role="group" aria-label="Schnell wählen" className="flex flex-wrap gap-[6px]">
            {ends.map((end) => (
              <button key={end.label} type="button" aria-pressed={samePoint(end.point, point)} onClick={() => setTarget(end.point)} className={pillClass(samePoint(end.point, point))}>
                {end.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <Result plan={plan} target={point} item={item} options={options} openingSeconds={opening.seconds} onSeason={onSeason} />

      {plan.episodes > 0 ? (
        <div className="flex flex-col gap-[10px] border-t border-line pt-[14px]">
          {/* At a pace: the day. */}
          <div className="flex flex-wrap items-center gap-x-[8px] gap-y-[6px] text-small text-prose">
            <span>Bei</span>
            <Stepper label="Folgen" value={prefs.rate} max={50} onChange={(rate) => change({ rate })} />
            <Select
              aria-label="Folgen am Tag oder pro Woche"
              value={prefs.unit}
              onChange={(event) => change({ unit: event.target.value === 'week' ? 'week' : 'day' })}
              className="!w-auto"
            >
              <option value="day">am Tag</option>
              <option value="week">pro Woche</option>
            </Select>
            <span aria-live="polite">
              → <strong className="font-semibold text-ink">{dayLabel(finish.date, today)}</strong>
              {finish.days > 2 ? <Figures text={` · ${inLabel(finish.days)}`} /> : null}
            </span>
          </div>
          {measured ? (
            <p className="text-small text-prose">
              <Figures text={`Ihr Tempo zuletzt: ${paceWords(measured.perDay)} (${measured.count} in ${measured.days} Tagen)`} />
              {(() => {
                const pace = paceSetting(measured.perDay)
                return pace.rate === prefs.rate && pace.unit === prefs.unit ? null : (
                  <>
                    {' · '}
                    <button type="button" onClick={() => change(pace)} className={linkClass}>
                      übernehmen
                    </button>
                  </>
                )
              })()}
            </p>
          ) : null}

          {/* By a day: the pace. */}
          <div className="flex flex-wrap items-center gap-x-[8px] gap-y-[6px] text-small text-prose">
            <label htmlFor={`${id}-datum`}>Bis zum</label>
            <TextInput
              id={`${id}-datum`}
              type="date"
              value={by}
              min={dayText(today)}
              onChange={(event) => setBy(event.target.value)}
              className="!w-auto"
            />
            {needed ? (
              <span aria-live="polite">
                →{' '}
                <strong className="font-semibold text-ink">
                  <Figures text={paceWords(needed.perDay)} />
                </strong>
                <Figures text={` · ${lengthLabel(needed.minutesPerDay)} täglich`} />
              </span>
            ) : by && byDay && byDay < new Date(today.toDateString()) ? (
              <span>! Der Tag ist vorbei.</span>
            ) : (
              <span>→ wie viel am Tag</span>
            )}
          </div>
        </div>
      ) : null}

      <Reveal label="Genauer rechnen" className="border-line">
        <div className="flex flex-col gap-[12px] pt-[4px]">
          <Toggle
            label="Von vorn rechnen"
            hint="Auch Gesehenes zählt — für ein zweites Mal oder für jemanden, der neu anfängt."
            checked={fromStart}
            onChange={setFromStart}
          />
          <Toggle
            label="Vorspann überspringen"
            hint={`${minutesSeconds(opening.seconds)} je Folge, ${
              opening.source === 'heard' ? 'am Ton erkannt' : opening.source === 'series' ? 'an der Serie eingestellt' : 'wie im Player eingestellt'
            }.`}
            checked={prefs.skip}
            onChange={(skip) => change({ skip })}
          />
          <div className="flex flex-col gap-[6px]">
            <span className="text-small text-prose">Tempo der Wiedergabe</span>
            <div role="radiogroup" aria-label="Tempo der Wiedergabe" className="flex flex-wrap gap-[6px]">
              {SPEEDS.map((speed) => (
                <button key={speed} type="button" role="radio" aria-checked={prefs.speed === speed} onClick={() => change({ speed })} className={pillClass(prefs.speed === speed)}>
                  {decimal(speed, 2)}×
                </button>
              ))}
            </div>
          </div>
        </div>
      </Reveal>

      {/* Kept with the series: it travels with the list. */}
      <div className="flex flex-wrap items-center gap-x-[14px] gap-y-[8px]">
        {goalHere ? (
          <Button type="button" size="sm" variant="quiet" onClick={dropGoal}>
            Ziel entfernen
          </Button>
        ) : (
          <Button type="button" size="sm" variant="quiet" disabled={plan.behind} onClick={keepGoal}>
            {goal ? 'Als neues Ziel merken' : 'Als Ziel merken'}
          </Button>
        )}
        <span className="text-small text-prose">
          {goalHere ? 'Steht auf der Merkliste bei dieser Serie.' : `${pointLabel(point)}${byDay ? ` bis ${dayLabel(byDay, today)}` : ''}`}
        </span>
      </div>
    </section>
  )
}

/** The figure, the line through the series, and how the figure came about. */
function Result({
  plan,
  target,
  item,
  options,
  openingSeconds,
  onSeason,
}: {
  plan: WatchPlan
  target: PlanPoint
  item: SavedLinkItem
  options: PlanOptions
  openingSeconds: number
  onSeason: (number: number, part: number) => void
}) {
  const unknownNames = plan.unknown.map((number) => seasonName(seasonsOf(item).find((season) => season.number === number)!))
  const regular = plan.episodes - plan.films
  const perEpisode = regular > 0 ? Math.round((plan.rawMinutes - (plan.films ? sumFilms(item, plan) : 0)) / regular) : 0
  const skipped = options.skipOpening > 0 && regular > 0
  const sped = options.speed > 1

  return (
    <div className="flex flex-col gap-[10px]" aria-live="polite">
      {plan.behind ? (
        <p className="text-body text-ink">
          Schon gesehen — <span className="font-semibold">{pointLabel(target)}</span> liegt hinter Ihrem Stand.
        </p>
      ) : (
        <p className="flex flex-wrap items-baseline gap-x-[16px] gap-y-[4px] text-ink">
          <span className="text-heading-sm font-semibold leading-none">
            <Figures text={`${plan.unknown.length ? 'mind. ' : ''}${episodesWord(plan.episodes, plan.films)}`} />
          </span>
          <span className="text-subheading leading-none">
            <Figures text={lengthLabel(plan.minutes)} />
          </span>
        </p>
      )}

      <SeriesLine bar={plan.bar} target={target} />

      {!plan.behind && plan.episodes > 0 ? (
        <p className="text-small leading-[1.5] text-prose">
          {plan.first ? <>Ab {pointLabel(plan.first)}. </> : null}
          {plan.exceptions ? (
            <Figures
              text={`${episodesWord(plan.episodes, plan.films)}, davon ${plan.exceptions} mit eigener Länge${skipped || sped ? '' : ` — zusammen ${lengthLabel(plan.rawMinutes)}`}`}
            />
          ) : (
            <>
              {regular > 0 ? (
                <Figures text={`${episodesWord(regular)} à ${perEpisode} Min.`} />
              ) : null}
              {regular > 0 && plan.films ? ' und ' : null}
              {plan.films ? (
                <Figures text={`${plan.films} ${plan.films === 1 ? 'Film' : 'Filme'} à ${item.filmDuration ?? 90} Min.`} />
              ) : null}
            </>
          )}
          {skipped ? (
            <Figures text={`, ohne Vorspann (${minutesSeconds(openingSeconds)})`} />
          ) : null}
          {sped ? (
            <Figures text={`, bei ${decimal(options.speed, 2)}×`} />
          ) : null}
          {skipped || sped ? (
            <Figures text={` — statt ${lengthLabel(plan.rawMinutes)}`} />
          ) : null}
        </p>
      ) : null}

      {plan.unknown.length ? (
        <p className="text-small leading-[1.5] text-prose">
          ! {unknownNames.join(', ')} {plan.unknown.length === 1 ? 'hat' : 'haben'} noch keine Folgenzahl und {plan.unknown.length === 1 ? 'ist' : 'sind'} nicht
          mitgezählt.{' '}
          <button type="button" onClick={() => onSeason(plan.unknown[0], 0)} className={linkClass}>
            Folgenzahl eintragen
          </button>
        </p>
      ) : null}
    </div>
  )
}

function sumFilms(item: SavedLinkItem, plan: WatchPlan): number {
  const films = plan.bar.find((season) => season.number === 0)
  if (!films) return 0
  let minutes = 0
  for (const run of films.runs) if (run.kind === 'planned') minutes += (run.to - run.from + 1) * (item.filmDuration ?? 90)
  return minutes
}

/**
 * The series as one line: a stretch per season, as long as it has episodes,
 * seen in a light tone, what is to watch up to the point in ink, the rest
 * open. A season whose length is not known is drawn short and dashed.
 */
function SeriesLine({ bar, target }: { bar: PlanSeason[]; target: PlanPoint }) {
  if (!bar.length) return null
  const labelled = bar.length <= 12
  return (
    <div className="flex flex-col gap-[4px]">
      <div className="flex h-[10px] w-full gap-[3px]" aria-hidden>
        {bar.map((season) => (
          <span
            key={season.number}
            title={`${season.name}${season.known ? `: ${season.count} Folgen` : ' — Folgenzahl unbekannt'}`}
            className={`relative flex h-full min-w-[6px] overflow-hidden rounded-[3px] ${season.known ? '' : 'outline-1 outline-dashed outline-rule'}`}
            style={{ flexGrow: season.known ? season.count : Math.max(2, season.count), flexBasis: 0 }}
          >
            {season.runs.map((run) => (
              <span
                key={run.from}
                className={run.kind === 'planned' ? 'bg-ink' : run.kind === 'seen' ? 'bg-ink/30' : 'bg-panel-strong'}
                style={{ flexGrow: run.to - run.from + 1, flexBasis: 0 }}
              />
            ))}
            {season.number === target.season ? (
              <span
                className="absolute inset-y-[-2px] w-[2px] bg-ink"
                style={{ left: `calc(${(Math.min(target.episode, season.count) / season.count) * 100}% - 1px)` }}
              />
            ) : null}
          </span>
        ))}
      </div>
      {labelled ? (
        <div className="flex w-full gap-[3px] text-micro text-prose" aria-hidden>
          {bar.map((season) => (
            <span key={season.number} className="min-w-[6px] truncate" style={{ flexGrow: season.known ? season.count : Math.max(2, season.count), flexBasis: 0 }}>
              {season.number === 0 ? 'Filme' : season.number}
            </span>
          ))}
        </div>
      ) : null}
      <p className="sr-only">
        Die Serie als Linie je Staffel: Gesehenes getönt, was bis {pointLabel(target)} zu schauen ist gefüllt, der Rest leer.
      </p>
    </div>
  )
}

/**
 * The goal kept on a series, in one sentence: „Ziel: Staffel 2, Folge 12 bis
 * Mo., 30. Nov. — noch 21 Folgen, 4 pro Woche reichen · 2 vor dem Plan“.
 */
export function goalSentence(state: ReturnType<typeof goalState>, goal: MerkGoal, by: Date | null): string {
  const where = `${pointLabel(goal)}${by ? ` bis ${dayLabel(by)}` : ''}`
  if (state.reached) return `Ziel erreicht: ${where}`
  if (state.overdue) return `Ziel: ${where} — der Tag ist vorbei, noch ${episodesWord(state.left)}`
  const enough = state.perDay !== null ? paceWords(state.perDay).replace(/ Folgen? /, ' ') : null
  const pace = enough ? `, ${enough} ${enough.startsWith('1 ') ? 'reicht' : 'reichen'}` : ''
  const ahead =
    state.ahead === null || state.ahead === 0
      ? ''
      : state.ahead > 0
        ? ` · ${state.ahead} vor dem Plan`
        : ` · ${-state.ahead} hinter dem Plan`
  return `Ziel: ${where} — noch ${episodesWord(state.left)}${pace}${ahead}`
}
