/**
 * Light and dark theming.
 *
 * Three states, not two: an explicit light choice, an explicit dark choice, and
 * "system", which follows the OS and keeps following it when the OS flips at
 * sunset. Only the explicit choices write an attribute; system leaves the root
 * bare so the media query in theme.css decides.
 *
 * The choice is the one thing this app persists. It is a display preference
 * carrying no information about what anyone processed, and a tool that forgets
 * you prefer dark every time you open it is tiresome.
 */

/**
 * Reads a stored value, falling back to the key this app used under its old
 * name. Renaming the product should not quietly throw away what someone saved.
 */
function readStored(key: string, previous: string): string | null {
  try {
    const current = localStorage.getItem(key)
    if (current !== null) return current
    const legacy = localStorage.getItem(previous)
    if (legacy !== null) localStorage.setItem(key, legacy)
    return legacy
  } catch {
    return null
  }
}

export type ThemeChoice = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'sondra:theme'

/** Background colours per theme, mirroring theme.css, for the browser chrome. */
const CHROME_COLOR: Record<ResolvedTheme, string> = {
  light: '#f2eee4',
  dark: '#0a110d',
}

export function readThemeChoice(): ThemeChoice {
  try {
    const stored = readStored(STORAGE_KEY, 'lizge:theme')
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // Private windows and blocked site data throw on access rather than
    // returning null; falling back to "system" is always correct.
  }
  return 'system'
}

export function systemTheme(): ResolvedTheme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  return choice === 'system' ? systemTheme() : choice
}

/** Writes the choice to the document and, best effort, to storage. */
export function applyThemeChoice(choice: ThemeChoice): ResolvedTheme {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)

  const resolved = resolveTheme(choice)
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', CHROME_COLOR[resolved])

  try {
    localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // Nothing to do — the theme still applies for this page view.
  }
  return resolved
}

/** Calls back when the OS theme changes, so "system" stays live. */
export function watchSystemTheme(handler: (theme: ResolvedTheme) => void): () => void {
  if (typeof matchMedia !== 'function') return () => undefined
  const query = matchMedia('(prefers-color-scheme: dark)')
  const listener = (event: MediaQueryListEvent) => handler(event.matches ? 'dark' : 'light')
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

export interface Palette {
  ink: string
  inkHover: string
  canvas: string
  raised: string
  muted: string
  line: string
}

/**
 * Reads the live palette out of the cascade.
 *
 * Canvas drawing and Wavesurfer both need real colour strings rather than CSS
 * variables, and hard-coding them would leave the waveforms stuck in light mode.
 */
export function readPalette(): Palette {
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback
  return {
    ink: read('--color-ink', '#0f3e1c'),
    inkHover: read('--color-ink-hover', '#17552b'),
    canvas: read('--color-canvas', '#f2eee4'),
    raised: read('--color-raised', '#fdfbf6'),
    muted: read('--color-muted', '#5a6b5f'),
    line: read('--color-line', '#d3cdbf'),
  }
}

/**
 * Blends a colour with a transparency, as an 8-digit hex.
 * Wavesurfer takes colour strings, not CSS variables with alpha.
 */
export function withAlpha(color: string, alpha: number): string {
  const hex = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0')
  return color.startsWith('#') && color.length === 7 ? `${color}${hex}` : color
}
