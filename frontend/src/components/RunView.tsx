import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ExternalLink, Square, TriangleAlert } from 'lucide-react'
import { HOLD, useStore } from '../store'
import type { FocusReason, RunState, TargetState } from '../store'
import { USE_MOCK } from '../api'
import { render } from '../api/mapping'
import { budgetOf, foundResults } from '../lib/results'
import { clock, cx, hostOf } from '../lib/ui'
import { SiteWindow } from './SiteWindow'
import { RouteMap } from './RouteMap'
import { QuestionCard } from './QuestionCard'
import { EvidenceModal, FoundStrip, PriceChart, Receipt, WinnerCard } from './Results'

export function RunView({ msgId, skillIds, run }: { msgId: string; skillIds: string[]; run: RunState }) {
  const skills = useStore((s) => s.skills)
  const stats = useStore((s) => s.stats[skillIds[0]])
  const stop = useStore((s) => s.stopRun)
  const approve = useStore((s) => s.approve)
  const pin = useStore((s) => s.pin)
  const [panel, setPanel] = useState<'activity' | 'console' | null>(null)
  const [evidence, setEvidence] = useState<string | null>(null)
  const closeEvidence = useCallback(() => setEvidence(null), [])
  const [now, setNow] = useState(() => Date.now())
  const live = run.status === 'starting' || run.status === 'planning' || run.status === 'running'

  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])

  const skill = skills.find((s) => s.id === skillIds[0])
  const kind: 'shop' | 'quote' = skill && /shop|mart|store|cart/i.test(skill.name + skill.site.url) ? 'shop' : 'quote'
  const done = run.targets.filter((t) => ['ok', 'found', 'failed', 'needs_human', 'stopped'].includes(t.status)).length
  const reconnecting = Object.values(run.connections ?? {}).includes('reconnecting')
  const found = foundResults(run)
  const budget = budgetOf(run)
  // Step labels include answers given during the run (e.g. the size you picked).
  const labelVars = { ...run.variables, ...run.choices }
  const steps = skill?.steps.map((s) => render(s.description, labelVars)) ?? []
  const finished = !live && run.targets.length > 0
  // An empty input is a personal choice (e.g. size) you didn't give: the agent asks if a site needs it.
  const inputs = Object.entries(run.variables).filter(([, value]) => value !== '')
  const choices = Object.entries(run.choices ?? {})
  const wants = constraintChips(run)
  const activityCount = run.targets.reduce((n, t) => n + (t.activity?.length ?? 0), 0)
  // Selecting a lane or thumbnail enlarges that site; selecting the enlarged one again goes back.
  const togglePin = (id: string) => pin(msgId, run.pinned === id ? null : id)

  // One route map per skill, so each lane is labelled with its own skill's steps.
  const routes = new Map<string, TargetState[]>()
  for (const t of run.targets) {
    const key = t.skillId ?? skillIds[0] ?? ''
    routes.set(key, [...(routes.get(key) ?? []), t])
  }

  return (
    <section className="animate-slide-in">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className={cx('min-w-0 text-[24px] leading-tight font-semibold tracking-[-0.025em] text-balance', !run.plan && live && 'animate-blink text-fg-3')}>
          {run.plan ?? (live ? 'Planning…' : run.status === 'stopped' ? 'Stopped' : 'Could not start this task')}
        </h2>
        <span className="tabular ml-auto flex items-center gap-3 font-mono text-[12px] text-fg-3">
          {run.targets.length > 0 && (
            <span className={cx(run.status === 'done' ? 'text-exact' : live ? 'text-accent-2' : 'text-fg-3')}>
              {run.status === 'done' ? 'done' : `${done}/${run.targets.length}`}
            </span>
          )}
          {clock((run.finishedAt ?? now) - run.startedAt)}
          {live && reconnecting && <span className="text-fuzzy">Reconnecting…</span>}
          {live && (
            <button disabled={run.stopping} onClick={() => void stop(msgId)} className="flex h-7 items-center gap-1.5 rounded-lg px-2 font-sans text-[12px] ring-1 ring-rule-2 hover:text-heal hover:ring-heal/50 disabled:opacity-50">
              <Square className="size-2.5 fill-current" /> {run.stopping ? 'Stopping…' : 'Stop'}
            </button>
          )}
        </span>
      </header>

      {(inputs.length > 0 || choices.length > 0 || wants.length > 0) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[12px]">
          {inputs.map(([name, value]) => (
            <span key={name} className="flex h-6 max-w-full items-center gap-1.5 rounded-md bg-chip px-2 ring-1 ring-rule" title={`Skill input “${name}”, chosen by the planner`}>
              <span className="text-fg-3">{name.replace(/_/g, ' ')}</span>
              <span className="truncate font-mono text-fg">{value}</span>
            </span>
          ))}
          {choices.map(([name, value]) => (
            <span
              key={name}
              className="flex h-6 items-center gap-1.5 rounded-md border border-dashed border-rule-2 px-2 text-fg-2"
              title="From your message or an answer you gave. Sent to every site, so the agent doesn’t ask again."
            >
              <span className="text-fg-3">{name.replace(/_/g, ' ')}</span>
              <span className="font-mono">{value}</span>
            </span>
          ))}
          {wants.map(({ label, value, title }) => (
            <span key={label + value} className="flex h-6 max-w-full items-center gap-1.5 rounded-md bg-accent/10 px-2 text-fg-2 ring-1 ring-accent/30" title={title}>
              <span className="text-fg-3">{label}</span>
              <span className="truncate font-mono text-fg">{value}</span>
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 space-y-3">
        {[...routes].map(([skillId, targets]) => {
          const routeSkill = skills.find((s) => s.id === skillId)
          return (
            <RouteMap
              key={skillId}
              steps={routeSkill ? routeSkill.steps.map((s) => render(s.description, labelVars)) : steps}
              targets={targets}
              title={routes.size > 1 ? `${routeSkill?.name ?? 'Skill'}, ${targets.length} ${targets.length === 1 ? 'site' : 'sites'}` : undefined}
              selected={run.pinned}
              onPick={togglePin}
            />
          )
        })}
        {run.targets.length > 0 && <Windows msgId={msgId} run={run} kind={kind} live={live} now={now} />}

        {finished && found.length > 0 && (
          <WinnerCard found={found} budget={budget} approve={run.needsApproval} approved={run.approved} onApprove={() => approve(msgId)} onEvidence={setEvidence} />
        )}
        {found.length > 0 && <PriceChart found={found} budget={budget} />}
        {(live || found.length > 0 || run.targets.some((t) => t.status === 'ok')) && <FoundStrip run={run} found={found} onEvidence={setEvidence} />}
        {/* Per-site outcome: outputs, the last page reached and why a site stopped. The mock's prices are covered by the cards above. */}
        {finished && run.table && !(USE_MOCK && found.length > 0) && <ResultTable run={run} />}
        {finished && run.status !== 'stopped' && <Receipt run={run} steps={steps.length || run.targets[0]?.totalSteps || 0} stats={stats} shop={kind === 'shop'} />}
      </div>

      {(run.status === 'failed' || run.status === 'stopped' || run.status === 'needs_human') && (
        <p role="alert" className="mt-4 flex items-start gap-2 text-[13.5px] text-heal">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" /> <span>{run.error ?? 'Stopped.'}</span>
        </p>
      )}

      <div className="mt-4 flex items-center gap-1">
        {!USE_MOCK && (
          <PanelToggle open={panel === 'activity'} onClick={() => setPanel((p) => (p === 'activity' ? null : 'activity'))} label="Activity" count={activityCount} />
        )}
        <PanelToggle open={panel === 'console'} onClick={() => setPanel((p) => (p === 'console' ? null : 'console'))} label={USE_MOCK ? 'Logs' : 'Console'} count={run.logs.length} />
      </div>
      {panel === 'activity' && <ActivityPanel run={run} />}
      {panel === 'console' && <LogPanel run={run} />}
      {evidence && <EvidenceModal run={run} targetId={evidence} kind={kind} onClose={closeEvidence} />}
    </section>
  )
}

/** One site in the spotlight, the rest as thumbnails. After the run, all collapse to thumbnails. */
function Windows({ msgId, run, kind, live, now }: { msgId: string; run: RunState; kind: 'shop' | 'quote'; live: boolean; now: number }) {
  const pin = useStore((s) => s.pin)
  const targets = run.targets
  const running = targets.find((t) => t.status === 'running')
  const waiting = targets.find((t) => t.status === 'needs_human' && t.blocked?.resumable)
  let focus = targets.find((t) => t.id === (run.pinned ?? run.focus?.id)) ?? running ?? targets[0]
  // Events stop when sites finish, so the director also re-checks on the clock tick.
  const age = now - (run.focus?.at ?? 0)
  if (!run.pinned && live && age > HOLD && focus.status !== 'running' && focus !== waiting) focus = waiting ?? running ?? focus
  const others = targets.filter((t) => t.id !== focus.id)
  const compact = !live && !run.pinned && targets.length > 1
  const reason: FocusReason | undefined = run.pinned ? undefined
    : focus === waiting || focus.question ? 'needs'
    : run.focus?.id === focus.id && age < HOLD * 2 ? run.focus.reason
    : focus.status === 'running' ? 'live' : undefined

  if (compact)
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {targets.map((t) => (
          <SiteWindow key={t.id} msgId={msgId} t={t} kind={kind} vars={run.variables} variant="thumb" onPick={() => pin(msgId, t.id)} />
        ))}
      </div>
    )

  const side = others.length > 0 && others.length <= 2
  return (
    <div>
      {run.pinned && !focus.takeover && (
        <div className="mb-2 flex items-center justify-end gap-3 text-[12px] text-fg-3">
          <span className="min-w-0 truncate">Showing {focus.name}</span>
          <button onClick={() => pin(msgId, null)} className="h-7 shrink-0 rounded-lg px-2 text-fg-2 ring-1 ring-rule-2 hover:text-fg">
            {live ? 'Back to auto' : 'Show all'}
          </button>
        </div>
      )}
      <div className={cx('grid gap-3', side && 'md:grid-cols-[minmax(0,1fr)_minmax(150px,30%)]')}>
        <SiteWindow key={focus.id} msgId={msgId} t={focus} kind={kind} vars={run.variables} variant="spot" reason={reason} />
        {others.length > 0 && (
          <div className={cx('grid content-start gap-3', side ? 'grid-cols-2 md:grid-cols-1' : 'grid-cols-2 sm:grid-cols-4')}>
            {others.map((t) => (
              <SiteWindow key={t.id} msgId={msgId} t={t} kind={kind} vars={run.variables} variant="thumb" onPick={() => pin(msgId, t.id)} />
            ))}
          </div>
        )}
      </div>
      {/* A waiting site that isn't in the spotlight (e.g. you pinned another one) still gets its answer box here. */}
      {others.filter((t) => t.question && t.status === 'running').map((t) => (
        <div key={t.id} className="mt-3"><QuestionCard msgId={msgId} t={t} /></div>
      ))}
    </div>
  )
}

/** What the planner read from the message beyond the skill inputs: budget, item count, requirements. */
function constraintChips(run: RunState): { label: string; value: string; title: string }[] {
  const c = run.constraints
  if (!c) return []
  const cur = c.currency ? ({ GBP: '£', USD: '$', EUR: '€', INR: '₹' } as Record<string, string>)[c.currency.toUpperCase()] ?? `${c.currency} ` : ''
  const price = (n: number) => `${cur}${n.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`
  return [
    ...(c.items > 1 ? [{ label: 'items', value: `${c.items} different`, title: `The agent puts ${c.items} different products in each site’s basket.` }] : []),
    ...(c.maxPrice ? [{ label: 'max', value: `${price(c.maxPrice)} each`, title: 'Each product’s price is read on its page; anything over this is skipped and another one chosen.' }] : []),
    ...(c.totalBudget ? [{ label: 'budget', value: `${price(c.totalBudget)} total`, title: 'Each remaining item may use an equal share of what’s left of this budget.' }] : []),
    ...c.requirements.map((req) => ({ label: 'must be', value: req, title: 'Each chosen product is checked against this on its page.' })),
  ]
}

function PanelToggle({ open, onClick, label, count }: { open: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button onClick={onClick} className={cx('flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12px] hover:text-fg', open ? 'text-fg' : 'text-fg-3')} aria-expanded={open}>
      <ChevronDown className={cx('size-3.5 transition', open && 'rotate-180')} />
      {label} <span className="tabular font-mono">{count}</span>
    </button>
  )
}

function ResultTable({ run }: { run: RunState }) {
  const table = run.table!
  return (
    <div className="overflow-x-auto">
      <table className="tabular w-full min-w-[420px] text-[14px]">
        <thead>
          <tr className="text-left text-[11.5px] text-fg-3">
            {table.columns.map((c, j) => (
              <th key={c} className={cx('pr-4 pb-2 font-medium last:pr-0', isNum(table.rows[0]?.[j]) && 'text-right')}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i} className={cx('border-t border-rule align-top', i === table.bestRow ? 'text-fg' : 'text-fg-2')}>
              {r.map((c, j) => (
                <td key={j} className={cx('py-2.5 pr-4 last:pr-0', isNum(c) && 'text-right font-mono text-[13px]', j === 0 && 'font-semibold whitespace-nowrap')}>
                  <Cell value={c} column={table.columns[j]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Result cells: URLs become links, everything else is shown as the backend returned it. */
function Cell({ value, column }: { value: string | number; column: string }) {
  if (typeof value === 'string' && /^https?:\/\//.test(value)) {
    return (
      <a href={value} target="_blank" rel="noreferrer" className="inline-flex max-w-[260px] items-center gap-1 font-mono text-[12px] text-accent-2 hover:underline" title={value}>
        <span className="truncate">{hostOf(value)}</span>
        <ExternalLink className="size-3 shrink-0" />
      </a>
    )
  }
  if (column === 'Status') {
    const tone = value === 'Done' || value === 'Found' ? 'text-fg' : value === 'Needs attention' ? 'text-fuzzy' : value === 'Failed' ? 'text-heal' : 'text-fg-3'
    return <span className={tone}>{value}</span>
  }
  if (column === 'Notes') return <span className="block max-w-[420px] text-[13px] leading-snug">{value}</span>
  if (column === 'Item') return <span className="whitespace-nowrap">{value}</span>
  return <>{value}</>
}

const TONE_TEXT = { info: 'text-fg-2', plan: 'text-fg-3', ok: 'text-fg', warn: 'text-fuzzy', error: 'text-heal' } as const
const TONE_DOT = { info: 'bg-rule-2', plan: 'bg-rule-2', ok: 'bg-accent-2', warn: 'bg-fuzzy', error: 'bg-heal' } as const

/** Readable agent activity per site; the backend's own wording is one toggle away. */
function ActivityPanel({ run }: { run: RunState }) {
  const [raw, setRaw] = useState(false)
  const [site, setSite] = useState<string>('all')
  const ref = useRef<HTMLDivElement>(null)
  const items = run.targets
    .filter((t) => site === 'all' || t.id === site)
    .flatMap((t) => (t.activity ?? []).map((item) => ({ ...item, target: t })))
    .sort((a, b) => a.ts.localeCompare(b.ts))
  const lastId = items.at(-1)?.id
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])
  useEffect(() => {
    const el = ref.current?.lastElementChild
    if (el) el.scrollTo({ top: el.scrollHeight })
  }, [items.length, lastId])

  return (
    <div ref={ref} className="mt-1 rounded-xl bg-black/40 ring-1 ring-rule">
      <div className="flex flex-wrap items-center gap-1 px-3 pt-2 text-[11.5px]">
        {run.targets.length > 1 &&
          [{ id: 'all', name: 'All sites' }, ...run.targets].map((t) => (
            <button
              key={t.id}
              onClick={() => setSite(t.id)}
              className={cx('h-6 rounded-md px-2', site === t.id ? 'bg-chip text-fg ring-1 ring-rule-2' : 'text-fg-3 hover:text-fg')}
            >
              {t.name}
            </button>
          ))}
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-fg-3">
          <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} className="accent-accent" /> raw
        </label>
      </div>
      <div className="max-h-72 overflow-y-auto px-3 pt-1 pb-3 text-[12.5px] leading-[1.6]">
        {items.length === 0 && <p className="py-2 text-fg-3">{run.targets.length ? 'No site activity yet.' : 'Activity appears once the agent starts on a site.'}</p>}
        {items.map((item) => (
          <div key={item.id} className="flex gap-3 py-0.5">
            <span className="tabular shrink-0 pt-px font-mono text-[11px] text-fg-3/70">{new Date(item.ts).toLocaleTimeString([], { hour12: false })}</span>
            {run.targets.length > 1 && site === 'all' && <span className="w-24 shrink-0 truncate text-fg-3">{item.target.name}</span>}
            <span className={cx('mt-[7px] size-1.5 shrink-0 rounded-full', TONE_DOT[item.tone])} />
            <span className={cx('min-w-0 break-words', raw ? 'font-mono text-[11.5px] whitespace-pre-wrap text-fg-2' : TONE_TEXT[item.tone])} title={raw ? undefined : item.raw}>
              {raw ? item.raw : item.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function LogPanel({ run }: { run: RunState }) {
  const [debug, setDebug] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const lines = run.logs.filter((l) => debug || l.level !== 'debug')
  const lastMessage = lines.at(-1)?.message
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])
  useEffect(() => {
    const el = ref.current?.lastElementChild
    if (el) el.scrollTo({ top: el.scrollHeight })
  }, [lines.length, lastMessage])

  return (
    <div ref={ref} className="mt-1 rounded-xl bg-black/40 ring-1 ring-rule">
      <label className="flex cursor-pointer items-center justify-end gap-1.5 px-3 pt-2 font-mono text-[11px] text-fg-3" title="Show the text Gemini generates while it works">
        <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} className="accent-accent" /> debug
      </label>
      <div className="max-h-60 overflow-y-auto px-3 pt-1 pb-3 font-mono text-[11.5px] leading-[1.7]">
        {lines.length === 0 && <p className="text-fg-3">No output yet.</p>}
        {lines.map((l) => (
          <div key={l.id} className="flex gap-3">
            <span className="tabular shrink-0 text-fg-3/70">{new Date(l.ts).toLocaleTimeString([], { hour12: false })}</span>
            {l.target && <span className="w-24 shrink-0 truncate text-fg-3">{l.target}</span>}
            <span className={cx('min-w-0 whitespace-pre-wrap break-words text-fg-2', l.level === 'warn' && 'text-fuzzy', l.level === 'error' && 'text-heal', l.level === 'debug' && 'text-fg-3')}>
              {l.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

const isNum = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && /^[£$€]?[\d,.]+$/.test(v))
