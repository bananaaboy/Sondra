# Handoff: Sondra (v1.1.19)

**Datum:** 28. Oktober 2026  
**Projektpfad:** `C:\Users\lizge.navajeetharan\Documents\PGM\Sondra`  
**Aktueller Branch:** `main` (auf Commit `bfa6b01` synchronisiert mit `origin/main`)  
**Status:** Alle 15 Verifikationstests (`npm run verify`) und `npm run typecheck` bestanden (Code 0).

---

## 1. Übersicht der Meilensteine bis Version 1.1.19

### Version 1.1.19 (Zuletzt hinzugefügt):
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
  integriertes 2-Spalten-Layout mit Seiten-Vorschau (`FolderInlinePreview`).
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
    panels/               Die 16 Werkzeuge (Ordner, Downloader, Merkliste, Converter, Player etc.)
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
  state/
    store.ts              Zustand Sitzungsspeicher (Memory-only für Medien)
```

---

## 3. Verifikation & Qualitätssicherung

Befehle zur Überprüfung des gesamten Systems:

```powershell
npm run verify           # Führt alle 15 Verifikationstests aus (Lautheit, Tempo, Harmonie, Ordner, Merkliste etc.)
npm run typecheck        # Strikte TypeScript-Prüfung ohne Emit
npm run build            # Produktions-Build (Vite + TypeScript)
npm run build:desktop    # Erstellt Windows Setup (.exe), Portabel und Store MSIX
```
