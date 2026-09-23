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
