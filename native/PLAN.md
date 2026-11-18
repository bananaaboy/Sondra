# Plan: Sondra ohne Electron, ohne Funktionsverlust

Entschieden am 18.11.2026: ganz weg von Electron, wie Discord — Rust, eine
Oberfläche, die direkt auf der Grafikkarte gezeichnet wird (GPUI), und das echte
FFmpeg statt der WebAssembly-Fassung. Dieser Plan sagt, in welchen Wellen das
geschieht und woran man merkt, dass nichts verloren ging.

Der Umfang, zur Einordnung: rund 75 000 Zeilen Oberfläche (19 Werkzeuge,
31 700 Zeilen allein in den Seiten), rund 30 000 Zeilen Logik in `src/lib`,
3 700 Zeilen Windows-Teil (`desktop/`) und etwa 25 Prüfskripte. Das ist ein
Projekt über viele Wochen, nicht über Tage.

## Wie „kein Funktionsverlust“ gesichert wird

Vier Dinge, die für jede Welle gelten:

1. **Die Funktionsliste** (`PARITY.md`). Jede Funktion der heutigen App steht dort
   mit ihrer Quelle, ihrer Welle und der Prüfung, die sie belegt. Eine Zeile wird
   erst „nativ ✔“, wenn die Prüfung läuft. Fällt jemandem beim Testen etwas auf,
   das fehlt, kommt eine Zeile dazu — die Liste wächst, sie schrumpft nur durch
   Erledigen.
2. **Die Prüfskripte der Website sind die Spezifikation.** Sie liefern schon
   feste Ausgaben (`verify:convert`, `:loudness`, `:harmony`, `:extractors`,
   `:resolve`, `:download`, `:merkliste`, `:drive`, `:devices`, `:intro`,
   `:folder` …). Jede Rust-Fassung bekommt dieselben Eingaben und muss dasselbe
   ausgeben. So wie es der Kern schon macht: die Testdateien schreibt die Website
   (`npm run native:fixture`), nicht Rust.
3. **Nebeneinander statt Ersetzen.** Das native Sondra bekommt eine eigene App-
   Kennung, einen eigenen Datenordner und einen eigenen Port und läuft neben der
   Electron-App. Es liest dieselben Daten (Drive), nimmt aber nichts weg. Die
   Electron-App wird weiter veröffentlicht, bis die Funktionsliste leer ist.
4. **Gestrichen wird nur mit Ihrem Wort.** Eine Funktion, die ich nicht nachbauen
   kann oder die sich nicht lohnt, steht als „offen: Entscheidung“ in der Liste.
   Sie wird erst gestrichen, wenn Sie es sagen — nie stillschweigend.

## Machbarkeitsproben zuerst (Welle 0b)

Fünf Fragen, die den ganzen Plan kippen können. Sie werden vor der Hauptarbeit
geklärt, mit je einer kleinen Probe, damit wir nicht nach drei Wellen
feststellen, dass etwas nicht geht:

| Frage | Warum sie kippen kann | Probe |
| --- | --- | --- |
| **Video im GPUI-Fenster** | Der Player ist das Herz von Sondra. GPUI hat keinen Videoknoten. | Ein Film läuft in einem GPUI-Fenster (libmpv oder FFmpeg + eigene Textur), mit Vollbild und Untertiteln. |
| **Bedienungshilfen** | Die Website hat Fokus, Beschriftungen und Screenreader-Namen. GPUI ist darin schwach. Das wäre ein echter Verlust. | Ein Fenster mit AccessKit; prüfen, was Windows-Sprecher davon sieht. |
| **GPUI auf Windows (x64 und Arm)** | Das Framework ist jung und ändert sich oft. | Ein Fenster auf `windows-latest` und `windows-11-arm`, Bildschirmfoto als Artefakt, GPUI-Version fest eingefroren. |
| **FFmpeg mitliefern** | x264 und andere Kodierer sind GPL; Größe und Lizenz des Pakets. | Ein FFmpeg-Build mit libopus, VP9, x264, libass und Hardware-Encoding; Lizenztext; Größe im Setup. |
| **Geräte-Verbindung mit der Website** | Das Übertragungsprotokoll muss mit Website und Android kompatibel bleiben. | Ein Rust-Gerät schickt eine Datei an die Website über WebRTC (`webrtc-rs`). |

