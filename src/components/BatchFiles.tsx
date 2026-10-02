/**
 * Which files a batch runs over: the session's files that fit, each with a
 * tick, and a way to add more in one pick.
 *
 * „All files of the session“ was the only choice before, so a batch of ten
 * recordings meant a session holding exactly those ten. Files added here are
 * ticked as they arrive; files that cannot become the target (a picture for a
 * sound format) are not listed at all rather than listed and refused.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { formatBytes } from '../lib/format'
import { useFilePicker } from '../hooks/useIngest'
import { useSession, type Asset, type AssetKind } from '../state/store'

export function useBatchSelection(kinds: readonly AssetKind[]) {
  const assets = useSession((state) => state.assets)
  const eligible = useMemo(() => assets.filter((asset) => kinds.includes(asset.kind)), [assets, kinds])
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(eligible.map((asset) => asset.id)))
  const seen = useRef(new Set(eligible.map((asset) => asset.id)))

  // Newly arrived files join the batch; files that left the session leave it.
  useEffect(() => {
    setChosen((current) => {
      const next = new Set([...current].filter((id) => eligible.some((asset) => asset.id === id)))
      for (const asset of eligible) {
        if (!seen.current.has(asset.id)) next.add(asset.id)
      }
      return next
    })
    seen.current = new Set(eligible.map((asset) => asset.id))
  }, [eligible])

  const selected = eligible.filter((asset) => chosen.has(asset.id))
  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const setAll = (on: boolean) => setChosen(new Set(on ? eligible.map((asset) => asset.id) : []))

  return { eligible, selected, chosen, toggle, setAll }
}

export function BatchFiles({
  selection,
  disabled = false,
}: {
  selection: ReturnType<typeof useBatchSelection>
  disabled?: boolean
}) {
  const picker = useFilePicker('für den Stapel geöffnet')
  const { eligible, selected, chosen, toggle, setAll } = selection
  const total = selected.reduce((sum, asset: Asset) => sum + asset.sizeBytes, 0)

  return (
    <div className="flex flex-col gap-[8px]">
      {picker.input}
      <div className="flex flex-wrap items-baseline justify-between gap-x-[12px] gap-y-[4px]">
        <p className="text-small text-prose">
          <span className="value">{selected.length}</span> von <span className="value">{eligible.length}</span>{' '}
          {eligible.length === 1 ? 'Datei' : 'Dateien'} gewählt
          {selected.length > 0 ? <span className="value text-muted"> · {formatBytes(total)}</span> : null}
        </p>
        <span className="flex gap-[12px] text-small">
          <button type="button" disabled={disabled} onClick={() => setAll(selected.length !== eligible.length)}
            className="press rounded-nav text-ink underline underline-offset-[3px] hover:no-underline disabled:opacity-40">
            {selected.length === eligible.length ? 'Keine' : 'Alle'}
          </button>
          <button type="button" disabled={disabled || picker.busy} onClick={picker.open}
            className="press rounded-nav text-ink underline underline-offset-[3px] hover:no-underline disabled:opacity-40">
            {picker.busy ? 'Wird gelesen …' : 'Weitere Dateien hinzufügen'}
          </button>
        </span>
      </div>
      {eligible.length === 0 ? (
        <p className="text-small text-muted">Noch keine passende Datei in der Sitzung.</p>
      ) : (
        <ul className="flex max-h-[280px] flex-col overflow-y-auto">
          {eligible.map((asset) => (
            <li key={asset.id} className="border-t border-line first:border-t-0">
              <label className="flex cursor-pointer items-center gap-[12px] py-[8px]">
                <input
                  type="checkbox"
                  checked={chosen.has(asset.id)}
                  disabled={disabled}
                  onChange={() => toggle(asset.id)}
                  className="h-[16px] w-[16px] shrink-0 accent-[var(--color-ink)]"
                />
                <span className="min-w-0 flex-1 truncate text-small text-prose">{asset.name}</span>
                <span className="value shrink-0 text-micro text-muted">{formatBytes(asset.sizeBytes)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
