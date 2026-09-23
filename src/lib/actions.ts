/**
 * What Sondra can do, in one list.
 *
 * Every tool used to describe itself in exactly one place — its tab — which
 * made two things impossible. A file could not say what could be done with it,
 * and nobody could find a capability without already knowing which tab owned
 * it. Both are answered by turning the tools into data.
 *
 * The same list feeds the tab bar, the actions offered on a selected file, the
 * search box and the command palette. Adding an entry here makes a capability
 * findable everywhere at once; there is no second place to remember.
 */

import type { AssetKind, PanelId } from '../state/store'

/** The heading a capability is filed under in the search results. */
export type ToolGroup = 'holen' | 'ton' | 'video' | 'bild' | 'musik'

export const GROUP_LABEL: Record<ToolGroup, string> = {
  holen: 'Hereinholen',
  ton: 'Ton',
  video: 'Video',
  bild: 'Bilder',
  musik: 'Für Musik',
}

export interface ToolAction {
  id: string
  panel: PanelId
  group: ToolGroup
  /** What it produces, in the user's words. */
  label: string
  hint: string
  /**
   * The file kinds this applies to. Empty means it needs no file at all —
   * the downloader is the only one of those, because it is how files arrive.
   */
  kinds: AssetKind[]
  /** Extra words people actually type, including the English ones. */
  keywords: string[]
}

