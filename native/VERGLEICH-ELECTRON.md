# Electron-Sondra gegen Rust-Sondra: was nativ wirklich fehlt

Stand 21.11.2026. Für jede Seite wurde nachgesehen, was im Code steht: die Bedienelemente der Website (`src/components/…`), die auch die Electron-App zeigt, Text für Text gegen `native/` gesucht, und dann im Rust-Code nachgesehen, ob die Funktion unter anderem Namen da ist. `PARITY.md` war dafür nur der Ausgangspunkt. Mehrere ihrer Zeilen sind veraltet, in beide Richtungen.

**Wie sicher ist das?** Alles hier stammt aus dem Lesen des Codes. Keine der beiden Apps wurde für diesen Vergleich von Hand durchgeklickt. „Fehlt“ heisst: im Rust-Code gibt es dafür weder einen Knopf noch eine Taste noch einen Aufruf. „Nur Logik“ heisst: die Rechnung steckt in einer Rust-Bibliothek und ist gegen die Website geprüft, aber in der Oberfläche kommt man nicht dran.

Legende: **✗ fehlt** · **◐ teilweise** · **⚙ nur Logik, keine Oberfläche** · **— entfällt bewusst**

---

## 1. Rahmen, Start, überall

| | Funktion in Electron | Rust |
| --- | --- | --- |
| ✓ | **Tastenkürzel in den Werkzeugen**: Strg+Z / Strg+Umschalt+Z (Ton-Editor, Video, Bilder), Strg+X/C/V und die Leertaste im Ton-Editor, die Leertaste im Zerschneiden-Pattern, Entf für „Pad löschen“ | Nativ seit 22.11.2026, dazu T (Tempo klopfen) und +/− (Zoom) im Ton-Editor und die Tasten der Ordnerliste |
| ✓ | **Rückmeldung beim Ablegen**: „Loslassen zum Öffnen“ erscheint, solange eine Datei über dem Fenster gezogen wird | Nativ seit 22.11.2026, mit dem Satz, wohin die Dateien gehen; abgelegt wird jetzt im ganzen Fenster (vorher nur im Einstieg der Startseite): an das offene Werkzeug, in den Player, sonst wie „Öffnen mit“ |
| ✗ | Drive-Fenster mit der Ordnerübersicht (`Projekte`, `Dateien/Ton·Video·Bilder·Andere`, `Heruntergeladen`, `Merkliste`), **Warteschlange** der Uploads und **„Dateien der Sitzung nach Art“ hochladen** | Es gibt nur Anmelden/Trennen in der Seitenleiste und „In Drive“ einzeln bei jedem Ergebnis |
| ✗ | **Projekt in Drive speichern** („Google Drive verbinden, um das Projekt dort zu speichern“) | Ein Projekt lässt sich nur lokal speichern |
| ✓ | **„An Gerät“ neben jedem „In Drive“** (`DeviceSendButton`): ein Ergebnis direkt an ein anderes Gerät schicken | Nativ seit 22.11.2026: „An „Name““ je offenes Gerät (bis drei) neben „In Drive“ |
| ◐ | Hinweis „Neu in x.y.z“ nach einem Update, als Zeile unter der Kopfzeile | Ist da. Neu ist das Mitteilungsfach, die Zeile gibt es zusätzlich |
| — | „App herunterladen“ (Fenster mit den Reitern Windows/Android), FFmpeg-Anzeige „WASM/Nativ“, „Unter der Haube“ | Unnötig in einem Programm, das schon installiert ist |

## 2. Merkliste

### Liste
| | Funktion in Electron | Rust |
| --- | --- | --- |
| ✓ | **Filter nach Tags** (Pillen je Tag) | Die Logik ist da (`sondra-merk::view`), einen Knopf gibt es nicht |
| ✓ | **„Nur offene Folgen“**: nur Serien zeigen, bei denen noch etwas zu schauen ist | ⚙ nur Logik |
| ◐ | **Ordner-Pille über der Liste** („„Anime“ · 3 Serien darin“ / „Ordner mit Folgen wählen“) und „Google Drive einbeziehen“ | Die Merkliste weiss vom Ordner nur, was die Seite „Ordner“ zuletzt gelesen hat |
| ✓ | **▶ auf der Kachel** (die nächste Folge direkt aus dem Ordner) | Nativ seit 22.11.2026 |
| ✓ | **Status des Abgleichs unter der Liste**: „Nur auf diesem Gerät gespeichert“ / „Über Google Drive abgeglichen“ / „Gleicht mit Anytype ab …“ | Die Fenster für Drive und Anytype sagen es, die Liste selbst nicht |

