/**
 * The component vocabulary, as the parts of a printed form.
 *
 * Every element here answers one question: is this something the form says,
 * or something the machine found? The form is set in Public Sans on paper and
 * ruled with hairlines. What the machine found is set in Courier Prime,
 * right-aligned, with its unit in its own column — the way a value typed into
 * a certificate sits apart from the field it was typed into.
 *
 * Two rules hold the system together, and both are refusals:
 *
 * Nothing is a card. A certificate has no boxes; it has rules. A section is
 * separated from the one above it by a line and by space, never by a border
 * on four sides, and because nothing lies on top of the sheet, nothing casts
 * a shadow onto it. The two shadow levels belong to the editor stage, which
 * is a plate mounted over the page rather than part of it.
 *
 * Ink is spent, not spread. Forest Ink marks rules, headings and the
 * single action a section is asking for. Everywhere else the page is paper
 * and graphite.
 */

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

type Tone = 'cream' | 'keylime' | 'mint' | 'sage' | 'slate'

/**
 * A region of the sheet.
 *
 * `cream` and `keylime` are top-level sections: a rule across the full width,
 * then air, then the content. No fill, no border, no shadow — the rule and the
 * space are the whole separation. The other three are blocks set *into* a
 * section, which take a tint so the eye reads them as inset rather than as
 * another object stacked on the page.
 */
const TONE_CLASS: Record<Tone, string> = {
  cream: 'border-t-2 border-rule pt-[20px]',
  keylime: 'border-t-2 border-rule pt-[20px]',
  mint: 'rounded-card bg-panel-soft ring-1 ring-inset ring-line/70',
  sage: 'rounded-card bg-panel-mid ring-1 ring-inset ring-line/70',
  slate: 'rounded-card bg-panel-cool ring-1 ring-inset ring-line/70',
}

export function Card({
  tone = 'keylime',
  padded = true,
  size = 'default',
  className = '',
  children,
}: {
  tone?: Tone
  padded?: boolean
  size?: 'default' | 'compact'
  className?: string
  children: ReactNode
}) {
  const inset = tone === 'mint' || tone === 'sage' || tone === 'slate'
  const padding = !padded
    ? ''
    : inset
      ? size === 'compact'
        ? 'p-[12px]'
        : 'p-[16px]'
      : size === 'compact'
        ? 'pb-[16px]'
        : 'pb-[24px]'
  return <div className={`${TONE_CLASS[tone]} ${padding} ${className}`}>{children}</div>
}

/**
 * The head of a section.
 *
 * Not a kicker: there is no heading underneath repeating it. It names a region
 * the reader could not otherwise name — "Zielwerte", "Ergebnis", "Nächstbeste"
 * — and it is therefore the heading itself, set as one. The rule above it does
 * the separating, which is why it needs neither a box nor capital letters.
 */
export function SectionHead({
  children,
  className = '',
  rule = true,
}: {
  children: ReactNode
  className?: string
  /** Off where the caller already drew a rule. */
  rule?: boolean
}) {
  return (
    <p
      className={`text-small font-semibold tracking-[-0.005em] text-ink ${
        rule ? 'border-t border-line pt-[8px]' : ''
      } ${className}`}
    >
      {children}
    </p>
  )
}

/**
 * The state of a value, as a mark in the margin.
 *
 * Readable before anything is read, which is the point: an em dash is a field
 * nobody has filled in, a filled dot is a value that was measured, an
 * exclamation is one that came back outside its tolerance. A sentence saying
 * the same thing would have to be read first.
 */
export function Mark({ state }: { state: 'blank' | 'measured' | 'warn' }) {
  const glyph = state === 'blank' ? '—' : state === 'measured' ? '●' : '!'
  const tone = state === 'warn' ? 'text-ink' : state === 'measured' ? 'text-ink/70' : 'text-muted'
  const label =
    state === 'blank' ? 'noch nicht gemessen' : state === 'measured' ? 'gemessen' : 'außerhalb der Toleranz'
  return (
    <span className={`mark ${tone}`} title={label} aria-label={label} role="img">
      {glyph}
    </span>
  )
}

