---
name: Sondra nativ
description: Die Vorführkabine — der Raum ist dunkel, nur die Platte, auf der gearbeitet wird, ist beleuchtet, und Minze ist das Licht des Projektors.
colors:
  room: "#050806"
  canvas: "#111a14"
  plate-edge: "#223328"
  raised: "#152019"
  panel-soft: "#18251d"
  panel-mid: "#1e2f25"
  panel-strong: "#273b2f"
  panel-cool: "#13242b"
  ink: "#a6ecb9"
  ink-hover: "#c3f4d0"
  on-ink: "#04100a"
  ink-wash: "#1c3726"
  prose: "#e6eee8"
  muted: "#abc0af"
  line: "#253629"
  rule: "#4d6656"
  faint: "#7f9686"
  stage: "#0b0e0f"
  stage-soft: "#151a1b"
  stage-line: "#515a5d"
  stage-ink: "#eef1f0"
  stage-muted: "#aab5b2"
  stage-accent: "#8fe0a6"
typography:
  display:
    fontFamily: "Barlow, 'Segoe UI', sans-serif"
    fontSize: "36px"
    fontWeight: 600
    lineHeight: 1.1
  headline:
    fontFamily: "Barlow, 'Segoe UI', sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.15
  title:
    fontFamily: "Barlow, 'Segoe UI', sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Barlow, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  small:
    fontFamily: "Barlow, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 400
  label:
    fontFamily: "Barlow, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 700
  value:
    fontFamily: "'Courier Prime', ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    fontFeature: "tabular-nums"
  wordmark:
    fontFamily: "'Cormorant Garamond', Georgia, serif"
    fontSize: "26px"
    fontWeight: 300
rounded:
  dialog: "16px"
  plate: "14px"
  card: "12px"
  nav: "8px"
  pill: "999px"
spacing:
  "0.5": "2px"
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.nav}"
    padding: "0 14px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
    textColor: "{colors.on-ink}"
  button-quiet:
    backgroundColor: "{colors.panel-soft}"
    textColor: "{colors.prose}"
    typography: "{typography.body}"
    rounded: "{rounded.nav}"
    padding: "0 14px"
    height: "32px"
  button-quiet-hover:
    backgroundColor: "{colors.panel-mid}"
    textColor: "{colors.prose}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.nav}"
    padding: "0 6px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.ink-wash}"
    textColor: "{colors.ink}"
  button-sm:
    typography: "{typography.small}"
    padding: "0 10px"
    height: "28px"
  chip:
    backgroundColor: "{colors.panel-soft}"
    textColor: "{colors.prose}"
    typography: "{typography.small}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "28px"
  chip-selected:
    backgroundColor: "{colors.ink-wash}"
    textColor: "{colors.ink}"
  tile:
    backgroundColor: "{colors.panel-soft}"
    textColor: "{colors.prose}"
    typography: "{typography.body}"
    rounded: "{rounded.card}"
    padding: "12px 14px"
  tile-hover:
    backgroundColor: "{colors.panel-mid}"
  rack:
    backgroundColor: "{colors.room}"
    width: "224px"
  rack-compact:
    backgroundColor: "{colors.room}"
    width: "60px"
  rack-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.body}"
    rounded: "{rounded.nav}"
    padding: "0 10px"
    height: "30px"
  rack-item-hover:
    backgroundColor: "{colors.panel-soft}"
    textColor: "{colors.prose}"
  rack-item-selected:
    backgroundColor: "{colors.ink-wash}"
    textColor: "{colors.prose}"
  plate:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.prose}"
    typography: "{typography.body}"
    rounded: "{rounded.plate}"
  input:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.prose}"
    typography: "{typography.small}"
    rounded: "{rounded.nav}"
    padding: "6px 10px"
  menu:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.prose}"
    rounded: "{rounded.card}"
    width: "240px"
  dialog:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.prose}"
    rounded: "{rounded.dialog}"
  settings-column:
    backgroundColor: "{colors.panel-soft}"
    rounded: "{rounded.card}"
    padding: "16px"
    width: "320px"
  notice-not-local:
    backgroundColor: "{colors.panel-cool}"
    textColor: "{colors.prose}"
    typography: "{typography.small}"
    rounded: "{rounded.card}"
    padding: "12px 14px"
  count-badge:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    height: "18px"
  progress-bar:
    backgroundColor: "{colors.line}"
    rounded: "{rounded.pill}"
    height: "4px"
