/**
 * Shared session state.
 *
 * In memory here; `hooks/useKeptSession` mirrors the files into IndexedDB on
 * this device and offers them back after a restart, unless the person has
 * switched that off („Sitzung auf diesem Gerät behalten“) — then closing the
 * tab is the delete button again, as it was for anyone on a shared machine.
 */

import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'

import { DEFAULT_CONVERT, type ConvertSettings } from '../lib/convert'
import { DEFAULT_NORMALIZATION, type NormalizationSettings } from '../lib/loudness'
import { DEFAULT_SEPARATION, type SeparationOptions } from '../lib/separation'
import type { AudioData } from '../lib/wav'

/**
 * What a file is, as far as the tools are concerned.
 *
 * Not a MIME type: the question every tool asks is "can I work on this", and
 * the answer is one of six, not one of four hundred. `image` and `archive`
 * arrived when the app stopped being audio-only.
 */
export type AssetKind = 'audio' | 'video' | 'image' | 'document' | 'archive' | 'unknown'

export interface Asset {
  id: string
  name: string
  /** Raw container bytes, exactly as they arrived. */
  bytes: Uint8Array
  mime: string
  sizeBytes: number
  kind: AssetKind
  /** Decoded audio, filled in on demand — decoding is not free. */
  audio: AudioData | null
  durationSeconds: number | null
  origin: 'file' | 'download' | 'derived'
  createdAt: number
}

export interface LogLine {
  id: number
  at: number
  level: 'info' | 'warn' | 'error'
  scope: string
  message: string
}

export type PanelId =
  | 'start'
  | 'downloader'
  | 'converter'
  | 'audio'
  | 'video'
  | 'images'
  | 'stems'
  | 'normalize'
  | 'sampler'
  | 'harmony'
  | 'mic'
  | 'subtitles'

interface SessionState {
  assets: Asset[]
  activeAssetId: string | null
  panel: PanelId
  logs: LogLine[]

  convert: ConvertSettings
  normalization: NormalizationSettings
  separation: SeparationOptions

  addAsset: (asset: Omit<Asset, 'id' | 'createdAt'>) => Asset
  updateAsset: (id: string, patch: Partial<Asset>) => void
  removeAsset: (id: string) => void
  clearAssets: () => void
  setActiveAsset: (id: string | null) => void
  setPanel: (panel: PanelId) => void

  log: (scope: string, message: string, level?: LogLine['level']) => void
  clearLogs: () => void

  setConvert: (patch: Partial<ConvertSettings>) => void
  setNormalization: (patch: Partial<NormalizationSettings>) => void
  setSeparation: (patch: Partial<SeparationOptions>) => void
}

let logCounter = 0

const makeId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `asset-${Date.now()}-${Math.random().toString(36).slice(2)}`

export const useSession = create<SessionState>((set, get) => ({
  assets: [],
  activeAssetId: null,
  // The tile screen, not a tool: the app's first sentence should be "what do
  // you want to do", not "paste a link".
  panel: 'start',
  logs: [],

  convert: DEFAULT_CONVERT,
  normalization: DEFAULT_NORMALIZATION,
  separation: DEFAULT_SEPARATION,

  addAsset: (input) => {
    const asset: Asset = { ...input, id: makeId(), createdAt: Date.now() }
    set((state) => ({ assets: [...state.assets, asset], activeAssetId: asset.id }))
    return asset
  },

  updateAsset: (id, patch) =>
    set((state) => ({
      assets: state.assets.map((asset) => (asset.id === id ? { ...asset, ...patch } : asset)),
    })),

  removeAsset: (id) =>
    set((state) => {
      const assets = state.assets.filter((asset) => asset.id !== id)
      return {
        assets,
        activeAssetId: state.activeAssetId === id ? (assets.at(-1)?.id ?? null) : state.activeAssetId,
      }
    }),

  clearAssets: () => set({ assets: [], activeAssetId: null }),

  setActiveAsset: (id) => set({ activeAssetId: id }),
  setPanel: (panel) => set({ panel }),

  log: (scope, message, level = 'info') =>
    set((state) => ({
      // A rolling buffer — the log is a diagnostic, not an archive.
      logs: [...state.logs, { id: (logCounter += 1), at: Date.now(), level, scope, message }].slice(-250),
    })),

  clearLogs: () => set({ logs: [] }),

  setConvert: (patch) => set({ convert: { ...get().convert, ...patch } }),
  setNormalization: (patch) => set({ normalization: { ...get().normalization, ...patch } }),
  setSeparation: (patch) => set({ separation: { ...get().separation, ...patch } }),
}))

/** The asset the panels currently act on. */
export function useActiveAsset(): Asset | null {
  return useSession((state) => state.assets.find((asset) => asset.id === state.activeAssetId) ?? null)
}

/**
 * The file a kind-specific tool should work on.
 *
 * The selection is shared across every tool, so the image tool can easily be
 * opened while a WAV is selected. Rather than showing an empty panel it falls
 * back to the first file of its own kind — and returns null only when the
 * session really holds nothing it can use.
 */
export function useActiveAssetOfKind(kind: AssetKind): Asset | null {
  return useSession((state) => {
    const active = state.assets.find((asset) => asset.id === state.activeAssetId)
    if (active?.kind === kind) return active
    return state.assets.find((asset) => asset.kind === kind) ?? null
  })
}

/**
 * Everything of one kind, for the tools that work on a whole batch.
 *
 * Through `useShallow`, because `filter` builds a new array on every read and
 * the store compares selector results by identity: without it every render
 * looks like a change, which re-renders, which reads again — React stops that
 * with "maximum update depth exceeded" rather than letting the tab hang.
 */
export function useAssetsOfKind(kind: AssetKind): Asset[] {
  return useSession(useShallow((state) => state.assets.filter((asset) => asset.kind === kind)))
}

const BY_EXTENSION: Record<string, AssetKind> = {}
const register = (kind: AssetKind, extensions: string[]) => {
  for (const extension of extensions) BY_EXTENSION[extension] = kind
}
register('audio', ['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aiff', 'aif', 'wma', 'alac', 'mka'])
register('video', ['mp4', 'webm', 'mkv', 'mov', 'avi', 'ts', 'm4v', 'flv', 'wmv', 'mpg', 'mpeg', '3gp'])
register('image', ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp', 'tif', 'tiff', 'svg', 'heic'])
register('document', ['pdf', 'txt', 'md', 'csv', 'json', 'docx', 'rtf', 'xml', 'srt', 'vtt'])
register('archive', ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'])

export function kindFromMime(mime: string, name: string): AssetKind {
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('text/') || mime === 'application/pdf' || mime === 'application/json') return 'document'
  if (/^application\/(zip|x-tar|gzip|x-7z|vnd\.rar)/.test(mime)) return 'archive'
  return BY_EXTENSION[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'unknown'
}

/** The plain-language name of a kind, for anywhere a file is described. */
export const KIND_LABEL: Record<AssetKind, string> = {
  audio: 'Ton',
  video: 'Video',
  image: 'Bild',
  document: 'Dokument',
  archive: 'Archiv',
  unknown: 'Datei',
}