### Serie hinzufügen und bearbeiten
| | Funktion in Electron | Rust |
| --- | --- | --- |
| ✗ | **„Mehr Angaben“ beim Hinzufügen**: Staffeln, Folgen je Staffel, Filme, Cover, Tags, Status | Es gibt ein Feld, „Wie weit sind Sie?“ und das Suchen bei AniList |
| ✓ | **„Bearbeiten“ einer Serie**, das ganze Formular: Titel, Adresse, Zahl der Staffeln, Folgen je Staffel, Filme, **Minuten je Folge und je Film**, **Ausnahmen je Folge**, Vorspannlänge der Serie, Tags, **Bewertung (Sterne)**, **Notiz**, „Gerade bei Staffel/Folge“ | Nativ seit 21.11.2026 (Fenster „Serie bearbeiten“): Name, Adresse, Bewertung, Tags, Notiz, Minuten je Folge und je Film, Vorspann, Cover (Adresse oder Bild vom Gerät), Format. Staffelzahlen, Ausnahmen und „Gerade bei“ stehen im Staffelfenster |
| ◐ | **Cover wählen**: aus einer Datei, über eine Adresse, „Cover & Staffeln abrufen“ (AniList) | Nativ seit 21.11.2026: Adresse oder „Bild vom Gerät“ (verkleinert auf 720 px). „Cover & Staffeln abrufen“ fehlt noch |
| ✗ | **Ausschnitt des Covers** (`FrameEditor`: ziehen, Pfeiltasten, Zoom mit Plus/Minus) | Gezeichnet wird der Ausschnitt, ändern kann man ihn nicht |
| ✓ | **Kachelformat je Serie**: Filmposter 2:3 oder Manga 5:7 | Nativ seit 21.11.2026 im Fenster „Serie bearbeiten“ |
| ◐ | **Teile einer Staffel** anlegen, benennen, mit eigenem Cover | „In Teile teilen“ nativ seit 21.11.2026; Teile benennen und eigene Cover fehlen noch |
| ◐ | **Cover je Staffel und je Teil** | Je Staffel nativ seit 21.11.2026 (Staffelfenster); je Teil noch nicht |

### Serienseite
| | Funktion in Electron | Rust |
| --- | --- | --- |
| ✓ | **Grosses Cover** im Kopf der Serie | Nativ seit 21.11.2026, dazu Quelle, „zuletzt …“, Stand, Sterne, Tags und Notiz |
| ◐ | **„Folge n laden“ / „Nächste Folgen laden …“** (übergibt Adresse, Staffel, Folge und Einstellungen an „Herunterladen“) | „Folge n laden“ nativ seit 21.11.2026 (unter „Mehr“, öffnet „Herunterladen“ mit der Adresse der Folge); „Nächste Folgen laden …“ fehlt noch |
| ✗ | **Als Stream abspielen** ohne Download („Folge sofort ohne vorherigen Download im Player abspielen“) | „Folge n abspielen“ gibt es nur, wenn die Datei im gelesenen Ordner liegt |
| ✗ | **Einstellungen je Serie zum Laden**: „Laden als“ (Video mit Ton / Nur Ton), Sprache (Deutsch synchronisiert, OmU, englische Untertitel, beste Fassung), Qualität (bis 4K, 320/192/128 kbps), „Untertitel dazu erstellen“ | — |
| ✓ | **„Online nach Neuem suchen“** als Knopf auf der Serie | Nativ seit 21.11.2026 unter „Mehr“ |
| ✓ | **„Im Ordner: Staffel 1: 1–3“** und im Staffelfenster der Strich unter jeder Folge, die im Ordner liegt | Nativ seit 22.11.2026 (ist die Zahl der Folgen unbekannt, reicht das Fenster so weit wie der Ordner) |
| ✓ | **„Als ungesehen markieren“** als eigener Befehl | „Rückgängig“ je Eintrag im Verlauf (wie auf der Website), dazu der zweite Klick auf ein Häkchen |

### Planer „Bis wohin?“
| | Funktion in Electron | Rust |
| --- | --- | --- |
| ✓ | **Ziel als Staffel + Folge** (nicht nur „Ende Staffel n“ / „Ganze Serie“) | — |
| ✓ | **„Als Ziel merken“** mit Anzeige an der Serie („Ziel: … noch 6 Folgen, 2 am Tag reichen · 1 vor dem Plan“) und auf dem Poster („Ziel · noch 6“) | ⚙ die Rechnung ist da |
| ✓ | **„Bis zum [Datum] → wie viel am Tag“** | — |
| ✓ | **„pro Woche“** statt „am Tag“ | — |
| ✓ | **„Genauer rechnen“**: von vorn, Tempo der Wiedergabe 1–2× | Nur „Ohne Vorspann“ ist wählbar |

### Statistik, Teilen, Austausch
| | Funktion in Electron | Rust |
| --- | --- | --- |
| ✓ | **Statistik als PNG speichern** | Nativ seit 22.11.2026 (900 × 500 wie auf der Website, mit Barlow gezeichnet) |
| ✓ | **„Zusammenfassung als Text kopieren“** (Statistik) | Nativ seit 22.11.2026 |
| ✓ | **Häkchen je Serie** im Fenster „Teilen“ (Rust wählt nur nach Stand oder genau eine Serie über „Empfehlen“) | Nativ seit 22.11.2026, mit „Alle“ und „Keine“ |
| ✓ | **Bilder im Link** (Winzig 6 × 9 / Klein / Gross, aus dem Cover-Ausschnitt) und die Angabe, was sie kosten | Nativ seit 22.11.2026 (Klein/Gross als JPEG unter derselben Grenze), mit „Ohne Bilder: … Zeichen; mit: …“ |
| ✓ | Hinweis „Erstellt mit Sondra“ in Text und Bild | Nativ seit 22.11.2026 |

