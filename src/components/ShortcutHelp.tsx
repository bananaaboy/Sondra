/**
 * Every keyboard shortcut in one place, behind „?“.
 *
 * The shortcuts were real but scattered — Strg+Z in the image tool, the pad
 * keys in the chopper, the wheel on the waveform — and only findable by
 * accident or in a tooltip. The list is written by hand, next to the code it
 * describes, not generated: a shortcut is part of a tool's design.
 */

import { useEffect, useState } from 'react'

import { Dialog } from './ui/primitives'

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Strg'

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: 'Überall',
    keys: [
      ['?', 'Diese Übersicht'],
      [`${MOD} + K`, 'Befehle und Werkzeuge suchen'],
      [`${MOD} + V`, 'Datei aus der Zwischenablage einfügen'],
      ['Datei ins Fenster ziehen', 'Öffnen'],
      ['← →', 'Zwischen den Reitern wechseln, wenn einer gewählt ist'],
    ],
  },
  {
    title: 'Ton',
    keys: [
      ['Mausrad auf der Welle', 'Hinein- und herauszoomen, um den Zeiger herum'],
      ['Umschalt + Mausrad', 'Den Ausschnitt verschieben'],
      [`${MOD} + Z`, 'Rückgängig'],
      [`${MOD} + Umschalt + Z`, 'Wiederholen'],
      [`${MOD} + C · X · V`, 'Auswahl kopieren, ausschneiden, einfügen'],
    ],
  },
  {
    title: 'Zerschneiden',
    keys: [
      ['1 2 3 4 · Q W E R · A S D F · Y X C V', 'Pads spielen'],
      ['Enter', 'Gezogenen Bereich als Pad anlegen'],
      ['Entf', 'Gewähltes Pad löschen'],
      ['Leertaste', 'Alles anhalten; im Beat: abspielen und anhalten'],
    ],
  },
  {
    title: 'Bilder und Video',
    keys: [
      [`${MOD} + Z`, 'Bilder: Rückgängig'],
      ['Leertaste halten', 'Bilder: Original zum Vergleich'],
      ['← →', 'Video: auf der Zeitleiste ein Stück weiter'],
    ],
  },
]

export function ShortcutHelp() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return
      event.preventDefault()
      setOpen((value) => !value)
    }
    // The footer's „Tastenkürzel“ link, for anyone who does not guess „?“.
    const onAsk = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('sondra:tastenkuerzel', onAsk)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('sondra:tastenkuerzel', onAsk)
    }
  }, [])

  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Tastenkürzel">
      <div className="grid gap-x-[32px] gap-y-[24px] sm:grid-cols-2">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h3 className="mb-[8px] text-small font-semibold text-ink">{group.title}</h3>
            <dl className="flex flex-col">
              {group.keys.map(([keys, what]) => (
                <div key={keys + what} className="flex items-baseline justify-between gap-[16px] border-t border-line py-[8px] first:border-t-0">
                  <dt className="text-small text-prose">{what}</dt>
                  <dd className="value shrink-0 text-right text-small text-ink">{keys}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  )
}