Fällt eine Probe durch, kommt sie als Entscheidung zu Ihnen, mit den Alternativen,
bevor weitergebaut wird.

### Ergebnisse der Proben (18.11.2026)

| Frage | Ergebnis |
| --- | --- |
| **Video im GPUI-Fenster** | **Die Fläche trägt es.** Auf Windows x64 und Arm zeigt GPUI pro Animationsbild ein neues 1080p-Bild (8 MB, BGRA): **54 und 52 Bilder pro Sekunde**, auf Läufern ohne Grafikkarte (nur „Hyper-V Video“, also Software). Auf echter Hardware ist mehr zu erwarten. **Nicht gemessen:** das Dekodieren im selben Prozess (natives FFmpeg dekodiert 1080p hier mit rund 15-facher Echtzeit), Bild-und-Ton-Gleichlauf, Vollbild, Untertitel über dem Bild, der Speicher bei zwei Stunden Wiedergabe. |
| **GPUI auf Windows (x64, Arm)** | **Läuft.** Das Fenster öffnet auf beiden, die Version ist auf `=0.2.2` festgeschrieben. Bauen dauert ohne Zwischenspeicher rund 6 Minuten (x64). Unter Linux baut GPUI nur mit einem lokalen Patch an `xattr` (siehe README). Ob der **deutsche Text** richtig gezeichnet wird, ist erst mit dem nachgereichten Bildschirmfoto belegt. |
| **Bedienungshilfen** | **Fehlschlag.** GPUI 0.2.2 hat im Quelltext weder AccessKit noch UI Automation. Eine GPUI-Oberfläche ist für Screenreader unsichtbar. Nicht lösbar ohne eigene Arbeit am Framework oder ein anderes Framework. **Entscheidung offen** (`PARITY.md` R13). |
| **FFmpeg nativ** | **Die Abstürze der WebAssembly-Fassung sind weg.** libopus Stereo Komplexität 10, VP9, x264 `veryfast` und das Einbrennen von Untertiteln mit libass laufen mit dem echten FFmpeg 6.1.1 fehlerfrei. **Offen:** Größe und Lizenz eines mitgelieferten Windows-Builds (x264 ist GPL), nicht gemessen. |
| **Geräte-Protokoll** | **Läuft.** Ein Rust-Gerät (`webrtc-rs`) als Sender, genau wie `devices.ts` (Kanal „sondra“, geordnet, 64-KiB-Stücke mit Flusskontrolle), echtes Chromium als Gegenstelle: 8 MiB ohne einen falschen Wert, Antwort kommt zurück, 6 von 6 Läufen (und in der CI). **Nicht geprüft:** über ein echtes Netz, die Gegenrichtung mit vielen Stücken, Wiederaufnahme, Android. |

**Folgen für den Plan:** Video und Fenster sind machbar. Das Geräte-Protokoll kann
nativ werden. Die einzige harte Frage, die der Plan nicht allein lösen kann, ist die
der **Bedienungshilfen**: Bleibt GPUI, geht für Nutzer von Screenreadern etwas verloren,
das die Website heute hat — und das ginge nur mit Ihrem ausdrücklichen Wort (Regel 4).

## Die Wellen

Jede Welle liefert etwas, das man benutzen kann, und endet an einem Tor: Prüfung
läuft, Zeilen in `PARITY.md` abgehakt, auf Windows (x64 und Arm) gebaut.

