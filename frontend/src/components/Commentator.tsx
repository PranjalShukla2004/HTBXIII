import { useEffect, useRef, useState } from 'react'
import { Check, Ellipsis, Play, Volume2, VolumeX } from 'lucide-react'
import { useCommentator } from '../lib/commentator'
import { CHATTINESS, PERSONALITIES, SPICE, personality } from '../lib/personalities'
import { cx } from '../lib/ui'

/** Header control: mute/unmute, plus a ⋯ menu to pick who's commentating and how spicy they get. */
export function CommentatorToggle() {
  const enabled = useCommentator((s) => s.enabled)
  const speaking = useCommentator((s) => s.speaking)
  const persona = useCommentator((s) => s.persona)
  const toggle = useCommentator((s) => s.toggle)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const p = personality(persona)

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <div ref={root} className="relative">
      <div className="glass flex h-9 items-center rounded-full text-[13px] font-medium">
        <button
          onClick={toggle}
          className={cx('flex h-full items-center gap-2 rounded-l-full pr-2 pl-3', enabled ? 'text-fg-2 hover:text-fg' : 'text-fg-3 hover:text-fg-2')}
          aria-pressed={enabled}
          title={enabled ? `${p.name} is commentating. Click to mute` : 'Commentary off. Click to turn on'}
        >
          {enabled ? <Volume2 className={cx('size-4', speaking && 'text-accent-2')} /> : <VolumeX className="size-4" />}
          <span className="hidden sm:inline">{enabled ? p.name : 'Commentary'}</span>
          <span className="sm:hidden" aria-hidden>{p.emoji}</span>
        </button>
        <span className="h-4 w-px bg-rule-2" aria-hidden />
        <button
          onClick={() => setOpen((o) => !o)}
          className={cx('grid h-full w-9 place-items-center rounded-r-full', open ? 'text-fg' : 'text-fg-3 hover:text-fg')}
          aria-label="Commentator settings"
          aria-expanded={open}
        >
          <Ellipsis className="size-4" />
        </button>
      </div>
      {open && <Settings />}
    </div>
  )
}

function Settings() {
  const s = useCommentator()
  const level = SPICE.find((x) => x.level === s.spice) ?? SPICE[1]
  return (
    <div
      role="dialog"
      aria-label="Commentator settings"
      className="glass-pop animate-slide-in absolute top-full right-0 z-50 mt-2 w-[340px] max-w-[calc(100vw-32px)] origin-top-right rounded-2xl p-3"
    >
      <div className="flex items-center justify-between px-1 pb-2">
        <div>
          <p className="text-[14px] font-semibold tracking-[-0.01em]">Commentator</p>
          <p className="text-[12px] text-fg-3">Who yaps over your runs, and how much.</p>
        </div>
        <Switch on={s.enabled} onChange={s.toggle} label="Commentary" />
      </div>

      <div className={cx('space-y-3 transition-opacity', !s.enabled && 'pointer-events-none opacity-40')}>
        <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Personality">
          {PERSONALITIES.map((p, i) => {
            const on = p.id === s.persona
            return (
              <button
                key={p.id}
                role="radio"
                aria-checked={on}
                onClick={() => s.configure({ persona: p.id })}
                className={cx(
                  'relative flex flex-col items-start gap-0.5 rounded-xl px-2.5 py-2 text-left ring-1',
                  i === 0 && 'col-span-2',
                  on ? 'bg-sel ring-accent/50' : 'bg-white/[0.03] ring-rule hover:bg-white/[0.06]',
                )}
              >
                <span className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <span aria-hidden>{p.emoji}</span>
                  {p.name}
                </span>
                <span className="text-[11.5px] leading-snug text-fg-3">{p.tagline}</span>
                {on && <Check className="absolute top-2 right-2 size-3.5 text-accent-2" strokeWidth={2.5} />}
              </button>
            )
          })}
        </div>

        <Segmented
          label="Spice"
          value={s.spice}
          options={SPICE.map((x) => ({ value: x.level, label: x.name }))}
          onChange={(v) => s.configure({ spice: v })}
          hint={level.hint}
        />
        <Segmented
          label="Chattiness"
          value={s.chattiness}
          options={CHATTINESS.map((x) => ({ value: x.level, label: x.name }))}
          onChange={(v) => s.configure({ chattiness: v })}
        />

        <button
          onClick={() => void s.preview()}
          disabled={s.previewing}
          className="btn-gloss flex h-9 w-full items-center justify-center gap-2 rounded-full bg-accent text-[13px] font-semibold text-white hover:bg-accent-2 disabled:opacity-60"
        >
          <Play className="size-3.5 fill-current" />
          {s.previewing ? 'Listening…' : `Hear ${personality(s.persona).name}`}
        </button>
      </div>
    </div>
  )
}

function Segmented({ label, value, options, onChange, hint }: {
  label: string; value: number; options: { value: number; label: string }[]; onChange: (v: number) => void; hint?: string
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between px-1 pb-1.5 text-[12px]">
        <span className="font-medium text-fg-2">{label}</span>
        {hint && <span className="text-fg-3">{hint}</span>}
      </div>
      <div className="relative grid rounded-full bg-black/30 p-1 ring-1 ring-rule" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }} role="radiogroup" aria-label={label}>
        {/* Sliding thumb: moves on the spring curve instead of jumping. */}
        <span
          className="absolute inset-y-1 rounded-full bg-white/12 shadow-[inset_0_1px_0_rgb(255_255_255/.12)] transition-[left] duration-500 [transition-timing-function:var(--ease-spring)]"
          style={{ width: `calc((100% - 8px) / ${options.length})`, left: `calc(4px + (100% - 8px) / ${options.length} * ${options.findIndex((o) => o.value === value)})` }}
          aria-hidden
        />
        {options.map((o) => (
          <button
            key={o.value}
            role="radio"
            aria-checked={o.value === value}
            onClick={() => onChange(o.value)}
            className={cx('relative h-7 rounded-full text-[12px] font-medium', o.value === value ? 'text-fg' : 'text-fg-3 hover:text-fg-2')}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Switch({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
      className={cx('relative h-6 w-10 shrink-0 rounded-full transition-colors', on ? 'bg-accent' : 'bg-white/15')}
    >
      <span
        className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-[left] duration-500 [transition-timing-function:var(--ease-spring)]', on ? 'left-[18px]' : 'left-0.5')}
      />
    </button>
  )
}

/** What the commentator is saying right now, as a floating caption. */
export function CommentatorCaption() {
  const caption = useCommentator((s) => s.caption)
  const speaking = useCommentator((s) => s.speaking)
  const persona = useCommentator((s) => s.persona)
  if (!caption) return null
  const p = personality(persona)
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 mb-3 flex justify-center px-4" aria-live="polite">
      <div key={caption} className="glass-pop animate-slide-in flex max-w-[640px] items-start gap-2.5 rounded-2xl px-3.5 py-2.5 text-[14px] leading-snug text-fg">
        <span className="shrink-0 text-[15px] leading-5" aria-hidden title={p.name}>{p.emoji}</span>
        <span>{caption}</span>
        <span className="mt-[5px] flex h-3 shrink-0 items-end gap-[2px]" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={cx('w-[3px] rounded-full bg-accent-2', speaking ? 'animate-eq' : 'h-1 opacity-50')}
              style={speaking ? { animationDelay: `${i * 120}ms` } : undefined}
            />
          ))}
        </span>
      </div>
    </div>
  )
}
