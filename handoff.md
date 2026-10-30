# Handoff: Sondra (v1.1.21)

**Datum:** 28. Oktober 2026  
**Projektpfad:** `C:\Users\lizge.navajeetharan\Documents\PGM\Sondra`  
**Aktueller Branch:** `main` (Release-Commit von v1.1.21, synchronisiert mit `origin/main`)  
**Status:** Alle 17 Verifikationstests (`npm run verify`) und `npm run typecheck` bestanden (Code 0).

---

## 1. Übersicht der Meilensteine bis Version 1.1.21

### Seit 1.1.22 (noch nicht veröffentlicht, 30.10.2026):
- **Browser-Szenarien im Repository** (`npm run verify:e2e`, Workflow „Browser“): Geräte,
  Ordner in Drive, Bewegung, Pausieren.
- **Geräte:** Fähigkeiten im Eintrag (`caps`), Text und Links, Auf Gerät abspielen, Ordner
  senden (`FileInfo.path`, `splitPath`, Android `save-begin` mit `dir`), mehrere Empfänger mit
  Warteschlange (zwei zugleich), Fortsetzen nach Abbruch (`Kept`/`Piece`).
- **Beim Minimieren pausieren** (`lib/pauseOnMinimize.ts`, Windows-App: `onWindowState`).
- **Ordner:** Löschen geht zuerst in `Sondra-Papierkorb` mit „Rückgängig“ (`binFiles`).
- **Offen aus der Liste:** eigener STUN/TURN-Server, Android-Split-APKs, Untertitel
  automatisch, Merkliste teilen, Statistik-Rückblick, virtuelle Liste.

### Seit 1.1.21 (veröffentlicht als 1.1.22 bzw. noch offen):
- **Geräte wiedererkennen:** die Windows-App wartet auf ihren Port und nimmt sonst einen
  gemerkten Ersatz (`port.json`), nie einen zufälligen — der Port ist Teil der Herkunft.
  Nach Neuinstallation: „Das war dieses Gerät“ (`adoptFormer`) übernimmt den alten Eintrag;
  „Entfernen“ für Geräte, die nicht offen sind (`removeDevice`).
- **Übertragung zuverlässig:** Abfragen alle 1,2 s während einer Übertragung, Sammeln der
  Wege bis 8 s, weiches Aufgeben nach 25/45 s, hartes nach 3 Min.; Android-Multicast-Lock
  (`Bridge.java`, `multicast`), Electron ohne mDNS-Verschleierung lokaler Adressen.
- **Ordner:** Löschen im Ordner „Sondra“ in Drive (Papierkorb, `trashDriveFiles`); die
  Seiten-Vorschau ist entfernt.
- **Bewegung:** gleitender Strich unter den Reitern, Werkzeuge kommen von der Seite ihres
  Reiters, Dialoge mit Ein- und Ausgang, Menüs (`drop`), Leisten unten (`dock`), Blätter auf
  dem Handy (`sheet`), gestaffelte Listen (`rise-list`), Überblendung beim Themenwechsel.

### Version 1.1.21:
- **Geräte (`#geraete`, `src/lib/devices.ts`, `deviceIdentity.ts`, `deviceTransfer.ts`):**
  Geräte desselben Google-Kontos finden sich über Drive (`Sondra/Geräte`) und tauschen
  Dateien direkt per WebRTC; das andere Gerät fragt vorher (`DeviceInbox`, auf jeder Seite).
  „An Gerät“ neben jedem „In Drive“.
- **Eindeutig und nicht überschreibbar:** ECDSA-P-256-Schlüssel je Gerät (privat nicht
  auslesbar), Kennung = SHA-256 des öffentlichen Schlüssels, Einträge und Nachrichten
  signiert; Fälschungen werden ignoriert, der Besitzer stellt seinen Eintrag wieder her.
  Namen eindeutig („Laptop 2“).
- **Kein STUN:** direkt im selben Netz; sonst auf Klick über Drive (`Sondra/Geräte/Übergabe`,
  danach gelöscht).
- **Android-Update in der App:** die Kopfzeile ruft den eingebauten Updater (APK laden,
  Installer öffnen) statt eines Links in den Browser; Apps vor 1.1.20 bekommen die APK über
  den Browser angeboten.
- **Prüfung:** `npm run verify:devices`.

### Version 1.1.20:
- **„Was ist neu“ (`src/changelog.json`, `WhatsNew.tsx`):** Verlauf auf allen Plattformen und
  als Release-Notizen; `verify:changelog` verlangt den Eintrag der Version.
- **Android:** yt-dlp auf dem Telefon (`YtDlp.java`, youtubedl-android 0.18.1), Start auf der
  Startseite, nichts vorgeholt auf Telefonen (`FETCH_LIGHT`).
- **Startseite neu**, Fenster **„App herunterladen“** neu (Reiter Windows/Android).

### Version 1.1.19:
- **Hintergrund-Downloads (`src/lib/backgroundDownload.ts`):**
  Downloads brechen beim Wechseln auf andere Werkzeuge (Player, Video-Editor, Merkliste)
  nicht mehr ab. `DownloaderPanel` bleibt im Hintergrund gemountet.
