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
  über dem Blatt schwebt: Editor-Platte, Popover, Ablage-Overlay, die
  kleinen Leisten unten und die Karte der Geräte.
- **Klartext, kein Amtston.** Überschriften heissen, was sie sind —
  „Werkzeuge", nicht „Verfügbare Verfahren". Sie-Form und nüchterner Ton
  bleiben; Behördendeutsch war nie dasselbe wie Sachlichkeit.
- **Werkzeuge sind Kacheln.** Die rund vierzig Werkzeuge stehen als Kachelfeld,
  nach Gruppen geordnet und über ein Feld filterbar — ausdrücklich so
  gewünscht. Eine getönte Fläche gibt der Kachel ihre Kante, kein Rahmen und
  kein Schatten. Zweispaltig ab der kleinsten Breite. Die Reiterleiste steht
  auch auf der Startseite, auf jeder Breite (Wunsch vom 23.10.2026: „im
  Startmenü kann man die Navbar nicht sehen“); unterhalb `sm` war sie dort
  ausgeblendet, weil sie abgeschnitten wurde — seit „Mehr“ wird nichts mehr
  abgeschnitten. **Die Startseite seit dem 28.10.2026** („sie ist sehr
  cluttered“; vorher zwei Kästen, Plakette „100 % lokal & privat“, drei
  Bildkarten und 45 gleich schwere Kacheln am Stück, 4 300 px auf dem
  Handy): ein getönter Einstieg (Überschrift, ein Satz in Sie-Form, „Datei
  auswählen“, „Von Adresse laden“; der ganze Block nimmt eine Datei an),
  „Filme und Serien“ (Merkliste mit „Weiter: …“, Abspielen, Ordner,
  Herunterladen), dann „Werkzeuge“ je Gruppe unter ihrer Überschrift, zwei
  Reihen sichtbar, der Rest hinter „Noch n Werkzeuge für …“; eine
  Gruppenpille zeigt die Gruppe ganz, die Suche alles. Kacheln auf
  `panel-soft`, Hinweis höchstens zwei Zeilen. Kein Windows-Block mehr unten
  — die Kopfzeile hat „App herunterladen“, und in der Android-App warb er
  für Windows.
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
  `hidden` auf einem `Button`: dessen eigenes `inline-flex` gewinnt. **Reiter,
  die nicht in die Zeile passen, stehen hinter „Mehr“** (`PanelTabs`,
  gemessen, der gewählte immer sichtbar) — nie abgeschnitten, nie seitlich
  zu wischen; vorher endete die Zeile auf jedem Laptop in „Miki…“.
- **Nichts steht vor der Seite.** FFmpeg lädt im Hintergrund, nie hinter einem
  Ladebildschirm. Ein Werkzeug, das wartet, zeigt das Warten bei sich. Jedes
  Werkzeug ist ein eigener Chunk (`React.lazy` in `Dashboard.tsx`) und wird
  erst beim Öffnen geholt, der Rest im Leerlauf; ein neues Panel gehört in
  `TOOLS` dort, nicht als statischer Import. **Auf einem Telefon wird nichts
  vorgeholt** (`FETCH_LIGHT` in `lib/desktop.ts`: Android, iPhone/iPad oder
  „Daten sparen“): weder der FFmpeg-Kern (32 MB WebAssembly, bei jedem Start
  der Android-App übersetzt) noch die vierzig Werkzeuge — das war der
  Hauptgrund, dass die App „mega schlecht“ lief. Player und Herunterladen
  werden erst beim ersten Öffnen eingehängt und bleiben dann (Film und
  Download laufen hinter anderen Werkzeugen weiter); vorher kosteten sie
  jeden Besuch 800 KB Skript. Die Merkliste schreibt bei jeder Änderung
  sofort ihr JSON und die SQLite-Kopie erst 1,5 s später oder beim Verlassen
  (`sondra:sqlite_db_stale` sagt dem nächsten Start, dass das JSON neuer
  ist) — ein „+1“ kostete ein Telefon sonst 150 ms.
- **Ordner** (`#ordner`, `FolderPanel.tsx`, `lib/folder.ts`, 1.1.12): die
  Dateien eines Ordners auf diesem Gerät als Kacheln (Vorschaubild aus dem
  Video bei ~15 %, Bild verkleinert beim Dekodieren, Dauer; `lib/thumbnails.ts`,
  zwei gleichzeitig, nur für Kacheln auf dem Schirm) oder als Liste; Art,
  Suche (auch in Unterordnern, ohne Akzente), Sortierung natürlich („2“ vor
  „10“), Unterordner zum Hineingehen oder alles darunter. Auswählen wie im
  Dateimanager (`clickSelect`: Klick, Strg/⌘, Umschalt; Pfeile, Leertaste,
  Strg+A, Escape), dann Abspielen (`sendToPlayer`, die Liste wird ersetzt),
  In die Sitzung, Als ZIP, In Drive, Löschen nach Rückfrage. Edge, Chrome und
  die App bekommen den Ordner selbst (File System Access): gemerkt in
  IndexedDB (`sondra-ordner`), beim nächsten Mal nur angeboten („„Anime“
  wieder öffnen“), nie still gelesen; Löschen fragt einmal nach Schreibrecht.
  **Löschen geht zuerst in einen Papierkorb von Sondra** (30.10.2026,
  `binFiles`/`restoreBinned` in `lib/folder.ts`): der Ordner `Sondra-Papierkorb`
  oben im gewählten Ordner — das Betriebssystem hat für einen Ordner, den
  der Browser freigibt, keinen —, die Dateien wandern dorthin
  (`FileSystemFileHandle.move`, wo der Browser es kann, sonst bis 256 MB
  kopiert und erst danach das Original entfernt; ein grösserer Film wird
  gemeldet und bleibt liegen). „Rückgängig“ steht gleich bei der Meldung und
  legt jede Datei in ihren Ordner zurück, ohne eine inzwischen belegte
  Datei zu überschreiben (Nummer statt dessen); „Endgültig löschen“ bleibt
  im Dialog daneben. Der Papierkorb-Ordner steht nicht in der Liste
  (`SKIPPED`) und wird nicht von Sondra geleert — das macht, wer den Ordner
  selbst leert. Firefox/Safari: `webkitdirectory`, einmal
  eingelesen, ohne Löschen — die Seite sagt das. Die Kachel bekommt den Fokus
  nur, wenn er schon in der Liste ist; vorher nahm die erste ihn beim
  Ankommen und scrollte dorthin. **Weiterschauen:** Folgen von Serien der
  Merkliste im Ordner (`folderSeries`) — gesehen markiert, die nächste (der
  Stand, sonst die nach der zuletzt gesehenen) mit dem Rest dahinter in den
  Player. **Die Merkliste spielt aus dem Ordner** (`lib/folderLibrary.ts`:
  ein Ordner für beide Seiten, `useFolder`, `folderEpisodes`, `playQueue`):
  eine Pille über der Liste („„Anime“ · 3 Serien darin“, sonst „Ordner mit
  Folgen wählen“), ▶ auf der Kachel, „Folge n abspielen“ vor „Folge n
  laden“ auf der Serie samt „Im Ordner: Staffel 1: 1–3“, im Staffel-Fenster
  ein Strich unter jeder Folge, die daliegt, und „Aus dem Ordner abspielen“.
  Der gemerkte Ordner wird beim Öffnen der Merkliste nur dann von selbst
  gelesen, wenn der Browser die Erlaubnis noch hält (nur Namen, Grössen,
  Daten), sonst steht er als Pille zum Klicken da. Der Serienname auf der
  Ordner-Karte öffnet die Serie in der Merkliste. **Doppelte finden** (`lib/duplicates.ts`): nur gleich grosse Dateien
  werden gelesen, bis 32 MB ganz (SHA-256), darüber an 32 Stellen; behalten
  wird die ohne „(1)“/„Kopie“, sonst die älteste. `npm run verify:folder`.
- **Dateien der Sitzung lassen sich umbenennen** (1.1.11): Stift im
  Dateimenü oder Doppelklick auf den Namen; die Endung bleibt neben dem
  Feld stehen, was Windows ablehnt (`\ / : * ? " < > |`, CON …), wird
  gesagt statt still ersetzt (`renamedFile` in `lib/format.ts`). Die
  behaltene Sitzung schreibt dafür nur den Datensatz um die gespeicherte
  Datei neu — vorher gingen ein neuer Name und eine neue Reihenfolge bei
  einem Neustart verloren, weil nur geänderte Bytes geschrieben wurden.
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
  lokal. Seit dem 23.9. trägt sie die fette Warnung im Downloader
  („Achtung: Herunterladen läuft nicht lokal", Ring in Tinte), seit dem
  22.10. dazu den einen Satz im Fenster „Google Drive“ („Was Sie in Drive
  speichern, verlässt dieses Gerät …“), seit dem 28.10. den Satz zum Weg über
  Drive unter „Geräte“ — dieselbe Aussage, sonst nichts. Den Lokal-Chip
  in der Kopfzeile gibt es nicht mehr — dass Sondra lokal rechnet, ist die
  Prämisse; die Ausnahme steht dort, wo sie passiert. An seinem Platz sitzt
  „App herunterladen" mit dem Fenster „Sondra als App“ (bis 860 px; neu
  am 28.10.2026, „app herunterladen teil ist auch nicht gut designed“ —
  vorher sechs Kacheln in vier Grössen unter einer 76-px-Wortmarke, Android
  als Fussnotenzeile): zwei Reiter, **Windows** und **Android**, der des
  Geräts in der Hand zuerst (`ON_ANDROID`). Je Reiter ein Weg in Tinte
  (`MainWay`: Setup bzw. APK, Fakten in Courier) und daneben der
  zweitbeste auf `panel-soft` — der Microsoft Store bzw. „So installieren
  Sie sie“ in drei, vier Schritten. Darunter bei Windows die übrigen Wege
  als Zeilen zwischen Linien (`OtherWay`): „Website als App“
  (Edge/Chrome-Installation über `lib/install.ts`, der einzige Weg, den die
  intelligente App-Steuerung nicht blockiert, solange das Setup unsigniert
  ist), „Portabel“ (die .exe ohne Installation) und das Setup für den
  anderen Prozessor. Die Store-Kachel ist ein Link auf den Eintrag
  (`MICROSOFT_STORE` in `lib/desktop.ts`, Store-ID 9P0JXR5GNSMG, live seit
  1.10.2026); ohne ihn trüge sie „Bald verfügbar" sichtbar auf der Fläche. In der App selbst entfällt der Knopf. Die Palette hat kein Rot, und sie braucht keins. **In der App gilt die
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
- **Ton und Zerschneiden sind Studios.** Ton im Editorrahmen
  (`EditorShell`, acht Werkzeuge in der Schiene, je eines im Inspektor) auf
  der Tonbühne (`editor/SoundStage.tsx`: Stage-Schwarz, Zeitlineal,
  Transport darunter, Leertaste spielt). Zerschneiden in zwei Rahmen:
  Schneiden (sechs Verfahren in `lib/chop.ts`, der Plan steht vorher auf
  der Welle, ein gezogener Bereich lässt sich allein schneiden) über Bühne
  und Transport; darunter Pads und Pattern als ein Rack — jede Zeile beginnt
  mit dem Pad — mit Reiter-Spalte. Keine gestapelten Karten mehr — „mega
  cluttered" war der Befund.
