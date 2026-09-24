---
name: Sondra
description: Ein Medienstudio, das im Tab rechnet — ein ruhiges, flaches Blatt, auf dem jede Zahl gemessen ist.
colors:
  canvas: "#f4f3ee"
  raised: "#ffffff"
  panel-soft: "#eaf2e9"
  panel-mid: "#e2ebe1"
  panel-strong: "#d2e4d1"
  panel-cool: "#e4edef"
  ink: "#0f3e1c"
  ink-hover: "#0a2b13"
  on-ink: "#ffffff"
  prose: "#1b231d"
  muted: "#5d6c61"
  line: "#d5d4c9"
  rule: "#bbc6ba"
  faint: "#b0b6af"
  stage: "#15181a"
  stage-soft: "#1d2124"
  stage-line: "#515a5d"
  stage-ink: "#eef1f0"
  stage-muted: "#aab5b2"
typography:
  display:
    fontFamily: "'Public Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "39px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.5px"
  headline:
    fontFamily: "'Public Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "25px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  title:
    fontFamily: "'Public Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.005em"
  body:
    fontFamily: "'Public Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  small:
    fontFamily: "'Public Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "'Public Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.45
  value:
    fontFamily: "'Courier Prime', ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.02em"
    fontFeature: "tabular-nums"
  wordmark:
    fontFamily: "'Sondra Wordmark', ui-serif, Georgia, serif"
    fontSize: "25px"
    fontWeight: 300
    letterSpacing: "-0.01em"
rounded:
  card: "16px"
  nav: "10px"
  pill: "999px"
spacing:
  "0.5": "2px"
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "9": "36px"
  "12": "48px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    typography: "{typography.body}"
    padding: "12px 16px"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
    textColor: "{colors.on-ink}"
  button-quiet:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "12px 16px"
  button-quiet-hover:
    backgroundColor: "{colors.panel-soft}"
    textColor: "{colors.ink}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
  button-sm:
    typography: "{typography.small}"
    padding: "8px 12px"
  input:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.prose}"
    typography: "{typography.value}"
    rounded: "{rounded.card}"
    padding: "8px 12px"
  select:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.prose}"
    typography: "{typography.small}"
    rounded: "{rounded.card}"
    padding: "8px 12px"
  chip:
    backgroundColor: "{colors.panel-soft}"
    textColor: "{colors.prose}"
    typography: "{typography.small}"
    rounded: "{rounded.nav}"
    padding: "8px"
  chip-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.prose}"
    typography: "{typography.small}"
    rounded: "{rounded.nav}"
    padding: "8px 12px"
  tab-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
  badge:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    padding: "3px 8px"
  badge-forest:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
  stat-row:
    backgroundColor: "transparent"
    textColor: "{colors.prose}"
    typography: "{typography.small}"
    padding: "8px 0"
  procedure-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.small}"
    padding: "10px 4px"
  procedure-row-hover:
    backgroundColor: "{colors.panel-soft}"
    textColor: "{colors.ink}"
  entry-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "16px 4px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.nav}"
    height: "32px"
    width: "32px"
  toggle-track:
    backgroundColor: "transparent"
    height: "16px"
    width: "28px"
  toggle-track-checked:
    backgroundColor: "{colors.ink}"
  toggle-knob:
    backgroundColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "12px"
    width: "12px"
  editor-frame:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.prose}"
    rounded: "{rounded.card}"
  editor-stage:
    backgroundColor: "{colors.stage}"
    textColor: "{colors.stage-ink}"
---

# Design System: Sondra

> Überschriften englisch, weil Werkzeuge sie genau so parsen; Inhalt deutsch wie
> in [PRODUCT.md](PRODUCT.md) und [CLAUDE.md](CLAUDE.md). Die **Tokens im
> Frontmatter sind normativ** — die Prosa sagt, wo und warum sie gelten, und
> wiederholt keinen Wert. Die Werte oben sind das helle Thema; die dunkle
> Umrechnung liegt Token für Token in der Sidecar-Datei (`npm`-Skript
> `scripts/build-design-sidecar.mjs`).
>
> Aufgenommen aus dem gebauten Stand, nicht aus dem Vorhaben. Quellen:
> `src/styles/theme.css`, `src/components/ui/primitives.tsx`, `public/fonts.css`
> und die drei Flächen, auf denen die Welt angewandt ist — `Home.tsx`,
> `AppShell.tsx`, `editor/EditorShell.tsx`.

## Overview

**Creative North Star: „Das ruhige Blatt"**

Sondra misst, und die Oberfläche soll dem nicht widersprechen: ruhig, flach,
ohne Effekt, der etwas behauptet, was nicht gemessen wurde. Jede Zahl in dieser
App wurde gemessen statt geschätzt, und sie wurde auf dem Gerät der Besucherin
gemessen.

Wie weit diese Haltung tragen darf, ist am 20.9.2026 an einem Fehlschlag
geklärt worden. Der erste Wurf hiess „Der Eichschein" und nahm das Bild
wörtlich: die Abschnitte hiessen „Prüfgegenstand" und „Verfügbare Verfahren",
jede Überschrift trug eine Klauselnummer, und die Startseite empfing mit einem
leeren Formular. Es war konsequent und es war unbenutzbar — beim ersten Blick
des Nutzers verworfen. **Das Messen gehört in die Art, wie Zahlen berichtet
werden, nicht in die Wörter auf der Tür.** Geblieben ist die Form, gegangen ist
die Amtssprache.

