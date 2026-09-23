# Product

<!-- impeccable:product-schema 1 -->

Sondra — Produktvermerk. Was eine spätere Sitzung wissen muss und weder dem
Code noch der Git-Historie ansieht. Kurz halten: mehr Text ist nicht
automatisch mehr Kontext. Veraltete Angaben sind schlimmer als fehlende.

Überschriften englisch, damit die Werkzeuge sie finden; Inhalt deutsch, wie im
ganzen Projekt. Die **gestalterischen** Entscheidungen stehen nicht hier, sondern in
[DESIGN.md](DESIGN.md); [CLAUDE.md](CLAUDE.md) verweist darauf. Eine
massgebliche Datei je Sache, sonst driften zwei auseinander.

## Platform

web

## Users

Öffentlich, für Fremde. lizge.ch steht offen im Netz und wird von Leuten
benutzt, die niemand kennt und denen niemand etwas erklären kann.

Primär: **Musikerinnen und Musiker, die selbst produzieren** (vom Nutzer am
20.9.2026 bestätigt). Sie kommen mit eigenen Aufnahmen und einer konkreten
Aufgabe — Spuren trennen, Tonart und Tempo bestimmen, an Anschlägen
zerschneiden, Lautheit prüfen — und **kennen die Begriffe**: LUFS, True Peak,
Stems, BPM, Camelot müssen ihnen nicht erklärt werden. Das rechtfertigt die
Dichte: 13-px-Bedienelemente, Messwerte in Tabellenziffern, Tastaturbedienung.

Das widerspricht nicht der zweiten Tatsache, sondern steht daneben: weil die
Seite offen im Netz steht, trifft sie auch Fremde, die nichts von ihr wissen.
Deshalb benennt die Oberfläche weiterhin **das Ergebnis, nicht die Technik** —
Fachsprache ist erlaubt, aber sie ist nie die einzige Tür.

Daraus folgt unmittelbar: **Erstbenutzung, leere Zustände und Fehlertexte
müssen allein tragen.** Es gibt niemanden, den man fragen kann.

## Product Purpose

Eine Ton-, Video- oder Bilddatei hereinholen, damit etwas tun, das Ergebnis
mitnehmen. Gelungen ist es, wenn jemand mit einem Vorhaben kommt und mit einer
fertigen Datei geht, ohne etwas installiert oder hochgeladen zu haben.

Was es nicht ist: keine DAW, kein Mehrspur-Schnitt, kein Projektformat. Eine
Sitzung ist ein Tab, und das Schliessen des Tabs ist die Löschtaste.

## Positioning

Zwei Dinge zusammen, die ein Nachbarprodukt nicht beide ehrlich behaupten kann:

1. **Es rechnet im Tab.** FFmpeg als WebAssembly, ONNX Runtime im Browser. Die
   Dateien verlassen das Gerät nicht — kein Upload-Endpunkt, keine Datenbank.
   Ein Umwandel-Dienst, der Dateien entgegennimmt, kann das nicht kopieren,
   weil er sie entgegennimmt.
2. **Die eine Ausnahme wird benannt, bevor jemand tippt.** „Herunterladen"
   geht über einen Dienst, und das steht als Erstes im Feld, nicht in einer
   Fussnote. Ein Werkzeug, das Lokalität behauptet und still eine Netzanfrage
   macht, ist schlimmer als eines, das es nie behauptet hat.

Dazu der Teil, den allgemeine Konverter nicht haben: Spuren trennen, Lautheit
nach EBU R128 messen und angleichen, Tonart, Tempo, Akkorde und Melodie als
MIDI, in Schnipsel zerlegen und auf Tasten legen.

## Operating Context

- **Eine Sitzung ist ein Tab.** Dateien werden hineingezogen oder geöffnet,
  Ergebnisse gespeichert oder in die Sitzung übernommen. Nichts überdauert das
  Schliessen; das ist Absicht und wird so gesagt.
- **Bereitgestellt auf Vercel** unter `www.lizge.ch`. Die zwei
  Serverfunktionen unter `api/` sind der einzige Teil, der nicht im Tab läuft.
- **Optionaler Anbieter** über `SONDRA_PROVIDER_URL`, serverseitig hinterlegt.
- **Optionale lokale Brücke:** wer volle Auflösung will, startet yt-dlp auf dem
  eigenen Rechner — eine Datei und ein Doppelklick, beschrieben unter
  „Mehr Wege".
- Mehrkern-FFmpeg braucht Cross-Origin-Isolation; die Kopfzeilen dafür stehen
  in `vercel.json`.

## Capabilities and Constraints

Gesetzt, nicht verhandelbar, mehrere davon ausdrücklich so gewünscht:

- **Es wird nichts hochgeladen.** Kein Upload-Endpunkt, keine Datenbank, kein
  `localStorage` für Medien.
- **Nur rechtlich zulässige Downloads. Keine DRM-Umgehung.**
- **Keine fremde Instanz fest verdrahtet.** Ein Anbieter wird über die
  Umgebungsvariable hinterlegt oder gar nicht. Sonst gingen alle eingegebenen
  Adressen an Dritte, die sich niemand ausgesucht hat.
- **Kein kompletter Rewrite.** Schrittweise erweitern, keine vorhandene
  Funktion ohne guten Grund entfernen, Breaking Changes vermeiden.
- Oberflächentexte **Deutsch**, Codekommentare **Englisch**. Keine i18n-Struktur
  — Deutsch ist fest verdrahtet, und das ist derzeit kein Mangel, sondern eine
  unentschiedene Frage.