---

# Design System: Sondra nativ

Diese Datei beschreibt **nur das native Programm** (`native/sondra-app`, `native/sondra-ui`, Rust und GPUI). Die Website hat ihre eigene Welt in `/DESIGN.md` und `.impeccable/design.json`; beide gelten hier nicht, und diese hier gilt dort nicht. Massgeblich sind `sondra-ui/src/theme.rs` (Palette, Grössen, Rundungen, Schriften), `sondra-ui/src/ui.rs` (Bauteile), `sondra-ui/src/motion.rs` und `sondra-app/src/layout.rs`. Gebaut am 20.11.2026; der Richtungsvertrag steht in `.impeccable/surfaces/native-sondra-app-src-shell-rs.md`.

## Overview

**Creative North Star: "Die Vorführkabine"**

Sondra ist die Kabine hinter der Leinwand. Der Raum ist dunkel; beleuchtet ist nur, woran gerade gearbeitet wird — die Platte („Leinwand“), auf der die Seite liegt, 8 px vom Fensterrand eingerückt, eine Stufe heller als der Raum, mit einem Streiflicht nur an der Oberkante. Links im Raum steht das Rack: Wortmarke, die sechs Aufgaben, die drei Werkzeuggruppen als Listen unter ihrem Namen, unten Sitzung, Drive, „Was ist neu“ und das Thema. Minze ist das Licht des Projektors: sie markiert, was man tun kann und wo man ist, und nirgends schmückt sie.

Dunkel ist die Vorgabe (`Mode::Dark`, Wunsch des Nutzers vom 20.11.2026); hell ist dieselbe Kabine mit Saallicht an, einen Klick entfernt im Fuss des Racks. Die Dichte ist die eines Schreibtischprogramms: Bedienelemente 28 bis 32 px hoch, Text 13 bis 14 px, Seitentitel weit darüber — der Rang kommt aus dem Grössenabstand, nicht aus der Farbe. Werte, Dateinamen und Zeiten stehen in Courier Prime wie die getippte Beschriftung einer Filmrolle.

Ausdrücklich verworfen: die Website mit Kopfzeile und Reiterreihe als Kategorie-Vorgabe, der Neon-auf-Schwarz-Klon eines Streamingdienstes, und Kino als Kostüm — kein Filmstreifen, keine Perforation, keine Leuchtschrift. Was aus der Kabine kommt, kommt als Funktion: das Saallicht, das beim Abspielen dunkler wird, und die Überblendmarke vor „Nächste Folge“.

**Key Characteristics:**
- Drei Stufen Waldschwarz: Raum < Platte < Feld; die Platte ist das Beleuchtete.
- Minze als einzige gesättigte Farbe; gefüllt genau einmal je Bildschirm, für die Hauptaktion der Seite.
- Barlow für die Oberfläche, Courier Prime für Eingetragenes, Cormorant Garamond für das eine Wort „Sondra“.
- Rang durch Grösse: 36 / 26 / 17 / 14 / 13 / 11 px.
- Flach auf der Platte; Tiefe hat nur die Platte selbst und was über ihr schwebt.
- Bewegung sagt, woher etwas kommt; das Saallicht ist die eine Signatur.

## Colors

Waldschwarz in Stufen, ein Grünton als Licht, eine kühle Tönung für eine einzige Aussage und eine neutrale Bühne für die Editoren. Die Werte im Kopf dieser Datei sind das dunkle Thema (die Vorgabe); das helle steht in `theme.rs` als `LIGHT` und in der Sidecar-Datei je Farbe unter `light`.

### Primary
- **Projektorlicht** (`ink`): was man tun kann und wo man ist — gefüllt die Hauptaktion, als Wort ein Ghost-Knopf oder Link, als Linie der Fokusring und der Fortschrittsbalken, als Marke das Symbol des gewählten Platzes im Rack und die Wortmarke. Im hellen Thema Waldtinte.
- **Projektorlicht, nah** (`ink-hover`): nur der Hover gefüllter Minze. Nie im Ruhezustand.
- **Auf dem Licht** (`on-ink`): Text auf gefüllter Minze.
- **Verdünntes Licht** (`ink-wash`): Minze auf den Grund verdünnt — der gewählte Platz im Rack, ein gewählter Chip, das Feld unter dem Symbol einer Kachel, der Hover eines Ghost-Knopfs, der Einstieg, wenn eine Datei darübergezogen wird.

