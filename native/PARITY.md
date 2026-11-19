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
| R02 | Reiterleiste: 6 einzelne, 3 Gruppen, „Mehr“ bei Platzmangel, Pfeiltasten | `PanelTabs`, `panelMeta` | 3 | Tabellen gegen `panelMeta.tsx` (golden); Klicktests im GPUI-Fenster (Gruppenmenü, Mehr, gewähltes bleibt, Escape); Job `app` über UI Automation. **Pfeiltasten zwischen den Reitern und Bewegung fehlen noch** | in Arbeit |
| R03 | Startseite: Einstieg, „Datei auswählen“, „Von Adresse laden“, Filme und Serien, Werkzeug-Kacheln mit Filter | `Home` | 3 | die 50 Kacheln und die Suche sind die der Website (golden, gleiche Treffer in gleicher Reihenfolge); Tests im GPUI-Fenster; Bildschirmfoto aus Job `app`. **Kacheln ohne Symbole (ein Buchstabe), „Projekt laden“, Sitzungsdateien und „Heute weiterschauen“ fehlen** | in Arbeit |
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
| M02 | Serie hinzufügen mit einem Feld; „Wie weit sind Sie?“; „Mehr Angaben“ | `AddDialog` | 4 | `sondra-app/tests/merkliste.rs`, UIA „Serie eintippen“ auf Windows | **teilweise nativ ✔** (ein Feld, Enter; „Wie weit sind Sie?“ und „Mehr Angaben“ offen) |
| M03 | Staffeln, Teile, Filme, Folgenzahlen, Gesehenes, „Stand“ rückt weiter (`settle`) | `merkliste.ts` | 4 | `sondra-merk`: 57 Einträge aus ungewöhnlichen Formen, Fortschritt, Teile, Abhaken, `settle` — dieselben Zahlen wie die Website (golden) | **Logik nativ ✔**, Oberfläche offen |
| M04 | Cover mit Ausschnitt und Zoom, Pyramide beim Verkleinern | `CoverImage` | 4 | Bildvergleich | **nativ ✔ (Kachel und Liste)** — `covers`: der Ausschnitt wie in `drawCover` (Mitte, Fokus, Zoom, nie über den Rand), Halbierungen, dann Lanczos auf das Mass der Kachel (doppelte Punkte für ein scharfes Bild), im Hintergrund, einmal je Mass; Adressen im Netz und Daten-URLs; Bilder aus Dateien reisen nicht in der Liste (Website-Regel) und bleiben auf dem Gerät, in der nativen App also ohne Bild; offen: der Ausschnitts-Editor, Bilder auf der Serienseite und für Staffeln |
| M05 | Stände (Am Schauen, Später, Pausiert, Fertig, Abgebrochen), Filter | `MerklistePanel` | 4 | `sondra-merk::view` (Filter, Abschnitte, Zähler) und `sondra-app/tests/merkliste.rs` im echten Fenster; UIA auf Windows | **teilweise nativ ✔** (Liste, Pillen, Suche ab sechs; Tags und „nur offene“ als Logik, noch ohne Knopf) |
| M06 | Ansicht als Poster oder Liste, Sortierungen | `MerklistePanel` | 4 | Liste ✔ (`merk_row`); Poster-Ansicht und Sortierung nur als Logik (`Sort`) | offen |
| M07 | Serienseite: abspielen, gesehen, bearbeiten, „Mehr“ | `MerklistePanel` | 4 | `sondra-app/tests/merkliste.rs`: Seite einer Serie (Staffeln, Folgen abhaken, Umschalt, Länge, Stand, Entfernen mit Rückgängig); „Abspielen“ und „Mehr“-Inhalte offen | **teilweise nativ ✔** (gesehen, Bearbeiten des Stands, entfernen; abspielen mit dem Player) |
| M08 | „Bis wohin?“ Planer, Ziel merken, Tempo aus dem Verlauf | `watchPlan`, `WatchPlanner` | 4 | `sondra-merk`: über 500 Pläne (Ziele × Optionen), Tempo, Ziel, Beschriftungen gegen die Website, in Europe/Zurich über die Zeitumstellungen (golden) | **Logik nativ ✔**, Oberfläche offen — Oberfläche nativ ✔: Block „Bis wohin?“ auf der Serienseite (Ziele Ende Staffel / Ganze Serie, Tempo, ohne Vorspann, Tempo am Tag mit Datum, eigenes Tempo); offen: Ziel merken, Datum wählen, „Genauer rechnen“ |
| M09 | Statistiken und Rückblick, Verlauf, Würfeln | `MerklisteRecap` | 4 | `sondra-merk`: Statistik, Sortierungen (deutsche Ordnung wie im Browser), Rückblick, Würfel-Auswahl, Plan bis zum Ende, Swiss-Zahlen — gegen die Website | **Logik nativ ✔**, Oberfläche offen — Fenster „Statistik und Rückblick“ nativ ✔ (Zahlen, Jahr wählen, Monatsbalken, Spitzenreiter); offen: Verlauf, Würfeln, Bild zum Teilen |
| M10 | Teilen: Link, Text, QR, Datei, Bilder im Link, Teile; Empfangen und Vergleichen | `merkShare`, `shareCover`, `qr` | 4 | `sondra-merk`: Packen Byte für Byte wie die Website, Links/Dateien/Teile/Text/Vergleich gegen sie, und die Website öffnet, was nativ geschrieben wird (CI). **Offen:** QR-Code zeichnen, Bildchen aus Covern herstellen (klein/gross), Oberfläche | in Arbeit |
| M11 | Export und Einlesen (JSON, MAL, AniList), Zusammenführen, Rückgängig | `merkliste.ts` | 4 | `sondra-merk`: Einlesen aus SQLite, JSON, MAL-XML und AniList-JSON in allen Formen (mit den Sätzen der Fehler), `merge_merkliste`, Tags, Verlauf — gegen die Website; **offen:** Rückgängig, Oberfläche | in Arbeit — Oberfläche nativ ✔: „Mehr“ → Exportieren (SQLite in Downloads/Sondra) und Einlesen … (SQLite, JSON, MAL, AniList; zusammenführen, nichts doppelt, Zurücknehmen) |
| M12 | Zusammenführen mit Drive (`mergeShared`), Entfernen bleibt entfernt | `merkliste.ts`, `googleDrive.ts` | 4 | `sondra-merk`: `merge_shared`, `take_shared`, `travelling`, `shared_key` gegen die Website (5 Abgleiche mit Entfernungen, Bildern von Dateien, gleichen Namen); **noch nicht gegen das echte Drive** | **Logik nativ ✔**, Anbindung offen |
| M13 | Abgleich mit Anytype (v1 und v2, Space, Seite „Sondra · Merkliste“) | `anytype.mjs`, `anytype.ts` | 4 | `verify:anytype` | offen |
| M14 | Discord-Status über die lokale Pipe | `discord.mjs` | 4 | `verify:discord` | offen |
| M15 | Neue Folgen melden (alle 3 Stunden, Benachrichtigung, Klick öffnet die Serie) | `newEpisodes.ts` | 1 | `verify:extractors`, `:resolve` | offen |
| M16 | AniList und MAL: Fortschritt abgleichen | `anilist.ts` | 4 | Test | offen |
| M17 | Ordner erkennt Serien (zwei Folgen genügen), „Auf die Merkliste“ | `folder.ts` | 4 | `sondra-merk::folder::find_new_series` und `series_to_merk_item` gegen die Website | **Logik nativ ✔**, Oberfläche offen |

