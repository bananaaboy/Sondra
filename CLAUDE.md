# Sondra

Deutschsprachiges Medienstudio, das im Browser rechnet. Vite 7 · React 19 ·
TypeScript · Tailwind v4 · zustand. Oberflächentexte sind **Deutsch**,
Codekommentare **Englisch**.

Wer das Produkt sucht — Publikum, Hauptaufgabe, die gesetzten Einschränkungen
und die gemessenen Grenzen, die Versprechen begrenzen — findet es in
[PRODUCT.md](PRODUCT.md). Diese Datei hier hält die gestalterischen
Entscheidungen, und zwar als einzige: zwei Regeldateien driften auseinander und
ziehen spätere Arbeit in verschiedene Richtungen.

## Design

**Die gestalterischen Entscheidungen stehen in [DESIGN.md](DESIGN.md).** Eine
massgebliche Datei je Sache — Produktwahrheit in `PRODUCT.md`, visuelle Welt in
`DESIGN.md`, Betrieb hier. Zwei Kopien derselben Regel driften auseinander, und
die veraltete gewinnt dann den nächsten Edit.

Am 20.9.2026 wurde die visuelle Welt mit Impeccable **ersetzt**, nicht
aufpoliert. Nur die Farben waren gesetzt; Typografie, Aufbau, Raster und
Formensprache sind neu: ein ruhiges, flaches Blatt — keine Kästen, kein
Schatten; getrennt wird mit Linie und Luft. Am 23.9.2026 kamen auf Wunsch die
Rundungen dazu (Blöcke 16 px, Bedienelemente 10 px, Pillen), zusammen mit
einer neu aufgebauten Startseite.

Der erste Wurf nahm die Messhaltung zu wörtlich und setzte die Oberfläche in
die Sprache eines Eichscheins: „Prüfgegenstand", „Verfügbare Verfahren", eine
Klauselnummer auf jeder Überschrift, ein leeres Formular als Einstieg. Noch am
selben Tag zurückgebaut, nachdem der Nutzer es gesehen hatte. Die Lehre steht
hier, weil sie jeden weiteren Edit betrifft: **das Messen gehört in die Art,
wie Zahlen berichtet werden, nicht in die Wörter auf der Tür.**

Das Wenige, was hier stehen muss, weil es jeden Edit betrifft:

- **Keine Karten, kein Schatten auf dem Blatt — aber gerundet.** Abschnitte
  trennt eine Linie und Luft. Rundung nur über die Tokens: `rounded-card`
  (16 px) für Blöcke, Kacheln, Popover; `rounded-nav` (10 px) für Knöpfe und
  Felder; `rounded-pill` für Filter, Schalter, Punkte. „Keine Angst vor
  Radius" war die ausdrückliche Ansage. Ausnahme, ebenso gewünscht:
  Zeitflächen — Zeitleiste, Wellenformen, Klavierrolle, Editorbühne — bleiben
  eckig. Die eine Schattenstufe gehört dem, was wirklich
  über dem Blatt schwebt: Editor-Platte, Popover, Ablage-Overlay.
- **Klartext, kein Amtston.** Überschriften heissen, was sie sind —
  „Werkzeuge", nicht „Verfügbare Verfahren". Sie-Form und nüchterner Ton
  bleiben; Behördendeutsch war nie dasselbe wie Sachlichkeit.
- **Werkzeuge sind Kacheln.** Die rund vierzig Werkzeuge stehen als Kachelfeld,
  nach Gruppen geordnet und über ein Feld filterbar — ausdrücklich so
  gewünscht. Eine getönte Fläche gibt der Kachel ihre Kante, kein Rahmen und
  kein Schatten. Zweispaltig ab der kleinsten Breite; die Reiterleiste ist auf
  der Startseite unterhalb `sm` ausgeblendet, weil sie dort dasselbe doppelt
  sagt und dabei abgeschnitten wird.
