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
    id: 'merkliste',
    slug: 'merkliste',
    label: 'Merkliste',
    summary: 'Serien und Listen, die Sie schauen — Staffeln, Folgen, Fortschritt',
    icon: <path d="M4.2 2.4h7.6v11.2L8 10.9l-3.8 2.7zM6.2 5.6h3.6" />,
  },
  {
    id: 'calendar',
    slug: 'kalender',
    label: 'Kalender',
    summary: 'Die Woche: wann Ihre Serien laufen und was Sie sich selbst eintragen',
    icon: <path d="M2.4 3.8h11.2v9.4H2.4zM2.4 6.6h11.2M5.4 2.2v3M10.6 2.2v3M5.2 9h.01M8 9h.01M10.8 9h.01M5.2 11.2h.01M8 11.2h.01" />,
  },
  {
    id: 'folder',
    slug: 'ordner',
    label: 'Ordner',
    summary: 'Die Dateien eines Ordners sehen, auswählen und weiterschauen',
    icon: <path d="M2 4.6c0-.6.5-1.1 1.1-1.1h3l1.4 1.5h5.4c.6 0 1.1.5 1.1 1.1v5.8c0 .6-.5 1.1-1.1 1.1H3.1c-.6 0-1.1-.5-1.1-1.1z" />,
  },
  {
    id: 'player',
    slug: 'abspielen',
    label: 'Abspielen',
    summary: 'Videos und Musik ansehen und anhören, auch grosse Filme',
    icon: <path d="M2 3.4h12v9.2H2zM6.6 5.8l3.6 2.2-3.6 2.2z" />,
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
    id: 'devices',
    slug: 'geraete',
    label: 'Geräte',
    summary: 'Dateien direkt an Ihr Handy oder Ihren Rechner senden',
    icon: <path d="M1.8 4.4c0-.5.4-.9.9-.9h7.4c.5 0 .9.4.9.9v5.2H1.8zM.8 11.6h9.8M11.6 6.2h2.6c.4 0 .8.4.8.8v6c0 .4-.4.8-.8.8h-2.6c-.4 0-.8-.4-.8-.8V7c0-.4.4-.8.8-.8zM12.6 12h.6" />,
  },
  {
    id: 'converter',
    slug: 'umwandeln',
    label: 'Umwandeln',
    summary: 'In ein anderes Dateiformat bringen — etwa Video zu MP3',
    icon: <path d="M2.6 5.4h9.2m0 0L9.4 3.1m2.4 2.3L9.4 7.7M13.4 10.6H4.2m0 0l2.4-2.3m-2.4 2.3l2.4 2.3" />,
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
    id: 'subtitles',
    slug: 'untertitel',
    label: 'Untertitel',
    summary: 'Gesprochenes als Text, SRT-Datei oder direkt im Video',
    icon: <path d="M2 3.4h12v9.2H2zM4.4 8.2h3.2M9 8.2h2.6M4.4 10.4h1.8M7.6 10.4h4" />,
  },
  {
    id: 'audio',
    slug: 'ton',
    label: 'Ton',
    summary: 'Schneiden, einfügen, Filter, Rauschen, Hall, Tonhöhe, Tempo',
    icon: <path d="M1.8 8h1.8l1.6-4.6 2.4 9.2 2-6.2 1.2 3.4h3" />,
  },
  {
    id: 'mix',
    slug: 'mischen',
    label: 'Mischen',
    summary: 'Stimme und Musik zusammen, die Musik weicht beim Sprechen',
    icon: <path d="M4 2.6v10.8M8 2.6v10.8M12 2.6v10.8M2.6 10h2.8M6.6 5.4h2.8M10.6 8.4h2.8" />,
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
    id: 'screen',
    slug: 'bildschirm',
    label: 'Bildschirm',
    summary: 'Bildschirm oder ein Fenster mit Ton als Video aufnehmen',
    icon: <path d="M1.8 2.8h12.4v8.4H1.8zM5.6 13.6h4.8M8 11.2v2.4M8 8.4a1.4 1.4 0 100-2.8 1.4 1.4 0 000 2.8z" />,
  },
  {
    id: 'phone',
    slug: 'spiegeln',
    label: 'Handy spiegeln',
    summary: 'Den Bildschirm Ihres Android-Handys hier zeigen und mit der Maus bedienen',
    icon: <path d="M5 1.8h6a1 1 0 011 1v10.4a1 1 0 01-1 1H5a1 1 0 01-1-1V2.8a1 1 0 011-1zM7 12h2" />,
  },
  {
    id: 'mic',
    slug: 'mikrofon',
    label: 'Mikrofon',
    summary: 'Testen, Geräte wählen und für Podcast, Stream oder Musik einstellen',
    icon: <path d="M8 2.2a2 2 0 012 2v3.6a2 2 0 01-4 0V4.2a2 2 0 012-2zM4.2 7.6a3.8 3.8 0 007.6 0M8 11.4v2.4M5.8 13.8h4.4" />,
  },
]

