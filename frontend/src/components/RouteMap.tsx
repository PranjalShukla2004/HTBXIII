import { Check, Hand, X } from 'lucide-react'
import type { TargetState } from '../store'
import { TIER_META, cx, siteColor } from '../lib/ui'

const STATUS = { queued: 'queued', running: 'running', ok: 'completed', failed: 'failed', needs_human: 'needs attention', stopped: 'stopped' } as const

/** The step a site stopped on: the backend names it in errors like "step 7 (...)"; otherwise the step it was working on. */
function stopStep(t: TargetState, n: number) {
  const named = t.detail?.match(/^step (\d+)\b/)
  return Math.max(0, Math.min(named ? Number(named[1]) : t.stepIndex, n - 1))
}

/**
 * The skill's steps across the top, one lane per site: who's ahead, who's stuck, where it self-healed.
 * Selecting a lane enlarges that site; selecting it again goes back.
 */
export function RouteMap({ steps, targets, title, selected, onPick }: {
  steps: string[]
  targets: TargetState[]
  title?: string
  selected?: string | null
  onPick?: (id: string) => void
}) {
  const n = Math.max(steps.length, 0, ...targets.map((t) => t.totalSteps))
  if (!n || !targets.length) return null
  const cols = `minmax(84px, 140px) repeat(${n}, minmax(0, 1fr))`

  return (
    <div className="rounded-xl bg-panel/60 px-3 pt-2.5 pb-3 ring-1 ring-rule">
      <div className="hidden gap-x-1.5 pb-1.5 sm:grid" style={{ gridTemplateColumns: cols }}>
        <span className="truncate text-[11.5px] text-fg-3">{title ?? `One recording, ${targets.length} ${targets.length === 1 ? 'site' : 'sites'}`}</span>
        {Array.from({ length: n }, (_, i) => (
          <span key={i} className="truncate text-[11px] text-fg-3" title={`Step ${i + 1}: ${steps[i] ?? ''}`}>
            {steps[i] ?? `Step ${i + 1}`}
          </span>
        ))}
      </div>
      <div className="space-y-0.5">
        {targets.map((t) => {
          const asking = t.status === 'running' && !!t.question
          const stuck = t.status === 'needs_human' || t.status === 'failed'
          const at = t.status === 'ok' ? n - 1 : stuck ? stopStep(t, n) : Math.min(t.stepIndex, n - 1)
          const stuckColor = t.status === 'needs_human' || asking ? 'var(--color-fuzzy)' : 'var(--color-heal)'
          const isSelected = selected === t.id
          const Row = onPick ? 'button' : 'div'
          return (
            <Row
              key={t.id}
              {...(onPick ? { onClick: () => onPick(t.id), 'aria-pressed': isSelected } : {})}
              title={`${t.name}: ${asking ? 'waiting for your answer' : STATUS[t.status]}${onPick ? `. ${isSelected ? 'Click to show all sites' : 'Click to enlarge'}` : ''}`}
              className={cx('-mx-1.5 grid w-[calc(100%+12px)] items-center gap-x-1.5 rounded-md px-1.5 py-1 text-left transition-colors',
                onPick && (isSelected ? 'bg-chip ring-1 ring-rule-2' : 'hover:bg-chip/60'))}
              style={{ gridTemplateColumns: cols }}
            >
              <span className={cx('flex min-w-0 items-center gap-1.5 text-[12px]', t.status === 'queued' ? 'text-fg-3' : 'text-fg-2')}>
                <span className="size-2 shrink-0 rounded-full" style={{ background: siteColor(t.index) }} />
                <span className="truncate">{t.name}</span>
              </span>
              <span className="relative grid h-4 items-center gap-x-1.5" style={{ gridColumn: '2 / -1', gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
                {Array.from({ length: n }, (_, i) => {
                  const tier = t.tiers[i]
                  const live = t.status === 'running' && !asking && i === t.stepIndex
                  const stop = stuck && i === at
                  return (
                    <span
                      key={i}
                      title={`${steps[i] ?? `Step ${i + 1}`}: ${stop ? STATUS[t.status] : tier ? TIER_META[tier].label : live ? 'in progress' : 'not reached'}`}
                      className={cx('h-1.5 rounded-full transition-colors duration-300', live && 'animate-blink', tier === 'skipped' && !stop && 'opacity-40')}
                      style={{ background: stop ? stuckColor : tier && tier !== 'skipped' ? TIER_META[tier].color : live ? 'var(--color-accent)' : 'var(--color-rule-2)' }}
                    />
                  )
                })}
                {t.status !== 'queued' && (
                  <span
                    className="absolute top-1/2 grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full ring-2 ring-[#16161a] transition-[left] duration-700 ease-[cubic-bezier(.65,0,.35,1)]"
                    style={{ left: `calc(${at + 0.5} * 100% / ${n})`, background: stuck || asking ? stuckColor : siteColor(t.index) }}
                    aria-label={`${t.name}: step ${at + 1} of ${n}, ${asking ? 'waiting for your answer' : STATUS[t.status]}`}
                  >
                    {t.status === 'ok' ? <Check className="size-2.5 text-white" strokeWidth={3.5} />
                      : t.status === 'needs_human' || asking ? <Hand className="size-2.5 text-black" strokeWidth={2.5} />
                      : t.status === 'failed' ? <X className="size-2.5 text-black" strokeWidth={3} /> : null}
                  </span>
                )}
              </span>
            </Row>
          )
        })}
      </div>
    </div>
  )
}