Daraus folgt alles Weitere, und zwar als Verzicht. Es gibt keine Karten: ein
Formular hat keine Kästen, es hat Linien. (Die runden Ecken sind seit dem
23.9.2026 zurück, siehe „Shapes" — der Rest dieses Absatzes gilt weiter.) Es gab keine runden Ecken, weil eine
gerasterte Seite keine hat. Es gibt keinen Schatten auf dem Blatt, weil nichts
auf dem Blatt liegt — die eine Tiefenstufe ist für die drei Dinge reserviert,
die wirklich darüber schweben. Getrennt wird durch eine gezogene Linie und
durch Raum, nie durch einen Rahmen auf vier Seiten.

Zwei Schriften teilen sich die Arbeit nach Bedeutung, nicht nach Geschmack.
Public Sans setzt die Oberfläche. Courier Prime ist das, was die Maschine
eingetragen hat: Messwerte, Dateinamen, Zeitmarken. Wer die beiden
unterscheiden kann, sieht auf einen Blick, was die Seite fragt und was
gefunden wurde. Die Serife der vorigen Welt ist aus dem System verschwunden und
überlebt allein in der Wortmarke, als eigene Familie `Sondra Wordmark` — eine
gegebene Zusage ist etwas anderes als eine Gewohnheit.

Ausdrücklich verworfen: die Kategorie-Voreinstellung (dunkles Chrom, Neonakzent,
Wellenform als Held) und deren erwartbares Gegenteil, die luftige weisse Seite
mit grosser Serifen-Schlagzeile — das war diese App vor dem Umbau.

**Key Characteristics:**

- Jede Zahl trägt, wie sie gemessen wurde — in der Zahl, nicht in der Überschrift
- Keine Karten und kein Schatten auf dem Blatt; Ecken sind gerundet (16 px Blöcke, 10 px Bedienelemente)
- Zwei Linienstärken statt Rahmen: die Haarlinie und die schwerere Abschnittslinie
- Zwei Schriften, getrennt nach Bedeutung: Oberfläche und eingetragener Wert
- Werkzeuge stehen als getöntes Kachelfeld, gruppiert und filterbar
- Der Einstieg zeigt die nächste Handlung, nicht den Zustand der leeren Sitzung
- Klartext statt Amtston: eine Überschrift heisst, was sie ist
- Ein einziger gesättigter Farbwert, gemessene Kontraste in beiden Themen

## Colors

Warmes Papier trägt die Fläche, ein einziges dunkles Waldgrün ist die
Druckfarbe, und eine dritte Welt — die neutrale Bühne der Editoren —
widerspricht beiden mit Absicht.

### Primary

- **Waldtinte** (`{colors.ink}`): die einzige gesättigte Farbe im System und
  die einzige Druckfarbe. Sie liegt auf den Linien, auf Überschriften, auf
  Kachelsymbolen, auf dem Fokusring und auf der einen gefüllten Aktion je
  Abschnitt. Sie bedeutet genau eines: *hier können Sie etwas tun.*
- **Waldtinte gedrückt** (`{colors.ink-hover}`): ausschliesslich der
  Hover-Zustand gefüllter Flächen. Nirgends im Ruhezustand.
- **Papier auf Tinte** (`{colors.on-ink}`): Text auf gefüllter Tinte.

### Neutral

- **Warmes Papier** (`{colors.canvas}`): das Blatt selbst, Grund der ganzen App.
- **Feld** (`{colors.raised}`): Weiss erscheint nur, wo ein Feld ausfüllbar ist
  oder wo eine Fläche eine eigene Mechanik hat — Eingaben, der Editorrahmen,
  die Reiterleiste. Nicht als Karte; eine Karte gibt es hier nicht.
- **Blasse Minze** (`{colors.panel-soft}`): eingesetzte Blöcke und der
  Hover-Grund von Listenzeilen.
- **Minze** (`{colors.panel-mid}`) und **Kräftige Minze**
  (`{colors.panel-strong}`): die zweite Tönungsstufe und die Textmarkierung.
- **Kühle Minze** (`{colors.panel-cool}`): reserviert für den einen Hinweis,
  dass etwas nicht lokal läuft — die Warnung oben im Downloader, mit 2 px
  Ring in Tinte und fetter Überschrift. Der einzige kühle Ton im hellen Thema,
  damit er sich nicht in die Reihe der übrigen Tönungen einsortiert. In der
  App, wo der Dienst auf dem eigenen Rechner läuft, fällt die Warnung weg; dort
  steht ein Block auf `panel-soft` mit demselben Haftungssatz.
- **Prosa** (`{colors.prose}`): Fliesstext und Beschriftungen.
- **Gedämpft** (`{colors.muted}`): Sekundärtext, Hinweise, Einheiten.
- **Nicht zutreffend** (`{colors.faint}`): ein Verfahren, das auf die geöffnete
  Datei nicht passt. Blasser als gedämpft, aber ausdrücklich noch lesbar — das
  Abdunkeln der ganzen Zeile mass sich bei APCA Lc 48 gegen ein Ziel von Lc 60
  und wurde dafür verworfen.
- **Haarlinie** (`{colors.line}`): die Linie einer Tabelle. Jede Trennung
  zwischen Zeilen, Feldern und Blöcken.
- **Abschnittslinie** (`{colors.rule}`): die schwerere Linie, die einen Abschnitt
  eröffnet, und der Ring um ein ruhiges Bedienelement.

### Tertiary

- **Bühne** (`{colors.stage}`), mit `{colors.stage-soft}`,
  `{colors.stage-line}`, `{colors.stage-ink}`, `{colors.stage-muted}`: die
  Fläche, auf der ein Bild oder Video bearbeitet wird. In beiden Themen dunkel
  und absichtlich neutral — ein Bild vor Creme wirkt warm, vor Grün kühl, und
  die eine Fläche, die über Farben nicht lügen darf, ist die, auf der man sie
  beurteilt.

### Named Rules

**Die Tinte-wird-ausgegeben-Regel.** Tinte liegt auf Linien, Überschriften und
der einen Aktion, um die ein Abschnitt bittet. Überall sonst ist die Seite
Papier und Graphit. Deckt sie mehr als etwa ein Zehntel eines Bildschirms, ist
sie keine Tinte mehr, sondern Farbe.

**Die Messregel.** Kontrast wird gerechnet, nicht geschätzt, und in beiden
Themen. APCA: Fliesstext ≥ Lc 75, Sekundärtext ≥ Lc 60, Überschriften ≥ Lc 45,
Nicht-Text ≥ Lc 15. Eine Palettenänderung ist erst fertig, wenn sie durch die
Zahlen gelaufen ist — dieser Durchgang fand eine Trennlinie bei Lc 0.0 und eine
gefüllte Schaltfläche bei Lc 70.

**Die Umrechnungsregel.** Dunkel ist eine eigene Abbildung mit eigenem
Kontrastdurchgang, nie eine Invertierung. Tinte und ihr Grund tauschen dort die
Rollen: der einzige gesättigte Wert muss der helle sein, sonst verschwinden
Überschriften und gefüllte Schaltflächen.

**Die Ehrliche-Bühne-Regel.** Die Bühne der Editoren bleibt neutral dunkel und
nimmt an keinem Themenwechsel teil. Sie ist kein Gestaltungsspielraum.

## Typography

**Form Font:** Public Sans (variabel 400–700), mit `ui-sans-serif`,
`system-ui`, `-apple-system`, `Segoe UI`
**Value Font:** Courier Prime (400 und 700), mit `ui-monospace`, `SF Mono`,
Menlo
**Wordmark Font:** `Sondra Wordmark` — Cormorant Garamond, ausschliesslich für
das eine Wort

**Character:** Public Sans existiert, weil eine Verwaltung eine Schrift
brauchte, in der ihre Dokumente gesetzt werden können — eine Amtsschrift der
Herkunft nach, nicht der Assoziation nach, mit den Tabellenziffern, die eine
Seite voller dB, LUFS und Byte-Zahlen braucht. Courier Prime ist die
Schreibmaschine, die auf echten Prüfscheinen die Lücken gefüllt hat. Beide sind
selbst gehostet unter `public/fonts`, kein CDN; nach dem Laden bleibt das Netz
still.

### Hierarchy

- **Display** (`display-lg`): die eine grosse Zeile einer Fläche. Steht in
  Tinte.
- **Headline** (`display-md`): der Kopf eines Hauptabschnitts — „Werkzeuge",
  „Ton, Video und Bilder bearbeiten". Steht in Tinte.
- **Title** (`display-sm`): Dialogtitel und Zwischenüberschriften.
- **Body**: laufender Text und die grosse Schaltflächengrösse. 16 px, weil das
  hier Deutsch ist — lange Wörter, und 14 px verlangt ihnen zu viel ab.
- **Small**: das dichte Werkzeug-Chrome — Anzeigen, Hinweise, Chips, Reiter,
  Formularzeilen. Drei Grössen tragen die ganze Oberfläche, und das ist die
  mittlere davon.
- **Label**: 11 px. Die kleinste Stufe: Kopfzeilen-Angaben, Beschriftungen in
  der Werkzeugleiste des Editors, und als einzige Versalbehandlung der
  gestempelte Badge (Laufweite 0.08em).
- **Value** (`value`): was die Maschine gefunden hat. Rechtsbündig, mit
  Tabellenziffern, in eigener Spalte neben der Einheit. Erscheint in der
  Grösse der Zeile, in der es steht — meist Small oder Label.
- **Wordmark**: das Wort „Sondra" im Kopf, in Gewicht 300. Sonst nirgends.

### Named Rules

**Die Zwei-Schriften-Regel.** Courier Prime steht für etwas, das tatsächlich
gefunden wurde: ein Messwert, ein Dateiname, eine Zeitmarke. Nie als Kostüm
für „technisch". Was die Oberfläche selbst sagt, steht in Public Sans.

**Die Sechs-Stufen-Regel.** Eine grosse Terz ab 16 px, genau sechs Stufen,
nichts dazwischen. Die Vorgängerwelt erklärte fünf Stufen und schrieb daneben
220 Grössen von Hand, darunter 9, 10, 10.5, 11, 12, 13, 13.5 und 14 px für
dieselbe Aufgabe. Zwei Grössen einen Pixel auseinander sind keine Hierarchie,
sondern eine nicht getroffene Entscheidung.

**Die Kein-Anzeigeschnitt-Regel.** Überschriften sind dieselbe Grotesk, nur
grösser und schwerer. Ein Prüfschein hat keine Anzeigeschrift, und die, die
diese App hatte, ist die Schrift, nach der jede Allerwelts-Vorlage greift.

**Die Ein-Wort-Regel.** Cormorant Garamond lädt als eigene Familie
`Sondra Wordmark` und setzt genau ein Wort. Sie ist nirgendwo sonst erlaubt —
auch nicht dort, wo eine Überschrift sie „auch" verwenden könnte.

## Layout

Die Seite ist ein Blatt. `shell` zentriert sie auf höchstens 1280 px und hält
links und rechts einen Rand von 21 px.

Alles komponiert als gerasterte zweispaltige Tabelle: Beschriftung links, Wert
rechtsbündig, Einheit in eigener schmaler Spalte (`w-[4ch]` bis `w-[6ch]`), so
dass eine Spalte von Werten von oben nach unten gelesen werden kann.
Wo eine Zeile einen Zustand hat, steht in einer eigenen Randspalte das Randzeichen
in derselben Achse.

Fliesstext, Listeneinträge und Beschreibungen sind auf **34em** gedeckelt.
Werte, Beschriftungen und Tabellenzellen erreichen die Deckelung nie, weil sie
kurz sind.

Abstände folgen einem 4-px-Raster; 2 px existiert als Halbschritt für
Haarlinien-Versätze. Tatsächlich getragen wird das System von vier Werten —
4, 8, 12 und 16 px — mit 20, 24, 32, 36 und 48 px für die grossen Sprünge.
Um das, was mehr zählt, steht mehr Raum: eine Verfahrenszeile bekommt 10 px
Höhe, eine Eingangszeile 16 px.

Die Umbrüche sind zwei. Unter **640 px** stapeln Formularzeilen Beschriftung
über Feld, und Raster fallen auf eine Spalte. Unter **1024 px** verliert der
Editor seine drei Spalten: die Werkzeugschiene wird zum waagerechten Streifen
unter der Bühne, der Inspektor fällt darunter. Die Reihenfolge bleibt dieselbe —
sehen, Werkzeug wählen, einstellen.

### Named Rules

**Die Klartext-Regel.** Eine Überschrift heisst, was der Abschnitt ist, in der
Sprache der Leserin: „Werkzeuge", nicht „Verfügbare Verfahren". Sie-Form und
nüchterner Ton bleiben — Behördendeutsch war nie dasselbe wie Sachlichkeit.
Diese Regel steht hier, weil der erste Wurf genau daran gescheitert ist.

**Die Keine-Zierziffer-Regel.** Abschnitte tragen keine Nummern. Der Vorgänger
nummerierte 1.1 bis 1.3.4 durch und verteidigte das damit, dass jede Nummer ein
Anker sei; als Bild war es Rauschen auf jeder Zeile. Tiefe Verweise bleiben
trotzdem möglich: jede Kachel behält ihre `id`, nur steht sie nicht mehr
gedruckt daneben.

**Die 34em-Regel.** Die Textspalte wird nicht breiter, weil das Fenster es
wurde. Die Einheit ist `em` und nicht `ch`: ein `ch` ist die Breite der Null und
damit breiter als der Durchschnittsbuchstabe, weshalb eine Deckelung bei 68ch
in Wahrheit bei 90 Zeichen landete.

## Elevation & Depth

Es gibt **genau eine Tiefenstufe**, und sie ist im Ruhezustand nirgends auf dem
Blatt. Das Blatt ist der Grund; nichts liegt darauf, also wirft nichts einen
Schatten darauf. Getrennt wird durch Linie, Raum und — für eingesetzte Blöcke —
durch eine Tönung, nie durch Abheben. Die zweite Stufe der Vorgängerwelt ist
mit den Karten verschwunden, die sie anhob.

### Shadow Vocabulary

- **Lift** (`--shadow-lift`, Utility `elevate-lift`): das Einzige, was schwebt.
  Im gebauten Stand trägt es drei Dinge: das Popover mit dem Lokalitäts-
  Versprechen, die Ablage-Überlagerung beim Ziehen einer Datei, und das Bild
  beziehungsweise Video, das auf der Bühne gezeigt wird. Im dunklen Thema ist
  es eine eigene, deutlich tiefere Umrechnung, keine Anpassung des hellen.

### Named Rules

**Die Nichts-liegt-auf-dem-Blatt-Regel.** Bevor etwas einen Schatten bekommt,
muss beantwortet sein, worüber es schwebt. Lässt sich das nicht beantworten,
schwebt es nicht: dann trennen Linie und Raum.

**Die Getönt-statt-gehoben-Regel.** Ein Block, der in einem Abschnitt sitzt,
bekommt eine Tönung, damit das Auge ihn als eingesetzt liest — nicht einen
Schatten, der ihn als weiteres gestapeltes Objekt behauptet.

## Shapes

**Ecken sind gerundet — seit dem 23.9.2026, auf ausdrücklichen Wunsch.** Die
Welt vom 20.9. war durchgehend eckig; beim Umbau der Startseite hiess es
„keine Angst haben, Radius zu benutzen". Zwei Stufen und die Pille:

- **`card` (16 px):** Kacheln, getönte Blöcke (`mint`, `sage`, `slate`), die
  Ablagefläche, das Windows-Feld, Popover, Formatliste, Editorrahmen.
- **`nav` (10 px):** Knöpfe, Eingabefelder, Auswahllisten, Chips, der
  Download-Knopf, Symbolknöpfe. Etwas enger, damit ein Knopf in einem Block
  konzentrisch sitzt; die Optionen in einer Segment-Schale nehmen 7 px.
- **`pill` (999 px):** Filterpillen auf der Startseite, das Suchfeld dort,
  Schalterkörper und -knauf, der Griff des Schiebereglers, Zustandspunkte.

Was eine Linie ist, bleibt gerade: Abschnittslinien, Haarlinien, der
Reiter-Unterstrich. Der Fokusring folgt der Rundung des Elements.

**Zeitflächen bleiben eckig** (ebenfalls auf Wunsch, 23.9.2026): die
Zeitleiste im Video-Editor, jede Wellenform (Ton-Editor, Lautstärke, Player,
Zerschneiden), die Klavierrollen (Tonart-Ansicht und Pad im Pattern) und die Editorbühne. Eine
Fläche, auf der eine Zeitachse oder ein Bild vermessen wird, beginnt und endet
an einer Kante; eine Rundung schnitte ihr die ersten und letzten Millisekunden
optisch ab. Die Bedienelemente daneben bleiben gerundet.

**Struktur wird gezogen, nicht angedeutet.** Zwei Linienstärken, und der
Unterschied ist nicht Dekoration:

- Die **Haarlinie** (`border-t border-line`, 1 px) ist die Linie einer Tabelle.
  Sie steht zwischen Zeilen, über einem Feld, über einem aufklappbaren
  Unterpunkt.
- Die **Abschnittslinie** (`border-t-2 border-rule`, 2 px) eröffnet einen
  Abschnitt und schliesst die Kopfzeile nach unten ab.

Eine Linie steht immer **auf einer Seite** — auf der, die dem zugewandt ist,
wovon getrennt wird. Eine Regel über dem ersten Eintrag ist zugleich die
Oberkante der Gruppe, also braucht die Gruppe keinen Kasten. Wo ein Umriss
wirklich gebraucht wird, weil eine Fläche eine eigene Mechanik hat — das
Eingabefeld, der Editorrahmen, die Reiterleiste —, ist es ein
`ring-1 ring-inset` in Haarlinien- oder Abschnittslinienstärke, kein `border`
und kein Schatten.

**Symbole**: der projekteigene Strichsatz, 16 px in `components/panelMeta.tsx`,
18–20 px in `components/editor/icons.tsx`, Strichstärke 1.35–1.4, ein Raster.
Nur dort, wo das Symbol eine Information trägt. Keine Symbolbibliotheken, keine
Emoji.

### Named Rules

**Die Eine-Linie-Regel.** Ein Rahmen auf allen vier Seiten behauptet, das hier
sei ein Objekt auf einer Fläche. In dieser Welt stimmt das für fast nichts. Die
Reihenfolge, in der gegriffen wird: erst Raum, dann Tönung, dann eine Linie,
und erst ganz zuletzt ein Umriss — und der nur für eine Fläche mit eigener
Mechanik.

**Die Zwei-Stärken-Regel.** Es gibt genau zwei Linien: die Haarlinie der
Tabelle und die schwerere Linie, die einen Abschnitt eröffnet. Beide sind eigene Farbtokens und
keine Deckkraft auf Tinte — dieselbe Tinte bei 25 % mass sich auf Papier bei
APCA Lc 25 und im dunklen Thema bei Lc 7.

## Components

### Buttons

- **Shape:** eckig, ohne Radius, ohne Schatten.
- **Primary:** gefüllte Tinte. Die eine Aktion, um die ein Abschnitt bittet.
  Auf der Startseite steht sie dort, wo die Leserin nach dem ersten Satz
  hinsieht — nicht am Fuss einer Tabelle.
- **Quiet:** Feldweiss mit Abschnittslinien-Ring. Eine gerasterte Fläche, die man
  auch drücken kann.
- **Ghost:** ein Wort im laufenden Text, unterstrichen in Abschnittslinie; beim
  Zeigen wechselt die Unterstreichung auf Tinte.
- **Hover / Active / Focus:** Farbwechsel in `--dur-fast`; ein Versatz von 1 px
  nach unten, nur bei feinem Zeiger (`press`). Fokus ist ein 2-px-Ring in Tinte
  mit 2 px Versatz, nie Browserblau.
- **Disabled:** Deckkraft 0.4, `cursor: not-allowed`.

### Chips

- **Style:** blasse Minze mit Haarlinien-Ring, Small, eckig. „Eins aus vier" —
  Seitenverhältnisse, Drehungen, Formate.
- **State:** ausgewählt ist gefüllte Tinte ohne Ring; `aria-pressed` trägt den
  Zustand mit.

### Containers

Es gibt **keine Karte**. `Card` ist der Name der Komponente, nicht ihrer Form:

- **`cream` / `keylime`** sind Abschnitte des Blattes — eine Abschnittslinie über
  die volle Breite, darunter Luft, darunter der Inhalt. Kein Grund, kein
  Rahmen, kein Schatten.
- **`mint` / `sage` / `slate`** sind Blöcke, die *in* einen Abschnitt gesetzt
  sind. Sie bekommen eine Tönung (`panel-soft`, `panel-mid`, `panel-cool`) und
  16 px Innenraum (12 px in `compact`), damit das Auge sie als eingesetzt liest.

### Inputs

- **Style:** Feldweiss, eckig, Haarlinien-Ring nach innen, `border: 0`, Small,
  8/12 px Innenraum. `TextInput` trägt zusätzlich `value` — was eingetippt
  wird, steht in der Schrift der eingetragenen Dinge.
- **Focus:** der Ring wechselt auf Tinte; das Feld verschiebt sich nicht.
- **Field:** eine Zeile des Formulars — Haarlinie oben, Beschriftung, Feld,
  darunter der Hinweis in gedämpft. Unter 640 px stapeln Beschriftung und Feld,
  weil eine deutsche Beschriftung und ein Bedienelement nebeneinander in
  340 px für keines von beiden Platz lassen.
- **Slider:** die Spur ist eine gedruckte Linie von 1 px, der Griff ein
  rechteckiger Reiter von 3 × 14 px in Tinte — keine OS-Chrome. Der Wert steht
  rechts in der Wertschrift.
- **Toggle:** eckiger Körper von 28 × 16 px, runder Knauf von 12 px. Der
  Schalter ist der eine physische Gegenstand auf einem Blatt Papier und deshalb
  das eine, was eine Rundung haben darf.

### Navigation

- **Reiterleiste** (`PanelTabs`): die zweite Zeile der Kopfzeile, Text auf
  deren eigenem Grund. Der gewählte Reiter steht in Tinte, halbfett, mit einer
  2-px-Linie darunter, die auf der Abschnittslinie der Kopfzeile aufliegt; die
  übrigen in Prosa. Bis zum 23.9.2026 war sie ein weisser Kasten mit Ring und
  gefüllter Auswahl unter einer getönten Sitzungsleiste — drei Bänder, bevor
  ein Werkzeug etwas sagte, und das Hauptargument für „mega cluttered". Auf dem
  Handy läuft sie randlos bis an den Rand und wird gewischt; auf der Startseite
  des Handys fehlt sie, weil die Kacheln darunter dasselbe Menü sind.
  Pfeiltasten wechseln den Reiter, der gewählte bleibt der einzige mit
  `tabIndex 0`.
- **Werkzeugschiene** (`Rail`): senkrecht 84 px breit auf Feldweiss, Symbol
  über Beschriftung in Label-Grösse; ein Werkzeug mit geänderter Einstellung
  trägt ein 5-px-Quadrat oben rechts. Unter 1024 px waagerecht.
- **Kopfzeile:** klebt oben, schwerere Linie nach unten, Grund `canvas/95` mit
  Unschärfe. Links die Wortmarke, rechts drei ruhige Bedienelemente: das
  Dateimenü, „App herunterladen" — als einziges getönt — und ein einzelner
  Themenknopf, der durch System, Hell und Dunkel schaltet. Der Download-Knopf
  öffnet ein natives `<dialog>` (Schattenstufe, Hintergrund abgedunkelt): der
  Microsoft Store als ausgegraute Zeile, die bei Hover, Fokus und Antippen
  „Bald verfügbar" sagt — bewusst `aria-disabled` statt `disabled`, weil ein
  deaktivierter Knopf in mehreren Browsern gar keinen Hover bekommt —, darunter
  das Setup (.exe). In der App entfällt er. Den Lokal-Chip („Lokal · 1
  Ausnahme") gibt es seit dem 23.9. nicht mehr; die Ausnahme sagt der
  Downloader selbst, laut.
  „Installieren" und der Suchknopf sind auf Wunsch entfallen; gesucht wird auf
  der Startseite, und Strg/Cmd + K öffnet die Befehlspalette weiterhin überall.
- **Dateimenü** (`SessionMenu` in `AssetList.tsx`): nennt die Datei, an der
  gearbeitet wird, und hält die ganze Sitzung einen Klick dahinter — Wiedergabe,
  Wechseln, Speichern, Entfernen, weitere Datei, Arbeitsspeicher, Alles
  verwerfen. Es ersetzt drei Dinge, die vorher auf jeder Seite standen: die
  Sitzungsleiste, die rechte Sitzungsspalte jedes Werkzeugs mit fünfzehn
  „Damit geht"-Knöpfen (eine zweite Kopie der Reiter) und den Knopf „Weitere
  Datei". Die Werkzeuge sind dadurch einspaltig oder behalten nur ihre eigene
  Seitenspalte. Das Menü trägt die eine Schattenstufe; auf dem Handy liegt es
  fest unter der Kopfzeile über die volle Breite.
- **Pattern** (`StepSequencer`): das Channel-Rack-Raster unter den Pads. Eine
  Zeile je Pad mit „M" (stumm) und dem Padnamen, der das Pad anspielt; 16
  oder 32 Zellen zu 24 × 28 px mit 5 px Rundung, in Vierergruppen abwechselnd
  `panel-mid` und `panel-soft`, eine gesetzte Zelle ist Tinte, der Laufpunkt
  ein 2-px-Ring. Auf dem Handy scrollt das Raster seitlich, statt die Zellen
  unter Daumengrösse zu drücken. Das Notensymbol neben dem Padnamen öffnet
  die **Klavierrolle** des Pads darunter: zwei Oktaven um die Tonhöhe des
  Pads (die Mitte ist C4), eine Spalte je Schritt, eckig als Zeitfläche.
  Klicken setzt, Ziehen verlängert oder verschiebt, ein Klick auf einen Ton
  nimmt ihn weg — ohne Rechtsklick, den Trackpad und Handy nicht haben. Ein
  Pad ist entweder gestept oder gerollt, wie ein Kanal in FL Studio; gerollt
  zeigt seine Zeile die Töne in klein.
- **Ein gezogener Bereich ist eine Frage** (Zerschneiden): er erscheint
  dunkler getönt mit „Auswahl hören", „Als Pad anlegen" und „Verwerfen",
  und wird erst auf Bestätigung ein Pad. Ein verirrter Zug hinterliess vorher
  ein Pad. Pads löschen: im Pad-Block oder mit Entf.
- **Einstellen heisst hören** (Ton-Editor): jeder Klang-Block ist ein
  Schalter, ein bewegter Regler schaltet ihn ein, und die Wiedergabe läuft
  durch dieselbe Web-Audio-Kette (`lib/liveSound.ts`), die „Übernehmen" danach
  offline rendert — was zu hören war, steht in der Datei. Eine Leiste unter
  der Welle sagt in einem Satz, was gerade zu hören ist, mit Vorher/Nachher.
  Tempo und Tonhöhe hört man live über einen körnigeren Schieber; übernommen
  rechnet der Phasenvocoder, und der Hinweis sagt das.
- **Blenden sind zu sehen, bevor sie da sind:** im Ton-Editor in der Welle
  selbst — die Säulen werden mit derselben Gleichleistungs-Kurve kleiner, die
  der Ton bekommt, was die Blende wegnimmt, bleibt als schwache Spur stehen,
  und eine Haarlinie folgt der Kurve. Kein Schleier über der alten Welle: der
  las sich als Kasten und zeigte nicht, was zu hören sein wird. Ebenso beim
  Überfahren von „Hier einblenden/ausblenden" über der Auswahl; im
  Video-Editor als Rampe auf der Zeitleiste und als Schwarz über dem Bild, das
  dem Abspielkopf Bild für Bild folgt.
- **Letzte Sitzung** steht über dem Werkzeug als Zeile mit Marke am Rand
  (`RestoreOffer`), wie `Notice`: was es war (Dateien, Grösse, wann, in Mono)
  und zwei Knöpfe, „Wiederherstellen“ und „Verwerfen“. Kein Dialog vor der
  Seite — sie bleibt bedienbar, bis jemand antwortet. Im Dateimenü sagt die
  Fusszeile „auf diesem Gerät gespeichert“ bzw. „wird … gespeichert …“, darunter
  der Schalter zum Abschalten.
- **Mehrere Dateien** (`BatchFiles`): ein Schalter „Mehrere Dateien auf
  einmal“, darunter eine Liste mit Häkchen, getrennt durch Linien, und
  „Weitere Dateien hinzufügen“ als Textlink. Nur Dateien, die das Ziel
  werden können, stehen darin; neu hinzugefügte sind gleich angehakt. Der
  Knopf zählt mit („3 Dateien umwandeln“).
- **Tastenkürzel** hinter `?` und im Fuss: ein `Dialog`, je Werkzeug eine
  Spalte, links was passiert, rechts die Tasten in Mono.
- **Untertitel im Bild:** Public Sans 600, 5,2 % der kurzen Bildseite, weiss
  auf einer dunklen, gerundeten Platte (62 % Deckkraft) je Zeile, höchstens
  zwei Zeilen à rund 42 Zeichen, unten mittig mit 6 % Abstand. Im Browser
  gezeichnet, damit es dieselbe Schrift ist wie auf der Seite.
- **Pegelanzeige** (Mikrofon): flacher Balken ohne Rundung — eine Zeitfläche
  im Sinn der Regel oben —, Tinte auf `panel-soft`, die letzten 6 dB als
  `panel-mid` markiert statt rot, Spitzenhalter als 2-px-Strich, Werte in
  Mono darunter.
- **Auswahlkarten** („Wofür?" beim Mikrofon): Knöpfe mit `role="radio"` im
  Kartenraster, `rounded-card`, gewählt gefüllte Tinte, sonst `panel-soft`.
- **Keine toten Bedienelemente.** Was ohne Voraussetzung nichts tut, steht
  nicht ausgegraut da, sondern erscheint mit der Voraussetzung: die Schnitte
  mit einer Auswahl, „Alle Dateien umwandeln" ab der zweiten Datei, „Stille
  entfernen" wenn Stille gefunden wurde.

### Kleine Bildschirme

Das Gegenstück zur Breite: auf dem Handy ist nicht die Fläche knapp, sondern
die Höhe, und sie ging ans Rahmenwerk. Gemessen bei 390 × 844: Kopfzeile
110 px, Sitzungsleiste 105 px, Reiter 44 px — zusammen 320 px, also 38 % des
Schirms, bevor das Werkzeug seine Überschrift zeigte. Jetzt 211 px (25 %).

Die Kopfzeile brach um, weil Wortmarke (101 px) und Bedienelemente (243 px)
mit Abstand und Rand auf 410 px kamen. Enger gesetzte Abstände, ein knapperer
Themenschalter und ein kürzerer Knopf bringen sie auf eine Zeile.

**Gekürzt wird der Text, nicht die Aussage.** Der Download-Knopf sagt auf dem
Handy „App" statt „App herunterladen". Die Sitzungsleiste sagt „1 Datei · 0.0 MB" statt
„… im Arbeitsspeicher dieses Tabs · nichts davon wurde gesendet": was dort
wegfällt, weiss die Leserin bereits, denn sie sieht genau diesen Tab an. Ab
`sm` steht wieder der volle Wortlaut.

### Grosse Bildschirme

Gemessen statt geschätzt: bei festen 1280 px lagen auf einem 2560er Monitor
50 % der Breite brach, auf einem 3440er 63 %. Die Spalte (`shell`) wächst
deshalb in Stufen — 1280 → 1440 (ab 1600 px) → 1680 (ab 1920) → 1840 (ab
2400) — und hört dann auf: darüber wird ein Werkzeug nicht leichter zu
bedienen, sondern zur Kopfdrehung, und das Auge findet die linke Kante nicht
mehr zurück. Jetzt sind es 13 % bei 1920 und 28 % bei 2560.

Alles hängt an dieser einen Utility — Kopf, Sitzungsleiste, Inhalt, Fuss —,
deshalb bleibt die Seite auf jeder Breite eine bündige Spalte. Fliesstext ist
davon unberührt, den deckelt die 34em-Regel unabhängig.

**Mehr Fläche heisst mehr Kacheln, nicht breitere.** Das Raster geht von 2
über 3 und 4 auf 5 Spalten; eine Kachel trägt eine Beschriftung und einen
Hinweis, und auf 500 px gezogen enthält sie vor allem Leere. Felder, die von
Natur aus eine Grösse haben, wachsen gar nicht mit: das Suchfeld ist bei
720 px gedeckelt, die Einstellungen des Konverters bei 860 px — sonst stand
dort ein Auswahlfeld mit dem Inhalt „Wie Quelle" in 550 px Breite.

**Die Editorbühne wächst in die Höhe, nicht in die Breite:**
`clamp(460px, 58vh, 760px)`. Auf einem 1440 px hohen Monitor war sie ein Band
in der Mitte mit 600 px leerer Seite darunter. Der Boden von 460 px hält den
Stand auf einem Laptop unverändert.

### Signature Components

**Das Randzeichen (`Mark`).** Der Zustand eines Wertes als ein Zeichen in der
Randspalte: `—` noch nicht gemessen, `●` gemessen, `!` ausserhalb der Toleranz.
Es ist vor jedem Wort lesbar, und es trägt seinen Klartext in `aria-label` und
`title` mit. Ein Satz, der dasselbe sagt, müsste erst gelesen werden.

**Die Messzeile (`Stat`).** Was gemessen wurde links, was herauskam rechts, die
Einheit in eigener Spalte, Haarlinie oben. Der Wert steht in der Wertschrift und
spielt beim Erscheinen einmal `pop` — eine Zahl, die gerade errechnet wurde,
darf einmal auffallen.

**Der Abschnittskopf (`SectionHead`).** Benennt einen Bereich, den die Leserin sonst
nicht benennen könnte — „Zielwerte", „Ergebnis", „Nächstbeste". Er *ist* die
Überschrift, keine Zeile darüber. Kein Kasten, keine Versalien; die Linie
darüber trennt.

**Die Umwandlungszeile (`Conversion`).** Zwei getönte Blöcke mit einem Pfeil
dazwischen — links, was hereinkommt, rechts in Tinte, was herauskommt. **Der
rechte Block ist das Bedienelement** (`FormatPicker`): antippen öffnet die
Formatliste, und was gewählt wird, steht sofort als grosses Wort im Block.

Zuerst lag dafür ein echtes `<select>` mit Deckkraft 0 über dem Block — das
erhielt den nativen Formatwähler, die Tastatur und die Screenreader-Ansage
geschenkt. Verworfen, weil der eine Teil eines `<select>`, den kein Stylesheet
erreicht, ausgerechnet der aufgeklappte ist, und genau den sieht man beim
Wählen an. Jetzt ist es eine ausgeschriebene Listbox, und alles, was das native
Element umsonst gab, ist absichtlich nachgebaut: `role`,
`aria-activedescendant`, Pfeiltasten, Home/End, Enter, Escape, Tippsuche, Klick
daneben schliesst, Fokus kehrt zum Block zurück. **Wer sie anfasst, fasst all
das mit an.** Die Liste trägt die eine Schattenstufe — sie ist eins der wenigen
Dinge, die wirklich über dem Blatt schweben.

Der markierte Eintrag steht auf `panel-soft`, nicht auf `panel-mid`: dort mass
sich der Hinweistext im dunklen Thema bei APCA Lc 59.3 gegen einen Boden von 60
— das dritte Mal, dass genau dieses Paar in dieser Welt durchgefallen ist. Die
Gruppentitel nehmen dafür `panel-mid`, damit beide unterscheidbar bleiben.

Oben je
das Format als grosses Wort in der Wertschrift, darunter der Dateiname, darunter
die Messwerte. Der Pfeil dreht sich auf dem Handy um 90°, wo die Blöcke stapeln.
Rechts steht erst eine Grösse, wenn wirklich eine Datei entstanden ist: eine
geschätzte Zahl wäre hier die einzige im ganzen Produkt.

Die Meta-Zeile steht in `prose`, nicht in `muted` — auf dieser Tönung mass sich
`muted` im dunklen Thema bei APCA Lc 59.3 gegen einen Boden von 60, derselbe
Fallstrick wie bei den Werkzeugkacheln. Die Trennung von der Zeile darüber
leistet stattdessen die Schrift, und das ist hier die ehrlichere: eine Grösse
und eine Dauer wurden gemessen, die Beschreibung eines Formats nicht.

**Der Vermerk (`Notice`).** Eine Anmerkung zum Befund: Abschnittslinie oben,
Randzeichen, Text. Kein farbiges Feld ringsum — die Seite annotiert, sie
umrandet die Annotation nicht.

**Die Unterklausel (`Reveal`).** Der genaue FFmpeg-Aufruf, das Analysefenster,
die zweitbeste Tonart. Haarlinie oben, `+` / `−` in der Wertschrift. Sichtbar
kostet es alle anderen für die Lebensdauer der App; gefaltet kostet es einen
Klick, einmal.

**Die Werkzeugkachel (`Tool`).** Ein getöntes Feld (`panel-mid`, im Hover
`panel-strong`), gerundet mit `card`, das Symbol neben der Beschriftung,
der Hinweis darunter. Die Tönung gibt der Kachel ihre Kante — kein Rahmen auf
vier Seiten, kein Schatten. Auf der Startseite filtern Pillen (Alle, Ton,
Video, Bilder, Für Musik) statt fünf Abschnitte untereinander. Passt ein Werkzeug nicht zur geöffneten Datei, sagt das allein die
Symbolfarbe (`faint`), und auch das erst, wenn überhaupt etwas geöffnet ist.
Das Feld ist ab der kleinsten Breite zweispaltig und wird ab `lg` dreispaltig;
einspaltig gestapelt ergaben dreissig Kacheln auf dem Handy eine Seite von
4110 px, zweispaltig sind es 2803 px und die ersten Kacheln liegen über der
Falz.
Der Hinweistext steht in `prose` statt `muted`: auf der Tönung der Kachel mass
sich `muted` im dunklen Thema bei APCA Lc 59.3 gegen einen Boden von 60.

**Der Editorrahmen (`EditorShell`).** Feldweiss mit Haarlinien-Ring: Kopfzeile
mit Dateiname und den Aktionen auf das ganze Dokument, dann Schiene · Bühne ·
Inspektor, darunter eine Statuszeile. Die Bühne bewegt sich nie und scrollt
nie; ein Werkzeugwechsel tauscht nur die Spalte rechts und spielt dort `rise`.
Der Schachbrettgrund (`stage-checks`) ist die eine Stelle, an der ein
dekoratives Muster seinen Platz verdient — er ist die einzige Art, „dieses
Pixel ist durchsichtig" von „dieses Pixel ist grau" zu unterscheiden.

### Motion

Vier Bewegungen, und keine fünfte wird erfunden. `rise` (etwas ist angekommen),
`pop` (eine Zahl wurde gerade errechnet), `press` (ein Bedienelement antwortet
dem Zeiger), `pulse-dot` (etwas läuft wirklich gerade). Dazu `sondra-drift` für
den unbestimmten Balken, wenn der Server keine Länge meldet. Drei Dauern
(`--dur-fast` 130 ms, `--dur-base` 240 ms, `--dur-slow` 420 ms) und zwei
Kurven (`--ease-out`, `--ease-settle`); alles nur Transform und Deckkraft, und
`prefers-reduced-motion` neutralisiert es vollständig.

## Do's and Don'ts

### Do:

- **Do** die Tinte für genau eine Bedeutung ausgeben: *hier können Sie etwas
  tun.* Höchstens ein Zehntel eines Bildschirms.
- **Do** mit Raum trennen, dann mit einer Tönung, dann mit einer Linie auf
  einer Seite — und einen Umriss nur für eine Fläche mit eigener Mechanik.
- **Do** jede Grösse aus den sechs Typo-Tokens nehmen und jeden Abstand aus dem
  4-px-Raster.
- **Do** Courier Prime nur dort setzen, wo die Maschine etwas eingetragen hat:
  Messwert, Dateiname, Zeitmarke.
- **Do** eine Überschrift so benennen, wie die Leserin die Sache nennt, und
  prüfen, ob das Wort ausserhalb dieses Projekts jemand sagt.
- **Do** Zustand als Zeichen in die Randspalte setzen und den Klartext über
  `aria-label` und `title` mitliefern.
- **Do** Kontraste in beiden Themen rechnen, bevor eine Palettenänderung als
  fertig gilt.
- **Do** jeden Zustand entwerfen: Fehler, leer, lädt, Fokus, deaktiviert.

### Don't:

- **Don't** eine Karte bauen. Kein weisser Kasten mit Rahmen ringsum und
  Schatten darunter — Weiss markiert ein Feld oder eine Fläche mit eigener
  Mechanik, nicht ein Objekt auf dem Papier.
- **Don't** eine Rundung von Hand setzen. Blöcke nehmen `rounded-card`,
  Bedienelemente `rounded-nav`, Pillen `rounded-pill`; eine vierte Grösse ist
  eine nicht getroffene Entscheidung.
- **Don't** einem Element auf dem Blatt einen Schatten geben. `elevate-lift`
  gehört dem, was wirklich darüber schwebt.
- **Don't** einen Abschnitt nummerieren. 1.1, 1.2.1 und ihresgleichen sind
  gefallen; sie machten eine Werkzeugliste zu einem Rechtstext.
- **Don't** Courier Prime als Kostüm für „technisch" verwenden — nicht für
  Überschriften, Beschriftungen oder Fliesstext.
- **Don't** Cormorant Garamond ausserhalb der Wortmarke einsetzen, und keinen
  Anzeigeschnitt einführen, den ein nüchternes Werkzeug nicht hätte.
- **Don't** Inter, Roboto, system-ui oder eine „sichere Alternative" (Geist,
  Space Grotesk, Poppins) als Fliesstextschrift einsetzen.
- **Don't** eine Pixelgrösse von Hand schreiben, wo ein Typo-Token existiert,
  oder einen Abstand ausserhalb des Rasters.
- **Don't** den dunklen Modus aus dem hellen invertieren, und die Bühne
  überhaupt nicht umfärben.
- **Don't** ein Symbol in ein abgerundetes Quadrat über eine Überschrift
  stapeln, eine versale Beschriftung setzen, die den Reiter darüber wiederholt,
  oder einen pulsierenden Punkt auf eine Angabe legen, die sich nie ändert.
- **Don't** Amtsdeutsch als Sachlichkeit ausgeben. „Prüfgegenstand",
  „Verfügbare Verfahren", „Prüfmittel" — alle drei standen hier einmal und
  sind gefallen. Wenn ein Wort nach Formular klingt, ist es das falsche.
- **Don't** die Startseite mit dem Zustand der leeren Sitzung eröffnen. Sie
  stand einmal als Tabelle aus drei leeren Feldern da; das Erste auf dem
  Schirm ist die nächste Handlung.
