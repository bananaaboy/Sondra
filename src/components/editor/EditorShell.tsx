/**
 * The frame both editors live in.
 *
 * The picture tool and the video tool used to be long forms: a preview at the
 * top, then twenty labelled controls stacked underneath it, and the thing you
 * were actually looking at scrolled off the screen the moment you reached for
 * a slider. That is a settings dialog, not an editor, and it is what "sehr
 * umständlich" means in practice — every adjustment costs a scroll back up to
 * see what it did.
 *
 * So the layout is the one every editor has converged on, for the same reason:
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │ file · what it is              undo redo  Save   │
 *   ├────┬────────────────────────────────┬────────────┤
 *   │ to │                                │ settings   │
 *   │ ol │            stage               │ for the    │
 *   │ s  │                                │ tool only  │
 *   ├────┴────────────────────────────────┴────────────┤
 *   │ status                                           │
 *   └──────────────────────────────────────────────────┘
 *
 * The stage never moves and never scrolls. Picking a tool on the left swaps
 * the column on the right, so only the handful of controls that belong to the
 * job in hand are on screen — the other thirty exist, but they are one click
 * away instead of one scroll away.
 *
 * Below `lg` there is no room for three columns, so the rail becomes a
 * horizontal strip of tool chips under the stage and the inspector falls
 * beneath it. The order stays the same: see it, choose a tool, adjust it.
 */

import type { ReactNode } from 'react'

export interface EditorTool {
  id: string
  label: string
  icon: ReactNode
  /** Marks a tool whose settings are no longer at their defaults. */
  touched?: boolean
}

export function EditorIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-[18px] w-[18px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

/** The heading above a group of controls in the inspector. */
export function ToolHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-[4px]">
      <p className="text-small font-semibold text-ink">{title}</p>
      {hint ? <p className="text-small leading-[1.45] text-muted">{hint}</p> : null}
    </div>
  )
}

/**
 * A row of equal-width choices — aspect ratios, rotations, formats.
 *
 * Three quarters of the controls in both editors are "pick one of four", and a
 * select menu hides three of the four behind a click. At this width they all
 * fit side by side and the current one is simply the filled chip.
 */