## 3. Ordner

| | Funktion in Electron | Rust |
| --- | --- | --- |
| ✓ | **„Zuletzt geöffnete Ordner“** (Menü „Zuletzt“, fünf, auf der leeren Seite eine Taste je Ordner) | Nativ seit 22.11.2026 |
| ✓ | **„In die Sitzung“** für die Auswahl | Nativ seit 22.11.2026 (Dateien in Drive nicht, die Zeile sagt es) |
| ✓ | **„In Drive“** für die Auswahl (hochladen aus dem Ordner) | Nativ seit 22.11.2026, eine Datei nach der anderen, Fortschritt in der Zeile |
| ✓ | **„An Geräte senden“** für die Auswahl (mehrere Geräte auf einmal) | Nativ seit 22.11.2026: Menü mit jedem Gerät und „An alle n Geräte“ |
| ✓ | **„Untertitel erzeugen“** für die Auswahl (Whisper hört die Filme ab und schreibt `Name.srt` daneben) | Nativ seit 22.11.2026, mit Modell und Sprache des Werkzeugs „Untertitel“; ohne Modell der Weg dorthin. Nie gegen ein echtes Modell gelaufen |
| ◐ | Eine `.srt`/`.vtt` mit dem Namen des Films geht beim Abspielen aus dem Ordner von selbst mit | ⚙ die Zuordnung ist geprüft. Der Player findet die Datei neben dem Film selbst |
| ✗ | **„In Staffel einordnen“**: das Fenster für Drive-Dateien (Serie wählen oder neu, Staffel, Nummer je Datei, Vorschau des Zielordners, „Der Reihe nach nummerieren“) | Nur „Einordnen“ mit einem Klick für Dateien, die schon erkannt sind |
| ✓ | **Tastatur in der Dateiliste**: Pfeile, Leertaste, Strg+A, Escape | Nativ seit 22.11.2026, dazu Enter (abspielen) und Umschalt+Pfeil; in Kacheln gehen ↑/↓ wie ←/→ eine Datei weiter |
| ✓ | **„Neu einlesen“** | Ist da |
| ✓ | **Seiten automatisch nachladen** (`IntersectionObserver`: „Weitere … zeigen“ drückt sich 900 px vor dem Rand selbst) | Nativ seit 22.11.2026 (eine Marke vor dem Knopf, 900 px) |
| — | Bedienung mit dem Finger (Tippen, langes Drücken, Blatt von unten) | Gibt es auf einem Windows-Rechner nicht (`PARITY.md` O10) |

## 4. Abspielen

| | Funktion in Electron | Rust |
| --- | --- | --- |
| ✓ | **Einstellungen zur Wiedergabe in der Oberfläche**: „Automatisch weiter“, **Titel wiederholen / Liste wiederholen / Anhalten am Ende**, **Sprungweite** für ←/→, „Vorspann überspringen anbieten“ an/aus, **„In der Merkliste abhaken“ an/aus** | ⚙ Die Werte (`Repeat`, `auto_next`, `skip`, `skip_opening`) wirken im Player und werden gespeichert, **aber kein Knopf stellt sie um**. Bleibt nur, was voreingestellt ist |
| ✓ | **Vorspann am Ton erkennen** (zwei Folgen vergleichen, Fingerabdruck, je Datei merken; „Neuen Vorspann erkennen“, „Erkannten Vorspann vergessen“, „In dieser Folge nicht gefunden“) | Nativ seit 22.11.2026: „Bild und Ton“ → Wiedergabe → Am Ton erkennen; bis vier Abdrücke an der Serie, je Datei gemerkt (`sondra:abspielen:vorspann`), der Knopf springt ans Ende des gefundenen Vorspanns |
| ✓ | **Feste Länge des Vorspanns** einstellen (Zahnrad → Vorspann), **„Für diese Folge ausblenden“** | Nativ (feste Länge unter „Bild und Ton“, × neben „Vorspann überspringen“) |
| ✓ | **Tasten** S (Vorspann), N (Nächste Folge), P (Vorherige), C (Untertitel an/aus), **Umschalt + ←/→ zu den Lesezeichen** | ◐ Umschalt + ←/→ gibt es. S, N, P, C fehlen |
| ✓ | **A-B-Schleife** | Nativ seit 22.11.2026 unter „Bild und Ton“ → Wiedergabe |
| ✓ | **Standbild als Merkliste-Cover** („Als Cover festlegen“) | Nativ seit 22.11.2026 (bei einer Folge einer Serie der Merkliste, 720 px, JPEG) |
| ✓ | **„Im Ton-Editor öffnen“ / „Im Video-Editor öffnen“** aus dem Player | Nativ seit 22.11.2026: über die Sitzung, der Film hier hält an |
| ✓ | **Warteschlange bearbeiten**: „Als Nächstes“, „Aus der Liste nehmen“, „Vorheriges“ | Nativ seit 22.11.2026 („Zurück“ war schon da) |
| ✓ | **Untertitel-Datei von Hand laden** (.srt/.vtt über einen Dateidialog) | Nativ seit 22.11.2026 („Ton und Untertitel“ → „Datei laden …“) |
| ✓ | **Laufzeit/Restzeit umschalten** (Klick auf die Zeit) | Nativ seit 22.11.2026 |
| ✓ | **Kapitel auf der Zeitleiste** (aus der Datei) beim Darüberfahren | Nativ seit 22.11.2026: Striche auf der Zeitleiste, „Kapitel: …“ neben der Steuerung, die Liste unter „Lesezeichen“ zum Hinspringen |
| ✓ | Entzerrer: Electron hat eine eigene Schublade mit Fader-Ansicht und Listenansicht und einen Schalter zum Umgehen (Bypass) | Fünf Bänder als Regler, fünf Voreinstellungen und der Schalter An/Aus (der Bypass) im Fenster „Bild und Ton“ — keine eigene Schublade |
| ✓ | Kino, Fenster füllen, Vollbild, Bild im Bild, Immer im Vordergrund, Qualität, Tonspur, Untertitel (Grösse, Grund), Bild (Einpassen/Füllen/Strecken, Helligkeit, Kontrast, Sättigung, Spiegeln), Verstärkung bis 300 %, Nachtmodus, Karaoke, Visualizer, Schlaf-Timer, Lesezeichen, Kapitel kopieren, Weiter bei, Abhaken ab 90 % | nativ da |

