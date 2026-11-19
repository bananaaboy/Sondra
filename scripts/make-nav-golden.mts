/**
 * Writes the table the native app's navigation (`native/sondra-app`) is tested against: the tools with
 * their addresses, labels and summaries, and how the tab row groups them. The Rust side must hold the
 * same, so a tool added, renamed or moved on the web that is not carried over fails the check.
 *
 *   npm run native:golden
 */
import { mkdirSync, writeFileSync } from 'node:fs'

import { PANELS, TAB_ENTRIES } from '../src/components/panelMeta'

const outDir = 'native/sondra-app/tests/golden'
mkdirSync(outDir, { recursive: true })

const panels = PANELS.map((p) => ({ id: p.id, slug: p.slug, label: p.label, summary: p.summary }))
const entries = TAB_ENTRIES.map((e) =>
  e.type === 'panel'
    ? { type: 'panel', panel: e.panel.id }
    : { type: 'group', id: e.id, label: e.label, panels: e.panels.map((p) => p.id) },
)
writeFileSync(`${outDir}/nav.json`, JSON.stringify({ panels, entries }, null, 2) + '\n')
console.log(`nav.json: ${panels.length} tools, ${entries.length} entries`)