### Tertiary
- **Nicht lokal** (`panel-cool`): für genau eine Aussage — hier läuft etwas nicht auf diesem Gerät. Getragen vom `Notice` der Art `NotLocal`, mit einem Rand in Minze und halbfettem Satz.

### Neutral
- **Raum** (`room`): Grund des Fensters und des Racks; die dunkelste Stufe.
- **Platte** (`canvas`): die Leinwand, auf der jede Seite liegt, und der Grund der Dialoge.
- **Streiflicht** (`plate-edge`): die 1-px-Kante oben an der Platte und der Rand von Menü und Dialog.
- **Feld** (`raised`): Textfelder und Menüs, eine Stufe über der Platte.
- **Tönungen** (`panel-soft`, `panel-mid`, `panel-strong`): `panel-soft` ist der Grund von Kacheln, Einstieg, Einstellungsspalte, leisen Knöpfen und Chips; `panel-mid` ist deren Hover und der gewählte Reiter; `panel-strong` der Grund eines Tooltips.
- **Fliesstext** (`prose`), **zurückgenommen** (`muted`), **blass** (`faint`): Text in drei Rängen. `muted` setzt Hinweise, Zusammenfassungen und die nicht gewählten Plätze im Rack.
- **Haarlinie** (`line`): zwischen Zeilen, unter dem Seitenkopf, über dem Fuss des Racks, Rand leiser Knöpfe und Chips, Grund des Fortschrittsbalkens.
- **Kante** (`rule`): der Rand eines Feldes in Ruhe und der Hover-Rand leiser Bedienelemente.
- **Bühne** (`stage`, `stage-soft`, `stage-line`, `stage-ink`, `stage-muted`, `stage-accent`): die Fläche der Editoren und des Players, dunkel und neutral in beiden Themen; ein fensterfüllender Player steht auf `stage` statt auf dem Raum.

### Named Rules
**Die Projektor-Regel.** Minze markiert, was man tun kann und wo man ist — nie Schmuck. Gefüllt wird sie genau einmal je Bildschirm: die Hauptaktion der Seite („Datei auswählen“ im Einstieg, „Datei wählen“ auf einer Werkzeugseite). Gewähltes ist verdünntes Licht (`ink-wash`), nicht gefülltes.

**Die Eine-Aussage-Regel.** `panel-cool` sagt nur: hier läuft etwas nicht lokal. Keine zweite Verwendung, kein Rot in der Palette.

**Die Bühnen-Regel.** Die Bühne ist neutral und in beiden Themen dunkel; ihre einzige Farbe ist `stage-accent` — der gespielte Teil, ein eingeschalteter Schalter, die Überblendmarke.

**Die Mess-Regel.** Kontrast wird nach APCA gemessen (`sondra-ui/tests/contrast.rs`), in beiden Themen, auf dem Grund, auf dem das Ding wirklich steht: Fliesstext ≥ Lc 75, Sekundärtext ≥ 60, Überschriften ≥ 45, Nicht-Text ≥ 15. `muted` auf einer Tönung ist die Falle dieser Palette — auf `panel-mid` im Dunkeln misst er nur noch Lc 61,4; noch eine Stufe dunkler, und er fällt.

## Typography

**Display Font:** Barlow (mit Segoe UI), halbfett
**Body Font:** Barlow
**Label/Mono Font:** Courier Prime, nur für Werte
**Wortmarke:** Cormorant Garamond Light, ein Wort

**Character:** Barlow ist die Beschriftung an den Geräten der Kabine — kompakt, technisch ohne Kostüm. Courier Prime ist das getippte Etikett auf der Rolle. Alle drei Schriften sind eingebettet (`fonts.rs`, SIL OFL 1.1).

