/**
 * `.sondra` project file export and import.
 *
 * A `.sondra` file is a store-only ZIP archive containing:
 *   - `project.json`: session metadata, active panel, settings, sampler patterns/slices/song-chain, subtitle segments, etc.
 *   - `assets/<index>_<name>`: the raw binary files currently in the session.
 */

import { saveBytes } from './download'
import { deserializeSondraSqlite, serializeSondraSqlite } from './sqlite'
import { createZip, readZip, type ZipEntry } from './zip'
import { kindFromMime, useSession, type Asset, type AssetKind, type PanelId } from '../state/store'
import type { ConvertSettings } from './convert'
import type { NormalizationSettings } from './loudness'
import type { SeparationOptions } from './separation'

export interface ProjectAssetMeta {
  id: string
  name: string
  entryPath: string
  mime: string
  sizeBytes: number
  kind: AssetKind
  durationSeconds: number | null
  origin: 'file' | 'download' | 'derived'
  createdAt: number
}

export type ProjectToolStates = Record<string, unknown>

export interface ProjectManifest {
  format: 'sondra-project'
  version: 1
  savedAt: number
  panel: PanelId
  activeAssetId: string | null
  convert: ConvertSettings
  normalization: NormalizationSettings
  separation: SeparationOptions
  assets: ProjectAssetMeta[]
  toolStates: ProjectToolStates
}

let currentToolStates: ProjectToolStates = {}

export function setProjectToolState(
  key: string,
  value: unknown,
): void {
  currentToolStates = {
    ...currentToolStates,
    [key]: value,
  }
}

export function getProjectToolState<T = Record<string, unknown>>(
  key: string,
): T | undefined {
  return currentToolStates[key] as T | undefined
}

/** The project as one `.sondra` archive, and the name it is saved under. */
export function buildProjectFile(customName?: string): { bytes: Uint8Array; fileName: string; assetCount: number } {
  const state = useSession.getState()
  const encoder = new TextEncoder()
  const entries: ZipEntry[] = []
  const assetMetas: ProjectAssetMeta[] = []

  state.assets.forEach((asset, index) => {
    const safeName = asset.name.replace(/[\\/:*?"<>|]+/g, '_') || `asset_${index}`
    const entryPath = `assets/${index}_${safeName}`
    entries.push({
      name: entryPath,
      data: asset.bytes,
    })
    assetMetas.push({
      id: asset.id,
      name: asset.name,
      entryPath,
      mime: asset.mime,
      sizeBytes: asset.sizeBytes,
      kind: asset.kind,
      durationSeconds: asset.durationSeconds,
      origin: asset.origin,
      createdAt: asset.createdAt,
    })
  })

  const manifest: ProjectManifest = {
    format: 'sondra-project',
    version: 1,
    savedAt: Date.now(),
    panel: state.panel,
    activeAssetId: state.activeAssetId,
    convert: state.convert,
    normalization: state.normalization,
    separation: state.separation,
    assets: assetMetas,
    toolStates: currentToolStates,
  }

  const merkItemsInProject = Array.isArray(currentToolStates.merkliste)
    ? (currentToolStates.merkliste as Record<string, unknown>[])
    : []
  const sqliteData = serializeSondraSqlite({
    items: merkItemsInProject,
    removed: {},
    appState: {
      manifest: { value: manifest, updatedAt: manifest.savedAt },
    },
  })

  entries.unshift({
    name: 'project.json',
    data: encoder.encode(JSON.stringify(manifest, null, 2)),
  })
  entries.unshift({
    name: 'project.sqlite',
    data: sqliteData,
  })

  const archive = createZip(entries)
  const activeAsset = state.assets.find((a) => a.id === state.activeAssetId) ?? state.assets[0]
  const baseName =
    customName?.trim().replace(/\.sondra$/i, '') ||
    activeAsset?.name.replace(/\.[^.]+$/, '') ||
    `sondra-projekt-${new Date().toISOString().slice(0, 10)}`

  return { bytes: archive, fileName: `${baseName}.sondra`, assetCount: state.assets.length }
}

export function saveProjectFile(customName?: string): void {
  const { bytes, fileName, assetCount } = buildProjectFile(customName)
  saveBytes(bytes, fileName, 'application/octet-stream')
  useSession.getState().log('projekt', `Projekt als ${fileName} gespeichert (${assetCount} ${assetCount === 1 ? 'Datei' : 'Dateien'})`)
}

export function isProjectFile(file: { name: string }): boolean {
  return /\.sondra$/i.test(file.name)
}

export function loadProjectBytes(bytes: Uint8Array, sourceName = 'projekt.sondra'): { assetCount: number } {
  const decoder = new TextDecoder()
  const entries = readZip(bytes)
  const sqliteEntry = entries.find((e) => e.name === 'project.sqlite')
  const manifestEntry = entries.find((e) => e.name === 'project.json')
  let manifest: ProjectManifest | undefined
  if (sqliteEntry) {
    try {
      const snap = deserializeSondraSqlite(sqliteEntry.data)
      const fromDb = snap.appState?.manifest?.value as ProjectManifest | undefined
      if (fromDb && fromDb.format === 'sondra-project') {
        manifest = fromDb
        if (snap.items.length > 0) {
          manifest.toolStates = {
            ...manifest.toolStates,
            merkliste: snap.items,
          }
        }
      }
    } catch {
      /* fall back to project.json */
    }
  }
  if (!manifest) {
    if (!manifestEntry) {
      throw new Error(`${sourceName} enthält keine gültige Sondra-Projektbeschreibung (project.sqlite / project.json).`)
    }
    manifest = JSON.parse(decoder.decode(manifestEntry.data)) as ProjectManifest
  }
  if (manifest.format !== 'sondra-project') {
    throw new Error(`${sourceName} ist keine unterstützte Sondra-Projektdatei.`)
  }

  const entryMap = new Map<string, Uint8Array>()
  for (const entry of entries) {
    entryMap.set(entry.name, entry.data)
  }

  const restoredAssets: Asset[] = []
  for (const meta of manifest.assets ?? []) {
    const data = entryMap.get(meta.entryPath)
    if (!data) continue
    const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: meta.mime || 'application/octet-stream' })
    restoredAssets.push({
      id: meta.id,
      name: meta.name,
      bytes: data,
      source: blob,
      mime: meta.mime || 'application/octet-stream',
      sizeBytes: data.byteLength,
      kind: meta.kind || kindFromMime(meta.mime || '', meta.name),
      audio: null,
      durationSeconds: meta.durationSeconds,
      origin: meta.origin ?? 'file',
      createdAt: meta.createdAt ?? Date.now(),
    })
  }

  currentToolStates = manifest.toolStates ?? {}

  useSession.setState({
    assets: restoredAssets,
    activeAssetId:
      manifest.activeAssetId && restoredAssets.some((a) => a.id === manifest.activeAssetId)
        ? manifest.activeAssetId
        : (restoredAssets[0]?.id ?? null),
    panel: manifest.panel ?? 'start',
    convert: manifest.convert ?? useSession.getState().convert,
    normalization: manifest.normalization ?? useSession.getState().normalization,
    separation: manifest.separation ?? useSession.getState().separation,
  })

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sondra:project-loaded', { detail: currentToolStates }))
  }

  useSession
    .getState()
    .log(
      'projekt',
      `Projekt ${sourceName} geladen (${restoredAssets.length} ${restoredAssets.length === 1 ? 'Datei' : 'Dateien'})`,
    )
  return { assetCount: restoredAssets.length }
}
