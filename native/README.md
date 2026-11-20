# Sondra nativ

Der Plan in Wellen steht in `PLAN.md`, die Liste aller Funktionen in `PARITY.md`.

Der Umbau von Sondra von Electron auf Rust, wie ihn Discord ankündigt hat:
keine Webseite im Fenster mehr, sondern eine Oberfläche, die direkt auf der
Grafikkarte gezeichnet wird (GPUI, das Framework hinter dem Zed-Editor), und
Medienverarbeitung mit dem echten FFmpeg statt der WebAssembly-Fassung.

**Stand: der Hintergrunddienst ist da, als Programm für die Befehlszeile.** Gebaut sind
der Kern (`sondra-core`), die Runde (`sondra-daemon`: suchen, aufräumen, laden),
Google Drive (`sondra-drive`), die Seiten (`sondra-extract`: AniWorld und seine sechs Hoster), das
Laden in eine Datei (`sondra-download`: direkt und HLS, Bandbreitengrenze, Fortsetzen) und das
Programm `sondra-dienst` (`sondra-service`), alles gegen nachgebaute Außenwelt getestet; die
Bedienungshilfen für GPUI (`sondra-a11y`) sind auf echtem Windows über UI Automation
abgefragt. Seit Welle 3/4 gibt es auch **ein Fenster** (`sondra`): Kopfzeile, Reiter, Startseite,
die **Merkliste** (Poster und Liste, Serienseite, +1, Entfernen mit Rückgängig; liest und schreibt
dieselbe SQLite-Datei wie die Website) und der **Ordner** (eine Platte lesen, filtern, auswählen,
in Sondras Papierkorb legen) — beide auf echtem Windows durch UI Automation geprüft. Noch kein
Tray, kein Player, keine Werkzeuge, kein Setup. Die Electron-App und die
Website laufen unverändert weiter, bis das native Sondra sie Stück für Stück
ersetzt — nichts davon wird abgeschaltet, bevor das Neue es besser kann.

## Warum

- Die Kodierer: libopus (Absturz ab Komplexität 5), VP9, x264 `veryfast` und
  libass stürzen in der WebAssembly-Fassung von FFmpeg ab; jede Umgehung steht in
  `CLAUDE.md`. Ein natives FFmpeg kennt diese Grenzen nicht.
- 135 MB Setup, davon das meiste Chromium; 32 MB WebAssembly bei jedem Start.
- Ein Hintergrunddienst (neue Folgen suchen, laden, aufräumen) braucht ein
  kleines Programm, kein Browserfenster.

## Aufbau

```
native/
  sondra-core/    Entscheidungen, ohne Fenster und ohne Netz — überall testbar
  sondra-daemon/  eine Runde des Hintergrunddienstes; alles Äußere hinter Traits
                  (Library, Checker, Fetcher, Trash, Host)
  sondra-a11y/    Bedienungshilfen für GPUI: Baum aus Rolle, Name, Lage und Fokus je Bild,
                  Anbindung an Windows UI Automation (AccessKit)
  sondra-drive/   Google Drive: Anmeldung (Systembrowser, PKCE), lesender Client, die Merkliste
  sondra-extract/ die Seiten: AniWorld/SerienStream, VOE, Filemoon, Vidmoly, Doodstream,
                  Streamtape, Vidoza, HLS-Listen; `testing` = nachgebaute Seiten für Tests
  sondra-download/ einen aufgelösten Strom in eine Datei laden (direkt, HLS, FFmpeg-Zusammenbau)
  sondra-service/ `sondra-dienst`: Suchen und Laden verdrahtet, Windows-Teile (Papierkorb,
                  Netzteil, getaktet, Wachhalten, Autostart), Schleife, Protokoll
  sondra-media/   der Medienkern: FFmpeg-Aufrufe, Lautheit, FFT, Tempo, Tonart, Vorspann — mit den
                  Zahlen der Website verglichen
  sondra-ui/      Sondras Look für GPUI: Farben hell/dunkel, Schriften, Radien, Bausteine (Knopf,
                  Chip, Reiter, Kachel, Menü, Hinweis, Textfeld), alle mit Namen und Rolle
  sondra-app/     das Fenster `sondra`: Kopfzeile, Reiterleiste (Gruppen, „Mehr“), Startseite;
                  Reiter und Kacheln kommen als Daten aus dem Code der Website
  sondra-merk/    die Merkliste und der Ordner als Logik: Eintrag, Einlesen aus allen Formen, Fortschritt
                  und Teile, Zusammenführen, Teilen, Planer, Dateinamen → Folge, Ordneransichten, Doppelte,
                  Papierkorb auf der Platte, Ordner lesen — mit den Zahlen der Website verglichen
  sondra-tray/    Tray-Symbol und Systemmeldungen (Windows), Fenster nach vorn, „immer im Vordergrund“
  sondra-midi/    MIDI-Controller für die Pads (winmm); Bytes und Zuordnung wie die Website
  sondra-onnx/    ein eigenes `.onnx`-Modell für „Spuren trennen“ (ONNX Runtime über `ort`), beide
                  Strategien der Website; zwei kleine Modelle für die Tests (`tests/make-models.py`)
  sondra-player/, sondra-playback/, sondra-audio/, sondra-devices/, sondra-speech/, sondra-mirror/,
  sondra-anytype/, sondra-electron/, sondra-discord/ — Player, Wiedergabe, Ton, Geräte, Whisper,
                  Handy spiegeln, Anytype, Datenübernahme aus der Electron-App, Discord
  installer/      Setup (NSIS) und Store-Paket (`make-msix.ps1`)
  vendor/xattr/   xattr 0.2.3 mit einer Zeile Patch, damit GPUI unter Linux baut
  probes/         Machbarkeitsproben der Welle 0b
```

