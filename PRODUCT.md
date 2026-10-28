# Product

<!-- impeccable:product-schema 1 -->

Sondra — Produktvermerk (Fassung v1.1.21, Stand 28. Oktober 2026). Was eine spätere
Sitzung wissen muss und weder dem Code noch der Git-Historie ansieht. Kurz
halten: mehr Text ist nicht automatisch mehr Kontext. Veraltete Angaben sind
schlimmer als fehlende.

Überschriften englisch, damit die Werkzeuge sie finden; Inhalt deutsch, wie im
ganzen Projekt. Die **gestalterischen** Entscheidungen stehen nicht hier, sondern in
[DESIGN.md](DESIGN.md); [CLAUDE.md](CLAUDE.md) verweist darauf. Eine
massgebliche Datei je Sache, sonst driften zwei auseinander.

## Platform

web · Windows-Desktop (Electron) · Android (WebView-Bridge)

## Users

Öffentlich, für Fremde. sondra.lizge.ch steht offen im Netz und wird von Leuten
benutzt, die niemand kennt und denen niemand etwas erklären kann.

Primär: **Musikerinnen und Musiker, Produzierende und Serien-Begeisterte**
(vom Nutzer am 20.9. und 26.10.2026 bestätigt). Sie kommen mit eigenen
Aufnahmen, Filmen oder Adressen und einer konkreten Aufgabe — Spuren trennen,
Tonart und Tempo bestimmen, an Anschlägen zerschneiden, Lautheit prüfen,
große Serien schauen und verwalten, oder Medien ohne Speicherbelastung
streamen — und **kennen die Begriffe**: LUFS, True Peak, Stems, BPM, Camelot,
HLS, NVENC müssen ihnen nicht erklärt werden. Das rechtfertigt die Dichte:
13-px-Bedienelemente, Messwerte in Tabellenziffern, Tastaturbedienung.

Das widerspricht nicht der zweiten Tatsache, sondern steht daneben: weil die
Seite offen im Netz steht, trifft sie auch Fremde, die nichts von ihr wissen.
Deshalb benennt die Oberfläche weiterhin **das Ergebnis, nicht die Technik** —
Fachsprache ist erlaubt, aber sie ist nie die einzige Tür.

Daraus folgt unmittelbar: **Erstbenutzung, leere Zustände und Fehlertexte
müssen allein tragen.** Es gibt niemanden, den man fragen kann.

## Product Purpose

Eine Ton-, Video- oder Bilddatei hereinholen, damit etwas tun, das Ergebnis
mitnehmen — oder Medien direkt im Studio verwalten und genießen. Gelungen ist
es, wenn jemand mit einem Vorhaben kommt und mit einer fertigen Datei oder
unterbrechungsfreier Unterhaltung geht, ohne etwas ungewollt hochgeladen zu haben.

Was es nicht ist: keine Mehrspur-DAW mit Plugin-Schnittstelle. Eine Sitzung
ist ein Tab. Ihre Dateien bleiben auf dem Gerät (IndexedDB & SQLite 3) und
werden beim nächsten Start angeboten, nicht ungefragt geladen; wer das
abschaltet, hat wieder die alte Regel: das Schliessen des Tabs ist die
Löschtaste.

## Positioning

Zwei Dinge zusammen, die ein Nachbarprodukt nicht beide ehrlich behaupten kann:

1. **Es rechnet im Tab.** FFmpeg als WebAssembly, ONNX Runtime im Browser,
   spezifikationskonforme SQLite-3-Engine ohne native Bindings. Die Dateien
   verlassen das Gerät nicht — kein Upload-Endpunkt, keine Cloud-Datenbank.
   Ein Umwandel-Dienst, der Dateien entgegennimmt, kann das nicht kopieren,
   weil er sie entgegennimmt. Die eine Tür nach draussen gehört dem Nutzer:
   sein eigenes Google Drive oder Anytype, verbunden auf seinen Wunsch,
   beschickt nur mit dem, was er freigibt — und seine eigenen anderen
   Geräte, zu denen eine Datei unter „Geräte“ direkt geht (WebRTC), ohne
   Server dazwischen.
2. **Die eine Ausnahme wird benannt, bevor jemand tippt.** „Herunterladen"
   geht über einen Dienst, und das steht als Erstes im Feld, nicht in einer
   Fussnote. Ein Werkzeug, das Lokalität behauptet und still eine Netzanfrage
   macht, ist schlimmer als eines, das es nie behauptet hat.

Dazu der Teil, den allgemeine Konverter oder Mediaplayer nicht haben:
Spuren trennen, Lautheit nach EBU R128 messen und angleichen, Tonart, Tempo,
Akkorde und Melodie als MIDI, in Schnipsel zerlegen und auf Tasten legen,
intelligente Serien-Merkliste mit Schauzeit-Rechner („Bis wohin?“),
Direct-Streaming mit Smart Prefetch, Hintergrund-Downloads mit Floating-Minibar
und KI-Sprachverbesserung direkt auf der Aufnahme.

## Operating Context

- **Eine Sitzung ist ein Tab.** Dateien werden hineingezogen, geöffnet oder
  unter Windows „mit Sondra geöffnet“, Ergebnisse gespeichert oder in die
  Sitzung übernommen. Die Sitzung überdauert das Schliessen und ein Update auf
  dem Gerät, auf ausdrücklichen Wunsch — mit einem Schalter „Sitzung auf
  diesem Gerät behalten“ für geteilte Rechner, der auch löscht.
- **Transaktionssichere SQLite 3 Datenbank:** Merkliste, Schau-Historie und
  Status lagern in einer lokalen SQLite-3-Binärdatei (`sondra.db`), die
  Rechtecks- und B-Tree-Strukturen direkt im Browser verwaltet.
