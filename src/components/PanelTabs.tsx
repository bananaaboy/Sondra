/**
 * The tool switcher, as the second line of the header.
 *
 * It used to be a white box with a hairline ring, below a tinted session strip,
 * below the header — three bands before a tool said anything, and the box was
 * the loudest of them. Now it is text on the header's own ground: the chosen
 * tool in ink with a rule under it, the rest in prose. The header's bottom
 * rule is the only line; the tabs sit on it.
 *
 * Sixteen tools need about 1300 px in a row, and the row had them all in a
 * strip that scrolled sideways: on a laptop it ended in a cut-off word, and a
 * mouse has no way to swipe. Now the row shows as many as fit, in their
 * order, and the rest stand behind „Mehr“ — with their icon and what they do.
 * The chosen tool is always in the row; when it would have been behind
 * „Mehr“, it takes the last place there instead.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useSession } from '../state/store'
import { PANELS, ToolIcon, type PanelMeta } from './panelMeta'

const TAB = 'press relative shrink-0 whitespace-nowrap px-[12px] pb-[10px] pt-[8px] text-small transition-colors duration-[var(--dur-fast)]'

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3 w-3 shrink-0 transition-transform duration-[var(--dur-fast)] ${open ? 'rotate-180' : ''}`}
      fill="none"
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Widths of every tab and of „Mehr“, and the room the row has. */
interface Measure {
  tabs: number[]
  more: number
  room: number
}

/**
 * Which tools stand in the row: from the left, as many as fit beside the
 * chosen one and „Mehr“. In order and without gaps — skipping a long label to
 * fit a short one after it would scramble the order people learn.
 */
function split(measure: Measure | null, activeIndex: number): { shown: PanelMeta[]; rest: PanelMeta[] } {
  if (!measure) return { shown: PANELS, rest: [] }
  const total = measure.tabs.reduce((sum, width) => sum + width, 0)
  if (total <= measure.room) return { shown: PANELS, rest: [] }
  let budget = measure.room - measure.more - (measure.tabs[activeIndex] ?? 0)
  const keep = new Set([activeIndex])
  for (let index = 0; index < PANELS.length; index += 1) {
    if (index === activeIndex) continue
    if (measure.tabs[index] > budget) break
    budget -= measure.tabs[index]
    keep.add(index)
  }
  return {
    shown: PANELS.filter((_, index) => keep.has(index)),
    rest: PANELS.filter((_, index) => !keep.has(index)),
  }
}

