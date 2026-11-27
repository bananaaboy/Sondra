/**
 * „Sprach-Reihenfolge“: which version of an episode Sondra takes first when an
 * episode comes in several — AniWorld has German, German with subtitles and
 * English with subtitles. Three rows, moved with two small buttons; the first
 * that exists for an episode is the one that is loaded, and when a better one
 * turns up later the Merkliste offers it.
 */

import { useState } from 'react'

import { getLanguageOrder, LANG_LABELS, moveLanguage, setLanguageOrder, type LangCode } from '../../lib/languages'

const arrow = (up: boolean) => (
  <svg viewBox="0 0 16 16" className="size-[14px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={up ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'} />
  </svg>
)

export function LanguageOrder({ className = '' }: { className?: string }) {
  const [order, setOrder] = useState<LangCode[]>(getLanguageOrder)
  const move = (code: LangCode, step: -1 | 1) => setOrder(setLanguageOrder(moveLanguage(order, code, step)))

  return (
    <div className={`flex flex-col gap-[8px] ${className}`}>
      <span id="language-order-label" className="text-small text-prose">
        Sprach-Reihenfolge
      </span>
      <ol aria-labelledby="language-order-label" className="m-0 flex list-none flex-col gap-[4px] p-0">
        {order.map((code, index) => (
          <li key={code} className="flex items-center gap-[10px] rounded-nav bg-raised px-[10px] py-[6px] ring-1 ring-inset ring-line">
            <span className="value w-[1.5ch] text-micro text-muted" aria-hidden>
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-small text-ink">{LANG_LABELS[code]}</span>
            <button
              type="button"
              aria-label={`${LANG_LABELS[code]} nach oben`}
              disabled={index === 0}
              onClick={() => move(code, -1)}
              className="press grid size-[26px] place-items-center rounded-nav text-ink hover:bg-panel-soft disabled:opacity-30"
            >
              {arrow(true)}
            </button>
            <button
              type="button"
              aria-label={`${LANG_LABELS[code]} nach unten`}
              disabled={index === order.length - 1}
              onClick={() => move(code, 1)}
              className="press grid size-[26px] place-items-center rounded-nav text-ink hover:bg-panel-soft disabled:opacity-30"
            >
              {arrow(false)}
            </button>
          </li>
        ))}
      </ol>
      <span className="text-small leading-[1.45] text-muted">
        Eine Folge kommt in der ersten Fassung, die es gibt. Erscheint später eine bessere, bietet die Merkliste sie an — die geladene Datei bleibt, wo sie ist.
      </span>
    </div>
  )
}
