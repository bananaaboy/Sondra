/**
 * Every keyboard shortcut and gesture in one place, behind „?“.
 *
 * Designed as a modern, interactive keyboard shortcuts hub featuring:
 * - Category tabs (Reiter) with live count badges
 * - Instant search and filtering with shortcut badges
 * - Tactile, styled keycaps
 * - Interactive 4x4 MPC sampler pad grid with real-time keypress feedback
 * - Comprehensive coverage of audio editing, sampler, player, images, and gestures
 */

import { useEffect, useMemo, useState } from 'react'
import { Dialog } from './ui/primitives'

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Strg'

export type ShortcutCategory = 'alle' | 'allgemein' | 'ton' | 'sampler' | 'player' | 'video-bild' | 'gesten'

export interface CategoryMeta {
  id: ShortcutCategory
  label: string
  shortLabel: string
  description: string
}

export const CATEGORIES: CategoryMeta[] = [
  { id: 'alle', label: 'Alle Kürzel', shortLabel: 'Alle', description: 'Vollständige Übersicht aller Tastaturbefehle und Schnellwahltasten' },
  { id: 'allgemein', label: 'Allgemein', shortLabel: 'Allgemein', description: 'Globale Navigation, Befehlspalette und Fensterelemente' },
  { id: 'ton', label: 'Ton & Schnitt', shortLabel: 'Ton & Schnitt', description: 'Audio-Editor, Schnittwerkzeuge, Tempo und Marker' },
  { id: 'sampler', label: 'Sampler & Beat', shortLabel: 'Sampler', description: '4×4 Pad-Raster, Slices, Aufnahme und Sequenzer' },
  { id: 'player', label: 'Player & Bühne', shortLabel: 'Player', description: 'Wiedergabe, Navigation, Lautstärke und Bühnenmodi' },
  { id: 'video-bild', label: 'Video & Bild', shortLabel: 'Video & Bild', description: 'Videoschnitt, Zeitleiste und Bildbearbeitung' },
  { id: 'gesten', label: 'Maus & Gesten', shortLabel: 'Maus & Gesten', description: 'Wellenform-Zoom, horizontales Scrollen und Drag & Drop' },
]

export interface ShortcutItem {
  id: string
  category: Exclude<ShortcutCategory, 'alle'>
  action: string
  description: string
  keys: Array<string[]>
  badge?: string
  keywords?: string[]
}