### Welle 0 — Fundament *(fertig)*
Kern (`sondra-core`): die geteilte Merkliste lesen, was geladen wird, was weg darf,
wann geladen werden darf. Eine Runde des Dienstes (`sondra-daemon`) mit
nachgebauter Außenwelt. Workflow „Native“ auf Linux und Windows. Testdateien
von der Website.

### Welle 1 — Der Hintergrunddienst läuft
**Was Sie danach haben:** ein kleines Programm ohne Fenster, das im Tray sitzt, mit
Windows startet, neue Folgen sucht, sie in den Serien-Ordner lädt, den Rechner
wach hält (wenn gewählt) und alte gesehene Folgen bei einer Speichergrenze in den
Papierkorb legt. Das, was Sie sich zuerst gewünscht haben.
- Google-Anmeldung (Systembrowser, Loopback, PKCE; Token mit Windows-Anmeldeinfo
  verschlüsselt) und Drive-Zugriff (`driveClient.ts`, `googleDrive.mjs`).
- Die Seiten: Extraktoren für AniWorld und seine Hoster, `resolve`, `stream`
  (HLS umschreiben, Segmente zusammensetzen), yt-dlp als Programm
  (`api/*.js`, `downloader.mjs`).
- Direkt auf die Festplatte schreiben, Bandbreitengrenze, Wiederaufnahme.
- Windows: Papierkorb, Tray, Autostart, Wachhalten, Benachrichtigungen,
  Einzel-Instanz.
- Einstellungen: eine kleine Konfigurationsseite (erste GPUI-Oberfläche).
- **Tor:** `verify:extractors`, `:resolve`, `:download`, `:drive`, `:google-token`
  als Rust-Tests gegen dieselben nachgebauten Seiten; ein Lauf über Nacht auf
  einem echten Rechner ohne Absturz.
- **Offen vorab:** AniWorld lässt Rechenzentren nicht durch; geprüft wird gegen
  nachgebaute Seiten, nie echt — das gilt weiter.

### Welle 2 — Der Medienkern (ohne Oberfläche)
**Was Sie danach haben:** `sondra-media`, ein Befehl, der alles kann, was die
Werkzeuge im Hintergrund tun — mit dem echten FFmpeg. Die Abstürze der
WebAssembly-Fassung (libopus ab Komplexität 5, VP9, x264 `veryfast`, libass)
sind damit gegenstandslos.
- FFmpeg-Aufträge mit Fortschritt (`convert.ts`, `convertRun.ts`, `video.ts`,
  `edit.ts`, `image.ts`, `studio.ts`, `zip.ts`, `playable.ts`).
- Signalverarbeitung in Rust: Lautheit (`loudness`), Tonart und Akkorde (`key`,
  `chroma`, `harmony`, `midi`), Tempo, Tonhöhe, Hall und Filter (`effects`),
  Entrauschen, Ducking, Declick, Vorspann-Fingerabdruck (`introPrint`).
- Modelle: Spurentrennung und Sprachverbesserung über ONNX (`ort`), Untertitel
  mit Whisper (`whisper.cpp` oder ONNX).
- **Tor:** `verify:convert` (jedes Format, jede Vorlage), `:loudness`, `:tempo`,
  `:harmony`, `:intro` als Rust-Tests mit denselben Eingaben und Ausgaben.

### Welle 3 — Das Fenster und das Design
**Was Sie danach haben:** ein Sondra-Fenster mit allem Drumherum, aber noch ohne
die Werkzeuge: die Kopfzeile, die gruppierte Reiterleiste samt „Mehr“, die
Startseite mit Kacheln, hell und dunkel, die Schriften, die Bewegung.
- Bausteine nach `DESIGN.md`: Knöpfe, Felder, Kacheln, Popover, Dialoge, Blätter,
  Meldungen, Bewegung. Farben und Radien als Tokens.
- Schriften (Public Sans, Courier Prime, Cormorant), Kontrast nach APCA geprüft.
- Datei ablegen, Dateimenü, Sitzung bleibt (`sessionStore`), Umbenennen,
  Tastenkürzel und Befehlspalette, Adressen der Werkzeuge als Startparameter.
