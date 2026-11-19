/**
 * Writes the table the native app's navigation (`native/sondra-app`) is tested against: the tools with
 * their addresses, labels and summaries, and how the tab row groups them. The Rust side must hold the
 * same, so a tool added, renamed or moved on the web that is not carried over fails the check.
 *
 *   npm run native:golden
 */
import { mkdirSync, writeFileSync } from 'node:fs'

import { PANELS, TAB_ENTRIES } from '../src/components/panelMeta'
import { ACTIONS, GROUP_LABEL, searchActions, startGroups, START_FILTERS } from '../src/lib/actions'

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

// The tiles of the start page: shipped as data (the app reads it), so a tool added on the web cannot be
// forgotten here — and what the web's search finds for some typical questions, in its order.
mkdirSync('native/sondra-app/data', { recursive: true })
writeFileSync(
  'native/sondra-app/data/actions.json',
  JSON.stringify({ groups: GROUP_LABEL, filters: START_FILTERS, start: startGroups().map((g) => ({ group: g.group, ids: g.actions.map((a) => a.id) })), actions: ACTIONS }, null, 2) + '\n',
)
const queries = ['mp3 aus video', 'tonart', 'extract audio', 'tonspur', 'Ordner', 'youtube', 'bpm', 'untertitel', 'zzzz', 'handy', 'aufnehmen', 'film abspielen', '']
writeFileSync(
  `${outDir}/search.json`,
  JSON.stringify(queries.map((query) => ({ query, ids: searchActions(query).map((a) => a.id) })), null, 2) + '\n',
)
console.log(`actions.json: ${ACTIONS.length} actions, ${queries.length} searches`)
