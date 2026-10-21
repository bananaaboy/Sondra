/**
 * Keeps the address bar and the open tool in step.
 *
 * Every tool now has an address — `#umwandeln`, `#tonart`, `#spuren-trennen` —
 * so a tab can be linked to, bookmarked, sent to somebody, and reached again
 * with the back button. Before this the whole app lived at one URL and the
 * back button left the site.
 *
 * The hash, not a path: `vercel.json` carries no catch-all rewrite, so
 * `/umwandeln` would be a real 404 on reload, and adding one risks shadowing
 * the two functions under `api/`. A fragment needs nothing from the server and
 * cannot break them.
 *
 * It stays out of the way of the share target, which arrives at `?shared=n`
 * and clears that marker once the files are collected.
 */

import { useEffect, useRef } from 'react'

import { PANELS } from '../components/panelMeta'
import { useSession, type PanelId } from '../state/store'

const SLUG_OF = new Map<PanelId, string>(PANELS.map((panel) => [panel.id, panel.slug]))
const PANEL_OF = new Map<string, PanelId>(PANELS.map((panel) => [panel.slug, panel.id]))

/** The panel a fragment names, or null when it names nothing we have. */
function panelFromHash(): PanelId | null {
  const slug = decodeURIComponent(window.location.hash.replace(/^#/, '')).trim().toLowerCase()
  return slug ? (PANEL_OF.get(slug) ?? null) : null
}

export function usePanelRoute() {
  const panel = useSession((state) => state.panel)
  const setPanel = useSession((state) => state.setPanel)

  /**
   * True while the panel change came from the URL rather than from a click.
   *
   * Without it the two effects chase each other: the address changes, that
   * sets the panel, the panel change pushes the address again, and the back
   * button needs two presses to get anywhere.
   */
  const fromUrl = useRef(false)

  // The address wins on arrival, so a pasted link opens what it names.
  useEffect(() => {
    const target = panelFromHash()
    if (target && target !== useSession.getState().panel) {
      fromUrl.current = true
      setPanel(target)
    }
    // Only on mount: later changes are handled by the two effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Back and forward move between tools instead of leaving the site.
  useEffect(() => {
    const onPop = () => {
      const target = panelFromHash() ?? 'start'
      // Only a step that changes the tool is the URL's to answer for. Back
      // from a series to the Merkliste stays on the same tool: no effect
      // runs to clear the flag, and the next click on a tab then left the
      // address on #merkliste — a reload opened the wrong tool.
      if (target === useSession.getState().panel) return
      fromUrl.current = true
      setPanel(target)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [setPanel])

  /**
   * A click on a tab or a tile writes the address.
   *
   * The start screen is the bare root rather than `#start`, so arriving at
   * the site leaves the URL alone and one press of back leaves the site, the
   * way it did before there was any routing. `#start` still *resolves*, since
   * links carrying it may already exist — it simply is not written.
   */
  const first = useRef(true)
  useEffect(() => {
    const slug = SLUG_OF.get(panel)
    if (!slug) return
    const desired = panel === 'start' ? '' : `#${slug}`
    if (window.location.hash === desired) {
      first.current = false
      return
    }

    if (fromUrl.current) {
      // The URL already says this; do not add a second entry for it.
      fromUrl.current = false
      first.current = false
      return
    }

    const next = window.location.pathname + window.location.search + desired
    // The first write is a correction of where we already are, not a step
    // somebody took; only later ones are history worth going back through.
    if (first.current) window.history.replaceState(null, '', next)
    else window.history.pushState(null, '', next)
    first.current = false
  }, [panel])
}