- **Floating Minibar (`src/components/Dashboard.tsx`):**
  Schwebendes Status-Widget unten rechts während laufender Hintergrund-Downloads:
  Fortschrittsbalken, Live-Downloadrate (MB/s), verbleibende Zeit, Pause/Fortsetzen und
  Ein-Klick-Rückkehr ins Download-Panel.
- **Screen Wake-Lock & Power Save Blocker:**
  Verhindert Systemruhezustand oder Bildschirmschlaf während aktiver Downloads und Wiedergabe.
- **Auto-Resume & Retry:**
  Automatische Wiederaufnahme abgebrochener Downloads am letzten Byte-Bereich.
- **Fertigstellungs-Gong:**
  Zweistimmiger Web-Audio-Gong (659,25 Hz & 880 Hz) bei fertigen Downloads.

### Version 1.1.18:
- **„Sofort abspielen“ (Direct-Stream):**
  HLS- (`hls.js`) und MP4-Streams sofort im Player ansehen, ohne die Datei vorher
  vollständig herunterzuladen. Optionales Speichern im Hintergrund während des Schauens.
- **Smart Prefetch:**
  Vorab-Auflösung und Vorab-Pufferung der nächsten Folge ab ca. 75 % Fortschritt im Player.
- **Timeline-Vorschaubilder & Kapitel:**
  Hover-Thumbnails über der Zeitleiste und eingebettete Kapitelmarker.
- **Redesign des Ordner-Explorers (`FolderPanel.tsx`):**
  Strikte Trennung von Ordner-Karten und Mediendateien, Beseitigung störender Badges/Pills,
  integriertes 2-Spalten-Layout mit Seiten-Vorschau (seit dem 29.10.2026 wieder entfernt).
- **AniList & MyAnimeList Synchronisation (`src/lib/anilist.ts`):**
  Automatisches Cloud-Update von gesehenen Folgen.
- **Zero-RAM Direct-to-Disk (Desktop-App):**
  Direkter Stream auf die Festplatte spart Hauptspeicher (0 MB RAM-Belastung).
- **GPU-beschleunigtes FFmpeg:**
  Automatische Hardware-Erkennung für NVIDIA NVENC, AMD AMF und Intel QuickSync.
- **KI-Sprachverbesserung (`src/lib/speechEnhance.ts`):**
  1-Klick-Rauschminderung, De-Reverb, Brummentfernung und Stimmpräsenz (100 % lokal).

### Version 1.1.17:
- **SQLite 3 Binary Engine (`src/lib/sqlite.ts`):**
  Spezifikationskonforme relationale SQLite-3-Datenbank (`sondra.db`) ohne externe
  WASM/Native-Abhängigkeiten. Transaktionssichere Speicherung für Merkliste, Historie
  und Schau-Stände.
- **Automatisches Google-Drive-Laden:**
  Resumable Chunk-Downloads und direktes Video-Streaming aus Google Drive ohne Speicherlimits.

---

## 2. Projektstruktur & Architektur

```
api/                      Vercel Serverless-Funktionen (resolve, stream, google-token)
desktop/                  Electron-App für Windows (server.mjs, downloader.mjs, discord.mjs)
android/                  Native Android-App (WebView-Brücke zu Google Drive & System)
public/                   Assets, Schriften, Icons, Service Worker (Isolations-Header)
scripts/                  Build-, Test-, Screenshot- und Verifikationsskripte
src/
  components/
    panels/               Die 17 Werkzeuge (Ordner, Downloader, Merkliste, Geräte, Converter, Player etc.)
    editor/               EditorShell, SoundStage, CropOverlay
    player/               MediaPlayer, SettingsMenu, Visualizer, Scrubbing
    ui/                   Design-System Primitives (Button, Notice, Card, Select, Toggle)
  lib/
    sqlite.ts             Reine TypeScript SQLite-3-Engine (B-Tree-Pages & Schemas)
    backgroundDownload.ts Hintergrund-Downloadmanager, Minibar, Wake-Lock, Chime
    speechEnhance.ts      DSP-Sprachverbesserung (Biquad-Filter, Spektralgates)
    anilist.ts            AniList/MAL GraphQL-Schnittstelle
    studio.ts             Download-Streams, HLS-Assembler, Formatkonverter
    folder.ts             Ordner-Scan, Sortierung, Selektion, Duplikaterkennung
    player.ts             Player-Steuerung, DirectStream, Smart Prefetch
    googleDrive.ts        Google Drive Client & Scopes
    devices.ts            Geräte: Register in Drive, Post, WebRTC, Ablage beim Empfänger
    deviceIdentity.ts     Schlüssel, Kennung, Signaturen, eindeutige Namen
    deviceTransfer.ts     Übertragungsprotokoll mit Flusskontrolle
  changelog.json          „Was ist neu“ und Release-Notizen
  state/
    store.ts              Zustand Sitzungsspeicher (Memory-only für Medien)
```

---

## 3. Verifikation & Qualitätssicherung

Befehle zur Überprüfung des gesamten Systems:

```powershell
npm run verify           # Führt alle 17 Verifikationstests aus (Versionsverlauf, Geräte, Lautheit, Tempo, Harmonie, Ordner, Merkliste etc.)
npm run typecheck        # Strikte TypeScript-Prüfung ohne Emit
npm run build            # Produktions-Build (Vite + TypeScript)
npm run build:desktop    # Erstellt Windows Setup (.exe), Portabel und Store MSIX
```