## 5. Herunterladen

| | Funktion in Electron | Rust |
| --- | --- | --- |
| ✓ | **„Was laden“**: Video mit Ton / Nur Ton / Ton aus dem Video | Geladen wird, was die Quelle liefert |
| ✓ | **Qualität**: Video beste / mittel / „wenn es das Video nur grösser gibt“, Ton verlustfrei / hoch / Standard / tiefer, AAC 256k, PCM | Nativ: Video Beste/4K/1080p/720p/480p/360p (gibt es nur grösser, kommt das Nächstkleinere), Ton 320/192/128 kbps oder verlustfrei |
| ✗ | **„Direktdateien anpassen“** oder 1:1 übernehmen | — |
| ✓ | **AniWorld-Sprache**: Ger-Dub, Ger-Sub (OmU), Eng-Sub, Auto | Rust nimmt die erste verfügbare Fassung |
| ✓ | **Dateinamen**: wie eine Office-Datei / neutral (`media_…`) / nur Zeichen | — |
| ✗ | **„Wie viele gleichzeitig laden“** | — |
| ◐ | **Was danach geschieht**: in die Sitzung legen, „Sofort als Datei speichern & zusätzlich in die Sitzung“, **direkt in Google Drive (ohne Sitzung)**, **„Nach Download sofort im Player abspielen“**, **„Stream sofort abspielen“** (abspielen, während geladen wird) | Nativ seit 22.11.2026: „In die Sitzung legen“, „Sofort abspielen“, „Untertitel erstellen“, „Direkt in Google Drive“ (die Datei liegt immer auch im Download-Ordner). „Stream sofort abspielen“ fehlt noch |
| ✓ | **„Untertitel erstellen“ nach dem Laden** | Nativ seit 22.11.2026 (über das Werkzeug „Untertitel“) |
| ✗ | **„Auf die Merkliste setzen“** mit Staffel, Folge und Einstellungen | — |
| ✗ | **Folgenwähler**: „Staffel und Folge wählen“, „Stelle in der Liste wählen“, „Die ganze Staffel laden“, „Alle Filme laden“, „Ganz gesehen“ | ◐ Es gibt „Alle laden“ und die Quellen einzeln |
| ✓ | **„Zuletzt geladen“** (Verlauf) | Nativ seit 22.11.2026: die letzten 30, mit Abspielen, Im Ordner zeigen, Wieder laden, Liste leeren |
| ✗ | **Netzwerkadapter wählen** („Netzwerk: Automatisch (Windows-Standard)“) | — |
| ✓ | **Eine Datei mit Links ablegen** („Loslassen, um die Links aus der Datei zu übernehmen“) | Nativ seit 22.11.2026: .txt/.m3u/.csv ablegen oder „auswählen“ |
| ✓ | **Hinweis auf erlaubtes Laden** („Bitte nur laden, was erlaubt ist“) | Nativ seit 22.11.2026 |
| — | Brücke im Terminal, cobalt-Dienst, „Weitere Wege“, YouTube-Sperre im Browser | Unnötig: yt-dlp liegt jetzt dem Setup bei |

## 6. Werkzeuge

