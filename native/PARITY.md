# Funktionsliste: was Sondra heute kann und was davon nativ ist

Die Liste, an der „kein Funktionsverlust“ gemessen wird (siehe `PLAN.md`). Quelle
sind `CLAUDE.md`, die Seiten unter `src/components/panels/` und `desktop/`.

- **Stand:** `offen` · `in Arbeit` · `nativ ✔` (die Prüfung läuft) ·
  `Entscheidung` (kann oder soll nicht 1:1 nachgebaut werden — wird nur mit dem
  Wort des Nutzers gestrichen).
- **Welle** nach `PLAN.md`. **Prüfung:** was die Zeile belegt; ein Skript der
  Website (`verify:…`) heißt, die Rust-Fassung bekommt dieselben Eingaben.
- Fehlt etwas, kommt eine Zeile dazu. Die Liste ist nie „fertig“, nur leer.

## Rahmen und Start

| ID | Funktion | Bestand | Welle | Prüfung | Stand |
| --- | --- | --- | --- | --- | --- |
| R01 | Kopfzeile: Dateimenü, Sitzung hinter dem Dateinamen, Drive-Knopf, Versionsmarke | `AppShell`, `GoogleDrive` | 3 | Bildschirmfotos | offen |
| R02 | Reiterleiste: 6 einzelne, 3 Gruppen, „Mehr“ bei Platzmangel, Pfeiltasten | `PanelTabs`, `panelMeta` | 3 | Szenario „bewegung“ als Klicktest | offen |
| R03 | Startseite: Einstieg, „Datei auswählen“, „Von Adresse laden“, Filme und Serien, Werkzeug-Kacheln mit Filter | `Home` | 3 | Bildschirmfotos | offen |
| R04 | „Heute weiterschauen“ auf der Startseite | `Home` | 4 | Szenario „serien“ | offen |
| R05 | Hell und dunkel, Farben und Radien nach `DESIGN.md`, Kontrast nach APCA | `ThemeToggle` | 3 | Kontrastmessung | offen |
| R06 | Schriften Public Sans, Courier Prime, Cormorant | `index.css` | 3 | Bildschirmfotos | offen |
| R07 | Bewegung: Reiterstrich, Werkzeug von der Seite, gestaffelte Listen, Menüs, Dialoge, ruhige Bewegung | `DESIGN.md` „Motion“ | 3 | Szenario „bewegung“ | offen |
| R08 | Tastenkürzel, Übersicht mit „?“, Befehlspalette | `ShortcutHelp`, `CommandPalette` | 3 | Klicktest | offen |
| R09 | Dateien ablegen und auswählen, Sitzung (Dateien, Umbenennen, Reihenfolge) | `FileDrop`, `useIngest` | 3 | Klicktest | offen |
| R10 | Sitzung bleibt auf dem Gerät, „Letzte Sitzung wiederherstellen“ | `sessionStore`, `RestoreOffer` | 3 | Klicktest | offen |
| R11 | Adresse je Werkzeug (`#umwandeln` …) als Startparameter | `usePanelRoute` | 3 | Test | offen |
| R12 | „Was ist neu“, Versionsmarke, Hinweis nach Update | `WhatsNew`, `changelog.json` | 8 | `verify:changelog` | offen |
| R13 | Bedienungshilfen: Rolle, Name, Lage, Fokus und Aktivieren für Screenreader, Tastaturbedienung | überall | 0b/3 | `sondra-a11y`: 7 Tests im GPUI-Testfenster; Windows-Anbindung wird in der CI über UI Automation abgefragt (Job `uia`); **echter Screenreader (NVDA, Sprecher) noch nie** | in Arbeit |

## Merkliste

