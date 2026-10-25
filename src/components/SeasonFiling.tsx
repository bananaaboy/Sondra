/**
 * „In Staffel einordnen“: episodes in Google Drive put into a series' season
 * — a folder per series under „Sondra/Serien“, one per season inside it —
 * and noted on each file which episode it is. The Merkliste then knows the
 * file whatever it is called, and ticks it off when it is watched.
 *
 * A series not on the Merkliste yet is put on it: without an entry there
 * would be nothing to tick off.
 *
 * Laid out as the question it is (25.10.2026, „design das Menü besser“):
 * on the left what it comes to — the poster, the season, the folder it goes
 * to —, on the right the three choices, series, season, episodes. Each file
 * says where its number came from, a number given twice or past the end of
 * the season is said where it happens, and a file can be left out. Before,
 * a bonus clip took „Folge 1“ beside S02E01 without a word.
 */

import { useMemo, useState } from 'react'

import { guessEpisode, normalTitle } from '../lib/episodeMatch'
import { matchFile, seasonPath, type FolderFile } from '../lib/folder'
import { DRIVE_PROBLEM, DriveError, fileIntoSeason } from '../lib/googleDrive'
import {
  createMerkItem,
  seasonName,
  seasonProgress,
  seasonsOf,
  setMerkItems,
  updateMerkItem,
  useMerkliste,
  type MerkSeason,
  type SavedLinkItem,
} from '../lib/merkliste'
import { CoverImage } from './CoverImage'
import { Stepper } from './panels/merklisteShared'
import { Button, Dialog, Notice, Progress, TextInput } from './ui/primitives'

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })
const GENERIC = /^(episode|episodes|folge|folgen|ep|staffel|season|teil|part|video|film|movie|clip)$/i
const linkClass = 'text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink'

/** Where a file's number came from: Sondra's note on it, its name, or counting on from the one before. */
type Source = 'note' | 'name' | 'counted'

interface Row {
  on: boolean
  episode: number
  source: Source
}

/** The series the files most likely are: what they were filed as, else what their names say. */
function firstGuess(files: FolderFile[], items: SavedLinkItem[]): { item: SavedLinkItem | null; name: string; season: number | null } {
  for (const file of files) {
    const match = matchFile(file, items)
    if (match) return { item: match.item, name: match.item.title, season: match.season }
  }
  const guess = files.map((file) => guessEpisode(file.name)).find(Boolean)
  // „Episode 01“ names no series: a word like that is no suggestion.
  const name = guess && !GENERIC.test(guess.title.trim()) ? guess.title : ''
  return { item: null, name, season: guess?.season ?? null }
}

/** Each file's episode as filed or named, else counting on from the one before. */
function guessedRows(files: FolderFile[], items: SavedLinkItem[]): Record<string, Row> {
  const out: Record<string, Row> = {}
  let last = 0
  for (const file of files) {
    const match = matchFile(file, items)
    // Filed before: Sondra's note on it, or a season's folder it lies in.
    const filed = Boolean(file.drive?.hint) || /(?:^|\/)Serien\/[^/]+\/(?:Staffel \d+|Filme)$/.test(file.dir)
    const named = guessEpisode(file.name)?.episode ?? null
    const episode = match?.episode ?? named ?? last + 1
    last = episode
    out[file.path] = { on: true, episode, source: match && filed ? 'note' : match || named !== null ? 'name' : 'counted' }
  }
  return out
}

/** The cover a series is shown with: its own, else its first season's. */
function coverOf(item: SavedLinkItem | null): { src: string; frame?: SavedLinkItem['coverFrame'] } | null {
  if (!item) return null
  if (item.cover) return { src: item.cover, frame: item.coverFrame }
  const first = seasonsOf(item).find((season) => season.cover)
  return first?.cover ? { src: first.cover, frame: first.coverFrame } : null
}

