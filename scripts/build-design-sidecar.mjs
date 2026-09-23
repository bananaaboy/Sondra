/**
 * Writes `.impeccable/design.json` — the sidecar that carries what DESIGN.md's
 * frontmatter schema cannot hold: tonal ramps, the dark remap, shadow and
 * motion tokens, breakpoints, drop-in component snippets, and the narrative.
 *
 * Run it with `node scripts/build-design-sidecar.mjs` whenever DESIGN.md is
 * regenerated.
 *
 * Every colour, shadow, easing and duration below is **read out of
 * `src/styles/theme.css` at build time**, not typed in here. The previous
 * version of this file hard-coded the values of the world before the
 * calibration-certificate pass, and went stale the moment that world was
 * replaced — a generator that repeats its source is a second source. If a
 * token named here has disappeared from the stylesheet, this script throws
 * rather than writing a plausible-looking lie.
 *
 * The ramps are computed rather than invented. Each one holds the token's own
 * hue and chroma and walks only its lightness, in OKLab, because walking
 * lightness in sRGB turns a dark green into a grey-green on the way up — the
 * strip would then show a hue the project does not contain.
 */

import fs from 'node:fs'
import path from 'node:path'

const THEME = path.join('src', 'styles', 'theme.css')

/* -- reading the stylesheet ------------------------------------------------ */

const css = fs.readFileSync(THEME, 'utf8')

/** The body of a block, found by its opening line and matched brace-for-brace. */
function block(source, opener) {
  const start = source.indexOf(opener)
  if (start === -1) throw new Error(`${THEME}: kein Block „${opener}“ gefunden`)
  let depth = 0
  for (let i = start + opener.length - 1; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start + opener.length, i)
    }
  }
  throw new Error(`${THEME}: Block „${opener}“ wird nicht geschlossen`)
}

/** Every `--name: value;` in a block, comments stripped. */
function declarations(body) {
  const out = new Map()
  for (const [, name, value] of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(name, value.trim())
  }
  return out
}

/** A plain `name: value;` declaration in a block — not a custom property. */
function property(body, name) {
  const match = body.replace(/\/\*[\s\S]*?\*\//g, '').match(new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+);`))
  if (!match) throw new Error(`${THEME}: ${name} fehlt in einem gelesenen Block.`)
  return match[1].trim()
}

/* `@theme` carries the light theme; its values double as the defaults. The
   dark theme is declared twice in the stylesheet — once behind the media
   query, once behind the attribute — and the attribute block is the one the
   switch honours in both directions, so it is the one read here. */
const light = declarations(block(css, '@theme {'))
const dark = declarations(block(css, ":root[data-theme='dark'] {"))
const shell = block(css, '@utility shell {')

/**
 * Every width the sheet is allowed to reach, in order.
 *
 * The base `max-width` first, then one rung per `@media (min-width: …)` inside
 * the utility. Named by the width that switches them on, so the sidecar says
 * what the stylesheet says rather than a comfortable subset of it.
 */
function shellLadder() {
  const rungs = [{ name: 'shell-max', value: property(shell, 'max-width') }]
  for (const [, at, body] of shell.matchAll(/@media\s*\(min-width:\s*([^)]+)\)\s*\{([^}]*)\}/g)) {
    const width = body.match(/max-width\s*:\s*([^;]+);/)
    if (width) rungs.push({ name: `shell-max-from-${at.trim()}`, value: width[1].trim() })
  }
  return rungs
}

function token(map, name, where) {
  const value = map.get(name)
  if (!value) throw new Error(`${THEME}: --${name} fehlt (${where}). DESIGN.md und dieser Sidecar sind auseinandergelaufen.`)
  return value
}

const lightColor = (name) => token(light, `color-${name}`, 'helles Thema')
const darkColor = (name) => token(dark, `color-${name}`, 'dunkles Thema')

/* -- sRGB <-> OKLab -------------------------------------------------------- */

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