| ID | Funktion | Bestand | Welle | Prüfung | Stand |
| --- | --- | --- | --- | --- | --- |
| M01 | Liste lesen aus Drive (SQLite und JSON) | `merkliste.ts`, `sqlite.ts` | 0 | Testdateien der Website | **nativ ✔** |
| M02 | Serie hinzufügen mit einem Feld; „Wie weit sind Sie?“; „Mehr Angaben“ | `AddDialog` | 4 | Szenario „serien“ | offen |
| M03 | Staffeln, Teile, Filme, Folgenzahlen, Gesehenes, „Stand“ rückt weiter (`settle`) | `merkliste.ts` | 4 | `verify:merkliste` | offen |
| M04 | Cover mit Ausschnitt und Zoom, Pyramide beim Verkleinern | `CoverImage` | 4 | Bildvergleich | offen |
| M05 | Stände (Am Schauen, Später, Pausiert, Fertig, Abgebrochen), Filter | `MerklistePanel` | 4 | `verify:merkliste` | offen |
| M06 | Ansicht als Poster oder Liste, Sortierungen | `MerklistePanel` | 4 | Szenario „merkliste“ | offen |
| M07 | Serienseite: abspielen, gesehen, bearbeiten, „Mehr“ | `MerklistePanel` | 4 | Szenario „serien“ | offen |
| M08 | „Bis wohin?“ Planer, Ziel merken, Tempo aus dem Verlauf | `watchPlan`, `WatchPlanner` | 4 | `verify:merkliste` | offen |
| M09 | Statistiken und Rückblick, Verlauf, Würfeln | `MerklisteRecap` | 4 | `verify:merkliste` | offen |
| M10 | Teilen: Link, Text, QR, Datei, Bilder im Link, Teile; Empfangen und Vergleichen | `merkShare`, `shareCover`, `qr` | 4 | `verify:merkliste` | offen |
| M11 | Export und Einlesen (JSON, MAL, AniList), Zusammenführen, Rückgängig | `merkliste.ts` | 4 | `verify:merkliste` | offen |
| M12 | Zusammenführen mit Drive (`mergeShared`), Entfernen bleibt entfernt | `merkliste.ts`, `googleDrive.ts` | 4 | Hin und Her mit der Website | offen |
| M13 | Abgleich mit Anytype (v1 und v2, Space, Seite „Sondra · Merkliste“) | `anytype.mjs`, `anytype.ts` | 4 | `verify:anytype` | offen |
| M14 | Discord-Status über die lokale Pipe | `discord.mjs` | 4 | `verify:discord` | offen |
| M15 | Neue Folgen melden (alle 3 Stunden, Benachrichtigung, Klick öffnet die Serie) | `newEpisodes.ts` | 1 | `verify:extractors`, `:resolve` | offen |
| M16 | AniList und MAL: Fortschritt abgleichen | `anilist.ts` | 4 | Test | offen |
| M17 | Ordner erkennt Serien (zwei Folgen genügen), „Auf die Merkliste“ | `folder.ts` | 4 | `verify:folder` | offen |

## Ordner

| ID | Funktion | Bestand | Welle | Prüfung | Stand |
| --- | --- | --- | --- | --- | --- |
| O01 | Dateien eines Ordners als Kacheln oder Liste, Vorschaubilder, lange Ordner in Seiten | `FolderPanel`, `thumbnails` | 4 | Szenario „ordner“ | offen |
| O02 | Art, Suche (auch Unterordner), natürliche Sortierung, Tiefe | `folder.ts` | 4 | `verify:folder` | offen |
| O03 | Auswählen wie im Dateimanager, Abspielen, In die Sitzung, ZIP, In Drive, Löschen | `FolderPanel` | 4 | Szenario „ordner“ | offen |
| O04 | Papierkorb von Sondra (verschieben, rückgängig, ansehen, endgültig löschen) | `FolderBin`, `folder.ts` | 4 | `verify:folder` | offen |
| O05 | Untertitel im Ordner: Datei mit gleichem Namen, sonst Whisper erzeugt `Name.srt` | `autoSubtitles`, `FolderSubtitles` | 4 | Test | offen |
| O06 | Weiterschauen, „Nach Serie“, „Ungesehen“, „Neu“, Merkliste spielt aus dem Ordner | `folderLibrary.ts` | 4 | `verify:folder` | offen |
| O07 | Doppelte finden (Größe, Hash, 32 Stellen) | `duplicates.ts` | 4 | `verify:folder` | offen |
| O08 | Ansicht je Ordner, zuletzt geöffnete Ordner, gemerkter Ordner | `folderMemory.ts` | 4 | Szenario „ordner-zuletzt“ | offen |
| O09 | Ordner aus Drive, Löschen in Drive, In Staffel einordnen, „Einordnen“ mit einem Klick | `driveClient.ts`, `SeasonFiling` | 4 | Szenario „serien“ | offen |
| O10 | Bedienung mit dem Finger (Tipp, langes Drücken, Blatt) | `FolderPanel` | 4 | Entscheidung, ob Touch gebraucht wird | **Entscheidung** |