### Umwandeln
- ◐ **Ausschnitt**: Start- und Endzeit (nativ seit 22.11.2026), „Ausschnitt vorhören“ fehlt noch
- ✓ **Video-Einstellungen in der Oberfläche** (nativ seit 22.11.2026): Qualität (CRF), Geschwindigkeit/Preset („Langsamer heisst kleiner“), Höhe („Wie Quelle“, 1080, 720 …), **Hochformat 9:16**, **Bildrate**. ⚙ `sondra-media::convert` kennt alle Felder, die Oberfläche bietet nur Vorlage, Format und die Bitrate für Ton
- ✓ **Ton**: variable Bitrate, Bittiefe (16/24/32 Float) (nativ seit 22.11.2026)
- ✓ **„Was FFmpeg gemeldet hat“** und **„Welcher Befehl dabei läuft“** (nativ seit 22.11.2026), aufklappbar bei einem Fehler
- ✗ Größe gegenüber der Quelle („Gegenüber Quelle“)

### Video
- ✓ **Wellenform** auf der Zeitleiste (nativ seit 22.11.2026)
- ✓ **Rückgängig / Wiederholen** (Strg+Z) (nativ seit 22.11.2026)
- ✓ Vorschau des Bildes beim Ziehen von Anfang und Ende (nativ seit 22.11.2026, höchstens alle 150 ms ein Standbild)
- ✓ Schnitt, Drehen, Spiegeln, Ausschnitt, Größe, Farbe, Looks, Schärfen, Entrauschen, Stabilisieren, Blenden, Tempo, Rückwärts, Ton unterlegen, Ton herausziehen, GIF, WebP, Standbild

### Ton-Editor
- ✓ **Datei hinten anfügen** (mit Überblendung)
- ✓ **Zoomen** (Mausrad, Umschalt + Mausrad schiebt)
- ✓ **„Ausschnitt behalten“** (alles andere weg) und **„Neu aus Auswahl“**
- ✓ **Einfügen „Am Ende“ / „An der Abspielstelle“ / „Auswahl ersetzen“** (nativ seit 22.11.2026, der Knopf sagt, was er tut, und wie lang die Zwischenablage ist)
- ✓ **In Schleife spielen**
- ✓ **Tempo klopfen** (T)
- ✓ **3-Band-Entzerrer** (Bässe 120 Hz, Mitten 1 kHz, Höhen 6 kHz als Regler), dazu Hoch-/Tiefpass und Kompressor als Regler wie auf der Website (nativ seit 22.11.2026)
- ✓ **„Aus der Auswahl lernen“** (Rauschprofil von einer gewählten Stelle: „Rauschen lernen“ mit Auswahl; „Lokale KI“ findet die Stelle selbst)
- ✓ **Stille entfernen mit Schwelle** (−25 / −45 / −60 dB)
- ✓ **„Zurück zum Original“**
- ✓ **Tastenkürzel** (Leertaste, Strg+X/C/V/Z)

### Zerschneiden (Pads und Pattern)
- ✓ **Pattern-Plätze A–D** mit „Aktuelles Pattern in den nächsten Platz kopieren“, **Song-Kette** (+A … +D, Block entfernen), Ausgabe 1×/2×/3×/4×/8×; „Noten zurück in Schritte“ (in der Klavierrolle)
- ✓ **„Einstellungen des gewählten Pads auf alle übertragen“**
- ✓ **Doppeltes / halbes Tempo** (Raster: Tempo-Pillen halb/erkannt/doppelt), **„Das ganze Raster früher oder später“** (−40 … +40 ms)
- ✓ **„Länge beim Transponieren halten“** (Phasenvocoder beim Export, `pattern::export_pad`)
- ✓ **Pad löschen (Entf)**, **„Ganze Datei als Pad 1“**, **„Am Zeiger teilen“** (Zeiger = letzter Klick in die Welle, beim Abspielen eines Pads die Stelle); Doppelklick fehlt
- ✓ **Auf −0,3 dBFS normalisieren** beim Export, **„Blende an den Schnittkanten“** (0–60 ms), **„So hören, wie es exportiert wird“**
- ✓ **Pattern/Song „In die Sitzung“**, Pad und alle Pads „In die Sitzung“
- ✓ sechs Verfahren, Pads, Klavierrolle, Akkorde und Arpeggio zeichnen, MIDI-Controller, Choke, Gate, Swing, Beat als WAV und MIDI, CUE und Audacity-Marken

### Bilder
- ✓ **Rückgängig / Wiederholen** (nativ seit 22.11.2026)
- ✓ **„Gedrückt halten für das Original“** (vorher/nachher auf der Bühne) — Maus oder Leertaste, nativ seit 22.11.2026
- ✓ **Pixelgenaue Skalierung** (Nearest Neighbour), nativ seit 22.11.2026
- ✓ Viele Bilder auf einmal, dazu **„Alle als ZIP“** (nativ seit 22.11.2026)

### Lautstärke
- ✓ **Mehrere Dateien auf einmal**
- ✓ **Obergrenze für Spitzen (True Peak)** einstellen und „Limiter statt zurücknehmen“
- ✓ **„Nur messen“**
- ✓ Anzeige von Kurzzeit- und Momentan-Lautheit max., Sample Peak, Hinweis „Limiter hat eingegriffen“
- ◐ Die Ziele (Streaming −14, Podcast −16, Rundfunk −23, Club −9) sind da

