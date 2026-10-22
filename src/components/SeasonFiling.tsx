/**
 * „In Staffel einordnen“: episodes in Google Drive put into a series' season
 * — a folder per series under „Sondra/Serien“, one per season inside it —
 * and noted on each file which episode it is. The Merkliste then knows the
 * file whatever it is called, and ticks it off when it is watched.
 *
 * A series not on the Merkliste yet is put on it: without an entry there
 * would be nothing to tick off.
 */

import { useMemo, useState } from 'react'

import { guessEpisode, normalTitle } from '../lib/episodeMatch'
import { matchFile, seasonPath, type FolderFile } from '../lib/folder'
import { DRIVE_PROBLEM, DriveError, fileIntoSeason } from '../lib/googleDrive'
import { createMerkItem, seasonName, seasonsOf, setMerkItems, updateMerkItem, useMerkliste, type SavedLinkItem } from '../lib/merkliste'
import { Button, Dialog, Notice, TextInput } from './ui/primitives'

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })
const GENERIC = /^(episode|episodes|folge|folgen|ep|staffel|season|teil|part|video|film|movie|clip)$/i
const linkClass = 'text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink'

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
  const [season, setSeason] = useState(String(start.season ?? start.item?.season ?? 1))
  // Each file's episode: as filed or named, else counting on from the one before.
  const [numbers, setNumbers] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    let last = 0
    for (const file of sorted) {
      const known = matchFile(file, items)?.episode ?? guessEpisode(file.name)?.episode ?? null
      last = known ?? last + 1
      out[file.path] = String(last)
    }
    return out
  })
  const [busy, setBusy] = useState<{ done: number } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const typed = normalTitle(name)
  const suggestions = useMemo(() => {
    const list = typed
      ? items.filter((item) => normalTitle(item.title).includes(typed) || typed.includes(normalTitle(item.title)))
      : items.filter((item) => item.status === 'watching')
    return [...list].sort((a, b) => Number(b.status === 'watching') - Number(a.status === 'watching') || collator.compare(a.title, b.title)).slice(0, 6)
  }, [items, typed])

  const seasonNumber = Number(season)
  const seasonOk = season.trim() !== '' && Number.isInteger(seasonNumber) && seasonNumber >= 0 && seasonNumber <= 99
  const episodes = sorted.map((file) => Number(numbers[file.path]))
  const episodesOk = episodes.every((value) => Number.isInteger(value) && value >= 1 && value <= 9999)
  const title = chosen?.title ?? name.trim()
  const ready = Boolean(title) && seasonOk && episodesOk && busy === null
  const target = seasonOk && title ? `Sondra/${seasonPath(title, seasonNumber).join('/')}` : null
  const knownSeasons = chosen ? seasonsOf(chosen).map((entry) => entry.number) : []

  const choose = (item: SavedLinkItem) => {
    setChosenId(item.id)
    setName(item.title)
    if (!seasonsOf(item).some((entry) => entry.number === seasonNumber)) setSeason(String(item.season ?? seasonsOf(item)[0]?.number ?? 1))
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
          season: seasonNumber,
          episode: Math.min(...episodes),
          seasons: [{ number: seasonNumber, episodes: null, watched: [] }],
        })
        const added = series
        setMerkItems((current) => [...current, added])
      } else if (!seasonsOf(series).some((entry) => entry.number === seasonNumber)) {
        updateMerkItem(series.id, (item) => ({
          seasons: [...seasonsOf(item), { number: seasonNumber, episodes: null, watched: [] }].sort((a, b) => a.number - b.number),
        }))
      }
      const id = series.id
      const where = await fileIntoSeason(
        sorted.map((entry, index) => ({
          id: entry.drive!.id,
          parent: entry.drive!.parent,
          hint: { series: id, season: seasonNumber, episode: episodes[index] },
        })),
        { title, season: seasonNumber, onProgress: (done) => setBusy({ done }) },
      )
      onFiled(where, sorted.length, seasonPath(title, seasonNumber).join('/'))
    } catch (error) {
      setProblem(error instanceof DriveError ? DRIVE_PROBLEM[error.code] : error instanceof Error ? error.message : String(error))
      setBusy(null)
    }
  }

  return (
    <Dialog open onClose={busy ? () => undefined : onClose} title="In Staffel einordnen" size="md">
      <div className="flex flex-col gap-[18px]">
        <p className="max-w-[60ch] text-small leading-[1.55] text-prose">
          {sorted.length === 1 ? 'Die Folge kommt' : `Die ${sorted.length} Folgen kommen`} in einen Ordner der Serie, darin in einen der
          Staffel. Die Merkliste erkennt sie dort an Staffel und Folge, wie die Datei auch heisst.
        </p>

        <div className="flex flex-col gap-[8px]">
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
            disabled={busy !== null}
          />
          {suggestions.length > 0 ? (
            <div role="group" aria-label="Serien der Merkliste" className="flex flex-wrap gap-[6px]">
              {suggestions.map((item) => {
                const on = item.id === chosenId
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={on}
                    disabled={busy !== null}
                    onClick={() => choose(item)}
                    className={`press rounded-pill px-[12px] py-[5px] text-small ${
                      on ? 'bg-ink font-semibold text-on-ink' : 'bg-panel-soft text-prose ring-1 ring-inset ring-line hover:bg-panel-mid hover:text-ink'
                    }`}
                  >
                    {item.title}
                  </button>
                )
              })}
            </div>
          ) : null}
          {title && !chosen ? <p className="text-small text-prose">Noch nicht auf der Merkliste — sie kommt beim Einordnen dazu.</p> : null}
        </div>

        <div className="flex flex-col gap-[8px]">
          <label htmlFor="einordnen-staffel" className="text-small font-semibold text-ink">
            Staffel
          </label>
          <div className="flex flex-wrap items-center gap-[8px]">
            <TextInput
              id="einordnen-staffel"
              type="number"
              inputMode="numeric"
              min={0}
              max={99}
              value={season}
              onChange={(event) => setSeason(event.target.value)}
              aria-describedby="einordnen-staffel-hinweis"
              disabled={busy !== null}
              className="!w-[88px]"
            />
            {knownSeasons
              .filter((number) => number !== seasonNumber)
              .map((number) => (
                <button
                  key={number}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setSeason(String(number))}
                  className="press rounded-pill bg-panel-soft px-[12px] py-[5px] text-small text-prose ring-1 ring-inset ring-line hover:bg-panel-mid hover:text-ink"
                >
                  {seasonName(seasonsOf(chosen!).find((entry) => entry.number === number)!)}
                </button>
              ))}
          </div>
          <p id="einordnen-staffel-hinweis" className="text-small text-prose">
            {seasonOk ? (seasonNumber === 0 ? '0 heisst Filme.' : null) : 'Eine Zahl von 0 bis 99; 0 heisst Filme.'}
          </p>
        </div>

        <fieldset className="flex flex-col gap-[6px]" disabled={busy !== null}>
          <legend className="mb-[6px] text-small font-semibold text-ink">Folgen</legend>
          <ul className="flex max-h-[260px] flex-col overflow-y-auto">
            {sorted.map((entry) => {
              const value = numbers[entry.path]
              const bad = !(Number.isInteger(Number(value)) && Number(value) >= 1)
              return (
                <li key={entry.path} className="flex items-center justify-between gap-[12px] border-t border-line py-[6px] first:border-t-0">
                  <span className="value min-w-0 truncate text-small text-ink" title={entry.path}>
                    {entry.name}
                  </span>
                  <label className="flex shrink-0 items-center gap-[6px] text-small text-prose">
                    Folge
                    <TextInput
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={value}
                      aria-invalid={bad}
                      aria-label={`Folge für ${entry.name}`}
                      onChange={(event) => setNumbers((current) => ({ ...current, [entry.path]: event.target.value }))}
                      className="!w-[76px]"
                    />
                  </label>
                </li>
              )
            })}
          </ul>
          {!episodesOk ? <p className="text-small text-prose">! Jede Folge braucht eine Nummer ab 1.</p> : null}
        </fieldset>

        {target ? (
          <p className="text-small text-prose">
            Nach <span className="value text-ink">{target}</span>
          </p>
        ) : null}

        {problem ? (
          <Notice tone="error" title="Nicht eingeordnet">
            {problem}
          </Notice>
        ) : null}

        <div className="flex flex-wrap items-center gap-[12px]">
          <Button type="button" disabled={!ready} onClick={() => void file()}>
            {busy ? `Ordnet ein … ${busy.done} / ${sorted.length}` : 'Einordnen'}
          </Button>
          <button type="button" onClick={onClose} disabled={busy !== null} className={`${linkClass} text-small`}>
            Abbrechen
          </button>
        </div>
      </div>
    </Dialog>
  )
}