## Abspielen und Herunterladen

| ID | Funktion | Bestand | Welle | Prüfung | Stand |
| --- | --- | --- | --- | --- | --- |
| P01 | Wiedergabe von Video und Musik, Steuerung auf dem Bild, Verlauf, Ausblenden | `PlayerPanel` | 5 | Szenario „abspielen“ | offen |
| P02 | Einstellungen: Qualität, Tempo, Untertitel, Tonspur, Bild, Ton (bis 300 %, Nachtmodus), Wiedergabe | `SettingsMenu` | 5 | Test | offen |
| P03 | Größen: neben der Liste, Kino, fensterfüllend, Vollbild, Bild-in-Bild | `PlayerPanel` | 5 | Test | offen |
| P04 | Vorspann überspringen (fest und am Ton erkannt), Nächste Folge | `player.ts`, `introPrint` | 5 | `verify:intro` | offen |
| P05 | Schlaf-Timer, Lesezeichen, Weiter bei, Kapitel kopieren | `player.ts` | 5 | `verify:merkliste` | offen |
| P06 | Abhaken in der Merkliste ab 90 % | `episodeMatch`, `MerklisteTick` | 5 | `verify:merkliste` | offen |
| P07 | Fremde Formate abspielen (umpacken, Ton wandeln, klein neu rechnen) | `playable.ts` | 5 | `verify:convert` | offen |
| P08 | Streamen aus Drive mit Bereichsanfragen | `driveClient.ts` | 5 | Szenario „drive“ | offen |
| P09 | „Beim Minimieren pausieren“ | `pauseOnMinimize.ts` | 5 | Test | offen |
| P10 | Film läuft hinter anderen Werkzeugen weiter, kleine Leiste | `Dashboard` | 5 | Klicktest | offen |
| P11 | Visualizer für Musik | `PlayerPanel` | 5 | Bildschirmfoto | offen |
| D01 | Downloader: Wege (eigener Dienst, Brücke, Portale), Weg als Satz | `DownloaderPanel` | 5 | `verify:download` | offen |
| D02 | Extraktoren: AniWorld und Hoster, YouTube-progressiv, HLS zusammensetzen | `api/*.js`, `studio.ts` | 1 | `verify:extractors`, `:resolve` | **teils nativ ✔** — AniWorld/SerienStream (Staffel, Film, Folge, Online-Prüfung), VOE, Filemoon, Vidmoly, Doodstream, Streamtape, Vidoza, Packer, HLS-Listen und -Laden; offen: YouTube, Podcast, Bilibili, Spotify, Drive-Links, 9anime, AnimeKaizen, MVFlix, yt-dlp |
| D03 | Listen und Playlists, Folgenwähler, Staffeln laden | `download.ts`, `EpisodePicker` | 5 | `verify:download` | offen |
| D04 | Direkt auf die Festplatte (kein RAM), Fortschritt, Pause, Abbruch, Wiederaufnahme | `downloader.mjs`, `backgroundDownload.ts` | 1 | Test | offen |
| D05 | Hintergrund: Minibar, Wachhalten, Gong, Auto-Resume | `backgroundDownload.ts` | 5 | Klicktest | offen |
| D06 | Direkt in Google Drive speichern; „In Drive“ bei jedem Ergebnis | `DriveSaveButton` | 5 | `verify:drive` | offen |
| D07 | Warnung „läuft nicht lokal“ (im Dienst-Fall der ruhige Block) | `DownloaderPanel` | 5 | Bildschirmfoto | offen |