- **Hintergrund-Downloads (v1.1.19):** Downloads brechen beim Verlassen des
  Reiters nicht ab; die Floating Minibar unten rechts hält Fortschritt und
  Steuerung permanent verfügbar. Screen Wake Lock verhindert den Standby.
- **Geräte (v1.1.21):** Geräte desselben Google-Kontos finden sich über
  einen signierten Eintrag je Gerät in Drive und tauschen Dateien direkt.
  Kennung = Hash des eigenen Schlüssels, Einträge und Nachrichten signiert:
  kein Gerät kann ein anderes überschreiben oder nachahmen (ausdrücklich so
  gewünscht). Das andere Gerät fragt vor dem Annehmen.
- **Android-App:** startet auf der Startseite, lädt Portale mit yt-dlp auf
  dem Telefon (die APK ist dadurch rund 150 MB) und aktualisiert sich über
  GitHub-Releases selbst, mit Androids Installer.
- **„Was ist neu“** (`src/changelog.json`): ein Verlauf für Website, beide
  Apps und die Release-Notizen; ohne Eintrag für die Version kein Release.
- **Offline nutzbar** nach einem Besuch: der Service Worker hält jedes
  Werkzeug der aktuellen Fassung (`offline.json`), nur das Herunterladen
  braucht das Netz und sagt das.
- **Bereitgestellt auf Vercel** unter `www.sondra.lizge.ch`. Die zwei
  Serverfunktionen unter `api/` sind der einzige Teil, der nicht im Tab läuft.
- **Optionaler Anbieter** über `SONDRA_PROVIDER_URL`, serverseitig hinterlegt.
- **Optionale lokale Brücke / Desktop-App:** wer volle Auflösung will oder
  Zero-RAM-Downloads auf Festplatte benötigt, nutzt die Windows-App oder
  yt-dlp auf dem eigenen Rechner.
- Mehrkern-FFmpeg braucht Cross-Origin-Isolation; die Kopfzeilen dafür stehen
  in `vercel.json`. In der Desktop-App steht zusätzlich hardwarebeschleunigtes
  FFmpeg (NVIDIA NVENC, AMD AMF, Intel QuickSync) zur Verfügung.

## Capabilities and Constraints

Gesetzt, nicht verhandelbar, mehrere davon ausdrücklich so gewünscht:

- **Es wird nichts hochgeladen.** Kein Upload-Endpunkt, keine zentrale
  Datenbank. Medien liegen im Speicher oder auf der lokalen Platte.
  Cloud-Speicher (Google Drive, AniList) erfordern die ausdrückliche
  Anmeldung des Nutzers und nutzen ausschließlich minimale Scopes (`drive.file`).
- **Nur rechtlich zulässige Downloads. Keine DRM-Umgehung.**
- **Keine fremde Instanz fest verdrahtet.** Ein Anbieter wird über die
  Umgebungsvariable hinterlegt oder gar nicht. Das gilt auch für Geräte:
  kein STUN- oder TURN-Dienst, deshalb direkt nur im selben Netz.
- **Kein kompletter Rewrite.** Schrittweise erweitern, keine vorhandene
  Funktion ohne guten Grund entfernen, Breaking Changes vermeiden.
- Oberflächentexte **Deutsch**, Codekommentare **Englisch**. Keine i18n-Struktur
  — Deutsch ist fest verdrahtet.

### Gemessene Grenzen, die Versprechen begrenzen

Nachgemessen im September und Oktober 2026, nicht vermutet:

| | |
|---|---|
| YouTube an einen Server | nur die progressive Spur, in der Regel 360p; manche Videos gar nichts |
| höhere Auflösungen | laufen über SABR und haben **keine** abrufbare Adresse — auch mit gültigem PoToken nicht |
| yt-dlp aus einem Rechenzentrum | löst auf, scheitert aber beim Holen an „Sign in to confirm you're not a bot" |
| dasselbe Video, zwei Orte | scheitert verschieden: aus dem Rechenzentrum an der Bot-Prüfung (`youtube.signin`), von einer Wohn-IP an SABR (`youtube.sabr`). Lokal hosten hebt die Grenze also nicht auf, es verschiebt sie |
| voller Umfang | nur über einen hinterlegten Anbieter oder yt-dlp / Desktop-App auf dem eigenen Gerät |
| Freigabe-Link einer Cloud | geht, sofern die Adresse die Datei selbst liefert |
| Geräte ohne STUN | direkt nur im selben Netz; zwischen zwei Netzen auf Klick über Google Drive |
| Android-APK mit yt-dlp | rund 151 MB (Python und FFmpeg für arm64, armv7 und x86_64) |

## Brand Commitments

- Das Produkt heisst **Sondra**. `sondra.lizge.ch` ist die offizielle Webadresse.
  Das Repository heisst `bananaaboy/Sondra`.
- **Der Haftungshinweis beim Downloader ist verbindlich** und muss sichtbar
  bleiben: dass es über einen Proxy läuft und dass dafür nicht gehaftet wird.
- **Logo und Wortmarke:** Die Wortmarke lädt als eigene Familie `Sondra Wordmark`.
- **Deutsch, Sie-Form, nüchterner Ton.** Texte dürfen umformuliert werden,
  der Ton nicht.
- **Alle Werkzeuge bleiben erreichbar.** Keines fällt weg, keines wird
  versteckt.
- **Die Farben:** Papier (#f2eee4), Forest Ink (#0f3e1c), Tinte (#143422) und
  das dunkle Thema Waldschwarz sind gesetzt.
