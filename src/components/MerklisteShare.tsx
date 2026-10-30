/**
 * The Merkliste to someone else, read-only: a dialog that makes the link, and
 * the dialog a link opens. The list is in the address, so nothing is uploaded;
 * the one who opens it sees it here, in their own browser, and decides
 * whether anything goes onto their own list.
 */

import { useEffect, useState } from 'react'

import { createMerkItem, merkItems, setMerkItems, useMerkliste, type SavedLinkItem } from '../lib/merkliste'
import { decodeShare, LINK_MAX, newFromShared, shareableList, shareLink, sharedFromHash, type SharedList } from '../lib/merkShare'
import { saveBytes } from '../lib/download'
import { exportMerkliste } from '../lib/merkliste'
import { useSession } from '../state/store'
import { STATUS_OPTIONS } from './panels/merklisteShared'
import { Button, Dialog, Notice, TextInput } from './ui/primitives'

const STATUS_LABEL = new Map(STATUS_OPTIONS.map((option) => [option.value, option.label]))

/** Makes the link: a name, whether progress goes along, and the result to copy. */
export function ShareDialog({ items, onClose }: { items: SavedLinkItem[]; onClose: () => void }) {
  const [name, setName] = useState('')
  const [progress, setProgress] = useState(true)
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  useEffect(() => {
    let current = true
    setLink(null)
    setCopied(null)
    void shareLink(shareableList(items, name, { progress }), window.location.origin).then((made) => current && setLink(made))
    return () => {
      current = false
    }
  }, [items, name, progress])
  const tooLong = link !== null && link.length > LINK_MAX
  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied('yes')
    } catch {
      setCopied('no')
    }
  }
  return (
    <Dialog open onClose={onClose} title="Merkliste teilen" size="md">
      <div className="flex flex-col gap-[16px]">
        <p className="text-body leading-[1.55] text-prose">
          Der Link trägt die Liste selbst: {items.length} {items.length === 1 ? 'Eintrag' : 'Einträge'}, nur zum Ansehen. Es wird nichts hochgeladen, und es lässt sich
          nicht zurückholen — wer den Link hat, sieht die Liste.
        </p>
        <label className="flex flex-col gap-[4px]">
          <span className="text-small text-prose">Ihr Name auf der Liste (frei)</span>
          <TextInput value={name} maxLength={40} onChange={(event) => setName(event.target.value)} placeholder="zum Beispiel Mia" className="font-sans" />
        </label>
        <label className="flex items-start gap-[10px] text-small leading-[1.5] text-prose">
          <input type="checkbox" checked={progress} onChange={(event) => setProgress(event.target.checked)} className="mt-[3px] h-[16px] w-[16px] accent-[var(--color-ink)]" />
          <span>
            Wie weit Sie sind und Ihre Bewertungen mitgeben. Nicht dabei: die Adressen der Folgen, Notizen und Cover.
          </span>
        </label>
        {tooLong ? (
          <Notice tone="warn" title="Zu lang für einen Link">
            {link!.length} Zeichen — Chats und Mails schneiden so etwas ab. Speichern Sie die Liste als Datei; wer sie bekommt, liest sie unter „Merkliste“ ein.
          </Notice>
        ) : (
          <label className="flex flex-col gap-[4px]">
            <span className="text-small text-prose">Link</span>
            <TextInput readOnly value={link ?? 'Wird gemacht …'} onFocus={(event) => event.currentTarget.select()} aria-busy={link === null} />
          </label>
        )}
        <div className="flex flex-wrap items-center gap-[10px]">
          {tooLong ? (
            <Button
              type="button"
              onClick={() => saveBytes(new TextEncoder().encode(exportMerkliste(items)), `Sondra-Merkliste-${new Date().toISOString().slice(0, 10)}.json`, 'application/json')}
            >
              Als Datei speichern
            </Button>
          ) : (
            <Button type="button" disabled={!link} onClick={() => void copy()}>
              Link kopieren
            </Button>
          )}
          <Button type="button" variant="quiet" onClick={onClose}>
            Schliessen
          </Button>
          <span aria-live="polite" className="text-small text-prose">
            {copied === 'yes' ? '● Kopiert' : copied === 'no' ? 'Nicht kopiert — markieren Sie den Link selbst.' : ''}
          </span>
        </div>
      </div>
    </Dialog>
  )
}

