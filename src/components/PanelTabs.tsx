/**
 * The tool switcher, as the second line of the header.
 *
 * It used to be a white box with a hairline ring, below a tinted session strip,
 * below the header — three bands before a tool said anything, and the box was
 * the loudest of them. Now it is text on the header's own ground: the chosen
 * tool in ink with a rule under it, the rest in prose. The header's bottom
 * rule is the only line; the tabs sit on it.
 *
 * Nineteen tools in a row are a line nobody reads to its end (and on a laptop
 * it ended in „Mehr“ after twelve). So the row holds the tasks people come
 * for, each on its own — Start, Merkliste, Ordner, Abspielen, Herunterladen,
 * Geräte — and the tools that work on a file stand in three groups, one button
 * each: Bearbeiten, Ton, Aufnehmen. A group's button names the chosen tool
 * („Ton · Mischen“), so the row still says where you are. Every tool is still
 * one click and a menu away, with its icon and what it does.
 *
 * Where even that does not fit (a phone), the row shows as many entries as fit,
 * in their order, and the rest stand behind „Mehr“ — measured, never cut off,
 * never to swipe sideways. The chosen entry is always in the row.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useSession } from '../state/store'
import { TAB_ENTRIES, ToolIcon, entryOf, type PanelMeta, type TabEntry } from './panelMeta'

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

/** What an entry says on its button: a tool by name, a group by name and — when it holds the chosen tool — that tool. */
function labelOf(entry: TabEntry, panel: string): string {
  if (entry.type === 'panel') return entry.panel.label
  const chosen = entry.panels.find((member) => member.id === panel)
  return chosen ? `${entry.label} · ${chosen.label}` : entry.label
}

/** Widths of every entry and of „Mehr“, and the room the row has. */
interface Measure {
  tabs: number[]
  more: number
  room: number
}

/**
 * Which entries stand in the row: from the left, as many as fit beside the
 * chosen one and „Mehr“. In order and without gaps — skipping a long label to
 * fit a short one after it would scramble the order people learn.
 */
function split(measure: Measure | null, activeIndex: number): { shown: number[]; rest: number[] } {
  const all = TAB_ENTRIES.map((_, index) => index)
  if (!measure) return { shown: all, rest: [] }
  const total = measure.tabs.reduce((sum, width) => sum + width, 0)
  if (total <= measure.room) return { shown: all, rest: [] }
  let budget = measure.room - measure.more - (measure.tabs[activeIndex] ?? 0)
  const keep = new Set([activeIndex])
  for (const index of all) {
    if (index === activeIndex) continue
    if (measure.tabs[index] > budget) break
    budget -= measure.tabs[index]
    keep.add(index)
  }
  return { shown: all.filter((index) => keep.has(index)), rest: all.filter((index) => !keep.has(index)) }
}

function Item({ panel, current, onPick }: { panel: PanelMeta; current: boolean; onPick: (panel: PanelMeta) => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-current={current ? 'page' : undefined}
      onClick={() => onPick(panel)}
      className="press flex min-w-0 items-start gap-[12px] rounded-nav px-[12px] py-[10px] text-left text-ink hover:bg-panel-soft focus-visible:bg-panel-soft"
    >
      <span className="mt-[2px] text-ink">
        <ToolIcon>{panel.icon}</ToolIcon>
      </span>
      <span className="flex min-w-0 flex-col gap-[2px]">
        <span className={`text-small ${current ? 'font-semibold' : 'font-medium'}`}>{panel.label}</span>
        <span className="text-micro leading-[1.4] text-prose">{panel.summary}</span>
      </span>
    </button>
  )
}

