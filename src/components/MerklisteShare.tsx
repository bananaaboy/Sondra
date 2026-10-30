/**
 * The Merkliste to someone else, read-only: a dialog that makes the link, and
 * the dialog a link, a file or a QR code opens. The list is in the address, so
 * nothing is uploaded and no service is asked; the one who opens it sees it
 * here, in their own browser, and decides what goes onto their own list.
 *
 * Sending chooses what goes (a few series are the usual case), whether the
 * little cover pictures go too, and how it travels: a link — or several, when
 * the list does not fit in one — as text anybody reads, as a QR code, or as a
 * file. Receiving puts the list next to one's own: what both have, what is new.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { saveBytes } from '../lib/download'
import { createMerkItem, merkItems, setMerkItems, useMerkliste, type SavedLinkItem, type SavedLinkStatus } from '../lib/merkliste'
import {
  compareShared,
  entryFromShared,
  LINK_MAX,
  onSharedFile,
  QR_LINK_MAX,
  readShareFile,
  readShared,
  shareableList,
  shareFile,
  shareFileName,
  shareLinks,
  sharedFromHash,
  shareText,
  type Reading,
  type SharedItem,
  type SharedList,
} from '../lib/merkShare'
import { COVER_TIERS, coverOfItem, thumbOf, thumbUrl, type CoverTier } from '../lib/shareCover'
import { useSession } from '../state/store'
import { STATUS_OPTIONS } from './panels/merklisteShared'
import { Button, Dialog, Notice, TextInput } from './ui/primitives'

const STATUS_LABEL = new Map(STATUS_OPTIONS.map((option) => [option.value, option.label]))
const statusOf = (item: SavedLinkItem): SavedLinkStatus => item.status ?? 'watching'

const pill = (active: boolean) =>
  `press rounded-pill px-[12px] py-[4px] text-small ring-1 ring-inset ${active ? 'bg-ink font-semibold text-on-ink ring-ink' : 'text-prose ring-line hover:text-ink'} disabled:cursor-not-allowed disabled:opacity-40`

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** A cover as the picture it was when the thumbnail was made: any change makes a new one. */
const coverKey = (item: SavedLinkItem) => {
  const cover = coverOfItem(item)
  return cover ? `${cover.src.length}:${cover.src.slice(-32)}:${JSON.stringify(cover.frame ?? null)}:${item.tileFormat ?? 'poster'}` : ''
}

/* -------------------------------------------------------------------------- */
/* Sending                                                                     */
/* -------------------------------------------------------------------------- */

/** A QR code for one link, made here; with several links, one after the other. */
function QrView({ links }: { links: string[] }) {
  const [at, setAt] = useState(0)
  const [code, setCode] = useState<{ size: number; path: string } | null | 'none'>(null)
  const link = links[Math.min(at, links.length - 1)]
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let current = true
    setCode(null)
    void import('../lib/qr').then(({ makeQr }) => current && setCode(makeQr(link) ?? 'none'))
    return () => {
      current = false
    }
  }, [link])
  // It opens below the buttons that asked for it, often below the fold of the dialog.
  useEffect(() => {
    if (code && code !== 'none') box.current?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [code])
  return (
    <div ref={box} className="flex flex-col items-start gap-[10px] border-t border-line pt-[14px]">
      {code === 'none' ? (
        <p className="text-small text-prose">Dieser Link ist zu lang für einen QR-Code.</p>
      ) : code === null ? (
        <p role="status" className="text-small text-prose">
          Macht den Code …
        </p>
      ) : (
        // Black on white whatever the theme: a code on a dark page is not read.
        <svg
          viewBox={`-4 -4 ${code.size + 8} ${code.size + 8}`}
          role="img"
          aria-label={links.length > 1 ? `QR-Code ${at + 1} von ${links.length}` : 'QR-Code der geteilten Merkliste'}
          shapeRendering="crispEdges"
          className="h-[min(78vw,340px)] w-[min(78vw,340px)] rounded-nav bg-white"
        >
          <path d={code.path} fill="#000" />
        </svg>
      )}
      <div className="flex flex-wrap items-center gap-[10px] text-small text-prose">
        {links.length > 1 ? (
          <>
            <Button type="button" size="sm" variant="quiet" disabled={at === 0} onClick={() => setAt(at - 1)}>
              Zurück
            </Button>
            <span className="value" aria-live="polite">
              Code {at + 1} von {links.length}
            </span>
            <Button type="button" size="sm" variant="quiet" disabled={at >= links.length - 1} onClick={() => setAt(at + 1)}>
              Weiter
            </Button>
          </>
        ) : null}
      </div>
      <p className="max-w-[56ch] text-small leading-[1.5] text-prose">
        {links.length > 1
          ? 'Das andere Telefon liest einen Code nach dem anderen mit der Kamera; die Liste ist da, sobald alle gelesen sind.'
          : 'Das andere Telefon liest den Code mit der Kamera und öffnet die Liste.'}
      </p>
    </div>
  )
}

