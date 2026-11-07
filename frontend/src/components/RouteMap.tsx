import { Check, Hand } from 'lucide-react'
import type { TargetState } from '../store'
import { TIER_META, cx, siteColor } from '../lib/ui'

/** The skill's steps across the top, one lane per site: who's ahead, who's stuck, where it self-healed. */
export function RouteMap({ steps, targets }: { steps: string[]; targets: TargetState[] }) {
  const n = steps.length || Math.max(0, ...targets.map((t) => t.totalSteps))
  if (!n || !targets.length) return null
  const cols = `minmax(84px, 140px) repeat(${n}, minmax(0, 1fr))`

  return (
    <div className="rounded-xl bg-panel/60 px-3 pt-2.5 pb-3 ring-1 ring-rule">
      <div className="hidden gap-x-1.5 pb-1.5 sm:grid" style={{ gridTemplateColumns: cols }}>
        <span className="text-[11.5px] text-fg-3">One recording, {targets.length} {targets.length === 1 ? 'site' : 'sites'}</span>
        {Array.from({ length: n }, (_, i) => (
          <span key={i} className="truncate text-[11px] text-fg-3" title={steps[i]}>
            {steps[i] ?? `Step ${i + 1}`}
          </span>
        ))}
      </div>
      <div className="space-y-1.5">
        {targets.map((t) => {
          const at = t.status === 'ok' ? n - 1 : Math.min(t.stepIndex, n - 1)
          const stuck = t.status === 'needs_human' || t.status === 'failed'
          return (
            <div key={t.id} className="grid items-center gap-x-1.5" style={{ gridTemplateColumns: cols }}>
              <span className={cx('flex min-w-0 items-center gap-1.5 text-[12px]', t.status === 'queued' ? 'text-fg-3' : 'text-fg-2')}>
                <span className="size-2 shrink-0 rounded-full" style={{ background: siteColor(t.index) }} />
                <span className="truncate">{t.name}</span>
              </span>
              <div className="relative grid h-4 items-center gap-x-1.5" style={{ gridColumn: '2 / -1', gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
                {Array.from({ length: n }, (_, i) => {
                  const tier = t.tiers[i]
                  const live = t.status === 'running' && i === t.stepIndex
                  return (
                    <span
                      key={i}
                      title={tier ? `${steps[i] ?? `Step ${i + 1}`}: ${TIER_META[tier].label}` : steps[i]}
                      className={cx('h-1.5 rounded-full transition-colors duration-300', live && 'animate-blink')}
                      style={{ background: tier ? TIER_META[tier].color : live ? 'var(--color-accent)' : stuck && i === at ? 'var(--color-fuzzy)' : 'var(--color-rule-2)' }}
                    />
                  )
                })}
                {t.status !== 'queued' && (
                  <span
                    className="absolute top-1/2 grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full ring-2 ring-panel transition-[left] duration-700 ease-[cubic-bezier(.65,0,.35,1)]"
                    style={{ left: `calc(${at + 0.5} * 100% / ${n})`, background: stuck ? 'var(--color-fuzzy)' : siteColor(t.index) }}
                    aria-label={`${t.name}: step ${at + 1} of ${n}${stuck ? ', stuck' : t.status === 'ok' ? ', finished' : ''}`}
                  >
                    {t.status === 'ok' ? <Check className="size-2.5 text-white" strokeWidth={3.5} /> : stuck ? <Hand className="size-2.5 text-black" strokeWidth={2.5} /> : null}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