### Hierarchy
- **Display** (600, 36 px, 1,1): die Überschrift des Einstiegs auf der Startseite.
- **Headline** (600, 26 px, 1,15): der Titel einer Seite im Seitenkopf (`page_head`). Der Vertrag sagte 28 px; gebaut und behalten sind 26.
- **Title** (600, 17 px, 1,3): die Überschrift eines Abschnitts („Werkzeuge“, „Heute weiterschauen“).
- **Body** (400, 14 px, 1,5): Fliesstext, Knöpfe, Plätze im Rack; Gruppenüberschriften innerhalb eines Abschnitts in derselben Grösse halbfett. Fliesstext höchstens 640 px breit (`MEASURE`, rund 70 Zeichen).
- **Small** (400, 13 px; mittel 500 auf Chips und Reitern): Hinweise, Chips, Felder, kleine Knöpfe, Tooltips.
- **Label** (700, 11 px): nur die Zahl im Zähler am Rand eines Rack-Platzes.
- **Value** (Courier Prime 400, 13 px): Messwerte, Dateinamen, Zeiten, Zählungen neben Gruppennamen.

### Named Rules
**Die Grössenabstand-Regel.** Rang kommt aus der Grösse, nicht aus der Farbe: zwischen Body (14) und Headline (26) liegt fast das Doppelte. Überschriften stehen in `prose`, nicht in Minze.

**Die Rollenetikett-Regel.** Courier Prime nur für das, was die Maschine eingetragen hat. Ein Feld setzt in Barlow und schaltet Courier nur ausdrücklich ein (`value_face`), wenn sein Inhalt ein Wert ist. Nie Mono als Kostüm für „technisch“.

**Die Ein-Wort-Regel.** Cormorant Garamond setzt nur „Sondra“ (26 px im Rack, im schmalen Rack das „S“ in 28 px), in Minze. Keine zweite Verwendung.

## Layout

Zwei Teile nebeneinander: das **Rack** links auf dem Raum, 224 px breit (der Vertrag sagte 232; gebaut sind 224), und die **Platte** rechts, oben, unten und rechts 8 px vom Fensterrand. Unter 980 px Fensterbreite zeigt das Rack nur die Symbole (60 px); der Name bleibt als Tooltip und für den Screenreader, Gruppenüberschriften werden zu Haarlinien. Der Kopf des Racks ist 52 px hoch.

Auf der Platte steht eine Spalte, die mit dem Fenster in Stufen wächst (`shell_width`: 1280, ab 1600 px Fenster 1440, ab 1920 1680, ab 2400 1840), mit 32 px Seitenrand (`GUTTER`), 28 px oben, 48 px unten und 24 px zwischen den Blöcken. Ein Seitenkopf trägt Titel und Zusammenfassung (auf `MEASURE` gehalten) und schliesst mit einer Haarlinie und 20 px Luft.

Kacheln stehen in ganzen Zellen (`columns_for` nach innerer Breite: 2, ab 640 px 3, ab 920 4, ab 1200 5) mit 12 px Abstand; mehr Fläche zeigt mehr Kacheln, nicht breitere. Die Startseite: Einstieg, „Heute weiterschauen“, dann die Werkzeuge je Gruppe unter ihrem Namen mit Zählung, mit 40 px zwischen den Teilen.

Rhythmus: 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48 px.

### Named Rules
**Die Ganze-Zellen-Regel.** Ein Raster packt in ganzen Zellen um; eine Kachel wird nicht über rund 260 px gestreckt.

**Die Daneben-Regel.** Eine Werkzeugseite stellt ihre Einstellungen in eine Spalte von 320 px auf `panel-soft` links neben die Arbeitsfläche (`harmony_page.rs` ist das Muster); die Arbeitsfläche hält mindestens 320 px und trägt die Hauptaktion oben.

## Elevation & Depth

Hybrid, und sparsam. Auf der Platte ist alles flach; getrennt wird mit Tönung, Haarlinie und Luft. Tiefe haben zwei Dinge: die Platte selbst, die als beleuchtete Fläche über dem Raum liegt, und was über der Platte schwebt.

### Shadow Vocabulary
- **Plattenschatten** (dunkel `0 6px 24px -6px rgba(0,0,0,0.45)`, hell `0 6px 24px -6px rgba(0,0,0,0.07)`): nur die Platte. Dazu das Streiflicht, eine 1-px-Kante in `plate-edge` nur oben.
- **Schwebeschatten** (`0 12px 32px -4px rgba(0,0,0,0.28), 0 2px 6px rgba(0,0,0,0.18)`, `float_shadow`): Menü und Dialog, beide mit Rand in `plate-edge`. Der Dialog liegt über einem Schleier `rgba(0,0,0,0.55)`.
- **Fokusring** (2 px Abstand in `canvas`, dann 2 px Minze; als Schatten gezeichnet): jedes fokussierbare Bauteil. Nie das Blau des Systems.