/** The address as it was when the page loaded: the page's own routing rewrites it a moment later. */
const SHARED_AT_LOAD = typeof window !== 'undefined' ? sharedFromHash(window.location.hash) : null

/** What a link opens: the list, as it is, and „Zu meiner Merkliste“ for what is new to this one. */
export function SharedListDialog() {
  const [open, setOpen] = useState(SHARED_AT_LOAD !== null)
  const [list, setList] = useState<SharedList | null | 'broken'>(null)
  const [added, setAdded] = useState<number | null>(null)
  const mine = useMerkliste()
  const setPanel = useSession((state) => state.setPanel)
  useEffect(() => {
    if (!SHARED_AT_LOAD) return
    let current = true
    void decodeShare(SHARED_AT_LOAD).then((decoded) => current && setList(decoded ?? 'broken'))
    return () => {
      current = false
    }
  }, [])
  if (!open) return null
  const close = () => {
    setOpen(false)
    try {
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    } catch {
      // The address stays; nothing depends on it.
    }
  }
  const fresh = list && list !== 'broken' ? newFromShared(list, mine) : []
  return (
    <Dialog open onClose={close} title={list && list !== 'broken' && list.name ? `Merkliste von ${list.name}` : 'Geteilte Merkliste'} size="md">
      <div className="flex flex-col gap-[16px]">
        {list === null ? (
          <p role="status" className="text-body text-prose">
            Liest die Liste …
          </p>
        ) : list === 'broken' ? (
          <Notice tone="error" title="Der Link ist nicht lesbar">
            Er ist abgeschnitten oder nicht von Sondra. Bitten Sie darum, ihn noch einmal zu schicken.
          </Notice>
        ) : (
          <>
            <p className="text-small text-prose">
              {list.items.length} {list.items.length === 1 ? 'Eintrag' : 'Einträge'} · nur zum Ansehen. Auf Ihrer eigenen Liste ändert sich nur, was Sie unten hinzufügen.
            </p>
            {list.items.length === 0 ? (
              <p className="text-small text-prose">Die Liste ist leer.</p>
            ) : (
              <ul className="rise-list flex max-h-[min(46dvh,420px)] flex-col overflow-y-auto">
                {list.items.map((item, index) => (
                  <li key={`${item.title}-${index}`} className="flex max-w-none items-baseline gap-[10px] border-t border-line py-[7px] first:border-t-0">
                    <span className="min-w-0 flex-1 truncate text-small font-semibold text-ink" title={item.title}>
                      {item.title}
                    </span>
                    <span className="shrink-0 text-small text-prose">
                      {STATUS_LABEL.get(item.status ?? 'watching')}
                      {item.seen ? ` · ${item.seen} ${item.seen === 1 ? 'Folge' : 'Folgen'}` : ''}
                      {item.rating ? ` · ★ ${item.rating}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-[10px]">
              {added === null ? (
                <Button
                  type="button"
                  disabled={fresh.length === 0}
                  onClick={() => {
                    const made = fresh.map((item) =>
                      createMerkItem({
                        title: item.title,
                        ...(item.status ? { status: item.status } : {}),
                        ...(item.rating ? { rating: item.rating } : {}),
                        ...(item.season !== undefined ? { season: item.season } : {}),
                        ...(item.episode !== undefined ? { episode: item.episode } : {}),
                      }),
                    )
                    setMerkItems(() => [...merkItems(), ...made])
                    setAdded(made.length)
                  }}
                >
                  {fresh.length === 0 ? 'Alles schon auf Ihrer Liste' : `${fresh.length} ${fresh.length === 1 ? 'Eintrag' : 'Einträge'} zu meiner Merkliste`}
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
                {added !== null ? `● ${added} hinzugefügt` : list.items.length - fresh.length > 0 && fresh.length > 0 ? `${list.items.length - fresh.length} schon vorhanden` : ''}
              </span>
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}
