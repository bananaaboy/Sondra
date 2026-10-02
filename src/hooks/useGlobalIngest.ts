/**
 * Files arriving from outside the page: dropped, pasted, opened by the
 * operating system, or shared from another app.
 *
 * A drop target you have to aim at is a small tax on every single use. Since
 * the whole window has no other use for a drop, it accepts one — and the
 * clipboard path covers the case where a file came from a screenshot tool or a
 * chat window.
 *
 * The other two matter because the one thing this app cannot do itself is fetch
 * from YouTube. Somebody else's program has to do that, so the trip back has to
 * be short: once Sondra is installed, a downloaded file can be opened with it
 * straight from the file manager, or pushed into it from a phone's share sheet.
 */

import { useEffect, useState } from 'react'

import { APP_BRIDGE, type OpenedFile } from '../lib/desktop'
import { useIngestFiles } from './useIngest'

/** The slice of the File Handling API this app uses. */
interface LaunchParams {
  files?: { getFile: () => Promise<File> }[]
}
interface LaunchQueue {
  setConsumer: (consumer: (params: LaunchParams) => void) => void
}

export function useGlobalIngest(): { dragging: boolean } {
  const { ingest } = useIngestFiles()
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    // Depth counting, because dragenter/dragleave fire for every child element
    // the pointer crosses and a naive boolean flickers.
    let depth = 0

    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      depth += 1
      setDragging(true)
    }
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.files.length) return
      event.preventDefault()
      depth = 0
      setDragging(false)
      void ingest(Array.from(event.dataTransfer.files), 'per Drag & Drop geladen')
    }
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      // Do not swallow a paste meant for the URL field.
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length === 0) return
      event.preventDefault()
      void ingest(files, 'aus der Zwischenablage eingefügt')
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [ingest])

  // "Open with Sondra" from the file manager. Chromium-only and desktop-only,
  // so its absence is the normal case rather than a problem.
  useEffect(() => {
    const queue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue
    if (!queue) return
    queue.setConsumer((params) => {
      const handles = params.files ?? []
      if (handles.length === 0) return
      void (async () => {
        const files = await Promise.all(handles.map((handle) => handle.getFile()))
        await ingest(files, 'aus dem Betriebssystem geöffnet')
      })()
    })
  }, [ingest])

  // The same from the Windows app: „Öffnen mit Sondra“, or a file dropped on
  // its icon. The app offers each file on its own server; fetching it here
  // turns it into an ordinary File for the same path a pick takes.
  useEffect(() => {
    const bridge = APP_BRIDGE
    if (!bridge?.takeOpenedFiles) return
    const take = async (opened: OpenedFile[]) => {
      if (opened.length === 0) return
      const files: File[] = []
      for (const entry of opened) {
        try {
          const response = await fetch(entry.url)
          if (!response.ok) continue
          const blob = await response.blob()
          files.push(new File([blob], entry.name, { type: blob.type }))
        } catch {
          // The file went away between the click and now; the rest still come.
        }
      }
      if (files.length > 0) await ingest(files, 'mit Sondra geöffnet')
    }
    void bridge.takeOpenedFiles().then(take)
    return bridge.onOpenedFiles?.((opened) => void take(opened))
  }, [ingest])

  // Files a share sheet handed to the service worker, which parked them and
  // sent the browser here with a count in the query string.
  useEffect(() => {
    const waiting = Number(new URLSearchParams(window.location.search).get('shared') ?? 0)
    if (!Number.isFinite(waiting) || waiting <= 0) return

    void (async () => {
      const files: File[] = []
      try {
        const cache = await caches.open('sondra-share')
        for (let index = 0; index < waiting; index += 1) {
          const key = `./shared/${index}`
          const response = await cache.match(key)
          if (!response) continue
          const name = decodeURIComponent(response.headers.get('X-Filename') ?? `geteilt-${index}`)
          const blob = await response.blob()
          files.push(new File([blob], name, { type: blob.type }))
          await cache.delete(key)
        }
      } catch {
        // Storage can be refused; there is simply nothing to collect then.
      }

      if (files.length > 0) await ingest(files, 'aus einer anderen App geteilt')
      // Drop the marker so a reload does not look for files that are gone —
      // but keep the fragment, which now names the open tool.
      window.history.replaceState(null, '', window.location.pathname + window.location.hash)
    })()
  }, [ingest])

  return { dragging }
}
