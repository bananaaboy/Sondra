/**
 * Three-state theme switch: follow the system, or pin light or dark.
 *
 * A two-state toggle cannot express "follow the system", which is the state
 * most people actually want — and the one that keeps working when their machine
 * switches at sunset.
 */

import type { ThemeChoice } from '../lib/theme'

const OPTIONS: { value: ThemeChoice; label: string; title: string }[] = [
  { value: 'light', label: 'Hell', title: 'Immer helles Erscheinungsbild' },
  { value: 'system', label: 'System', title: 'Dem Betriebssystem folgen' },
  { value: 'dark', label: 'Dunkel', title: 'Immer dunkles Erscheinungsbild' },
]

function Icon({ choice }: { choice: ThemeChoice }) {
  if (choice === 'light') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.3" />
        <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <path d="M8 1.4v1.6M8 13v1.6M14.6 8H13M3 8H1.4M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1M12.7 12.7l-1.1-1.1M4.4 4.4L3.3 3.3" />
        </g>
      </svg>
    )
  }
  if (choice === 'dark') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
        <path
          d="M13.2 9.6A5.6 5.6 0 016.4 2.8a5.6 5.6 0 106.8 6.8z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <rect x="1.8" y="3.2" width="12.4" height="8.4" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.4 14h5.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * One button that steps through the three states.
 *
 * It was a segmented control of three filled squares — the heaviest object in
 * the header after the file button, for a setting most people touch once. The
 * three states are all still there; the button shows the current one and a
 * press moves to the next, and its name says both.
 */
export function ThemeToggle({
  choice,
  onChange,
}: {
  choice: ThemeChoice
  onChange: (choice: ThemeChoice) => void
}) {
  const index = OPTIONS.findIndex((option) => option.value === choice)
  const current = OPTIONS[index] ?? OPTIONS[1]
  const next = OPTIONS[(index + 1) % OPTIONS.length]
  return (
    <button
      type="button"
      onClick={() => onChange(next.value)}
      title={`${current.title} — wechseln zu: ${next.label}`}
      aria-label={`Erscheinungsbild: ${current.label}. Wechseln zu ${next.label}`}
      className="press flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-nav text-ink hover:bg-panel-soft"
    >
      <Icon choice={current.value} />
    </button>
  )
}