const SHORTCUT_ITEMS: ShortcutItem[] = [
  /* Allgemein */
  {
    id: 'help',
    category: 'allgemein',
    action: 'Tastenkürzel-Übersicht',
    description: 'Diese Schnellübersicht jederzeit ein- und ausblenden',
    keys: [['?']],
    badge: 'Global',
    keywords: ['hilfe', 'shortcuts', 'tasten', 'übersicht', 'fragezeichen'],
  },
  {
    id: 'palette',
    category: 'allgemein',
    action: 'Befehlspalette öffnen',
    description: 'Alle Werkzeuge, Aktionen und Dateien in der Sitzung durchsuchen',
    keys: [[MOD, 'K']],
    badge: 'Global',
    keywords: ['suche', 'command', 'palette', 'befehl', 'aktionen', 'find'],
  },
  {
    id: 'paste-file',
    category: 'allgemein',
    action: 'Datei aus Zwischenablage',
    description: 'Kopierte Audio-, Video- oder Bilddateien sofort einfügen',
    keys: [[MOD, 'V']],
    badge: 'Global',
    keywords: ['paste', 'einfügen', 'clipboard', 'zwischenablage', 'datei'],
  },
  {
    id: 'tabs',
    category: 'allgemein',
    action: 'Werkzeug-Reiter wechseln',
    description: 'Zwischen den Hauptwerkzeugen blättern, wenn ein Reiter fokussiert ist',
    keys: [['←'], ['→']],
    badge: 'Navigation',
    keywords: ['tabs', 'reiter', 'pfeiltasten', 'wechseln', 'werkzeuge'],
  },
  {
    id: 'close',
    category: 'allgemein',
    action: 'Dialog oder Suche schließen',
    description: 'Aktiven Dialog, Vollbild oder Befehlspalette beenden',
    keys: [['Esc']],
    badge: 'Global',
    keywords: ['escape', 'abbrechen', 'schließen', 'exit'],
  },
  {
    id: 'tab-nav',
    category: 'allgemein',
    action: 'Bedienelemente durchschalten',
    description: 'Springt schrittweise vor- oder rückwärts zum nächsten Steuerelement',
    keys: [['Tab'], ['Umschalt', 'Tab']],
    badge: 'Navigation',
    keywords: ['tabulator', 'fokus', 'weiterschalten', 'barrierefreiheit'],
  },

  /* Ton & Schnitt */
  {
    id: 'undo-audio',
    category: 'ton',
    action: 'Rückgängig (Undo)',
    description: 'Den letzten Schnitt, Pegeländerung oder Filter zurücknehmen',
    keys: [[MOD, 'Z']],
    badge: 'Editor',
    keywords: ['undo', 'rückgängig', 'zurück', 'schnitt'],
  },
  {
    id: 'redo-audio',
    category: 'ton',
    action: 'Wiederholen (Redo)',
    description: 'Zuletzt rückgängig gemachten Arbeitsschritt erneut anwenden',
    keys: [[MOD, 'Umschalt', 'Z']],
    badge: 'Editor',
    keywords: ['redo', 'wiederholen', 'vorwärts'],
  },
  {
    id: 'copy-audio',
    category: 'ton',
    action: 'Auswahl kopieren',
    description: 'Den ausgewählten Wellenform-Abschnitt kopieren',
    keys: [[MOD, 'C']],
    badge: 'Editor',
    keywords: ['copy', 'kopieren', 'zwischenspeicher'],
  },
  {
    id: 'cut-audio',
    category: 'ton',
    action: 'Auswahl ausschneiden',
    description: 'Den ausgewählten Audioabschnitt entfernen und im Puffer speichern',
    keys: [[MOD, 'X']],
    badge: 'Editor',
    keywords: ['cut', 'ausschneiden', 'cutten'],
  },
  {
    id: 'paste-audio',
    category: 'ton',
    action: 'Audioabschnitt einfügen',
    description: 'Kopierten Ton an der aktuellen Abspielposition einsetzen',
    keys: [[MOD, 'V']],
    badge: 'Editor',
    keywords: ['paste', 'einfügen', 'position'],
  },
  {
    id: 'tap-tempo',
    category: 'ton',
    action: 'Tap-Tempo (BPM)',
    description: 'Takt mit der Taste T mitklopfen, um das Tempo (BPM) live zu messen',
    keys: [['T']],
    badge: 'Werkzeug',
    keywords: ['tap', 'tempo', 'bpm', 'beats', 'takt', 'metronom'],
  },
  {
    id: 'play-audio',
    category: 'ton',
    action: 'Vorhören starten / anhalten',
    description: 'Spielt den Audioeditor ab oder stoppt die Wiedergabe',
    keys: [['Leertaste']],
    badge: 'Editor',
    keywords: ['play', 'pause', 'abspielen', 'vorhören', 'space'],
  },
  {
    id: 'zoom-wheel',
    category: 'ton',
    action: 'Wellenform horizontal zoomen',
    description: 'Mausrad über der Welle drehen, um stufenlos hinein- und herauszuzoomen',
    keys: [['Mausrad']],
    badge: 'Welle',
    keywords: ['zoom', 'mausrad', 'welle', 'vergrößern', 'verkleinern'],
  },
  {
    id: 'scroll-wave',
    category: 'ton',
    action: 'Wellenform-Ausschnitt scrollen',
    description: 'Umschalt gedrückt halten und Mausrad drehen, um horizontal zu scrollen',
    keys: [['Umschalt', 'Mausrad']],
    badge: 'Welle',
    keywords: ['scroll', 'horizontal', 'verschieben', 'ausschnitt'],
  },

  /* Sampler & Beat */
  {
    id: 'sampler-pads',
    category: 'sampler',
    action: 'Pads 1–16 spielen',
    description: 'Tasten 1–4, Q–R, A–F und Y–V triggern die 16 Pads wie auf einer MPC',
    keys: [['1–4'], ['Q–R'], ['A–F'], ['Y–V']],
    badge: 'Hardware-Layout',
    keywords: ['pads', 'mpc', 'sampler', 'slices', 'trigger', 'beat', 'drums'],
  },
  {
    id: 'sampler-add-pad',
    category: 'sampler',
    action: 'Auswahl als Pad anlegen',
    description: 'Aktuell markierten Wellenform-Bereich sofort als neues Slice-Pad anlegen',
    keys: [['Enter']],
    badge: 'Sampler',
    keywords: ['pad', 'slice', 'erstellen', 'anlegen', 'enter'],
  },
  {
    id: 'sampler-delete-pad',
    category: 'sampler',
    action: 'Gewähltes Pad löschen',
    description: 'Das aktuell ausgewählte Slice-Pad aus der Bank entfernen',
    keys: [['Entf']],
    badge: 'Sampler',
    keywords: ['löschen', 'entfernen', 'delete', 'pad'],
  },
  {
    id: 'sampler-stop-all',
    category: 'sampler',
    action: 'Alle Pads anhalten / Beat',
    description: 'Stoppt sofort alle klingenden Slices; startet/pausiert im Beat-Modus',
    keys: [['Leertaste']],
    badge: 'Sampler',
    keywords: ['stopp', 'anhalten', 'choke', 'beat', 'space'],
  },
  {
    id: 'sampler-midi',
    category: 'sampler',
    action: 'USB-MIDI Dynamik',
    description: 'Angeschlossene MIDI-Keyboards und Pad-Controller spielen mit Velocity',
    keys: [['USB-MIDI']],
    badge: 'Hardware',
    keywords: ['midi', 'controller', 'keyboard', 'velocity', 'anschlag'],
  },

  /* Player & Bühne */
  {
    id: 'player-toggle',
    category: 'player',
    action: 'Abspielen und anhalten',
    description: 'Startet oder stoppt die Wiedergabe des aktuellen Mediums',
    keys: [['Leertaste'], ['K']],
    badge: 'Player',
    keywords: ['play', 'pause', 'abspielen', 'anhalten', 'stop'],
  },
  {
    id: 'player-seek',
    category: 'player',
    action: 'Kurzer Zeitsprung vor / zurück',
    description: 'Springt um die konfigurierte Schrittweite (Standard: 5 Sekunden)',
    keys: [['←'], ['→']],
    badge: 'Player',
    keywords: ['seek', 'spulen', 'pfeiltasten', 'springen'],
  },
  {
    id: 'player-seek-10',
    category: 'player',
    action: '10 Sekunden vor / zurück',
    description: 'J springt 10 Sekunden zurück, L springt 10 Sekunden vorwärts',
    keys: [['J'], ['L']],
    badge: 'Player',
    keywords: ['10s', 'vor', 'zurück', 'jkl', 'youtube'],
  },
  {
    id: 'player-volume',
    category: 'player',
    action: 'Lautstärke lauter / leiser',
    description: 'Regelt die Lautstärke im Player schrittweise um 5%',
    keys: [['↑'], ['↓']],
    badge: 'Player',
    keywords: ['lautstärke', 'volume', 'lauter', 'leiser'],
  },
  {
    id: 'player-mute',
    category: 'player',
    action: 'Ton stummschalten (Mute)',
    description: 'Schaltet Audio stumm oder stellt die vorherige Lautstärke wieder her',
    keys: [['M']],
    badge: 'Player',
    keywords: ['mute', 'stumm', 'lautlos'],
  },
  {
    id: 'player-fullscreen',
    category: 'player',
    action: 'Vollbildmodus',
    description: 'Schaltet die Videobühne in den echten Vollbildmodus um',
    keys: [['F']],
    badge: 'Player',
    keywords: ['fullscreen', 'vollbild', 'monitor'],
  },
  {
    id: 'player-web-full',
    category: 'player',
    action: 'Fensterfüllender Modus',
    description: 'Passt das Video optimal in den gesamten Browserbereich ein',
    keys: [['W']],
    badge: 'Video',
    keywords: ['fenster', 'web-vollbild', 'video'],
  },
  {
    id: 'player-theater',
    category: 'player',
    action: 'Kino- / Theatermodus',
    description: 'Vergrößert die Videobühne und blendet Seitenleisten aus',
    keys: [['T']],
    badge: 'Video',
    keywords: ['theater', 'kino', 'bühne', 'groß'],
  },
  {
    id: 'player-subtitles',
    category: 'player',
    action: 'Untertitel umschalten',
    description: 'Aktiviert oder deaktiviert vorhandene Untertitelspuren',
    keys: [['C']],
    badge: 'Video',
    keywords: ['untertitel', 'captions', 'subtitles', 'text'],
  },
  {
    id: 'player-next-prev',
    category: 'player',
    action: 'Nächstes / vorheriges Medium',
    description: 'N springt zum nächsten, P zum vorherigen Asset der Sitzung',
    keys: [['N'], ['P']],
    badge: 'Player',
    keywords: ['nächstes', 'vorheriges', 'next', 'previous', 'playlist'],
  },
  {
    id: 'player-skip-opening',
    category: 'player',
    action: 'Vorspann überspringen',
    description: 'Springt ans Ende des Vorspanns — am Ton erkannt, sonst um seine feste Länge',
    keys: [['S']],
    badge: 'Video',
    keywords: ['vorspann', 'intro', 'opening', 'überspringen', 'skip'],
  },
  {
    id: 'player-bookmark',
    category: 'player',
    action: 'Lesezeichen setzen',
    description: 'Merkt sich die Stelle, die gerade läuft — bei dieser Datei, auf diesem Gerät',
    keys: [['B']],
    badge: 'Player',
    keywords: ['lesezeichen', 'marke', 'bookmark', 'kapitel', 'stelle'],
  },
  {
    id: 'player-bookmark-jump',
    category: 'player',
    action: 'Zum vorigen / nächsten Lesezeichen',
    description: 'Springt zwischen den Lesezeichen der Datei',
    keys: [['Umschalt', '←'], ['Umschalt', '→']],
    badge: 'Player',
    keywords: ['lesezeichen', 'springen', 'kapitel', 'bookmark'],
  },
  {
    id: 'player-loop-ab',
    category: 'player',
    action: 'A-B Loop setzen',
    description: 'A und B markieren Anfang und Ende einer Endlosschleife',
    keys: [['A-B']],
    badge: 'Player',
    keywords: ['loop', 'ab', 'schleife', 'wiederholen'],
  },
  {
    id: 'player-frame',
    category: 'player',
    action: 'Bild für Bild (Frame-Step)',
    description: 'Bei angehaltenem Video genau 1 Frame zurück (,) oder vor (.)',
    keys: [[','], ['.']],
    badge: 'Video',
    keywords: ['frame', 'bild', 'einzelbild', 'schritt'],
  },
  {
    id: 'player-speed',
    category: 'player',
    action: 'Geschwindigkeit anpassen',
    description: 'Wiedergabetempo schrittweise verringern (<) oder erhöhen (>)',
    keys: [['<'], ['>']],
    badge: 'Player',
    keywords: ['tempo', 'geschwindigkeit', 'speed', 'rate', 'schneller', 'langsamer'],
  },
  {
    id: 'player-jump-percent',
    category: 'player',
    action: 'Zeitsprung in 10%-Schritten',
    description: 'Ziffer 0 springt an den Anfang, 1–9 springen direkt zu 10%–90%',
    keys: [['0 … 9']],
    badge: 'Player',
    keywords: ['prozent', 'zahlen', 'sprung', 'position'],
  },

  /* Video & Bild */
  {
    id: 'undo-image',
    category: 'video-bild',
    action: 'Bildbearbeitung rückgängig',
    description: 'Nimmt den letzten Zuschnitt, Filter oder Skalierung zurück',
    keys: [[MOD, 'Z']],
    badge: 'Bilder',
    keywords: ['undo', 'rückgängig', 'bild', 'foto'],
  },
  {
    id: 'redo-image',
    category: 'video-bild',
    action: 'Bildbearbeitung wiederholen',
    description: 'Stellt rückgängig gemachte Bildbearbeitungen wieder her',
    keys: [[MOD, 'Umschalt', 'Z']],
    badge: 'Bilder',
    keywords: ['redo', 'wiederholen', 'bild'],
  },
  {
    id: 'compare-image',
    category: 'video-bild',
    action: 'Originalbild vergleichen',
    description: 'Leertaste gedrückt halten, um das unbehandelte Original anzuzeigen',
    keys: [['Leertaste halten']],
    badge: 'Bilder',
    keywords: ['original', 'vergleich', 'vorher', 'nachher', 'leertaste'],
  },
  {
    id: 'video-timeline-nav',
    category: 'video-bild',
    action: 'Zeitleisten-Schritt',
    description: 'Auf der Videoschnitt-Zeitleiste ein Stück weiter oder zurück bewegen',
    keys: [['←'], ['→']],
    badge: 'Video',
    keywords: ['video', 'zeitleiste', 'timeline', 'navigation'],
  },

  /* Maus & Gesten */
  {
    id: 'drag-drop',
    category: 'gesten',
    action: 'Datei per Drag & Drop öffnen',
    description: 'Beliebige Mediendatei einfach aus dem Explorer ins Fenster ziehen',
    keys: [['Datei ins Fenster ziehen']],
    badge: 'Geste',
    keywords: ['drag', 'drop', 'ziehen', 'öffnen', 'import'],
  },
  {
    id: 'wave-zoom-gesture',
    category: 'gesten',
    action: 'Wellenform stufenlos zoomen',
    description: 'Mausrad über der Tonspur drehen: vergrößert exakt um die Zeigerposition',
    keys: [['Mausrad auf Wellenform']],
    badge: 'Welle',
    keywords: ['zoom', 'mausrad', 'lupe', 'welle'],
  },
  {
    id: 'wave-scroll-gesture',
    category: 'gesten',
    action: 'Wellenform seitlich verschieben',
    description: 'Umschalt gedrückt halten + Mausrad: bewegt den sichtbaren Bereich',
    keys: [['Umschalt + Mausrad']],
    badge: 'Welle',
    keywords: ['pan', 'scrollen', 'verschieben', 'umschalt'],
  },
  {
    id: 'visualizer-click',
    category: 'gesten',
    action: 'Visualizer-Stil umschalten',
    description: 'Klick auf den Musik-Visualizer wechselt zwischen Balken, Welle und Kreis',
    keys: [['Klick auf Visualizer']],
    badge: 'Player',
    keywords: ['visualizer', 'klick', 'stil', 'spektrum', 'balken', 'radial'],
  },
]

