# Entwurf: Absatz für `public/datenschutz.html` — das native Programm

**Stand: Entwurf vom 20.11.2026, nicht veröffentlicht.** Datenschutz ist ein Rechtstext, der Ihnen gehört: Bitte lesen
Sie ihn gegen, wie das Programm tatsächlich arbeitet (die Quellen stehen in Klammern), ändern Sie, was nicht stimmt, und
setzen Sie ihn erst dann in `public/datenschutz.html` ein. Die bestehende Seite nennt Website, Windows-App
(Electron) und Android-App; das native Programm fehlt dort.

## Sondra für Windows (natives Programm)

Das native Programm rechnet auf Ihrem Computer. Dateien, die Sie öffnen, umwandeln, schneiden oder abspielen, werden nicht
hochgeladen. Es gibt keine Konten, kein Tracking und keine Werbung.

**Was auf Ihrem Computer liegt.** In `%APPDATA%\Sondra\native` (bei der portablen Fassung im Ordner `Sondra-Daten`
neben der Datei) legt Sondra ab: Ihre Merkliste, Einstellungen, die zuletzt benutzten Ordner und Stellen im Player und,
nur wenn Sie es einschalten, die Dateiliste der letzten Sitzung. Schlüssel zu Diensten, die Sie verbinden (Google Drive,
Anytype, AniList, der Schlüssel Ihres Geräts), liegen dort mit der Windows-Datenschutzschnittstelle verschlüsselt und
werden nie angezeigt. Die Dateien aus Projekten, die Sie öffnen, kommen in den Unterordner `Projekte`.

**Wann das Programm das Netz benutzt — nur auf Ihre Handlung oder wenn Sie es eingeschaltet haben:**

- *Herunterladen:* die Adresse, die Sie eingeben, wird abgerufen (bei Portalen über yt-dlp, das Sondra nur auf Ihren
  Klick von yt-dlp.org/GitHub holt und gegen die veröffentlichte Prüfsumme prüft).
- *Untertitel erzeugen:* das Sprachmodell wird einmalig von Hugging Face geladen; der Ton verlässt Ihren Computer nicht.
- *Serie suchen* (Hinzufügen-Feld, nur auf „Suchen“) und, wenn Sie AniList verbunden haben, der Abgleich Ihres
  Fortschritts: der Name der Serie bzw. Ihr Fortschritt geht an AniList (graphql.anilist.co).
- *Google Drive* (wenn Sie sich anmelden): was Sie dorthin senden, speichert Google; Sondra sieht nur, was es selbst
  anlegte (Berechtigung `drive.file`).
- *Geräte:* Ihre Geräte finden sich über Ihr Google Drive; Dateien gehen direkt zwischen den Geräten (WebRTC), ohne
  Server von uns. Ein STUN-/TURN-Server wird nur benutzt, wenn Sie selbst einen eintragen.
- *Neue Folgen melden* (aus, bis Sie es einschalten): die AniWorld-Seiten Ihrer Serien „Am Schauen“ werden alle drei
  Stunden abgefragt.
- *Updates:* im installierten Programm fragt Sondra alle sechs Stunden die Datei `latest-nativ.yml` auf
  github.com/bananaaboy/Sondra ab; die Fassung wird geladen und gegen ihre Prüfsumme geprüft. Das GitHub-Konto wird dafür
  nicht gebraucht, GitHub sieht die Adresse Ihres Computers wie bei jedem Aufruf.
- *Anytype* und *Discord* sprechen nur mit dem Programm auf Ihrem eigenen Computer (127.0.0.1 bzw. Discords lokale
  Schnittstelle).

Alles andere bleibt offline. Beim Teilen einer Merkliste steht sie im Link bzw. in der Datei selbst; Sondra lädt nichts hoch.

**Offen zu klären, bevor es veröffentlicht wird:** ob die Passage über Updates und GitHub so gelten soll (das Microsoft-Store-
Paket aktualisiert sich nicht selbst, dort entfällt sie); ob Meldungen des Systems (Tray-Symbol) einen Satz brauchen.