Geplant, in dieser Reihenfolge:

1. **`sondra-core`** *(da)*: die geteilte Merkliste lesen (SQLite und älteres
   JSON), entscheiden, was als Nächstes geladen wird, was bei einer
   Speichergrenze weg darf, wann geladen werden darf.
2. **`sondra-daemon`**: *die Runde ist da* (`round::run_round`: neue Folgen suchen
   und melden, bei Speichergrenze gesehene Folgen in den Papierkorb, laden, solange
   Fenster, Netzteil und Verbindung es erlauben — vor jeder Datei neu geprüft; was
   geladen ist, steht nach jedem Schritt auf der Platte). **Hinter denselben Traits
   gebaut:** Google-Anmeldung und Drive lesen (`sondra-drive`), die Seiten
   (`sondra-extract`), das Laden (`sondra-download`), Papierkorb, Netzteil,
   getaktete Verbindung, Wachhalten, Autostart (`sondra-service`). **Noch offen:**
   yt-dlp als Programm und die übrigen Seiten (YouTube, Podcast, Bilibili, Spotify,
   9anime, AnimeKaizen, MVFlix), Tray, Benachrichtigungen, die Einstellungsseite.
3. **`sondra-media`**: natives FFmpeg als Prozess; Umwandeln zuerst.
4. **`sondra-app`**: das Fenster in GPUI, Werkzeug für Werkzeug in der
   Reihenfolge, in der sie benutzt werden (Start, Merkliste, Ordner, Player, …).

## Regeln, die hier schon gelten

- **Der Kern liest die Merkliste nur.** Er schreibt sie nie zurück. Was er
  geladen hat, steht in seinem eigenen Zustand (`State`), bis Web, Android und
  Windows sich auf eine gemeinsame Zusammenführung des Schreibens geeinigt haben.
  Unbekannte Felder bleiben erhalten (`Item::extra`).
- **Nie eine ungesehene Folge löschen,** auch wenn die Speichergrenze überschritten
  bleibt. Gelöscht werden nur gesehene Folgen, nur Dateien, die Sondra selbst
  geladen hat, und später nur in den Papierkorb von Windows.
- **Nichts ist vorgewählt.** Keine Serie wird von selbst geladen, kein Rechner
  wach gehalten, nichts gelöscht, bis es jemand wählt (`Config::default`).
- **Kein Anbieter fest verdrahtet** und nur, was legal geladen werden darf —
  wie im Rest von Sondra.
- Das Design (Kacheln ohne Schatten, Rundungen, zwei Schriften, Sie-Form) gilt
  auch hier; `DESIGN.md` bleibt die eine Quelle.

## Testen

```
npm run native:fixture          # schreibt die Testdateien mit dem Serializer der Website
cargo test --manifest-path native/Cargo.toml
```

Die Testdateien in `sondra-core/tests/fixtures/` schreibt die Website selbst.
Ein Rust-Leser, der nur gegen Rust-Dateien geprüft wäre, bewiese nichts über
die Datei in Drive. Der Workflow „Native“ erzeugt sie bei jedem Lauf neu und
bricht ab, wenn sie sich geändert haben — dann hat sich das Dateiformat
geändert, und der Kern muss mit.

## Entwickeln unter Linux

GPUI 0.2.2 baut unter Linux nicht von selbst: `xattr` 0.2.3 nutzt `ENOATTR`,
das `libc` 0.2.191 dort nicht mehr kennt. Unter Windows spielt das keine Rolle. Der
Workspace trägt deshalb einen Patch (`vendor/xattr`, `[patch.crates-io]`); der Fehler
gehört in `xattr`. Zum Linken der Tests braucht Linux die Entwicklungspakete
`libxkbcommon-x11-dev libxcb1-dev libfontconfig-dev libfreetype-dev libwayland-dev`.

## Nicht geprüft

Alles hier ist nur auf einem Linux-Rechner ohne Bildschirm gelaufen. Kein
Fenster wurde gezeichnet, nichts auf echtem Windows ausprobiert. Der Workflow
„Native“ führt die Kern-Tests auf Windows aus, das ist die erste echte Prüfung.
