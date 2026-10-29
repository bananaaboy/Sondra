import type { CSSProperties } from 'react'

/**
 * The delay for the n-th item of a list that arrives as a list (`rise` reads
 * `--delay`): 30 ms apart, and never more than 240 ms in all — a long list
 * must not keep its last rows waiting.
 */
export function stagger(index: number, step = 30): CSSProperties {
  return { ['--delay' as string]: `${Math.min(Math.max(0, index), 8) * step}ms` }
}
