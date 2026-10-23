/**
 * The Android app's icons, made from the same mark as everything else.
 *
 *   npm run android:icons
 *
 * Android 8 and later draw the launcher icon from two layers — Sondra's
 * green behind, the white bars in front — and cut it to the phone's shape;
 * those layers are a vector (`ic_launcher_foreground.xml`, also the
 * monochrome layer for themed icons and the start screen's icon), written
 * here from the bars of the mark. Older phones take a picture per screen
 * density: the rounded icon as it is, and a round one cut from the
 * full-bleed mark.
 *
 * The PNG reading, writing and scaling is `store-tiles.mjs`' plain Node.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BARS, INK, drawMark, readPng, scale, writePng } from './store-tiles.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const res = path.join(root, 'android/app/src/main/res')
const icon = readPng(path.join(root, 'public/icon-512.png'))

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
const hex = (rgb) => `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`

/** The full-bleed mark cut to a circle, its edge sampled 4 × 4. */
function round(size) {
  const plate = drawMark(size, size, 0.5)
  const r = size / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0
      for (let sy = 0; sy < 4; sy += 1) {
        for (let sx = 0; sx < 4; sx += 1) {
          const dx = x + (sx + 0.5) / 4 - r
          const dy = y + (sy + 0.5) / 4 - r
          if (dx * dx + dy * dy <= r * r) hits += 1
        }
      }
      plate.pixels[(y * size + x) * 4 + 3] = Math.round((255 * hits) / 16)
    }
  }
  return plate
}

for (const [name, factor] of Object.entries(DENSITIES)) {
  const folder = path.join(res, `mipmap-${name}`)
  fs.mkdirSync(folder, { recursive: true })
  writePng(path.join(folder, 'ic_launcher.png'), scale(icon, Math.round(48 * factor)))
  writePng(path.join(folder, 'ic_launcher_round.png'), round(Math.round(48 * factor)))
}

// The front layer: the five bars in white, the 32-unit mark 60 dp wide in
// the 108 dp layer, inside the 66 dp every launcher shape keeps.
const bar = ([x, y, w]) => {
  const r = 1.65
  const f = (value) => Number(value.toFixed(3))
  return `M${f(x + r)},${f(y)} H${f(x + w - r)} A${r},${r} 0 0 1 ${f(x + w - r)},${f(y + 2 * r)} H${f(x + r)} A${r},${r} 0 0 1 ${f(x + r)},${f(y)} Z`
}
fs.mkdirSync(path.join(res, 'drawable'), { recursive: true })
fs.writeFileSync(
  path.join(res, 'drawable', 'ic_launcher_foreground.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<!-- Made by scripts/android-icons.mjs from the mark's bars; edit there. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <group
        android:translateX="24"
        android:translateY="24"
        android:scaleX="1.875"
        android:scaleY="1.875">
        <path
            android:fillColor="#FFFFFF"
            android:pathData="${BARS.map(bar).join(' ')}" />
    </group>
</vector>
`,
)
fs.mkdirSync(path.join(res, 'values'), { recursive: true })
fs.writeFileSync(
  path.join(res, 'values', 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<!-- Made by scripts/android-icons.mjs: the icon's green. -->
<resources>
    <color name="ic_launcher_background">${hex(INK)}</color>
</resources>
`,
)
console.log(`Android-Symbole geschrieben nach ${path.relative(root, res)}`)