const PAD_GRID = [
  ['1', '2', '3', '4'],
  ['Q', 'W', 'E', 'R'],
  ['A', 'S', 'D', 'F'],
  ['Y', 'X', 'C', 'V'],
]

const PAD_ORDER = ['1', '2', '3', '4', 'q', 'w', 'e', 'r', 'a', 's', 'd', 'f', 'y', 'x', 'c', 'v']

function KeyCap({
  label,
  active,
}: {
  label: string
  active?: boolean
}) {
  return (
    <kbd
      className={`inline-flex items-center justify-center min-w-[26px] h-[26px] px-[8px] py-[1px] rounded-[5px] font-mono text-micro font-bold select-none border transition-all duration-100 ${
        active
          ? 'bg-ink text-on-ink border-ink shadow-[0_1px_0_1px_rgba(0,0,0,0.25)] scale-95'
          : 'bg-raised text-ink border-rule/70 shadow-[0_1.5px_0_1px_rgba(0,0,0,0.08)]'
      }`}
    >
      {label}
    </kbd>
  )
}

function ShortcutKeys({
  keys,
  activeKey,
}: {
  keys: Array<string[]>
  activeKey?: string | null
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-[6px]">
      {keys.map((combo, comboIdx) => (
        <span key={comboIdx} className="inline-flex items-center gap-[4px]">
          {comboIdx > 0 ? (
            <span className="px-[3px] text-micro text-muted font-sans font-normal">oder</span>
          ) : null}
          {combo.map((k, kIdx) => {
            const isPressed = activeKey
              ? activeKey.toLowerCase() === k.toLowerCase() ||
                (k === 'Leertaste' && activeKey === ' ') ||
                (k === 'Enter' && activeKey === 'Enter') ||
                (k === 'Esc' && activeKey === 'Escape') ||
                (k === 'Entf' && (activeKey === 'Delete' || activeKey === 'Backspace'))
              : false
            return (
              <span key={kIdx} className="inline-flex items-center gap-[4px]">
                {kIdx > 0 ? <span className="text-micro text-muted font-mono font-medium">+</span> : null}
                <KeyCap label={k} active={isPressed} />
              </span>
            )
          })}
        </span>
      ))}
    </div>
  )
}

