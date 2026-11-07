import type { Tier } from '../api'
import { TIER_META, avatarColor, cx } from '../lib/ui'

export type Tone = 'chip' | 'sel' | 'warn' | 'ghost'

const TONE: Record<Tone, string> = {
  chip: 'bg-chip text-fg border-rule',
  sel: 'bg-sel text-fg border-accent/60',
  warn: 'bg-warn text-fg border-fuzzy/40',
  ghost: 'bg-panel text-fg-2 border-rule',
}

/** A row: bordered, rounded, content laid out in fields. */
export function Strip({
  tone = 'chip',
  className,
  children,
  as: As = 'div',
  ...rest
}: { tone?: Tone; className?: string; children: React.ReactNode; as?: 'div' | 'button' } & React.HTMLAttributes<HTMLElement>) {
  return (
    <As {...(rest as object)} className={cx('relative flex items-stretch overflow-hidden rounded-lg border text-left transition-colors', TONE[tone], className)}>
      {children}
    </As>
  )
}

export function Field({ className, children }: { className?: string; children: React.ReactNode }) {
  return <span className={cx('flex min-w-0 items-center px-2.5', className)}>{children}</span>
}

/** Letter mark for a skill or site. */
export function Avatar({ name, size = 22, color }: { name: string; size?: number; color?: string }) {
  const c = color ?? avatarColor(name)
  return (
    <span
      className="grid shrink-0 place-items-center rounded-md text-[11px] font-semibold"
      style={{ width: size, height: size, background: `color-mix(in srgb, ${c} 22%, transparent)`, color: c }}
      aria-hidden
    >
      {name.replace(/[^a-z0-9]/gi, '')[0]?.toUpperCase() ?? '?'}
    </span>
  )
}

/** Step ticks: one bar per step, coloured by how the matcher found the element. */
export function Ticks({ total, tiers, active }: { total: number; tiers: (Tier | 'skipped')[]; active?: number }) {
  return (
    <span className="flex items-center gap-[3px]" aria-label={`${tiers.filter(Boolean).length} of ${total} steps`}>
      {Array.from({ length: total }, (_, i) => {
        const t = tiers[i]
        const live = active === i
        return (
          <span
            key={i}
            title={t ? `Step ${i + 1}: ${TIER_META[t].label}` : `Step ${i + 1}`}
            className={cx('h-3 w-1 rounded-full transition-colors duration-300', live && 'animate-blink')}
            style={{ background: t ? TIER_META[t].color : live ? 'var(--color-accent)' : 'var(--color-rule-2)' }}
          />
        )
      })}
    </span>
  )
}
