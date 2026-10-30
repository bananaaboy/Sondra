/**
 * Which subtitle files lie beside a film, and what a made one is called. Pure
 * names, so the folder page and the tests can use them without the speech
 * model or FFmpeg.
 */

import { stemOf } from './player'

const SUBTITLE = /\.(srt|vtt)$/i

/** `Film.srt`, `Film.de.srt`, `Film.vtt`: the stem of a subtitle file, with a language tag cut off. */
const subtitleStem = (name: string) => stemOf(name).replace(/\.[a-z]{2,3}$/, '')

/** The subtitle files in the same folder that belong to a film, by name. */
export function subtitlesBeside<T extends { name: string; dir: string }>(film: { name: string; dir: string }, all: T[]): T[] {
  const stem = stemOf(film.name)
  return all.filter((entry) => entry.dir === film.dir && SUBTITLE.test(entry.name) && (stemOf(entry.name) === stem || subtitleStem(entry.name) === stem))
}

/** The name a made subtitle gets: the film's, with `.srt` — no language tag, so every player takes it. */
export const subtitleNameFor = (name: string): string => `${name.replace(/\.[^.]+$/, '')}.srt`