### Named Rules
**Die Beleuchtete-Platte-Regel.** Die Platte ist das einzige Ding im Ruhezustand mit Schatten. Kacheln, Einstieg, Einstellungsspalte: Tönung, kein Rahmen, kein Schatten.

**Die Schwebe-Regel.** Ein Schatten heisst „schwebt über der Platte“. Was nicht schwebt, bekommt keinen.

## Shapes

Gerundet, und nur über die Tokens (`theme::radius`): Dialoge 16 px, die Platte 14 px, Blöcke, Kacheln, Menüs, Einstellungsspalte und Hinweis 12 px, Bedienelemente — Knöpfe, Felder, Rack-Plätze, Menüzeilen, das Symbolfeld einer Kachel — 8 px, Chips, Zähler und Fortschrittsbalken als Pille. Der Vertrag nannte für die Platte 16 px; gebaut sind 14, eine Stufe zwischen Block und Dialog. Ränder sind 1 px Haarlinien; der einzige 2-px-Rand ist die Überblendmarke.

Symbole sind Striche auf einem 16er-Raster (Strichstärke 1,35, runde Enden; `icons.rs`, aus den Daten der Website), 16 px im Rack, 17 px auf einem Feld von 32 px in der Kachel, und nehmen die Textfarbe an.

## Components

### Buttons
- **Shape:** sanft gerundet (8 px), 32 px hoch, klein 28 px.
- **Primary:** gefüllte Minze, Text `on-ink` halbfett, 14 px Seitenrand; Hover `ink-hover`. Genau einmal je Bildschirm; `primary_when(on)` macht einen Knopf nur so lange zur Hauptaktion, wie es noch nichts anderes zu tun gibt.
- **Quiet (Vorgabe):** `panel-soft` mit Haarlinie, Text `prose` mittel; Hover `panel-mid` mit `rule`-Rand.
- **Ghost:** ein Wort in Minze ohne Grund, 6 px Seitenrand; Hover `ink-wash`.
- **Hover / Focus / Deaktiviert:** Fokusring wie oben; deaktiviert 40 % Deckkraft und nicht drückbar. Enter und Leertaste lösen aus wie ein Klick.

### Chips
- **Style:** Pille, 28 px hoch, 12 px Seitenrand, 13 px mittel; `panel-soft` mit Haarlinie, Hover `panel-mid`.
- **State:** gewählt ist verdünntes Licht — `ink-wash`, Rand und Wort in Minze, halbfett. Die gefüllte Fläche bleibt der Hauptaktion.

### Cards / Containers
- **Kachel:** `panel-soft`, 12 px Rundung, 12 × 14 px Innenrand, kein Rahmen, kein Schatten; Hover `panel-mid`. Links ein Symbolfeld (32 px, 8 px Rundung, `ink-wash`, Symbol in Minze), rechts Titel (14 px halbfett, `prose`) und Hinweis (13 px `muted`, höchstens zwei Zeilen, kurz geschrieben statt abgeschnitten).
- **Einstieg:** `panel-soft`, 12 px Rundung, 26 × 28 px Innenrand; nimmt überall Dateien an und zeigt das beim Darüberziehen mit `ink-wash` und Minze-Rand.
- **Einstellungsspalte:** 320 px, `panel-soft`, 12 px Rundung, 16 px Innenrand.

### Inputs / Fields
- **Style:** `raised`, Rand `rule`, 8 px Rundung, 6 × 10 px Innenrand, 13 px Barlow.
- **Focus:** der Rand wird Minze.
- **Wert:** Courier Prime nur mit `value_face`.

### Navigation
- **Rack-Platz:** Symbol und Name, 30 px hoch, 8 px Rundung, 14 px. In Ruhe `muted` mittel; Hover `panel-soft` mit `prose`; gewählt `ink-wash`, Name `prose` halbfett, Symbol in Minze. Wartet dort etwas, steht ein Zähler am Rand (Pille, Minze, 11 px fett); im schmalen Rack sitzt er oben rechts am Symbol.
- **Gruppenname:** klein, halbfett, `muted` — eine Beschriftung über einer Liste, keine Seitenüberschrift.
- **Fuss:** durch eine Haarlinie getrennt; dieselben Plätze, nie gewählt.