/** A stamped field: a value the form carries rather than one it was given. */
export function Badge({
  children,
  tone = 'cream',
  className = '',
}: {
  children: ReactNode
  tone?: 'cream' | 'forest'
  className?: string
}) {
  const styles = tone === 'forest' ? 'bg-ink text-on-ink' : 'text-ink ring-1 ring-inset ring-rule'
  return (
    <span
      className={`inline-flex items-center gap-[6px] px-[8px] py-[3px] text-micro uppercase tracking-[0.08em] leading-none ${styles} ${className}`}
    >
      {children}
    </span>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'quiet' | 'ghost'
  size?: 'sm' | 'md'
}

/**
 * What the section is asking for.
 *
 * Square, unshadowed, and filled with ink only for the one action that
 * completes a section — there is one place to act. `quiet` is a ruled
 * field you may also press; `ghost` is a word in the running text.
 */
export function Button({ variant = 'primary', size = 'md', className = '', ...props }: ButtonProps) {
  const base =
    'press inline-flex items-center justify-center gap-[8px] rounded-nav font-sans font-medium disabled:cursor-not-allowed disabled:opacity-40'
  const sizes = size === 'sm' ? 'px-[12px] py-[8px] text-small' : 'px-[16px] py-[12px] text-body'
  const variants = {
    primary: 'bg-ink text-on-ink hover:bg-ink-hover',
    quiet: 'bg-raised text-ink ring-1 ring-inset ring-rule hover:bg-panel-soft',
    ghost: 'bg-transparent text-ink underline decoration-rule hover:decoration-ink',
  }[variant]

  return <button className={`${base} ${sizes} ${variants} ${className}`} {...props} />
}

/**
 * A line of the form: what is being asked on the left, the field on the right.
 *
 * Below `sm` the two stack, because a German label and a control side by side
 * in 340 pixels leaves room for neither.
 */
export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <label className={`flex flex-col gap-[4px] border-t border-line pt-[8px] ${className}`}>
      <span className="text-small text-prose">{label}</span>
      {children}
      {hint ? <span className="text-small leading-[1.45] text-muted">{hint}</span> : null}
    </label>
  )
}

const CONTROL =
  'w-full rounded-nav border-0 bg-raised px-[12px] py-[8px] text-small text-prose outline-none ring-1 ring-inset ring-line focus:ring-ink'

/** A choice off a printed list, so it keeps the form's own face. */
export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${CONTROL} appearance-none pr-[32px] ${className}`} {...props} />
}

/** Something typed in, so it is set in the face of things typed in. */
export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${CONTROL} value ${className}`} {...props} />
}

export function Slider({
  label,
  value,
  display,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; display: string }) {
  return (
    <div className="flex flex-col gap-[4px]">
      <div className="flex items-baseline justify-between gap-[12px]">
        <span className="text-small text-prose">{label}</span>
        <span className="value text-small text-ink">{display}</span>
      </div>
      <input type="range" {...props} />
    </div>
  )
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="press group flex w-full items-start gap-[12px] text-left disabled:opacity-40"
    >
      <span
        className={`mt-[2px] flex h-[16px] w-[28px] shrink-0 items-center rounded-pill p-[2px] transition-colors duration-[var(--dur-fast)] ${
          checked ? 'bg-ink' : 'bg-transparent ring-1 ring-inset ring-rule group-hover:ring-ink/60'
        }`}
      >
        <span
          className={`h-[12px] w-[12px] rounded-pill transition-transform duration-[var(--dur-base)] ease-[var(--ease-settle)] ${
            checked ? 'translate-x-[12px] bg-on-ink' : 'translate-x-0 bg-ink/55'
          }`}
        />
      </span>
      <span className="flex flex-col gap-[2px]">
        <span className="text-small text-prose">{label}</span>
        {hint ? <span className="text-small leading-[1.45] text-muted">{hint}</span> : null}
      </span>
    </button>
  )
}

