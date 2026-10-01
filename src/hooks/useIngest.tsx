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
import { kindFromMime, useSession } from '../state/store'

const MEDIA_PATTERN = /^(audio|video)\//

/** Everything this app can open, for the picker's accept list. */
export const ACCEPTED_FILES = 'audio/*,video/*,.mkv,.flac,.opus,.m4a,.ts,.aac,.wma,.aiff,.aif'

export function useIngestFiles() {
  const addAsset = useSession((state) => state.addAsset)
  const log = useSession((state) => state.log)
  const [busy, setBusy] = useState(false)

  const ingest = useCallback(
    async (files: File[] | FileList, source: string) => {
      const list = Array.from(files)
      const usable = list.filter(
        (file) => MEDIA_PATTERN.test(file.type) || kindFromMime(file.type, file.name) !== 'unknown',
      )

      // Saying nothing when a .docx lands on the window reads as a broken drop
      // target. Saying so costs one line and answers the question.
      if (usable.length === 0) {
        if (list.length > 0) {
          log('bibliothek', `${list.length === 1 ? list[0].name : `${list.length} Dateien`} übersprungen — kein Ton und kein Video`, 'warn')
        }
        return 0
      }

      setBusy(true)
      try {
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
        }
        return usable.length
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
export function useFilePicker(source = 'geöffnet') {
  const { ingest, busy } = useIngestFiles()
  const ref = useRef<HTMLInputElement>(null)

  const input = (
    <input
      ref={ref}
      type="file"
      multiple
      accept={ACCEPTED_FILES}
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
