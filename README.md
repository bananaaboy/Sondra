# Sondra

Ein Medienstudio im Browser, das nichts hochlädt. Der Server liefert HTML,
JavaScript und WebAssembly aus — danach rechnet ausschliesslich der Rechner des
Besuchers. Live unter [sondra.lizge.ch](https://www.sondra.lizge.ch), als Windows-App im
[Microsoft Store](https://apps.microsoft.com/detail/9P0JXR5GNSMG), als Windows- und
Android-App über die [Releases](https://github.com/bananaaboy/Sondra/releases/latest).
Was in jeder Version dazukam, steht unter „Was ist neu“ (ein Klick auf die
Versionsnummer) und in [`src/changelog.json`](src/changelog.json).

Vite 7 · React 19 · TypeScript · Tailwind v4 · zustand · SQLite 3 · FFmpeg als
WebAssembly und nativ mit GPU-Beschleunigung.

## Was es kann

Die Werkzeuge heissen nach dem Ergebnis, nicht nach dem Verfahren. Jedes hat
eine eigene Adresse; der Start ist die blanke Wurzel. Die Reihenfolge folgt exakt
der Navigationsleiste:

| Werkzeug | Adresse | |
|---|---|---|
| **Ordner** | `#ordner` | Lokale Ordner oder Google Drive durchsuchen; Kachel- und Listenansicht, Weiterschauen der Merkliste, Duplikate-Finder, Löschen (in Drive in den Papierkorb) |
| **Herunterladen** | `#herunterladen` | Videos und Musik von Adressen holen; Hintergrund-Downloads mit Floating-Minibar, Zero-RAM Direct-to-Disk, Sofort-Abspielen, Wake-Lock und Fertigstellungs-Gong; in der Android-App mit yt-dlp auf dem Telefon in voller Auflösung |
| **Merkliste** | `#merkliste` | Serien und Filme verfolgen; Staffeln, Folgen, Rechner „Bis wohin?“, Ziel-Planung, AniList/MAL-Sync, Anytype- und Google-Drive-Abgleich |
| **Geräte** | `#geraete` | Dateien direkt zwischen den eigenen Geräten (Handy, Laptop, Rechner): gefunden über das Google-Konto, übertragen per WebRTC, das andere Gerät fragt vorher; „An Gerät“ neben jedem „In Drive“ |
| **Umwandeln** | `#umwandeln` | Ton und Video in andere Formate; die Ziele richten sich nach der Quelle, Vorlagen für WhatsApp, Instagram Reels oder Hörbücher, Stapel als ZIP |
| **Ton** | `#ton` | Schneiden an der Wellenform, Kopieren/Einfügen/Verdoppeln, Stille einfügen, Zoom (auch mit dem Mausrad) und Schleife; Filter, KI-Sprachverbesserung & Rauschentfernung, Echo, Hall, Pegel, Blenden, Tonhöhe und Tempo — live vorhören |
| **Video** | `#video` | Schneiden an der Zeitleiste, Ausschnitt, Drehen; GPU-beschleunigte Konvertierung (NVENC/AMF/QSV), Bildfilter (Helligkeit, Kontrast, Sättigung, Looks, schärfen, entrauschen, stabilisieren), Blenden, Lautstärke und Lautheit, Tempo, rückwärts, Ton herauslösen, GIF |
| **Abspielen** | `#abspielen` | Media Player für Filme und Musik: Direkt-Stream ohne Download, Smart Prefetch ab 75 %, Timeline-Vorschaubilder, Kapitel, Untertitel (.srt/.vtt), Vollbild, Kinomodus, Nachtmodus, automatische Merklisten-Abhaking |
| **Bilder** | `#bilder` | Skalieren, zuschneiden, Farbe, umwandeln, Stapel als ZIP |
| **Mischen** | `#mischen` | Stimme und Musik in eine Datei; die Musik wird beim Sprechen weich leiser (Schwelle aus der Aufnahme, Haltezeit, Vorlauf, Ausklang), Vorher/Nachher, als WAV oder unter das Video gelegt |
| **Spuren trennen** | `#spuren-trennen` | Gesang, Schlagzeug, Bass, Übriges — ohne Modell-Download direkt im Browser oder mit eigenem ONNX-Modell |
| **Lautstärke** | `#lautstaerke` | EBU R128 / ITU-R BS.1770-4 mit True-Peak-Grenze, mehrere Dateien auf einmal als ZIP |
| **Zerschneiden** | `#zerschneiden` | Schnitte an Anschlägen oder im Tempo-Raster, 16 Pads mit Tonhöhe, Pegel, Panorama und Hüllkurve, eigene Bereiche nach Bestätigung, Step-Sequencer (Tempo, Swing, 16/32 Schritte) mit Klavierrolle je Pad, als loopbare WAV oder MIDI, Sample-Pack |
| **Tonart** | `#tonart` | Tempo (BPM), Tonart mit Camelot-Code, Akkordverlauf, Melodie als MIDI |
| **Untertitel** | `#untertitel` | Gesprochenes als Text mit Whisper auf dem Gerät (Modell einmalig von Hugging Face), jede Zeile korrigierbar; als TXT, SRT, VTT, als Untertitelspur im Video oder ins Bild gebrannt |
| **Bildschirm** | `#bildschirm` | Ganzer Bildschirm oder ein Fenster, mit Ton des Rechners und/oder Mikrofon, als Video direkt in die Sitzung; in der App mit Quellenauswahl samt Vorschaubildern |
| **Mikrofon** | `#mikrofon` | Ein- und Ausgang wählen, Pegelanzeige, Mithören, Probe; Ein-Klick-KI-Sprachverbesserung (Rausch- und Halleliminierung), Profile für Podcast, Streaming, Videocall, Gesang oder Instrument mit Bericht jedes Schritts und Vorher/Nachher |

Die Sitzung bleibt auf dem Gerät (IndexedDB & SQLite 3) und wird nach dem Schliessen
wieder angeboten; abschaltbar im Dateimenü. Ganze Projekte lassen sich als
`.sondra`-Datei exportieren und über den Knopf „Projekt laden“ auf der Startseite
oder per Dateiverknüpfung wiederherstellen. Nach einem Besuch geht alles ausser
dem Herunterladen auch ohne Netz. `?` zeigt alle Tastenkürzel.

Die Startseite zeigt ohne Datei nur, was die Seite kann, sowie die Knöpfe zum
Öffnen von Dateien, Laden von Projekten oder Abrufen von Adressen. Mit Datei fragt
sie, was damit passieren soll, und bietet die passenden Werkzeuge an. Darunter
stehen alle Werkzeuge als Kacheln, nach Gruppen filterbar und durchsuchbar.

Die geöffneten Dateien liegen hinter dem Dateinamen in der Kopfzeile: dort
wechseln, abspielen, speichern, entfernen, weitere öffnen oder alles
verwerfen. Überall, wo etwas bearbeitet wurde, lässt es sich anhören, und wo
es ein Vorher gibt, im direkten Umschalten dagegen — bei gehaltener
Abspielposition.

## Schnellstart

```bash
npm install
npm run dev              # http://localhost:5173
npm run build            # statisches Bündel in dist/
npm run preview          # dist/ mit den Isolations-Headern ausliefern
npm run dev:service      # dist/ zusammen mit den Funktionen unter api/
npm run typecheck        # TypeScript ohne Emit
npm run verify           # Alle Verifikationstests (Versionsverlauf, Geräte, Lautheit, Tempo, Harmonie, Ordner, Merkliste, Drive …)
```

`vite preview` kennt `api/` nicht. Wer den Downloader lokal durchspielen will,
baut einmal und startet `npm run dev:service`.

## Was lokal bleibt

1. **Keine fremden Ursprünge.** Schriften, WASM-Module und Skripte liegen im
   eigenen Bündel. Kein CDN, keine Google Fonts, kein Analytics. Der
   Netzwerk-Tab bleibt nach dem Laden still.
2. **Medien im Arbeitsspeicher & SQLite 3.** Dateien liegen standardmässig
   ausschliesslich im Heap des Tabs oder werden per Stream direkt auf die Festplatte
   geschrieben. Merkliste, Einstellungen, Schau-Historie und gelöschte Einträge
   lagern transaktionssicher in einer vollwertigen lokalen SQLite-3-Binärdatenbank
   (`sondra.db`). Tab schliessen ohne Speichern ist die Löschtaste.
3. **Die Ausnahme steht, wo sie passiert.** Das Herunterladen ist das einzige
   Werkzeug, das einen Dienst dieser Seite braucht: die eingegebene Adresse
   geht an ihn, er reicht die Datei durch. Eigene Dateien sieht er nie,
   gespeichert wird dort nichts. Das sagt eine fette Warnung oben im
   Downloader, bevor jemand tippt. Google Drive bekommt nur, was jemand
   ausdrücklich dorthin schickt, in das eigene Konto.
4. **Das Mikrofon bleibt im Tab.** Es wird nur auf Knopfdruck geöffnet, roh
   (ohne die Filter des Browsers), und beim Verlassen des Werkzeugs wieder
   freigegeben. Aufnahmen liegen nur im Arbeitsspeicher.
5. **Von Gerät zu Gerät ohne Umweg.** Unter „Geräte“ gehen Dateien direkt
   und verschlüsselt (WebRTC) auf ein anderes eigenes Gerät, kein Server von
   Sondra und kein fremder Vermittler liegt dazwischen. Im Drive liegt dafür
   nur je Gerät ein kleiner, signierter Eintrag und für Sekunden die
   Nachricht, die eine Übertragung anbietet. Über Drive selbst geht eine
   Datei nur auf Klick, wenn kein direkter Weg da ist, und wird danach dort
   gelöscht.

Die Datenschutzerklärung steht in
[`public/datenschutz.html`](public/datenschutz.html), live unter
[sondra.lizge.ch/datenschutz.html](https://www.sondra.lizge.ch/datenschutz.html).

## Der Downloader

Der Browser allein kommt an die meisten Portale nicht heran (CORS). Deshalb
gibt es zwei kleine Funktionen:

- `api/resolve.js` schlägt nach, was hinter einer Adresse liegt, und
  **signiert** die gefundenen Adressen (HMAC, kurze Gültigkeit).
- `api/stream.js` prüft die Signatur und reicht die Bytes durch — nur
  `https`, nie in private Adressbereiche, damit der Endpunkt kein SSRF-Loch
  ist.

Der Browser holt in 4-MB-Stücken mit `Range`. Das hält jeden Aufruf unter dem
Zeitlimit einer Serverless-Funktion, macht den Fortschritt exakt und das
Abbrechen sofort wirksam.

Welcher Weg geantwortet hat, steht beim Ergebnis: „Über den hinterlegten
Anbieter", „YouTube direkt" oder „Direkte Datei-Adresse". YouTube liefert an
einen Server nur die progressive Spur (Bild und Ton in einer Datei, in der
Regel 360p); die hohen Auflösungen laufen über SABR und haben keine abrufbare
Adresse. Volle Auflösung gibt es über einen hinterlegten Anbieter oder über
die Wege unter „Optionen" im Panel (eigener Dienst, yt-dlp auf dem eigenen
Gerät).

### Hintergrund-Downloads & Floating Minibar (v1.1.19)

- **Unterbrechungsfreies Laden:** Downloads brechen beim Verlassen des
  Download-Reiters nicht mehr ab. Der Downloader bleibt im Hintergrund gemountet
  und aktiv, während andere Werkzeuge (Player, Video-Editor, Mixer) genutzt werden.
- **Floating Minibar:** Sobald ein Download läuft und ein anderes Werkzeug
  geöffnet wird, blendet sich unten rechts eine elegante, schwebende Leiste
  ein. Sie zeigt den aktuellen Titel, Fortschrittsbalken, Geschwindigkeit in MB/s,
  Prozentsatz sowie Pause- und Abbruchknöpfe. Ein Klick bringt den Nutzer
  direkt zum Downloader zurück.
- **Screen Wake-Lock & Power Save Blocker:** Hält den Bildschirm und das
  System über die Screen Wake Lock API und Electron-PowerSaveBlocker wach,
  sodass der Rechner während großer Downloads nicht in den Ruhezustand fällt.
- **Auto-Resume & Retry:** Kurze Verbindungsunterbrüche werden automatisch
  abgefangen; der Download setzt genau am letzten Chunk wieder an.
- **Fertigstellungs-Gong:** Bei Abschluss ertönt ein dezenter, zweistimmiger
  Web-Audio-Gong (659,25 Hz & 880 Hz, abschaltbar in den Einstellungen).

### Sofort abspielen (Direct-Stream)

Statt große Folgen erst komplett herunterzuladen, übergibt die Aktion
**„Sofort abspielen“** aufgelöste HLS- (`.m3u8` via `hls.js`) und MP4-Streams
sofort an den Player-Tab (`PlayerPanel.tsx`). Auf Wunsch wird die Datei
parallel im Hintergrund auf der Festplatte gespeichert.

### Zero-RAM Direct-to-Disk (Desktop-App)

In der Desktop-App umgeht der Download den Browser-Arbeitsspeicher vollständig:
`desktop/downloader.mjs` schreibt den Mediendatenstrom direkt via
`fs.createWriteStream` auf die Festplatte im Zielordner. Das senkt den
RAM-Bedarf bei großen Staffel-Downloads auf nahezu **0 MB**.

### Umgebungsvariablen der Bereitstellung

| Variable | Wofür |
|---|---|
| `SONDRA_SECRET` | signiert die Adressen, die der Proxy weiterreicht |
| `SONDRA_PROVIDER_URL` | optional: ein cobalt-kompatibler Anbieter; wird zuerst gefragt und bringt volle Auflösung und weitere Portale |
| `SONDRA_PROVIDER_KEY` | optional: dessen `Api-Key`, falls verlangt |

Mit einem eigenen Dienst (cobalt oder die yt-dlp-Brücke auf dem eigenen
Rechner) geht es über dasselbe Feld: „Nachsehen" fragt ihn zuerst und nimmt
seine Einstellungen für Qualität und Nur-Ton. Wird die Seite lokal
ausgeliefert — in der Windows-App oder über die Brücke —, ist der Schalter für
externe Downloader von Anfang an an und Sondra sucht den Dienst auf
`localhost:9000` von selbst. Teile, die ein Dienst als HLS ankündigt, aber
schon fertig zusammengesetzt schickt (die Brücke tut das bei YouTube), werden
erkannt und direkt genommen.

Kein Anbieter ist fest verdrahtet. Eine fremde Instanz im Quelltext würde jede
eingegebene Adresse an Dritte schicken, die niemand ausgesucht hat.

Geladen wird nur, was man laden darf: AES-verschlüsselte HLS-Streams werden
abgelehnt, Kopierschutz wird nicht umgangen. Der Hinweis zur Verantwortung
steht im Panel, bevor man etwas eintippt.

## Ordner & Explorer (`#ordner`)

Der Ordner-Tab bietet einen vollwertigen lokalen Medien-Explorer:

- **Moderne Kachelansicht:** Getrennte Sektionen für Ordner und Mediendateien.
  Ordner erscheinen als kompakte, informative Karten (mit Dateizahl und
  Gesamtgröße); Videodateien mit Thumbnails bei 15 % der Laufzeit.
- **Auswählen wie im Dateimanager:** Klick, Strg/⌘, Umschalt, Pfeile; dann
  Abspielen, In die Sitzung, Als ZIP, In Drive oder Löschen. Ein Doppelklick
  spielt ab. Eine eigene Vorschau neben der Liste gibt es nicht mehr — die
  Kacheln nehmen die ganze Breite.
- **Löschen:** auf diesem Gerät zuerst in den Ordner „Sondra-Papierkorb“ im
  gewählten Ordner, mit „Rückgängig“ gleich daneben (Edge, Chrome, die App);
  „Endgültig löschen“ bleibt möglich. Im Ordner „Sondra“ in Google Drive gehen
  gelöschte Dateien in den Papierkorb von Drive und lassen sich dort 30 Tage
  lang wiederherstellen.
- **An Geräte senden und Auf Gerät abspielen:** unter einer Auswahl, ein oder
  mehrere Geräte des eigenen Kontos.
- **Listenansicht:** Strukturierte Tabelle mit Name, Art, Größe, Änderungsdatum
  und Laufzeit.
- **Weiterschauen:** Erkennt Folgen von Serien aus der Merkliste im Ordner und
  bietet die nächste ungesehene Episode mit einem Klick an.
- **Doppelte finden:** Identifiziert Dateikopien anhand von SHA-256-Prüfungen
  (bis 32 MB ganz, darüber an 32 Stellen) und behält die Originale.

## Merkliste & Serienbibliothek (`#merkliste`)

Eine private Mediathek zum Verfolgen von Anime, Serien und Filmen:

- **SQLite 3 Engine (`src/lib/sqlite.ts`):** Speichert Einträge, Staffeln,
  Fortschritte, Notizen und Historie direkt in einer relationalen
  SQLite-3-Binärdatei (`sondra.db` bzw. `Sondra-Merkliste.sqlite`).
  Arbeitet ohne externe native oder WASM-Abhängigkeiten im Browser-OPFS und
  IndexedDB.
- **„Bis wohin?“-Rechner:** Berechnet exakt, wie viele Folgen und Stunden
  bis zu einer bestimmten Staffel, Folge oder dem Serienabschluss fehlen.
  Ermittelt anhand des persönlichen Schautempos der letzten Wochen, an
  welchem Datum das Ziel erreicht wird.
- **AniList & MyAnimeList Synchronisation:** Automatischer Abgleich des
  Schau-Fortschritts mit AniList oder MAL beim Beenden einer Folge im Player.
- **Automatischer Metadaten-Import:** Beim Einfügen von AniWorld- oder
  SerienStream-Links werden Titel, Cover, Staffeln und Episoden automatisch
  abgerufen.
- **Multi-Device Sync:** Synchronisation über Anytype (lokale API) oder eine
  geteilte JSON/SQLite-Datei im Google Drive.
- **In Staffel einordnen:** Ausgewählte Episoden werden per Knopfdruck
  automatisch in saubere Ordnerstrukturen (`Serien/<Titel>/Staffel n`) abgelegt.

## Geräte (`#geraete`)

Dateien zwischen den eigenen Geräten: vom Laptop aufs Handy, vom Handy auf den
Rechner, auch zwischen Website, Windows-App und Android-App.

- **Verbinden:** auf jedem Gerät unter „Geräte“ einmal „Dieses Gerät
  verbinden“, mit demselben Google-Konto. Die Geräte erscheinen dort mit
  „offen“ oder „zuletzt vor …“.
- **Senden:** „Dateien senden“ beim Gerät, Dateien darauf ziehen, oder „An
  Gerät“ neben jedem „In Drive“ unter einem Ergebnis. Das andere Gerät fragt,
  bevor es annimmt — auf jeder Seite, als schwebende Karte.
- **Ankommen:** in der Android-App in Downloads/Sondra, im Browser und in der
  Windows-App in einem Ordner, der beim ersten Mal gewählt wird (Firefox und
  Safari: als gewöhnlicher Download).
- **Eindeutig und nicht überschreibbar:** jedes Gerät erzeugt ein eigenes
  Schlüsselpaar (ECDSA P-256), dessen geheimer Teil das Gerät nie verlässt.
  Die Kennung ist der SHA-256 des öffentlichen Schlüssels, jeder Eintrag in
  `Sondra/Geräte` und jede Nachricht ist signiert. Ein veränderter oder
  gefälschter Eintrag wird von allen ignoriert, sein Besitzer schreibt ihn
  neu. Namen bleiben eindeutig („Laptop 2“).
- **Der Weg:** Drive vermittelt nur, wer wer ist, und den Handschlag; die
  Datei geht direkt per WebRTC-Datenkanal. Einen STUN-Dienst gibt es nicht
  (kein fremder Anbieter fest verdrahtet), direkt geht es deshalb im selben
  Netz — außer Sie tragen unter „Eigener Server für andere Netze“ einen
  STUN- oder TURN-Server Ihrer Wahl ein. Das TURN-Passwort wird nicht
  gespeichert. Sonst bietet Sondra Google Drive an — erst auf Klick, und danach
  wird die Datei dort gelöscht.
- **Wiedererkannt nach Update und Neuinstallation:** die Windows-App bleibt
  auf ihrem Port (127.0.0.1:47199; ist er belegt, wartet sie und nimmt dann
  einen gemerkten Ersatz statt eines zufälligen) — der Port gehört zur
  Herkunft, und mit ihm verschwanden Schlüssel und Merkliste. Nach einer
  Neuinstallation oder gelöschten Daten ist der alte Schlüssel weg; „Geräte“
  fragt dann „Neu installiert?“, und „Das war dieses Gerät“ übernimmt Namen
  und Platz des alten Eintrags. Ein Gerät, das nicht mehr offen ist, lässt
  sich „Entfernen“.
- **Zuverlässiger Weg:** während einer Übertragung fragt Sondra jede 1,2 s
  nach Antworten statt alle 4–15 s, sammelt Verbindungswege bis zu 8 s und
  gibt einen direkten Weg erst nach drei Minuten auf (vorher nach 15 s, was
  jeden dritten bis fünften Versuch scheitern liess). Die Android-App hält
  dafür kurz ein Multicast-Lock (sonst hört sie die `.local`-Namen der
  anderen Geräte nicht), die Windows-App nennt ihre Adresse im Netz direkt.
- **Mehr als Dateien:** „Text senden“ schickt einen Text oder Link (er
  erscheint als Karte, nichts öffnet sich von selbst); „Auf Gerät abspielen“
  unter einer Auswahl im Ordner startet einen Film dort — liegt er in Drive,
  streamt das andere Gerät ihn selbst, ein einzelner lokaler Film (bis 2 GB)
  wird gesendet und spielt nach der Ankunft; „Ordner senden“ und „An Geräte
  senden“ schicken ganze Ordner mit ihren Unterordnern an ein oder mehrere
  Geräte, zwei Übertragungen gleichzeitig, die übrigen warten.
- **Fortsetzen:** reisst die Verbindung mitten in einer Datei ab, behält der
  Empfänger das Fertige und das Stück der angefangenen, und „Fortsetzen“
  beim Sender schickt nur den Rest (nicht in der Android-App als Empfänger).
- **Ältere Versionen:** jedes Gerät nennt in seinem signierten Eintrag, was es
  kann; Neues wird nur Geräten angeboten, die es können, und die Seite sagt
  bei den anderen, dass dort ein Update fehlt.
- **Prüfung:** `npm run verify:devices` (Kennungen, Signaturen, Fälschungen,
  Wiederholungen, Namen, Fähigkeiten, Pfade, Flusskontrolle, Abbruch,
  Fortsetzen) und `npm run verify:e2e` (zwei Geräte im Browser).

## Der Player (`#abspielen`)

Ein hochperformanter Media Player für Filme und Musik:

- **Direkt von der Festplatte:** Große 4K- und 1080p-Filme (> 50 GB) laufen
  ohne Speicherlast via Blob/Object-URL direkt von der Festplatte.
- **Smart Prefetch:** Erreicht die Wiedergabe ca. 75 % einer Folge, löst
  Sondra die nächste Episode im Hintergrund auf und puffert sie vor — für
  nahtlose Übergänge ohne Ladezeit.
- **Timeline-Vorschaubilder & Kapitel:** Hover-Vorschaubilder beim Bewegen
  über die Zeitleiste; Kapitelmarker für Intro, Hauptteil und Abspann.
- **Automatisches Abhaken:** Erkennt Serie, Staffel und Folge aus dem
  Dateinamen; ab 90 % Laufzeit wird die Episode in der Merkliste als
  „gesehen“ markiert.
- **Akustische Vorspann-Erkennung:** Haitsma/Kalker-Audio-Fingerprinting
  erkennt gemeinsame Intros über zwei Folgen hinweg und bietet
  „Vorspann überspringen“ an.
- **Klang- & Bildoptimierung:** Nachtmodus (Dynamikkompression für Sprache),
  Lautstärke-Boost bis 300 %, Kinomodus (T), Fensterfüllung (W) und Vollbild (F).

## FFmpeg: Nativ und im Browser

Sondra wählt automatisch den schnellsten verfügbaren Weg für Audio- und Videoberechnungen:

- **GPU-beschleunigtes FFmpeg (Windows-App):** Prüft automatisch die
  Verfügbarkeit von Hardware-Encodern:
  - **NVIDIA:** `h264_nvenc`
  - **AMD:** `h264_amf`
  - **Intel:** `h264_qsv`
  Video-Exporte und Schnitte laufen damit 5–10× schneller und entlasten die CPU fast vollständig.
- **Natives System-FFmpeg:** Bei installiertem System-FFmpeg werden Operationen
  ohne WebAssembly-Overhead über Systemprozesse ausgeführt.
- **WebAssembly (mehrfädig):** Im Browser mit aktivierten Isolations-Headern
  rechnet `@ffmpeg/core-mt` mehrfädig parallel über Web Worker und `SharedArrayBuffer`.
- **WebAssembly (einfädig):** Fehlt die Isolation, schaltet Sondra nahtlos auf
  den einfädigen Core zurück.

Welcher Motor gerade rechnet, wird transparent in der Fußzeile (z. B. `FFmpeg: Nativ`
oder `FFmpeg: WASM (4 Threads)`) sowie im Bereich „Unter der Haube“ ausgewiesen.

Im Browser ist `@ffmpeg/ffmpeg` nur ein RPC-Client; `load()` startet einen Worker und
übergibt ihm die Adressen von Core und WASM. Was dabei zählt:

- **Alles aus dem eigenen Bündel.** Beide Cores sind Abhängigkeiten und werden
  über Vites `?url` als gehashte Assets eingebunden, nicht per `toBlobURL` von
  einem CDN. Die Adressen müssen absolut sein, weil der Worker relative Pfade
  gegen seinen eigenen Ort auflöst.
- **`optimizeDeps.exclude`** für `@ffmpeg/ffmpeg`, `@ffmpeg/util` und
  `onnxruntime-web` — sonst schreibt das Pre-Bundling Adressen um, die diese
  Pakete zur Laufzeit selbst auflösen.
- **`classWorkerURL` nicht setzen** und **`assetsInlineLimit: 0`.** Ein
  eingebetteter Worker aus einer `data:`-URL bekommt einen undurchsichtigen
  Ursprung und darf den Core nicht importieren.
- **Mehrfädig nur isoliert.** `@ffmpeg/core-mt` braucht `SharedArrayBuffer`,
  also `Cross-Origin-Opener-Policy: same-origin` und
  `Cross-Origin-Embedder-Policy: credentialless` (`credentialless`, damit
  fremde Medien ohne CORP-Header ladbar bleiben). Die Header stehen in
  `vite.config.ts`, `vercel.json`, `public/_headers` und
  `public/staticwebapp.config.json`; wo sich keine Header setzen lassen,
  ergänzt `public/coi-serviceworker.js` sie. Fehlt die Isolation trotzdem,
  lädt `capabilities.ts` den einfädigen Core.
- **Eingaben kopieren.** `writeFile` überträgt den ArrayBuffer; ohne Kopie wäre
  die Datei in der Sitzung danach leer.
- **MEMFS aufräumen.** `runFfmpeg()` löscht Ein- und Ausgaben im `finally`,
  sonst wächst der Heap mit jeder Datei. Abbrechen geht nur über
  `terminate()`; der nächste Aufruf lädt den Core neu.

FFmpeg lädt im Hintergrund, nie hinter einem Ladebildschirm. Ein Werkzeug, das
wartet, zeigt das Warten bei sich.

## KI-Sprachverbesserung (Mic & Audio)

In `#mikrofon` und `#ton` steht eine lokale KI-Sprachverbesserung bereit:
- **1-Klick-Säuberung:** Entfernt Tastaturklicken, Rauschen, Brummen und
  störenden Raumhall (De-Reverb) in Echtzeit.
- **Präsenz-EQ & Normalisierung:** Hebt Sprachfrequenzen bei 2,8 kHz sanft an
  und pegelt die Aufnahme auf Standard-Sprachlautheit ein.
- **100 % lokal:** Läuft rein mathematisch in Float32Array ohne Cloud-Übertragung.

## Als Windows-App

Sondra gibt es auch als installierte Windows-App: eigenes Fenster statt
Browser, Eintrag im Startmenü, Verknüpfung auf dem Desktop, Deinstallation
über die Windows-Einstellungen. Oben auf der Website öffnet „App
herunterladen" das Fenster „Sondra als App“ mit zwei Reitern: Windows (Setup,
[Microsoft Store](https://apps.microsoft.com/detail/9P0JXR5GNSMG), Website als App,
Portabel) und Android (die APK) — der des eigenen Geräts zuerst. Das Setup installiert für alle Benutzer
unter „Programme“ (eine UAC-Abfrage), läuft mit `/S` ganz ohne Oberfläche,
wie es der Microsoft Store verlangt, und zeigt sonst vorher `LIZENZ.txt`. In
„Apps & Features“ steht es als „Sondra Studio“ von „Lizge“ — beides
muss mit dem Eintrag im Partner Center übereinstimmen.

`desktop/electron.mjs` öffnet ein Fenster auf `desktop/server.mjs`, der die
Seite und die Funktionen unter `api/` nur auf `127.0.0.1` ausliefert — mit
denselben Isolations-Headern wie die Website, damit FFmpeg mehrfädig rechnet.
Electron steht nur in `desktop/package.json`, damit die Installation auf
Vercel keinen Browser herunterlädt, den sie nie startet. Die App liefert, was
die Website ausliefert, ohne Bereitstellungsdateien, Service Worker und
`sondra-ytdlp.mjs`.

- **Herunterladen:** [Sondra-Setup.exe](https://github.com/bananaaboy/Sondra/releases/latest/download/Sondra-Setup.exe)
  aus dem neuesten Release. Das Setup ist nicht signiert; Windows fragt beim
  ersten Start nach.
- **Selbst bauen (Windows):** einmal `npm ci --prefix desktop`, dann
  `npm run build:desktop` → `release/Sondra-Setup-<Version>.exe`.
- **Ausprobieren auf jedem System:** nach `npm run build` baut
  `node scripts/build-desktop.mjs --dir` den entpackten App-Ordner;
  `npm run desktop` startet nur den Server und öffnet ihn im Browser.
- **GitHub Actions → „Desktop":** baut auf Windows, installiert still,
  prüft den Eintrag in Apps & Features, startet die installierte App zweimal
  und klickt sie dann mit `scripts/desktop-ui-test.mjs` durch — jedes
  Werkzeug mit einer echten Datei, das Mikrofon mit Chromiums Testgerät. Die
  Bildschirmfotos landen als Artefakt „Bildschirmfotos“.
- **GitHub Actions → „Desktop testen":** lädt eine veröffentlichte Setup-Datei
  herunter (eine Adresse oder das neueste Release), installiert sie und klickt
  sie ebenso durch.
  Von Hand gestartet, veröffentlicht die Option `release` ein Release
  `v<Version>` mit `Sondra-Setup.exe`. Vorher gehört die Version in
  `package.json` und `desktop/package.json` und oben in `src/changelog.json`
  ein Eintrag dazu: er wird zu den Notizen des Releases („Neu in …“), und
  `verify:changelog` bricht ab, wenn er fehlt. Für den Microsoft Store baut jeder Lauf
  das MSIX-Paket (Artefakt „Sondra-Store-MSIX“); eine Setup-Adresse ohne
  Umleitung braucht es dafür nicht mehr.

Die App schreibt ein Protokoll nach `%APPDATA%\Sondra\sondra.log`.

## Als Android-App

`android/` ist Sondra für Android: eine eigene App um die Website —
ihr eigenes WebView, keine Adressleiste, kein Chrome nötig. Was eine Seite
dort nicht kann, macht die App: die Anmeldung bei Google Drive (die der
Website, im Browser geöffnet), Speichern nach Downloads/Sondra, „Teilen“ und
„Öffnen mit“ für Videos und Ton (sie laufen dann im Player), die
Dateiauswahl (auch ganze Ordner), Vollbild-Video und das Mikrofon. Eigenes
Symbol, Startbild, Kurzbefehle (Merkliste, Ordner, Abspielen); sie startet
auf der Startseite. Statt Anytype (das nur die Windows-App erreicht) bringt
Google Drive die Merkliste und den Ordner mit den anderen Geräten zusammen.

- **Herunterladen wie in der Windows-App:** youtubedl-android bringt yt-dlp
  samt Python und FFmpeg mit; Portal-Adressen lädt das Telefon selbst, in
  voller Auflösung oder nur als Ton, mit Fortschritt in der Benachrichtigung,
  nach Downloads/Sondra. Deshalb ist die APK rund 150 MB gross.
- **Updates:** die App fragt GitHub nach der neuesten Fassung, lädt die APK
  selbst (Fortschritt in der Kopfzeile) und öffnet danach Androids
  Installer. Apps vor 1.1.20 kennen das nicht; ihnen bietet die Seite die
  APK über den Browser an.
- **Geräte:** Dateien von anderen Geräten landen in Downloads/Sondra.

- **GitHub Actions → „Android":** baut APK und AAB, prüft sie und legt sie
  als Artefakt „Sondra-Android“ ab. Jeder Lauf startet die App auf einem
  Android-14-Emulator (Symbol, Kurzbefehl, Link, Teilen, Rückkehr von der
  Google-Anmeldung) und legt Bildschirmfotos als „Sondra-Android-Bilder“ ab.
- **Im Release:** das offizielle Release (Workflow „Desktop“ mit `release`)
  baut die Android-App mit und legt `Sondra-Android.apk` neben die Setups;
  die Website verlinkt sie unter „App herunterladen“.
- **Android-Schlüssel:** jede Fassung muss mit demselben Schlüssel signiert
  sein, sonst installiert Android sie nicht über die alte. Einmal auf dem
  eigenen Rechner erzeugen — nie in einem Lauf, dessen Artefakte in diesem
  öffentlichen Repository jeder laden könnte:

  ```bash
  keytool -genkeypair -keystore sondra-android.jks -alias sondra -keyalg RSA \
    -keysize 4096 -validity 36500 -dname "CN=Sondra, O=Lizge, C=CH"
  base64 -w0 sondra-android.jks > ANDROID_KEYSTORE_BASE64.txt
  ```

  Dann in GitHub → Settings → Secrets and variables → Actions zwei Secrets:
  `ANDROID_KEYSTORE_BASE64` (Inhalt der Datei) und
  `ANDROID_KEYSTORE_PASSWORD` (das Passwort). Die `.jks` sicher aufbewahren;
  ohne sie lässt sich die App nie mehr aktualisieren. Fehlen die Secrets,
  signiert der Debug-Schlüssel, und das Release bricht ab.
- **Google Drive in der App:** nichts weiter einzurichten — es ist die
  Anmeldung der Website (Client „Webanwendung“ und Secret in Vercel). Sie
  öffnet sich im Browser und kehrt danach von selbst in die App zurück.
- **Links öffnen in der App:** den SHA-256-Fingerabdruck aus dem Lauf in
  Vercel als `ANDROID_CERT_SHA256` eintragen; der Build schreibt dann
  `/.well-known/assetlinks.json`.
- **Selbst bauen:** Android SDK mit `platforms;android-36`, dann
  `cd android && ./gradlew assembleRelease`. Symbole neu: `npm run android:icons`.

## Projektdateien (.sondra)

Über das Sitzungsmenü oder den Knopf „Projekt speichern“ lässt sich der gesamte
Arbeitsstand als portable `.sondra`-Datei sichern und transportieren:

- **Alles in einer Datei:** Eine `.sondra`-Datei ist ein ZIP-Archiv,
  das sämtliche Quell- und Ergebnisdateien unter `assets/` enthält sowie eine
  `project.json` mit allen Werkzeugzuständen.
- **Zustände bleiben erhalten:** Schnittmarken, Sampler-Slices, Melodien und
  Muster im Step-Sequencer, Untertitel-Texte mit Zeitcodes, Bildschirmaufnahmen
  und Mikrofon-Kalibrierungen werden exakt wiederhergestellt.
- **Einfaches Laden:** Direkt über den Knopf **„Projekt laden“** auf der Startseite,
  per Drag & Drop oder über die Windows-Dateiverknüpfung mit dem offiziellen
  Sondra-Dateisymbol.

## Die Rechenverfahren

**Lautheit.** Vollständiges BS.1770-4, gegen den Referenzpunkt der Norm geprüft
(`npm run verify:loudness`): ein 1-kHz-Sinus mit Spitzenamplitude X dBFS auf
beiden Kanälen liest X LUFS — gemessen auf 0,01 LU genau. Angehängte Stille
verschiebt den Wert nicht, der True-Peak-Messer findet die 3 dB, die zwischen den
Abtastwerten liegen, und die Verstärkung trifft ihr Ziel auf 0,01 dB. Die K-Bewertung aus Hochregal- und
RLB-Hochpassfilter wird für die tatsächliche Abtastrate berechnet, nicht aus der
48-kHz-Tabelle übernommen. Danach 400-ms-Blöcke mit 75 Prozent Überlappung über
Präfixsummen, absolutes Gate bei −70 LUFS, relatives bei −10 LU. Loudness Range
nach Tech 3342 aus 3-Sekunden-Blöcken.

Der True-Peak-Messer tastet vierfach über eine Polyphasen-FIR über. Zwei Details
entscheiden über die Genauigkeit: eine ungerade Zahl von Koeffizienten je Phase,
sodass Phase 0 die Identität ist, und Stille statt Randwiederholung ausserhalb des
Puffers — hält man stattdessen den Randwert, klingelt der Filter gegen ein
künstliches Plateau und meldet bei hohen Frequenzen bis zu 3 dB zu viel. So
bleibt der Fehler über das ganze Band unter 0,3 dB.

**Spurentrennung.** Medianfilter über die Zeitachse eines Magnitudenspektrogramms
lassen den harmonischen Anteil übrig, Medianfilter über die Frequenzachse den
perkussiven (Fitzgerald 2010). Parallel schätzt die Ähnlichkeit von links und
rechts pro Bin, wie mittig ein Anteil liegt — bei Lead-Gesang fast immer sehr
mittig. Aus beiden entstehen vier Affinitäten, die pro Bin auf eins normiert
werden; die Spuren addieren sich damit exakt zum Original zurück. Der gleitende
Median hält sein Fenster sortiert, also eine Einfüge- und eine Löschoperation je
Ausgabewert statt einer Sortierung. Verarbeitet wird in Abschnitten mit
Überblendung, sodass der Speicherbedarf nicht von der Dateilänge abhängt.

**Tonhöhe und Länge.** Ein Phasenvocoder propagiert die Momentanfrequenz von
Rahmen zu Rahmen; Transponieren ist Dehnen plus Resampling mit dem Kehrwert. Die
Pads spielen dagegen über die Abspielrate — sofort hörbar, so wie es
Hardware-Sampler tun.

**Tempo.** Autokorrelation der Onset-Hüllkurve: erst messen, wie stark sich das
Spektrum von Rahmen zu Rahmen nach oben ändert, dann fragen, bei welcher
Verschiebung dieses Signal am besten mit sich selbst zusammenfällt. Eine zweite
Suche findet die Phase, damit das Raster auf dem ersten Schlag beginnt und nicht
bei Sekunde null.

Die Sicherheit hat zwei Bedingungen: die Korrelationsspitze muss aus dem Feld
herausragen *und* das Material muss überhaupt Transienten haben. Ein gehaltener
Akkord erfüllt nur die erste und bekäme sonst ein erfundenes Tempo attestiert.
Halbes und doppeltes Tempo beschreiben dasselbe Raster, deshalb stehen ×2 und ÷2
daneben — eine Automatik kann das nicht entscheiden, ein Ohr schon.

**Schnittpunkte** wandern auf den nächsten steigenden Nulldurchgang, höchstens
wenige Millisekunden weit. Ein Schnitt mitten in der Wellenform hinterlässt eine
Stufe, und eine Stufe klickt. Blenden verdecken das, kosten aber den Anschlag —
genau den Teil eines Chops, auf den es ankommt.

## Was hier geht, was ein DAW nicht macht

Zwei Dinge, für die Produzenten sonst zu Zusatzsoftware greifen.

**Tonart aus Audio.** FL Studio 2026 benennt Akkorde im Piano Roll, also aus
MIDI — nicht aus einer Aufnahme, die man hineinzieht. Der Pitch-Region-Detektor
in Edison ist kein Tonartfinder; dafür gibt es Mixed In Key zu kaufen. Nötig ist
das nicht: eine Tonart ist eine Verteilung über die zwölf Tonklassen, und
Krumhansl und Kessler haben gemessen, wie diese Verteilungen aussehen. Die
Korrelation des Tonklassenprofils gegen ihre 24 Profile ergibt die Tonart, dazu
den Camelot-Code und die Nachbarn, die harmonisch dazu passen.

Parallele Dur- und Moll-Tonarten enthalten dieselben zwölf Töne. Das Profil
allein kann sie deshalb nicht trennen — was sie unterscheidet, ist welcher Ton
sich wie ein Grundton verhält. Dafür kommen zwei Indizien dazu: die Basslage und
der Anfang des Stücks. Bleibt es knapp, sagt die Oberfläche das und nennt die
Alternative, statt eine Zahl zu erfinden.

**Audio zu MIDI.** FL Studio hat das nicht eingebaut. Hier verfolgt YIN (de
Cheveigné und Kawahara, 2002) die Tonhöhe Rahmen für Rahmen; daraus werden Noten
gebildet und als Standard-MIDI-Datei geschrieben, die jedes DAW öffnet.

Die Verfolgung ist bewusst einstimmig. Ein mehrstimmiger Transkriptor braucht
ein trainiertes Modell und einen entsprechenden Download; eine einzelne Linie —
Bass, Hook, Gesang — ist ohnehin das, was man heraushören will. Auf einem vollen
Mix findet er die auffälligste Stimme statt der gewünschten, deshalb steht im
Panel der Hinweis, vorher unter „Spuren trennen“ zu trennen.

**Akkorde** werden über dieselben Tonklassen gegen Dreiklang-Vorlagen
abgeglichen. Dabei gibt es eine Falle: eine einzelne Note buchstabiert mit ihren
Obertönen selbst einen Durdreiklang, sodass naives Vorlagen-Matching jeder
Durchgangsnote einen Akkord anhängt. Der Ausweg ist ein Vergleich — erklärt eine
einzelne Tonklasse das Fenster deutlich besser als der beste Dreiklang, ist es
eine Melodie und kein Akkord. Gemessen an synthetischem Material liegt eine
Solostimme bei einem Verhältnis von 1,23 bis 1,48, Akkorde unter einer Melodie
bei 0,86 bis 1,11; die Grenze liegt dazwischen.

Beides rechnet lokal, ohne Modell und ohne Download.

## Eigenes Trennmodell verwenden

Sondra liefert keine Modellgewichte mit; ein Demucs-Export wiegt Hunderte
Megabyte, die sonst jeder Besuch mitlädt. Unter „Spuren trennen“ lässt sich eine
`.onnx`-Datei wählen. Der Läufer liest Rang und Form der Ein- und Ausgabe aus
den Session-Metadaten und wählt danach:

- **Rang 3** `[1, Kanäle, Samples]` → Wellenform-Modell, überlappende
  Hann-Fenster mit gewichteter Überlagerung.
- **Rang 4** `[1, Kanäle, Frequenz, Zeit]` → Maskenmodell; die Phase stammt aus
  dem Original.

WebGPU wird zuerst versucht, WASM ist der Rückfall. Die ONNX-Laufzeit wird
dynamisch importiert — wer die Funktion nie benutzt, lädt sie nie.

## Hell und dunkel

Drei Zustände statt zwei: hell, dunkel und „System“, das dem Betriebssystem
folgt und ihm auch später noch folgt. Nur die ausdrücklichen Entscheidungen
schreiben ein Attribut an `<html>`; „System“ lässt die Media Query in
`theme.css` entscheiden.

Farben heissen nach ihrer Rolle, nicht nach ihrem Ton — `canvas` statt
`cream-paper` —, weil genau der Ton sich zwischen den Themes ändert. Tailwind
gibt jede Farbklasse als `var(--color-…)` aus, sodass ein Theme-Wechsel die
Variablen neu belegt und nichts an den Komponenten anfasst. Ein kurzes Skript im
`<head>` setzt das Attribut vor dem ersten Paint, damit niemand kurz das falsche
Theme sieht.

Wellenformen zeichnen auf Canvas und in Wavesurfer mit echten Farbwerten. Die
werden zur Laufzeit aus dem Cascade gelesen; beim Wechsel wird Wavesurfer
umgefärbt statt neu aufgebaut, sonst wären alle gesetzten Bereiche weg.

## Offline

Der Service Worker setzt auf der Website die Isolations-Header und hält einen
Offline-Cache: Antworten vom eigenen Ursprung werden beim Abruf mitgeschrieben
und ohne Netz aus dem Cache bedient, auch der FFmpeg-Core. Ab dem zweiten
Besuch braucht die Seite kein Netz mehr. Fremde Ursprünge werden nie
zwischengespeichert. Über das Manifest lässt sich Sondra aus dem Browsermenü
als App installieren.

## Bekannte Grenzen

- **YouTube ohne Anbieter** liefert in der Regel nur 360p, manche Videos gar
  nicht. Volle Auflösung braucht `SONDRA_PROVIDER_URL` oder einen eigenen Weg
  unter „Optionen".
- **AES-verschlüsselte HLS-Streams** werden abgelehnt. Sondra lädt keine
  Schlüssel und umgeht keinen Kopierschutz.
- **Die eingebaute Spurentrennung erreicht kein Demucs.** Sie reicht für
  Karaoke, Remix-Vorarbeit und das Herauslösen von Schlagzeug.
- **Mono-Material** trennt sich schlechter: ohne Stereobild fehlt die
  Mitteninformation, aus der sich der Gesang ableiten liesse.
- **Das Bündel ist gross.** Beide FFmpeg-Cores und die ONNX-Laufzeit ergeben
  rund 90 MB in `dist/`. Geladen wird nur, was benutzt wird — wer bloss die
  Seite ansieht, holt unter 400 KB.
- **Das Windows-Setup ist nicht signiert.** SmartScreen fragt nach, und Smart
  App Control kann es blockieren.
- **Geräte direkt nur im selben Netz.** Ohne STUN-Dienst findet sich zwischen
  zwei Netzen kein direkter Weg; dann geht es auf Klick über Google Drive. Das
  empfangende Gerät muss Sondra offen haben, ein Angebot wartet 15 Minuten.
- **Die Android-APK ist rund 150 MB gross** — Python und FFmpeg für yt-dlp,
  für drei Prozessorarten.

## Projektstruktur

```
api/                 Funktionen des Downloaders (resolve, stream, google-token)
desktop/             Windows-App: Electron-Fenster, lokaler Server, Setup-Texte, Icons
android/             Native Android-App (Java, WebView-Brücke)
public/              statische Dateien: Schriften, Icons, Manifest,
                     Service Worker, Datenschutzerklärung
scripts/             Build der App, lokaler Dienst, Prüf- und Screenshot-Skripte
src/
  components/        Kopfzeile, Startseite, Reiter, Sitzungsmenü, Wellenform
    editor/          gemeinsame Editor-Hülle und Zuschnitt
    panels/          die 17 Werkzeug-Panels, Step-Sequencer und Piano-Roll
    player/          Media Player, Mini-Bar, Abspiellisten-Steuerung
    ui/              Grundbausteine (Button, Notice, Reveal …)
  hooks/             Routing, Dateiaufnahme, Dekodierung, Theme, Undo/Redo
  lib/               Rechenverfahren, SQLite-3-Engine, Hintergrund-Downloads,
                     KI-Sprachverbesserung, AniList, Projektdateien (.sondra),
                     Geräte (Identität, Register, Übertragung)
  changelog.json     „Was ist neu“ und die Release-Notizen, je Version
  state/             Sitzung (zustand, nur im Speicher)
  styles/            Tokens und Theme
.github/workflows/   Build, Test und Release der Windows- und Android-App
```

Produktgrundlagen stehen in [PRODUCT.md](PRODUCT.md), die gestalterischen
Entscheidungen in [DESIGN.md](DESIGN.md).

## Lizenz

Sondra steht unter der [MIT-Lizenz](LICENSE).

Mitgelieferte und eingebundene Fremdprojekte behalten ihre eigenen Lizenzen:
FFmpeg (über ffmpeg.wasm, GPL), ONNX Runtime Web, Wavesurfer.js, Tone.js,
youtubei.js, React und zustand. Die Android-App enthält youtubedl-android
(GPL-3.0) mit yt-dlp (Unlicense), Python (PSF-Lizenz) und FFmpeg (GPL). Die Schriften Public Sans, Courier Prime und
Cormorant Garamond stehen unter der SIL Open Font License und liegen als
Teilmengen im Repository. Die Windows-App legt die Lizenztexte unter
`lizenzen/` in ihren Installationsordner.