function SamplerPadMatrix({ activeKey }: { activeKey?: string | null }) {
  return (
    <div className="mb-[20px] rounded-card bg-panel-soft p-[16px] ring-1 ring-rule/40">
      <div className="flex flex-wrap items-baseline justify-between gap-[8px] mb-[12px]">
        <div>
          <span className="text-small font-semibold text-ink">4×4 Hardware-Pad-Belegung</span>
          <p className="text-micro text-muted">
            Entspricht der klassischen MPC-Anordnung. Gate-Pads stoppen beim Loslassen, One-Shot-Pads klingen aus.
          </p>
        </div>
        <span className="font-mono text-micro text-muted">Pads 1–16</span>
      </div>
      <div className="grid grid-cols-4 gap-[8px] max-w-[340px]">
        {PAD_GRID.flat().map((padKey) => {
          const isLit = activeKey?.toLowerCase() === padKey.toLowerCase()
          const padNumber = PAD_ORDER.indexOf(padKey.toLowerCase()) + 1
          return (
            <div
              key={padKey}
              className={`flex h-[52px] flex-col items-center justify-center rounded-nav border transition-all duration-100 select-none ${
                isLit
                  ? 'bg-ink text-on-ink border-ink shadow-inner font-bold scale-95'
                  : 'bg-raised text-ink border-rule/60 hover:bg-panel-mid'
              }`}
            >
              <span className="font-mono text-small font-bold">{padKey}</span>
              <span className={`text-[10px] ${isLit ? 'text-on-ink/80' : 'text-muted'}`}>
                Pad {padNumber}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ShortcutHelp() {
  const [open, setOpen] = useState(false)
  const [activeCategory, setActiveCategory] = useState<ShortcutCategory>('alle')
  const [searchQuery, setSearchQuery] = useState('')
  const [activeKey, setActiveKey] = useState<string | null>(null)

  useEffect(() => {
    let keyTimeout: number | null = null

    const onKey = (event: KeyboardEvent) => {
      // Toggle dialog with ?
      if (event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target as HTMLElement | null
        if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return
        event.preventDefault()
        setOpen((value) => !value)
        return
      }

      // If dialog is open, track pressed key for visual feedback
      if (open) {
        const target = event.target as HTMLElement | null
        const inInput = Boolean(target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

        if (event.key === 'Escape' && searchQuery.trim() !== '') {
          event.preventDefault()
          setSearchQuery('')
          return
        }

        if (!inInput) {
          setActiveKey(event.key)
          if (keyTimeout) window.clearTimeout(keyTimeout)
          keyTimeout = window.setTimeout(() => setActiveKey(null), 1000)
        }
      }
    }

    const onAsk = () => {
      setOpen(true)
      setSearchQuery('')
      setActiveKey(null)
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('sondra:tastenkuerzel', onAsk)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('sondra:tastenkuerzel', onAsk)
      if (keyTimeout) window.clearTimeout(keyTimeout)
    }
  }, [open, searchQuery])

  // Filter items based on active category and search query
  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return SHORTCUT_ITEMS.filter((item) => {
      if (activeCategory !== 'alle' && item.category !== activeCategory) {
        return false
      }
      if (!q) return true

      const matchAction = item.action.toLowerCase().includes(q)
      const matchDesc = item.description.toLowerCase().includes(q)
      const matchBadge = item.badge?.toLowerCase().includes(q) ?? false
      const matchKeywords = item.keywords?.some((kw) => kw.toLowerCase().includes(q)) ?? false
      const matchKeys = item.keys.some((combo) => combo.some((k) => k.toLowerCase().includes(q)))

      return matchAction || matchDesc || matchBadge || matchKeywords || matchKeys
    })
  }, [activeCategory, searchQuery])

  // Group filtered items by category when showing "alle" or searching
  const groupedSections = useMemo(() => {
    const categoriesToShow = activeCategory === 'alle'
      ? CATEGORIES.filter((c) => c.id !== 'alle')
      : CATEGORIES.filter((c) => c.id === activeCategory)

    return categoriesToShow
      .map((cat) => ({
        meta: cat,
        items: filteredItems.filter((item) => item.category === cat.id),
      }))
      .filter((sec) => sec.items.length > 0)
  }, [activeCategory, filteredItems])

  const showPadMatrix = (activeCategory === 'sampler' || activeCategory === 'alle') &&
    (searchQuery.trim() === '' || 'sampler'.includes(searchQuery.toLowerCase()) || 'pad'.includes(searchQuery.toLowerCase()))

  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Tastenkürzel & Gesten" size="lg">
      <div className="flex flex-col gap-[20px]">
        {/* Search and Quick Tip Bar */}
        <div className="flex flex-col gap-[12px] sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 min-w-[260px]">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Kürzel oder Aktion suchen (z. B. Strg+Z, Leertaste, Schneiden, Tempo)…"
              className="w-full rounded-pill bg-raised px-[16px] py-[9px] pr-[38px] text-small text-ink ring-1 ring-inset ring-line placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ink"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Suche leeren"
                className="absolute right-[12px] top-1/2 -translate-y-1/2 p-[4px] text-muted hover:text-ink"
              >
                <svg viewBox="0 0 16 16" className="h-[14px] w-[14px]" fill="none" aria-hidden>
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-[8px]">
            <span className="font-mono text-micro text-muted">
              {filteredItems.length} {filteredItems.length === 1 ? 'Kürzel' : 'Kürzel'}
            </span>
            <span className="text-micro text-muted">·</span>
            <span className="text-micro text-muted">
              Drücke <KeyCap label="?" /> zum Umschalten
            </span>
          </div>
        </div>

        {/* Category Tabs (Reiter) */}
        <nav className="flex flex-wrap gap-[6px] border-b border-line/60 pb-[14px]" aria-label="Tastenkürzel-Kategorien" role="tablist">
          {CATEGORIES.map((cat) => {
            const isActive = activeCategory === cat.id
            const count = cat.id === 'alle'
              ? SHORTCUT_ITEMS.length
              : SHORTCUT_ITEMS.filter((item) => item.category === cat.id).length
            return (
              <button
                key={cat.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveCategory(cat.id)}
                className={`press inline-flex items-center gap-[6px] rounded-pill px-[12px] py-[6px] text-small transition-all ${
                  isActive
                    ? 'bg-ink text-on-ink font-semibold shadow-sm'
                    : 'bg-panel-soft text-prose hover:bg-panel-mid hover:text-ink'
                }`}
              >
                <span>{cat.shortLabel}</span>
                <span
                  className={`rounded-pill px-[6px] py-[1px] text-micro leading-none font-mono ${
                    isActive ? 'bg-on-ink/20 text-on-ink' : 'bg-canvas text-muted'
                  }`}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </nav>

        {/* Sampler Visual 4x4 Matrix (if Sampler category or search matches) */}
        {showPadMatrix ? <SamplerPadMatrix activeKey={activeKey} /> : null}

        {/* Shortcut Groups / Cards */}
        {groupedSections.length > 0 ? (
          <div className="grid gap-[20px]">
            {groupedSections.map(({ meta, items }) => (
              <section key={meta.id} className="rounded-card bg-panel-soft/60 p-[16px] ring-1 ring-rule/40">
                <div className="flex flex-wrap items-baseline justify-between gap-[8px] mb-[12px] border-b border-line/60 pb-[8px]">
                  <div>
                    <h3 className="text-small font-semibold text-ink">{meta.label}</h3>
                    <p className="text-micro text-muted">{meta.description}</p>
                  </div>
                  <span className="font-mono text-micro text-muted">
                    {items.length} {items.length === 1 ? 'Eintrag' : 'Einträge'}
                  </span>
                </div>

                <div className="flex flex-col">
                  {items.map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-col gap-[6px] border-t border-line/50 py-[10px] first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:gap-[16px] hover:bg-canvas/50 px-[8px] -mx-[8px] rounded-nav transition-colors"
                    >
                      <div className="flex flex-col gap-[2px]">
                        <div className="flex items-center gap-[8px]">
                          <span className="text-small font-semibold text-ink">{item.action}</span>
                          {item.badge ? (
                            <span className="rounded-[3px] bg-panel-mid px-[6px] py-[1px] text-[10px] font-medium uppercase tracking-wider text-muted">
                              {item.badge}
                            </span>
                          ) : null}
                        </div>
                        <span className="text-micro text-muted leading-relaxed">{item.description}</span>
                      </div>
                      <div className="shrink-0 pt-[2px] sm:pt-0">
                        <ShortcutKeys keys={item.keys} activeKey={activeKey} />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-[48px] text-center rounded-card bg-panel-soft/40 ring-1 ring-rule/30">
            <p className="text-small font-semibold text-ink">Keine Tastenkürzel gefunden</p>
            <p className="mt-[4px] text-micro text-muted max-w-[36ch]">
              Für den Suchbegriff „{searchQuery}“ wurden in dieser Kategorie keine passenden Aktionen gefunden.
            </p>
            <button
              type="button"
              onClick={() => {
                setSearchQuery('')
                setActiveCategory('alle')
              }}
              className="mt-[16px] rounded-pill bg-ink px-[14px] py-[6px] text-small font-medium text-on-ink hover:opacity-90 transition-opacity"
            >
              Suche zurücksetzen
            </button>
          </div>
        )}

        {/* Footer info note */}
        <div className="flex flex-wrap items-center justify-between gap-[12px] border-t border-line/60 pt-[14px] text-micro text-muted">
          <span>Tipp: Umschalt + Mausrad verschiebt die Wellenform seitlich; Mausrad zoomt.</span>
          <span>Taste Esc schließt diese Übersicht</span>
        </div>
      </div>
    </Dialog>
  )
}