### Mischen
- ✓ **Voreinstellungen** (Podcast/Talk, Radio/Moderation, Voiceover/Stark, Hintergrund/Dezent, Ohne Absenken)
- ✓ **Weiche Blenden** (Einschwing- und Rückkehrzeit, nativ „Wird leiser in“/„Kommt zurück in“)
- ✓ **Als MP3** speichern (Rust: WAV und Video)
- ✓ Ducking, Attack/Release, Vorlauf, Musik wiederholen, Einzelspuren, unter das Video legen

### Spuren trennen
- ✓ **Feinjustierung**: Auflösung (FFT 2048/4096/8192), Länge der Filter, Maskenhärte, Mittenschärfe
- — WebGPU (gibt es nativ nicht; Rust rechnet auf der CPU oder mit ONNX Runtime)

### Untertitel
- ✓ **Jede Zeile vor dem Speichern korrigieren** (Rust speichert, was erkannt wurde)
- ◐ „Noch einmal erkennen“ gibt es als „Neu erzeugen“

### Tonart
- ✓ **„Passt zu“** (Tonarten, die sich mischen lassen)
- ✓ Tonart, Camelot, Tempo, Akkorde, Melodie, MIDI

### Mikrofon
- ✓ **Wiedergabegerät wählen** (Kopfhörer) mit „Ausgang testen“ (Testton 440 Hz) — `sondra_audio::set_output_device`, gilt für alles, was Sondra danach abspielt
- ✓ **Probe** (bis 15 s) mit **„Ein-Klick-Sprachverbesserung (KI)“** (an), verbessert/Original anhören, **„(Verbesserte) Probe in die Sitzung“**; „In die Sitzung“ auch nach dem Einstellen
- ✓ **„Aufnahme mit 1 Klick verbessern“** auf einer Aufnahme der Sitzung oder einer gewählten (`sondra_media::speech_enhance`, Zahl für Zahl wie `enhanceSpeechAudioData`); dazu im Ton-Editor unter „Säubern“
- ✓ „Mithören“ (sich selbst live über den Ausgang hören), nativ seit 22.11.2026

### Bildschirm aufnehmen
- ✗ **Fenster unter Linux/macOS wählen** (Rust nur unter Windows, der Text sagt es)
- ✓ Bildschirm oder Fenster, Ton des Rechners, Mikrofon, Bilder je Sekunde

## 7. Geräte und Handy

| | Funktion in Electron | Rust |
| --- | --- | --- |
| ✓ | **„Fortsetzen“** einer abgerissenen Übertragung in der Oberfläche | Nativ seit 22.11.2026: die Engine hält die Dateien, der Empfänger den angefangenen Teil (`.sondra-teil`), dasselbe Angebot mit `resume` wird ohne zweite Frage angenommen, nur der Rest geht; Fähigkeit `resume` im Eintrag |
| ✓ | **Mehrere Geräte auf einmal** aus einer Auswahl im Ordner | Nativ seit 22.11.2026 |
| ✗ | **Handy in einem eigenen Fenster** (Picture-in-Picture bzw. Fenster des Systems, frei auf dem Bildschirm) | Das Handy steht nur in der Seite |
| ✓ | **„Wenn es nicht klappt“** und **„Technische Einzelheiten“** auf der Seite „Handy spiegeln“ (Liste der üblichen Fehler: Handy nicht in der Liste, Zulassen kommt nicht, schwarzes Bild, kein Ton, y/z vertauscht, „Ein anderes Programm benutzt das Handy“) | Nativ seit 22.11.2026; nach einem Fehler von selbst aufgeklappt |
| ✓ | **Strg+Alt+Esc** gibt die Tastatur zurück | Ist da |

## 8. Betrieb und Verteilung

| | Funktion in Electron | Rust |
| --- | --- | --- |
| ◐ | **Microsoft Store**: Electron ist seit dem 1.10.2026 live im Store | Rust wird in der CI als MSIX gebaut, aber nie eingereicht |
| ◐ | **Updates**: `latest.yml` liegt in jedem Release | Rust liest `latest-nativ.yml`, die erst auf Ihr Wort ins Release kommt |
| — | Android-App, Website, Offline-Service-Worker | Gehören nicht zur Windows-App |

---

## Nachtrag: im Browser geprüft (21.11.2026)

Ein Skript hat die Website (dieselbe Oberfläche wie die Electron-App) im eingebauten Chromium Seite für Seite durchgeklickt. Es lief einmal mit einer Beispiel-Merkliste und einmal mit einer Testdatei (Film, Ton, Bild) in jedem Werkzeug. Jedes Menü und jedes Fenster, das sich ohne Folgen öffnen liess, wurde aufgemacht. Jeder Text und jeder Knopfname wurde mit dem Rust-Code abgeglichen. Was dabei **zusätzlich** zur Liste oben fehlt:

**Rahmen**
- ✓ **Tastenkürzel-Übersicht** wie in Electron: Einträge in Gruppen (Allgemein, Ton & Schnitt, Sampler & Beat, Player & Bühne, Video & Bild, Ordner, Maus & Gesten) mit Gruppenpillen und einem Suchfeld (nativ seit 22.11.2026).
- ✓ **Player-Tasten** (nativ seit 22.11.2026, A/B als Knopf unter „Bild und Ton“): J/L (10 s zurück/vor), `,`/`.` (Bild für Bild), `<`/`>` (Tempo), 0–9 (zu 0–90 % springen), A/B (Schleife).
- ✓ **Bilder**: die Leertaste gedrückt halten zeigt das Original (nativ seit 22.11.2026).
- ✓ **Visualizer**: ein Klick wechselt zwischen Balken, Welle und Kreis (nativ seit 22.11.2026).
- ✓ **„Protokoll“**: was Sondra gerade tut, zum Nachlesen (nativ seit 22.11.2026: Marke „Protokoll“ unten im Rack, die letzten 250 Zeilen dieses Laufs, nur im Speicher, „Leeren“; geschrieben von Sitzung, Ablegen, Öffnen, Drive, Geräten, Ordner, Umwandeln, Video, Bildern, Ton, Mischen, Zerschneiden, Mikrofon und Herunterladen).
- ✓ **Sitzungsmenü**: „Weitere Datei öffnen“, „Alle n als ZIP speichern“ mit eigenem Namen, „Alles verwerfen“ und die Zeile „2,9 MB auf diesem Gerät, nichts davon gesendet“ (nativ seit 22.11.2026; die Dateien bleiben, wo sie liegen).

**Merkliste**
- ✓ **Kopfzeile mit Zahlen**: „2 am Schauen · 1 später“.
- ✓ **„Alle Tags“** als Filter.
- ✓ **„Nur offene Folgen“**.
- ✓ **Ordner-Pille** („Ordner mit Folgen wählen“).
- ✓ **Wo die Liste liegt**: „Nur auf diesem Gerät gespeichert. Über Google Drive teilen es alle Ihre Geräte.“
- ◐ **„Mehr“ einer Serie**: „Folge n laden“, „Nächste Folgen laden …“, „Online nach Neuem suchen“, „Empfehlen“. **Nativ seit 21.11.2026:** „Folge n laden“, „Online nach Neuem suchen“, „Empfehlen“, „Von der Merkliste entfernen“; „Nächste Folgen laden …“ fehlt noch.
- ◐ **Staffelkarten** mit Cover und „10 von 39, weiter mit Folge 11“. Ein Klick klappt die Folgen auf, jede mit ihrer Dauer („Folge 1, gesehen (47 Min.)“). Dazu ein Zähler „Anzahl Folgen“, „Noch 29 Folgen (11,6 Std.) · fertig bei 1/Tag: So., 20. Dez.“ und „Folge 11 laden“ je Staffel. Für die Filme gibt es „Filme bearbeiten: Anzahl, Name, Cover“. **Nativ seit 21.11.2026:** je Staffel „Staffel bearbeiten“ mit Fenster: Cover, „n Folgen gesehen“, „Weiter mit Folge n“, „Hier weiterschauen“, Abhaken (mit Umschalt bis dort), „Alle gesehen“, „Zurücksetzen“, Anzahl, Name, Cover, „In Teile teilen“, Staffel entfernen und Ausnahmen der Dauer. Noch fehlt: die Karte selbst mit Cover und Dauer je Folge.
- ✓ **Planer**: das Ziel als Staffel (Auswahl) und Folge (−/+), „am Tag“ oder „pro Woche“, ein Datumsfeld „Bis zum“ und „Als Ziel merken“. Danach steht oben „Ziel: Staffel 4, Folge 39 — noch 29 Folgen“ und beim Planer „Steht auf der Merkliste bei dieser Serie.“

**Herunterladen**
- ✓ **Zwischenablage**: „In der Zwischenablage: aniworld.to/… — Einfügen und nachsehen / Nicht jetzt“.
- ✓ **„Merken“**: die Adresse auf die Merkliste.
- ✓ **„.txt / .m3u mit Links hier ablegbar“** (nativ seit 22.11.2026).
- ✓ **„alle zeigen“**: die Liste der Portale, die gehen (nativ seit 22.11.2026).
- ✗ **Einstellungen**: Fenster „Download-Einstellungen“ (siehe Abschnitt 5) und „Ton bei Fertigstellung abspielen“ samt Erklärung.

**Umwandeln (mit Datei)**
- ✗ **„Zielformat“** als Menü.
- ✓ **„Zuschneiden“**: nur einen Ausschnitt umwandeln.
- ✗ **„Mehrere Dateien auf einmal“** als Schalter.
- ✓ **Abtastrate**: Wie Quelle, 22,05 / 32 / 44,1 / 48 kHz.
- ✓ **Kanäle**: Wie Quelle, Mono, Stereo.