## Geräte, Handy, Drive

| ID | Funktion | Bestand | Welle | Prüfung | Stand |
| --- | --- | --- | --- | --- | --- |
| G01 | Gerätekennung aus dem öffentlichen Schlüssel, signierte Einträge, Fälschungen abgelehnt | `deviceIdentity.ts` | 6 | `verify:devices` | offen |
| G02 | Post über Drive, Namen eindeutig, Wiedererkennen nach Neuinstallation | `devices.ts` | 6 | `verify:devices` | offen |
| G03 | Direkte Übertragung (WebRTC), Flusskontrolle, Annehmen und Ablehnen | `deviceTransfer.ts` | 6 | Austausch mit der Website | offen |
| G04 | Ordner senden, Fortsetzen nach Abbruch, drei Übertragungen zugleich | `deviceTransfer.ts` | 6 | Szenario „geraete“ | offen |
| G05 | Text und Links senden; auf anderem Gerät abspielen | `devices.ts` | 6 | Szenario „geraete“ | offen |
| G06 | Weg über Drive, eigener STUN/TURN-Server, Fähigkeiten (`caps`) | `deviceServers.ts` | 6 | `verify:devices` | offen |
| H01 | Handy spiegeln: ADB über USB, scrcpy-Server 3.3.3, H.264, Maus, Tasten | `phoneMirror.ts` | 6 | **gegen ein echtes Handy** | offen |
| H02 | UHID-Tastatur, Ton des Handys, Bildschirmfoto, eigenes Fenster | `hidKeyboard.ts`, `phoneAudio.ts` | 6 | `verify:hid`, echtes Handy | offen |
| GD1 | Google-Anmeldung (Systembrowser, PKCE), Token verschlüsselt, Trennen | `googleDrive.mjs` | 1 | `verify:drive`, `:google-token` | **nativ ✔** (gegen nachgebautes Google; nie gegen das echte; Windows: Anmeldeinfo-Verschlüsselung gebaut, auf Windows noch nicht gelaufen) |
| GD2 | Ordner „Sondra“ in Drive, Hochladen (5 MB / 8-MB-Stücke), Projekte, Merkliste | `googleDrive.ts` | 1 | `verify:drive` | offen |

## Werkzeuge

| ID | Funktion | Bestand | Welle | Prüfung | Stand |
| --- | --- | --- | --- | --- | --- |
| W01 | Umwandeln: alle Formate, Vorlagen (WhatsApp, Reel, Hörbuch, E-Mail), eigene Vorlagen, Stapel, ZIP | `ConverterPanel`, `convert.ts` | 2/7a | `verify:convert` | offen |
| W02 | Lautstärke: Lautheit messen und angleichen, Stapel | `NormalizePanel`, `loudness.ts` | 2/7a | `verify:loudness` | offen |
| W03 | Bilder: skalieren, zuschneiden, umwandeln, viele auf einmal | `ImagePanel`, `image.ts` | 2/7a | Bildvergleich | offen |
| W04 | Untertitel: Whisper, TXT/SRT/VTT, als Spur oder eingebrannt | `SubtitlesPanel`, `transcribe.ts` | 2/7a | Test | offen |
| W05 | Video-Editor: schneiden, drehen, Farbe, Blenden, Tempo, Ton; große Dateien | `VideoPanel`, `video.ts` | 2/7c | Szenario | offen |
| W06 | Ton-Editor: Studio, acht Werkzeuge, Filter, Rauschen, Hall, Tonhöhe, Tempo, Blenden | `AudioEditorPanel`, `effects.ts` | 2/7b | Test, Hörprobe | offen |
| W07 | Mischen: Stimme und Musik, Ducking | `MixPanel`, `duck.ts` | 2/7b | Test | offen |
| W08 | Spuren trennen (Gesang, Schlagzeug, Bass) | `StemsPanel`, `separation.ts` | 2/7b | Test | offen |
| W09 | Tonart, Tempo, Akkorde, Melodie als MIDI | `HarmonyPanel`, `key.ts`, `midi.ts` | 2/7b | `verify:harmony`, `:tempo` | offen |
| W10 | Zerschneiden: sechs Verfahren, Pads, Pattern, Klavierrolle | `SamplerPanel`, `chop.ts`, `pattern.ts` | 7c | Test, Hörprobe | offen |
| W11 | Mikrofon: Test, Geräte, Kalibrierung, Kette mit Zahlen, Vorher/Nachher | `MicPanel`, `micCalibrate.ts` | 7b | Test | offen |
| W12 | Bildschirm aufnehmen (mit Ton des Rechners, Fenster oder Schirm) | `ScreenPanel`, `screenRecord.ts` | 7b | Klicktest | offen |
| W13 | Lokale KI: Modelle laden, Fortschritt, Hugging Face nur auf Hinweis | `localAi.ts`, `onnx.ts` | 2 | Test | offen |