- Das Ergebnis der Probe zu Bedienungshilfen wird hier verbaut.
- **Tor:** Bildschirmfotos aller Zustände (hell/dunkel, schmal/breit) neben denen
  der Website, von mir und von Ihnen angesehen; Kontrastmessung; ein Test mit
  Tastatur allein.

### Welle 4 — Merkliste, Ordner, Start (der Alltag)
**Was Sie danach haben:** das, was Sie am häufigsten benutzen, nativ.
- Merkliste (5 200 Zeilen): Serien, Staffeln, Teile, Cover mit Ausschnitt, Stände,
  Poster und Liste, Planer „Bis wohin?“, Rückblick, Teilen (Link, Text, QR, Datei,
  Bilder im Link, Teile), Empfangen und Vergleichen, AniList/MAL, Anytype, Discord,
  neue Folgen melden. **Der Kern fängt hier an zu schreiben:** Zusammenführen
  (`mergeShared`) muss mit der Website übereinstimmen.
- Ordner (2 350 Zeilen): Kacheln und Liste, Auswahl, Vorschaubilder, Suche,
  Papierkorb von Sondra samt Ansicht, Untertitel im Ordner, Weiterschauen,
  Doppelte finden, Ansicht je Ordner, Drive-Ordner, Einordnen.
- **Tor:** `verify:merkliste`, `:anytype`, `:discord`, `:folder`, `:drive` als
  Rust-Tests; ein Hin und Her der Liste zwischen Website und nativem Sondra, in
  beide Richtungen, mit Entfernen und gleichzeitigen Änderungen — die Liste in
  Drive darf nie schlechter werden, als sie war.

### Welle 5 — Player und Herunterladen
**Was Sie danach haben:** Filme und Musik ansehen, Serien herunterladen.
- Player (3 500 Zeilen): Wiedergabe, alle Einstellungen, Größen, Bild-in-Bild,
  Vorspann überspringen (fest und am Ton), Schlaf-Timer, Lesezeichen, Abhaken in
  der Merkliste, Streaming aus Drive, fremde Formate, Weiter-bei,
  „Beim Minimieren pausieren“, Visualizer.
- Herunterladen (3 600 + 1 300 Zeilen): Wege, Portale, Listen, Folgenwähler,
  Minibar, Wachhalten, Gong, Wiederaufnahme.
- **Tor:** Wiedergabe jedes Formats aus `verify:convert` und der Szenarien
  „abspielen“; `verify:download`; ein langer Film mit Vorspringen und
  Untertiteln, von Ihnen angesehen.

### Welle 6 — Geräte und Handy
**Was Sie danach haben:** Dateien zwischen Ihren Geräten, das Handy auf dem Schirm.
- Geräte (`devices.ts`, `deviceTransfer.ts`, `deviceIdentity.ts`, 2 300 Zeilen):
  Identität (nicht auslesbarer Schlüssel im Windows-Speicher), Post über Drive,
  WebRTC, Ordner senden, Fortsetzen, Text und Links, auf anderem Gerät
  abspielen, der Weg über Drive, eigener STUN/TURN-Server, Wiedererkennen.
  **Muss mit Website und Android gesprächsfähig bleiben.**
- Handy spiegeln: ADB über USB, H.264-Bild, UHID-Tastatur, Ton, eigenes Fenster,
  Bildschirmfoto — mit dem scrcpy-Server wie bisher (Lizenzen bleiben).
- **Tor:** `verify:devices`; Austausch mit Website und mit der Android-App in
  beide Richtungen; Handy spiegeln **erstmals gegen ein echtes Handy** (das ist
  bis heute nie geschehen).

### Welle 7 — Die Werkzeuge (in drei Stücken)
- **7a — Formulare mit Aufträgen:** Umwandeln (Vorlagen, Stapel, ZIP), Lautstärke,
  Bilder, Untertitel.
