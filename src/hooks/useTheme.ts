/**
 * React bindings for the theme controller.
 */

import { useCallback, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'

import {
  applyThemeChoice,
  readPalette,
  readThemeChoice,
  resolveTheme,
  watchSystemTheme,
  type Palette,
  type ResolvedTheme,
  type ThemeChoice,
} from '../lib/theme'

export interface ThemeState {
  choice: ThemeChoice
  resolved: ResolvedTheme
  setChoice: (choice: ThemeChoice) => void
}

export function useTheme(): ThemeState {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readThemeChoice())
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readThemeChoice()))

  useEffect(() => {
    setResolved(applyThemeChoice(choice))
  }, [choice])

  // While the choice is "system" the OS keeps the casting vote.
  useEffect(() => {
    if (choice !== 'system') return undefined
    return watchSystemTheme(setResolved)
  }, [choice])

  // A switch the person makes crossfades the whole page rather than flipping
  // every colour at once; the browser holds the old picture while the new
  // theme is written underneath. Without View Transitions, or with reduced
  // motion, it simply flips.
  const setChoice = useCallback((next: ThemeChoice) => {
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (calm || typeof document.startViewTransition !== 'function') {
      setChoiceState(next)
      return
    }
    document.startViewTransition(() => {
      applyThemeChoice(next)
      flushSync(() => setChoiceState(next))
    })
  }, [])

  return { choice, resolved, setChoice }
}

/**
 * The live palette, re-read whenever the theme changes.
 *
 * Reading happens after paint so the new custom-property values are already in
 * the cascade.
 */
export function usePalette(resolved: ResolvedTheme): Palette {
  const [palette, setPalette] = useState<Palette>(() => readPalette())

  useEffect(() => {
    // One frame of delay: the attribute has been written, but the style
    // recalculation it triggers has not necessarily landed yet.
    const frame = requestAnimationFrame(() => setPalette(readPalette()))
    return () => cancelAnimationFrame(frame)
  }, [resolved])

  return palette
}