export function Progress({ value, label }: { value: number | null; label?: string }) {
  const percent = value === null ? null : Math.round(Math.max(0, Math.min(1, value)) * 100)
  return (
    <div className="flex flex-col gap-[4px]">
      {label ? (
        <div className="flex items-baseline justify-between gap-[12px]">
          <span className="text-small text-muted">{label}</span>
          {percent !== null ? <span className="value text-small text-ink">{percent} %</span> : null}
        </div>
      ) : null}
      <div
        className="h-[4px] w-full overflow-hidden bg-ink/12"
        role="progressbar"
        aria-valuenow={percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full bg-ink transition-[width] duration-[var(--dur-base)] ease-[var(--ease-out)] ${
            percent === null ? 'sondra-drift w-1/3' : ''
          }`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

/**
 * One measured result: what was measured, what came out, in what unit.
 *
 * The value is right-aligned in the typewriter face so a column of them lines
 * up and can be read down — which is the only reason a certificate is shaped
 * like a table in the first place.
 */
export function Stat({
  label,
  value,
  note,
  unit,
  emphasis = false,
}: {
  label: string
  value: string
  note?: string
  /** Split out so the figures still align when the units differ. */
  unit?: string
  emphasis?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-[12px] border-t border-line py-[8px]">
      <div className="flex min-w-0 flex-col">
        <span className="text-small text-prose">{label}</span>
        {note ? <span className="text-small leading-[1.4] text-muted">{note}</span> : null}
      </div>
      <span className="flex shrink-0 items-baseline gap-[4px]">
        <span className={`value pop text-ink ${emphasis ? 'text-subheading' : 'text-small'}`}>{value}</span>
        {unit ? <span className="w-[4ch] text-left text-small text-muted">{unit}</span> : null}
      </span>
    </div>
  )
}

/**
 * A remark on the finding.
 *
 * Marked in the margin rather than boxed: a certificate annotates, it does not
 * put a coloured panel around the annotation.
 */
export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'error'
  title?: string
  children: ReactNode
}) {
  return (
    <div className="rise flex gap-[12px] border-t-2 border-rule pt-[12px] text-small leading-[1.55]">
      <Mark state={tone === 'info' ? 'measured' : 'warn'} />
      <div className="min-w-0 flex-1">
        {title ? <p className="mb-[4px] font-semibold text-ink">{title}</p> : null}
        <div className="text-prose">{children}</div>
      </div>
    </div>
  )
}

/**
 * A subsection, folded away.
 *
 * Every tool here has a layer underneath it that the person who knows what
 * they are doing will want — the exact FFmpeg command, the analysis window,
 * the runner-up key. Showing it by default taxes everyone else for the whole
 * life of the app; folding it costs one click, once.
 */
export function Reveal({
  label,
  children,
  className = '',
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <details className={`group border-t border-line ${className}`}>
      <summary className="press inline-flex cursor-pointer list-none items-center gap-[8px] py-[8px] text-small text-muted hover:text-ink">
        <span className="value text-ink">
          <span className="group-open:hidden">+</span>
          <span className="hidden group-open:inline">−</span>
        </span>
        {label}
      </summary>
      <div className="rise pb-[8px]">{children}</div>
    </details>
  )
}

export function ArrowRight({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={`h-[14px] w-[14px] ${className}`} fill="none">
      <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * A modal built on the platform's own `<dialog>`.
 *
 * Setup belongs behind a door rather than inline: it is read once, and leaving
 * it on the page pushed everything that gets used daily below the fold. The
 * native element brings the focus trap, the Escape key and the backdrop with
 * it, so none of that has to be reimplemented badly here.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (open && !node.open) node.showModal()
    if (!open && node.open) node.close()
  }, [open])

  // Portalled to the body: a modal dialog still renders nothing while any
  // ancestor is hidden, and the one in the downloader lives in a section that
  // is folded away until someone opens it — the button outside that asked
  // for the dialog then opened an invisible one.
  return createPortal(
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose()
      }}
      className="m-auto w-[min(920px,calc(100vw-24px))] bg-canvas p-0 text-prose ring-1 ring-rule backdrop:bg-ink/50"
    >
      <div className="flex max-h-[min(88vh,900px)] flex-col">
        <div className="flex items-center justify-between gap-[12px] border-b-2 border-rule px-[24px] py-[16px]">
          <p className="display-sm">{title}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="press p-[4px] text-muted transition-colors hover:text-ink"
          >
            <svg viewBox="0 0 16 16" className="h-[16px] w-[16px]" fill="none" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-[24px] py-[20px]">{children}</div>
      </div>
    </dialog>,
    document.body,
  )
}
