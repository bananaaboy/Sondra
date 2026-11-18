# Sondra nativ

Der Umbau von Sondra von Electron auf Rust, wie ihn Discord ankündigt hat:
keine Webseite im Fenster mehr, sondern eine Oberfläche, die direkt auf der
Grafikkarte gezeichnet wird (GPUI, das Framework hinter dem Zed-Editor), und
Medienverarbeitung mit dem echten FFmpeg statt der WebAssembly-Fassung.

**Stand: Fundament.** Gebaut sind der Kern (`sondra-core`) und die Logik einer
Runde des Hintergrunddienstes (`sondra-daemon`: suchen, aufräumen, laden), beides
gegen nachgebaute Außenwelt getestet. Es gibt noch kein Fenster, kein Programm,
das läuft, und kein Setup. Die Electron-App und die
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
```

Geplant, in dieser Reihenfolge:

1. **`sondra-core`** *(da)*: die geteilte Merkliste lesen (SQLite und älteres
   JSON), entscheiden, was als Nächstes geladen wird, was bei einer
   Speichergrenze weg darf, wann geladen werden darf.
2. **`sondra-daemon`**: *die Runde ist da* (`round::run_round`: neue Folgen suchen
   und melden, bei Speichergrenze gesehene Folgen in den Papierkorb, laden, solange
   Fenster, Netzteil und Verbindung es erlauben — vor jeder Datei neu geprüft; was
   geladen ist, steht nach jedem Schritt auf der Platte). **Noch zu bauen, hinter
   denselben Traits:** Google-Anmeldung (Systembrowser, Loopback, PKCE, derselbe
   Client „Desktop-App“) und Drive lesen, die Seiten (Extraktoren für AniWorld und
   yt-dlp), der Papierkorb von Windows, Tray, Autostart, Rechner wach halten.
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
das `libc` 0.2.191 dort nicht mehr kennt. Unter Windows spielt das keine Rolle.
Zum Entwickeln hier hilft ein lokaler Patch (`ENODATA` statt `ENOATTR` in
`src/sys/mod.rs`) über `[patch.crates-io]`; der Fehler gehört in `xattr`.

## Nicht geprüft

Alles hier ist nur auf einem Linux-Rechner ohne Bildschirm gelaufen. Kein
Fenster wurde gezeichnet, nichts auf echtem Windows ausprobiert. Der Workflow
„Native“ führt die Kern-Tests auf Windows aus, das ist die erste echte Prüfung.