## Ordner

| ID | Funktion | Bestand | Welle | Prüfung | Stand |
| --- | --- | --- | --- | --- | --- |
| O01 | Dateien eines Ordners als Kacheln oder Liste, Vorschaubilder, lange Ordner in Seiten | `FolderPanel`, `thumbnails` | 4 | `sondra-merk::folder` (Ansichten, 360) und `scan` (echte Ordner auf der Platte); `sondra-app/tests/folder_page.rs`; UIA auf Windows; **Kacheln mit Vorschaubildern offen** — es gibt Zeilen | **teilweise nativ ✔** (Liste, 240 je Seite) |
| O02 | Art, Suche (auch Unterordner), natürliche Sortierung, Tiefe | `folder.ts` | 4 | `sondra-merk::folder` gegen die Website (golden): Art, Suche ohne Akzente, natürliche Sortierung, Tiefe, Unterordner-Summen | **Logik nativ ✔**, Oberfläche offen |
| O03 | Auswählen wie im Dateimanager, Abspielen, In die Sitzung, ZIP, In Drive, Löschen | `FolderPanel` | 4 | `sondra-app/tests/folder_page.rs`: Auswählen (Klick, Strg, Umschalt), Löschen nach Rückfrage; Abspielen, In die Sitzung, ZIP, In Drive offen | **teilweise nativ ✔** |
| O04 | Papierkorb von Sondra (verschieben, rückgängig, ansehen, endgültig löschen) | `FolderBin`, `folder.ts` | 4 | `sondra-merk::bin` (verschieben, Notiz, zurücklegen ohne Überschreiben, ansehen, endgültig; eine Notiz aus dem Ordner heraus wird nie befolgt) und die Fenster in `folder_page.rs`; UIA mit echten Dateien auf Windows | **nativ ✔** |
| O05 | Untertitel im Ordner: Datei mit gleichem Namen, sonst Whisper erzeugt `Name.srt` | `autoSubtitles`, `FolderSubtitles` | 4 | `sondra-merk::subtitles` (welche Datei gehört zum Film, wie heisst die erzeugte) gegen die Website; Whisper offen | **Namen nativ ✔**, Rest offen |
| O06 | Weiterschauen, „Nach Serie“, „Ungesehen“, „Neu“, Merkliste spielt aus dem Ordner | `folderLibrary.ts` | 4 | `verify:folder` | offen |
| O07 | Doppelte finden (Größe, Hash, 32 Stellen) | `duplicates.ts` | 4 | `sondra-merk::duplicates`: Kopiermarken, Behalten-zuerst, Gruppen, die echten SHA-256-Schlüssel (ganz und an 32 Stellen, 33-MB-Datei) wie die Website; Oberfläche offen | **Logik nativ ✔**, Oberfläche offen |
| O08 | Ansicht je Ordner, zuletzt geöffnete Ordner, gemerkter Ordner | `folderMemory.ts` | 4 | `sondra-merk::folder_memory` (9 Abläufe) gegen `folderMemory.ts`; `FileStore` und der angebotene letzte Ordner in `folder_page.rs`; „Neu seit dem letzten Besuch“ und „zuletzt geöffnet“ offen | **teilweise nativ ✔** |
| O09 | Ordner aus Drive, Löschen in Drive, In Staffel einordnen, „Einordnen“ mit einem Klick | `driveClient.ts`, `SeasonFiling` | 4 | Szenario „serien“ | offen |
| O10 | Bedienung mit dem Finger (Tipp, langes Drücken, Blatt) | `FolderPanel` | 4 | Entscheidung, ob Touch gebraucht wird | **Entscheidung** |

