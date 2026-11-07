import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Square, TriangleAlert } from 'lucide-react'
import { HOLD, useStore } from '../store'
import type { FocusReason, RunState } from '../store'
import { budgetOf, foundResults } from '../lib/results'
import { clock, cx } from '../lib/ui'
import { SiteWindow } from './SiteWindow'
import { RouteMap } from './RouteMap'
import { EvidenceModal, FoundStrip, PriceChart, Receipt, WinnerCard } from './Results'

export function RunView({ msgId, skillIds, run }: { msgId: string; skillIds: string[]; run: RunState }) {
  const skills = useStore((s) => s.skills)
  const stats = useStore((s) => s.stats[skillIds[0]])
  const stop = useStore((s) => s.stopRun)
  const approve = useStore((s) => s.approve)
  const [logs, setLogs] = useState(false)
  const [evidence, setEvidence] = useState<string | null>(null)
  const closeEvidence = useCallback(() => setEvidence(null), [])
  const [, tick] = useState(0)
  const live = run.status === 'starting' || run.status === 'planning' || run.status === 'running'

  useEffect(() => {
    if (!live) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [live])

  const skill = skills.find((s) => s.id === skillIds[0])
  const kind: 'shop' | 'quote' = skill && /shop|mart|store|cart/i.test(skill.name + skill.site.url) ? 'shop' : 'quote'
  const done = run.targets.filter((t) => ['ok', 'failed', 'needs_human', 'stopped'].includes(t.status)).length
  const reconnecting = Object.values(run.connections ?? {}).includes('reconnecting')
  const found = foundResults(run)
  const budget = budgetOf(run)
  const steps = skill?.steps.map((s) => s.description) ?? []
  const finished = !live && run.targets.length > 0

  return (
    <section className="animate-slide-in">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className={cx('text-[24px] leading-tight font-semibold tracking-[-0.025em]', !run.plan && live && 'animate-blink text-fg-3')}>
          {run.plan ?? (live ? 'Planning…' : run.status === 'stopped' ? 'Stopped' : 'Could not start this task')}
        </h2>
        <span className="tabular ml-auto flex items-center gap-3 font-mono text-[12px] text-fg-3">
          {run.targets.length > 0 && (
            <span className={cx(run.status === 'done' ? 'text-exact' : live ? 'text-accent-2' : 'text-fg-3')}>
              {run.status === 'done' ? 'done' : `${done}/${run.targets.length}`}
            </span>
          )}
          {clock((run.finishedAt ?? Date.now()) - run.startedAt)}
          {live && reconnecting && <span className="text-fuzzy">Reconnecting…</span>}
          {live && (
            <button disabled={run.stopping} onClick={() => void stop(msgId)} className="flex h-7 items-center gap-1.5 rounded-lg px-2 font-sans text-[12px] ring-1 ring-rule-2 hover:text-heal hover:ring-heal/50">
              <Square className="size-2.5 fill-current" /> Stop
            </button>
          )}
        </span>
      </header>

      <div className="mt-4 space-y-3">
        <RouteMap steps={steps} targets={run.targets} />
        {run.targets.length > 0 && <Windows msgId={msgId} run={run} kind={kind} live={live} />}

        {finished && found.length > 0 && (
          <WinnerCard found={found} budget={budget} approve={run.needsApproval} approved={run.approved} onApprove={() => approve(msgId)} onEvidence={setEvidence} />
        )}
        {found.length > 0 && <PriceChart found={found} budget={budget} />}
        {(live || found.length > 0 || run.targets.some((t) => t.status === 'ok')) && <FoundStrip run={run} found={found} onEvidence={setEvidence} />}
        {finished && found.length === 0 && !run.targets.some((t) => t.status === 'ok') && run.table && <ResultTable run={run} />}
        {finished && run.status !== 'stopped' && <Receipt run={run} steps={steps.length || run.targets[0]?.totalSteps || 0} stats={stats} shop={kind === 'shop'} />}
      </div>

      {(run.status === 'failed' || run.status === 'stopped' || run.status === 'needs_human') && (
        <p className="mt-4 flex items-center gap-2 text-[13.5px] text-heal">
          <TriangleAlert className="size-4" /> {run.error ?? 'Stopped.'}
        </p>
      )}

      <button onClick={() => setLogs((v) => !v)} className="mt-4 flex h-7 items-center gap-1.5 text-[12px] text-fg-3 hover:text-fg" aria-expanded={logs}>
        <ChevronDown className={cx('size-3.5 transition', logs && 'rotate-180')} />
        Logs <span className="tabular font-mono">{run.logs.length}</span>
      </button>
      {logs && <LogPanel run={run} />}
      {evidence && <EvidenceModal run={run} targetId={evidence} kind={kind} onClose={closeEvidence} />}
    </section>
  )
}

/** One site in the spotlight, the rest as thumbnails. After the run, all collapse to thumbnails. */
function Windows({ msgId, run, kind, live }: { msgId: string; run: RunState; kind: 'shop' | 'quote'; live: boolean }) {
  const pin = useStore((s) => s.pin)
  const targets = run.targets
  const running = targets.find((t) => t.status === 'running')
  const waiting = targets.find((t) => t.status === 'needs_human' && t.blocked?.resumable)
  let focus = targets.find((t) => t.id === (run.pinned ?? run.focus?.id)) ?? running ?? targets[0]
  // Events stop when sites finish, so the director also re-checks on the clock tick.
  const age = Date.now() - (run.focus?.at ?? 0)
  if (!run.pinned && live && age > HOLD && focus.status !== 'running' && focus !== waiting) focus = waiting ?? running ?? focus
  const others = targets.filter((t) => t.id !== focus.id)
  const compact = !live && !run.pinned && targets.length > 1
  const reason: FocusReason | undefined = run.pinned ? undefined
    : focus === waiting ? 'needs'
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
          <span>Showing {focus.name}</span>
          <button onClick={() => pin(msgId, null)} className="h-7 rounded-lg px-2 text-fg-2 ring-1 ring-rule-2 hover:text-fg">
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
    </div>
  )
}

function ResultTable({ run }: { run: RunState }) {
  const table = run.table!
  return (
    <table className="tabular w-full text-[14px]">
      <thead>
        <tr className="text-left text-[11.5px] text-fg-3">
          {table.columns.map((c, j) => (
            <th key={c} className={cx('pb-2 font-medium', isNum(table.rows[0]?.[j]) && 'text-right')}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((r, i) => (
          <tr key={i} className={cx('border-t border-rule', i === table.bestRow ? 'text-fg' : 'text-fg-2')}>
            {r.map((c, j) => (
              <td key={j} className={cx('py-2.5 pr-4 last:pr-0', isNum(c) && 'text-right font-mono text-[13px]', j === 0 && 'font-semibold')}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
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
      <label className="flex cursor-pointer items-center justify-end gap-1.5 px-3 pt-2 font-mono text-[11px] text-fg-3">
        <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} className="accent-accent" /> debug
      </label>
      <div className="max-h-60 overflow-y-auto px-3 pt-1 pb-3 font-mono text-[11.5px] leading-[1.7]">
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