export function ChoiceRow<T extends string | number>({
  value,
  options,
  onChange,
  columns = 0,
}: {
  value: T
  options: { value: T; label: string; title?: string }[]
  onChange: (value: T) => void
  /** 0 lets them flow; a number forces an even grid. */
  columns?: number
}) {
  return (
    <div
      className={columns > 0 ? 'grid gap-[4px]' : 'flex flex-wrap gap-[4px]'}
      style={columns > 0 ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={String(option.value)}
            type="button"
            title={option.title}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`press rounded-nav px-[8px] py-[8px] text-small leading-none ${
              active
                ? 'bg-ink text-on-ink'
                : 'bg-panel-soft text-prose ring-1 ring-inset ring-line hover:bg-panel-mid'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** A square icon button, for the top bar and the stage overlay. */
export function IconButton({
  label,
  onClick,
  disabled,
  active,
  onStage = false,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  /** Stage buttons sit on the dark surface and need its palette. */
  onStage?: boolean
  children: ReactNode
}) {
  const tone = onStage
    ? active
      ? 'bg-stage-ink text-stage'
      : 'bg-stage-soft/85 text-stage-ink ring-1 ring-inset ring-stage-line hover:bg-stage-line'
    : active
      ? 'bg-ink text-on-ink'
      : 'text-muted hover:bg-panel-soft hover:text-ink'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`press inline-flex h-[32px] w-[32px] items-center justify-center rounded-nav disabled:cursor-not-allowed disabled:opacity-35 ${tone}`}
    >
      {children}
    </button>
  )
}

function Rail({
  tools,
  tool,
  onTool,
  orientation,
}: {
  tools: EditorTool[]
  tool: string
  onTool: (id: string) => void
  orientation: 'vertical' | 'horizontal'
}) {
  const vertical = orientation === 'vertical'
  return (
    <div
      role="tablist"
      aria-label="Werkzeuge"
      aria-orientation={orientation}
      className={
        vertical
          ? 'flex w-[84px] shrink-0 flex-col gap-[4px] border-r border-line bg-raised p-[8px]'
          : 'flex gap-[4px] overflow-x-auto border-t border-line bg-raised p-[8px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
      }
    >
      {tools.map((entry) => {
        const active = entry.id === tool
        return (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onTool(entry.id)}
            title={entry.label}
            className={`press relative flex shrink-0 items-center rounded-nav ${
              vertical
                ? 'flex-col gap-[4px] px-[4px] py-[8px]'
                : 'flex-col gap-[4px] px-[12px] py-[8px]'
            } ${active ? 'bg-ink text-on-ink' : 'text-prose hover:bg-panel-soft'}`}
          >
            {entry.icon}
            <span className="text-micro leading-none">{entry.label}</span>
            {/* A tool that holds a change says so without being opened. */}
            {entry.touched ? (
              <span
                aria-hidden
                className={`absolute right-[7px] top-[7px] h-[5px] w-[5px] ${
                  active ? 'bg-on-ink' : 'bg-ink'
                }`}
              />
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

export function EditorShell({
  title,
  subtitle,
  actions,
  tools,
  tool,
  onTool,
  stage,
  stageOverlay,
  underStage,
  inspector,
  status,
  stageClassName = 'stage-checks min-h-[360px] sm:min-h-[clamp(460px,58vh,760px)]',
}: {
  title: ReactNode
  subtitle?: ReactNode
  /** Undo, redo, reset, export — the things that act on the whole document. */
  actions?: ReactNode
  tools: EditorTool[]
  tool: string
  onTool: (id: string) => void
  stage: ReactNode
  /** Floats over the stage, bottom-centred: zoom, playback, frame counter. */
  stageOverlay?: ReactNode
  /** Full-width under the stage and inside the frame — the video timeline. */
  underStage?: ReactNode
  inspector: ReactNode
  status?: ReactNode
  /**
   * The stage's ground and height. The picture and video stages sit on the
   * transparency checks; the sound stage has nothing that can be transparent
   * and draws on plain stage black, a little lower, since a waveform gains
   * nothing from 760 pixels of height.
   */
  stageClassName?: string
}) {
  return (
    <div className="flex flex-col overflow-hidden bg-raised ring-1 ring-inset ring-line">
      <header className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px] border-b border-line px-[16px] py-[8px]">
        <div className="min-w-0 flex-1">
          <p className="truncate text-small font-semibold text-ink">{title}</p>
          {subtitle ? <p className="value truncate text-small text-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-[4px]">{actions}</div> : null}
      </header>

      <div className="flex min-h-0 flex-col lg:flex-row">
        {/* Flex, so the rail runs the full height of the stage beside it. */}
        <div className="hidden lg:flex">
          <Rail tools={tools} tool={tool} onTool={onTool} orientation="vertical" />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* The contents are positioned rather than flowed, and that is not a
              detail. Both editors measure this box to work out how big to draw
              the picture, and a child with `h-full` inside a parent whose
              height comes from `min-height` resolves to auto — so on a phone
              the measurement came back as the height of nothing and the photo
              was drawn forty pixels wide. Inset children have a height because
              this box has one.

              The height grows with the window instead of standing at 460px
              forever: on a 1440px-tall monitor that left the editor as a
              band across the middle with six hundred pixels of empty page
              under it. `clamp` keeps the old 460px as the floor, so nothing
              regresses on a laptop, and stops at 760px, past which a picture
              is no easier to work on and the tool rail and the inspector
              beside it just stretch. */}
          <div className={`relative flex-1 overflow-hidden ${stageClassName}`}>
            {stage}
            {stageOverlay ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-[12px] flex justify-center">
                <div className="pointer-events-auto flex items-center gap-[4px] bg-stage/80 p-[4px] ring-1 ring-inset ring-stage-line backdrop-blur-[6px]">
                  {stageOverlay}
                </div>
              </div>
            ) : null}
          </div>
          {underStage ? <div className="border-t border-line bg-raised">{underStage}</div> : null}
          <div className="lg:hidden">
            <Rail tools={tools} tool={tool} onTool={onTool} orientation="horizontal" />
          </div>
        </div>

        {/* Beside the stage the column scrolls in itself rather than
            stretching the row: a tool with four blocks of controls made the
            stage — and the waveform on it — as tall as those blocks, and
            pushed the transport under the fold. The stage sets the height. */}
        <aside
          role="tabpanel"
          className="relative w-full shrink-0 border-t border-line bg-raised lg:w-[288px] lg:border-l lg:border-t-0"
        >
          <div className="p-[16px] lg:absolute lg:inset-0 lg:overflow-y-auto lg:overscroll-contain lg:[scrollbar-color:var(--color-rule)_transparent] lg:[scrollbar-width:thin]">
            {/* Keyed so switching tools replays the entrance instead of
                swapping controls underneath the pointer. */}
            <div key={tool} className="rise flex flex-col gap-[16px]">
              {inspector}
            </div>
          </div>
        </aside>
      </div>

      {status ? (
        <footer className="flex flex-wrap items-center gap-x-[16px] gap-y-[4px] border-t border-line px-[16px] py-[8px] text-small text-muted">
          {status}
        </footer>
      ) : null}
    </div>
  )
}
