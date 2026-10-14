/**
 * The editor tool icons, in one place.
 *
 * All drawn on the same 20×20 grid with the same stroke so a rail of them
 * reads as one set rather than eight borrowed glyphs.
 */

import { EditorIcon } from './EditorShell'

export const IconCrop = (
  <EditorIcon>
    <path d="M6 2v12h12M2 6h12v12" />
  </EditorIcon>
)

export const IconTransform = (
  <EditorIcon>
    <path d="M4 8a6 6 0 019.9-4.5M16 12a6 6 0 01-9.9 4.5M14 3.2V6h-2.8M6 16.8V14h2.8" />
  </EditorIcon>
)

export const IconSize = (
  <EditorIcon>
    <path d="M3 3h8v8H3zM11 11h6v6h-6M14 8l3-3m0 0h-3m3 0v3" />
  </EditorIcon>
)

export const IconColor = (
  <EditorIcon>
    <path d="M10 2.5a7.5 7.5 0 000 15 2 2 0 001.6-3.2 1.6 1.6 0 011.3-2.6h1.6A3 3 0 0017.5 8c0-3-3.4-5.5-7.5-5.5z" />
    <path d="M6.2 9.2h.01M9 6.2h.01M12.8 7.4h.01" strokeWidth="1.9" />
  </EditorIcon>
)

export const IconSharpen = (
  <EditorIcon>
    <path d="M10 2.5l7 14.5H3zM10 8v4.5" />
  </EditorIcon>
)

export const IconFade = (
  <EditorIcon>
    <path d="M2.5 15.5L7.5 5h5l5 10.5M2.5 15.5h15" />
  </EditorIcon>
)

export const IconExport = (
  <EditorIcon>
    <path d="M10 13V2.8m0 0L6.5 6.3M10 2.8l3.5 3.5M3 12.5v3a1.5 1.5 0 001.5 1.5h11a1.5 1.5 0 001.5-1.5v-3" />
  </EditorIcon>
)

export const IconTrim = (
  <EditorIcon>
    <path d="M5 3v14M15 3v14M5 10h10" />
  </EditorIcon>
)

export const IconSpeed = (
  <EditorIcon>
    <path d="M3.2 14.5a8 8 0 1113.6 0" />
    <path d="M10 12l3.4-4.2" />
  </EditorIcon>
)

export const IconSound = (
  <EditorIcon>
    <path d="M4 7.5h2.8L11 4v12L6.8 12.5H4zM14 7.6a3.5 3.5 0 010 4.8" />
  </EditorIcon>
)

export const IconHarvest = (
  <EditorIcon>
    <path d="M2.8 4.5h9v11h-9zM11.8 8l5.4-3v10l-5.4-3z" />
  </EditorIcon>
)

export const IconBatch = (
  <EditorIcon>
    <path d="M6.5 6.5h11v11h-11zM13.5 6.5V3.5h-11v11h3" />
  </EditorIcon>
)

/* -- the sound editor ------------------------------------------------------ */

export const IconCut = (
  <EditorIcon>
    <circle cx="5.8" cy="14.6" r="2.3" />
    <circle cx="14.2" cy="14.6" r="2.3" />
    <path d="M7.4 12.9L14.6 2.8M12.6 12.9L5.4 2.8" />
  </EditorIcon>
)

export const IconLevel = (
  <EditorIcon>
    <path d="M4 17V10M8 17V5M12 17V8M16 17V12M2.5 17h15" />
  </EditorIcon>
)

export const IconEq = (
  <EditorIcon>
    <path d="M5 3v5.5m0 3V17M10 3v1.5m0 3V17M15 3v8.5m0 3V17M3.2 10h3.6M8.2 6h3.6M13.2 13h3.6" />
  </EditorIcon>
)

export const IconClean = (
  <EditorIcon>
    <path d="M2.5 12h2.2l1.6-3.5 2.2 7 2-6 1.4 2.5h2.6" />
    <path d="M15.5 2.8v4M13.5 4.8h4" />
  </EditorIcon>
)

export const IconRoom = (
  <EditorIcon>
    <path d="M3.5 10h.01" strokeWidth="2.2" />
    <path d="M6.8 7.2a4 4 0 010 5.6M9.6 4.6a7.6 7.6 0 010 10.8M12.4 2a11.2 11.2 0 010 16" />
  </EditorIcon>
)

export const IconTempo = (
  <EditorIcon>
    <path d="M6.2 17.2h7.6L11.6 2.8H8.4zM10 12.5l4.6-6.3M7.2 13.5h5.6" />
  </EditorIcon>
)

export const IconHistory = (
  <EditorIcon>
    <path d="M3.6 10a6.4 6.4 0 101.9-4.6M3.6 3.4v2.8h2.8M10 6.4V10l2.6 1.6" />
  </EditorIcon>
)

export const IconPlay = (
  <EditorIcon>
    <path d="M6 4.2v11.6L15.5 10z" fill="currentColor" stroke="none" />
  </EditorIcon>
)

export const IconPause = (
  <EditorIcon>
    <path d="M6 4.5h2.6v11H6zM11.4 4.5H14v11h-2.6z" fill="currentColor" stroke="none" />
  </EditorIcon>
)

export const IconStop = (
  <EditorIcon>
    <path d="M5.2 5.2h9.6v9.6H5.2z" fill="currentColor" stroke="none" />
  </EditorIcon>
)

export const IconLoop = (
  <EditorIcon>
    <path d="M4 9.5V8a3 3 0 013-3h8.5m0 0L13 2.5M15.5 5L13 7.5M16 10.5V12a3 3 0 01-3 3H4.5m0 0L7 12.5M4.5 15L7 17.5" />
  </EditorIcon>
)

export const IconToStart = (
  <EditorIcon>
    <path d="M5 4.5v11" />
    <path d="M15 4.5v11L7.5 10z" fill="currentColor" stroke="none" />
  </EditorIcon>
)

export const IconZoomIn = (
  <EditorIcon>
    <path d="M8.8 3.5a5.3 5.3 0 110 10.6 5.3 5.3 0 010-10.6zM12.7 12.7L17 17M8.8 6.6v4.4M6.6 8.8H11" />
  </EditorIcon>
)

export const IconZoomOut = (
  <EditorIcon>
    <path d="M8.8 3.5a5.3 5.3 0 110 10.6 5.3 5.3 0 010-10.6zM12.7 12.7L17 17M6.6 8.8H11" />
  </EditorIcon>
)

export const IconUndo = (
  <EditorIcon>
    <path d="M7 5L3.5 8.5 7 12M3.5 8.5H12a4.5 4.5 0 010 9h-1" />
  </EditorIcon>
)

export const IconRedo = (
  <EditorIcon>
    <path d="M13 5l3.5 3.5L13 12M16.5 8.5H8a4.5 4.5 0 000 9h1" />
  </EditorIcon>
)