export function PanelTabs() {
  const panel = useSession((state) => state.panel)
  const setPanel = useSession((state) => state.setPanel)
  const rowRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const [measure, setMeasure] = useState<Measure | null>(null)
  // Which menu is open: a group's id or 'mehr', and where it hangs.
  const [open, setOpen] = useState<{ id: string; left: number } | null>(null)
  // Where the one rule under the chosen tab stands. It glides from the tab
  // that was chosen to the next, along the header's own rule, so a switch
  // shows where it went; the very first placement does not glide in from 0.
  const [rule, setRule] = useState<{ left: number; width: number; glide: boolean } | null>(null)

  const activeIndex = entryOf(panel)

  // Measured from a hidden copy of the whole row, every label set in the
  // chosen tab's weight, so a choice never makes the row longer than planned.
  // Again whenever the chosen tool changes: a group's button grows by its name.
  useLayoutEffect(() => {
    const row = rowRef.current
    const ruler = measureRef.current
    if (!row || !ruler) return
    const update = () => {
      const widths = [...ruler.children].map((child) => (child as HTMLElement).getBoundingClientRect().width)
      const more = widths.pop() ?? 0
      setMeasure((before) =>
        before && before.more === more && before.room === row.getBoundingClientRect().width && before.tabs.join() === widths.join()
          ? before
          : { tabs: widths, more, room: row.getBoundingClientRect().width },
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(row)
    // Public Sans arrives after the first layout and sets wider than the fallback.
    void document.fonts?.ready.then(update)
    return () => observer.disconnect()
  }, [panel])

  const { shown, rest } = useMemo(() => split(measure, activeIndex), [measure, activeIndex])
  const hidden = rest.reduce((sum, index) => {
    const entry = TAB_ENTRIES[index]
    return sum + (entry.type === 'panel' ? 1 : entry.panels.length)
  }, 0)

  useLayoutEffect(() => {
    const tab = listRef.current?.querySelector<HTMLElement>('[data-tab][aria-current="page"]')
    if (!tab) return
    // The rule sits under the label, not the padding: 12 px either side,
    // none on the left of the first tab.
    const inset = tab === listRef.current?.firstElementChild ? 0 : 12
    const left = tab.offsetLeft + inset
    const width = Math.max(0, tab.offsetWidth - inset - 12)
    setRule((before) =>
      before && before.left === left && before.width === width ? before : { left, width, glide: before !== null },
    )
  }, [panel, shown, measure])

  // Closes on a click anywhere else and on Escape, like every other popover.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(null)
      openerRef.current?.focus()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Whatever changes the tool closes the menu.
  useEffect(() => setOpen(null), [panel])

  // The first item gets the focus when a menu opens: the chosen one if it is in there.
  useEffect(() => {
    if (!open) return
    const menu = rootRef.current?.querySelector<HTMLElement>('[role="menu"]')
    const target = menu?.querySelector<HTMLElement>('[aria-current="page"]') ?? menu?.querySelector<HTMLElement>('[role="menuitem"]')
    target?.focus()
  }, [open])

  const toggle = (id: string, event: React.MouseEvent<HTMLElement>, align: 'left' | 'right') => {
    const button = event.currentTarget
    if (open?.id === id) {
      setOpen(null)
      return
    }
    openerRef.current = button
    // A group hangs under its own button, but never past the screen's edge;
    // „Mehr“ is right-aligned, as it always was.
    const root = rootRef.current
    const menuWidth = Math.min(380, window.innerWidth - 32)
    const left =
      align === 'left' && root
        ? Math.max(0, Math.min(button.getBoundingClientRect().left - root.getBoundingClientRect().left, root.clientWidth - menuWidth))
        : 0
    setOpen({ id, left })
  }

  const pick = (next: PanelMeta) => {
    setPanel(next.id)
    setOpen(null)
  }

  // Arrow keys walk the buttons of the row, Home and End jump to its ends: nine
  // stops are fewer to tab through than eighteen were, and arrows are what the
  // row has always answered to. They move the focus; Enter or Space chooses.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    const edge = event.key === 'Home' ? 0 : event.key === 'End' ? -1 : null
    if (!delta && edge === null) return
    // Inside an open menu the arrows belong to the menu.
    if ((event.target as HTMLElement).closest('[role="menu"]')) return
    const stops = [...(rowRef.current?.querySelectorAll<HTMLElement>('[data-stop]') ?? [])]
    if (!stops.length) return
    event.preventDefault()
    const at = stops.indexOf(document.activeElement as HTMLElement)
    const next = edge !== null ? (edge === 0 ? 0 : stops.length - 1) : (at + delta + stops.length) % stops.length
    stops[next]?.focus()
  }

  // Arrow keys inside an open menu, top to bottom.
  const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    const edge = event.key === 'Home' ? 0 : event.key === 'End' ? -1 : null
    if (!delta && edge === null) return
    event.preventDefault()
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = edge !== null ? (edge === 0 ? 0 : items.length - 1) : (at + delta + items.length) % items.length
    items[next]?.focus()
  }

  const openGroup = open && open.id !== 'mehr' ? TAB_ENTRIES.find((entry) => entry.type === 'group' && entry.id === open.id) : null

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <div ref={rowRef} className="flex items-end overflow-x-clip">
        <div ref={listRef} data-tabrow className="relative flex min-w-0">
          {shown.map((index, position) => {
            const entry = TAB_ENTRIES[index]
            const active = index === activeIndex
            const base = `${TAB} ${position === 0 ? 'pl-0' : ''} ${active ? 'font-semibold text-ink' : 'text-prose hover:text-ink'}`
            if (entry.type === 'panel') {
              return (
                <button
                  key={entry.panel.id}
                  type="button"
                  data-tab
                  data-stop
                  data-panel={entry.panel.id}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setPanel(entry.panel.id)}
                  title={entry.panel.summary}
                  className={base}
                >
                  {entry.panel.label}
                </button>
              )
            }
            const isOpen = open?.id === entry.id
            return (
              <button
                key={entry.id}
                type="button"
                data-tab
                data-stop
                data-group={entry.id}
                data-panel={active ? panel : undefined}
                aria-current={active ? 'page' : undefined}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                onClick={(event) => toggle(entry.id, event, 'left')}
                title={entry.panels.map((member) => member.label).join(', ')}
                className={`${base} flex items-center gap-[6px]`}
              >
                {labelOf(entry, panel)}
                <Chevron open={isOpen} />
              </button>
            )
          })}
          {/* The rule under the chosen tab lands on the header's own rule.
              One element, scaled from a single pixel, so the glide is a
              transform and never a layout. */}
          {rule ? (
            <span
              aria-hidden
              data-tabrule
              className={`pointer-events-none absolute bottom-[-2px] left-0 h-[2px] w-[1px] origin-left bg-ink ${
                rule.glide ? 'transition-transform duration-[var(--dur-slow)] ease-[var(--ease-settle)]' : ''
              }`}
              style={{ transform: `translateX(${rule.left}px) scaleX(${rule.width})` }}
            />
          ) : null}
        </div>

        {rest.length > 0 ? (
          <button
            type="button"
            data-stop
            onClick={(event) => toggle('mehr', event, 'right')}
            aria-expanded={open?.id === 'mehr'}
            aria-haspopup="menu"
            className={`${TAB} flex items-center gap-[6px] ${open?.id === 'mehr' ? 'text-ink' : 'text-prose hover:text-ink'}`}
          >
            Mehr
            <span className="value text-micro text-muted">{hidden}</span>
            <Chevron open={open?.id === 'mehr'} />
          </button>
        ) : null}
      </div>

      {openGroup && openGroup.type === 'group' ? (
        <div
          role="menu"
          aria-label={openGroup.label}
          onKeyDown={onMenuKey}
          // Under its own button; on a phone the width is the screen's less its margins.
          style={{ left: open?.left ?? 0 }}
          className="drop elevate-lift absolute top-[calc(100%+8px)] z-30 flex max-h-[calc(100dvh-140px)] w-[min(380px,calc(100vw-32px))] flex-col gap-[2px] overflow-y-auto overscroll-contain rounded-card bg-raised p-[8px] ring-1 ring-inset ring-line"
        >
          {openGroup.panels.map((member) => (
            <Item key={member.id} panel={member} current={member.id === panel} onPick={pick} />
          ))}
        </div>
      ) : null}

      {open?.id === 'mehr' ? (
        <div
          role="menu"
          aria-label="Weitere Werkzeuge"
          onKeyDown={onMenuKey}
          // Right-aligned under „Mehr“; on a phone the same rule makes it
          // the screen's width less its margins.
          className="drop elevate-lift absolute right-0 top-[calc(100%+8px)] z-30 flex max-h-[calc(100dvh-140px)] w-[min(420px,calc(100vw-32px))] flex-col gap-[2px] overflow-y-auto overscroll-contain rounded-card bg-raised p-[8px] ring-1 ring-inset ring-line"
        >
          {rest.map((index) => {
            const entry = TAB_ENTRIES[index]
            if (entry.type === 'panel') {
              return <Item key={entry.panel.id} panel={entry.panel} current={entry.panel.id === panel} onPick={pick} />
            }
            return (
              <div key={entry.id} role="group" aria-label={entry.label} className="flex flex-col gap-[2px]">
                <p className="px-[12px] pb-[2px] pt-[10px] text-micro font-semibold text-muted">{entry.label}</p>
                {entry.panels.map((member) => (
                  <Item key={member.id} panel={member} current={member.id === panel} onPick={pick} />
                ))}
              </div>
            )
          })}
        </div>
      ) : null}

      {/* The ruler: every entry and „Mehr“, out of sight and out of reach —
          clipped, or its width would widen the page. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0 overflow-hidden">
        <div ref={measureRef} className="invisible flex w-max">
          {TAB_ENTRIES.map((entry, index) => (
            <span
              key={entry.type === 'panel' ? entry.panel.id : entry.id}
              className={`${TAB} flex items-center gap-[6px] font-semibold ${index === 0 ? 'pl-0' : ''}`}
            >
              {labelOf(entry, panel)}
              {entry.type === 'group' ? <Chevron open={false} /> : null}
            </span>
          ))}
          <span className={`${TAB} flex items-center gap-[6px]`}>
            Mehr
            <span className="value text-micro">{hidden || 18}</span>
            <Chevron open={false} />
          </span>
        </div>
      </div>
    </div>
  )
}
