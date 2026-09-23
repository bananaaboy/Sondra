# Sondra

Ein Medienstudio im Browser, das nichts hochlädt. Der Server liefert HTML,
JavaScript und WebAssembly aus — danach rechnet ausschliesslich der Rechner des
Besuchers. Live unter [lizge.ch](https://www.lizge.ch), als Windows-App über
die [Releases](https://github.com/bananaaboy/Lizge/releases/latest).

Vite 7 · React 19 · TypeScript · Tailwind v4 · zustand · FFmpeg als
WebAssembly.

## Was es kann

Die Werkzeuge heissen nach dem Ergebnis, nicht nach dem Verfahren. Jedes hat
eine eigene Adresse; der Start ist die blanke Wurzel.

| Werkzeug | Adresse | |
|---|---|---|
| **Herunterladen** | `#herunterladen` | Direkte Links, Freigabe-Links, HLS-Playlisten, YouTube (progressive Spur) und — mit Anbieter oder eigenem Dienst — weitere Portale |
| **Umwandeln** | `#umwandeln` | Ton und Video in andere Formate; die Ziele richten sich nach der Quelle, Stapel als ZIP |
| **Ton** | `#ton` | Schneiden an der Wellenform, Kopieren/Einfügen/Verdoppeln, Stille einfügen, Zoom und Schleife; Filter, Bass/Höhen, Kompressor, Rauschentfernung aus einem Rauschprofil, Echo, Hall; Pegel, Blenden, Tonhöhe, Tempo, Kanäle |
| **Video** | `#video` | Schneiden an der Zeitleiste, Ausschnitt, Drehen; Bild (Helligkeit, Kontrast, Sättigung, Looks, schärfen, entrauschen, stabilisieren), Blenden, Lautstärke und Lautheit, Tempo, rückwärts, Ton herauslösen, GIF |
| **Bilder** | `#bilder` | Skalieren, zuschneiden, Farbe, umwandeln, Stapel als ZIP |
| **Spuren trennen** | `#spuren-trennen` | Gesang, Schlagzeug, Bass, Übriges — ohne Modell-Download |
| **Lautstärke** | `#lautstaerke` | EBU R128 / ITU-R BS.1770-4 mit True-Peak-Grenze |
| **Zerschneiden** | `#zerschneiden` | Schnitte an Anschlägen oder im Tempo-Raster, 16 Pads mit Tonhöhe, Pegel, Panorama und Hüllkurve, Step-Sequencer (Tempo, Swing, 16/32 Schritte) als loopbare WAV oder MIDI, Sample-Pack |
| **Tonart** | `#tonart` | Tempo, Tonart mit Camelot-Code, Akkordverlauf, Melodie als MIDI |
| **Mikrofon** | `#mikrofon` | Ein- und Ausgang wählen, Pegelanzeige, Mithören, Probe; Einstellen für Podcast, Streaming, Videocall, Gesang oder Instrument mit Bericht jedes Schritts und Vorher/Nachher |

Die Startseite zeigt ohne Datei nur, was die Seite kann, und den Knopf, der
sie startet. Mit Datei fragt sie, was damit passieren soll, und bietet die
passenden Werkzeuge an. Darunter stehen alle Werkzeuge als Kacheln, nach
Gruppen filterbar und durchsuchbar.

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
npm run verify           # Lautheit, Tempo, Harmonie und Auflösung prüfen
```

`vite preview` kennt `api/` nicht. Wer den Downloader lokal durchspielen will,
baut einmal und startet `npm run dev:service`.

## Was lokal bleibt

1. **Keine fremden Ursprünge.** Schriften, WASM-Module und Skripte liegen im
   eigenen Bündel. Kein CDN, keine Google Fonts, kein Analytics. Der
   Netzwerk-Tab bleibt nach dem Laden still.
2. **Medien nur im Arbeitsspeicher.** Dateien liegen ausschliesslich im Heap
   des Tabs — keine IndexedDB, keine Cookies. Tab schliessen ist die
   Löschtaste. Im `localStorage` stehen nur drei Einstellungen: das
   Erscheinungsbild (`sondra:theme`), ein selbst eingetragener
   Extraktionsdienst (`sondra:service`, ohne API-Schlüssel) und eigene
   Instanzen (`sondra:instances`).
3. **Die Ausnahme steht, wo sie passiert.** Das Herunterladen ist das einzige
   Werkzeug, das das Gerät verlässt: die eingegebene Adresse geht an den
   kleinen Dienst dieser Seite, der die Datei durchreicht. Eigene Dateien sieht
   er nie, gespeichert wird dort nichts. Das sagt eine fette Warnung oben im
   Downloader, bevor jemand tippt.
4. **Das Mikrofon bleibt im Tab.** Es wird nur auf Knopfdruck geöffnet, roh
   (ohne die Filter des Browsers), und beim Verlassen des Werkzeugs wieder
   freigegeben. Aufnahmen liegen nur im Arbeitsspeicher.

Die Datenschutzerklärung steht in
[`public/datenschutz.html`](public/datenschutz.html), live unter
[lizge.ch/datenschutz.html](https://www.lizge.ch/datenschutz.html).

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

## Als Windows-App

Sondra gibt es auch als installierte Windows-App: eigenes Fenster statt
Browser, Eintrag im Startmenü, Verknüpfung auf dem Desktop, Deinstallation
über die Windows-Einstellungen. Oben auf der Website öffnet „App
herunterladen" die Auswahl zwischen Microsoft Store (noch ausgegraut, „Bald
verfügbar") und Setup. Das Setup installiert für alle Benutzer
unter „Programme“ (eine UAC-Abfrage), läuft mit `/S` ganz ohne Oberfläche,
wie es der Microsoft Store verlangt, und zeigt sonst vorher `LIZENZ.txt`. In
„Apps & Features“ steht es als „Sondra - Multimedia“ von „Lizge“ — beides
muss mit dem Eintrag im Partner Center übereinstimmen.

`desktop/electron.mjs` öffnet ein Fenster auf `desktop/server.mjs`, der die
Seite und die Funktionen unter `api/` nur auf `127.0.0.1` ausliefert — mit
denselben Isolations-Headern wie die Website, damit FFmpeg mehrfädig rechnet.
Electron steht nur in `desktop/package.json`, damit die Installation auf
Vercel keinen Browser herunterlädt, den sie nie startet. Die App liefert, was
die Website ausliefert, ohne Bereitstellungsdateien, Service Worker und
`sondra-ytdlp.mjs`.

- **Herunterladen:** [Sondra-Setup.exe](https://github.com/bananaaboy/Lizge/releases/latest/download/Sondra-Setup.exe)
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
  herunter (Blob-Adresse oder neuestes Release), installiert sie und klickt
  sie ebenso durch.
  Von Hand gestartet, veröffentlicht die Option `release` ein Release
  `v<Version>` mit `Sondra-Setup.exe`, und die Option `store` legt das Setup
  zusätzlich auf Vercel Blob (Secret `BLOB_READ_WRITE_TOKEN`) — eine
  Paket-URL ohne Umleitung, wie sie der Microsoft Store verlangt.

Die App schreibt ein Protokoll nach `%APPDATA%\Sondra\sondra.log`.

## FFmpeg im Browser

`@ffmpeg/ffmpeg` ist nur ein RPC-Client; `load()` startet einen Worker und
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

## Projektstruktur

```
api/                 Funktionen des Downloaders (resolve, stream, _shared)
desktop/             Windows-App: Electron-Fenster, lokaler Server, Setup-Texte
public/              statische Dateien: Schriften, Icons, Manifest,
                     Service Worker, Datenschutzerklärung
scripts/             Build der App, lokaler Dienst, Prüfskripte
src/
  components/        Kopfzeile, Startseite, Reiter, Sitzungsmenü, Wellenform
    editor/          gemeinsame Editor-Hülle und Zuschnitt
    panels/          die zehn Werkzeuge, dazu der Step-Sequencer
    ui/              Grundbausteine (Button, Notice, Reveal …)
  hooks/             Routing, Dateiaufnahme, Dekodierung, Theme
  lib/               Rechenverfahren, Effekte, Mikrofon-Kalibrierung, Pattern,
                     FFmpeg-Client, Downloader-Client
  state/             Sitzung (zustand, nur im Speicher)
  styles/            Tokens und Theme
.github/workflows/   Build und Release der Windows-App
```

Produktgrundlagen stehen in [PRODUCT.md](PRODUCT.md), die gestalterischen
Entscheidungen in [DESIGN.md](DESIGN.md).

## Lizenz

Sondra steht unter der [MIT-Lizenz](LICENSE).

Mitgelieferte und eingebundene Fremdprojekte behalten ihre eigenen Lizenzen:
FFmpeg (über ffmpeg.wasm, GPL), ONNX Runtime Web, Wavesurfer.js, Tone.js,
youtubei.js, React und zustand. Die Schriften Public Sans, Courier Prime und
Cormorant Garamond stehen unter der SIL Open Font License und liegen als
Teilmengen im Repository. Die Windows-App legt die Lizenztexte unter
`lizenzen/` in ihren Installationsordner.
