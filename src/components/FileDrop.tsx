/**
 * Drop target and file picker.
 *
 * The whole window already accepts a drop, so this exists for the case where
 * someone is looking for the button rather than guessing that the page is a
 * target. Ingestion itself is shared with every other door in `useIngest`.
 */

import { useEffect, useState } from 'react'

import { useFilePicker, useIngestFiles } from '../hooks/useIngest'
import { ArrowRight, Button } from './ui/primitives'

export function FileDrop({
  compact = false,
  accept,
  prompt = 'Datei hierher ziehen — Ton oder Video, beliebig viele',
}: {
  compact?: boolean
  /** The picker's filter, where a tool takes one kind of file. */
  accept?: string
  prompt?: string
}) {
  const { ingest } = useIngestFiles()
  const { input, open, busy } = useFilePicker('geöffnet', accept)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    let depth = 0
    const onEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      depth += 1
      setDragging(true)
    }
    const onLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDropWindow = () => {
      depth = 0
      setDragging(false)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDropWindow)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDropWindow)
    }
  }, [])

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setDragging(false)
        if (event.dataTransfer.files.length) void ingest(event.dataTransfer.files, 'hierher gezogen')
      }}
      className={`flex flex-col items-center gap-[12px] rounded-card text-center transition-colors duration-[var(--dur-fast)] ${
        dragging
          ? 'bg-panel-mid ring-2 ring-inset ring-ink'
          : 'bg-panel-soft ring-1 ring-inset ring-line'
      } ${compact ? 'p-[16px]' : 'p-[28px]'}`}
    >
      {input}
      {!compact ? (
        <p className="text-body text-prose">{prompt}</p>
      ) : null}
      <Button size={compact ? 'sm' : 'md'} onClick={open} disabled={busy}>
        {busy ? 'Wird gelesen…' : 'Datei auswählen'}
        <ArrowRight />
      </Button>
    </div>
  )
}