## Windows-Teil, Betrieb, Verteilung

| ID | Funktion | Bestand | Welle | Prüfung | Stand |
| --- | --- | --- | --- | --- | --- |
| B01 | Installer für alle Benutzer, Eintrag in Apps & Features, stille Installation | `installer.nsh` | 8 | Workflow | offen |
| B02 | Portabel (Daten daneben, anderer Port, keine Registrierung) | `build-desktop.mjs` | 8 | Workflow | offen |
| B03 | Microsoft-Store-Paket (MSIX), Store-Fassung ohne eigenen Updater | `build-desktop.mjs --store` | 8 | Workflow | offen |
| B04 | Arm64 | Workflow | 8 | Workflow | offen |
| B05 | Automatische Updates (`latest.yml`, Fortschritt, „Auf x.y.z aktualisieren“) | `updater.mjs`, `AppUpdate` | 8 | Workflow | offen |
| B06 | „Öffnen mit Sondra“, Dateiendungen `.sondra` und `.sondra-liste` mit Logo | `installer.nsh` | 8 | Workflow | offen |
| B07 | Einzel-Instanz, zweiter Start reicht Dateien weiter | `electron.mjs` | 1/8 | Test | offen |
| B08 | Offline: alles nach dem ersten Besuch | `coi-serviceworker.js` | 8 | Test | offen |
| B09 | Datenschutz, Lizenzen (FFmpeg, scrcpy, Tango, Modelle), Changelog | `public/` | 8 | `verify:scrcpy` u. a. | offen |
| B10 | Daten der Electron-App übernehmen (Sitzung, Einstellungen, Lesezeichen) | `localStorage`, IndexedDB | 8 | Test mit echten Daten | offen |

## Neu im nativen Sondra (kein Bestand)

| ID | Funktion | Welle | Prüfung | Stand |
| --- | --- | --- | --- | --- |
| N01 | Neue Folgen automatisch laden, je Serie wählbar, feste Zahl auf Vorrat | 0/1 | Testdateien der Website | **nativ ✔** (`sondra-dienst laufen`; gegen nachgebaute Seiten) |
| N02 | Speichergrenze: gesehene Folgen in den Papierkorb, nie eine ungesehene | 0/1 | `sondra-core` Tests | **nativ ✔** (Papierkorb: `trash`-Paket, auf Windows in der CI) |
| N03 | Zeitfenster, nur am Netzteil, nur ohne getaktete Verbindung, Bandbreitengrenze | 0/1 | `sondra-core` Tests | **nativ ✔** (Papierkorb: `trash`-Paket, auf Windows in der CI) |
| N04 | Rechner wach halten (aus, beim Laden, immer), Herunterfahren nach dem Laden | 0/1 | Test auf Windows | **nativ ✔** — Wachhalten und Herunterfahren (60 s zum Zurücknehmen); Windows-Aufrufe in der CI geprüft, echter Schlaf nicht |
| N05 | Dienst im Tray, startet mit Windows | 1 | Test auf Windows | **in Arbeit** — Autostart (HKCU Run) und eine Instanz je Ordner da; Tray und Benachrichtigungen offen |
