# Handoff: Sondra (v1.1.0) & Gespeicherte Links Feature

**Datum:** 20. Oktober 2026  
**Projektpfad:** `C:\Users\lizge.navajeetharan\Documents\PGM\Sondra`  
**Aktueller Branch:** `main` (nach Push)

---

## 1. Projekt-Überblick & Bisheriger Verlauf

- **Version 1.1.0 Release**:
  - `package.json` auf `1.1.0` aktualisiert.
  - `README.md` vollständig auf Version 1.1.0 aktualisiert und überarbeitet.
  - **Microsoft Store Assets**:
    - Neues randloses Hero-Banner `1920 × 1080` (`screenshots/microsoft-store-hero-1920x1080.png`) mit 84 Kacheln (12×7 Grid) und integriertem Sondra 5-Balken-Logo.
    - Alle Store-Screenshots im Dark Mode mit aktiven Beispieldaten (Audiospuren, Wellenformen, Schnitt, Transkription).

---

## 2. Zuletzt implementiert: Gespeicherte Links & Universelle Serien-/Episoden-Steuerung

### Anforderung:
Links sollen dauerhaft gespeichert werden können. Bei AniWorld (und überall) soll einstellbar sein, in welcher Sprache (`Auto`, `Ger-Sub`, `Ger-Dub`, `Eng-Sub`), welcher Staffel (`Filme` oder Staffel `1+`) und welcher Episode (`Alle` oder Episode `1+`) man ist. Alle Links sollen diese Einstellungen besitzen.

### Umgesetzte Dateien:

1. **`src/lib/download.ts`**:
   - `LinkEpisodeInfo`: Interface für Staffel, Episode, `isEpisodicUrl` und `seriesSlug`.
   - `parseLinkEpisodeInfo(url)`: Liest Staffel und Episode aus AniWorld/SerienStream (`/anime/stream/.../staffel-X/episode-Y`, `/filme/film-Y`), YouTube-Playlists (`&index=Y`), Pfaden (`/s01e02`, `/staffel-X/episode-Y`) oder Parametern (`?season=X&episode=Y`).
   - `buildUrlWithEpisode(url, season, episode)`: Schreibt die URL bei Staffel- oder Episodenwechsel dynamisch um.
   - `deriveLinkTitle(url)`: Erzeugt saubere Anime-/Serien-/Videotitel aus Adressen.
   - `sourceBadgeForUrl(url)`: Erkennt Portale (`AniWorld`, `SerienStream`, `YouTube`, `Mediathek`, etc.).

2. **`src/components/panels/DownloaderPanel.tsx`**:
   - **`SavedLinkItem` & Persistenz**:
     - Gespeichert in `localStorage` unter `'sondra:saved_links'`.
     - Voll synchronisiert mit `.sondra`-Projektdateien über `getProjectToolState('downloader')` und `setProjectToolState('downloader', ...)`.
   - **Aktive Adressleiste**:
     - Button **„Link speichern“ / „Gespeichert“** direkt neben „Nachsehen“.
     - **Universelle Link-Steuerleiste** für jeden Link (direkt unter der Adressleiste):
       - **Sprache**: `Auto`, `Ger-Sub (OmU)`, `Ger-Dub`, `Eng-Sub`
       - **Staffel**: Button `Filme` (`season = 0`) sowie Stepper `−` / Eingabe / `+`
       - **Episode**: Button `Alle` (`episode = null`) sowie Stepper `−` / Eingabe / `+` und Schnellknopf **`+1 Folge`**
       - **Qualität & Modus**: Wahl zwischen Video & Ton, Audio-Format (`MP3`, `M4A`, `FLAC`, `WAV`, `OPUS`, `Original`), Video-/Audio-Qualitätsstufen und `Lokale KI`-Untertitel (`KI-UT`)
   - **Ergebnis-Karte (`result`)**:
     - Quick-Actions: **„Link speichern“** und **„Nächste Folge (Ep. X)“**.
   - **Bereich „Gespeicherte Links“**:
     - Vollständige Liste gemerkter Links mit Portal-Badge, editierbarem Namen, Statusanzeige und Schnellaktionen (**„Nachsehen“**, **„+1 Folge“**, **„Kopieren“**, **„Löschen“**).
     - Inline-Steuerleiste pro gespeichertem Link für Sprache, Staffel, Episode, Modus, Qualität und KI-Untertitel.
     - Formular zum manuellen Hinzufügen weiterer Links (**„+ Link hinzufügen“**).
   - **Download-Verlauf („Zuletzt geladen“)**:
     - Button **„Merken“** auf jedem Verlaufseintrag zum Übernehmen in die gespeicherten Links.

3. **`scripts/verify-download.mts`**:
   - Unit-Verifikationstests für `parseLinkEpisodeInfo`, `buildUrlWithEpisode`, `deriveLinkTitle` und `sourceBadgeForUrl` ergänzt.

---

## 3. Nächste Schritte / Offener Git-Push

Die Dateien befinden sich im Workspace unter `C:\Users\lizge.navajeetharan\Documents\PGM\Sondra`.

Zum Übernehmen und Pushen ins Remote-Repository:

```powershell
cd "C:\Users\lizge.navajeetharan\Documents\PGM\Sondra"
git status
git add src/lib/download.ts src/components/panels/DownloaderPanel.tsx scripts/verify-download.mts handoff.md
git commit -m "feat(downloader): add saved links, episode/season switcher and language controls"
git push
```

Zur Überprüfung des Builds:
```powershell
npm run build
# oder:
npm run typecheck
npm run verify:download
```
