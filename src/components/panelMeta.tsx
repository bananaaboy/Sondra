/**
 * The tools, as data.
 *
 * Shared by the tab bar, the tile start screen and anything else that needs to
 * name a tool: three copies of this list is three chances for the icon in one
 * place to disagree with the label in another.
 *
 * Every tool is named for the result, not for the technique. "Spuren",
 * "Lautheit" and "Harmonie" are what these things are called by people who
 * already know what they are. Someone arriving with a recording and a question
 * does not know that yet, and a tab bar is the worst possible place to learn
 * vocabulary: it is the one control you have to use before you have seen
 * anything. So the label answers "what will this do for me" and the line
 * underneath says it again in a full sentence.
 */

import type { ReactNode } from 'react'

import type { PanelId } from '../state/store'

export interface PanelMeta {
  id: PanelId
  /**
   * The panel's address, as it appears after the `#`.
   *
   * German and stable, because it is a link someone may send. It is kept
   * apart from `id` on purpose: `id` is what the code switches on and must
   * never move, the slug is what a person reads and may be renamed with a
   * redirect if a word turns out wrong.
   */
  slug: string
  label: string
  summary: string
  icon: ReactNode
}

export const PANELS: PanelMeta[] = [
  {
    id: 'start',
    slug: 'start',
    label: 'Start',
    summary: 'Alle Werkzeuge als Kacheln, mit Suche',
    icon: <path d="M2.6 7.2L8 2.6l5.4 4.6v5.6a.9.9 0 01-.9.9H3.5a.9.9 0 01-.9-.9z" />,
  },
  {
    id: 'downloader',
    slug: 'herunterladen',
    label: 'Herunterladen',
    summary: 'Ein Video oder Lied von einer Adresse holen',
    icon: (
      <path d="M8 2.6v7.2m0 0L5.2 7M8 9.8L10.8 7M2.8 12.2h10.4" />
    ),
  },
  {
    id: 'converter',
    slug: 'umwandeln',
    label: 'Umwandeln',
    summary: 'In ein anderes Dateiformat bringen — etwa Video zu MP3',
    icon: <path d="M2.6 5.4h9.2m0 0L9.4 3.1m2.4 2.3L9.4 7.7M13.4 10.6H4.2m0 0l2.4-2.3m-2.4 2.3l2.4 2.3" />,
  },
  {
    id: 'audio',
    slug: 'ton',
    label: 'Ton',
    summary: 'Schneiden, einfügen, Filter, Rauschen, Hall, Tonhöhe, Tempo',
    icon: <path d="M1.8 8h1.8l1.6-4.6 2.4 9.2 2-6.2 1.2 3.4h3" />,
  },
  {
    id: 'video',
    slug: 'video',
    label: 'Video',
    summary: 'Schneiden, drehen, Farbe, Blenden, Tempo, Ton',
    icon: <path d="M1.8 4.2h8.6v7.6H1.8zM10.4 7l3.8-2.2v6.4L10.4 9z" />,
  },
  {
    id: 'images',
    slug: 'bilder',
    label: 'Bilder',
    summary: 'Skalieren, zuschneiden, umwandeln, viele auf einmal',
    icon: <path d="M2 3.2h12v9.6H2zM2 10l3.4-3.2 3 2.8 2.2-2 3.4 3.2M5.6 6.2a.9.9 0 100-1.8.9.9 0 000 1.8z" />,
  },
  {
    id: 'stems',
    slug: 'spuren-trennen',
    label: 'Spuren trennen',
    summary: 'Gesang, Schlagzeug und Bass als einzelne Dateien',
    icon: <path d="M8 1.8L14 5 8 8.2 2 5zM2 8l6 3.2L14 8M2 11l6 3.2L14 11" />,
  },
  {
    id: 'normalize',
    slug: 'lautstaerke',
    label: 'Lautstärke',
    summary: 'So laut machen wie im Radio, ohne zu übersteuern',
    icon: <path d="M3.4 9.6V6.4M6.5 12V4M9.5 10.8V5.2M12.6 8.6V7.4" />,
  },
  {
    id: 'sampler',
    slug: 'zerschneiden',
    label: 'Zerschneiden',
    summary: 'In Schläge zerlegen, auf Pads legen und einen Beat daraus bauen',
    icon: <path d="M3.4 2.8l7.4 9.2M12.6 2.8L5.2 12M4.3 13.2a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM11.7 13.2a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />,
  },
  {
    id: 'harmony',
    slug: 'tonart',
    label: 'Tonart',
    summary: 'Tonart, Tempo, Akkorde und die Melodie als MIDI',
    icon: <path d="M6 11.6V3.4l7-1.2v8.2M6 11.6a1.8 1.8 0 11-3.6 0 1.8 1.8 0 013.6 0zM13 10.4a1.8 1.8 0 11-3.6 0 1.8 1.8 0 013.6 0z" />,
  },
  {
    id: 'subtitles',
    slug: 'untertitel',
    label: 'Untertitel',
    summary: 'Gesprochenes als Text, SRT-Datei oder direkt im Video',
    icon: <path d="M2 3.4h12v9.2H2zM4.4 8.2h3.2M9 8.2h2.6M4.4 10.4h1.8M7.6 10.4h4" />,
  },
  {
    id: 'mic',
    slug: 'mikrofon',
    label: 'Mikrofon',
    summary: 'Testen, Geräte wählen und für Podcast, Stream oder Musik einstellen',
    icon: <path d="M8 2.2a2 2 0 012 2v3.6a2 2 0 01-4 0V4.2a2 2 0 012-2zM4.2 7.6a3.8 3.8 0 007.6 0M8 11.4v2.4M5.8 13.8h4.4" />,
  },
]

export function ToolIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}