/**
 * What the tab bar shows: a tool on its own, or a group of tools behind one
 * button. Eighteen tabs in a row ended in „Mehr“ on every laptop; the tasks
 * people come for stay single, and the editing tools stand in three groups
 * by what they work on. Nothing is dropped — every tool keeps its address and
 * its place in `PANELS`, which stays in the order of this list (checked
 * below), so arrow keys and the slide direction keep meaning the same.
 */
export type TabEntry =
  | { type: 'panel'; panel: PanelMeta }
  | { type: 'group'; id: string; label: string; panels: PanelMeta[] }

const byId = new Map(PANELS.map((panel) => [panel.id, panel]))
const single = (id: PanelId): TabEntry => ({ type: 'panel', panel: byId.get(id)! })
const group = (id: string, label: string, ids: PanelId[]): TabEntry => ({
  type: 'group',
  id,
  label,
  panels: ids.map((member) => byId.get(member)!),
})

export const TAB_ENTRIES: TabEntry[] = [
  single('start'),
  single('merkliste'),
  single('calendar'),
  single('folder'),
  single('player'),
  single('downloader'),
  single('devices'),
  group('bearbeiten', 'Bearbeiten', ['converter', 'video', 'images', 'subtitles']),
  group('ton', 'Ton', ['audio', 'mix', 'stems', 'normalize', 'sampler', 'harmony']),
  group('aufnehmen', 'Aufnehmen', ['screen', 'phone', 'mic']),
]

/** The entry a tool stands in. */
export function entryOf(id: PanelId): number {
  return Math.max(
    0,
    TAB_ENTRIES.findIndex((entry) => (entry.type === 'panel' ? entry.panel.id === id : entry.panels.some((panel) => panel.id === id))),
  )
}

if (import.meta.env.DEV) {
  const flat = TAB_ENTRIES.flatMap((entry) => (entry.type === 'panel' ? [entry.panel] : entry.panels)).map((panel) => panel.id)
  if (flat.join() !== PANELS.map((panel) => panel.id).join()) {
    throw new Error('panelMeta: TAB_ENTRIES und PANELS haben nicht dieselbe Reihenfolge')
  }
}

/**
 * The sound editor's jobs, each with its own mark. Borrowing the editor's
 * icon put the same wave on thirteen tiles, and a field of identical marks
 * reads as no marks at all.
 */
export const ACTION_ICONS: Partial<Record<string, ReactNode>> = {
  'audio-cut': <path d="M5 3.4v9.2M11 3.4v9.2M1.8 8h1.6M12.6 8h1.6M6.6 8l.8-2.4 1.2 4.8.8-2.4" />,
  'audio-fade': <path d="M1.8 12.4L5.6 3.6h4.8l3.8 8.8M1.8 12.4h12.4" />,
  'audio-gain': <path d="M3 12.6v-1.8M6 12.6V8.6M9 12.6V6.2M12 12.6V3.6" />,
  'audio-silence': <path d="M1.6 8h.8l.9-2.8.9 5.6.9-2.8h4.6l.9-2.8.9 5.6.9-2.8h.8" />,
  'audio-clipboard': <path d="M5.6 5.6h7v7h-7zM3.4 10.4v-7h7" />,
  'audio-filter': <path d="M1.8 10.6c1.6 0 2-5.2 3.6-5.2s2 6.2 3.6 6.2 2.2-3.8 5.2-3.8" />,
  'audio-noise': <path d="M1.8 8h1.6l1-2.6 1.4 5.2 1-2.6h1.4M10.6 5.2v.01M12.8 7.2v.01M10.8 10.4v.01M13.2 11.6v.01M12.4 3.8v.01" />,
  'audio-dynamics': <path d="M3.4 8h.01M6 5.6a3.4 3.4 0 010 4.8M8.6 3.6a6.2 6.2 0 010 8.8M11.2 1.8a8.8 8.8 0 010 12.4" />,
  'audio-reverse': <path d="M13.6 4.8H2.6m0 0l2-2m-2 2l2 2M2.6 11.2h1.6l.9-1.8 1.4 3.6 1.4-3.6.9 1.8h4.8" />,
  'audio-join': <path d="M1.8 5.2h4.4v5.6H1.8zM9.8 5.2h4.4v5.6H9.8zM6.2 8h3.6" />,
  'audio-pitch': <path d="M2 12.8h3V9.6h3V6.4h3V3.2h3" />,
  'audio-tempo': <path d="M5.4 13.2L7 2.8h2l1.6 10.4zM4.4 13.2h7.2M8 10.2l3.4-5.2" />,
  'audio-shape': <path d="M9.4 8a3.6 3.6 0 11-7.2 0 3.6 3.6 0 017.2 0zM13.8 8a3.6 3.6 0 11-7.2 0 3.6 3.6 0 017.2 0z" />,
}

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
