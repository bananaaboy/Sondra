# Sondra

Ein Medienstudio im Browser, das nichts hochlädt. Der Server liefert HTML,
JavaScript und WebAssembly aus — danach rechnet ausschliesslich der Rechner des
Besuchers. Live unter [sondra.lizge.ch](https://www.sondra.lizge.ch), als Windows-App im
[Microsoft Store](https://apps.microsoft.com/detail/9P0JXR5GNSMG) oder über die
[Releases](https://github.com/bananaaboy/Sondra/releases/latest).

Vite 7 · React 19 · TypeScript · Tailwind v4 · zustand · FFmpeg als
WebAssembly und nativ.

## Was es kann

Die Werkzeuge heissen nach dem Ergebnis, nicht nach dem Verfahren. Jedes hat
eine eigene Adresse; der Start ist die blanke Wurzel. Die Reihenfolge folgt exakt
der Navigationsleiste:

| Werkzeug | Adresse | |
|---|---|---|
| **Herunterladen** | `#herunterladen` | Direkte Links, Freigabe-Links, HLS-Playlisten, YouTube (progressive Spur) und — mit Anbieter oder eigenem Dienst — weitere Portale |
| **Umwandeln** | `#umwandeln` | Ton und Video in andere Formate; die Ziele richten sich nach der Quelle, mehrere Dateien auf einmal als ZIP |
| **Ton** | `#ton` | Schneiden an der Wellenform, Kopieren/Einfügen/Verdoppeln, Stille einfügen, Zoom (auch mit dem Mausrad) und Schleife; Filter, Bass/Höhen, Kompressor, Klicks und Knackser entfernen, Rauschentfernung aus einem Rauschprofil, Echo, Hall, Pegel, Blenden, Tonhöhe und Tempo — alles live zu hören, bevor es übernommen wird; Kanäle |
| **Video** | `#video` | Schneiden an der Zeitleiste, Ausschnitt, Drehen; Bild (Helligkeit, Kontrast, Sättigung, Looks, schärfen, entrauschen, stabilisieren), Blenden, Lautstärke und Lautheit, Tempo, rückwärts, Ton herauslösen, GIF |
| **Abspielen** | `#abspielen` | Media Player zum Ansehen und Anhören: spielt direkt von der Festplatte, auch grosse Filme, Wiedergabeliste, Untertitel aus .srt/.vtt, Vollbild, Bild im Bild, Tempo, Tastatur, „Weiter bei“; was der Browser nicht kann (AVI, MPEG-4, AC-3/DTS-Ton), macht FFmpeg abspielbar |
| **Bilder** | `#bilder` | Skalieren, zuschneiden, Farbe, umwandeln, Stapel als ZIP |
| **Mischen** | `#mischen` | Stimme und Musik in eine Datei; die Musik wird beim Sprechen weich leiser (Schwelle aus der Aufnahme, Haltezeit, Vorlauf, Ausklang), Vorher/Nachher, als WAV oder unter das Video gelegt |
| **Spuren trennen** | `#spuren-trennen` | Gesang, Schlagzeug, Bass, Übriges — ohne Modell-Download |
| **Lautstärke** | `#lautstaerke` | EBU R128 / ITU-R BS.1770-4 mit True-Peak-Grenze, mehrere Dateien auf einmal als ZIP |
| **Zerschneiden** | `#zerschneiden` | Schnitte an Anschlägen oder im Tempo-Raster, 16 Pads mit Tonhöhe, Pegel, Panorama und Hüllkurve, eigene Bereiche nach Bestätigung, Step-Sequencer (Tempo, Swing, 16/32 Schritte) mit Klavierrolle je Pad, als loopbare WAV oder MIDI, Sample-Pack |
| **Tonart** | `#tonart` | Tempo, Tonart mit Camelot-Code, Akkordverlauf, Melodie als MIDI |
| **Untertitel** | `#untertitel` | Gesprochenes als Text mit Whisper auf dem Gerät (Modell einmalig von Hugging Face), jede Zeile korrigierbar; als TXT, SRT, VTT, als Untertitelspur im Video oder ins Bild gebrannt |
| **Bildschirm** | `#bildschirm` | Ganzer Bildschirm oder ein Fenster, mit Ton des Rechners und/oder Mikrofon, als Video direkt in die Sitzung; in der App mit Quellenauswahl samt Vorschaubildern |
| **Mikrofon** | `#mikrofon` | Ein- und Ausgang wählen, Pegelanzeige, Mithören, Probe; Einstellen für Podcast, Streaming, Videocall, Gesang oder Instrument mit Bericht jedes Schritts und Vorher/Nachher |

Die Sitzung bleibt auf dem Gerät (IndexedDB) und wird nach dem Schliessen
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
npm run verify           # Lautheit, Tempo, Harmonie und Auflösung prüfen
```

`vite preview` kennt `api/` nicht. Wer den Downloader lokal durchspielen will,
baut einmal und startet `npm run dev:service`.

## Was lokal bleibt

1. **Keine fremden Ursprünge.** Schriften, WASM-Module und Skripte liegen im
   eigenen Bündel. Kein CDN, keine Google Fonts, kein Analytics. Der
   Netzwerk-Tab bleibt nach dem Laden still.
2. **Medien im Arbeitsspeicher.** Dateien liegen standardmässig ausschliesslich
   im Heap des Tabs. Optional sichert die lokale Sitzungswiederherstellung
   den Stand im Browser (IndexedDB), oder man exportiert die gesamte Sitzung
   als `.sondra`-Projektdatei. Tab schliessen ohne Speichern ist die
   Löschtaste. Im `localStorage` stehen nur Einstellungen: das
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
herunterladen" die Auswahl zwischen
[Microsoft Store](https://apps.microsoft.com/detail/9P0JXR5GNSMG) und Setup. Das Setup installiert für alle Benutzer
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
  `v<Version>` mit `Sondra-Setup.exe`. Für den Microsoft Store baut jeder Lauf
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
auf der Merkliste. Statt Anytype (das nur die Windows-App erreicht) bringt
Google Drive die Merkliste und den Ordner mit den anderen Geräten zusammen.

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

## FFmpeg: Nativ und im Browser

Sondra wählt automatisch den schnellsten verfügbaren Weg für Audio- und Videoberechnungen:

- **Natives FFmpeg:** Ist auf dem Rechner (oder in der Windows-App) ein natives
  FFmpeg verfügbar, nutzt Sondra direkte Systemaufrufe ohne WebAssembly-Overhead.
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
desktop/             Windows-App: Electron-Fenster, lokaler Server, Setup-Texte, Icons
public/              statische Dateien: Schriften, Icons, Manifest,
                     Service Worker, Datenschutzerklärung
scripts/             Build der App, lokaler Dienst, Prüf- und Screenshot-Skripte
src/
  components/        Kopfzeile, Startseite, Reiter, Sitzungsmenü, Wellenform
    editor/          gemeinsame Editor-Hülle und Zuschnitt
    panels/          die 14 Werkzeug-Panels, Step-Sequencer und Piano-Roll
    player/          Media Player, Mini-Bar, Abspiellisten-Steuerung
    ui/              Grundbausteine (Button, Notice, Reveal …)
  hooks/             Routing, Dateiaufnahme, Dekodierung, Theme, Undo/Redo
  lib/               Rechenverfahren, Effekte, Mikrofon-Kalibrierung, Pattern,
                     Projektdateien (.sondra), FFmpeg-Client, Downloader-Client
  state/             Sitzung (zustand, nur im Speicher)
  styles/            Tokens und Theme
.github/workflows/   Build, Test und Release der Windows-App (Setup & MSIX)
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