## Abspielen und Herunterladen

| ID | Funktion | Bestand | Welle | Prüfung | Stand |
| --- | --- | --- | --- | --- | --- |
| P01 | Wiedergabe von Video und Musik, Steuerung auf dem Bild, Verlauf, Ausblenden | `PlayerPanel` | 5 | `sondra-playback` (echte Dateien, echtes FFmpeg: Uhr, Bild wartet auf den Ton, Pause, Sprung, Tempo, Ende), `sondra-app/tests/player_page.rs`, UIA mit einem Film auf Windows; **Steuerung auf dem Bild und Ausblenden offen** (die Leiste steht unter der Bühne) | **teilweise nativ ✔** |
| P02 | Einstellungen: Qualität, Tempo, Untertitel, Tonspur, Bild, Ton (bis 300 %, Nachtmodus), Wiedergabe | `SettingsMenu` | 5 | Tempo, Lautstärke, Stumm, Wiederholen/Automatisch weiter (Logik `sondra-player::Settings` gegen die Website); Tonspur-Wahl, Untertitel (Datei neben dem Film, eingebaute Textspuren, Schriftgrösse, Grund) im Fenster „Ton und Untertitel“ (Test mit echtem Film); Fenster „Bild und Ton“: Einpassen/Füllen/Strecken, Helligkeit, Kontrast, Sättigung, Spiegeln (FFmpeg-Filter, am echten Bild gemessen), Verstärkung bis 300 %, Nachtmodus (Kompressor mit den Werten der Website); Qualität, Entzerrer, Karaoke, Bild-Untertitel offen | **teilweise nativ ✔** |
| P03 | Größen: neben der Liste, Kino, fensterfüllend, Vollbild, Bild-in-Bild | `PlayerPanel` | 5 | Test mit dem Fenster der CI: Normal, Kino (T), Fenster füllen (W, Esc), Vollbild (F; das Fenster wird einmal gefragt, verlässt es den Vollbildmodus von selbst, folgt die Größe), Steuerung über dem Bild blendet nach 4 s aus (Maus oder Taste holt sie, Mauszeiger weg); Bild-in-Bild offen | **teilweise nativ ✔** |
| P04 | Vorspann überspringen (fest und am Ton erkannt), Nächste Folge | `player.ts`, `introPrint` | 5 | `sondra-player`: Wann „Vorspann überspringen“ und „Nächste Folge“ angeboten werden (gegen die Website); Erkennung am Ton `sondra-media::intro`; Knöpfe im Player offen | **Logik nativ ✔** |
| P05 | Schlaf-Timer, Lesezeichen, Weiter bei, Kapitel kopieren | `player.ts` | 5 | `sondra-player`: Schlaf-Timer-Fade, Lesezeichen (säubern, hinzufügen, Nachbarn, Kapitel), Stelle je Datei (die letzten fünfzig) gegen die Website; „Weiter bei“ im Player ✔; Lesezeichen und Schlaf-Timer als Oberfläche offen | **teilweise nativ ✔** |
| P06 | Abhaken in der Merkliste ab 90 % | `episodeMatch`, `MerklisteTick` | 5 | Test: Name → Serie/Staffel/Folge, ab 90 % abgehakt, nur in derselben Datei, „Rückgängig“ | **nativ ✔** |
| P07 | Fremde Formate abspielen (umpacken, Ton wandeln, klein neu rechnen) | `playable.ts` | 5 | Test mit AVI (MPEG-4/MP3) und MKV (H.264/AC-3) gegen echten FFmpeg: spielt, ohne Vorschau — das natives FFmpeg braucht kein Umpacken | **nativ ✔** |
| P08 | Streamen aus Drive mit Bereichsanfragen | `driveClient.ts` | 5 | Szenario „drive“ | offen |
| P09 | „Beim Minimieren pausieren“ | `pauseOnMinimize.ts` | 5 | Test: aus, bis der Schalter an ist (Fenster „Bild und Ton“, gleicher Schlüssel wie die Website); dann hält ein minimiertes Fenster (Windows: `IsIconic`, zweimal je Sekunde gefragt) an und fängt nicht von selbst wieder an — das Minimieren selbst nur in der CI auf Windows geprüft, nie von Hand | **nativ ✔** (Windows-Teil ungeprüft) |
| P10 | Film läuft hinter anderen Werkzeugen weiter, kleine Leiste | `Dashboard` | 5 | Test: der Film läuft hinter anderen Werkzeugen weiter, die kleine Leiste (Name, Stelle, Pause, „Zum Player“) steht unten rechts | **nativ ✔** |
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
| G01 | Gerätekennung aus dem öffentlichen Schlüssel, signierte Einträge, Fälschungen abgelehnt | `deviceIdentity.ts` | 6 | `verify:devices` | **nativ ✔** — `sondra-devices` (ECDSA P-256 mit `p256`): Kanonische JSON, Kennung, Namen, signierte Einträge und Nachrichten, Fälschungen, Wiederholung, Alter; Einträge und Nachrichten der Website (echtes WebCrypto) werden geglaubt, Fälschungen nicht; was die Crate schreibt, glaubt die Website (`npm run verify:native-devices` in der CI); der private Schlüssel wird noch nirgends geschützt abgelegt (Windows: Anmeldeinfo-Versiegelung folgt mit der Seite) |
| G02 | Post über Drive, Namen eindeutig, Wiedererkennen nach Neuinstallation | `devices.ts` | 6 | `verify:devices` | offen |
| G03 | Direkte Übertragung (WebRTC), Flusskontrolle, Annehmen und Ablehnen | `deviceTransfer.ts` | 6 | Austausch mit der Website | **Protokoll nativ ✔, Leitung offen** — `sondra-devices::transfer`: Absender und Empfänger über eine `Wire`-Schnittstelle (Nachrichten `start`/`ready`/`file`/`end`/`done`/`ack`/`saved`/`cancel`/`error` als dasselbe JSON, Stücke zu 64 KB, Quittung alle 4 MB, höchstens 16 MB voraus), mit zwei Warteschlangen im Speicher gegen die Szenarien der Website geprüft (ganz und in Reihenfolge, langsamer Empfänger hält den Absender zurück, Abbruch von beiden Seiten); der Datenkanal (WebRTC, `webrtc-rs`) fehlt noch |
| G04 | Ordner senden, Fortsetzen nach Abbruch, drei Übertragungen zugleich | `deviceTransfer.ts` | 6 | Szenario „geraete“ | **Fortsetzen und Pfade nativ ✔ (ohne Leitung)** — Fortsetzen nach gekappter Leitung: der Empfänger hält ganze und halbe Dateien (`Piece`, „noch wie hinterlassen“), der Absender schickt nur den Rest, ein verändertes Stück beginnt von vorn; Ordnerpfade bereinigt (`split_path`, kein `..`, acht Ebenen), freier Name; „Ordner senden“ in der Oberfläche und drei Übertragungen zugleich offen |
| G05 | Text und Links senden; auf anderem Gerät abspielen | `devices.ts` | 6 | Szenario „geraete“ | offen |
| G06 | Weg über Drive, eigener STUN/TURN-Server, Fähigkeiten (`caps`) | `deviceServers.ts` | 6 | `verify:devices` | offen |
| H01 | Handy spiegeln: ADB über USB, scrcpy-Server 3.3.3, H.264, Maus, Tasten | `phoneMirror.ts` | 6 | **gegen ein echtes Handy** | offen |
| H02 | UHID-Tastatur, Ton des Handys, Bildschirmfoto, eigenes Fenster | `hidKeyboard.ts`, `phoneAudio.ts` | 6 | `verify:hid`, echtes Handy | offen |
| GD1 | Google-Anmeldung (Systembrowser, PKCE), Token verschlüsselt, Trennen | `googleDrive.mjs` | 1 | `verify:drive`, `:google-token` | **nativ ✔** (gegen nachgebautes Google; nie gegen das echte; Windows: Anmeldeinfo-Verschlüsselung gebaut, auf Windows noch nicht gelaufen) |
| GD2 | Ordner „Sondra“ in Drive, Hochladen (5 MB / 8-MB-Stücke), Projekte, Merkliste | `googleDrive.ts` | 1 | `verify:drive` | offen |