**Video (mit Datei)**
- ◐ **Rückgängig/Wiederholen** (nativ seit 22.11.2026) und **„Fertigstellen“** (nativ heisst es „Video speichern“).
- ✗ **„Ton im Vorhören“** an/aus.
- ✓ **Tempo „Feiner“** als Regler, mit „Länge danach“ (nativ seit 22.11.2026).

**Bilder (mit Datei)**
- ✓ **Rückgängig/Wiederholen** (nativ seit 22.11.2026).
- ✗ **Zoom**: „Passend“ / „Grösser“.
- ✓ **„Vergleichen“**.
- ✓ **„Ausschnitt aufheben“**.

**Ton (mit Datei)**
- ✓ **Stopp**, **Schleife**, **Zoom hinein/heraus**.
- ✓ **„Datei zum Anhängen“**.
- ✓ **Tonhöhe ±12 Halbtöne** mit „Tonhöhe übernehmen“ / „Tempo übernehmen“ (nativ: „Tonhöhe und Tempo“ im Ton-Editor).
- ✓ **„Tempo klopfen“** (Tippen oder T).
- ✓ **Verlauf als Liste**, jeder Schritt mit Strg+Z zurückzunehmen (nativ: Werkzeug „Verlauf“).

**Mischen (mit Datei)**
- ✓ **Vorlagen**: Podcast / Talk, Radio / Moderation, Hintergrund / Dezent, Voiceover / Stark.
- ✓ **Vergleich** „Gemischt“ ↔ „Ohne Absenken“.
- ✓ **„In die Sitzung übernehmen“** (nativ seit 22.11.2026).
- ✓ **Name des ZIP** für die Einzelspuren (nativ seit 22.11.2026).

**Spuren trennen (mit Datei)**
- ✓ **Mittenschärfe** und **Maskenhärte** als Regler.
- — WebGPU: nativ nicht nötig.

**Lautstärke (mit Datei)**
- ✓ **Messart**: Lautheit (LUFS) oder Spitzenpegel (dBFS).
- ✓ **„Übersteuerung verhindern“**.
- ✓ **„Limiter statt zurücknehmen“**.
- ✓ **Obergrenze True Peak**.
- ✓ **„Mehrere Dateien auf einmal“** (Ergebnis als ZIP).
- ✓ **„Nur messen“**.

**Zerschneiden (mit Datei)**
- ✓ **„Am Zeiger teilen“** und **„Als 1 Pad“** (nativ seit 22.11.2026).
- ✗ **Zoom**.
- ✗ **Pads ↔ Piano-Roll** umschalten.
- ✗ **1 oder 2 Takte**.
- ✓ **„Grundbeat vorschlagen“** (nativ „Start-Beat legen“); Pads entstehen nativ gleich beim Schneiden.
- ✓ **Export**: „Einzelnes Pattern“ oder „Song-Kette“, dazu „In die Sitzung“ (nativ seit 22.11.2026).
- ✓ **Je Pad**: Löschen, „Auf alle übertragen“, Anfang −10/+10 ms, „Halbieren“, „Mit nächstem verbinden“, „So hören, wie es exportiert wird“ nativ seit 22.11.2026.

**Tonart (mit Datei)**
- ✓ **„Einfach“ / „Detail“** als Ansicht.

Die vollständigen Rohlisten liegen bei diesem Lauf als Datei im Arbeitsordner der Sitzung. Die Bildschirmfotos jeder Seite und jedes geöffneten Menüs liegen dort ebenfalls.

## Was nativ mehr kann als Electron

Ein Programm im Infobereich, das mit Windows startet. Neue Folgen auf Vorrat laden. Eine Speichergrenze, die nur Gesehenes löscht. Ein Zeitfenster für Downloads, nur am Netzteil und ohne getaktete Verbindung. Herunterfahren nach dem Laden. Ein eigenes `.onnx`-Modell für Spuren trennen. Untertitel mit whisper.cpp ohne Browser. Ein Mitteilungsfach. Die Übernahme der Daten aus der Electron-App.

## Wie man daraus eine Reihenfolge macht

Gemessen an dem, was man täglich benutzt, wiegen diese Lücken am schwersten:

1. **Serie bearbeiten**: Titel, Länge, Bewertung, Notiz, Tags, Cover. Ohne das bleibt ein Tippfehler im Titel für immer stehen.
2. **Wiedergabe-Einstellungen im Player**: Automatisch weiter, Wiederholen, Sprungweite, Abhaken an/aus. Die Werte sind schon da, es fehlen nur Knöpfe.
3. **Herunterladen**: Was laden, Qualität, AniWorld-Sprache, und „Folge n laden“ von der Serie aus.
4. **Umwandeln**: Ausschnitt und die Video-Einstellungen (die Rechnung ist schon da).
5. **Tastenkürzel** in Ton-Editor, Video und Bildern.
6. **Vorspann am Ton** im Player (die Rechnung ist schon da).
7. **Ordner**: In die Sitzung, In Drive, An Geräte, Untertitel erzeugen, zuletzt geöffnete Ordner.