export function PanelTabs() {
  const panel = useSession((state) => state.panel)
  const setPanel = useSession((state) => state.setPanel)
  const rowRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const [measure, setMeasure] = useState<Measure | null>(null)
  const [open, setOpen] = useState(false)

  // Measured from a hidden copy of the whole row, every label set in the
  // chosen tab's weight, so a choice never makes the row longer than planned.
  useLayoutEffect(() => {
    const row = rowRef.current
    const ruler = measureRef.current
    if (!row || !ruler) return
    const update = () => {
      const widths = [...ruler.children].map((child) => (child as HTMLElement).getBoundingClientRect().width)
      const more = widths.pop() ?? 0
      setMeasure({ tabs: widths, more, room: row.getBoundingClientRect().width })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(row)
    // Public Sans arrives after the first layout and sets wider than the fallback.
    void document.fonts?.ready.then(update)
    return () => observer.disconnect()
  }, [])

  const activeIndex = Math.max(
    0,
    PANELS.findIndex((entry) => entry.id === panel),
  )
  const { shown, rest } = useMemo(() => split(measure, activeIndex), [measure, activeIndex])

  // Closes on a click anywhere else and on Escape, like every other popover.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      moreRef.current?.focus()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Whatever changes the tool closes the list.
  useEffect(() => setOpen(false), [panel])

  // A tablist answers to the arrow keys; tabbing through ten buttons to reach
  // the tool is not the way to switch. The arrows walk all tools, also those
  // behind „Mehr“ — the chosen one always comes into the row.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!delta) return
    event.preventDefault()
    const next = PANELS[(activeIndex + delta + PANELS.length) % PANELS.length]
    setPanel(next.id)
    requestAnimationFrame(() => rowRef.current?.querySelector<HTMLElement>(`[data-panel="${next.id}"]`)?.focus())
  }

  // Arrow keys inside the open list, top to bottom.
  const onListKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (!delta) return
    event.preventDefault()
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const at = items.indexOf(document.activeElement as HTMLElement)
    items[(at + delta + items.length) % items.length]?.focus()
  }

  return (
    <div ref={rootRef} className="relative">
      <div ref={rowRef} className="flex items-end overflow-x-clip">
        <div role="tablist" aria-label="Werkzeuge" onKeyDown={onKeyDown} className="flex min-w-0">
          {shown.map((entry, index) => {
            const active = entry.id === panel
            return (
              <button
                key={entry.id}
                data-panel={entry.id}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => setPanel(entry.id)}
                title={entry.summary}
                className={`${TAB} ${index === 0 ? 'pl-0' : ''} ${active ? 'font-semibold text-ink' : 'text-prose hover:text-ink'}`}
              >
                {entry.label}
                {/* The rule under the chosen tab lands on the header's own rule. */}
                <span
                  aria-hidden
                  className={`absolute bottom-[-2px] right-[12px] h-[2px] bg-ink transition-opacity duration-[var(--dur-fast)] ${
                    index === 0 ? 'left-0' : 'left-[12px]'
                  } ${active ? 'opacity-100' : 'opacity-0'}`}
                />
              </button>
            )
          })}
        </div>

        {rest.length > 0 ? (
          <button
            ref={moreRef}
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-haspopup="menu"
            className={`${TAB} flex items-center gap-[6px] ${open ? 'text-ink' : 'text-prose hover:text-ink'}`}
          >
            Mehr
            <span className="value text-micro text-muted">{rest.length}</span>
            <Chevron open={open} />
          </button>
        ) : null}
      </div>

      {open ? (
        <div
          role="menu"
          aria-label="Weitere Werkzeuge"
          onKeyDown={onListKey}
          // Right-aligned under „Mehr“; on a phone the same rule makes it
          // the screen's width less its margins.
          className="rise elevate-lift absolute right-0 top-[calc(100%+8px)] z-30 grid max-h-[calc(100dvh-140px)] w-[min(560px,calc(100vw-32px))] grid-cols-1 gap-[2px] overflow-y-auto overscroll-contain rounded-card bg-raised p-[8px] ring-1 ring-inset ring-line min-[480px]:grid-cols-2"
        >
          {rest.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              role="menuitem"
              autoFocus={index === 0}
              onClick={() => {
                setPanel(entry.id)
                setOpen(false)
              }}
              className="press flex min-w-0 items-start gap-[12px] rounded-nav px-[12px] py-[10px] text-left text-ink hover:bg-panel-soft focus-visible:bg-panel-soft"
            >
              <span className="mt-[2px] text-ink">
                <ToolIcon>{entry.icon}</ToolIcon>
              </span>
              <span className="flex min-w-0 flex-col gap-[2px]">
                <span className="text-small font-semibold">{entry.label}</span>
                <span className="text-micro leading-[1.4] text-prose">{entry.summary}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {/* The ruler: every tab and „Mehr“, out of sight and out of reach —
          clipped, or its 1300 px would widen the page. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0 overflow-hidden">
        <div ref={measureRef} className="invisible flex w-max">
          {PANELS.map((entry, index) => (
            <span key={entry.id} className={`${TAB} font-semibold ${index === 0 ? 'pl-0' : ''}`}>
              {entry.label}
            </span>
          ))}
          <span className={`${TAB} flex items-center gap-[6px]`}>
            Mehr
            <span className="value text-micro">{PANELS.length}</span>
            <Chevron open={false} />
          </span>
        </div>
      </div>
    </div>
  )
}