export const ACTIONS: ToolAction[] = [
  /* -- getting things in ---------------------------------------------------- */
  {
    id: 'download',
    panel: 'downloader',
    group: 'holen',
    label: 'Von einer Adresse laden',
    hint: 'Video oder Lied aus dem Netz holen',
    kinds: [],
    keywords: ['download', 'youtube', 'url', 'link', 'herunterladen', 'import', 'holen', 'stream'],
  },

  /* -- the microphone -------------------------------------------------------- */
  {
    id: 'mic-test',
    panel: 'mic',
    group: 'ton',
    label: 'Mikrofon testen',
    hint: 'Pegel, Ein- und Ausgang, Probe anhören',
    kinds: [],
    keywords: ['mikrofon', 'mic', 'microphone', 'test', 'pegel', 'eingang', 'ausgang', 'headset', 'aufnahme'],
  },
  {
    id: 'mic-calibrate',
    panel: 'mic',
    group: 'ton',
    label: 'Mikrofon einstellen',
    hint: 'Rauschen weg, Stimme klar — für Podcast, Stream, Musik',
    kinds: [],
    keywords: ['kalibrieren', 'rauschen', 'noise', 'podcast', 'streaming', 'obs', 'discord', 'videocall', 'gate', 'filter'],
  },

  /* -- converting ----------------------------------------------------------- */
  {
    id: 'convert-audio',
    panel: 'converter',
    group: 'ton',
    label: 'In ein anderes Format bringen',
    hint: 'MP3, FLAC, WAV, AAC, Opus, ALAC, Vorbis',
    kinds: ['audio', 'video'],
    keywords: ['convert', 'umwandeln', 'mp3', 'flac', 'wav', 'aac', 'opus', 'alac', 'format', 'konvertieren'],
  },
  {
    id: 'extract-audio',
    panel: 'video',
    group: 'ton',
    label: 'Ton aus dem Video holen',
    hint: 'Die Tonspur als eigene Datei',
    kinds: ['video'],
    keywords: ['extract audio', 'ton', 'tonspur', 'audio', 'herauslösen', 'trennen', 'mp3 aus video'],
  },

  /* -- video ---------------------------------------------------------------- */
  {
    id: 'video-trim',
    panel: 'video',
    group: 'video',
    label: 'Video zuschneiden',
    hint: 'Anfang und Ende festlegen',
    kinds: ['video'],
    keywords: ['cut', 'trim', 'schneiden', 'kürzen', 'zuschneiden', 'ausschnitt', 'split'],
  },
  {
    id: 'video-crop',
    panel: 'video',
    group: 'video',
    label: 'Bildausschnitt ändern',
    hint: 'Ränder wegschneiden, Format ändern',
    kinds: ['video'],
    keywords: ['crop', 'ausschnitt', 'ränder', 'format', '16:9', '9:16', 'hochkant', 'quadrat'],
  },
  {
    id: 'video-rotate',
    panel: 'video',
    group: 'video',
    label: 'Drehen oder spiegeln',
    hint: 'Hochkant-Aufnahmen geraderücken',
    kinds: ['video', 'image'],
    keywords: ['rotate', 'drehen', 'spiegeln', 'flip', 'hochkant', 'querformat'],
  },
  {
    id: 'video-speed',
    panel: 'video',
    group: 'video',
    label: 'Geschwindigkeit ändern',
    hint: 'Zeitraffer oder Zeitlupe',
    kinds: ['video'],
    keywords: ['speed', 'geschwindigkeit', 'zeitlupe', 'zeitraffer', 'slow motion', 'schneller', 'langsamer'],
  },
  {
    id: 'video-resize',
    panel: 'video',
    group: 'video',
    label: 'Auflösung ändern',
    hint: '1080p, 720p, kleiner machen',
    kinds: ['video'],
    keywords: ['resize', 'auflösung', '1080p', '720p', '4k', 'verkleinern', 'komprimieren', 'kleiner'],
  },
  {
    id: 'video-mute',
    panel: 'video',
    group: 'video',
    label: 'Ton entfernen',
    hint: 'Video ohne Tonspur',
    kinds: ['video'],
    keywords: ['mute', 'stumm', 'ton weg', 'ohne ton', 'silence'],
  },
  {
    id: 'video-frame',
    panel: 'video',
    group: 'video',
    label: 'Einzelbild speichern',
    hint: 'Ein Standbild aus dem Video',
    kinds: ['video'],
    keywords: ['frame', 'standbild', 'screenshot', 'thumbnail', 'vorschaubild', 'einzelbild'],
  },
  {
    id: 'video-gif',
    panel: 'video',
    group: 'video',
    label: 'GIF daraus machen',
    hint: 'Kurzer Ausschnitt als GIF',
    kinds: ['video'],
    keywords: ['gif', 'animation', 'schleife', 'loop'],
  },

  /* -- images --------------------------------------------------------------- */
  {
    id: 'image-resize',
    panel: 'images',
    group: 'bild',
    label: 'Bild skalieren',
    hint: 'Auf eine Zielbreite bringen',
    kinds: ['image'],
    keywords: ['resize', 'skalieren', 'verkleinern', 'vergrößern', 'größe', 'pixel', 'breite'],
  },
  {
    id: 'image-convert',
    panel: 'images',
    group: 'bild',
    label: 'Bildformat ändern',
    hint: 'PNG, JPEG oder WebP',
    kinds: ['image'],
    keywords: ['convert', 'png', 'jpg', 'jpeg', 'webp', 'umwandeln', 'format'],
  },
  {
    id: 'image-compress',
    panel: 'images',
    group: 'bild',
    label: 'Bild kleiner machen',
    hint: 'Qualität gegen Dateigröße abwägen',
    kinds: ['image'],
    keywords: ['compress', 'komprimieren', 'optimieren', 'kleiner', 'dateigröße', 'quality'],
  },
  {
    id: 'image-crop',
    panel: 'images',
    group: 'bild',
    label: 'Bild zuschneiden',
    hint: 'Ausschnitt aufziehen',
    kinds: ['image'],
    keywords: ['crop', 'zuschneiden', 'ausschnitt', 'beschneiden'],
  },
  {
    id: 'image-adjust',
    panel: 'images',
    group: 'bild',
    label: 'Helligkeit und Farbe',
    hint: 'Helligkeit, Kontrast, Sättigung, Schärfe',
    kinds: ['image'],
    keywords: ['brightness', 'helligkeit', 'kontrast', 'sättigung', 'farbe', 'schärfen', 'weichzeichnen', 'blur', 'filter'],
  },
  {
    id: 'image-batch',
    panel: 'images',
    group: 'bild',
    label: 'Viele Bilder auf einmal',
    hint: 'Dieselben Schritte auf alle, Ergebnis als ZIP',
    kinds: ['image'],
    keywords: ['batch', 'stapel', 'alle', 'mehrere', 'massen', 'zip'],
  },

  /* -- editing sound -------------------------------------------------------- */
  {
    id: 'audio-cut',
    panel: 'audio',
    group: 'ton',
    label: 'Ton schneiden',
    hint: 'Ausschnitt wählen, behalten oder herausschneiden',
    kinds: ['audio'],
    keywords: ['cut', 'trim', 'schneiden', 'kürzen', 'ausschnitt', 'crop', 'split', 'bearbeiten', 'editor'],
  },
  {
    id: 'audio-fade',
    panel: 'audio',
    group: 'ton',
    label: 'Ein- und ausblenden',
    hint: 'Weiche Anfänge und Enden',
    kinds: ['audio'],
    keywords: ['fade', 'blende', 'einblenden', 'ausblenden', 'fade in', 'fade out', 'weich'],
  },
  {
    id: 'audio-gain',
    panel: 'audio',
    group: 'ton',
    label: 'Lauter oder leiser',
    hint: 'Pegel in dB, auch nur im Ausschnitt',
    kinds: ['audio'],
    keywords: ['gain', 'pegel', 'lauter', 'leiser', 'volume', 'db', 'verstärken', 'peak'],
  },
  {
    id: 'audio-silence',
    panel: 'audio',
    group: 'ton',
    label: 'Stille entfernen',
    hint: 'Pausen finden und herausschneiden',
    kinds: ['audio'],
    keywords: ['silence', 'stille', 'pausen', 'leerlauf', 'trim silence', 'entfernen'],
  },
  {
    id: 'audio-clipboard',
    panel: 'audio',
    group: 'ton',
    label: 'Kopieren, einfügen, verdoppeln',
    hint: 'Ausschnitte umstellen, Stille einfügen, stummschalten',
    kinds: ['audio'],
    keywords: ['kopieren', 'einfügen', 'copy', 'paste', 'duplizieren', 'stumm', 'mute', 'stille einfügen', 'schleife', 'loop', 'zoom'],
  },
  {
    id: 'audio-filter',
    panel: 'audio',
    group: 'ton',
    label: 'Filter, Bass und Höhen',
    hint: 'Tiefen oder Höhen entfernen, Klang anpassen',
    kinds: ['audio'],
    keywords: ['eq', 'equalizer', 'hochpass', 'tiefpass', 'bass', 'höhen', 'treble', 'filter', 'rumpeln'],
  },
  {
    id: 'audio-noise',
    panel: 'audio',
    group: 'ton',
    label: 'Rauschen entfernen',
    hint: 'Aus einer ruhigen Stelle lernen, dann herausrechnen',
    kinds: ['audio'],
    keywords: ['rauschen', 'noise', 'denoise', 'rauschunterdrückung', 'brummen', 'hiss'],
  },
  {
    id: 'audio-dynamics',
    panel: 'audio',
    group: 'ton',
    label: 'Kompressor, Echo, Hall',
    hint: 'Dynamik bändigen, Raum und Wiederholungen dazu',
    kinds: ['audio'],
    keywords: ['kompressor', 'compressor', 'echo', 'delay', 'hall', 'reverb', 'raum', 'effekt'],
  },
  {
    id: 'audio-reverse',
    panel: 'audio',
    group: 'ton',
    label: 'Rückwärts abspielen',
    hint: 'Die Aufnahme umkehren',
    kinds: ['audio'],
    keywords: ['reverse', 'rückwärts', 'umkehren', 'backwards'],
  },
  {
    id: 'audio-join',
    panel: 'audio',
    group: 'ton',
    label: 'Aufnahmen aneinanderhängen',
    hint: 'Mit kurzer Überblendung verbinden',
    kinds: ['audio'],
    keywords: ['join', 'merge', 'concat', 'aneinander', 'verbinden', 'zusammenfügen', 'anhängen'],
  },
  {
    id: 'audio-pitch',
    panel: 'audio',
    group: 'musik',
    label: 'Tonhöhe ändern',
    hint: 'Transponieren, Länge bleibt gleich',
    kinds: ['audio'],
    keywords: ['pitch', 'tonhöhe', 'transponieren', 'halbtöne', 'shift', 'höher', 'tiefer'],
  },
  {
    id: 'audio-tempo',
    panel: 'audio',
    group: 'musik',
    label: 'Tempo ändern',
    hint: 'Dehnen oder stauchen, Tonhöhe bleibt',
    kinds: ['audio'],
    keywords: ['tempo', 'stretch', 'dehnen', 'schneller', 'langsamer', 'time stretch', 'bpm ändern'],
  },
  {
    id: 'audio-shape',
    panel: 'audio',
    group: 'ton',
    label: 'Mono, Stereo, Abtastrate',
    hint: 'Kanäle und Abtastrate umstellen',
    kinds: ['audio'],
    keywords: ['mono', 'stereo', 'kanäle', 'channels', 'abtastrate', 'sample rate', '44100', '48000', 'bit'],
  },

  /* -- music ---------------------------------------------------------------- */
  {
    id: 'stems',
    panel: 'stems',
    group: 'musik',
    label: 'Spuren trennen',
    hint: 'Gesang, Schlagzeug und Bass einzeln',
    kinds: ['audio', 'video'],
    keywords: ['stems', 'spuren', 'gesang', 'vocals', 'karaoke', 'instrumental', 'schlagzeug', 'bass', 'trennen'],
  },
  {
    id: 'loudness',
    panel: 'normalize',
    group: 'musik',
    label: 'Lautstärke angleichen',
    hint: 'EBU R128, so laut wie im Radio',
    kinds: ['audio', 'video'],
    keywords: ['loudness', 'lautstärke', 'normalize', 'normalisieren', 'lufs', 'r128', 'laut', 'leise', 'mastering'],
  },
  {
    id: 'loudness-check',
    panel: 'normalize',
    group: 'musik',
    label: 'Master prüfen',
    hint: 'LUFS, True Peak, Dynamik messen',
    kinds: ['audio', 'video'],
    keywords: ['master check', 'messen', 'lufs', 'true peak', 'dynamik', 'clipping', 'qualität', 'analyse'],
  },
  {
    id: 'chop',
    panel: 'sampler',
    group: 'musik',
    label: 'In Schnipsel zerlegen',
    hint: 'An Anschlägen oder im Takt, auf Tasten legen',
    kinds: ['audio'],
    keywords: ['chop', 'slice', 'zerschneiden', 'sampler', 'pads', 'beat', 'break', 'schnipsel'],
  },
  {
    id: 'key',
    panel: 'harmony',
    group: 'musik',
    label: 'Tonart und Tempo bestimmen',
    hint: 'Tonart, Camelot, BPM, Akkorde, MIDI',
    kinds: ['audio'],
    keywords: ['key', 'tonart', 'bpm', 'tempo', 'camelot', 'akkorde', 'chords', 'midi', 'melodie', 'harmonie'],
  },
]

/** The actions that make sense for a file of this kind. */
export function actionsFor(kind: AssetKind): ToolAction[] {
  return ACTIONS.filter((action) => action.kinds.includes(kind))
}

/**
 * Free-text search over everything.
 *
 * Deliberately forgiving: it matches on the label, the hint and the keyword
 * list, so "mp3 aus video", "extract audio" and "tonspur" all find the same
 * thing. Ranked so a hit in the label beats a hit in a keyword.
 */
export function searchActions(query: string, kind?: AssetKind): ToolAction[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  const pool = kind ? ACTIONS.filter((a) => a.kinds.length === 0 || a.kinds.includes(kind)) : ACTIONS
  if (terms.length === 0) return pool

  const scored = pool
    .map((action) => {
      const label = action.label.toLowerCase()
      const hint = action.hint.toLowerCase()
      const keywords = action.keywords.join(' ')
      let score = 0
      for (const term of terms) {
        if (label.includes(term)) score += 6
        else if (keywords.includes(term)) score += 3
        else if (hint.includes(term)) score += 2
        else return null
      }
      return { action, score }
    })
    .filter((entry): entry is { action: ToolAction; score: number } => entry !== null)

  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.action)
}
