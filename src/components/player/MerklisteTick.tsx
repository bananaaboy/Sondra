/**
 * The Merkliste, under the picture: which episode the file is, and — once it
 * has run to 90 % — that it was ticked off, with a way back.
 *
 * Nothing shows for a file whose name matches no series. The tick happens
 * once per file and episode; taken back, it stays taken back while the file
 * plays.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { alreadySeen, matchEpisode, seenEpisode, SEEN_AT } from '../../lib/episodeMatch'
import { requestOpenSeries, setMerkItems, updateMerkItem, useMerkliste, type SavedLinkItem } from '../../lib/merkliste'
import { useSession } from '../../state/store'

const linkClass = 'text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink'

export function MerklisteTick({ name, time, duration, enabled }: { name: string; time: number; duration: number; enabled: boolean }) {
  const items = useMerkliste()
  const setPanel = useSession((state) => state.setPanel)
  const match = useMemo(() => (enabled ? matchEpisode(name, items) : null), [enabled, name, items])
  const key = match ? `${name}|${match.item.id}|${match.season}|${match.episode}` : null
  /** What this file ticked off, and the entry as it was before. */
  const [ticked, setTicked] = useState<{ key: string; before: SavedLinkItem; undone: boolean } | null>(null)
  /**
   * The file seen playing short of 90 %. On a switch to the next file the
   * name changes one render before the player resets its clock, so the new
   * episode met the old one's end — and with „Automatisch weiter“ every
   * episode was ticked off the moment it began.
   */
  const armed = useRef<string | null>(null)

  useEffect(() => {
    if (!match || !key || ticked?.key === key) return
    if (!(duration > 0)) return
    if (time / duration < SEEN_AT) {
      armed.current = key
      return
    }
    if (armed.current !== key || alreadySeen(match)) return
    const before = match.item
    updateMerkItem(before.id, seenEpisode(before, match.season, match.episode))
    setTicked({ key, before, undone: false })
  }, [match, key, ticked, time, duration])

  if (!match) return null

  const where = match.season === 0 ? `Film ${match.episode}` : `Staffel ${match.season}, Folge ${match.episode}`
  const open = () => {
    requestOpenSeries(match.item.id)
    setPanel('merkliste')
  }
  const undo = () => {
    if (!ticked) return
    // Counted as changed now, or the copy in Anytype would bring the tick back.
    setMerkItems((current) => current.map((entry) => (entry.id === ticked.before.id ? { ...ticked.before, updatedAt: Date.now() } : entry)))
    setTicked({ ...ticked, undone: true })
  }

  const mine = ticked?.key === key
  return (
    <p role="status" className="flex flex-wrap items-baseline gap-x-[10px] gap-y-[4px] text-small text-prose">
      <span className="font-semibold text-ink">Merkliste</span>
      <button type="button" onClick={open} className={linkClass}>
        {match.item.title}
      </button>
      <span>· {where}</span>
      {mine && !ticked.undone ? (
        <>
          <span>— abgehakt.</span>
          <button type="button" onClick={undo} className={`${linkClass} font-semibold`}>
            Rückgängig
          </button>
        </>
      ) : mine && ticked.undone ? (
        <span>— nicht abgehakt.</span>
      ) : alreadySeen(match) ? (
        <span>— schon gesehen.</span>
      ) : (
        <span>— wird ab {Math.round(SEEN_AT * 100)} % abgehakt.</span>
      )}
    </p>
  )
}