- **7b — Ton:** Ton-Editor (Studio, Effektkette, Wellenform, Hören durch
  dieselbe Kette), Mischen, Spuren trennen, Tonart, Mikrofon (Kalibrierung),
  Bildschirm aufnehmen. Audioausgabe über `cpal`.
- **7c — Die großen Flächen:** Video-Editor, Zerschneiden mit Pads, Pattern-
  Sequenzer und Klavierrolle.
- **Tor je Stück:** die Prüfungen aus Welle 2 über die Oberfläche, Szenarien als
  Klicktests, Bildschirmfotos, und von Ihnen benutzt.

### Welle 8 — Ablösen
**Was Sie danach haben:** Sondra ohne Electron als das Sondra, das man herunterlädt.
- Installer, Portabel, Microsoft-Store-Paket, Arm64, automatische Updates mit
  signierten Dateien, „Öffnen mit Sondra“, Dateiendungen (`.sondra`,
  `.sondra-liste`), Einzel-Instanz, Offline.
- **Umzug der Daten:** Sitzung, Einstellungen und Lesezeichen der Electron-App
  werden eingelesen (Merkliste und Ordner liegen ohnehin in Drive).
- Lizenzen, Datenschutz, Changelog, „Was ist neu“.
- **Erst Vorschau, dann Vorgabe:** eine native Vorschau-Fassung neben der Electron-
  App; die Electron-App wird noch eine Fassung lang als Rückfall angeboten.
- **Tor:** keine Zeile in `PARITY.md` mehr offen (oder gestrichen mit Ihrem Wort);
  ein Durchgang aller Szenarien; Sie haben es zwei Wochen benutzt.

## Was bleibt, wie es ist

Die Website (`sondra.lizge.ch`) und die Android-App ändern sich nicht. Sie bleiben
die Fassungen für Browser und Telefon, und die Merkliste in Drive bleibt das
Gemeinsame. Was dort geändert wird, bleibt abwärtskompatibel; der Workflow „Native“
bricht ab, sobald das Dateiformat sich ändert, ohne dass der Kern mitzieht.

## Risiken, offen benannt

- **GPUI ist jung.** Die Schnittstelle ändert sich oft, es gibt wenig Dokumentation.
  Die Version wird festgeschrieben; ein Wechsel ist eine eigene Arbeit.
- **Bedienungshilfen** könnten ein echter Verlust werden. Das entscheidet die
  Probe in Welle 0b, und Sie entscheiden, wenn sie schlecht ausfällt.
- **Video im Fenster** ist die größte technische Frage.
- **Nur Windows.** Linux und macOS sind nicht Teil des Plans.
- **Nichts davon ist auf echter Hardware gelaufen.** Ich arbeite auf einem Linux-
  Rechner ohne Bildschirm; Fenster zeichnet erst Windows in der CI. Jedes Tor, das
  „von Ihnen angesehen“ sagt, meint das ernst.
- **Der Aufwand.** Die Wellen 4 bis 7 sind jede für sich Wochen. Die Reihenfolge
  ist so gewählt, dass jede Welle allein einen Nutzen hat — falls wir unterwegs
  anders entscheiden, bleibt das Fertige brauchbar.

## Reihenfolge und Abhängigkeiten

```
0 Fundament ─┬─ 0b Proben ──┬─ 3 Fenster ─┬─ 4 Merkliste/Ordner ─ 5 Player/Download ─┐
             ├─ 1 Dienst ───┘             ├─ 6 Geräte/Handy ────────────────────────┼─ 8 Ablösen
             └─ 2 Medienkern ─────────────┴─ 7a/7b/7c Werkzeuge ────────────────────┘
```

Welle 1 und 2 brauchen kein Fenster und können vor der Welle 3 laufen. Von der
Welle 3 an hängt alles an der Oberfläche.
