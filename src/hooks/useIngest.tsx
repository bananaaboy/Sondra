/**
 * One way in for every file, wherever it came from.
 *
 * Dropping on the window, picking from the header, picking from a panel's drop
 * zone, pasting, opening with Sondra from the file manager and sharing from a
 * phone all end here. Keeping it in one place is not tidiness for its own sake:
 * it is what makes the log line, the rejection rule for non-media files and the
 * "stays in this tab" promise identical no matter which door was used.
 */

import { useCallback, useRef, useState } from 'react'

import { formatBytes } from '../lib/format'
import { isProjectFile, loadProjectBytes } from '../lib/project'
import { kindFromMime, useSession } from '../state/store'

const MEDIA_PATTERN = /^(audio|video)\//

/** Pictures, for the picture tool's own picker — what its decoder reads. */
export const IMAGE_ACCEPT = 'image/*,.heic,.heif,.avif,.webp'

/**
 * Everything this app can open, for the picker's accept list.
 *
 * Pictures belong in it: the picture tool is one of the tools. Without them a
 * system file dialog opened on a filter of sound and video, and a photo could
 * only be picked by switching that filter to „All files" by hand.
 */
export const ACCEPTED_FILES = `audio/*,video/*,.mkv,.flac,.opus,.m4a,.ts,.aac,.wma,.aiff,.aif,${IMAGE_ACCEPT}`

export function useIngestFiles() {
  const addAsset = useSession((state) => state.addAsset)
  const log = useSession((state) => state.log)
  const [busy, setBusy] = useState(false)

  const ingest = useCallback(
    async (files: File[] | FileList, source: string) => {
      const list = Array.from(files)
      const projects = list.filter((file) => isProjectFile(file))
      const usable = list.filter(
        (file) => !isProjectFile(file) && (MEDIA_PATTERN.test(file.type) || kindFromMime(file.type, file.name) !== 'unknown'),
      )

      // Saying nothing when a .docx lands on the window reads as a broken drop
      // target. Saying so costs one line and answers the question.
      if (usable.length === 0 && projects.length === 0) {
        if (list.length > 0) {
          log('bibliothek', `${list.length === 1 ? list[0].name : `${list.length} Dateien`} übersprungen — kein Ton und kein Video`, 'warn')
        }
        return 0
      }

      setBusy(true)
      try {
        let count = 0
        for (const projectFile of projects) {
          const bytes = new Uint8Array(await projectFile.arrayBuffer())
          const loaded = loadProjectBytes(bytes, projectFile.name)
          count += loaded.assetCount
        }
        for (const file of usable) {
          const bytes = new Uint8Array(await file.arrayBuffer())
          addAsset({
            name: file.name || 'eingefügt',
            bytes,
            source: file,
            mime: file.type || 'application/octet-stream',
            sizeBytes: bytes.byteLength,
            kind: kindFromMime(file.type, file.name),
            audio: null,
            durationSeconds: null,
            origin: 'file',
          })
          log('bibliothek', `${file.name || 'eingefügt'} ${source} (${formatBytes(bytes.byteLength)})`)
          count += 1
        }
        return count
      } finally {
        setBusy(false)
      }
    },
    [addAsset, log],
  )

  return { ingest, busy }
}

/**
 * A file picker that can be opened from anywhere.
 *
 * Returns the input element to render — it has to exist in the tree for the
 * click to count as user-initiated — and the function that opens it.
 */
export function useFilePicker(source = 'geöffnet', accept = ACCEPTED_FILES) {
  const { ingest, busy } = useIngestFiles()
  const ref = useRef<HTMLInputElement>(null)

  const input = (
    <input
      ref={ref}
      type="file"
      multiple
      accept={accept}
      className="sr-only"
      onChange={(event) => {
        if (event.target.files?.length) void ingest(event.target.files, source)
        // Cleared so picking the same file twice in a row still fires.
        event.target.value = ''
      }}
    />
  )

  return { input, open: () => ref.current?.click(), busy }
}

/**
 * Dedicated picker for `.sondra` project files.
 */
export function useProjectPicker() {
  const log = useSession((state) => state.log)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  const openProject = useCallback(
    async (file: File) => {
      setBusy(true)
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        loadProjectBytes(bytes, file.name)
      } catch (err) {
        log('projekt', err instanceof Error ? err.message : String(err), 'error')
      } finally {
        setBusy(false)
      }
    },
    [log],
  )

  const input = (
    <input
      ref={ref}
      type="file"
      accept=".sondra"
      className="sr-only"
      onChange={(event) => {
        const file = event.target.files?.[0]
        if (file) void openProject(file)
        event.target.value = ''
      }}
    />
  )

  return { input, open: () => ref.current?.click(), busy }
}
