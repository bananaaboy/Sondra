/**
 * What the web editors' crop rectangle does while it is dragged (`dragRect` in `CropOverlay.tsx`): which
 * rectangle comes out of each handle, each pointer place and each locked ratio. The native editors
 * (`native/sondra-media::crop_drag`) must give the same rectangle.
 *
 *   npm run native:golden
 */
import { writeFileSync } from 'node:fs'

import { dragRect, type DragState, type Handle, type Rect } from '../src/components/editor/CropOverlay'

const handles: Handle[] = ['move', 'n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se', 'new']
const starts: Rect[] = [
  { x: 0.2, y: 0.3, width: 0.4, height: 0.3 },
  { x: 0, y: 0, width: 1, height: 1 },
  { x: 0.6, y: 0.5, width: 0.4, height: 0.5 },
]
const points = [
  { x: 0.5, y: 0.5 },
  { x: 0, y: 0 },
  { x: 1, y: 1 },
  { x: 0.25, y: 0.9 },
  { x: 0.9, y: 0.1 },
  { x: 0.21, y: 0.31 },
  { x: 0.7, y: 0.65 },
]
const ratios: { ratio: number | null; sourceAspect: number }[] = [
  { ratio: null, sourceAspect: 16 / 9 },
  { ratio: 1, sourceAspect: 16 / 9 },
  { ratio: 16 / 9, sourceAspect: 4 / 3 },
  { ratio: 9 / 16, sourceAspect: 1 },
]
const cases: { handle: Handle; start: Rect; origin: { x: number; y: number }; point: { x: number; y: number }; ratio: number | null; sourceAspect: number; out: Rect }[] = []
for (const handle of handles) {
  for (const start of starts) {
    // A 'new' press starts a rectangle of the smallest size where the pointer landed.
    for (const origin of handle === 'new' ? [{ x: 0.3, y: 0.4 }, { x: 0.8, y: 0.2 }] : [{ x: start.x + start.width / 2, y: start.y + start.height / 2 }]) {
      for (const point of points) {
        for (const { ratio, sourceAspect } of ratios) {
          const state: DragState = { handle, start: handle === 'new' ? { x: origin.x, y: origin.y, width: 0.02, height: 0.02 } : start, originX: origin.x, originY: origin.y }
          cases.push({ handle, start: state.start, origin, point, ratio, sourceAspect, out: dragRect(state, point, ratio, sourceAspect) })
        }
      }
    }
  }
}
writeFileSync('native/sondra-media/tests/golden/crop.json', `${JSON.stringify(cases)}\n`)
console.log('Ausschnitt: ' + cases.length + ' Züge')