function Poster({ item, title, className = '' }: { item: SavedLinkItem | null; title: string; className?: string }) {
  const cover = coverOf(item)
  const [broken, setBroken] = useState<string | null>(null)
  const picture = cover && cover.src !== broken ? cover : null
  return (
    <span
      aria-hidden
      className={`relative block overflow-hidden ${picture ? 'bg-stage' : 'bg-panel-mid'} ${className}`}
      style={{ aspectRatio: item?.tileFormat === 'manga' ? '5 / 7' : '2 / 3' }}
    >
      {picture ? (
        <CoverImage src={picture.src} frame={picture.frame} onError={() => setBroken(picture.src)} />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center p-[12%] text-center font-semibold leading-[1.15] text-ink/45">
          <span className="line-clamp-4 break-words">{title || 'Serie'}</span>
        </span>
      )}
    </span>
  )
}

export function SeasonFilingDialog({
  files,
  onClose,
  onFiled,
}: {
  files: FolderFile[]
  onClose: () => void
  /** Where they went, how many, and the folder inside the scan to show. */
  onFiled: (where: string, count: number, dir: string) => void
}) {
  const items = useMerkliste()
  const sorted = useMemo(() => [...files].sort((a, b) => collator.compare(a.name, b.name)), [files])
  const [start] = useState(() => firstGuess(sorted, items))
  const [name, setName] = useState(start.name)
  const [chosenId, setChosenId] = useState<string | null>(start.item?.id ?? null)
  const chosen = items.find((item) => item.id === chosenId) ?? null
  const [season, setSeason] = useState(start.season ?? start.item?.season ?? 1)
  const [guessed] = useState(() => guessedRows(sorted, items))
  const [rows, setRows] = useState<Record<string, Row>>(guessed)
  const [busy, setBusy] = useState<{ done: number } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const typed = normalTitle(name)
  const suggestions = useMemo(() => {
    const list = typed
      ? items.filter((item) => normalTitle(item.title).includes(typed) || typed.includes(normalTitle(item.title)))
      : items.filter((item) => item.status === 'watching')
    return [...list].sort((a, b) => Number(b.status === 'watching') - Number(a.status === 'watching') || collator.compare(a.title, b.title)).slice(0, 6)
  }, [items, typed])

  const title = chosen?.title ?? name.trim()
  const known: MerkSeason[] = chosen ? seasonsOf(chosen) : []
  const target = known.find((entry) => entry.number === season) ?? null
  const length = target?.episodes ?? null
  const picked = sorted.filter((file) => rows[file.path].on)
  const numbers = picked.map((file) => rows[file.path].episode)
  const twice = new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i))
  const ready = Boolean(title) && picked.length > 0 && busy === null
  const path = title ? seasonPath(title, season) : null
  const nextSeason = Math.max(0, ...known.map((entry) => entry.number)) + 1
  const unit = season === 0 ? 'Film' : 'Folge'
  const units = season === 0 ? 'Filme' : 'Folgen'

  const setRow = (file: FolderFile, patch: Partial<Row>) => setRows((current) => ({ ...current, [file.path]: { ...current[file.path], ...patch } }))

  const choose = (item: SavedLinkItem) => {
    setChosenId(item.id)
    setName(item.title)
    if (!seasonsOf(item).some((entry) => entry.number === season)) setSeason(item.season ?? seasonsOf(item)[0]?.number ?? 1)
  }

  /** The chosen files numbered in the order they stand, from the lowest number among them. */
  const inOrder = () => {
    let next = Math.max(1, Math.min(...numbers))
    setRows((current) => {
      const out = { ...current }
      for (const file of sorted) if (out[file.path].on) out[file.path] = { ...out[file.path], episode: next++, source: 'counted' }
      return out
    })
  }

  const file = async () => {
    if (!ready) return
    setProblem(null)
    setBusy({ done: 0 })
    try {
      // The entry first, so its id goes onto the files.
      let series = chosen
      if (!series) {
        series = createMerkItem({
          title,
          status: 'watching',
          season,
          episode: Math.min(...numbers),
          seasons: [{ number: season, episodes: null, watched: [] }],
        })
        const added = series
        setMerkItems((current) => [...current, added])
      } else if (!seasonsOf(series).some((entry) => entry.number === season)) {
        updateMerkItem(series.id, (item) => ({
          seasons: [...seasonsOf(item), { number: season, episodes: null, watched: [] }].sort((a, b) => a.number - b.number),
        }))
      }
      const id = series.id
      const where = await fileIntoSeason(
        picked.map((entry) => ({
          id: entry.drive!.id,
          parent: entry.drive!.parent,
          hint: { series: id, season, episode: rows[entry.path].episode },
        })),
        { title, season, onProgress: (done) => setBusy({ done }) },
      )
      onFiled(where, picked.length, seasonPath(title, season).join('/'))
    } catch (error) {
      setProblem(error instanceof DriveError ? DRIVE_PROBLEM[error.code] : error instanceof Error ? error.message : String(error))
      setBusy(null)
    }
  }

  const locked = busy !== null

  return (
    <Dialog open onClose={locked ? () => undefined : onClose} title="In Staffel einordnen" size="lg">
      <div className="grid grid-cols-1 gap-x-[28px] gap-y-[20px] sm:grid-cols-[176px_minmax(0,1fr)]">
        {/* What it comes to. */}
        <aside aria-label="Ergebnis" className="hidden flex-col gap-[14px] sm:flex">
          <Poster item={chosen} title={title} className="w-full rounded-card" />
          <div className="flex flex-col gap-[2px]">
            <p className="text-body font-semibold leading-snug text-ink">{title || 'Noch keine Serie'}</p>
            <p className="text-small text-prose">
              {target ? seasonName(target) : season === 0 ? 'Filme' : `Staffel ${season}`}
              {target?.episodes ? ` · ${target.episodes} Folgen` : ''}
              {target && seasonProgress(target).watched ? ` · ${seasonProgress(target).watched} gesehen` : ''}
            </p>
            {title && !chosen ? <p className="text-small text-prose">Kommt neu auf die Merkliste.</p> : null}
            {chosen && !target ? <p className="text-small text-prose">Die Staffel kommt neu dazu.</p> : null}
          </div>
          {path ? <FolderTree path={path} count={picked.length} unit={picked.length === 1 ? unit : units} /> : null}
        </aside>

        <div className="flex min-w-0 flex-col gap-[22px]">
          {/* The series. */}
          <section className="flex flex-col gap-[8px]">
            <label htmlFor="einordnen-serie" className="text-small font-semibold text-ink">
              Serie
            </label>
            <TextInput
              id="einordnen-serie"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                const exact = items.find((item) => normalTitle(item.title) === normalTitle(event.target.value))
                setChosenId(exact?.id ?? null)
              }}
              placeholder="Name der Serie"
              autoComplete="off"
              disabled={locked}
            />
            {suggestions.length > 0 ? (
              <div role="group" aria-label="Serien der Merkliste" className="flex flex-wrap gap-[8px]">
                {suggestions.map((item) => {
                  const on = item.id === chosenId
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={on}
                      disabled={locked}
                      onClick={() => choose(item)}
                      className={`press flex max-w-[220px] items-center gap-[8px] rounded-nav py-[4px] pl-[4px] pr-[12px] text-left text-small ${
                        on ? 'bg-ink font-semibold text-on-ink' : 'bg-raised text-prose ring-1 ring-inset ring-line hover:text-ink hover:ring-rule'
                      }`}
                    >
                      <Poster item={item} title={item.title} className="w-[22px] shrink-0 rounded-[4px]" />
                      <span className="truncate">{item.title}</span>
                    </button>
                  )
                })}
              </div>
            ) : null}
          </section>

          {/* The season. */}
          <section className="flex flex-col gap-[10px] border-t border-line pt-[16px]">
            <div className="flex flex-wrap items-center justify-between gap-x-[12px] gap-y-[8px]">
              <span id="einordnen-staffel" className="text-small font-semibold text-ink">
                Staffel
              </span>
              <Stepper label="Staffel" value={season} min={0} max={99} onChange={setSeason} />
            </div>
            {known.length || chosen ? (
              <div role="group" aria-labelledby="einordnen-staffel" className="flex flex-wrap gap-[6px]">
                {known.map((entry) => (
                  <button
                    key={entry.number}
                    type="button"
                    aria-pressed={entry.number === season}
                    disabled={locked}
                    onClick={() => setSeason(entry.number)}
                    className={pill(entry.number === season)}
                  >
                    {seasonName(entry)}
                  </button>
                ))}
                {chosen && !known.some((entry) => entry.number === nextSeason) ? (
                  <button type="button" aria-pressed={season === nextSeason} disabled={locked} onClick={() => setSeason(nextSeason)} className={pill(season === nextSeason)}>
                    Neu: Staffel {nextSeason}
                  </button>
                ) : null}
              </div>
            ) : null}
            {season === 0 ? <p className="text-small text-prose">0 heisst Filme.</p> : null}
            <EpisodeStrip season={target} incoming={numbers} twice={twice} unit={unit} />
          </section>

          {/* The episodes. */}
          <fieldset aria-labelledby="einordnen-folgen" className="flex min-w-0 flex-col gap-[6px] border-t border-line pt-[16px]" disabled={locked}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-[12px] gap-y-[4px]">
              <span id="einordnen-folgen" className="text-small font-semibold text-ink">
                {units} <span className="value font-normal text-prose">{picked.length}/{sorted.length}</span>
              </span>
              <span className="flex flex-wrap gap-x-[14px] text-small">
                {picked.length > 1 ? (
                  <button type="button" onClick={inOrder} className={linkClass}>
                    Der Reihe nach nummerieren
                  </button>
                ) : null}
                {Object.keys(guessed).some((key) => guessed[key].episode !== rows[key].episode || !rows[key].on) ? (
                  <button type="button" onClick={() => setRows(guessed)} className={linkClass}>
                    Wie erkannt
                  </button>
                ) : null}
              </span>
            </div>
            <ul className="flex max-h-[min(340px,40vh)] flex-col overflow-y-auto">
              {sorted.map((entry) => {
                const row = rows[entry.path]
                const past = row.on && length !== null && row.episode > length
                const double = row.on && twice.has(row.episode)
                return (
                  <li key={entry.path} className="max-w-none border-t border-line py-[7px] first:border-t-0">
                    <div className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-[10px]">
                      <input
                        type="checkbox"
                        checked={row.on}
                        onChange={(event) => setRow(entry, { on: event.target.checked })}
                        aria-label={`${entry.name} einordnen`}
                        className="size-[16px]"
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className={`value truncate text-small ${row.on ? 'text-ink' : 'text-prose line-through decoration-rule'}`} title={entry.path}>
                          {entry.name}
                        </span>
                        <span className="text-micro text-prose">
                          {!row.on
                            ? 'bleibt, wo sie ist'
                            : row.source === 'note'
                              ? 'schon eingeordnet'
                              : row.source === 'name'
                                ? 'Nummer aus dem Namen'
                                : 'weitergezählt — bitte prüfen'}
                        </span>
                      </span>
                      <span className={row.on ? '' : 'opacity-40'}>
                        <Stepper label={`${unit} für ${entry.name}`} value={row.episode} max={9999} onChange={(episode) => setRow(entry, { episode, on: true })} />
                      </span>
                    </div>
                    {double || past ? (
                      <p className="mt-[4px] pl-[28px] text-small text-ink">
                        ! {double ? `${unit} ${row.episode} kommt mehrmals vor.` : `Staffel hat ${length} Folgen.`}
                      </p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </fieldset>

          {path ? (
            <p className="text-small text-prose sm:hidden">
              Nach <span className="value text-ink">Sondra/{path.join('/')}</span>
            </p>
          ) : null}

          {problem ? (
            <Notice tone="error" title="Nicht eingeordnet">
              {problem}
            </Notice>
          ) : null}

          {busy ? <Progress value={busy.done / Math.max(1, picked.length)} label={`Ordnet ein … ${busy.done} von ${picked.length}`} /> : null}

          <div className="flex flex-wrap items-center gap-[12px] border-t border-line pt-[16px]">
            <Button type="button" disabled={!ready} onClick={() => void file()}>
              {picked.length === 0 ? 'Nichts gewählt' : `${picked.length} ${picked.length === 1 ? unit : units} einordnen`}
            </Button>
            <button type="button" onClick={onClose} disabled={locked} className={`${linkClass} text-small`}>
              Abbrechen
            </button>
            {!title ? <span className="text-small text-prose">Zuerst eine Serie wählen oder eintippen.</span> : null}
          </div>
        </div>
      </div>
    </Dialog>
  )
}

const pill = (on: boolean) =>
  `press rounded-pill px-[12px] py-[5px] text-small ${
    on ? 'bg-ink font-semibold text-on-ink' : 'bg-raised text-prose ring-1 ring-inset ring-line hover:text-ink hover:ring-rule'
  }`

/**
 * The season as a row of its episodes: the ones already seen in a light
 * tone, the ones coming in from this selection in ink, one given twice with
 * a mark — so a gap or a clash shows before anything moves.
 */
function EpisodeStrip({ season, incoming, twice, unit }: { season: MerkSeason | null; incoming: number[]; twice: Set<number>; unit: string }) {
  const length = season?.episodes ?? null
  const highest = Math.max(0, ...incoming, ...(season?.watched ?? []))
  const count = Math.min(200, Math.max(length ?? 0, highest))
  if (!count) return null
  const coming = new Set(incoming)
  return (
    <div className="flex flex-col gap-[6px]">
      <div className="flex flex-wrap gap-[3px]" aria-hidden>
        {Array.from({ length: count }, (_, i) => i + 1).map((n) => {
          const seen = season?.watched.includes(n) ?? false
          const past = length !== null && n > length
          return (
            <span
              key={n}
              title={`${unit} ${n}${coming.has(n) ? ' — kommt hierher' : ''}${seen ? ', gesehen' : ''}`}
              className={`value grid h-[22px] min-w-[26px] place-items-center rounded-[5px] px-[3px] text-micro ${
                coming.has(n)
                  ? twice.has(n)
                    ? 'bg-ink text-on-ink ring-2 ring-inset ring-panel-strong'
                    : 'bg-ink text-on-ink'
                  : seen
                    ? 'bg-panel-strong text-ink'
                    : 'bg-raised text-prose ring-1 ring-inset ring-line'
              } ${past ? 'outline-1 outline-dashed outline-rule' : ''}`}
            >
              {twice.has(n) ? `${n}!` : n}
            </span>
          )
        })}
      </div>
      <p className="text-small text-prose">
        {length !== null ? `${length} Folgen bekannt. ` : 'Folgenzahl der Staffel noch unbekannt. '}
        Gefüllt: was jetzt dazukommt{season?.watched.length ? ', getönt: schon gesehen' : ''}.
      </p>
    </div>
  )
}

/** Where the files go, as the folders in Drive: Sondra › Serien › Titel › Staffel n. */
function FolderTree({ path, count, unit }: { path: string[]; count: number; /** „Folge“ or „Folgen“, as the count asks. */ unit: string }) {
  const steps = ['Sondra', ...path]
  return (
    <div className="flex flex-col gap-[6px] border-t border-line pt-[12px]">
      <span className="text-small text-prose">In Google Drive nach</span>
      <ol className="flex flex-col gap-[3px]">
        {steps.map((step, i) => (
          <li key={i} className="flex min-w-0 max-w-none items-center gap-[6px] text-small" style={{ paddingLeft: `${i * 10}px` }}>
            <svg viewBox="0 0 16 16" aria-hidden className="size-[13px] shrink-0 text-ink" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round">
              <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
            </svg>
            <span className={`truncate ${i === steps.length - 1 ? 'font-semibold text-ink' : 'text-prose'}`}>{step}</span>
          </li>
        ))}
      </ol>
      <span className="value pl-[40px] text-small text-ink">
        + {count} {unit}
      </span>
    </div>
  )
}