## Werkzeuge

| ID | Funktion | Bestand | Welle | Prüfung | Stand |
| --- | --- | --- | --- | --- | --- |
| W01 | Umwandeln: alle Formate, Vorlagen (WhatsApp, Reel, Hörbuch, E-Mail), eigene Vorlagen, Stapel, ZIP | `ConverterPanel`, `convert.ts` | 2/7a | `verify:convert` | **Kern nativ ✔** (`sondra-media`: alle Formate und Vorlagen mit dem echten FFmpeg, Befehle gleich der Website; Stapel, ZIP, eigene Vorlagen und die Oberfläche offen) |
| W02 | Lautstärke: Lautheit messen und angleichen, Stapel | `NormalizePanel`, `loudness.ts` | 2/7a | `verify:loudness` | **Kern nativ ✔** (Messung und Verstärkung wie die Website auf 8 Signalen und 6 Plänen; das Rechnen der Datei und die Oberfläche offen) |
| W03 | Bilder: skalieren, zuschneiden, umwandeln, viele auf einmal | `ImagePanel`, `image.ts` | 2/7a | Bildvergleich | **Kern und Seite nativ ✔, Ausschnitt noch ohne Ziehen** — `sondra-media::image_ops` (Reihenfolge und Rechnung der Website, Ausschnitt in Bruchteilen, mitdrehen und mitspiegeln; FFmpeg-Filter statt Canvas: Helligkeit, Kontrast, Sättigung, Weichzeichnen, Schärfen als 3×3-Faltung), Seite „Bilder“ (Bühne aus derselben Kette wie die Datei, Werkzeuge Ausschnitt nach Seitenverhältnis, Drehen, Größe, Farbe, Schärfe, Speichern als WebP/JPEG/PNG, viele auf einmal); offen: freier Ausschnitt mit Griffen, ZIP für viele, Größe der Datei vorab messen, EXIF-Drehung gegen die Website |
| W04 | Untertitel: Whisper, TXT/SRT/VTT, als Spur oder eingebrannt | `SubtitlesPanel`, `transcribe.ts` | 2/7a | Test | offen |
| W05 | Video-Editor: schneiden, drehen, Farbe, Blenden, Tempo, Ton; große Dateien | `VideoPanel`, `video.ts` | 2/7c | Szenario | **Kern nativ ✔, Seite ohne Zeitleiste** — `sondra-media::video_ops`: 26 Befehlszeilen Argument für Argument gegen `video.ts` (Schnitt als Kopie oder Filter, Drehen, Ausschnitt, Größe, Farbe, Looks, Blenden, Tempo in Stufen, Rückwärts, WebM/VP8, GIF, WebP, Ton herausziehen, Standbild, Ton unterlegen), Seite „Video bearbeiten“ (Standbild-Bühne mit den Änderungen, Schnitt an der Stelle setzen, Werkzeuge, Fortschritt mit Abbrechen, neben das Original schreiben); offen: Abspielen der Vorschau mit den Änderungen, Zeitleiste mit Griffen, Ausschnitt ziehen, Wellenform |
| W06 | Ton-Editor: Studio, acht Werkzeuge, Filter, Rauschen, Hall, Tonhöhe, Tempo, Blenden | `AudioEditorPanel`, `effects.ts` | 2/7b | Test, Hörprobe | offen |
| W07 | Mischen: Stimme und Musik, Ducking | `MixPanel`, `duck.ts` | 2/7b | Test | **nativ ✔** — `sondra-media::duck` Zahl für Zahl gegen `duck.ts` (vier Fälle: Schwelle, Sprache, Verstärkung je 10 ms, Abtastwerte, Spitze und Abzug), Seite „Stimme und Musik mischen“ (Einstellungen als Stufen, neu gemischt bei jeder Änderung, Pegel von Stimme und Musik, WAV 24 Bit, Einzelspuren in einen Ordner, unter ein Video legen); Hörprobe in der Mischseite offen (Abspielen im Player nach dem Speichern) |
| W08 | Spuren trennen (Gesang, Schlagzeug, Bass) | `StemsPanel`, `separation.ts` | 2/7b | Test | offen |
| W09 | Tonart, Tempo, Akkorde, Melodie als MIDI | `HarmonyPanel`, `key.ts`, `midi.ts` | 2/7b | `verify:harmony`, `:tempo` | **nativ ✔** — Seite „Tonart und Akkorde“ (Datei wählen, Akkordfenster, Melodie verfolgen mit Klarheit, kürzester Note und Raster; Tonart, Camelot, Tempo, Akkorde, Melodie; MIDI für Akkorde, Melodie oder beides neben die Quelle); Test mit echtem FFmpeg und gesynthetem Akkord und Tonleiter |
| W10 | Zerschneiden: sechs Verfahren, Pads, Pattern, Klavierrolle | `SamplerPanel`, `chop.ts`, `pattern.ts` | 7c | Test, Hörprobe | **Planer nativ ✔** — `sondra-media::chop` (Spektralfluss einmal je Datei, sechs Verfahren, Bereich, Vorlauf, Nulldurchgang, Zusammenlegen zu kurzer Teile, Deckel 128) gegen `chop.ts` auf 19 Plänen eines Schlagzeug-Stücks; Pads, Pattern, Klavierrolle und die Seite offen |
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
