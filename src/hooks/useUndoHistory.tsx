/**
 * Reusable Undo / Redo state history with keyboard shortcuts (`Ctrl+Z` / `Ctrl+Y`
 * and `Cmd+Z` / `Cmd+Shift+Z`) plus a compact UI bar for tool headers.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export interface UndoController<T> {
  canUndo: boolean
  canRedo: boolean
  record: (snapshot: T) => void
  undo: () => void
  redo: () => void
  clear: () => void
}

export function useUndoHistory<T>(
  currentState: T,
  applySnapshot: (snapshot: T) => void,
  options: number | { maxDepth?: number; enabled?: boolean } = 30,
): UndoController<T> {
  const maxDepth = typeof options === 'number' ? options : (options.maxDepth ?? 30)
  const [past, setPast] = useState<T[]>([])
  const [future, setFuture] = useState<T[]>([])
  const currentRef = useRef<T>(currentState)
  currentRef.current = currentState
  const applyRef = useRef(applySnapshot)
  applyRef.current = applySnapshot

  const record = useCallback(
    (snapshot: T) => {
      setPast((prev) => [...prev.slice(-(maxDepth - 1)), snapshot])
      setFuture([])
    },
    [maxDepth],
  )

  const undo = useCallback(() => {
    setPast((prev) => {
      if (prev.length === 0) return prev
      const previous = prev[prev.length - 1]
      setFuture((f) => [currentRef.current, ...f.slice(0, maxDepth - 1)])
      applyRef.current(previous)
      return prev.slice(0, -1)
    })
  }, [maxDepth])

  const redo = useCallback(() => {
    setFuture((prev) => {
      if (prev.length === 0) return prev
      const [next, ...rest] = prev
      setPast((p) => [...p.slice(-(maxDepth - 1)), currentRef.current])
      applyRef.current(next)
      return rest
    })
  }, [maxDepth])

  const clear = useCallback(() => {
    setPast([])
    setFuture([])
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) {
        return
      }
      const mod = event.ctrlKey || event.metaKey
      if (!mod) return
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) {
        if (past.length > 0) {
          event.preventDefault()
          undo()
        }
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        if (future.length > 0) {
          event.preventDefault()
          redo()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [past.length, future.length, undo, redo])

  return {
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    record,
    undo,
    redo,
    clear,
  }
}

export function UndoRedoBar({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}) {
  return (
    <div className="inline-flex items-center gap-[4px]" role="group" aria-label="Verlauf">
      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        title="Rückgängig (Strg+Z)"
        aria-label="Rückgängig"
        className="press inline-flex items-center gap-[5px] rounded-nav bg-panel-soft px-[9px] py-[5px] text-micro font-medium text-ink ring-1 ring-inset ring-line transition-colors hover:ring-ink disabled:pointer-events-none disabled:opacity-40"
      >
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5.5 4L2.5 7l3 3" />
          <path d="M3 7h6.5a3.5 3.5 0 0 1 0 7H7" />
        </svg>
        <span>Rückgängig</span>
      </button>
      <button
        type="button"
        onClick={onRedo}
        disabled={!canRedo}
        title="Wiederholen (Strg+Y)"
        aria-label="Wiederholen"
        className="press inline-flex items-center gap-[5px] rounded-nav bg-panel-soft px-[9px] py-[5px] text-micro font-medium text-ink ring-1 ring-inset ring-line transition-colors hover:ring-ink disabled:pointer-events-none disabled:opacity-40"
      >
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M10.5 4l3 3-3 3" />
          <path d="M13 7H6.5a3.5 3.5 0 0 0 0 7H9" />
        </svg>
        <span>Wiederholen</span>
      </button>
    </div>
  )
}
