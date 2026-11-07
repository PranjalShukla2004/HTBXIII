import { Hand, X } from 'lucide-react'
import { useStore } from '../store'
import type { RunState, TargetState } from '../store'
import { render } from '../api/mapping'
import { TIER_META, avatarColor, cx } from '../lib/ui'

/** The step a site stopped on: the backend names it in errors like "step 7 (...)"; otherwise the step it was working on. */
function stopStep(t: TargetState, total: number) {
  const named = t.detail?.match(/^step (\d+)\b/)
  const index = named ? Number(named[1]) : t.stepIndex
  return Math.max(0, Math.min(index, total - 1))
}

/** One row per site, one bar per skill step. Rows select the site to enlarge. */
export function RunProgress({ run, skillIds, focus, onFocus }: {
  run: RunState
  skillIds: string[]
  focus: string | null
  onFocus: (id: string) => void
}) {
  const skills = useStore((s) => s.skills)
  const groups = new Map<string, TargetState[]>()
  for (const t of run.targets) {
    const key = t.skillId ?? skillIds[0] ?? ''
    groups.set(key, [...(groups.get(key) ?? []), t])
  }

  return (
    <div className="mt-4 space-y-3 rounded-xl bg-panel p-2.5 ring-1 ring-rule">
      {[...groups].map(([skillId, targets]) => {
        const skill = skills.find((s) => s.id === skillId)
        const total = Math.max(skill?.steps.length ?? 0, ...targets.map((t) => t.totalSteps))
        const labels = Array.from({ length: total }, (_, i) => (skill?.steps[i] ? render(skill.steps[i].description, run.variables) : `Step ${i + 1}`))
        const columns = `minmax(108px, 150px) repeat(${Math.max(total, 1)}, minmax(0, 1fr))`
        const title = groups.size === 1
          ? `One recording, ${targets.length} ${targets.length === 1 ? 'site' : 'sites'}`
          : `${skill?.name ?? 'Skill'}, ${targets.length} ${targets.length === 1 ? 'site' : 'sites'}`
        return (
          <div key={skillId} className="overflow-x-auto">
            <div className="min-w-[520px]">
              <div className="grid items-end gap-x-1.5 px-1.5 pb-1.5" style={{ gridTemplateColumns: columns }}>
                <span className="truncate text-[11.5px] text-fg-3">{title}</span>
                {labels.map((label, i) => (
                  <span key={i} className="truncate text-[11px] text-fg-3" title={`Step ${i + 1}: ${label}`}>
                    {label}
                  </span>
                ))}
              </div>
              {targets.map((t) => (
                <ProgressRow key={t.id} t={t} total={total} columns={columns} labels={labels} selected={focus === t.id} onClick={() => onFocus(t.id)} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const STATUS = { queued: 'queued', running: 'running', ok: 'completed', failed: 'failed', needs_human: 'needs attention', stopped: 'stopped' } as const

function ProgressRow({ t, total, columns, labels, selected, onClick }: {
  t: TargetState
  total: number
  columns: string
  labels: string[]
  selected: boolean
  onClick: () => void
}) {
  const halted = t.status === 'needs_human' || t.status === 'failed'
  const stop = halted ? stopStep(t, total) : -1

  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      title={`${t.name}: ${STATUS[t.status]}. ${selected ? 'Click to show all sites' : 'Click to enlarge'}`}
      className={cx('grid h-7 w-full items-center gap-x-1.5 rounded-md px-1.5 text-left transition-colors', selected ? 'bg-chip ring-1 ring-rule-2' : 'hover:bg-chip/60')}
      style={{ gridTemplateColumns: columns }}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="size-2 shrink-0 rounded-full" style={{ background: avatarColor(t.name) }} />
        <span className={cx('truncate text-[12.5px]', t.status === 'queued' ? 'text-fg-3' : 'text-fg-2')}>{t.name}</span>
      </span>
      {Array.from({ length: total }, (_, i) => {
        const tier = t.tiers[i]
        const live = t.status === 'running' && i === t.stepIndex
        const marker = i === stop
        const color = marker
          ? t.status === 'needs_human' ? 'var(--color-fuzzy)' : 'var(--color-heal)'
          : tier && tier !== 'skipped' ? TIER_META[tier].color : live ? 'var(--color-accent)' : 'var(--color-rule-2)'
        const state = marker ? STATUS[t.status] : tier ? TIER_META[tier].label.toLowerCase() : live ? 'in progress' : 'not reached'
        return (
          <span key={i} className="relative flex h-4 items-center" title={`Step ${i + 1}: ${labels[i]} (${state})`}>
            <span className={cx('h-1.5 w-full rounded-full transition-colors duration-300', live && 'animate-blink', tier === 'skipped' && !marker && 'opacity-40')} style={{ background: color }} />
            {marker && (
              <span className="absolute left-1/2 grid size-4 -translate-x-1/2 place-items-center rounded-full text-bg" style={{ background: color }}>
                {t.status === 'needs_human' ? <Hand className="size-2.5" strokeWidth={2.5} /> : <X className="size-2.5" strokeWidth={3} />}
              </span>
            )}
          </span>
        )
      })}
    </button>
  )
}