function hexToOklab(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => toLinear(parseInt(hex.slice(1 + i, 3 + i), 16) / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

function oklabToHex({ L, a, b }) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return (
    '#' +
    rgb
      .map((c) => Math.max(0, Math.min(255, Math.round(toGamma(c) * 255))).toString(16).padStart(2, '0'))
      .join('')
  )
}

/** Eight steps, dark to light, hue and chroma held. */
function ramp(hex) {
  const { a, b } = hexToOklab(hex)
  return Array.from({ length: 8 }, (_, i) => oklabToHex({ L: 0.15 + (i * (0.95 - 0.15)) / 7, a, b }))
}

/* -- the human layer -------------------------------------------------------
   Roles, names and purposes cannot be read out of a stylesheet. The hexes
   beside them can, and are: this table names tokens, it does not restate
   their values.
   ------------------------------------------------------------------------- */

const colors = [
  ['ink', 'primary', 'Waldtinte', 'Die einzige gesättigte Farbe und die einzige Druckfarbe: Linien, Überschriften, Kachelsymbole, Fokusring und die eine gefüllte Aktion je Abschnitt.'],
  ['ink-hover', 'primary', 'Waldtinte gedrückt', 'Nur der Hover-Zustand gefüllter Flächen. Nie im Ruhezustand.'],
  ['on-ink', 'primary', 'Papier auf Tinte', 'Text auf gefüllter Tinte.'],
  ['canvas', 'neutral', 'Warmes Papier', 'Das Blatt selbst, Grund der ganzen App.'],
  ['raised', 'neutral', 'Feld', 'Weiss erscheint nur, wo ein Feld ausfüllbar ist oder eine Fläche eigene Mechanik hat — nicht als Karte.'],
  ['panel-soft', 'neutral', 'Blasse Minze', 'Eingesetzte Blöcke und der Hover-Grund von Listenzeilen.'],
  ['panel-mid', 'neutral', 'Minze', 'Die zweite Tönungsstufe eingesetzter Blöcke.'],
  ['panel-strong', 'neutral', 'Kräftige Minze', 'Die Textmarkierung (::selection).'],
  ['panel-cool', 'neutral', 'Kühle Minze', 'Reserviert für den einen Hinweis, dass etwas nicht lokal läuft.'],
  ['prose', 'neutral', 'Prosa', 'Fliesstext und Beschriftungen.'],
  ['muted', 'neutral', 'Gedämpft', 'Sekundärtext, Hinweise, Einheiten.'],
  ['faint', 'neutral', 'Nicht zutreffend', 'Ein Werkzeug, das auf die geöffnete Datei nicht passt. Blasser als gedämpft, aber ausdrücklich noch lesbar.'],
  ['line', 'neutral', 'Haarlinie', 'Die Linie einer Tabelle: jede Trennung zwischen Zeilen, Feldern und Blöcken. Gemessen auf APCA Lc 15.'],
  ['rule', 'neutral', 'Abschnittslinie', 'Die schwerere Linie, die einen Abschnitt eröffnet. Eigenes Token statt Deckkraft auf Tinte, weil eine Deckkraft über dunklem Grund ihren Kontrast verliert.'],
  ['stage', 'tertiary', 'Bühne', 'Die Fläche, auf der ein Bild oder Video bearbeitet wird. In beiden Themen dunkel und neutral, damit sie über Farben nicht lügt.'],
  ['stage-soft', 'tertiary', 'Bühne gehoben', 'Das Schachbrett der Transparenz und die Knöpfe auf der Bühne.'],
  ['stage-line', 'tertiary', 'Bühnenlinie', 'Trennung und Ring auf der Bühne.'],
  ['stage-ink', 'tertiary', 'Bühnenschrift', 'Text auf der Bühne.'],
  ['stage-muted', 'tertiary', 'Bühne gedämpft', 'Sekundärtext auf der Bühne.'],
]

/* -- component snippets ----------------------------------------------------
   Literal values rather than `var(--color-…)`: the panel renders these in a
   shadow DOM on a different page, where this project's custom properties do
   not exist. Light theme, because that is the frontmatter's normative side.
   ------------------------------------------------------------------------- */

/* The two families are read out of the stylesheet like everything else, then
   stripped of the spaces after their commas so they survive inside a `font:`
   shorthand. Typing them here would put the type system in two places. */
const stack = (name) => token(light, `font-${name}`, 'Schriften').replace(/,\s+/g, ',')
const FORM = stack('sans')
const VALUE = stack('value')
const EASE = token(light, 'ease-out', 'Bewegung')
const FAST = token(light, 'dur-fast', 'Bewegung')
const INK = lightColor('ink')
const INK_HOVER = lightColor('ink-hover')
const ON_INK = lightColor('on-ink')
const CANVAS = lightColor('canvas')
const RAISED = lightColor('raised')
const SOFT = lightColor('panel-soft')
const MID = lightColor('panel-mid')
const STRONG = lightColor('panel-strong')
const PROSE = lightColor('prose')
const MUTED = lightColor('muted')
const LINE = lightColor('line')
const RULE = lightColor('rule')

const focus = (selector) => `${selector}:focus-visible{outline:2px solid ${INK};outline-offset:2px}`

const components = [
  {
    name: 'Primary Button',
    kind: 'button',
    refersTo: 'button-primary',
    description: 'Die eine Aktion, um die ein Abschnitt bittet. Eckig, ungeschattet, gefüllte Tinte.',
    html: '<button class="ds-btn-primary">Datei öffnen</button>',
    css:
      `.ds-btn-primary{display:inline-flex;align-items:center;gap:8px;background:${INK};color:${ON_INK};font:500 16px/1.55 ${FORM};padding:12px 16px;border:none;border-radius:0;cursor:pointer;transition:background ${FAST} ${EASE},transform ${FAST} ${EASE}}` +
      `.ds-btn-primary:hover{background:${INK_HOVER}}` +
      `.ds-btn-primary:active{transform:translateY(1px)}` +
      focus('.ds-btn-primary') +
      `.ds-btn-primary:disabled{opacity:.4;cursor:not-allowed;transform:none}`,
  },
  {
    name: 'Quiet Button',
    kind: 'button',
    refersTo: 'button-quiet',
    description: 'Die zweite Wahl, die sichtbar die zweite ist: Feldweiss mit Klausellinien-Ring.',
    html: '<button class="ds-btn-quiet">In die Sitzung übernehmen</button>',
    css:
      `.ds-btn-quiet{display:inline-flex;align-items:center;gap:8px;background:${RAISED};color:${INK};font:500 16px/1.55 ${FORM};padding:12px 16px;border:none;border-radius:0;box-shadow:inset 0 0 0 1px ${RULE};cursor:pointer;transition:background ${FAST} ${EASE},transform ${FAST} ${EASE}}` +
      `.ds-btn-quiet:hover{background:${SOFT}}` +
      `.ds-btn-quiet:active{transform:translateY(1px)}` +
      focus('.ds-btn-quiet'),
  },
  {
    name: 'Text Input',
    kind: 'input',
    refersTo: 'input',
    description: 'Was eingetippt wird, steht in der Schrift der eingetragenen Dinge. Ring statt Rahmen, Fokus wechselt ihn auf Tinte.',
    html: '<input class="ds-input" type="text" value="https://www.youtube.com/watch?v=…" aria-label="Adresse" />',
    css:
      `.ds-input{width:100%;box-sizing:border-box;background:${RAISED};color:${PROSE};font:400 13px/1.5 ${VALUE};font-variant-numeric:tabular-nums;letter-spacing:-.02em;padding:8px 12px;border:none;border-radius:0;box-shadow:inset 0 0 0 1px ${LINE};outline:none}` +
      `.ds-input::placeholder{font-family:${FORM};color:${MUTED}}` +
      `.ds-input:focus{box-shadow:inset 0 0 0 1px ${INK}}`,
  },
  {
    name: 'Choice Chip',
    kind: 'chip',
    refersTo: 'chip',
    description: 'Eins aus vier — Seitenverhältnis, Drehung, Format. Ausgewählt ist gefüllte Tinte ohne Ring.',
    html: '<div style="display:flex;gap:4px"><button class="ds-chip" aria-pressed="false">Frei</button><button class="ds-chip ds-chip-on" aria-pressed="true">16:9</button><button class="ds-chip" aria-pressed="false">4:3</button></div>',
    css:
      `.ds-chip{background:${SOFT};color:${PROSE};font:400 13px/1 ${FORM};padding:8px;border:none;border-radius:0;box-shadow:inset 0 0 0 1px ${LINE};cursor:pointer;transition:background ${FAST} ${EASE},transform ${FAST} ${EASE}}` +
      `.ds-chip:hover{background:${MID}}` +
      `.ds-chip:active{transform:translateY(1px)}` +
      `.ds-chip-on{background:${INK};color:${ON_INK};box-shadow:none}` +
      focus('.ds-chip'),
  },
  {
    name: 'Panel Tabs',
    kind: 'nav',
    refersTo: 'tab',
    description: 'Die Werkzeugleiste. Ausgewählt ist gefüllte Tinte. Die Reiter trugen einmal Nummern; sie sind mit allen anderen Zierziffern gefallen.',
    html: '<div class="ds-tabs" role="tablist"><button class="ds-tab ds-tab-on" role="tab" aria-selected="true">Start</button><button class="ds-tab" role="tab" aria-selected="false">Herunterladen</button><button class="ds-tab" role="tab" aria-selected="false">Umwandeln</button></div>',
    css:
      `.ds-tabs{display:flex;gap:4px;background:${RAISED};padding:4px;box-shadow:inset 0 0 0 1px ${LINE}}` +
      `.ds-tab{display:flex;align-items:center;gap:8px;background:transparent;color:${PROSE};font:400 13px/1.5 ${FORM};padding:8px 12px;border:none;border-radius:0;cursor:pointer;transition:background ${FAST} ${EASE}}` +
      `.ds-tab:hover{background:${SOFT}}` +
      `.ds-tab-on{background:${INK};color:${ON_INK}}` +
      focus('.ds-tab'),
  },
  {
    name: 'Toggle',
    kind: 'custom',
    refersTo: 'toggle-track',
    description: 'Eckiger Körper, runder Knauf: der Schalter ist der eine physische Gegenstand auf einem Blatt Papier und darf deshalb als einziges eine Rundung haben.',
    html: '<button class="ds-toggle" role="switch" aria-checked="true"><span class="ds-toggle-track"><span class="ds-toggle-knob"></span></span><span class="ds-toggle-text"><span class="ds-toggle-label">Mehrkern verwenden</span><span class="ds-toggle-hint">Braucht Cross-Origin-Isolation.</span></span></button>',
    css:
      `.ds-toggle{display:flex;align-items:flex-start;gap:12px;background:none;border:none;padding:0;text-align:left;cursor:pointer;font-family:${FORM}}` +
      `.ds-toggle-track{display:flex;align-items:center;flex-shrink:0;margin-top:2px;width:28px;height:16px;padding:2px;box-sizing:border-box;background:${INK};border-radius:0}` +
      `.ds-toggle-knob{width:12px;height:12px;border-radius:999px;background:${ON_INK};transform:translateX(12px);transition:transform 240ms cubic-bezier(.16,1,.3,1)}` +
      `.ds-toggle[aria-checked="false"] .ds-toggle-track{background:transparent;box-shadow:inset 0 0 0 1px ${RULE}}` +
      `.ds-toggle[aria-checked="false"] .ds-toggle-knob{transform:translateX(0);background:${INK};opacity:.55}` +
      `.ds-toggle-text{display:flex;flex-direction:column;gap:2px}` +
      `.ds-toggle-label{font:400 13px/1.5 ${FORM};color:${PROSE}}` +
      `.ds-toggle-hint{font:400 13px/1.45 ${FORM};color:${MUTED}}` +
      focus('.ds-toggle'),
  },
  {
    name: 'Stat Row',
    kind: 'custom',
    refersTo: 'stat-row',
    description: 'Eine Messzeile: was gemessen wurde links, was herauskam rechts in der Wertschrift, die Einheit in eigener Spalte. Haarlinie oben statt Kasten ringsum.',
    html: '<div class="ds-stats"><div class="ds-stat"><span class="ds-stat-label">Integrierte Lautheit</span><span class="ds-stat-figure"><span class="ds-stat-value">-14.2</span><span class="ds-stat-unit">LUFS</span></span></div><div class="ds-stat"><span class="ds-stat-label">True Peak</span><span class="ds-stat-figure"><span class="ds-stat-value">-1.0</span><span class="ds-stat-unit">dBTP</span></span></div><div class="ds-stat"><span class="ds-stat-label">Dynamikumfang</span><span class="ds-stat-figure"><span class="ds-stat-value">7.4</span><span class="ds-stat-unit">LU</span></span></div></div>',
    css:
      `.ds-stats{font-family:${FORM};background:${CANVAS};max-width:420px}` +
      `.ds-stat{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid ${LINE}}` +
      `.ds-stat-label{font:400 13px/1.5 ${FORM};color:${PROSE}}` +
      `.ds-stat-figure{display:flex;align-items:baseline;gap:4px;flex-shrink:0}` +
      `.ds-stat-value{font:400 13px/1.5 ${VALUE};font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:${INK}}` +
      `.ds-stat-unit{width:4ch;text-align:left;font:400 13px/1.5 ${FORM};color:${MUTED}}`,
  },
  {
    name: 'Section Head',
    kind: 'custom',
    refersTo: 'entry-row',
    description: 'Der Kopf eines Abschnitts: Linie darüber, Überschrift, darunter die Messzeilen. Kein Kasten, keine Nummer — Abschnittsnummern sind gefallen.',
    html: '<div class="ds-sec"><h2 class="ds-sec-head">Ergebnis</h2><div class="ds-sec-row"><span class="ds-sec-key">Datei</span><span class="ds-sec-val">out_audio.wav</span></div><div class="ds-sec-row"><span class="ds-sec-key">Dauer</span><span class="ds-sec-val">03:42.118</span></div></div>',
    css:
      `.ds-sec{font-family:${FORM};background:${CANVAS};max-width:420px}` +
      `.ds-sec-head{margin:0;padding-top:12px;border-top:2px solid ${RULE};font:700 25px/1.25 ${FORM};letter-spacing:-.015em;color:${INK}}` +
      `.ds-sec-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:6px 0;border-top:1px solid ${LINE};margin-top:12px}` +
      `.ds-sec-row+.ds-sec-row{margin-top:0}` +
      `.ds-sec-key{font:400 13px/1.5 ${FORM};color:${MUTED}}` +
      `.ds-sec-val{font:400 13px/1.5 ${VALUE};font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:${INK};text-align:right}`,
  },
  {
    name: 'Tool Tile',
    kind: 'custom',
    refersTo: 'procedure-row',
    description: 'Eine Werkzeugkachel: getöntes Feld, Symbol oben, Beschriftung, Hinweis. Die Tönung gibt die Kante — kein Rahmen, kein Schatten, keine Rundung. Ersetzt den nummerierten Index, der hier zuvor stand.',
    html: '<div class="ds-tiles"><button class="ds-tile"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.2h12v9.6H2zM2 10l3.4-3.2 3 2.8 2.2-2 3.4 3.2M5.6 6.2a.9.9 0 100-1.8.9.9 0 000 1.8z"/></svg><span class="ds-tile-label">Bild zuschneiden</span><span class="ds-tile-hint">Ausschnitt aufziehen</span></button><button class="ds-tile"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 5.4h9.2m0 0L9.4 3.1m2.4 2.3L9.4 7.7M13.4 10.6H4.2m0 0l2.4-2.3m-2.4 2.3l2.4 2.3"/></svg><span class="ds-tile-label">Bildformat ändern</span><span class="ds-tile-hint">PNG, JPEG oder WebP</span></button></div>',
    css:
      `.ds-tiles{display:grid;grid-template-columns:1fr 1fr;gap:8px;background:${CANVAS};max-width:460px}` +
      `.ds-tile{display:flex;flex-direction:column;align-items:flex-start;gap:6px;background:${MID};border:none;border-radius:0;padding:16px;text-align:left;cursor:pointer;transition:background ${FAST} ${EASE}}` +
      `.ds-tile:hover{background:${STRONG}}` +
      `.ds-tile svg{color:${INK};flex-shrink:0}` +
      `.ds-tile-label{font:600 13px/1.3 ${FORM};color:${INK}}` +
      /* `prose`, not `muted`: on the tile's own tint `muted` measured APCA
         Lc 59.3 in the dark theme against a Lc 60 floor. */
      `.ds-tile-hint{font:400 13px/1.4 ${FORM};color:${PROSE}}` +
      `.ds-tile:focus-visible{outline:2px solid ${INK};outline-offset:-2px}`,
  },
]

/* -- the record ------------------------------------------------------------ */

const design = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  title: 'Design System: Sondra',
  extensions: {
    colorMeta: Object.fromEntries(
      colors.map(([key, role, displayName, purpose]) => [
        key,
        {
          role,
          displayName,
          canonical: lightColor(key),
          dark: darkColor(key),
          purpose,
          tonalRamp: ramp(lightColor(key)),
        },
      ]),
    ),
    typographyMeta: {
      display: { displayName: 'Display', purpose: 'Die eine grosse Zeile einer Fläche. Steht in Tinte.' },
      headline: { displayName: 'Headline', purpose: 'Der Kopf einer Hauptklausel, neben seiner Klauselnummer.' },
      title: { displayName: 'Title', purpose: 'Dialogtitel und Zwischenüberschriften.' },
      body: { displayName: 'Body', purpose: 'Fliesstext und die grosse Schaltflächengrösse. 16px, weil Deutsch lange Wörter hat.' },
      small: { displayName: 'Small', purpose: 'Das dichte Werkzeug-Chrome: Anzeigen, Hinweise, Chips, Reiter, Formularzeilen.' },
      label: { displayName: 'Label', purpose: 'Die kleinste Stufe: Kopfzeilen-Angaben, Beschriftungen der Werkzeugschiene, und als einzige Versalbehandlung der gestempelte Badge.' },
      value: { displayName: 'Value', purpose: 'Was die Maschine gefunden hat: Messwert, Dateiname, Zeitmarke. Rechtsbündig, Tabellenziffern, Einheit in eigener Spalte. Nie als Kostüm für „technisch“.' },
      wordmark: { displayName: 'Wordmark', purpose: 'Cormorant Garamond, geladen als eigene Familie „Sondra Wordmark“ für genau ein Wort. Sonst nirgends erlaubt.' },
    },
    shadows: [
      {
        name: 'lift',
        value: token(light, 'shadow-lift', 'Tiefe, helles Thema'),
        purpose: 'Die einzige Tiefenstufe, und im Ruhezustand nirgends auf dem Blatt. Getragen wird sie vom Lokalitäts-Popover, von der Ablage-Überlagerung und von der Rasterdatei auf der Bühne.',
      },
      {
        name: 'lift-dark',
        value: token(dark, 'shadow-lift', 'Tiefe, dunkles Thema'),
        purpose: 'Dieselbe Stufe im dunklen Thema — eine eigene, deutlich tiefere Umrechnung, keine Anpassung des hellen.',
      },
    ],
    motion: [
      { name: 'ease-out', value: token(light, 'ease-out', 'Bewegung'), purpose: 'Standard für jeden Zustandswechsel und für „rise“.' },
      { name: 'ease-settle', value: token(light, 'ease-settle', 'Bewegung'), purpose: 'Exponentielles Auslaufen für „pop“ und den Schalterknauf. Kein Feder-Effekt: echte Objekte bremsen ab, sie wackeln nicht in Position.' },
      { name: 'dur-fast', value: token(light, 'dur-fast', 'Bewegung'), purpose: 'Farbwechsel, Druck, alles, was sofort antworten muss.' },
      { name: 'dur-base', value: token(light, 'dur-base', 'Bewegung'), purpose: 'Eintritt neuer Inhalte („rise“, „pop“) und der Weg des Schalterknaufs.' },
      { name: 'dur-slow', value: token(light, 'dur-slow', 'Bewegung'), purpose: 'Die grosse Bewegung. Im gebauten Stand deklariert, aber von keiner Fläche verwendet.' },
    ],
    /* `sm` and `lg` are Tailwind's own defaults — the project does not
       redeclare them, so there is no token to read. The shell's own ladder
       is read, every rung of it: reading only the first `max-width` reported
       a cap of 1280px after the column had already been taught to grow to
       1840, which is exactly the kind of half-truth this generator exists to
       prevent. */
    breakpoints: [
      { name: 'sm', value: '640px' },
      { name: 'lg', value: '1024px' },
      ...shellLadder(),
    ],
  },
  components,
  narrative: {
    northStar: 'Das ruhige Blatt',
    overview:
      'Sondra misst, und die Oberfläche soll dem nicht widersprechen: ruhig, flach, ohne Effekt, der etwas behauptet, was nicht gemessen wurde. Jede Zahl in dieser App wurde gemessen statt geschätzt, und sie wurde auf dem Gerät der Besucherin gemessen.\n\nWie weit diese Haltung tragen darf, ist am 20.9.2026 an einem Fehlschlag geklärt worden. Der erste Wurf hiess „Der Eichschein“ und nahm das Bild wörtlich: die Abschnitte hiessen „Prüfgegenstand“ und „Verfügbare Verfahren“, jede Überschrift trug eine Klauselnummer, und die Startseite empfing mit einem leeren Formular aus drei Feldern. Es war konsequent und es war unbenutzbar — beim ersten Blick des Nutzers verworfen. Das Messen gehört in die Art, wie Zahlen berichtet werden, nicht in die Wörter auf der Tür.\n\nGeblieben ist die Form, gegangen ist die Amtssprache. Es gibt keine Karten, keine runden Ecken und keinen Schatten auf dem Blatt — die eine Tiefenstufe ist für die Dinge reserviert, die wirklich darüber schweben. Getrennt wird durch eine gezogene Linie und durch Raum. Die dreissig Werkzeuge stehen als getöntes Kachelfeld: die Tönung gibt der Kachel ihre Kante, ohne einen Rahmen auf vier Seiten zu ziehen.\n\nZwei Schriften teilen sich die Arbeit nach Bedeutung, nicht nach Geschmack. Public Sans setzt die Oberfläche. Courier Prime ist das, was die Maschine eingetragen hat: Messwerte, Dateinamen, Zeitmarken. Die Serife der vorigen Welt ist aus dem System verschwunden und überlebt allein in der Wortmarke, als eigene Familie „Sondra Wordmark“ — eine gegebene Zusage ist etwas anderes als eine Gewohnheit.',
    keyCharacteristics: [
      'Jede Zahl trägt, wie sie gemessen wurde — in der Zahl, nicht in der Überschrift',
      'Keine Karten, keine runden Ecken, kein Schatten auf dem Blatt',
      'Zwei Linienstärken statt Rahmen: die Haarlinie und die schwerere Abschnittslinie',
      'Zwei Schriften, getrennt nach Bedeutung: Oberfläche und eingetragener Wert',
      'Werkzeuge stehen als getöntes Kachelfeld, gruppiert und filterbar',
      'Der Einstieg zeigt die nächste Handlung, nicht den Zustand der leeren Sitzung',
      'Klartext statt Amtston: eine Überschrift heisst, was sie ist',
      'Ein einziger gesättigter Farbwert, gemessene Kontraste in beiden Themen',
    ],
    rules: [
      {
        name: 'Die Tinte-wird-ausgegeben-Regel',
        body: 'Tinte liegt auf Linien, Klauselnummern und der einen Aktion, um die ein Abschnitt bittet. Überall sonst ist die Seite Papier und Graphit. Deckt sie mehr als etwa ein Zehntel eines Bildschirms, ist sie keine Tinte mehr, sondern Farbe.',
        section: 'colors',
      },
      {
        name: 'Die Messregel',
        body: 'Kontrast wird gerechnet, nicht geschätzt, und in beiden Themen. APCA: Fliesstext ≥ Lc 75, Sekundärtext ≥ Lc 60, Überschriften ≥ Lc 45, Nicht-Text ≥ Lc 15. Eine Palettenänderung ist erst fertig, wenn sie durch die Zahlen gelaufen ist — dieser Durchgang fand eine Trennlinie bei Lc 0.0 und eine gefüllte Schaltfläche bei Lc 70.',
        section: 'colors',
      },
      {
        name: 'Die Umrechnungsregel',
        body: 'Dunkel ist eine eigene Abbildung mit eigenem Kontrastdurchgang, nie eine Invertierung. Tinte und ihr Grund tauschen dort die Rollen: der einzige gesättigte Wert muss der helle sein, sonst verschwinden Überschriften und gefüllte Schaltflächen.',
        section: 'colors',
      },
      {
        name: 'Die Ehrliche-Bühne-Regel',
        body: 'Die Bühne der Editoren bleibt neutral dunkel und nimmt an keinem Themenwechsel teil. Sie ist kein Gestaltungsspielraum.',
        section: 'colors',
      },
      {
        name: 'Die Zwei-Schriften-Regel',
        body: 'Courier Prime steht für etwas, das tatsächlich gefunden wurde: ein Messwert, ein Dateiname, eine Zeitmarke, eine Klauselnummer. Nie als Kostüm für „technisch“. Was das Formular fragt, steht in Public Sans.',
        section: 'typography',
      },
      {
        name: 'Die Sechs-Stufen-Regel',
        body: 'Eine grosse Terz ab 16px, genau sechs Stufen, nichts dazwischen. Die Vorgängerwelt erklärte fünf Stufen und schrieb daneben 220 Grössen von Hand, darunter 9, 10, 10.5, 11, 12, 13, 13.5 und 14px für dieselbe Aufgabe. Zwei Grössen einen Pixel auseinander sind keine Hierarchie, sondern eine nicht getroffene Entscheidung.',
        section: 'typography',
      },
      {
        name: 'Die Kein-Anzeigeschnitt-Regel',
        body: 'Überschriften sind dieselbe Grotesk, nur grösser und schwerer. Ein nüchternes Werkzeug hat keine Anzeigeschrift, und die, die diese App hatte, ist die Schrift, nach der jede Allerwelts-Vorlage greift.',
        section: 'typography',
      },
      {
        name: 'Die Ein-Wort-Regel',
        body: 'Cormorant Garamond lädt als eigene Familie „Sondra Wordmark“ und setzt genau ein Wort. Sie ist nirgendwo sonst erlaubt — auch nicht dort, wo eine Überschrift sie „auch“ verwenden könnte.',
        section: 'typography',
      },
      {
        name: 'Die Klartext-Regel',
        body: 'Eine Überschrift heisst, was der Abschnitt ist, in der Sprache der Leserin: „Werkzeuge“, nicht „Verfügbare Verfahren“. Sie-Form und nüchterner Ton bleiben — Behördendeutsch war nie dasselbe wie Sachlichkeit. Die Regel steht hier, weil der erste Wurf genau daran gescheitert ist.',
        section: 'layout',
      },
      {
        name: 'Die Keine-Zierziffer-Regel',
        body: 'Abschnitte tragen keine Nummern. Der Vorgänger nummerierte 1.1 bis 1.3.4 durch und verteidigte das damit, dass jede Nummer ein Anker sei; als Bild war es Rauschen auf jeder Zeile. Tiefe Verweise bleiben möglich: jede Kachel behält ihre id, nur steht sie nicht mehr gedruckt daneben.',
        section: 'layout',
      },
      {
        name: 'Die 34em-Regel',
        body: 'Die Textspalte wird nicht breiter, weil das Fenster es wurde. Die Einheit ist „em“ und nicht „ch“: ein „ch“ ist die Breite der Null und damit breiter als der Durchschnittsbuchstabe, weshalb eine Deckelung bei 68ch in Wahrheit bei 90 Zeichen landete.',
        section: 'layout',
      },
      {
        name: 'Die Nichts-liegt-auf-dem-Blatt-Regel',
        body: 'Bevor etwas einen Schatten bekommt, muss beantwortet sein, worüber es schwebt. Lässt sich das nicht beantworten, schwebt es nicht: dann trennen Linie und Raum.',
        section: 'elevation',
      },
      {
        name: 'Die Getönt-statt-gehoben-Regel',
        body: 'Ein Block, der in einem Abschnitt sitzt, bekommt eine Tönung, damit das Auge ihn als eingesetzt liest — nicht einen Schatten, der ihn als weiteres gestapeltes Objekt behauptet.',
        section: 'elevation',
      },
      {
        name: 'Die Eine-Linie-Regel',
        body: 'Ein Rahmen auf allen vier Seiten behauptet, das hier sei ein Objekt auf einer Fläche. In dieser Welt stimmt das für fast nichts. Die Reihenfolge, in der gegriffen wird: erst Raum, dann Tönung, dann eine Linie, und erst ganz zuletzt ein Umriss — und der nur für eine Fläche mit eigener Mechanik.',
        section: 'shapes',
      },
      {
        name: 'Die Zwei-Stärken-Regel',
        body: 'Es gibt genau zwei Linien: die Haarlinie der Tabelle und die schwerere Linie, die einen Abschnitt eröffnet. Beide sind eigene Farbtokens und keine Deckkraft auf Tinte — dieselbe Tinte bei 25 % mass sich auf Papier bei APCA Lc 25 und im dunklen Thema bei Lc 7.',
        section: 'shapes',
      },
    ],
    dos: [
      'Do die Tinte für genau eine Bedeutung ausgeben: hier können Sie etwas tun. Höchstens ein Zehntel eines Bildschirms.',
      'Do mit Raum trennen, dann mit einer Tönung, dann mit einer Linie auf einer Seite — und einen Umriss nur für eine Fläche mit eigener Mechanik.',
      'Do jede Grösse aus den sechs Typo-Tokens nehmen und jeden Abstand aus dem 4-px-Raster.',
      'Do Courier Prime nur dort setzen, wo die Maschine etwas eingetragen hat: Messwert, Dateiname, Zeitmarke.',
      'Do eine Überschrift so benennen, wie die Leserin die Sache nennt, und prüfen, ob das Wort ausserhalb dieses Projekts jemand sagt.',
      'Do Zustand als Zeichen in die Randspalte setzen und den Klartext über aria-label und title mitliefern.',
      'Do Kontraste in beiden Themen rechnen, bevor eine Palettenänderung als fertig gilt.',
      'Do jeden Zustand entwerfen: Fehler, leer, lädt, Fokus, deaktiviert.',
    ],
    donts: [
      'Don\'t eine Karte bauen. Kein weisser Kasten mit Rahmen ringsum und Schatten darunter — Weiss markiert ein Feld oder eine Fläche mit eigener Mechanik, nicht ein Objekt auf dem Papier.',
      'Don\'t eine Ecke runden. „card“ und „nav“ stehen auf 0, und das ist keine Übergangslösung; „pill“ gehört dem Schalterknauf.',
      'Don\'t einem Element auf dem Blatt einen Schatten geben. „elevate-lift“ gehört dem, was wirklich darüber schwebt.',
      'Don\'t einen Abschnitt nummerieren. 1.1, 1.2.1 und ihresgleichen sind gefallen; sie machten eine Werkzeugliste zu einem Rechtstext.',
      'Don\'t Courier Prime als Kostüm für „technisch“ verwenden — nicht für Überschriften, Beschriftungen oder Fliesstext.',
      'Don\'t Cormorant Garamond ausserhalb der Wortmarke einsetzen, und keinen Anzeigeschnitt einführen, den ein Prüfschein nicht hätte.',
      'Don\'t Inter, Roboto, system-ui oder eine „sichere Alternative“ (Geist, Space Grotesk, Poppins) als Fliesstextschrift einsetzen.',
      'Don\'t eine Pixelgrösse von Hand schreiben, wo ein Typo-Token existiert, oder einen Abstand ausserhalb des Rasters.',
      'Don\'t den dunklen Modus aus dem hellen invertieren, und die Bühne überhaupt nicht umfärben.',
      'Don\'t ein Symbol in ein abgerundetes Quadrat über eine Überschrift stapeln, eine versale Beschriftung setzen, die den Reiter darüber wiederholt, oder einen pulsierenden Punkt auf eine Angabe legen, die sich nie ändert.',
      'Don\'t Amtsdeutsch als Sachlichkeit ausgeben. „Prüfgegenstand“, „Verfügbare Verfahren“, „Prüfmittel“ — alle drei standen hier einmal und sind gefallen. Wenn ein Wort nach Formular klingt, ist es das falsche.',
      'Don\'t die Startseite mit dem Zustand der leeren Sitzung eröffnen. Sie stand einmal als Tabelle aus drei leeren Feldern da; das Erste auf dem Schirm ist die nächste Handlung.',
    ],
  },
}

const out = path.join('.impeccable', 'design.json')
fs.mkdirSync('.impeccable', { recursive: true })
fs.writeFileSync(out, JSON.stringify(design, null, 2) + '\n', 'utf8')
console.log(
  `${out} geschrieben — ${design.components.length} Komponenten, ` +
    `${Object.keys(design.extensions.colorMeta).length} Farben mit Tonleiter und dunkler Entsprechung, ` +
    `gelesen aus ${THEME}`,
)
