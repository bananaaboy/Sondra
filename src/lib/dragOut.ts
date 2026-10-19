/**
 * Drag-Out from Sondra into external desktop programs (Windows Explorer,
 * DAWs like FL Studio / Ableton / Reaper, video editors, Discord, browsers).
 *
 * Uses Chromium's standard `DownloadURL` dataTransfer format (`mime:name:url`),
 * which instructs Chromium/Electron and desktop browsers to materialize the
 * file at the drop target on the operating system when dragged outside the
 * window.
 */

import type { DragEvent } from 'react'

export interface DragOutFile {
  name: string
  bytes: Uint8Array
  mime?: string
}

let activeBlobUrl: string | null = null

export function startFileDragOut(
  event: DragEvent<HTMLElement>,
  fileOrName: DragOutFile | string,
  bytesArg?: Uint8Array,
  mimeArg?: string,
): void {
  const file: DragOutFile =
    typeof fileOrName === 'string'
      ? { name: fileOrName, bytes: bytesArg ?? new Uint8Array(0), mime: mimeArg }
      : fileOrName
  if (!file.bytes || file.bytes.byteLength === 0) return
  if (activeBlobUrl) {
    URL.revokeObjectURL(activeBlobUrl)
    activeBlobUrl = null
  }
  const mime = file.mime || 'application/octet-stream'
  const safeName = (file.name || 'datei.wav').replace(/[:/\\?*"<>|]/g, '_')
  const blob = new Blob([file.bytes as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  activeBlobUrl = url

  event.dataTransfer.effectAllowed = 'copyMove'
  event.dataTransfer.setData('DownloadURL', `${mime}:${safeName}:${url}`)
  event.dataTransfer.setData('text/uri-list', url)
}
