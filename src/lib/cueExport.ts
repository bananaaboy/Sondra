/**
 * Export slices and cue points as CUE-Sheet, Audacity Label Track, or Reaper CSV.
 *
 * Supports hardware samplers, CD-cueing, Audacity track labeling, and Reaper DAW workflows.
 */

export interface ExportSlice {
  id?: string
  start: number
  end: number
  name?: string
}

/** Formats seconds into standard CUE-Sheet mm:ss:ff format (75 frames per second). */
export function formatCueTime(seconds: number): string {
  const totalSeconds = Math.max(0, seconds)
  const minutes = Math.floor(totalSeconds / 60)
  const secs = Math.floor(totalSeconds % 60)
  const frames = Math.floor((totalSeconds % 1) * 75)
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}`
}

/** Generates standard CUE-Sheet (.cue) content. */
export function createCueSheet(audioFileName: string, slices: ExportSlice[], albumTitle = 'Sondra Chops'): string {
  const lines: string[] = [
    `TITLE "${albumTitle}"`,
    `FILE "${audioFileName}" WAVE`,
  ]

  slices.forEach((slice, index) => {
    const trackNum = String(index + 1).padStart(2, '0')
    const trackTitle = slice.name || `Pad ${trackNum}`
    lines.push(`  TRACK ${trackNum} AUDIO`)
    lines.push(`    TITLE "${trackTitle}"`)
    lines.push(`    INDEX 01 ${formatCueTime(slice.start)}`)
  })

  return lines.join('\n') + '\n'
}

/** Generates Audacity Label Track (.txt) format: Start\tEnd\tLabel */
export function createAudacityLabels(slices: ExportSlice[]): string {
  return (
    slices
      .map((slice, index) => {
        const title = slice.name || `Pad ${String(index + 1).padStart(2, '0')}`
        return `${slice.start.toFixed(6)}\t${slice.end.toFixed(6)}\t${title}`
      })
      .join('\n') + '\n'
  )
}

/** Generates Reaper Markers / Regions CSV format. */
export function createReaperCsv(slices: ExportSlice[]): string {
  const header = '#\tName\tStart\tEnd\tLength'
  const rows = slices.map((slice, index) => {
    const name = slice.name || `Pad ${String(index + 1).padStart(2, '0')}`
    const length = Math.max(0, slice.end - slice.start)
    return `R${index + 1}\t${name}\t${slice.start.toFixed(3)}\t${slice.end.toFixed(3)}\t${length.toFixed(3)}`
  })
  return [header, ...rows].join('\n') + '\n'
}
