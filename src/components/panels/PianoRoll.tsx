/**
 * A pad, opened up: its piano roll.
 *
 * Two octaves either side of the pad's own pitch, one column per step. Click
 * to set a note, drag to lengthen it as it is set, drag a note to move it,
 * drag its right edge to change its length, click it once to take it away —
 * the gestures of FL Studio's roll, without its right-click, which a trackpad
 * and a phone do not have.
 *
 * The pad's pitch is the C in the middle; a note two rows up plays the chop
 * two semitones higher. A time surface, so it stays square-cornered.
 */

import { useEffect, useRef, useState } from 'react'

import type { RollNote } from '../../lib/pattern'

const TOP = 12
const BOTTOM = -12
const ROWS = TOP - BOTTOM + 1
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'H']
const BLACK = new Set([1, 3, 6, 8, 10])

const pitchClass = (semitone: number) => ((semitone % 12) + 12) % 12
const noteName = (semitone: number) => `${NAMES[pitchClass(semitone)]}${4 + Math.floor(semitone / 12)}`

type Drag = {
  index: number
  kind: 'move' | 'resize' | 'new'
  downStep: number
  downSemitone: number
  origin: RollNote
  moved: boolean
}

export function PianoRoll({
  notes,
  steps,
  current,
  big,
  onChange,
  onAudition,
}: {
  notes: RollNote[]
  steps: number
  current: number | null
  big: boolean
  onChange: (notes: RollNote[]) => void
  onAudition: (semitone: number) => void
}) {
  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const notesRef = useRef(notes)
  notesRef.current = notes
  /** The length a new note gets: the last one drawn, as in FL Studio. */
  const [lastLength, setLastLength] = useState(1)
  const rowHeight = big ? 22 : 16

  // Open at the pad's own pitch, not at the top of two octaves.
  useEffect(() => {
    const box = scrollRef.current
    if (box) box.scrollTop = (TOP - 0) * rowHeight - box.clientHeight / 2 + rowHeight / 2
  }, [rowHeight])

  const cellAt = (clientX: number, clientY: number) => {
    const box = gridRef.current!.getBoundingClientRect()
    const step = Math.min(steps - 1, Math.max(0, Math.floor(((clientX - box.left) / box.width) * steps)))
    const semitone = Math.min(TOP, Math.max(BOTTOM, TOP - Math.floor((clientY - box.top) / rowHeight)))
    return { step, semitone, x: clientX - box.left, width: box.width }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const { step, semitone, x, width } = cellAt(event.clientX, event.clientY)
    const columnWidth = width / steps
    const list = notesRef.current
    const index = list.findIndex((note) => note.semitone === semitone && step >= note.step && step < note.step + note.length)
    if (index >= 0) {
      const note = list[index]
      const rightEdge = ((note.step + note.length) / steps) * width
      const kind = rightEdge - x <= Math.max(6, columnWidth * 0.3) ? 'resize' : 'move'
      dragRef.current = { index, kind, downStep: step, downSemitone: semitone, origin: note, moved: false }
      return
    }
    const note = { step, length: Math.min(lastLength, steps - step), semitone }
    onChange([...list, note])
    onAudition(semitone)
    dragRef.current = { index: list.length, kind: 'new', downStep: step, downSemitone: semitone, origin: note, moved: false }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const { step, semitone } = cellAt(event.clientX, event.clientY)
    const list = [...notesRef.current]
    const note = list[drag.index]
    if (!note) return
    let next = note
    if (drag.kind === 'move') {
      const start = Math.min(steps - drag.origin.length, Math.max(0, drag.origin.step + step - drag.downStep))
      const pitch = Math.min(TOP, Math.max(BOTTOM, drag.origin.semitone + semitone - drag.downSemitone))
      next = { ...drag.origin, step: start, semitone: pitch }
      if (pitch !== note.semitone) onAudition(pitch)
    } else {
      next = { ...note, length: Math.max(1, Math.min(steps - note.step, step - note.step + 1)) }
    }
    if (next.step === note.step && next.semitone === note.semitone && next.length === note.length) return
    drag.moved = true
    list[drag.index] = next
    onChange(list)
  }

  const onPointerUp = () => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    const list = notesRef.current
    if (drag.kind === 'move' && !drag.moved) {
      // A click on a note, without a drag, takes it away.
      onChange(list.filter((_, index) => index !== drag.index))
      return
    }
    const note = list[drag.index]
    if (note) {
      if (drag.kind !== 'move') setLastLength(note.length)
      // Two notes on the same key and step are one note played twice.
      const clean = list.filter(
        (other, index) => index === drag.index || other.semitone !== note.semitone || other.step !== note.step,
      )
      if (clean.length !== list.length) onChange(clean)
    }
  }

  return (
    <div ref={scrollRef} className="overflow-y-auto" style={{ maxHeight: big ? 480 : 300 }}>
      <div className="flex">
        {/* The keys: the pad's pitch is the C in the middle. */}
        <div className="w-[52px] shrink-0">
          {Array.from({ length: ROWS }, (_, row) => {
            const semitone = TOP - row
            const black = BLACK.has(pitchClass(semitone))
            return (
              <button
                key={semitone}
                type="button"
                onClick={() => onAudition(semitone)}
                title={semitone === 0 ? 'Tonhöhe des Pads' : `${semitone > 0 ? '+' : ''}${semitone} Halbtöne`}
                className={`value flex w-full items-center justify-end border-b border-canvas/40 pr-[6px] text-micro ${
                  black ? 'bg-ink/80 text-on-ink' : 'bg-raised text-muted'
                } ${semitone === 0 ? 'font-semibold text-ink' : ''} ${semitone === 0 && black ? 'text-on-ink' : ''}`}
                style={{ height: rowHeight }}
              >
                {pitchClass(semitone) === 0 || semitone === 0 || big ? noteName(semitone) : ''}
              </button>
            )
          })}
        </div>

        <div
          ref={gridRef}
          role="grid"
          aria-label="Klavierrolle"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="relative min-w-0 flex-1 cursor-crosshair touch-none select-none"
          style={{ height: ROWS * rowHeight }}
        >
          {Array.from({ length: ROWS }, (_, row) => {
            const semitone = TOP - row
            return (
              <div
                key={semitone}
                aria-hidden
                className={`absolute inset-x-0 border-b border-line/60 ${
                  semitone === 0 ? 'bg-panel-mid' : BLACK.has(pitchClass(semitone)) ? 'bg-panel-soft' : 'bg-raised'
                }`}
                style={{ top: row * rowHeight, height: rowHeight }}
              />
            )
          })}
          {Array.from({ length: steps + 1 }, (_, step) => (
            <div
              key={step}
              aria-hidden
              className={`absolute inset-y-0 w-px ${step % 4 === 0 ? 'bg-ink/30' : 'bg-line'}`}
              style={{ left: `${(step / steps) * 100}%` }}
            />
          ))}
          {current !== null ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 bg-ink/10"
              style={{ left: `${(current / steps) * 100}%`, width: `${100 / steps}%` }}
            />
          ) : null}
          {notes.map((note, index) => (
            <div
              key={`${note.step}-${note.semitone}-${index}`}
              aria-label={`${noteName(note.semitone)}, Schritt ${note.step + 1}, ${note.length} lang`}
              className={`pointer-events-none absolute border border-canvas/70 bg-ink ${
                current !== null && current >= note.step && current < note.step + note.length ? 'bg-ink-hover' : ''
              }`}
              style={{
                left: `${(note.step / steps) * 100}%`,
                width: `${(note.length / steps) * 100}%`,
                top: (TOP - note.semitone) * rowHeight + 1,
                height: rowHeight - 2,
              }}
            >
              {/* The grip for the length. */}
              <span className="absolute inset-y-[3px] right-[2px] w-[2px] bg-on-ink/60" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
