/**
 * Everything the app can do, one keystroke away.
 *
 * A tool bar with eight entries is already at the edge of what can be scanned,
 * and each entry hides several capabilities behind it — "Umwandeln" does not
 * say the word "MP3" anywhere. Rather than growing the bar until it is a menu,
 * the capabilities are searchable: type what you want, in your own words,
 * German or English, and the thing that does it comes up.
 *
 * It also answers the question a tab bar cannot: which of these apply to the
 * file I have open? Actions for the selected file are listed first and marked.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { ACTIONS, GROUP_LABEL, searchActions, type ToolAction, type ToolGroup } from '../lib/actions'
import { formatBytes } from '../lib/format'
import { KIND_LABEL, useSession } from '../state/store'

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  const assets = useSession((state) => state.assets)
  const activeId = useSession((state) => state.activeAssetId)
  const setPanel = useSession((state) => state.setPanel)
  const setActiveAsset = useSession((state) => state.setActiveAsset)
  const active = assets.find((asset) => asset.id === activeId) ?? null

  /* -- the shortcut --------------------------------------------------------- */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const node = dialogRef.current
    if (!node) return
    if (open && !node.open) {
      node.showModal()
      setQuery('')
      setCursor(0)
      // The dialog has to be showing before the field can take focus.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
    if (!open && node.open) node.close()
  }, [open])

  /* -- what to show --------------------------------------------------------- */
  const matches = useMemo(() => {
    const found = query.trim() ? searchActions(query) : ACTIONS
    if (!active) return found
    // Sorted, not filtered: a tool that does not fit the open file is still
    // worth finding — it just should not be the first thing offered.
    return [...found].sort((a, b) => {
      const fits = (action: ToolAction) => (action.kinds.includes(active.kind) ? 0 : 1)
      return fits(a) - fits(b)
    })
  }, [query, active])

  const files = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return []
    return assets.filter((asset) => asset.name.toLowerCase().includes(term)).slice(0, 4)
  }, [query, assets])

  /**
   * The flat list, but ordered so the headings come out in a sensible order.
   *
   * Thirty capabilities in one column is a wall. Grouped under five headings
   * it is a menu — and when a file is open, the group that fits it comes
   * first, so the answer to "what can I do with this" is at the top rather
   * than somewhere in the middle.
   */
  const rows = useMemo(() => {
    const order: ToolGroup[] = ['holen', 'ton', 'musik', 'video', 'bild']
    const preferred = active
      ? ({ audio: 'ton', video: 'video', image: 'bild' } as Partial<Record<string, ToolGroup>>)[active.kind]
      : undefined
    const groups = preferred ? [preferred, ...order.filter((g) => g !== preferred)] : order

    const actions: { kind: 'action'; action: ToolAction; heading?: string }[] = []
    for (const group of groups) {
      const inGroup = matches.filter((action) => action.group === group)
      for (const [index, action] of inGroup.entries()) {
        actions.push({ kind: 'action', action, heading: index === 0 ? GROUP_LABEL[group] : undefined })
      }
    }

    return [
      ...files.map((file, index) => ({
        kind: 'file' as const,
        file,
        heading: index === 0 ? ('Dateien in dieser Sitzung' as string | undefined) : undefined,
      })),
      ...actions,
    ]
  }, [files, matches, active])

  useEffect(() => setCursor(0), [query])

  const choose = (index: number) => {
    const row = rows[index]
    if (!row) return
    if (row.kind === 'file') setActiveAsset(row.file.id)
    else if (row.action.id === 'shortcuts') {
      window.dispatchEvent(new Event('sondra:tastenkuerzel'))
    } else setPanel(row.action.panel)
    setOpen(false)
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={() => setOpen(false)}
      onClick={(event) => {
        if (event.target === dialogRef.current) setOpen(false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setCursor((value) => Math.min(rows.length - 1, value + 1))
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setCursor((value) => Math.max(0, value - 1))
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          choose(cursor)
        }
      }}
      className="m-auto w-[min(620px,calc(100vw-24px))] rounded-card bg-canvas p-0 text-prose backdrop:bg-ink/50 backdrop:backdrop-blur-[3px]"
    >
      <div className="flex max-h-[min(70vh,560px)] flex-col">
        <div className="flex items-center gap-[8px] border-b border-line px-[16px] py-[16px]">
          <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-muted" fill="none" aria-hidden>
            <circle cx="7" cy="7" r="4.4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.4 10.4L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Was möchten Sie tun? — „mp3“, „video schneiden“, „tonart“…"
            aria-label="Werkzeug suchen"
            className="w-full border-0 bg-transparent text-body text-prose outline-none placeholder:text-muted"
          />
          <kbd className="hidden shrink-0 rounded-nav bg-panel-soft px-[8px] py-[4px] font-mono text-micro text-muted sm:block">
            Esc
          </kbd>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-[8px]">
          {rows.length === 0 ? (
            <div className="px-[12px] py-[16px]">
              <p className="text-small text-muted">
                Nichts gefunden. Suchen Sie nach dem Ergebnis, nicht nach dem Verfahren:
              </p>
              <div className="mt-[8px] flex flex-wrap gap-[8px]">
                {['mp3', 'video schneiden', 'gesang', 'kleiner machen', 'tonart', 'stille'].map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => setQuery(example)}
                    className="press bg-panel-soft px-[8px] py-[4px] text-small text-ink hover:bg-panel-mid"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {rows.map((row, index) => {
            const selected = index === cursor
            const heading = row.heading ? (
              <p
                key={`h-${row.heading}`}
                className="px-[12px] pt-[12px] pb-[4px] text-small font-semibold text-muted"
              >
                {row.heading}
              </p>
            ) : null

            if (row.kind === 'file') {
              return (
                <div key={`file-wrap-${row.file.id}`}>
                  {heading}
                <button
                  key={`file-${row.file.id}`}
                  type="button"
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => choose(index)}
                  className={`flex w-full items-center gap-[8px] rounded-nav px-[12px] py-[8px] text-left ${
                    selected ? 'bg-ink text-on-ink' : 'hover:bg-panel-soft'
                  }`}
                >
                  <span className={`shrink-0 text-micro uppercase tracking-[0.06em] ${selected ? 'opacity-70' : 'text-muted'}`}>
                    {KIND_LABEL[row.file.kind]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-small">{row.file.name}</span>
                  <span className={`value shrink-0 text-micro ${selected ? 'opacity-70' : 'text-muted'}`}>
                    {formatBytes(row.file.sizeBytes)}
                  </span>
                  </button>
                </div>
              )
            }

            const fits = active ? row.action.kinds.includes(active.kind) : false
            return (
              <div key={`wrap-${row.action.id}`}>
                {heading}
                <button
                key={row.action.id}
                type="button"
                onMouseEnter={() => setCursor(index)}
                onClick={() => choose(index)}
                className={`flex w-full items-baseline gap-[8px] rounded-nav px-[12px] py-[8px] text-left ${
                  selected ? 'bg-ink text-on-ink' : 'hover:bg-panel-soft'
                } ${
                  /* Dimmed rather than labelled. A badge reading "fits your
                     selection" on nearly every row is a badge that says
                     nothing; quieting the few that do not fit says the same
                     thing without adding thirty words to the screen. */
                  active && !fits && !selected ? 'opacity-55' : ''
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-small">{row.action.label}</span>
                  <span className={`block truncate text-small ${selected ? 'opacity-70' : 'text-muted'}`}>
                    {row.action.hint}
                  </span>
                </span>
                {selected ? (
                  <span className="shrink-0 rounded-nav bg-on-ink/20 px-[8px] py-[2px] font-mono text-micro">
                    ↵
                  </span>
                ) : null}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </dialog>
  )
}