/** Makes the link: what goes, with or without pictures, and the ways to hand it over. */
export function ShareDialog({ items, preselect, onClose }: { items: SavedLinkItem[]; preselect?: string[]; onClose: () => void }) {
  const [name, setName] = useState('')
  const [progress, setProgress] = useState(true)
  const [pictures, setPictures] = useState(true)
  const [tier, setTier] = useState<CoverTier>(preselect?.length === 1 ? 'klein' : 'winzig')
  const [chosen, setChosen] = useState<Set<string>>(() => {
    if (preselect && preselect.length > 0) return new Set(preselect)
    const watching = items.filter((item) => statusOf(item) === 'watching').map((item) => item.id)
    return new Set(watching.length > 0 ? watching : items.map((item) => item.id))
  })
  const [thumbs, setThumbs] = useState<{ key: string; map: Map<string, Uint8Array> } | null>(null)
  const [links, setLinks] = useState<string[] | null>(null)
  const [qrLinks, setQrLinks] = useState<string[] | null>(null)
  /** The same without the pictures, so what they cost can be seen. */
  const [bare, setBare] = useState<{ count: number; chars: number } | null>(null)
  const [showQr, setShowQr] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const cache = useRef(new Map<string, Uint8Array | null>())

  const picked = useMemo(() => items.filter((item) => chosen.has(item.id)), [items, chosen])
  const counts = useMemo(() => {
    const byStatus = new Map<SavedLinkStatus, SavedLinkItem[]>()
    for (const item of items) byStatus.set(statusOf(item), [...(byStatus.get(statusOf(item)) ?? []), item])
    return byStatus
  }, [items])

  const key = `${pictures ? tier : 'ohne'}|${picked.map((item) => item.id).join(',')}`

  // The little pictures, made once per cover and size.
  useEffect(() => {
    if (!pictures) {
      setThumbs({ key, map: new Map() })
      return
    }
    let current = true
    void (async () => {
      const map = new Map<string, Uint8Array>()
      for (const item of picked) {
        const cover = coverOfItem(item)
        if (!cover) continue
        const id = `${item.id}|${tier}|${coverKey(item)}`
        if (!cache.current.has(id)) cache.current.set(id, await thumbOf(cover, item.tileFormat ?? 'poster', tier).catch(() => null))
        const made = cache.current.get(id)
        if (made) map.set(item.id, made)
        if (!current) return
      }
      if (current) setThumbs({ key, map })
    })()
    return () => {
      current = false
    }
    // `key` stands for picked, tier and pictures together.
  }, [key])

  const ready = thumbs?.key === key
  const list: SharedList | null = useMemo(
    () => (ready && picked.length > 0 ? shareableList(picked, name, { progress, thumbs: pictures ? thumbs.map : undefined }) : null),
    [ready, picked, name, progress, pictures, thumbs],
  )
  const withPicture = ready && pictures ? picked.filter((item) => thumbs.map.has(item.id)).length : 0
  const hadCover = picked.filter((item) => coverOfItem(item)).length

  useEffect(() => {
    let current = true
    setLinks(null)
    setCopied(null)
    if (!list) return
    void shareLinks(list, window.location.origin, LINK_MAX).then((made) => current && setLinks(made))
    return () => {
      current = false
    }
  }, [list])

  useEffect(() => {
    let current = true
    setBare(null)
    if (!list || !pictures || withPicture === 0) return
    void shareLinks(shareableList(picked, name, { progress }), window.location.origin, LINK_MAX).then(
      (made) => current && setBare({ count: made.length, chars: made.reduce((sum, link) => sum + link.length, 0) }),
    )
    return () => {
      current = false
    }
    // The list stands for everything it is made of.
  }, [list])

  useEffect(() => {
    let current = true
    setQrLinks(null)
    if (!list || !showQr) return
    void shareLinks(list, window.location.origin, QR_LINK_MAX).then((made) => current && setQrLinks(made))
    return () => {
      current = false
    }
  }, [list, showQr])

  const toggleStatus = (status: SavedLinkStatus) => {
    const group = counts.get(status) ?? []
    setChosen((current) => {
      const next = new Set(current)
      const all = group.every((item) => next.has(item.id))
      for (const item of group) {
        if (all) next.delete(item.id)
        else next.add(item.id)
      }
      return next
    })
  }
  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
    } catch {
      setCopied('nein')
    }
  }
  const tooBig = links !== null && links.length === 0
  const chars = links?.reduce((sum, link) => sum + link.length, 0) ?? 0

  return (
    <Dialog open onClose={onClose} title={picked.length === 1 && preselect?.length === 1 ? `„${picked[0].title}“ empfehlen` : 'Merkliste teilen'} size="lg">
      <div className="flex flex-col gap-[20px]">
        <p className="max-w-[68ch] text-body leading-[1.55] text-prose">
          Der Link trägt die Liste selbst, nur zum Ansehen. Es wird nichts hochgeladen, und es lässt sich nicht zurückholen — wer ihn hat, sieht die gewählten Einträge.
        </p>

        <section aria-label="Was mitgeht" className="flex flex-col gap-[10px] border-t border-line pt-[14px]">
          <div className="flex flex-wrap items-center gap-[8px]">
            {STATUS_OPTIONS.filter((option) => (counts.get(option.value) ?? []).length > 0).map((option) => {
              const group = counts.get(option.value) ?? []
              const all = group.every((item) => chosen.has(item.id))
              return (
                <button key={option.value} type="button" aria-pressed={all} onClick={() => toggleStatus(option.value)} className={pill(all)} title={option.title}>
                  {option.label} <span className="value text-[0.9em] opacity-80">{group.length}</span>
                </button>
              )
            })}
            <span className="flex-1" />
            <button type="button" onClick={() => setChosen(new Set(items.map((item) => item.id)))} className="press text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink">
              Alle
            </button>
            <button type="button" onClick={() => setChosen(new Set())} className="press text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink">
              Keine
            </button>
          </div>
          <ul className="flex max-h-[min(30vh,240px)] flex-col overflow-y-auto">
            {items.map((item) => (
              <li key={item.id} className="max-w-none border-t border-line first:border-t-0">
                <label className="flex cursor-pointer items-baseline gap-[10px] py-[6px]">
                  <input type="checkbox" checked={chosen.has(item.id)} onChange={() => toggle(item.id)} className="h-[16px] w-[16px] shrink-0 translate-y-[2px] accent-[var(--color-ink)]" />
                  <span className="min-w-0 flex-1 truncate text-small font-semibold text-ink" title={item.title}>
                    {item.title}
                  </span>
                  <span className="shrink-0 text-small text-prose">{STATUS_LABEL.get(statusOf(item))}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className="text-small text-prose" aria-live="polite">
            {picked.length} von {items.length} gewählt
          </p>
        </section>

        <section aria-label="Angaben" className="flex flex-col gap-[12px] border-t border-line pt-[14px]">
          <label className="flex max-w-[420px] flex-col gap-[4px]">
            <span className="text-small text-prose">Ihr Name auf der Liste (frei)</span>
            <TextInput value={name} maxLength={40} onChange={(event) => setName(event.target.value)} placeholder="zum Beispiel Mia" className="font-sans" />
          </label>
          <label className="flex items-start gap-[10px] text-small leading-[1.5] text-prose">
            <input type="checkbox" checked={progress} onChange={(event) => setProgress(event.target.checked)} className="mt-[3px] h-[16px] w-[16px] accent-[var(--color-ink)]" />
            <span>Wie weit Sie sind und Ihre Bewertungen mitgeben. Nie dabei: die Adressen der Folgen und Ihre Notizen.</span>
          </label>
          <label className="flex items-start gap-[10px] text-small leading-[1.5] text-prose">
            <input type="checkbox" checked={pictures} onChange={(event) => setPictures(event.target.checked)} className="mt-[3px] h-[16px] w-[16px] accent-[var(--color-ink)]" />
            <span>Kleine Bilder der Cover mitgeben — sie stecken im Link selbst, nichts wird nachgeladen.</span>
          </label>
          {pictures ? (
            <div className="flex flex-col gap-[6px] pl-[26px]">
              <div role="radiogroup" aria-label="Grösse der Bilder" className="flex flex-wrap gap-[8px]">
                {COVER_TIERS.map((option) => (
                  <button key={option.id} type="button" role="radio" aria-checked={tier === option.id} onClick={() => setTier(option.id)} className={pill(tier === option.id)}>
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="text-small text-prose" aria-live="polite">
                {COVER_TIERS.find((option) => option.id === tier)?.note}
                {ready ? ` · ${hadCover === 0 ? 'keiner der gewählten Einträge hat ein Cover' : `${withPicture} von ${hadCover} mit Bild`}` : ''}
                {ready && hadCover > withPicture ? ' — manche Bilder liessen sich nicht lesen' : ''}
              </p>
            </div>
          ) : null}
        </section>

        <section aria-label="Weitergeben" className="flex flex-col gap-[12px] border-t border-line pt-[14px]">
          {picked.length === 0 ? (
            <p className="text-small text-prose">Wählen Sie mindestens einen Eintrag.</p>
          ) : links === null || !list ? (
            <p role="status" aria-busy="true" className="text-small text-prose">
              {ready ? 'Wird gemacht …' : 'Macht die Bilder …'}
            </p>
          ) : tooBig ? (
            <Notice tone="warn" title="Zu gross für Links">
              Selbst in Teilen sind das zu viele Nachrichten. Wählen Sie weniger Einträge, kleinere Bilder oder keine — oder geben Sie die Liste als Datei weiter.
            </Notice>
          ) : (
            <p className="text-small text-prose" aria-live="polite">
              {links.length === 1
                ? `Ein Link, ${chars} Zeichen`
                : `${links.length} Links, ${chars} Zeichen zusammen — jeder in eine eigene Nachricht, der andere öffnet sie nacheinander`}
              {bare ? ` · ohne Bilder ${bare.count === 1 ? 'ein Link' : `${bare.count} Links`}, ${bare.chars} Zeichen` : ''}.
            </p>
          )}

          {links && links.length > 1 ? (
            <ul className="flex max-h-[180px] flex-col overflow-y-auto">
              {links.map((link, index) => (
                <li key={link} className="flex max-w-none items-center gap-[10px] border-t border-line py-[5px] first:border-t-0">
                  <span className="value w-[3.4em] shrink-0 text-small text-prose">
                    {index + 1}/{links.length}
                  </span>
                  <span className="value min-w-0 flex-1 truncate text-small text-ink" title={link}>
                    {link}
                  </span>
                  <button type="button" onClick={() => void copy(`teil${index}`, link)} className="press shrink-0 text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink">
                    {copied === `teil${index}` ? '● Kopiert' : 'Kopieren'}
                  </button>
                </li>
              ))}
            </ul>
          ) : links && links.length === 1 ? (
            <TextInput readOnly value={links[0]} onFocus={(event) => event.currentTarget.select()} aria-label="Link" />
          ) : null}

          <div className="flex flex-wrap items-center gap-[10px]">
            {tooBig ? (
              <Button type="button" disabled={!list} onClick={async () => list && saveBytes(await shareFile(list), shareFileName())}>
                Als Datei speichern
              </Button>
            ) : (
              <Button type="button" disabled={!links || links.length === 0} onClick={() => links && void copy('links', links.join(links.length > 1 ? '\n\n' : ''))}>
                {links && links.length > 1 ? `Alle ${links.length} Links kopieren` : 'Link kopieren'}
              </Button>
            )}
            <Button type="button" variant="quiet" disabled={!list || links === null} onClick={() => list && links && void copy('text', shareText(list, links))}>
              Als Text kopieren
            </Button>
            <Button type="button" variant="quiet" aria-pressed={showQr} disabled={!list || tooBig} onClick={() => setShowQr((current) => !current)}>
              {showQr ? 'QR-Code ausblenden' : 'QR-Code zeigen'}
            </Button>
            {!tooBig ? (
              <Button type="button" variant="quiet" disabled={!list} onClick={async () => list && saveBytes(await shareFile(list), shareFileName())}>
                Als Datei speichern
              </Button>
            ) : null}
            <span className="flex-1" />
            <Button type="button" variant="quiet" onClick={onClose}>
              Schliessen
            </Button>
          </div>
          <p aria-live="polite" className="min-h-[1.5em] text-small text-prose">
            {copied === 'links' ? '● Kopiert' : copied === 'text' ? '● Als Text kopiert — jede Zeile eine Serie, darunter der Link' : copied === 'nein' ? 'Nicht kopiert — markieren Sie den Link selbst.' : ''}
          </p>
          {showQr ? (
            qrLinks === null ? (
              <p role="status" className="text-small text-prose">
                Macht die Codes …
              </p>
            ) : qrLinks.length === 0 ? (
              <p className="text-small text-prose">Zu gross für QR-Codes — wählen Sie weniger Einträge oder kleinere Bilder.</p>
            ) : (
              <QrView links={qrLinks} />
            )
          ) : null}
        </section>
      </div>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/* Receiving                                                                   */
/* -------------------------------------------------------------------------- */

/** The address as it was when the page loaded: the page's own routing rewrites it a moment later. */
const SHARED_AT_LOAD = typeof window !== 'undefined' ? sharedFromHash(window.location.hash) : null

/** What a link, a file or a code opens: the list next to one's own, and „Zu meiner Merkliste“ for what is new. */
export function SharedListDialog() {
  const [open, setOpen] = useState(SHARED_AT_LOAD !== null)
  const [reading, setReading] = useState<Reading | null>(null)
  const [skip, setSkip] = useState<Set<string>>(new Set())
  const [how, setHow] = useState<'wie dort' | 'später'>('wie dort')
  const [added, setAdded] = useState<number | null>(null)
  const mine = useMerkliste()
  const setPanel = useSession((state) => state.setPanel)

  const arrive = useCallback((next: Promise<Reading>) => {
    setOpen(true)
    setReading(null)
    setSkip(new Set())
    setAdded(null)
    void next.then(setReading)
  }, [])

  useEffect(() => {
    if (SHARED_AT_LOAD) arrive(readShared(SHARED_AT_LOAD))
  }, [arrive])

  // A link opened in a page that is already there: only the hash changes.
  useEffect(() => {
    const onHash = (event: HashChangeEvent) => {
      // From the event: the page's own routing may have rewritten the address by the time this runs.
      let text: string | null = null
      try {
        text = sharedFromHash(new URL(event.newURL).hash)
      } catch {
        // No address to read.
      }
      if (text) arrive(readShared(text))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [arrive])

  // A file, whichever way it came.
  useEffect(
    () =>
      onSharedFile((bytes) =>
        arrive(readShareFile(bytes).then((list): Reading => (list ? { kind: 'list', list } : { kind: 'broken' }))),
      ),
    [arrive],
  )

  const list = reading?.kind === 'list' ? reading.list : null
  const comparison = useMemo(() => (list ? compareShared(list, mine) : null), [list, mine])
  const pictures = useMemo(() => new Map((comparison?.fresh ?? []).map((item) => [item, item.thumb ? thumbUrl(item.thumb, item.tile ?? 'poster') : null] as const)), [comparison])
  if (!open) return null

  const close = () => {
    setOpen(false)
    try {
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    } catch {
      // The address stays; nothing depends on it.
    }
  }
  const fresh = comparison?.fresh ?? []
  const taking = fresh.filter((item) => !skip.has(item.title))
  const title = list?.name ? `Merkliste von ${list.name}` : 'Geteilte Merkliste'
  const who = list?.name ? list.name : 'der anderen Person'

  return (
    <Dialog open onClose={close} title={title} size="lg">
      <div className="flex flex-col gap-[16px]">
        {reading === null ? (
          <p role="status" className="text-body text-prose">
            Liest die Liste …
          </p>
        ) : reading.kind === 'broken' ? (
          <Notice tone="error" title="Das ist nicht lesbar">
            Der Link oder die Datei ist abgeschnitten oder nicht von Sondra. Bitten Sie darum, sie noch einmal zu schicken.
          </Notice>
        ) : reading.kind === 'parts' ? (
          <>
            <p className="text-body leading-[1.55] text-ink" aria-live="polite">
              Teil {reading.got.length === 1 ? `${reading.got[0]}` : reading.got.join(', ')} von {reading.of} ist da.
            </p>
            <p className="max-w-[60ch] text-small leading-[1.55] text-prose">
              Die Liste kam in {reading.of} Teilen, weil sie nicht in einen Link passte. Öffnen Sie auch die anderen Links aus derselben Nachricht — was schon geöffnet ist, bleibt zwei Tage gemerkt.
            </p>
            <ol aria-label="Teile" className="flex flex-wrap gap-[8px]">
              {Array.from({ length: reading.of }, (_, index) => index + 1).map((n) => (
                <li key={n} className={`value max-w-none rounded-pill px-[12px] py-[4px] text-small ring-1 ring-inset ${reading.got.includes(n) ? 'bg-ink text-on-ink ring-ink' : 'text-prose ring-line'}`}>
                  {n}
                </li>
              ))}
            </ol>
            <div>
              <Button type="button" variant="quiet" onClick={close}>
                Schliessen
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-small leading-[1.55] text-prose" aria-live="polite">
              {plural(list!.items.length, 'Eintrag', 'Einträge')} · nur zum Ansehen. Beide haben <span className="value">{comparison!.both.length}</span> · nur bei Ihnen{' '}
              <span className="value">{comparison!.onlyMine}</span> · nur bei {who} <span className="value">{fresh.length}</span>.
            </p>

            {fresh.length === 0 ? (
              <p className="border-t border-line pt-[12px] text-body text-prose">{list!.items.length === 0 ? 'Die Liste ist leer.' : 'Alles, was auf dieser Liste steht, haben Sie schon.'}</p>
            ) : (
              <section aria-label={`Neu für Sie: ${fresh.length}`} className="flex flex-col gap-[8px] border-t border-line pt-[12px]">
                <div className="flex flex-wrap items-center gap-[10px]">
                  <h3 className="text-subheading text-ink">Neu für Sie</h3>
                  <span className="value text-small text-prose">{taking.length} von {fresh.length} gewählt</span>
                  <span className="flex-1" />
                  <button type="button" onClick={() => setSkip(new Set())} className="press text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink">
                    Alle
                  </button>
                  <button type="button" onClick={() => setSkip(new Set(fresh.map((item) => item.title)))} className="press text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink">
                    Keine
                  </button>
                </div>
                <ul className="rise-list flex max-h-[min(44dvh,400px)] flex-col overflow-y-auto">
                  {fresh.map((item: SharedItem) => {
                    const picture = pictures.get(item)
                    return (
                      <li key={item.title} className="max-w-none border-t border-line first:border-t-0">
                        <label className="flex cursor-pointer items-center gap-[12px] py-[7px]">
                          <input
                            type="checkbox"
                            checked={!skip.has(item.title)}
                            disabled={added !== null}
                            onChange={() =>
                              setSkip((current) => {
                                const next = new Set(current)
                                if (!next.delete(item.title)) next.add(item.title)
                                return next
                              })
                            }
                            className="h-[16px] w-[16px] shrink-0 accent-[var(--color-ink)]"
                          />
                          {picture ? (
                            <img src={picture} alt="" width={32} height={item.tile === 'manga' ? 45 : 48} className="h-[48px] w-[32px] shrink-0 rounded-nav bg-panel-soft object-cover" />
                          ) : (
                            <span aria-hidden className="h-[48px] w-[32px] shrink-0 rounded-nav bg-panel-soft" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-small font-semibold text-ink" title={item.title}>
                              {item.title}
                            </span>
                            <span className="block text-small text-prose">
                              {STATUS_LABEL.get(item.status ?? 'watching')}
                              {item.seen ? ` · ${plural(item.seen, 'Folge', 'Folgen')}` : ''}
                              {item.rating ? ` · ★ ${item.rating}` : ''}
                            </span>
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
                <div role="radiogroup" aria-label="Übernehmen als" className="flex flex-wrap items-center gap-[8px] pt-[4px]">
                  <span className="text-small text-prose">Übernehmen</span>
                  {(['wie dort', 'später'] as const).map((option) => (
                    <button key={option} type="button" role="radio" aria-checked={how === option} disabled={added !== null} onClick={() => setHow(option)} className={pill(how === option)}>
                      {option === 'wie dort' ? 'wie dort' : 'als Später'}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {comparison!.both.length > 0 ? (
              <details className="border-t border-line pt-[10px] text-small text-prose">
                <summary className="press cursor-pointer text-ink">Schon auf Ihrer Liste ({comparison!.both.length})</summary>
                <ul className="mt-[6px] flex max-h-[160px] flex-col overflow-y-auto">
                  {comparison!.both.map((item) => (
                    <li key={item.title} className="max-w-none border-t border-line py-[4px] first:border-t-0">
                      {item.title}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <div className="flex flex-wrap items-center gap-[10px]">
              {added === null ? (
                <Button
                  type="button"
                  disabled={taking.length === 0}
                  onClick={() => {
                    const made = taking.map((item) => createMerkItem(entryFromShared(item, how)))
                    setMerkItems(() => [...merkItems(), ...made])
                    setAdded(made.length)
                  }}
                >
                  {taking.length === 0 ? 'Nichts gewählt' : `${plural(taking.length, 'Eintrag', 'Einträge')} zu meiner Merkliste`}
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={() => {
                    close()
                    setPanel('merkliste')
                  }}
                >
                  Zur Merkliste
                </Button>
              )}
              <Button type="button" variant="quiet" onClick={close}>
                Schliessen
              </Button>
              <span aria-live="polite" className="text-small text-prose">
                {added !== null ? `● ${added} hinzugefügt` : ''}
              </span>
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}
