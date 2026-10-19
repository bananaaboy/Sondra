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

const TOP = 16
const BOTTOM = -16
const ROWS = TOP - BOTTOM + 1
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'H']
const BLACK = new Set([1, 3, 6, 8, 10])

export type ScaleKind = 'chromatic' | 'minor' | 'major' | 'pentatonic' | 'blues'
export type StampKind = 'single' | 'minor' | 'major' | 'octave'

const SCALES: Record<ScaleKind, Set<number>> = {
  chromatic: new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
  minor: new Set([0, 2, 3, 5, 7, 8, 10]),
  major: new Set([0, 2, 4, 5, 7, 9, 11]),
  pentatonic: new Set([0, 3, 5, 7, 10]),
  blues: new Set([0, 3, 5, 6, 7, 10]),
}

const STAMP_INTERVALS: Record<StampKind, number[]> = {
  single: [0],
  minor: [0, 3, 7],
  major: [0, 4, 7],
  octave: [0, 12],
}

const pitchClass = (semitone: number) => ((semitone % 12) + 12) % 12
export const noteName = (semitone: number) => `${NAMES[pitchClass(semitone)]}${4 + Math.floor(semitone / 12)}`

function snapSemitoneToScale(semitone: number, scale: ScaleKind): number {
  const allowed = SCALES[scale]
  if (allowed.has(pitchClass(semitone))) return semitone
  for (let delta = 1; delta <= 6; delta += 1) {
    if (semitone + delta <= TOP && allowed.has(pitchClass(semitone + delta))) return semitone + delta
    if (semitone - delta >= BOTTOM && allowed.has(pitchClass(semitone - delta))) return semitone - delta
  }
  return semitone
}

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
  scale = 'chromatic',
  stamp = 'single',
  onChange,
  onAudition,
}: {
  notes: RollNote[]
  steps: number
  current: number | null
  big: boolean
  scale?: ScaleKind
  stamp?: StampKind
  onChange: (notes: RollNote[]) => void
  onAudition: (semitone: number) => void
}) {
  const gridRef = useRef<HTMLDivElement>(null)
  const velRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const velDragRef = useRef(false)
  const notesRef = useRef(notes)
  notesRef.current = notes
  /** The length a new note gets: the last one drawn, as in FL Studio. */
  const [lastLength, setLastLength] = useState(2)
  const rowHeight = big ? 28 : 24
  const allowedScale = SCALES[scale]

  // Open at the pad's own pitch, not at the top of two octaves.
  useEffect(() => {
    const box = scrollRef.current
    if (box) box.scrollTop = Math.max(0, (TOP - 0) * rowHeight - box.clientHeight / 2 + rowHeight / 2)
  }, [rowHeight, big])

  const cellAt = (clientX: number, clientY: number) => {
    const box = gridRef.current!.getBoundingClientRect()
    const step = Math.min(steps - 1, Math.max(0, Math.floor(((clientX - box.left) / box.width) * steps)))
    const rawSemitone = Math.min(TOP, Math.max(BOTTOM, TOP - Math.floor((clientY - box.top) / rowHeight)))
    const semitone = scale === 'chromatic' ? rawSemitone : snapSemitoneToScale(rawSemitone, scale)
    return { step, semitone, rawSemitone, x: clientX - box.left, width: box.width }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const { step, semitone, rawSemitone, x, width } = cellAt(event.clientX, event.clientY)
    const columnWidth = width / steps
    const list = notesRef.current
    const index = list.findIndex(
      (note) => (note.semitone === rawSemitone || note.semitone === semitone) && step >= note.step && step < note.step + note.length,
    )
    if (index >= 0) {
      const note = list[index]
      const rightEdge = ((note.step + note.length) / steps) * width
      const kind = rightEdge - x <= Math.max(8, columnWidth * 0.32) ? 'resize' : 'move'
      dragRef.current = { index, kind, downStep: step, downSemitone: note.semitone, origin: note, moved: false }
      return
    }
    const len = Math.min(lastLength, steps - step)
    const intervals = STAMP_INTERVALS[stamp]
    const added: RollNote[] = intervals
      .map((offset) => semitone + offset)
      .filter((pitch) => pitch >= BOTTOM && pitch <= TOP)
      .map((pitch) => ({
        step,
        length: len,
        semitone: scale === 'chromatic' ? pitch : snapSemitoneToScale(pitch, scale),
        velocity: 0.9,
      }))
    const nextList = [...list, ...added]
    onChange(nextList)
    onAudition(semitone)
    dragRef.current = {
      index: list.length,
      kind: 'new',
      downStep: step,
      downSemitone: semitone,
      origin: added[0] ?? { step, length: len, semitone, velocity: 0.9 },
      moved: false,
    }
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
      const rawPitch = Math.min(TOP, Math.max(BOTTOM, drag.origin.semitone + semitone - drag.downSemitone))
      const pitch = scale === 'chromatic' ? rawPitch : snapSemitoneToScale(rawPitch, scale)
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

  const applyVelocityAt = (clientX: number, clientY: number) => {
    const box = velRef.current?.getBoundingClientRect()
    if (!box) return
    const step = Math.min(steps - 1, Math.max(0, Math.floor(((clientX - box.left) / box.width) * steps)))
    const vel = Math.max(0.15, Math.min(1, 1 - (clientY - box.top) / box.height))
    const list = notesRef.current
    let changed = false
    const updated = list.map((note) => {
      if (step >= note.step && step < note.step + note.length) {
        changed = true
        return { ...note, velocity: Number(vel.toFixed(2)) }
      }
      return note
    })
    if (changed) onChange(updated)
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="relative flex-1" style={{ minHeight: big ? 660 : 558 }}>
        <div ref={scrollRef} className="absolute inset-0 overflow-y-auto">
          <div className="flex">
          {/* The keys: the pad's pitch is the C in the middle. */}
          <div className="w-[48px] shrink-0 border-r border-line select-none">
            {Array.from({ length: ROWS }, (_, row) => {
              const semitone = TOP - row
              const pc = pitchClass(semitone)
              const black = BLACK.has(pc)
              const inScale = allowedScale.has(pc)
              return (
                <button
                  key={semitone}
                  type="button"
                  onClick={() => onAudition(semitone)}
                  title={semitone === 0 ? 'Grundton des Pads (C4)' : `${semitone > 0 ? '+' : ''}${semitone} Halbtöne (${noteName(semitone)})`}
                  className={`value flex w-full items-center justify-end border-b border-line/60 pr-[6px] text-micro transition-colors ${
                    black
                      ? 'bg-panel-strong/75 text-ink hover:bg-ink hover:text-on-ink'
                      : inScale
                        ? 'bg-raised text-prose hover:bg-panel-mid'
                        : 'bg-panel-soft/60 text-muted/60 hover:bg-panel-soft'
                  } ${semitone === 0 ? 'font-bold text-ink ring-1 ring-inset ring-ink/40' : ''}`}
                  style={{ height: rowHeight }}
                >
                  {pc === 0 || semitone === 0 || big ? noteName(semitone) : ''}
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
              const pc = pitchClass(semitone)
              const inScale = allowedScale.has(pc)
              return (
                <div
                  key={semitone}
                  aria-hidden
                  className={`absolute inset-x-0 border-b border-line/55 ${
                    semitone === 0
                      ? 'bg-panel-mid/80'
                      : !inScale
                        ? 'bg-panel-soft/45'
                        : BLACK.has(pc)
                          ? 'bg-panel-soft/80'
                          : 'bg-raised'
                  }`}
                  style={{ top: row * rowHeight, height: rowHeight }}
                />
              )
            })}
            {Array.from({ length: steps + 1 }, (_, step) => (
              <div
                key={step}
                aria-hidden
                className={`absolute inset-y-0 w-px ${step % 4 === 0 ? 'bg-rule' : 'bg-line/60'}`}
                style={{ left: `${(step / steps) * 100}%` }}
              />
            ))}
            {current !== null ? (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 bg-ink/15"
                style={{ left: `${(current / steps) * 100}%`, width: `${100 / steps}%` }}
              />
            ) : null}
            {notes.map((note, index) => {
              const active = current !== null && current >= note.step && current < note.step + note.length
              const isSustained = note.length >= 2
              const vel = note.velocity ?? 0.9
              return (
                <div
                  key={`${note.step}-${note.semitone}-${index}`}
                  aria-label={`${noteName(note.semitone)}, Schritt ${note.step + 1}, ${note.length} lang`}
                  className={`pointer-events-none absolute flex items-center overflow-hidden rounded-[3px] border ${
                    active
                      ? 'border-ink bg-ink-hover text-on-ink'
                      : isSustained
                        ? 'border-ink bg-panel-strong text-ink'
                        : 'border-canvas/70 bg-ink text-on-ink'
                  }`}
                  style={{
                    left: `${(note.step / steps) * 100}%`,
                    width: `${(note.length / steps) * 100}%`,
                    top: (TOP - note.semitone) * rowHeight + 1,
                    height: rowHeight - 2,
                    opacity: 0.45 + vel * 0.55,
                  }}
                >
                  {isSustained ? (
                    <>
                      {/* Solid attack block on step 1 + sustain tail line with dot, matching mockup */}
                      <span
                        className="h-full shrink-0 bg-ink"
                        style={{ width: `${Math.min(42, Math.round(100 / note.length))}%` }}
                      />
                      <span className="relative mx-[6px] flex flex-1 items-center">
                        <span className="h-[2px] w-full bg-ink" />
                        <span className="ml-[-3px] h-[5px] w-[5px] shrink-0 rounded-pill bg-ink" />
                      </span>
                    </>
                  ) : null}
                  {/* The grip for the length. */}
                  <span className={`absolute inset-y-[3px] right-[2px] w-[2px] ${isSustained ? 'bg-ink/70' : 'bg-on-ink/70'}`} />
                </div>
              )
            })}
            </div>
          </div>
        </div>
      </div>

      {/* Velocity / Anschlagsstärke lane */}
      <div className="flex h-[38px] shrink-0 border-t border-line bg-panel-soft/50 select-none">
        <div className="value flex w-[48px] shrink-0 items-center justify-end border-r border-line pr-[6px] text-micro text-muted">
          Dyn
        </div>
        <div
          ref={velRef}
          aria-label="Anschlagsstärke je Schritt"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.currentTarget.setPointerCapture(e.pointerId)
            velDragRef.current = true
            applyVelocityAt(e.clientX, e.clientY)
          }}
          onPointerMove={(e) => {
            if (velDragRef.current) applyVelocityAt(e.clientX, e.clientY)
          }}
          onPointerUp={() => {
            velDragRef.current = false
          }}
          onPointerCancel={() => {
            velDragRef.current = false
          }}
          className="relative flex-1 cursor-ns-resize touch-none"
        >
          {Array.from({ length: steps + 1 }, (_, step) => (
            <div
              key={step}
              aria-hidden
              className={`absolute inset-y-0 w-px ${step % 4 === 0 ? 'bg-rule/70' : 'bg-line/40'}`}
              style={{ left: `${(step / steps) * 100}%` }}
            />
          ))}
          {notes.map((note, idx) => {
            const vel = note.velocity ?? 0.9
            return (
              <div
                key={`vel-${note.step}-${note.semitone}-${idx}`}
                className="pointer-events-none absolute bottom-0 flex flex-col items-center"
                style={{
                  left: `${((note.step + 0.18) / steps) * 100}%`,
                  width: `${(0.64 / steps) * 100}%`,
                  height: `${Math.round(vel * 86)}%`,
                }}
              >
                <span className="h-[4px] w-[4px] shrink-0 rounded-pill bg-ink" />
                <span className="w-[2px] flex-1 bg-ink/75" />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
