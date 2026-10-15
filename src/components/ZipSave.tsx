/**
 * Saving several files as one archive, under a name of one's own.
 *
 * Every archive used to be named for the user — `bilder.zip`, `beat-chops.zip`
 * — and renamed by hand afterwards. Now the name is a field beside the button:
 * left empty, the suggestion (shown as its placeholder) is used; typed, it is
 * cleaned for the file system and gets its `.zip`. The same field everywhere
 * an archive is made, so it is found where it was last seen.
 */

import { useId, useState } from 'react'

import { zipName } from '../lib/zip'
import { ArrowRight, Button, TextInput } from './ui/primitives'

export function ZipSave({
  suggestion,
  label = 'Als ZIP speichern',
  onSave,
  disabled = false,
  variant = 'primary',
  stacked = false,
}: {
  /** The name used when the field is left empty, without `.zip`. */
  suggestion: string
  label?: string
  /** Gets the file name (with `.zip`) and its stem (for a folder inside). */
  onSave: (name: { file: string; stem: string }) => void
  disabled?: boolean
  variant?: 'primary' | 'quiet'
  /** Field above the button, for a narrow column. */
  stacked?: boolean
}) {
  const [typed, setTyped] = useState('')
  const id = useId()
  const save = () => {
    if (!disabled) onSave(zipName(typed, suggestion))
  }
  return (
    <div className="flex flex-col gap-[6px]">
      <label htmlFor={id} className="text-small text-prose">
        Name des ZIP
      </label>
      <div className={`flex gap-[8px] ${stacked ? 'flex-col' : 'flex-wrap items-center'}`}>
        <div className={`relative ${stacked ? 'w-full' : 'min-w-[200px] flex-1 sm:max-w-[360px]'}`}>
          <TextInput
            id={id}
            value={typed}
            placeholder={suggestion}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                save()
              }
            }}
            className="pr-[48px]"
          />
          <span aria-hidden className="value pointer-events-none absolute right-[12px] top-1/2 -translate-y-1/2 text-small text-muted">
            .zip
          </span>
        </div>
        <Button size="sm" variant={variant} onClick={save} disabled={disabled} className={stacked ? 'w-full' : ''}>
          {label}
          {variant === 'primary' ? <ArrowRight /> : null}
        </Button>
      </div>
    </div>
  )
}