### Gemessene Grenzen, die Versprechen begrenzen

Nachgemessen im September 2026, nicht vermutet. Wer hier etwas anderes
verspricht, verspricht etwas Falsches:

| | |
|---|---|
| YouTube an einen Server | nur die progressive Spur, in der Regel 360p; manche Videos gar nichts |
| höhere Auflösungen | laufen über SABR und haben **keine** abrufbare Adresse — auch mit gültigem PoToken nicht |
| yt-dlp aus einem Rechenzentrum | löst auf, scheitert aber beim Holen an „Sign in to confirm you're not a bot" |
| dasselbe Video, zwei Orte | scheitert verschieden: aus dem Rechenzentrum an der Bot-Prüfung (`youtube.signin`), von einer Wohn-IP an SABR (`youtube.sabr`). Lokal hosten hebt die Grenze also nicht auf, es verschiebt sie |
| andere Client-Kontexte | WEB, ANDROID, IOS, MWEB, TV_EMBEDDED, WEB_EMBEDDED durchgemessen am 21.9.2026: alle liefern dieselben 22 Formate, keines mit abrufbarer Adresse. Kein Ausweg |
| voller Umfang | nur über einen hinterlegten Anbieter oder yt-dlp auf dem eigenen Gerät |
| Freigabe-Link einer Cloud | geht, sofern die Adresse die Datei selbst liefert — der Name darf allein im `Content-Disposition` stehen |

Deshalb steht im Downloader, **welcher Weg geantwortet hat**: das entscheidet
über die Auflösung und darüber, wer die Adresse gesehen hat.

## Brand Commitments

- Das Produkt heisst **Sondra**. `lizge.ch` ist nur die Adresse, unter der es
  liegt, und bleibt es; der Repository-Name „Lizge" ist Altlast. Überall in der
  Oberfläche heisst es Sondra.
- **Der Haftungshinweis beim Downloader ist verbindlich** und muss sichtbar
  bleiben: dass es über einen Proxy läuft und dass dafür nicht gehaftet wird.
- Vorhandene Assets: `public/favicon.svg`, `public/icon-192.png`,
  `public/icon-512.png`, `public/icon-maskable.png`, dazu die Wortmarke im
  Kopf (`Logo` in `AppShell.tsx`).
- Am 20.9.2026 beim Redesign ausdrücklich als bindend genannt und deshalb
  unverändert durch den Umbau getragen:
  - **Logo und Wortmarke.** Die Wortmarke behält ihre eigene Schrift, auch
    nachdem die Serife aus dem übrigen System verschwunden ist; sie lädt
    dafür als eigene Familie `Sondra Wordmark`.
  - **Deutsch, Sie-Form, nüchterner Ton.** Texte dürfen umformuliert werden,
    der Ton nicht.
  - **Alle Werkzeuge bleiben erreichbar.** Keines fällt weg, keines wird
    versteckt.
  - **Die Farben.** Papierweiss `#f4f3ee`, Forest Ink `#0f3e1c` und der dunkle
    Modus waren beim Redesign gesetzt; alles andere — Typografie, Aufbau,
    Raster, Formensprache — stand zur Disposition.

## Evidence on Hand

Was wirklich existiert und zitiert werden darf:

- **Messungen statt Meinungen.** Die Kontrastwerte (APCA) und die Grenzen der
  Download-Wege oben sind nachgemessen und im README festgehalten.
- **Verifizierte Durchläufe:** Bild-, Video- und Tonoperationen sind mit
  echten Dateien durchgespielt; ein Download über den Dienst lief mit
  11 829 048 Bytes in Teilstücken durch.

Was es **nicht** gibt und was keine spätere Sitzung erfinden darf: keine
Nutzerzahlen, keine Testimonials, keine Fallstudien, keine Presse, keine
Preisangaben, keine Vergleichswerte gegen andere Produkte. Wenn so etwas
gebraucht wird, muss es beschafft werden, nicht ausgedacht.

## Product Principles

1. **Sag, wo die Dateien bleiben — besonders wenn die Antwort unbequem ist.**
   Die eine Ausnahme wird benannt, gross und bevor jemand tippt.
2. **Benenne das Ergebnis, nicht die Technik.** Wer mit einer Aufnahme und
   einer Frage ankommt, kennt das Fachwort noch nicht.
3. **Zeigen statt behaupten.** Grössen werden gemessen, nicht geschätzt;
   Vorschau und Datei entstehen aus demselben Code.
4. **Nichts ohne guten Grund entfernen.** Was jemand schon benutzt hat, bleibt
   erreichbar — notfalls einen Klick tiefer, nicht gelöscht.
5. **Versprich nur, was gemessen wurde.** Wo eine Grenze existiert, steht sie
   in der Oberfläche statt in der Ausrede hinterher.

## Accessibility & Inclusion

Kein Standard formal vorgeschrieben, aber die Latte liegt fest und wird
gemessen, nicht nach Augenmass gesetzt:

- APCA: Fliesstext ≥ Lc 75, Sekundärtext ≥ Lc 60, Überschriften ≥ Lc 45,
  Trennlinien und andere Nicht-Text-Elemente ≥ Lc 15.
- Tastaturbedienung und sichtbare Fokusringe; Reiter reagieren auf Pfeiltasten.
- `prefers-reduced-motion` neutralisiert jede Bewegung.
- Offen und bewusst unentschieden: keine andere Sprache als Deutsch.
