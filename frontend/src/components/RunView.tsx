import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ExternalLink, Hand, Minimize2, Square, TriangleAlert } from 'lucide-react'
import { useStore } from '../store'
import type { RunState, TargetState } from '../store'
import { USE_MOCK } from '../api'
import { TIER_META, clock, cx, hostOf } from '../lib/ui'
import { Avatar, Field, Strip, Ticks } from './Strip'
import type { Tone } from './Strip'
import { SimPage } from './SimPage'
import { RunProgress } from './RunProgress'

const STATUS_LABEL: Record<TargetState['status'], string> = {
  queued: 'Queued', running: 'Running', ok: 'Completed', failed: 'Failed', needs_human: 'Needs attention', stopped: 'Stopped',
}
const STATUS_TEXT: Record<TargetState['status'], string> = {
  queued: 'text-fg-3', running: 'text-accent-2', ok: 'text-fg-2', failed: 'text-heal', needs_human: 'text-fuzzy', stopped: 'text-fg-3',
}

export function RunView({ msgId, skillIds, run }: { msgId: string; skillIds: string[]; run: RunState }) {
  const skills = useStore((s) => s.skills)
  const stop = useStore((s) => s.stopRun)
  const approve = useStore((s) => s.approve)
  const [panel, setPanel] = useState<'activity' | 'console' | null>(null)
  /** The enlarged site; selecting it again (or Show all) returns to the grid. */
  const [focus, setFocus] = useState<string | null>(null)
  const toggleFocus = (id: string) => setFocus((current) => (current === id ? null : id))
  const [now, setNow] = useState(() => Date.now())
  const live = run.status === 'starting' || run.status === 'planning' || run.status === 'running'

  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])

  const skill = skills.find((s) => s.id === skillIds[0])
  const kind: 'shop' | 'quote' = skill && /shop|mart|store|cart/i.test(skill.name + skill.site.url) ? 'shop' : 'quote'
  const done = run.targets.filter((t) => ['ok', 'failed', 'needs_human', 'stopped'].includes(t.status)).length
  const reconnecting = Object.values(run.connections ?? {}).includes('reconnecting')
  const inputs = Object.entries(run.variables)
  const choices = Object.entries(run.choices ?? {})
  const activityCount = run.targets.reduce((n, t) => n + (t.activity?.length ?? 0), 0)
  const focused = run.targets.find((t) => t.id === focus)

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

      {(inputs.length > 0 || choices.length > 0) && (
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
              title="Read from your message. The run API only accepts the skill’s own inputs, so this option is not sent to the browser agent; it may stop and ask for it."
            >
              <span className="text-fg-3">{name.replace(/_/g, ' ')}</span>
              <span className="font-mono">{value}</span>
            </span>
          ))}
        </div>
      )}

      {run.targets.length > 0 && <RunProgress run={run} skillIds={skillIds} focus={focused?.id ?? null} onFocus={toggleFocus} />}

      {focused && (
        <div className="animate-slide-in mt-3">
          <div className="mb-2 flex items-center justify-end gap-3 text-[12px] text-fg-3">
            <span className="min-w-0 truncate">Showing {focused.name}</span>
            <button onClick={() => setFocus(null)} className="h-7 shrink-0 rounded-lg px-2.5 text-fg-2 ring-1 ring-rule-2 hover:text-fg">
              Show all
            </button>
          </div>
          <SiteWindow t={focused} index={run.targets.indexOf(focused)} kind={kind} vars={run.variables} large onToggle={() => setFocus(null)} />
        </div>
      )}

      {run.targets.length > (focused ? 1 : 0) && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {run.targets.map((t, i) => t.id === focused?.id ? null : (
            <SiteWindow key={t.id} t={t} index={i} kind={kind} vars={run.variables} onToggle={() => toggleFocus(t.id)} />
          ))}
        </div>
      )}

      {!live && run.table && (
        <div className="animate-slide-in mt-5">
          {!USE_MOCK && run.summary && <p className="mb-3 text-[13.5px] text-fg-2">{run.summary}</p>}
          <div className="overflow-x-auto">
            <table className="tabular w-full min-w-[420px] text-[14px]">
              <thead>
                <tr className="text-left text-[11.5px] text-fg-3">
                  {run.table.columns.map((c, j) => (
                    <th key={c} className={cx('pr-4 pb-2 font-medium last:pr-0', isNum(run.table!.rows[0]?.[j]) && 'text-right')}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {run.table.rows.map((r, i) => {
                  const best = i === run.table!.bestRow
                  return (
                    <tr key={i} className={cx('border-t border-rule align-top', best ? 'text-fg' : 'text-fg-2')}>
                      {r.map((c, j) => (
                        <td key={j} className={cx('py-2.5 pr-4 last:pr-0', isNum(c) && 'text-right font-mono text-[13px]', j === 0 && 'font-semibold whitespace-nowrap')}>
                          {j === 0 && best ? (
                            <span className="relative inline-block">
                              {c}
                              <svg className="pointer-events-none absolute -inset-x-2 -bottom-1.5 h-2 w-[calc(100%+16px)]" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden>
                                <path d="M2 5 C 30 2, 60 7, 98 3" fill="none" stroke="var(--color-accent)" strokeWidth="2.2" strokeLinecap="round" />
                              </svg>
                            </span>
                          ) : (
                            <Cell value={c} column={run.table!.columns[j]} />
                          )}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {run.needsApproval && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="text-[13.5px] text-fg-2">{run.approved ? 'Approved.' : run.summary}</span>
              {!run.approved && (
                <button
                  onClick={() => approve(msgId)}
                  className="ml-auto h-10 rounded-xl bg-accent px-4 text-[14px] font-semibold text-white transition hover:bg-accent-2"
                >
                  {run.needsApproval}
                </button>
              )}
              {run.approved && <Check className="size-4 text-exact" />}
            </div>
          )}
        </div>
      )}

      {(run.status === 'failed' || run.status === 'stopped' || run.status === 'needs_human') && (!run.table || run.status === 'stopped' || USE_MOCK) && (
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
    </section>
  )
}

function PanelToggle({ open, onClick, label, count }: { open: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button onClick={onClick} className={cx('flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12px] hover:text-fg', open ? 'text-fg' : 'text-fg-3')} aria-expanded={open}>
      <ChevronDown className={cx('size-3.5 transition', open && 'rotate-180')} />
      {label} <span className="tabular font-mono">{count}</span>
    </button>
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
    const tone = value === 'Done' ? 'text-fg' : value === 'Needs attention' ? 'text-fuzzy' : value === 'Failed' ? 'text-heal' : 'text-fg-3'
    return <span className={tone}>{value}</span>
  }
  if (column === 'Notes') return <span className="block max-w-[420px] text-[13px] leading-snug">{value}</span>
  return <>{value}</>
}

function SiteWindow({ t, index, kind, vars, large = false, onToggle }: {
  t: TargetState
  index: number
  kind: 'shop' | 'quote'
  vars: Record<string, string>
  /** Enlarged view: full-width, with the site link and the agent's full message. */
  large?: boolean
  onToggle?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.6)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / 480))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const total = t.totalSteps || (USE_MOCK ? 7 : 0)
  const scene = Math.min(t.stepIndex, total - 1)
  const tier = t.tiers[scene]
  const ring = tier && tier !== 'skipped' ? TIER_META[tier].color : '#7c6bff'
  const attention = t.status === 'needs_human'
  const tone: Tone = t.status === 'queued' || t.status === 'stopped' ? 'ghost' : attention || (t.status === 'running' && t.learned) ? 'warn' : t.status === 'running' ? 'sel' : 'chip'
  const result = t.result ? String(t.result.total ?? t.result.price ?? '') : ''
  const footer = t.status === 'queued' ? hostOf(t.url)
    : attention ? (t.attention?.question ?? t.currentStep ?? 'Needs your attention')
    : t.status === 'ok' && USE_MOCK ? 'Finished' : (t.currentStep ?? 'Opening the site')
  const image = <img src={t.frame} alt={`${t.frameFinal ? 'Final' : 'Live'} view of ${t.name}`} className="h-full w-full object-cover object-top" />
  // Small windows select on click; the enlarged one holds links, so it collapses from its header button.
  const select = !large && onToggle ? {
    role: 'button', tabIndex: 0, 'aria-label': `Enlarge ${t.name}`, onClick: onToggle,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } },
  } : {}

  return (
    <div
      {...select}
      className={cx('flex flex-col overflow-hidden rounded-xl bg-panel transition', attention ? 'ring-2 ring-fuzzy' : 'ring-1 ring-rule',
        t.status === 'queued' && 'opacity-55', !large && onToggle && 'cursor-pointer hover:ring-rule-2', !large && attention && onToggle && 'hover:ring-fuzzy')}
    >
      <Strip tone={tone} className={cx('shrink-0 rounded-none border-0 border-b', large ? 'h-11' : 'h-10')}>
        <Field className="pr-0">
          <Avatar name={t.name} size={large ? 22 : 20} />
        </Field>
        <Field className="flex-1">
          <span className={cx('truncate font-medium', large ? 'text-[14px]' : 'text-[13px]')} title={t.url}>{t.name}</span>
        </Field>
        <Field className={large && onToggle ? 'pr-1' : 'pr-2.5'}>
          {t.status === 'ok' && result ? (
            <span className="tabular font-mono text-[12px] font-semibold">{result}</span>
          ) : (
            <Ticks total={total} tiers={t.tiers} active={t.status === 'running' ? t.stepIndex : undefined} />
          )}
        </Field>
        {large && onToggle && (
          <Field className="pr-1.5 pl-0">
            <button onClick={onToggle} className="grid size-7 place-items-center rounded-md text-fg-3 hover:bg-chip hover:text-fg" aria-label="Show all sites" title="Show all sites">
              <Minimize2 className="size-3.5" />
            </button>
          </Field>
        )}
      </Strip>
      <div ref={ref} className="relative aspect-[16/10] overflow-hidden bg-white">
        {t.status === 'queued' ? (
          <div className="grid h-full place-items-center bg-side text-[12px] text-fg-3">Waiting for its turn</div>
        ) : t.frame ? (
          large ? (
            <a href={t.frame} target="_blank" rel="noreferrer" title="Open the final screenshot" className="block h-full">{image}</a>
          ) : image
        ) : USE_MOCK ? (
          <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
            <SimPage kind={kind} site={index} name={t.name} scene={scene} ring={ring} vars={vars} done={t.status === 'ok'} />
          </div>
        ) : (
          <div className="grid h-full place-items-center bg-side px-4 text-center text-[12px] text-fg-3">
            {t.status === 'running' ? (
              <span className="flex items-center gap-2">
                <span className="size-1.5 animate-blink rounded-full bg-accent" /> Watch the agent in its Chrome window
              </span>
            ) : attention ? 'Needs your attention' : t.status === 'failed' ? 'Could not complete this site' : t.status === 'stopped' ? 'Stopped' : 'Run complete · no screenshot'}
          </div>
        )}
        {t.learned && (
          <span className="animate-slide-in absolute top-2 right-2 max-w-[80%] rounded-md bg-black/80 px-2 py-1 text-[11.5px] font-medium text-fuzzy ring-1 ring-fuzzy/40 backdrop-blur">
            Learned “{t.learned}”
          </span>
        )}
      </div>
      <div className={cx('flex items-center gap-2 px-3 text-[12px]', large ? 'min-h-11 py-2' : 'min-h-8 py-1.5', attention ? 'text-fuzzy' : 'text-fg-2')}>
        {t.status === 'running' && <span className="size-1.5 shrink-0 animate-blink rounded-full bg-accent" />}
        {attention && <Hand className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1" title={t.detail ?? footer}>
          <span className={cx('block', large ? 'leading-snug' : 'truncate')}>{footer}</span>
          {large && attention && t.attention?.options.length ? (
            <span className="mt-0.5 block font-mono text-[11px] text-fg-2">{t.attention.options.join(' · ')}</span>
          ) : null}
        </span>
        {(!large || !attention) && <span className={cx('shrink-0 text-[11px] font-medium', STATUS_TEXT[t.status])}>{STATUS_LABEL[t.status]}</span>}
        {large && t.status !== 'queued' && (
          <a
            href={t.lastUrl ?? t.url}
            target="_blank"
            rel="noreferrer"
            title={t.lastUrl ?? t.url}
            className={cx('flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-semibold transition',
              attention ? 'bg-fuzzy text-bg hover:brightness-110' : 'text-fg-2 ring-1 ring-rule-2 hover:text-fg')}
          >
            <ExternalLink className="size-3.5" /> Open site
          </a>
        )}
      </div>
    </div>
  )
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
