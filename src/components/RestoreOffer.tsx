/**
 * „Letzte Sitzung wiederherstellen“ — above whatever tool is open, until the
 * person answers. A mark at the edge, like every other state note here, not
 * a dialog in the way: the page works while it stands there.
 */

import { describeOffer, useKept } from '../hooks/useKeptSession'
import { Button, Mark } from './ui/primitives'

export function RestoreOffer() {
  const offer = useKept((state) => state.offer)
  const keep = useKept((state) => state.keep)
  const restoring = useKept((state) => state.restoring)
  const error = useKept((state) => state.error)
  const restore = useKept((state) => state.restore)
  const discard = useKept((state) => state.discard)

  if (!offer || !keep) return null

  return (
    <div role="region" aria-label="Letzte Sitzung" className="rise flex flex-wrap items-center gap-x-[16px] gap-y-[8px] border-b border-line pb-[16px]">
      <div className="flex min-w-0 flex-1 gap-[12px]">
        <Mark state={error ? 'warn' : 'measured'} />
        <p className="min-w-0 text-small leading-[1.55] text-prose">
          <span className="font-semibold text-ink">Letzte Sitzung: </span>
          <span className="value">{describeOffer(offer)}</span>
          {error ? <span className="block text-ink">Wiederherstellen ging nicht: {error}</span> : null}
        </p>
      </div>
      <div className="flex gap-[8px]">
        <Button size="sm" disabled={restoring} onClick={() => void restore()}>
          {restoring ? 'Wird geladen …' : 'Wiederherstellen'}
        </Button>
        <Button size="sm" variant="ghost" disabled={restoring} onClick={() => void discard()}>
          Verwerfen
        </Button>
      </div>
    </div>
  )
}
