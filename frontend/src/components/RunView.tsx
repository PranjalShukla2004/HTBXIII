import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Square, TriangleAlert } from 'lucide-react'
import { useStore } from '../store'
import type { RunState, TargetState } from '../store'
import { USE_MOCK } from '../api'
import { TIER_META, clock, cx, hostOf } from '../lib/ui'
import { Avatar, Field, Strip, Ticks } from './Strip'
import type { Tone } from './Strip'
import { SimPage } from './SimPage'

export function RunView({ msgId, skillIds, run }: { msgId: string; skillIds: string[]; run: RunState }) {
  const skills = useStore((s) => s.skills)
  const stop = useStore((s) => s.stopRun)
  const approve = useStore((s) => s.approve)
  const [logs, setLogs] = useState(false)
  const [, tick] = useState(0)
  const live = run.status === 'starting' || run.status === 'planning' || run.status === 'running'

  useEffect(() => {
    if (!live) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [live])

  const skill = skills.find((s) => s.id === skillIds[0])
  const kind: 'shop' | 'quote' = skill && /shop|mart|store|cart/i.test(skill.name + skill.site.url) ? 'shop' : 'quote'
  const done = run.targets.filter((t) => t.status === 'ok' || t.status === 'failed').length

  return (
    <section className="animate-slide-in">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className={cx('text-[24px] leading-tight font-semibold tracking-[-0.025em]', !run.plan && 'animate-blink text-fg-3')}>
          {run.plan ?? 'Planning…'}
        </h2>
        <span className="tabular ml-auto flex items-center gap-3 font-mono text-[12px] text-fg-3">
          {run.targets.length > 0 && (
            <span className={cx(run.status === 'done' ? 'text-exact' : live ? 'text-accent-2' : 'text-fg-3')}>
              {run.status === 'done' ? 'done' : `${done}/${run.targets.length}`}
            </span>
          )}
          {clock((run.finishedAt ?? Date.now()) - run.startedAt)}
          {live && (
            <button onClick={() => void stop(msgId)} className="flex h-7 items-center gap-1.5 rounded-lg px-2 font-sans text-[12px] ring-1 ring-rule-2 hover:text-heal hover:ring-heal/50">
              <Square className="size-2.5 fill-current" /> Stop
            </button>
          )}
        </span>
      </header>

      {run.targets.length > 0 && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {run.targets.map((t, i) => (
            <SiteWindow key={t.id} t={t} index={i} kind={kind} vars={run.variables} />
          ))}
        </div>
      )}

      {run.status === 'done' && run.table && (
        <div className="animate-slide-in mt-5">
          <table className="tabular w-full text-[14px]">
            <thead>
              <tr className="text-left text-[11.5px] text-fg-3">
                {run.table.columns.map((c, j) => (
                  <th key={c} className={cx('pb-2 font-medium', isNum(run.table!.rows[0]?.[j]) && 'text-right')}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {run.table.rows.map((r, i) => {
                const best = i === run.table!.bestRow
                return (
                  <tr key={i} className={cx('border-t border-rule', best ? 'text-fg' : 'text-fg-2')}>
                    {r.map((c, j) => (
                      <td key={j} className={cx('py-2.5 pr-4 last:pr-0', isNum(c) && 'text-right font-mono text-[13px]', j === 0 && 'font-semibold')}>
                        {j === 0 && best ? (
                          <span className="relative inline-block">
                            {c}
                            <svg className="pointer-events-none absolute -inset-x-2 -bottom-1.5 h-2 w-[calc(100%+16px)]" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden>
                              <path d="M2 5 C 30 2, 60 7, 98 3" fill="none" stroke="var(--color-accent)" strokeWidth="2.2" strokeLinecap="round" />
                            </svg>
                          </span>
                        ) : (
                          c
                        )}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
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

      {(run.status === 'failed' || run.status === 'stopped') && (
        <p className="mt-4 flex items-center gap-2 text-[13.5px] text-heal">
          <TriangleAlert className="size-4" /> {run.error ?? 'Stopped.'}
        </p>
      )}

      <button onClick={() => setLogs((v) => !v)} className="mt-4 flex h-7 items-center gap-1.5 text-[12px] text-fg-3 hover:text-fg" aria-expanded={logs}>
        <ChevronDown className={cx('size-3.5 transition', logs && 'rotate-180')} />
        Logs <span className="tabular font-mono">{run.logs.length}</span>
      </button>
      {logs && <LogPanel run={run} />}
    </section>
  )
}

function SiteWindow({ t, index, kind, vars }: { t: TargetState; index: number; kind: 'shop' | 'quote'; vars: Record<string, string> }) {
  const ref = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.6)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / 480))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const total = t.totalSteps || 7
  const scene = Math.min(t.stepIndex, total - 1)
  const tier = t.tiers[scene]
  const ring = tier && tier !== 'skipped' ? TIER_META[tier].color : '#7c6bff'
  const tone: Tone = t.status === 'queued' ? 'ghost' : t.status === 'failed' ? 'warn' : t.status === 'ok' ? 'chip' : t.learned ? 'warn' : 'sel'
  const result = t.result ? String(t.result.total ?? Object.values(t.result)[1] ?? '') : ''

  return (
    <div className={cx('overflow-hidden rounded-xl bg-panel ring-1 ring-rule transition-opacity', t.status === 'queued' && 'opacity-55')}>
      <Strip tone={tone} className="h-10 rounded-none border-0 border-b">
        <Field className="pr-0">
          <Avatar name={t.name} size={20} />
        </Field>
        <Field className="flex-1">
          <span className="truncate text-[13px] font-medium">{t.name}</span>
        </Field>
        <Field className="pr-2.5">
          {t.status === 'ok' && result ? (
            <span className="tabular font-mono text-[12px] font-semibold">{result}</span>
          ) : (
            <Ticks total={total} tiers={t.tiers} active={t.status === 'running' ? t.stepIndex : undefined} />
          )}
        </Field>
      </Strip>
      <div ref={ref} className="relative aspect-[16/10] overflow-hidden bg-white">
        {t.status === 'queued' ? (
          <div className="grid h-full place-items-center bg-side text-[12px] text-fg-3">Waiting</div>
        ) : t.frame ? (
          <img src={t.frame} alt={`Live view of ${t.name}`} className="h-full w-full object-cover object-top" />
        ) : USE_MOCK ? (
          <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
            <SimPage kind={kind} site={index} name={t.name} scene={scene} ring={ring} vars={vars} done={t.status === 'ok'} />
          </div>
        ) : (
          <div className="grid h-full place-items-center bg-side px-4 text-center text-[12px] text-fg-3">Running in its browser window</div>
        )}
        {t.learned && (
          <span className="animate-slide-in absolute top-2 right-2 max-w-[80%] rounded-md bg-black/80 px-2 py-1 text-[11.5px] font-medium text-fuzzy ring-1 ring-fuzzy/40 backdrop-blur">
            Learned “{t.learned}”
          </span>
        )}
      </div>
      <div className="flex h-8 items-center gap-2 px-3 text-[12px] text-fg-2">
        {t.status === 'running' && <span className="size-1.5 shrink-0 animate-blink rounded-full bg-accent" />}
        <span className="truncate">
          {t.status === 'queued' ? hostOf(t.url) : t.status === 'ok' ? 'Finished' : (t.currentStep ?? 'Opening')}
        </span>
      </div>
    </div>
  )
}

function LogPanel({ run }: { run: RunState }) {
  const [debug, setDebug] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const lines = run.logs.filter((l) => debug || l.level !== 'debug')
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])
  useEffect(() => {
    const el = ref.current?.lastElementChild
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

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
            <span className={cx('text-fg-2', l.level === 'warn' && 'text-fuzzy', l.level === 'error' && 'text-heal', l.level === 'debug' && 'text-fg-3')}>
              {l.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

const isNum = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && /^[£$€]?[\d,.]+$/.test(v))