- **Die Spalte wächst mit dem Schreibtisch, aber nicht endlos.** `shell` geht
  in Stufen von 1280 auf 1840 px; das Kachelraster von 2 über 3 und 4 auf 5
  Spalten. Mehr Fläche heisst mehr sichtbare Kacheln, nicht breitere — und ein
  Formularfeld oder ein Suchfeld wächst gar nicht mit. Die Editorbühne wächst
  stattdessen in die **Höhe** (`clamp(460px, 58vh, 760px)`), weil auf einem
  hohen Monitor die Leere unter ihr das eigentliche Problem war.
- **Eine Leiste, nicht drei.** Kopfzeile, Sitzungsleiste und Reiter-Kasten
  standen übereinander, dazu rechts in jedem Werkzeug eine Sitzungsspalte mit
  fünfzehn Knöpfen — „mega cluttered". Jetzt: Kopfzeile mit Dateimenü, Reiter
  als ihre zweite Zeile, die Sitzung einen Klick hinter dem Dateinamen. Keine
  ausgegrauten Knöpfe für Fälle, die gerade nicht bestehen; sie erscheinen mit
  ihrer Voraussetzung. Auf kleinen Breiten kürzt sich der Text, nicht die
  Aussage (der Download-Knopf sagt „App"). Ausblenden über einen Wrapper, nicht mit
  `hidden` auf einem `Button`: dessen eigenes `inline-flex` gewinnt.
- **Nichts steht vor der Seite.** FFmpeg lädt im Hintergrund, nie hinter einem
  Ladebildschirm. Ein Werkzeug, das wartet, zeigt das Warten bei sich. Jedes
  Werkzeug ist ein eigener Chunk (`React.lazy` in `Dashboard.tsx`) und wird
  erst beim Öffnen geholt, der Rest im Leerlauf; ein neues Panel gehört in
  `TOOLS` dort, nicht als statischer Import.
- **Die Sitzung bleibt auf dem Gerät,** auf ausdrücklichen Wunsch vom
  24.9.2026 (`lib/sessionStore.ts`, IndexedDB). Beim Start wird die letzte
  angeboten („Letzte Sitzung: Wiederherstellen / Verwerfen“), nie still
  geladen. Der Schalter „Sitzung auf diesem Gerät behalten“ im Dateimenü
  löscht beim Abschalten alles — die alte Regel „Schliessen ist die
  Löschtaste“ für geteilte Rechner. Dekodierter Ton wird nicht gespeichert.
- **Der Einstieg zeigt die nächste Handlung,** nicht den Zustand der leeren
  Sitzung. Ohne Datei steht dort, was die Seite kann und der Knopf, der sie
  startet — kein Formular mit leeren Feldern.
- **Zwei Schriften, semantisch getrennt.** Public Sans setzt die Oberfläche,
  Courier Prime das, was die Maschine eingetragen hat — Messwerte,
  Dateinamen, Timecodes. Nie Mono als Kostüm für „technisch". Cormorant lebt
  für genau ein Wort weiter: die Wortmarke ist eine bindende Zusage.
- **`panel-cool` ist für genau eine Aussage da:** hier läuft etwas nicht
  lokal. Seit dem 23.9. trägt sie nur noch die fette Warnung im Downloader
  („Achtung: Herunterladen läuft nicht lokal", Ring in Tinte). Den Lokal-Chip
  in der Kopfzeile gibt es nicht mehr — dass Sondra lokal rechnet, ist die
  Prämisse; die Ausnahme steht dort, wo sie passiert. An seinem Platz sitzt
  „App herunterladen" mit einem Auswahlfenster: zuerst „Als App aus dem
  Browser" (Edge/Chrome-Installation über `lib/install.ts` — der einzige Weg,
  den die intelligente App-Steuerung nicht blockiert, solange das Setup
  unsigniert ist), dann Microsoft Store ausgegraut mit „Bald verfügbar" bei
  Hover, dann das Setup; in der App selbst entfällt er. Die Palette hat kein Rot, und sie braucht keins. **In der App gilt die
  Prämisse der Warnung nicht:** dort startet `desktop/downloader.mjs` einen
  eigenen yt-dlp-Dienst auf 127.0.0.1:9000, und statt der Warnung steht ein
  ruhiger Block auf `panel-soft`, der den Haftungssatz wörtlich behält. Der
  Dienst hat keine eigenen Extraktoren (anders als das Brücken-Skript), holt
  yt-dlp nur nach Nachfrage und antwortet nur Sondra: der App-Seite und
  sondra.lizge.ch.
- **Der Downloader hat einen Weg für Portale: das Feld oben.** Es fragt einen
  verbundenen Dienst zuerst und übernimmt dessen Einstellungen. Wird die Seite
  lokal ausgeliefert (App, Brücke), ist der Schalter für externe Downloader von
  Anfang an an. Kein Spiegel-Hinweis, der nach einer Weile aufpoppt.
- **Was gerechnet wurde, wird als Schritt mit Werten berichtet.** Das
  Mikrofon-Werkzeug zeigt nach dem Einstellen jede Stufe (Hochpass, Brummen,
  Rauschminderung, Gate, Kompressor, Lautheit) mit den Zahlen, die sie benutzt
  hat, und vorher/nachher zum Umschalten. Ein Mikrofon wird roh geöffnet und
  beim Verlassen des Werkzeugs freigegeben.
- **Was automatisch gewählt wird, wird gesagt, nicht gefragt.** Der
  Downloader nannte den Weg automatisch und stellte daneben drei Knöpfe zur
  Handauswahl. Jetzt steht der gewählte Weg als Satz da, die Handauswahl ist
  ein Klick dahinter. Weggenommen wird dabei nichts.
- **Einstellen heisst hören.** Im Ton-Editor ist jeder Effekt ein Schalter,
  ein Regler schaltet ihn ein, und die Wiedergabe läuft durch dieselbe Kette,
  die „Übernehmen" offline rendert. Blenden stehen in der Welle selbst bzw.
  als Rampe da, bevor sie gerechnet sind. Im Zerschneiden wird ein gezogener Bereich erst
  auf Bestätigung ein Pad.
- **Zustand ist eine Marke am Rand,** kein Kasten: `Notice` annotiert mit
  `●` und `!`, statt den Hinweis einzurahmen.
- **Untertitel laufen mit Whisper im Browser** (`workers/transcribe.worker.ts`,
  transformers.js). Das Modell kommt beim ersten Gebrauch von Hugging Face und
  wird dort gesagt, wo es passiert; die ONNX-Laufzeit ist mitgebaut, nicht vom
  CDN. `onnxruntime-node` und `sharp` sind über `overrides` durch leere Pakete
  in `stubs/` ersetzt — die Browser-Fassung braucht sie nie, und ihr
  Installationsskript scheitert in Umgebungen ohne freien Download.
  Eingebrannt wird mit im Browser gezeichneten Bildern je Untertitel, nicht
  mit libass: das stürzt in diesem FFmpeg-Build ab. x264 immer mit
  `-preset medium`; `veryfast` stürzt ebenso ab.
- **Jedes Werkzeug hat eine Adresse.** `#umwandeln`, `#tonart`,
  `#spuren-trennen` — die Slugs stehen in `panelMeta.tsx`, das Routing in
  `usePanelRoute`. Der Start ist die blanke Wurzel. Ein neues Panel ohne Slug
  ist unfertig.
- **`muted` auf einer Tönung ist der Fallstrick dieser Welt.** Auf
  `panel-mid` mass er sich im dunklen Thema dreimal bei Lc 59.3, Boden ist 60.
  Auf getöntem Grund gehört Sekundärtext auf `prose` oder die Tönung auf
  `panel-soft` — aber erst messen, dann setzen.
- **Kontrast wird gemessen, nicht geschätzt.** APCA: Fliesstext ≥ Lc 75,
  sekundär ≥ 60, Überschriften ≥ 45, Nicht-Text ≥ 15. Eine Palettenänderung
  ist erst fertig, wenn sie durch die Zahlen gelaufen ist — und eine getönte
  Fläche verschiebt den Grund, auf dem gemessen wurde.
- **Keine Eyebrows.** Ausnahmslos gebannt, auch als Platzhalter. Eine
  Überschrift trägt sich selbst. Versalien gibt es nur im `Badge`.
- **Kein Bauteil ohne Fehler-, Leer-, Lade-, Fokus- und Deaktiviert-Zustand.**

Vor einer Gestaltungsänderung: `DESIGN.md` lesen. Das Skill dazu liegt unter
`.claude/skills/impeccable/`; der Richtungsvertrag mit dem Seed-Key steht in
`.impeccable/surfaces/src-app-tsx.md`.

## Betrieb

- `npm run dev` · `npm run build` · `npm run typecheck`
- Offline: `public/coi-serviceworker.js` hält nach einem Besuch alle Dateien
  aus `offline.json` (ein Vite-Plugin schreibt die Liste beim Build) und
  löscht, was frühere Fassungen im Cache liessen. WebAssembly-Kerne nur bei
  Gebrauch.
- `npm run dev:service` serviert `dist/` zusammen mit den Funktionen unter
  `api/`, was `vite preview` nicht kann — nötig, um den Downloader lokal
  durchzuspielen.
- **„Öffnen mit Sondra“**: `desktop/installer.nsh` trägt Sondra nur unter
  `OpenWithProgids` ein, nie als Standard (der Workflow prüft das). Dateien
  aus der Befehlszeile oder vom zweiten Start reicht `electron.mjs` über
  `server.mjs` (`/geoeffnet/<token>`, einmal abrufbar) an die Seite.
- `npm run build:desktop` baut die Windows-App (Electron, NSIS-Setup nach
  `release/`); vorher einmal `npm ci --prefix desktop`. Quelle in `desktop/`,
  Electron steht bewusst nur in `desktop/package.json`. `release/` wird nicht
  eingecheckt.
- **Die App aktualisiert sich selbst** (`desktop/updater.mjs`,
  electron-updater, GitHub-Releases von `bananaaboy/Sondra`). Sie liest
  `latest.yml` aus dem neuesten Release; der Desktop-Workflow lädt die Datei
  mit dem Setup hoch und bricht ab, wenn sie fehlt. Ein Release ohne
  `latest.yml` ist für installierte Apps unsichtbar. In der App sitzt an der
  Stelle von „App herunterladen" der Update-Knopf (`AppUpdate.tsx`, über
  `desktop/preload.cjs`): „Nach Updates suchen", Fortschritt beim Laden,
  „Auf x.y.z aktualisieren", wenn es bereit ist; nicht gedrängt, beim
  Schliessen wird ohnehin installiert. Scheitert es, steht „Update nicht
  möglich" sichtbar da, mit „Setup laden" daneben — nie nur im Tooltip.
  `nsis.packElevateHelper` bleibt gesetzt: nur dann steht
  `isAdminRightsRequired` in `latest.yml`, und das Update geht bei der
  Installation für alle Benutzer direkt über elevate.exe. Alles, was der
  Updater sagt, steht in `sondra.log`. Neue Version: `version`
  in `package.json` und `desktop/package.json` erhöhen, dann den Workflow mit
  „release“ starten.
- Umgebungsvariablen der Bereitstellung:
  - `SONDRA_SECRET` — signiert die Adressen, die der Proxy weiterreicht.
  - `SONDRA_PROVIDER_URL` — ein cobalt-kompatibler Anbieter. Ist einer
    hinterlegt, wird er zuerst gefragt und liefert volle Auflösung und die
    Portale, für die es hier keinen Extraktor gibt. Ohne ihn bleibt YouTube auf
    der progressiven Spur (in der Regel 360p).
  - `SONDRA_PROVIDER_KEY` — dessen `Api-Key`, falls verlangt.
- **Kein Anbieter wird fest verdrahtet.** Eine fremde Instanz im Code würde
  jede eingegebene Adresse an Dritte schicken, die niemand ausgesucht hat.