- **Der Downloader zeigt alle Wege offen** („Weitere Wege", drei Kacheln),
  und die Brücken-Anleitung fragt, ob Node.js (bei cobalt auch Git) schon da
  ist. Nach `winget install` liest PowerShell den PATH neu ein, sonst kennt
  dasselbe Fenster `node` nicht.
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
  ist unfertig. Ein `popstate`, das beim selben Werkzeug bleibt (zurück von
  einer Serie zur Merkliste), setzt keine Marke „kommt aus der Adresse“ —
  sonst schrieb der nächste Reiterklick die Adresse nicht, und Neuladen
  öffnete das falsche Werkzeug. Und wer die Marke setzt, findet die Adresse
  meist schon richtig vor: dann wird sie dort auch gelöscht, sonst blieb
  nach einer eingetippten Adresse oder einem Link der nächste Wechsel —
  etwa „Folge abspielen“ aus der Merkliste — ohne Adresse.
- **`muted` auf einer Tönung ist der Fallstrick dieser Welt.** Auf
  `panel-mid` mass er sich im dunklen Thema dreimal bei Lc 59.3, Boden ist 60.
  Auf getöntem Grund gehört Sekundärtext auf `prose` oder die Tönung auf
  `panel-soft` — aber erst messen, dann setzen.
- **Kontrast wird gemessen, nicht geschätzt.** APCA: Fliesstext ≥ Lc 75,
  sekundär ≥ 60, Überschriften ≥ 45, Nicht-Text ≥ 15. Eine Palettenänderung
  ist erst fertig, wenn sie durch die Zahlen gelaufen ist — und eine getönte
  Fläche verschiebt den Grund, auf dem gemessen wurde.
- **Bewegung sagt, woher etwas kommt** (29.10.2026: „es hat überall viel zu
  wenig Animationen“). Der Strich unter den Reitern gleitet, ein Werkzeug
  kommt von der Seite seines Reiters, Listen kommen gestaffelt
  (`rise-list`), Menüs klappen aus ihrem Knopf (`drop`), Leisten kommen vom
  unteren Rand (`dock`), Blätter fahren auf dem Handy hoch (`sheet`),
  Dialoge haben Ein- und Ausgang (global auf `dialog`, keine eigene
  Animation daneben), hell/dunkel blendet über. Eintritte füllen
  `backwards`. Liste und Gründe: DESIGN.md, „Motion“.
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
- **Browser-Szenarien** (`npm run build && npm run verify:e2e`, `scripts/e2e/`,
  Workflow „Browser“): zwei Geräte, die sich Dateien schicken (direkt, über
  Drive, Ablehnen, Fälschungen, Neuinstallation, Text und Links, Abspielen
  auf dem anderen Gerät, Ordner in beide Richtungen, drei Übertragungen auf
  einmal, Fortsetzen nach einer gekappten Leitung), der Ordner „Sondra“ in
  Drive samt Löschen, die Bewegung (Reiterstrich, Dialoge, Menüs, ruhige
  Bewegung) und „Beim Minimieren pausieren“. Drive läuft als Nachbildung im Prozess des Tests
  (`scripts/e2e/lib.mjs`), `run.mjs` startet `dev-service` selbst. Jedes
  Szenario ist ein eigener Prozess; neue Funktionen bekommen dort ihr
  Szenario, nicht nur eine Prüfung unter Node.
- `npm run dev:service` serviert `dist/` zusammen mit den Funktionen unter
  `api/`, was `vite preview` nicht kann — nötig, um den Downloader lokal
  durchzuspielen.
- **„Öffnen mit Sondra“**: `desktop/installer.nsh` trägt Sondra nur unter
  `OpenWithProgids` ein, nie als Standard (der Workflow prüft das). Dateien
  aus der Befehlszeile oder vom zweiten Start reicht `electron.mjs` über
  `server.mjs` (`/geoeffnet/<token>`, einmal abrufbar) an die Seite.
- **Microsoft Store als MSIX** (`npm run build:desktop -- --store`, im
  Workflow bei jedem Lauf: gebaut, mit Wegwerf-Zertifikat installiert,
  gestartet, Artefakt „Sondra-Store-MSIX“). Das unsignierte Setup lehnt der
  Store ab (Richtlinie 10.2.9), das MSIX signiert er selbst. Die Identität aus
  Partner Center steht in den Repository-Variablen `STORE_IDENTITY_NAME`,
  `STORE_PUBLISHER`, `STORE_PUBLISHER_NAME` (als Variable oder Secret; und `STORE_DISPLAY_NAME`, sonst
  „Sondra Studio“); ohne sie entstehen Testwerte. In der Store-Fassung
  (`process.windowsStore`) sind der eigene Updater und das Nachladen von
  yt-dlp aus: der Store aktualisiert selbst und erlaubt kein nachgeladenes
  Programm (10.2.2). yt-dlp wird dort nur benutzt, wenn es schon da ist
  (`winget install yt-dlp.yt-dlp`), und die Fehlermeldung sagt genau das.
  Kacheln macht `scripts/store-tiles.mjs` aus `icon-512.png`.
- **Video-Editor: grosse Dateien und fremde Formate.** Eine gewählte Datei
  bleibt als `asset.source` (der File) an der Sitzung; die Vorschau spielt
  direkt von dort, und FFmpeg liest sie über WORKERFS
  (`runFfmpegOnDisk`, `probeDisk`), statt sie erst in den Speicher zu
  kopieren. Spielt der Browser die Datei nicht (AVI, MPEG-4, H.265 in
  Firefox) oder ohne Ton (AC-3/DTS im MKV), macht `lib/playable.ts` eine
  Vorschau: umpacken, nur den Ton wandeln, oder klein neu rechnen — so wenig
  wie nötig, mit Fortschritt auf der Bühne und „Ohne Vorschau weiter".
  Geschnitten wird immer das Original. **libopus stürzt in Stereo ab
  Komplexität 5 ab** (gemessen am 14.10.2026, auch unter Node; der Tab
  stirbt) — bis 4 läuft es bei jeder Bitrate. Jede Opus-Kodierung geht
  deshalb über `opusArgs` in `lib/convert.ts` (`-compression_level 4`).
  **VP9 kommt in diesem Build nie an** (einfädig Absturz, mehrfädig Hänger);
  WebM ist VP8 (`vp8Args`). Für Vorschauen weiter Vorbis oder AAC.
- **Umwandeln muss eine Datei liefern** (`lib/convertRun.ts`): gewählte
  Dateien liest FFmpeg über WORKERFS statt sie zu kopieren; stürzt der
  mehrfädige Kern ab oder schweigt er 90 s, folgt ein zweiter Versuch auf dem
  einfädigen (`loadFfmpeg({ singleThread: true })`, `FfmpegCrash`). Was
  dann noch scheitert, steht als Satz da, FFmpegs Zeilen einen Klick
  dahinter. `npm run verify:convert` schickt jedes Format mit den üblichen
  Einstellungen durch den echten Kern, jeden Lauf in eigenem Prozess — ein
  Absturz dort beendet den Prozess wie sonst den Tab. **Vorlagen**
  (`lib/convertPresets.ts`, 21.10.2026): „Für WhatsApp“, „Instagram Reel“,
  „Hörbuch“, „Klein für E-Mail“ als Pillen unter dem Format, je mit dem, was
  sie für ein Video und — wo sinnvoll — für einen Ton bedeuten; eigene
  Vorlagen sind die Einstellungen unter einem Namen im `localStorage`
  (`sondra:umwandeln:vorlagen`). Reel braucht `videoFrame: 'vertical'`
  (1080 × 1920, eingepasst mit Rändern, nie beschnitten). Die Bildrate steht
  deshalb für jedes Videoformat da, nicht nur für GIF. `verify:convert`
  schickt jede Vorlage durch den echten Kern.
- **Abspielen** (`PlayerPanel.tsx`, `lib/player.ts`): der Media Player,
  nur zum Ansehen und Anhören. Dateien werden nie in die Sitzung gelesen,
  sondern über eine Object-URL auf dem File abgespielt; solange das Werkzeug
  offen ist, gehören fallengelassene Dateien ihm (`claimDrops`, in
  `useGlobalIngest`). Eine .srt/.vtt mit gleichem Namen wird Untertitel.
  Fremde Formate über dieselbe Vorschau wie im Video-Editor (`playable.ts`),
  hier bis 720p; neu rechnen nur auf Klick, weil es so lange dauert wie der
  Film. „Weiter bei“ und Lautstärke bleiben im `localStorage` dieses Geräts.
  Seit dem 2.10.2026 ein Player wie die bekannten: Steuerung über dem Bild
  auf einem Verlauf, blendet sich beim Abspielen aus; alles Einstellbare
  hinter dem Zahnrad (`player/SettingsMenu.tsx`): Qualität (kleinere Fassung
  per FFmpeg, der Film läuft weiter), Tempo, Untertitel samt Grösse und
  Hintergrund, Tonspur, Bild (Einpassen/Füllen, Helligkeit, Kontrast,
  Sättigung, Spiegeln), Ton (Verstärkung bis 300 %, Nachtmodus über Web
  Audio), Wiedergabe (weiter, wiederholen, Sprungweite). Vier Grössen: neben
  der Liste, Kinomodus (T), fensterfüllend (W, Esc) und Vollbild (F). Der
  Rahmen ist gerundet — ein Ort zum Ansehen, keine Messfläche —, die eine
  Farbe darauf ist `stage-accent`. Fensterfüllend braucht `:root.player-fill`,
  sonst hält die Einblende-Animation des Panels das `fixed` gefangen.
  **Der Player hängt nicht im Panel mit `key`** (`Dashboard.tsx`): der
  `key={panel}`, der die Einblendung neu startet, baute ihn bei jedem
  Werkzeugwechsel ab — der Film stand still, und die kleine Leiste „läuft
  weiter“ erschien nie. Der Visualizer gehört der Musik (nur dann läuft der
  Ton durch Web Audio dafür), das Menü fällt unter den Rahmen, wenn der
  niedriger als 400 px ist. WAV (PCM 8/16/24 bit, 32 bit Float) spielt der
  Browser selbst — `browserPlaysAudio` kannte PCM nicht, und jede WAV ging
  erst durch FFmpeg.
  **Vorspann überspringen** (1.1.10): über einer Folge (Video, ab 4 Min.) in
  den ersten sechs Minuten — einem Drittel einer kurzen — ein Knopf, der um
  die Länge des Vorspanns springt (S); im Abspann, den letzten 2:30 oder
  einem Achtel, „Nächste Folge“ (N). Die Regeln stehen als reine Funktionen
  in `lib/player.ts` (`openingOffered`, `nextOffered`). Die Länge gehört der
  Serie auf der Merkliste (`opening`, reist mit nach Anytype), sonst
  `settings.opening`, 1:30. **Schlaf-Timer**: 15, 30, 60 Minuten oder Ende
  des Titels, nicht gespeichert; die letzten zehn Sekunden wird es leiser
  (`sleepFade`), dann angehalten und die eingestellte Lautstärke zurück.
  „Ende des Titels“ hält an, statt „Automatisch weiter“ zu folgen.
  **Vorspann am Ton** (1.1.11, `lib/introPrint.ts`, `lib/introDetect.ts`,
  `workers/intro.worker.ts`): zwei Folgen einer Serie der Merkliste werden
  verglichen — die ersten acht Minuten per FFmpeg (WORKERFS) als 8 kHz mono,
  daraus ein Fingerabdruck nach Haitsma/Kalker (10 Frames/s, 33 Bänder
  300–2000 Hz, Fenster 2048 — mit 1024 stimmten versetzte Folgen nur zu
  gut der Hälfte überein), und das längste Stück, das beide teilen, ist der
  Vorspann. Gereiht nach übereinstimmenden Frames, nicht nach Länge; leise
  Frames zählen nie (zwei Folgen, die mit Stille beginnen, teilen keinen
  Vorspann); die Enden werden nachgeschnitten, bis drei Sekunden und dann
  eine Sekunde daneben dicht übereinstimmen — sonst hing Musik, die danach
  unter anderem Dialog wiederkommt, eine Sekunde dran. Bis zu vier Abdrücke
  je Serie (`intros`, eine neue Staffel bringt oft einen neuen Vorspann),
  reisen mit der Merkliste. In jeder Folge wird der Vorspann im Hintergrund
  gesucht und je Datei behalten (`sondra:abspielen:vorspann`); dann steht
  „Vorspann überspringen“ genau während er läuft und springt an sein Ende,
  auch nach einem Cold Open. Solange gesucht wird, kein Knopf; nicht
  gefunden: die feste Länge wie bisher. Zahnrad → Vorspann.
  **Lesezeichen** (1.1.11): B setzt eins, Umschalt + ←/→ springen,
  Striche auf der Zeitleiste, Liste im Zahnrad mit Namen und „Als Kapitel
  kopieren“ (YouTube-Format, beginnt bei 0:00). Je Datei nach Name und
  Grösse in `sondra:abspielen:marken`, wie „Weiter bei“.
- **Beim Minimieren pausieren** (30.10.2026, Wunsch: „beim minimieren vom
  fenster alles was am abspielen ist zu pausieren“; `lib/pauseOnMinimize.ts`):
  aus, bis der Schalter unter Zahnrad → Wiedergabe an ist (gemerkt in
  `sondra:pausieren-beim-minimieren`). Hält an, was in Sondra spielt —
  Player, Ton-Editor, Sampler, Sequenzer, Vorschauen — und fängt beim
  Zurückkommen nicht von selbst wieder an. Medienelemente findet nur
  `play()` selbst (`new Audio()` der Wellenform steht in keinem DOM), also
  wird es einmal umhüllt; was über Web Audio spielt, meldet sich mit
  `registerPauser`. Ein Film im Bild-in-Bild bleibt. Die Windows-App sagt
  Minimieren selbst (`onWindowState`, 1.1.23); sonst, im Browser und in der
  Android-App, gilt die verborgene Seite — also auch der Wechsel zu einem
  anderen Tab, und der Schalter sagt das.
- **Bildschirm aufnehmen** (`lib/screenRecord.ts`): Im Browser fragt der
  Browser. Electron hat keinen eigenen Dialog — die Seite holt die Quellen
  über das Preload (`captureSources`, `desktopCapturer`), der Nutzer wählt,
  `pickCaptureSource` merkt sich die Wahl, und der
  `setDisplayMediaRequestHandler` in `electron.mjs` gibt genau diese Quelle
  heraus; ohne Wahl lehnt er ab. Ton des Rechners ist Loopback (ganzer
  Rechner). MediaRecorder-WebM wird mit FFmpeg per Stream-Kopie nachgearbeitet,
  sonst fehlen Dauer und Index.
- **Portabel** (`Sondra-Portable[-arm64]-<Version>.exe`, im Release auch als
  `Sondra-Portable.exe`): electron-builders Ziel „portable“, gebaut aus
  demselben entpackten App-Ordner wie das Setup (`--prepackaged`), nicht ein
  zweites Mal gepackt. Der Starter entpackt bei jedem Start in einen
  temporären Ordner und sagt über `PORTABLE_EXECUTABLE_DIR`, wo die .exe
  liegt. Die Daten liegen in `Sondra-Daten` daneben (`app.setPath` vor dem
  Single-Instance-Lock; nicht schreibbar → `%APPDATA%\Sondra Portabel`),
  der Port ist 47198 statt 47199 — sonst nähme sie neben der installierten
  App einen zufälligen und damit bei jedem Start eine leere Merkliste. Keine
  Registrierung (`registerSondraProjectIcon` aus). Sie ersetzt sich nicht
  selbst: der Updater liest nur `latest.yml` und bietet die neue Datei an
  (`available`, `download`). `latest.yml` nennt weiter nur das Setup; das
  Build-Skript stellt sie wieder her, falls der Portable-Lauf sie anfasst.
  Der Workflow startet sie zweimal aus einem eigenen Ordner und prüft
  Datenordner und Port.
- **Arm64**: `npm run build:desktop -- --arm64` (und `--store --arm64`). Der
  Workflow baut x64 auf `windows-latest` und arm64 auf `windows-11-arm`, beide
  mit denselben Prüfungen; der Release-Job legt beide Setups ins Release und
  führt die `latest.yml` zusammen (`scripts/merge-update-info.mjs`, x64
  zuerst — electron-updater nimmt die Datei mit der eigenen Architektur im
  Namen, sonst die erste).
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
  in `package.json` und `desktop/package.json` erhöhen, **oben in
  `src/changelog.json` einen Eintrag anlegen**, dann den Workflow mit
  „release“ starten.
- **Was ist neu** (`src/changelog.json`, `WhatsNew.tsx`, 28.10.2026,
  Wunsch: „auf allen Plattformen einen Release-Log, wo steht, was in jeder
  Version dazugekommen ist“): eine Liste für Website, beide Apps und die
  GitHub-Release-Notizen — für Menschen geschrieben, nicht als Commit-Log.
  Geöffnet über die Versionsmarke neben dem Namen und die Fusszeile; nach
  einem Update einmal eine Zeile unter der Kopfzeile („Neu in 1.1.20 …“,
  `sondra:gesehene-version`), ein erster Besuch bekommt sie nicht.
  `verify:changelog` (in `verify`) bricht ab, wenn die Version aus
  `package.json` nicht oben steht; der Release-Schritt setzt den Eintrag
  als „Neu in x“ vor die Notizen (in PowerShell gelesen — Nodes Ausgabe
  verbog die Codepage die Umlaute).
- Umgebungsvariablen der Bereitstellung:
  - `SONDRA_SECRET` — signiert die Adressen, die der Proxy weiterreicht.
  - `SONDRA_PROVIDER_URL` — ein cobalt-kompatibler Anbieter. Ist einer
    hinterlegt, wird er zuerst gefragt und liefert volle Auflösung und die
    Portale, für die es hier keinen Extraktor gibt. Ohne ihn bleibt YouTube auf
    der progressiven Spur (in der Regel 360p).
  - `SONDRA_PROVIDER_KEY` — dessen `Api-Key`, falls verlangt.
  - `VITE_GOOGLE_CLIENT_ID` — der OAuth-Client „Webanwendung“ für Google
    Drive, beim Build gelesen. Ohne ihn bietet die Website Drive nicht an.
  - `GOOGLE_CLIENT_SECRET` — dessen Secret, **nur für `api/google-token.js`**.
    Damit bleibt die Anmeldung auf der Website; ohne es gilt sie eine Stunde.
    Rotieren: bei Google ein zweites Secret anlegen, hier eintragen, neu
    bereitstellen, das alte löschen — niemand muss sich neu anmelden.
  - **Kein Server-Secret gelangt in die Seite.** Was der Browser-Code hält,
    steht im JavaScript jedes Besuchers, „Secret“ in Vercel hin oder her: so
    lag das Google-Secret am 22.10.2026 offen im Bundle (`define` und
    `envPrefix: ['VITE_', 'GOOGLE_', 'VERCEL_']`). Der Build bricht jetzt ab,
    wenn eines dieser Secrets in einer Datei stünde (`noServerSecrets` in
    `vite.config.ts`).
- **Hintergrund-Downloads & Floating Minibar (1.1.19):** In `Dashboard.tsx`
  wird `DownloaderPanel` mit `hidden={panel !== 'downloader'}` dauerhaft im
  DOM gehalten — aktive Downloads brechen bei einem Wechsel in andere Werkzeuge
  (Player, Editor, Merkliste) nicht mehr ab. Sobald ein Download läuft und ein
  anderes Werkzeug aktiv ist, erscheint unten rechts eine schwebende Minibar
  mit Live-Fortschrittsbalken, Download-Rate (MB/s), verbleibender Zeit,
  Titel sowie Pause- und Abbruchknöpfen. Ein Klick fokussiert den Downloader.
- **Screen Wake-Lock & Power Save Blocker (`lib/backgroundDownload.ts`, 1.1.19):**
  Hält Bildschirm und Betriebssystem während aktiver Downloads oder Wiedergabe
  wach (Screen Wake Lock API im Browser, `powerSaveBlocker` in Electron).
  Bei Verbindungsabbrüchen greift ein automatisches Auto-Resume.
- **Fertigstellungs-Gong (`lib/backgroundDownload.ts`, 1.1.19):** Bei
  abgeschlossenem Download erklingt ein dezenter zweistimmiger Sinusklang
  (659,25 Hz & 880 Hz) über die Web Audio API.
- **Zero-RAM Direct-to-Disk (1.1.18):** In der Desktop-App schreibt
  `desktop/downloader.mjs` bzw. `/api/direct-save` Datenströme via Node
  `fs.createWriteStream` direkt in den Serien-Zielordner der Festplatte,
  ohne Zwischenspeicherung im Browser-Heap (0 MB zusätzlicher RAM-Verbrauch).
- **Herunterladen: Erkennen, Zusammensetzen, Laden** (16.10.2026). Adressen
  liest `extractAddresses` (`lib/download.ts`) aus jedem Text — Komma,
  Semikolon, Zeilen, Anführungszeichen, Punkt am Satzende; ins einzeilige
  Feld kommen sie mit „, " getrennt. HLS (`.m3u8`, auch als `audio/mpegurl`)
  geht durch `/api/stream`: der Dienst schreibt die Playlist um, jede
  Adresse darin bekommt ein eigenes Token, und die Seite setzt die Segmente
  (samt getrennter Tonspur, samt `EXT-X-BYTERANGE`) mit FFmpeg per
  Stream-Kopie zu einer MP4 zusammen (`downloadHls` in `lib/studio.ts`);
  verschlüsselte Streams bleiben abgelehnt. Einträge einer Liste haben eine
  feste `id`, nicht ihre Position — eine Playlist, die sich auffaltet,
  verschob sonst alle Zeilen danach. `boundedFetch` prüft Zertifikate
  immer; hinter einem Schul- oder Firmenproxy hilft der Zertifikatspeicher
  des Systems (`tls.getCACertificates('system')`), nie `rejectUnauthorized:
  false`. `npm run verify:download` prüft das ohne Netz.
- **Abspielen hakt in der Merkliste ab** (`lib/episodeMatch.ts`,
  `player/MerklisteTick.tsx`): aus dem Dateinamen Serie, Staffel und Folge
  („S01E13“, „1x13“, „Titel - 13“, „Staffel 1 Folge 13“), der längste
  passende Titel der Liste gewinnt; ohne Staffel im Namen die eine Staffel,
  die, bei der der Eintrag steht, oder durchgezählt. Ab 90 % wird genau diese
  Folge abgehakt (`seenEpisode`, nie andere, nie wieder ab), der Stand rückt
  über `settle`; unter dem Bild steht es mit „Rückgängig“, abschaltbar im
  Zahnrad („In der Merkliste abhaken“). **Abgehakt wird nur, was in derselben
  Datei unter 90 % lief** (`armed` in `MerklisteTick`): beim Wechsel zur
  nächsten Datei kommt der Name einen Render vor der zurückgesetzten Uhr an,
  und mit „Automatisch weiter“ war jede Folge abgehakt, sobald sie begann.
  Eine Serie von aussen öffnen: `requestOpenSeries` + Reiter wechseln.
- **Neue Folgen melden** (nur in der App, `lib/newEpisodes.ts`): eine Minute
  nach dem Start, dann alle drei Stunden, jede Serie „Am Schauen“ mit
  AniWorld-Adresse nacheinander über das eigene `/api/resolve`. Gemeldet wird
  über eine Windows-Benachrichtigung nur, was seit der letzten Prüfung
  dazukam — die erste merkt sich nur den Stand —, jede Folge einmal; ein
  Klick holt das Fenster nach vorn (`sondra:focus`) und öffnet die Serie.
  **Eine Online-Prüfung ist keine Änderung:** `checkOnlineUpdates` setzt
  `updatedAt` nicht mehr, sonst gewann die ältere Fassung dieses Rechners
  beim Abgleich mit Anytype über Folgen, die anderswo abgehakt wurden.
  **`/api/resolve` liest Optionen aus dem geparsten `body`,** nie aus
  `request.body?.…`: der Server der App (und `dev:service`) reicht den Körper
  als Text weiter, Vercel als Objekt. So lief in der App die Prüfung nie,
  und Sprache und Netzwerkadapter fehlten beim Auflösen. Eine Prüfung löst
  nie eine Folge auf; geht sie nicht, heisst die Antwort `status: 'unknown'`,
  und „Online prüfen“ sagt es in einem Satz. AniWorld steht hinter
  DDoS-Guard und lässt Rechenzentren nicht durch — geprüft wird gegen
  nachgebaute Seiten (`verify:extractors`, `verify:resolve`). Gezählt werden
  nur Links auf die eigene Serie (`/stream/<slug>/staffel-n`); jeder
  Staffel-Link und `data-season-id` machten die „Staffel 21“ einer fremden
  Serie zur neuesten. **Neu ist, was die Liste nicht kennt** (`onlineNews`):
  eine fehlende Staffel oder Folgen über die bekannte Zahl hinaus — im
  Rückstand sein ist nichts Neues. „Auf die Merkliste nehmen“
  (`takeOnlineNews`) ergänzt Staffel oder Zahl, bei geteilten Staffeln den
  letzten Teil, und lässt den Stand über `settle` auf der ersten ungesehenen
  Folge; vorher sprang „Zur neuen Folge springen“ über Ungesehenes hinweg.
- **Discord** (nur in der App, aus bis zum Schalter in der Merkliste,
  `desktop/discord.mjs`): spricht Discords lokale Pipe direkt. Gesendet wird
  erst nach `READY` und dann einmal je Änderung — vorher löste jede Antwort
  Discords einen neuen Rahmen aus, rund 50 000 je Sekunde. Rahmen, die die
  Pipe in Stücken liefert, werden gesammelt, bis sie ganz sind. Ausschalten
  schliesst die Pipe; Discord nimmt den Status dann selbst weg. `npm run
  verify:discord` spielt das gegen eine nachgebaute Pipe durch.
- **Merkliste** (`#merkliste`, `MerklistePanel.tsx`, Daten in
  `lib/merkliste.ts`): ein Speicher für den Tab und „Merken“ im
  Herunterladen (`useMerkliste`, `localStorage` `sondra:saved_links`,
  Projektdatei unter `merkliste`). „Folge n laden“ legt den Eintrag mit
  `requestLookup` ab und wechselt den Tab; das Herunterladen nimmt ihn beim
  Öffnen (`takePendingLookup`). Covers aus Dateien werden als JPEG
  verkleinert, weil sie im `localStorage` liegen.
  **Gezählt wird nie über das Ende hinaus:** gesehene Folgen jenseits der
  bekannten Anzahl fallen weg (`cleanWatched`), und jede Änderung am
  Gesehenen setzt den Stand über `settle` auf die erste ungesehene Folge —
  ab der Staffel, dann die folgenden, dann Lücken davor; ist alles gesehen,
  wird der Eintrag „Fertig“. Vorher ging der Stand einfach eins weiter, und
  „Alle gesehen“ liess eine Staffel mit 39 Folgen auf „Folge 40“ stehen
  („40/39“). **Teile** (`MerkSeason.parts`) sind Abschnitte einer Staffel,
  keine eigenen Staffeln: die Folgen zählen durch, `episodes` der Staffel
  ist die Summe der Teile (`withParts`), Gesehenes und Stand bleiben an der
  Staffel; `partsOf`/`partProgress` leiten je Teil Bereich und Fortschritt
  ab. Ein offener Teil ohne Gesehenes wird beim Auflösen einfach
  weggenommen. Kacheln sind 2:3 (Filmposter) oder je Serie 5:7 (Manga,
  `tileFormat`, `TILE_FORMATS`); Vorschau und Staffel-Fenster folgen dem
  Format, der Ausschnitt bleibt gültig. Der Ausschnitt eines Covers liegt
  als `coverFrame` (x, y in %, Zoom 1–3) neben jedem Cover — an der Serie,
  der Staffel und dem Teil — und wird von `CoverImage` überall gleich
  gezeichnet (der Editor dafür, `FrameEditor`, ist ein `block`: als
  Inline-Span in einem Wrapper mass er 0 × 0, und kein Bild liess sich
  ziehen): auf einen Canvas in Gerätepixeln (ResizeObserver mit
  `device-pixel-content-box`; weicht der Wert von CSS × `devicePixelRatio`
  ab, gilt das Produkt), aus einer Pyramide von Halbierungen (`halve`), nie
  als `<img>`, das der Browser in einem Schritt verkleinert — das sah
  überschärft aus. Covers aus Dateien: längere Seite 720 px, ebenso in
  Halbschritten, als WebP 0.9 (sonst JPEG 0.92).
  Statistik und ihr Bild in den Grüntönen der Palette (`ink`, `faint`,
  `rule`): Tailwinds Amber und Slate lagen im dunklen Thema bei Lc 0 bis 17,
  „Fertig“ war unsichtbar. Felder in den Fenstern stehen in `Group`, einer
  benannten Gruppe — die Beschriftung allein nannte für Screenreader nichts.
  Export als `Sondra-Merkliste-<Datum>.json`
  (`exportMerkliste`), Einlesen führt zusammen (`mergeMerkliste`: dieselbe
  Serie per `id` oder Name, die zuletzt geänderte Seite gewinnt) und lässt
  sich zurücknehmen.
  **„Bis wohin?“** (25.10.2026, Wunsch: „wie viel man schauen muss, um an
  einen selbst gewählten Punkt zu kommen“; `lib/watchPlan.ts`,
  `WatchPlanner.tsx`): auf der Seite einer Serie, ab `xl` rechts neben
  Kopf und Staffeln (eigene Spalte — als Rasterzeile gestreckt, schob
  „Genauer rechnen“ die Staffeln nach unten), darunter sonst. Ziel ist
  Staffel + Folge oder „Ende Staffel n“ / „Ganze Serie“; gezählt wird ab
  dem Stand, Gesehenes nicht (Lücken davor auch nicht), mit den Längen der
  Serie samt Ausnahmen, Filme nach den Staffeln. Eine Staffel ohne
  Folgenzahl auf dem Weg wird genannt („mind.“), nie geraten. Darunter die
  Rechnung in Worten („21 Folgen à 24 Min., ohne Vorspann (1:30) — statt
  …“), dann „Bei [2] [am Tag | pro Woche] → Tag“ (heute zählt als erster
  Tag) und „Bis zum [Datum] → so viel am Tag“. Das eigene Tempo kommt aus
  dem Verlauf (`recentPace`: vier Wochen, mindestens eine Woche geteilt,
  damit ein Abend keine Gewohnheit wird) und ist die Vorgabe. „Genauer
  rechnen“: von vorn, Vorspann überspringen (am Ton erkannt, an der Serie
  oder wie im Player), Tempo 1–2× (Vorgabe aus dem Player). Tempo und
  Optionen bleiben im `localStorage` (`sondra:merkliste:rechner`). **Ziel
  merken** legt `goal` an die Serie (`{season, episode, by?, setAt,
  count}`, reist mit der Liste): die Serie sagt dann „Ziel: … — noch 6
  Folgen, 2 am Tag reichen · 1 vor dem Plan“ (gegen ein gleichmässiges
  Tempo seit dem Setzen), das Poster „Ziel · noch 6“. Die alte Zeile
  „1/Tag: fertig … · 2/Tag: …“ ist darin aufgegangen.
  **Stände** sind fünf: Am Schauen, Später, Pausiert, Fertig, Abgebrochen
  (Filterpillen nur für Stände mit Einträgen). Etwas neu Gesehenes nimmt
  eine pausierte oder abgebrochene Serie wieder auf (`settle` vergleicht
  die Zahl des Gesehenen), eine geänderte Folgenzahl nicht. MAL „On-Hold“/
  „Dropped“ und AniList „PAUSED“/„DROPPED“ kommen so an statt als „Später“.
  **Als Liste** neben „Als Poster“ (`sondra:merkliste:ansicht`): je Serie
  eine Zeile mit kleinem Poster, Stand, Balken mit Zähler, „noch 6 · 2 Std.
  24 Min.“ und +1 — `li` bekommt `max-w-none`, sonst greift die 34em-Regel.
  Sortierung „Am wenigsten übrig“ (Restzeit, Unbekanntes zuletzt).
  `CoverImage` liegt in `components/CoverImage.tsx`, damit „In Staffel
  einordnen“ Poster zeichnet, ohne die Merkliste zu laden.
- **Merkliste in Anytype** (nur in der App): `desktop/anytype.mjs` spricht im
  Hauptprozess mit Anytypes lokaler API (`127.0.0.1:31009`, `Anytype-Version:
  2025-11-08`), koppelt über den vierstelligen Code (`/v1/auth/challenges`,
  `/v1/auth/api_keys`) und legt den Schlüssel mit `safeStorage` verschlüsselt in
  `userData` ab; die Seite sieht ihn nie, sie schickt über
  `sondraApp.anytype(action, …)` eine Aktion nach der anderen. **Seit Anytype
  0.51.6 kann ein Schlüssel an gewählte Spaces gebunden sein,** und `/v1` lehnt
  ihn ab (403 `v1_not_available_for_scoped_keys`, „…carries a space grant, which
  /v1 cannot honor“). Die erste solche Ablehnung schaltet die Verbindung auf
  `/v2` (`api: 'v2'` in `anytype.json`, neu bestimmt bei jeder Kopplung); ein
  Schlüssel für alle Spaces bleibt auf `/v1`, wo er immer lief. `/v2` hat kein
  „ganze Seite ersetzen“: Schreiben liest `?outline=true`, löscht jeden obersten
  Block (`delete_block`, `recursive`) und fügt den Text als
  `insert_blocks`-Markdown an — höchstens 512 Ops je PATCH, 256 Blöcke je Op,
  deshalb `markdownRuns` (zählt jede Zeile, schneidet nur vor einem neuen
  obersten Block). Ein Space ausserhalb der Freigabe heisst `not-granted`. Im
  Browser geht es nicht: Anytypes API sendet keine CORS-Kopfzeilen
  (anytype-heart, `core/api/server`), und die Merkliste sagt das in einem Satz
  statt eines toten Knopfs. In Anytype liegt eine Seite „Sondra · Merkliste“: oben
  lesbar, unten ein Datenblock (Base64 im Codeblock, damit Anytypes
  Markdown-Umbau ihn nicht verbiegt). Ein Abgleich (`syncMerkliste` in
  `lib/anytype.ts`) liest, führt zusammen (`mergeShared`: je Serie gewinnt die
  zuletzt geänderte Seite, Entferntes bleibt entfernt über
  `sondra:merkliste_removed`, Covers aus Dateien bleiben auf ihrem Gerät) und
  schreibt nur, wenn Anytype nicht schon genau das hält — verglichen mit der
  Seite, nicht mit dem zuletzt Geschriebenen. Läuft beim Öffnen des Tabs und
  2,5 s nach jeder Änderung. **Was bewusst zurückkommt, gilt als jetzt
  geändert** — „Rückgängig“ nach dem Entfernen (`restoreMerkItem`), eine
  eingelesene Datei (`importMerkliste`), das Zurücknehmen davon
  (`revertImport`). Die Seite in Anytype kennt die Entfernung noch, und eine
  Entfernung schlägt jede ältere Änderung: vorher meldete das Einlesen
  „3 neu“, und der nächste Abgleich nahm die drei wieder weg. Eine Entfernung,
  die eine spätere Änderung überholt hat, fällt aus der Liste. Anytypes
  Export lässt die Sprache am Codeblock weg; gelesen wird deshalb ab
  „## Sondra-Daten“. Steht dort ein Block, den Sondra nicht lesen kann, wird
  die Seite nie überschrieben (`unreadable`). **Verbinden lädt die Liste aus
  Anytype** (`loadFromAnytype`, Wunsch vom 21.10.2026: „soll die Daten von
  Anytype laden, ausser man sagt spezifisch nicht“): sie ersetzt die Liste
  dieses Geräts, Covers aus Dateien bleiben, die bisherige lässt sich danach
  mit einem Klick dazunehmen (`importMerkliste`); „Nicht laden — beide
  Listen zusammenführen“ ist die ausdrückliche Ausnahme. Hält die Seite noch
  keine Liste, schreibt der erste Abgleich diese hin. **Antworten von
  Anytype:** nur 401 heisst „Schlüssel zurückgezogen“ und löscht ihn; 403
  ist ein Space mit Leserechten (`forbidden`, der Schlüssel bleibt — vorher
  warf das die Kopplung weg und der Space-Schritt fragte wieder nach dem
  Code); 404 und 410 heissen „Seite fehlt“, die nächste Runde legt sie neu
  an. Jeder Fehler steht mit Anytypes Grund (`detail`) in `sondra.log` und
  klein im Fenster, mit „Erneut“ daneben. Die Liste gehört allein
  `lib/merkliste.ts`; das Herunterladen hält keine eigene Kopie im Projekt.
  `npm run verify:anytype` spielt das gegen eine nachgebaute Anytype-API durch.
- **Google Drive** (22.10.2026, `lib/googleDrive.ts`, `lib/driveClient.ts`,
  `GoogleDrive.tsx`): auf Wunsch alles geordnet in einen Ordner „Sondra“ im
  eigenen Drive — `Projekte`, `Dateien/{Ton,Video,Bilder,Andere}`,
  `Heruntergeladen`, `Merkliste`. Nur Scope `drive.file`: Sondra sieht nur,
  was es selbst ablegte. Die Seite schickt die Dateien selbst zu Google (bis
  5 MB multipart, darüber resumable in 8-MB-Stücken direkt vom File; ein
  308 ohne sichtbares `Range` gilt als ganz angekommen), nie über `api/`.
  Ein Upload nach dem anderen; Projekte und die Merkliste ersetzen
  gleichnamige als neue Version, Dateien mit gleichem Namen und gleicher
  Grösse werden nicht noch einmal geschickt. **Anmelden im Browser:** Popup
  zu Google, zurück auf `public/google-drive.html`, das Token geht über
  einen BroadcastChannel an den Tab — nicht über `window.opener`, den COOP
  same-origin auf dem Weg über Google kappt. Das Token lebt nur im
  Arbeitsspeicher, eine Stunde; danach warten Uploads, und die Kopfzeile
  sagt wieder „Drive anmelden“ (ein Klick, das Popup muss im Klick aufgehen).
  **Anmeldung, die bleibt** (`api/google-token.js`, wenn dort
  `GOOGLE_CLIENT_SECRET` steht und die Client-ID die der Seite ist — die
  Seite fragt beim Laden per GET): Google schickt einen Code statt des
  Tokens (`access_type=offline`, `prompt=consent`), die Funktion tauscht ihn
  mit dem Secret und legt den Refresh-Token in ein Cookie `sondra_drive`
  (HttpOnly, Secure, SameSite=Strict, Pfad nur die Funktion, 180 Tage);
  die Seite bekommt nur das Token für die Stunde und holt das nächste mit
  `refresh`, beim Laden ohne Klick. Ohne das Secret ist das Cookie wertlos.
  „Trennen“ ruft `signout` (bei Google zurückgezogen, Cookie weg). Secret
  und Refresh-Token einer früheren Fassung im `localStorage` löscht
  `readSettings` beim Laden. `npm run verify:google-token`.
  **In der App** (`desktop/googleDrive.mjs`): Google lässt keinen
  eingebetteten Browser anmelden, also Systembrowser und Loopback mit PKCE
  auf einem freien Port, nur für die eine Antwort; der Refresh-Token liegt
  mit `safeStorage` in `userData`, die Seite bekommt über
  `sondraApp.drive('token')` je ein Access-Token. „Trennen“ zieht bei
  Google zurück. Die Knöpfe stehen erst da, wenn ein Client eingerichtet
  ist. **Der Drive-Knopf in der Kopfzeile steht immer da** (`DriveButton`,
  Wunsch vom 22.10.2026: „im Header kein Drive anmelden Button“ — vorher
  erschien er nur während einer Übertragung): ohne Verbindung „Drive
  anmelden“, und der Klick meldet an, während das Fenster daneben Ordner und
  den Satz „verlässt dieses Gerät“ zeigt; verbunden ein ruhiges „Drive“, beim
  Senden Prozent, „Fehler“, kurz „fertig“. Rechts vom Dateimenü, weil dessen
  Ankunftshinweis nach links aufgeht. Platz dafür: „App herunterladen“ heisst
  unter `lg` „App“, die Versionsmarke weicht unter 420 px (die Fusszeile
  nennt sie), unter 360 px stehen Drive und App nur als Symbol mit Namen
  für Screenreader, und Knöpfe schrumpfen nicht (`shrink-0`) — vorher wurde
  der Theme-Knopf auf 14 px gequetscht.
  **Direkt in Drive, ohne Sitzung** (Wunsch vom 23.10.2026: „sachen direkt
  auf die drive speichern … ohne auf die sitzung zu bringen“): „In Drive“
  (`DriveSaveButton`, `saveResultToDrive`) neben „Speichern“ bei jedem
  Ergebnis — Umwandeln, Video, Bilder, Lautstärke, Untertitel (SRT),
  Mikrofon, Mischen, Bildschirm, Herunterladen —, in den Ordner nach Art;
  meldet Warten, Prozent, „In Drive gespeichert“, „Schon in Drive“ und
  „erneut versuchen“ am Knopf selbst, meldet ohne Verbindung an. Eine WAV
  aus dekodiertem Ton wird erst beim Klick gerechnet. Herunterladen kennt
  dazu „Direkt in Google Drive speichern (ohne Sitzung)“ als Verhalten; ohne
  eingerichtetes Drive gilt dort wieder die Sitzung.
  Einrichtung: ein Google-Cloud-Projekt mit der Drive API, Zustimmungs-
  bildschirm mit `drive.file`, darin zwei OAuth-Clients — „Webanwendung“
  (JavaScript-Ursprung der Website, Weiterleitung `…/google-drive.html`;
  ID als `VITE_GOOGLE_CLIENT_ID` in Vercel) und „Desktop-App“ (ID und Secret
  als Repository-Variable `GOOGLE_CLIENT_ID` und Secret
  `GOOGLE_CLIENT_SECRET`; `build-desktop.mjs` backt sie in den
  Hauptprozess). Beide im selben Projekt, sonst sieht die App nicht, was die
  Website ablegte. `npm run verify:drive` spielt Client und App-Anmeldung
  gegen nachgebaute Google-Endpunkte durch.
  **Merkliste über Drive** (Wunsch vom 22.10.2026: „eine json file auf
  drive … als Alternative für Anytype“): der Schalter „Merkliste über Drive
  abgleichen“ macht `Sondra/Merkliste/Sondra-Merkliste.json` zur Liste, die
  alle Geräte desselben Kontos teilen, auch die Website. Eine Runde
  (`syncMerklisteWithDrive`) wie bei Anytype: lesen, `mergeShared`,
  zurückschreiben nur, wenn die Datei nicht schon genau das hält
  (`sharedKey`, verglichen mit der Datei, nicht mit dem zuletzt
  Geschriebenen); eine Datei, die keine Merkliste ist, wird nie
  überschrieben (`unreadable`). Die Datei trägt Einträge wie sie reisen
  (`travelling`, Covers aus Dateien bleiben auf dem Gerät) und die
  Entfernungen; `readMerklisteFile` liest sie wie jeden Export, auch die
  alte Sicherung ohne Entfernungen. Runden beim Verbinden, beim Start der
  App, beim Öffnen der Merkliste, 2,5 s nach jeder Änderung und beim
  Zurückkommen ans Fenster (höchstens jede Minute); nie zwei gleichzeitig.
  Was eine Runde selbst einsetzt, startet keine neue (`applying`). Nichts
  davon geht durch die Upload-Schlange: die Kopfzeile meldet keine
  Merkliste. Auf der Website ohne Token wartet es still; die Merkliste sagt
  „dafür bei Google anmelden“ mit Knopf. Ohne Anmeldung zuvor sagt die
  Merkliste „Über Google Drive abgleichen“ — Schalter an, Anmeldung im
  selben Klick. Erstes Verbinden führt zusammen statt zu ersetzen.
  **Ordner aus Drive** (Wunsch: „ordner soll den vom drive laden, so dass
  man von dort aus die Sachen schauen kann, dann soll es die Merkliste
  aktualisieren“): auf der Seite „Ordner“ „Aus Google Drive“ — der Ordner
  „Sondra“ (`tree` in `driveClient.ts`, Unterordner, Seiten mit
  `nextPageToken`), als `FolderScan` mit `source: 'drive'`; ein Eintrag hat
  dann `drive: { id, mime }` statt `file`. Mehr sieht Sondra in Drive mit
  `drive.file` nicht, und die Seite sagt das. Keine Vorschaubilder (hiesse,
  jeden Film zu holen), kein „Doppelte finden“; „In die
  Sitzung“ und ZIP holen die Dateien zuerst (`fileHere`). Gemerkt wird die
  Quelle (`sondra:ordner:quelle`), und die Merkliste liest Drive von selbst
  wieder ein, sobald angemeldet, sonst „Google Drive einbeziehen“.
  **Löschen in Drive** (Wunsch vom 29.10.2026: „Sachen im Sondra Ordner
  löschen können“): „Löschen …“ steht auch dort, nur geht es in den
  Papierkorb von Drive (`trash` in `driveClient.ts`, PATCH `trashed: true`;
  `trashDriveFiles`), und Dialog und Knopf sagen das („In den Papierkorb“,
  30 Tage wiederherstellbar). Eine Datei, die schon fehlt, gilt als
  gelöscht. **Keine Vorschau neben der Liste** (29.10.2026: „Vorschau im
  Tab Ordner braucht es nicht“): `FolderInlinePreview` und das grosse
  Vorschau-Fenster sind weg, die Kacheln haben die ganze Breite — auch mit
  einer gewählten Datei, die vorher eine Spalte kostete.
  **In Staffel einordnen** (Wunsch vom 22.10.2026: Folgen auswählen, einer
  Serie und Staffel zuweisen, „dann wird ein Ordner erstellt vom Anime und
  die ausgewählten Episoden sind im Ordner in einem anderen Ordner mit der
  ausgewählten Staffel“; `SeasonFiling.tsx`): in der Auswahlleiste eines
  Drive-Ordners. Serie aus der Merkliste (Pillen, vorgeschlagen nach dem,
  was die Dateien schon sind oder heissen — „Episode 01“ schlägt nichts
  vor) oder ein neuer Name, der dann auf die Merkliste kommt; Staffel als
  Zahl (0 = Filme); je Datei die Folge, vorbelegt aus dem Namen, sonst
  weitergezählt. **Neu gestaltet am 25.10.2026** („design das Menü
  besser“): links, was herauskommt — Poster, Staffel, der Zielordner als
  kleiner Baum mit „+ 5 Folgen“ —, rechts Serie (Poster-Pillen), Staffel
  (Pillen der bekannten, „Neu: Staffel 3“, Zähler) mit einem Streifen der
  Folgen (gefüllt: kommt dazu, getönt: gesehen) und die Dateien: Häkchen
  zum Auslassen, Nummer als Zähler, darunter woher sie kommt („schon
  eingeordnet“, „Nummer aus dem Namen“, „weitergezählt — bitte prüfen“).
  Doppelte Nummern und Folgen über das Ende der Staffel stehen an der
  Zeile; „Der Reihe nach nummerieren“ und „Wie erkannt“. Vorher bekam ein
  Bonus-Clip still „Folge 1“ neben S02E01. `fileIntoSeason` legt `Sondra/Serien/<Titel>/Staffel n`
  an (`folderAt`, vorhandene Ordner werden benutzt) und verschiebt jede
  Datei dorthin (`move`: `addParents`/`removeParents`), mit
  `appProperties` `sondraSerie`/`sondraStaffel`/`sondraFolge` — für andere
  Apps unsichtbar, für Website und App im selben Google-Projekt dieselben.
  Umbenannt wird nichts. Erkannt wird eine Datei deshalb zuerst an dieser
  Notiz (`matchHint`), dann am Ordner (`Serien/<Titel>/Staffel n`, auch
  von Hand dorthin gelegt), zuletzt am Namen (`matchFile`). Der Player
  bekommt die Notiz mit (`RemoteMedia.hint`), damit `MerklisteTick` auch
  „Episode 01.mkv“ abhakt. Danach liest die Seite Drive neu und zeigt den
  Staffel-Ordner. **Ein Ordner öffnet mit einem Klick, eine Datei mit
  zweien:** der zweite Klick eines Doppelklicks auf einen Ordner traf, was
  an seine Stelle rückte, und ein Film lief los. Klicks mit `detail ≥ 2`
  bis 600 ms nach dem Wechsel zählen nicht; ein eigener erster Klick hebt
  das auf.
  **Abspielen aus Drive**: der Player bekommt `RemoteMedia` statt eines
  Files (`sendToPlayer`), `source` bleibt leer. Gestreamt über den Service
  Worker: `drive-media/<id>?size=…&type=…` auf dieser Herkunft, der Worker
  holt die Bereiche mit `Range` und `Authorization` von Drive und setzt
  `Content-Range` selbst zusammen (welche Kopfzeilen der Browser von Google
  durchlässt, spielt so keine Rolle). Ein `<video>` kann Drive kein Token
  schicken, und ein Token in der Adresse landete in Protokollen: der Worker
  fragt die Seite per `MessageChannel` (`drive-token-wanted`) und hält es
  nur im Speicher; nach einem 401 fragt er einmal neu. Ob der Worker das
  kann, sagt ein `drive-ping` — ein Worker älterer Fassung nicht. Ohne
  Worker wird die Datei ganz geholt (Fortschritt auf der Bühne) und als
  Blob gespielt. FFmpeg (Vorschau, Qualität, Vorspann am Ton) gilt nur für
  Dateien auf dem Gerät. Fehlt auf der Website die Anmeldung, sagt die
  Bühne „Drive anmelden“ und versucht es danach erneut. Was zu Ende geschaut
  wird, hakt `MerklisteTick` ab wie sonst, und die Runde trägt es nach
  Drive. Getestet mit `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1`, sonst
  erreichen die Anfragen des Workers in Playwright die Nachbildung nicht.
- **Geräte** (`#geraete`, `DevicesPanel.tsx`, `lib/devices.ts`,
  `lib/deviceIdentity.ts`, `lib/deviceTransfer.ts`; 28.10.2026, Wunsch:
  „verschiedene Geräte verbinden und seamless Daten tauschen“, dazu: „die
  Geräte, wo registriert sind, unique und nicht überschreibbar von anderen
  Geräten“): Geräte desselben Google-Kontos finden sich über Drive, die
  Dateien gehen direkt (WebRTC-Datenkanal, DTLS). Opt-in über „Dieses
  Gerät verbinden“ (`sondra:geraete:an`). **Eindeutig und nicht
  überschreibbar:** jedes Gerät erzeugt beim ersten Verbinden ein
  ECDSA-P-256-Paar, der private Schlüssel ist nicht auslesbar
  (`extractable: false`) und liegt in IndexedDB `sondra-geraet`; die
  Kennung ist der SHA-256 des öffentlichen Schlüssels (20 Zeichen
  Crockford-Base32) — wählen kann man sie nicht, nur verdienen. Jeder
  Eintrag in `Sondra/Geräte/Gerät-<Kennung>.json` ist signiert; Drive kennt
  innerhalb eines Kontos keine feineren Rechte, also gilt: was nicht
  sauber signiert ist oder dessen Kennung nicht zum Schlüssel passt, wird
  von allen ignoriert (`checkRecord`, `pickDevices`), und der Besitzer
  schreibt seinen Eintrag in der nächsten Runde neu und löscht Kopien unter
  seiner Kennung. Jedes Gerät schreibt nur seine eigene Datei. Namen sind
  eindeutig (`uniqueName`: „Laptop 2“); wer einen Namen später nahm als
  ein anderes Gerät (`created`), benennt sich selbst um, nie das andere.
  **Post:** `Sondra/Geräte/Post`, je Nachricht eine Datei mit
  `appProperties` `sondraAn`/`sondraVon`, signiert, höchstens 15 Min. alt,
  nur einmal (`openMessage`); gelesen alle 4 s (im Hintergrund 15 s), der
  Empfänger löscht jede an ihn. Liste alle 30 s, eigener Eintrag alle
  2 Min. („offen“ = in den letzten 3 Min. gesehen). **Ablauf:** Angebot
  mit SDP und Dateiliste → das andere Gerät fragt („Annehmen“/„Ablehnen“,
  auch als schwebende Karte auf jeder Seite, `DeviceInbox`) → Antwort →
  Datenkanal. Protokoll in `deviceTransfer.ts` (64-KB-Stücke, der
  Empfänger bestätigt alle 4 MB, der Sender ist höchstens 16 MB voraus —
  sonst hielte ein langsames Telefon den Film im Speicher). **Kein
  STUN-Server** („kein Anbieter fest verdrahtet“): direkt geht es im
  selben Netz; sonst „Kein direkter Weg“ und — erst auf Klick, auf
  `panel-cool` gesagt — über Drive (`Sondra/Geräte/Übergabe`, nach dem
  Empfang gelöscht; geholt wird nur, was die Notiz `sondraUebergabe` genau
  dieser Übertragung trägt). **Ablage:** Android-App über `openSave`
  (save-begin/chunk/end in 1-MB-Stücken nach Downloads/Sondra), Chromium
  in einen beim ersten Mal gewählten Ordner (`showDirectoryPicker`, Handle
  in IndexedDB), sonst über `saveBytes`. „An Gerät“ steht neben jedem „In
  Drive“ (`DeviceSendButton` in `DriveSaveButton`). `npm run
  verify:devices` (Kennung, Fälschung, Wiederholung, Namen, Flusskontrolle,
  Abbruch); zwei Geräte samt nachgebautem Drive wurden mit Playwright
  durchgespielt (direkt, über Drive, beide Richtungen, Manipulation).
  **Ein IndexedDB-Fehler in `idb` wird zur Ablehnung:** ein Wert, der sich
  nicht speichern lässt, warf im Callback, und das Annehmen hing für immer.
  **Wiedererkennen** (29.10.2026: „nach einem Update oder Reinstall nicht
  mehr erkannt“): Schlüssel und Kennung hängen an der Herkunft, und zu der
  gehört der Port. `desktop/server.mjs` nahm bei belegtem 47199 sofort
  einen zufälligen — nach einem Update, solange der alte Prozess noch
  auslief, war die App ein neues Gerät mit leerer Merkliste. Jetzt: bis 16 ×
  250 ms warten, dann der gemerkte Ersatz aus `port.json` im Datenordner,
  erst dann ein freier, der dort gemerkt wird. Nach einer Neuinstallation
  (oder gelöschten Websitedaten) ist der Schlüssel unwiederbringlich weg —
  „nicht überschreibbar“ heisst genau das. Deshalb fragt `FormerHint`:
  Einträge, die nicht offen sind, dieselbe Art und Plattform haben, vor
  diesem angelegt und höchstens 14 Tage vor ihm zuletzt gesehen wurden,
  stehen mit „Das war dieses Gerät“ (`adoptFormer`: alter Eintrag gelöscht,
  sein Name übernommen) und „Nein, das ist ein anderes Gerät“ (`decided`,
  nie wieder gefragt). „Entfernen“ gibt es nur für Geräte, die nicht offen
  sind; ein lebendes schreibt seinen Eintrag ohnehin neu.
  **Zuverlässig** („funktioniert all 3–5 mal“): ein hartes Aus nach 15 s
  traf auf Post, die im Hintergrund nur alle 15 s gelesen wurde, und auf
  3 s Sammeln der Wege. Jetzt liest die Post jede 1,2 s, solange eine
  Übertragung auf Antwort wartet (nicht beim Fragen), und 400 ms nach jedem
  eigenen Angebot; gesammelt wird bis 8 s; nach 25 s (Sender) bzw. 45 s
  (Empfänger) steht „Kein direkter Weg“ samt Drive-Angebot da, aber die
  Verbindung wartet weiter bis drei Minuten und übernimmt, wenn sie doch
  aufgeht (`waitOpen`). Android hört `.local`-Namen nur mit
  `WifiManager.MulticastLock` (`multicast` in `Bridge.java`, Erlaubnis
  `CHANGE_WIFI_MULTICAST_STATE`, nach 120 s von selbst frei); Electron
  nennt seine Adresse im Netz direkt (`WebRtcHideLocalIpsWithMdns` aus),
  weil Windows-mDNS oft gesperrt ist. Beides wirkt erst mit einer neuen
  App-Fassung.
  **Was ein Gerät kann, steht in seinem Eintrag** (30.10.2026, `caps` im
  signierten Eintrag, `can()`): `text`, `play`, `folder`, `resume`. Eine
  ältere Fassung übergeht eine Nachricht, die sie nicht kennt, ohne
  Antwort — der Absender würde ewig warten —, also bietet er das Neue nur
  Geräten an, die es in `caps` nennen, und die Seite sagt bei den anderen,
  woran es liegt („Dort läuft eine ältere Version …“). Ein Eintrag ohne
  `caps` gilt weiter (die Unterschrift deckt jedes Feld, das da steht); die
  Liste lässt sich nicht nachträglich ändern. Eine neue Fähigkeit gehört
  hier und in `ownCaps()`, nie nur in die Oberfläche.
  **Ein Server in anderen Netzen** (30.10.2026, `lib/deviceServers.ts`,
  `OwnServer` auf der Seite „Geräte“, gefaltet): ein Feld für STUN und eins
  für TURN, leer, nichts eingetragen und nichts eingebaut — „kein Anbieter fest
  verdrahtet“ gilt weiter, denn ein fremder Server sähe jede Adresse. Die
  Adressen (`stun:`/`stuns:`, `turn:`/`turns:`, sonst abgelehnt) liegen im
  `localStorage`; **das TURN-Passwort nie** — es bleibt im Speicher der
  Seite und wird nach dem Schliessen neu gefragt. Die Verbindung nimmt
  `currentIceServers()`; der Server und die Relay-Adressen reisen in der
  Beschreibung durch Drive. Die Karte steht auf `panel-cool`: hier läuft etwas
  nicht lokal.
  **Text und Links** (`sendText`, Nachricht `text`, Karte `NoteRow`): bis
  4 000 Zeichen, nichts öffnet sich von selbst, als Link gilt nur ein
  einzelnes `http`/`https`. **Auf anderem Gerät abspielen** (`play`):
  Filme im Ordner „Sondra“ in Drive — nur Namen und Drive-Kennungen gehen
  (`playOnDevice`), das andere Gerät fragt, dann streamt es selbst; ein
  einzelner Film von diesem Gerät bis 2 GB geht als Übertragung mit
  `play: true` und startet nach der Ankunft im Player, ohne gespeichert zu
  werden (`playTarget`: Blöcke zu 32 MB). **Ordner senden** (`folder`):
  `FileInfo.path`, höchstens 300 Dateien je Übertragung; beim Empfang
  bereinigt `splitPath` jeden Teil (kein `..`, kein absoluter Anfang, acht
  Ebenen), Chromium legt Unterordner im gewählten Ordner an, die
  Android-App über `save-begin` mit `dir` unter `Downloads/Sondra/…`
  (eine App vor 1.1.23 speichert flach), sonst wird der Pfad Teil des
  Namens. „An Geräte senden“ unter einer Auswahl im Ordner: mehrere Geräte
  auf einmal, je eine Übertragung; **zwei senden zugleich** (`takeSlot`), die
  anderen warten auf ihrem offenen Kanal und sagen es. **Fortsetzen**
  (`resume`, `Kept`/`Piece` in `deviceTransfer.ts`): reisst die Leitung ab,
  schreibt der Empfänger zu Ende, was schon in der Warteschlange war, und
  hält die fertigen Dateien und das Stück der angefangenen (`suspend`:
  Ordner-Zugriff schliesst die Datei und öffnet sie mit
  `keepExistingData` wieder, der Browser-Speicher behält seine Teile);
  „Fortsetzen“ beim Sender bietet die Datei noch einmal an, der Empfänger
  nimmt genau diese Übertragung von selbst an (er hat zu diesen Dateien
  schon ja gesagt), meldet in `ready` was er hat (`done`, `from`), und der
  Sender schickt nur den Rest. Ein Stück, das nicht mehr stimmt
  (`intact`), beginnt von vorn — nie wird Falsches angehängt. Die
  Android-App kann das nicht (ihre Ablage schreibt in einem Zug), also
  nennt sie `resume` nicht. Ein Senden auf einem geschlossenen Kanal heisst
  `closed`, nicht „Datei nicht lesbar“.
- **Android-App** (`android/`, Wunsch vom 22.10.2026: „eine Android-App,
  die über Google Drive läuft statt Anytype“; am 23.10.: „es soll wirklich
  wie eine App sein, nicht Webapp“): eine eigene App um die Website, Paket
  `ch.lizge.sondra`, Java, keine Bibliothek für Web-Apps. `MainActivity`
  hält ein WebView auf `https://sondra.lizge.ch` (Start auf der Startseite wie die Website, seit 28.10.2026; vorher `#merkliste`),
  zwischen den Systemleisten (Insets als Abstand, Tastatur eingeschlossen),
  Startbild über die SplashScreen-API, bis die Seite gezeichnet hat; nur die
  eigene Adresse bleibt drin, alles andere und neue Fenster gehen an den
  Browser. Zurück-Taste geht in der Seite zurück. **Die erste Fassung (TWA,
  Chrome mit Adressleiste bis zur Schlüssel-Freigabe) war dem Nutzer zu sehr
  Website**; dazu stürzte sie ab, weil `ManageDataLauncherActivity` im
  Manifest fehlte — Build und lint merkten es nicht.
  **Was die Seite nicht kann, macht die App** (`Bridge.java`): ein Objekt
  `SondraNative` (androidx.webkit `addWebMessageListener`, nur für die
  eigene Herkunft und den Hauptframe), JSON mit `id` und `type`, die Antwort
  mit derselben `id`; die Seite spricht es über `lib/android.ts`
  (`ANDROID_BRIDGE`, `IN_ANDROID_APP`; dazu `SondraAndroid/<Version>` im
  User-Agent). `sign-in`: die Anmeldung bei Google Drive ist **die der
  Website** (`signInWeb`, Client „Webanwendung“, Code an
  `api/google-token`, Cookie im WebView, `CookieManager.flush()` beim
  Pausieren), nur öffnet die App sie im Browser (Custom Tab, androidx.browser)
  statt im Popup — Google lässt sie im WebView nicht zu. Der `state` trägt
  die Marke `app.`; daran erkennt `google-drive.html`, dass die Antwort der
  App gehört, und schickt sie als `intent://angemeldet?…#Intent;scheme=
  ch.lizge.sondra;package=ch.lizge.sondra;end` (nur dieses Paket; Knopf
  „Zurück zu Sondra“, falls der Browser einen Tipp will). Die App hält die
  Antwort, sagt der Seite `sign-in`, die holt sie mit `sign-in-result`; kommt
  Sondra ohne Antwort nach vorn, `sign-in-closed` (nach 1,5 s). Wurde die App
  unterwegs beendet, nimmt die neue Seite die Antwort (`resumeAppSignIn`, der
  `state` liegt dafür kurz in `sondra:drive:anmeldung`). Eine App, die
  `sign-in` nicht kennt, heisst `app-outdated`. **Zwei Fassungen davor gingen
  nicht:** die Google Play-Dienste (`AuthorizationClient`) verlangten einen
  OAuth-Client „Android“ mit dem SHA-1 des Schlüssels, der fehlte und sich mit
  dem Debug-Schlüssel bei jedem Lauf änderte; danach Loopback wie in der
  Windows-App — dort wartet die App im Hintergrund auf Googles Antwort, und
  Android hält Apps im Hintergrund an. Jetzt steckt nichts von Google in der
  App (der Workflow bricht ab, stünde ein `GOCSPX-` darin), und die Seite ist
  dieselbe wie im Browser. `save-*`: `saveBytes` gibt in der App die Datei in
  Stücken (1 MB, Base64) an `Saver.java`, nach `Downloads/Sondra` (ab
  Android 10 MediaStore, davor mit Speicher-Erlaubnis) — ein WebView kann
  `blob:` nicht speichern; alle Downloads gehen über `saveBytes`.
  `opened`: Teilen und „Öffnen mit“ (Video, Ton) — die App bedient jede
  Datei einmal unter `/__app/opened/<token>` (`shouldInterceptRequest`,
  auch für die Anfragen des Service Workers, der diesen Pfad durchlässt),
  die Seite holt sie, Filme und Ton gehen in den Player (`sendToPlayer`,
  `#abspielen`), anderes in die Sitzung. `theme`: die Seite meldet hell
  oder dunkel, die Systemleisten folgen. Dateiauswahl über Androids
  Auswahl (auch `webkitdirectory`: ein ganzer Ordner, rekursiv), Mikrofon
  mit Laufzeit-Erlaubnis, Vollbild-Video (`onShowCustomView`), offline beim
  ersten Start eine eigene Seite mit „Erneut versuchen“, ein beendeter
  WebView-Prozess baut das WebView neu statt die App zu beenden.
  Kurzbefehle (Merkliste/Ordner/Abspielen) gehen über `ShortcutActivity`:
  Android startet sie mit `CLEAR_TASK`, direkt auf `MainActivity` schlossen
  sie eine laufende Sondra; so wechselt nur der Hash. Version und versionCode
  (`a·10000 + b·100 + c`) aus der `package.json` der Website. AGP 8.13, SDK
  36 (min 24), R8 an (rund 210 KB). `/.well-known/assetlinks.json` schreibt die
  Seite beim Build aus `ANDROID_CERT_SHA256` (Vercel; Komma-Liste): dann
  öffnen Links auf sondra.lizge.ch ohne Rückfrage in der App. Workflow
  „Android“: baut APK und AAB, lint, prüft Paket, Version, Startaktivität und
  Signatur und dass kein Google-Secret drin ist, nennt SHA-256 (für Vercel)
  in der Zusammenfassung, **startet die APK auf einem Android-14-Emulator**
  (`android/launch-check.sh`: Symbol, die Seite spricht mit der App,
  Kurzbefehl, Link, Teilen, der Weg zurück von Google, Neustart —
  kein Absturz, die richtige Adresse; Bildschirmfotos als Artefakt
  „Sondra-Android-Bilder“); Schlüssel aus `ANDROID_KEYSTORE_BASE64`/
  `ANDROID_KEYSTORE_PASSWORD`, sonst Debug-Schlüssel (dann kein Release:
  keine spätere Fassung liesse sich darüber installieren). **Der Schlüssel
  entsteht nie in einem Lauf:** das Repository ist öffentlich, seine
  Artefakte lädt jeder mit einem GitHub-Konto — „new_key“, das ihn einen Tag
  als Artefakt hielt, ist deshalb weg (README, „Android-Schlüssel“).
  **Teil des offiziellen Release** (Wunsch vom 23.10.2026): der Workflow
  „Desktop“ ruft „Android“ als `workflow_call` auf (eigene Prüfungen samt
  Emulator) und legt `Sondra-Android[-<Version>].apk` mit den Setups ins
  Release; signiert der Debug-Schlüssel oder passt die Version nicht, bricht
  das Release ab. „release“ in „Android“ allein hängt die APK an ein
  bestehendes Release. Die Website verlinkt sie (`ANDROID_APK`,
  `releases/latest/download/Sondra-Android.apk`): in „App herunterladen“
  der Reiter „Android“, auf einem Android-Telefon der erste.
  **Herunterladen in der App** (28.10.2026, Wunsch: „eine Möglichkeit wie
  auf Desktop zu downloaden“; `YtDlp.java`, `panels/DeviceDownload.tsx`):
  youtubedl-android 0.18.1 bringt yt-dlp samt Python und FFmpeg mit
  (arm64-v8a, armeabi-v7a, x86_64; `extractNativeLibs` und
  `useLegacyPackaging`, sonst findet die Bibliothek ihre Binärdateien
  nicht), beim ersten Gebrauch entpackt, yt-dlp einmal pro Woche
  aktualisiert. Brücke: `ytdlp-info`, `ytdlp-download` (sofort `{job}`,
  Fortschritt als Ereignis `ytdlp`, auch in einer Benachrichtigung),
  `ytdlp-cancel`; die fertige Datei kommt über MediaStore nach
  Downloads/Sondra. Im Downloader geht in der App jede Portal-Adresse
  dorthin (`forDevice`), AniWorld und seine Hoster weiter über Sondras
  eigene Extraktoren; eine ältere App antwortet `rejected`, dann gilt der
  Weg der Website. Die Aufträge leben im Modul, nicht im Panel — wer das
  Werkzeug verlässt, sieht sie beim Zurückkommen.
  **Updates der App** (`Updater.java`, ab 1.1.20): die App holt die APK
  selbst (`update-download`, Fortschritt in der Kopfzeile) und öffnet dann
  Androids Installer („1.1.21 installieren“). Vorher stand dort ein Link,
  und Chrome hielt die APK bei 99 %, bis jemand im Browser „Trotzdem
  herunterladen“ bestätigte — vom Nutzer am 28.10.2026 so erlebt. Eine App
  vor 1.1.20 kennt `update-state` nicht (`rejected`); dann vergleicht
  `AppUpdate` die Version im User-Agent mit der der Seite und bietet die
  APK über den Browser an, mit genau diesem Hinweis. Die APK ist seit yt-dlp
  rund 150 MB (Python und FFmpeg für drei Architekturen).
  Icons: `npm run android:icons` (Vektor-Vordergrund aus den Balken des
  Zeichens, auch für das Startbild; PNGs mit den Helfern aus
  `store-tiles.mjs`). Lokal bauen: Android SDK mit `platforms;android-36`,
  dann `cd android && ./gradlew assembleRelease`.
- **Kein Anbieter wird fest verdrahtet.** Eine fremde Instanz im Code würde
  jede eingegebene Adresse an Dritte schicken, die niemand ausgesucht hat.