### Notice
Zustand ist eine Marke am Rand, kein Kasten: `●` für eine Aussage, `!` für eine Warnung, in Minze fett vor dem Satz (13 px `prose`). Nur die Art „nicht lokal“ bekommt eine Fläche: `panel-cool`, 12 px Rundung, Minze-Rand, halbfett.

### Menu und Dialog
- **Menü:** `raised`, 12 px Rundung, Rand `plate-edge`, Schwebeschatten, mindestens 240 px; Zeilen 8 px gerundet, Hover `panel-mid`, gewählt `ink-wash`.
- **Dialog:** `canvas`, 16 px Rundung, Rand `plate-edge`, Schwebeschatten über einem Schleier; 16 px zwischen den Teilen.

### Fortschrittsbalken
4 px hoch, Pille, Grund `line`, gespielter Teil in Minze; ohne bekannten Anteil nur der Grund.

### Signature: Saallicht
Während auf der Seite „Abspielen“ ein Film läuft, wird das Licht im Saal heruntergedreht: das Rack blendet auf 32 % Deckkraft ab. Es kommt zurück, sobald der Zeiger darüber steht oder der Fokus darin ist, und blendet in beide Richtungen über 420 ms mit `ease-out`. Wer weniger Bewegung verlangt, bekommt den Wechsel ohne Blende.

### Signature: Überblendmarke
In den letzten zwei Sekunden, bevor „Nächste Folge“ angeboten wird, blinkt oben rechts im Bild zweimal ein Ring (18 px, 2-px-Rand in `stage-accent`, Füllung zu 40 %), wie die Überblendmarke auf einer Filmrolle. Sobald der Knopf kommt, ist er weg. Nur bei Videos mit einer nächsten Datei.

### Motion
Drei Dauern, zwei Kurven, keine Federn (`motion.rs`): 130 ms für Rückmeldung auf Druck und Hover, 240 ms für einen neuen Zustand, 420 ms für einen zurückgelegten Weg (ein Werkzeug kommt von der Seite, das Saallicht). `ease-out` ist die Vorgabe, `ease-settle` für Weiteres. Nur Eintritte: einblenden und dabei vom Herkunftsort heranrücken; Listen gestaffelt um 30 ms, zusammen höchstens 240 ms. Die schwebende Leiste kommt 16 px von unten. Weniger Bewegung im System heisst keine.

## Do's and Don'ts

### Do:
- **Do** füllen Sie Minze genau einmal je Bildschirm — die Hauptaktion der Seite; Gewähltes ist `ink-wash`.
- **Do** runden Sie nur über `theme::radius` (16 / 14 / 12 / 8 / Pille).
- **Do** setzen Sie Werte, Dateinamen und Zeiten mit `ui.value` in Courier Prime, alles andere in Barlow.
- **Do** halten Sie Fliesstext und Zusammenfassungen auf 640 px (`MEASURE`).
- **Do** stellen Sie auf Werkzeugseiten die Einstellungen in eine 320-px-Spalte auf `panel-soft` neben die Arbeitsfläche.
- **Do** messen Sie jede neue Paarung von Text und Grund in `tests/contrast.rs`, in beiden Themen.
- **Do** hüllen Sie jedes Bauteil in `accessible(…)` mit Name und Rolle und geben Sie ihm einen Fokusring.

### Don't:
- **Don't** geben Sie Kacheln, Blöcken oder der Einstellungsspalte einen Rahmen oder Schatten — die Tönung ist die Kante.
- **Don't** setzen Sie Schatten auf etwas, das nicht über der Platte schwebt.
- **Don't** verwenden Sie `panel-cool` für etwas anderes als „läuft nicht lokal“.
- **Don't** färben Sie Überschriften in Minze, um Rang zu erzeugen — Rang kommt aus der Grösse.
- **Don't** kostümieren Sie die Kabine: kein Filmstreifen, keine Perforation, keine Leuchtschrift. Kino-Geräte kommen nur als Funktion vor (Saallicht, Überblendmarke).
- **Don't** verwenden Sie Mono als Kostüm für „technisch“.
- **Don't** setzen Sie Eyebrows oder Versalien-Vorzeilen über eine Überschrift.
