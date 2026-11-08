import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ExternalLink, X } from 'lucide-react'
import type { RunState, TargetState } from '../store'
import { USE_MOCK } from '../api'
import type { Found } from '../lib/results'
import { addedToBasket, better, money, whyItWon } from '../lib/results'
import type { SkillStats } from '../lib/stats'
import { clock, cx, hostOf, siteColor } from '../lib/ui'
import { Avatar } from './Strip'
import { SimPage } from './SimPage'

function useMedia(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setMatch(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return match
}

/* ---------------- Live ranked strip ---------------- */

const CARD_H = 92
const GAP = 8

/** Results drop in as each site reports a price, and the row re-sorts itself. */
export function FoundStrip({ run, found, onEvidence }: { run: RunState; found: Found[]; onEvidence: (id: string) => void }) {
  const wide = useMedia('(min-width: 640px)')
  const foundIds = new Set(found.map((f) => f.target.id))
  const waiting = run.targets.filter((t) => !foundIds.has(t.id) && ['queued', 'running'].includes(t.status) || (t.status === 'needs_human' && t.blocked?.resumable))
  const missing = run.targets.filter((t) => !foundIds.has(t.id) && !waiting.includes(t))
  const slots: ({ kind: 'found'; f: Found } | { kind: 'wait' | 'none'; t: TargetState })[] = [
    ...found.map((f) => ({ kind: 'found' as const, f })),
    ...waiting.map((t) => ({ kind: 'wait' as const, t })),
    ...missing.map((t) => ({ kind: 'none' as const, t })),
  ]
  const n = slots.length
  if (!n) return null

  return (
    <div className="relative" style={{ height: wide ? CARD_H : n * (CARD_H + GAP) - GAP }} role="list" aria-label="Results so far, cheapest first">
      {slots.map((slot, rank) => {
        const t = slot.kind === 'found' ? slot.f.target : slot.t
        const pos = wide
          ? { left: `calc(${rank} * ((100% - ${(n - 1) * GAP}px) / ${n} + ${GAP}px))`, top: 0, width: `calc((100% - ${(n - 1) * GAP}px) / ${n})` }
          : { left: 0, top: rank * (CARD_H + GAP), width: '100%' }
        return (
          <div
            key={t.id}
            role="listitem"
            className="absolute transition-[left,top] duration-700 ease-[cubic-bezier(.65,0,.35,1)]"
            style={{ ...pos, height: CARD_H }}
          >
            {slot.kind === 'found' ? (
              <FoundCard f={slot.f} rank={rank} best={rank === 0 && !slot.f.overBudget} onEvidence={() => onEvidence(t.id)} />
            ) : slot.kind === 'none' && t.status === 'ok' ? (
              <AddedCard run={run} t={t} onEvidence={() => onEvidence(t.id)} />
            ) : (
              <div className={cx('flex h-full flex-col justify-between rounded-xl p-3 ring-1 ring-rule', slot.kind === 'wait' ? 'bg-panel/60' : 'bg-transparent')}>
                <div className="flex items-center gap-2 text-[12.5px] text-fg-2">
                  <Avatar name={t.name} size={18} color={siteColor(t.index)} />
                  <span className="truncate">{t.name}</span>
                </div>
                {slot.kind === 'wait' ? (
                  <div className="space-y-1.5">
                    <div className="h-2.5 w-3/4 animate-blink rounded bg-chip" />
                    <div className="h-4 w-1/3 animate-blink rounded bg-chip" />
                  </div>
                ) : (
                  <span className="truncate text-[12px] text-fg-3" title={t.currentStep}>
                    {t.status === 'needs_human' ? (t.currentStep && t.currentStep.length < 60 ? t.currentStep : 'Needed a person') : t.status === 'stopped' ? 'Stopped' : 'Could not finish'}
                  </span>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** A site that finished without reporting a price: show what went into the basket. */
function AddedCard({ run, t, onEvidence }: { run: RunState; t: TargetState; onEvidence: () => void }) {
  const added = addedToBasket(run, t.id)
  return (
    <div className="animate-slide-in flex h-full flex-col justify-between rounded-xl bg-panel p-3 ring-1 ring-rule">
      <div className="flex items-center gap-2 text-[12.5px]">
        <Avatar name={t.name} size={18} color={siteColor(t.index)} />
        <span className="truncate font-medium">{t.name}</span>
      </div>
      <button onClick={onEvidence} className="truncate text-left text-[13.5px] text-fg hover:underline" title="See the final page">
        {added.product ?? 'Product added'}
      </button>
      <div className="flex items-center gap-2 text-[12px]">
        <span className="flex items-center gap-1 text-exact">
          <Check className="size-3.5" strokeWidth={2.5} /> {added.confirmed ? 'In the basket' : 'Done'}
        </span>
        {added.url && (
          <a href={added.url} target="_blank" rel="noopener noreferrer" className="ml-auto flex items-center gap-1 text-fg-3 hover:text-fg">
            Open <ExternalLink className="size-3" />
          </a>
        )}
      </div>
    </div>
  )
}

function FoundCard({ f, rank, best, onEvidence }: { f: Found; rank: number; best: boolean; onEvidence: () => void }) {
  return (
    <div className={cx('animate-slide-in flex h-full flex-col justify-between rounded-xl p-3 ring-1', best ? 'bg-sel ring-accent/60' : 'bg-panel ring-rule', f.overBudget && 'opacity-60')}>
      <div className="flex items-center gap-2 text-[12.5px]">
        <span className="tabular w-3 shrink-0 font-mono text-[11px] text-fg-3">{rank + 1}</span>
        <Avatar name={f.target.name} size={18} color={siteColor(f.target.index)} />
        <span className="truncate font-medium">{f.target.name}</span>
        {f.delivery && <span className="ml-auto shrink-0 text-[11px] text-fg-3">{f.delivery}</span>}
      </div>
      <div className="truncate text-[12px] text-fg-2">{f.product ?? ' '}</div>
      <div className="flex items-baseline gap-2">
        <button onClick={onEvidence} className="tabular rounded font-mono text-[16px] font-semibold underline decoration-rule-2 decoration-dotted underline-offset-4 hover:decoration-accent" title="See where this price came from">
          {money(f.unit, f.cur)}
        </button>
        {f.qty > 1 && <span className="tabular font-mono text-[11px] text-fg-3">{money(f.total, f.cur)} for {f.qty}</span>}
        {f.overBudget && <span className="ml-auto text-[11px] text-fuzzy">Over budget</span>}
      </div>
    </div>
  )
}

/* ---------------- Winner ---------------- */

export function WinnerCard({ found, budget, approve, approved, onApprove, onEvidence }: {
  found: Found[]
  budget?: { amount: number; cur: string }
  approve?: string
  approved?: boolean
  onApprove: () => void
  onEvidence: (id: string) => void
}) {
  const win = found[0]
  const runner = found[1]
  const reasons = whyItWon(win, found, budget)
  const rows: { label: string; a: string; b?: string; key?: 'unit' | 'total' | 'delivery' | 'rating' }[] = [
    { label: 'Product', a: win.product ?? '–', b: runner?.product ?? '–' },
    { label: 'Each', a: money(win.unit, win.cur), b: runner && money(runner.unit, runner.cur), key: 'unit' },
    ...(win.qty > 1 ? [{ label: `For ${win.qty}`, a: money(win.total, win.cur), b: runner && money(runner.total, runner.cur), key: 'total' as const }] : []),
    ...(win.delivery || runner?.delivery ? [{ label: 'Delivery', a: win.delivery ?? '–', b: runner?.delivery ?? '–', key: 'delivery' as const }] : []),
    ...(win.rating || runner?.rating ? [{ label: 'Rating', a: win.rating?.toFixed(1) ?? '–', b: runner?.rating?.toFixed(1) ?? '–', key: 'rating' as const }] : []),
  ]

  return (
    <div className="animate-slide-in overflow-hidden rounded-xl bg-panel ring-1 ring-accent/50">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 p-4">
        <Avatar name={win.target.name} size={36} color={siteColor(win.target.index)} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-fg-3">Best pick</div>
          <div className="text-[20px] leading-tight font-semibold tracking-[-0.02em]">{win.target.name}</div>
          <div className="truncate text-[13.5px] text-fg-2">{win.product}</div>
        </div>
        <div className="text-right">
          <button onClick={() => onEvidence(win.target.id)} className="tabular font-mono text-[24px] font-semibold underline decoration-rule-2 decoration-dotted underline-offset-[6px] hover:decoration-accent" title="See where this price came from">
            {money(win.unit, win.cur)}
          </button>
          {win.qty > 1 && <div className="tabular font-mono text-[12px] text-fg-3">{money(win.total, win.cur)} for {win.qty}</div>}
        </div>
      </div>

      {reasons.length > 0 && (
        <ul className="flex flex-wrap gap-2 px-4 pb-4">
          {reasons.map((r) => (
            <li key={r} className="flex items-center gap-1.5 rounded-md bg-exact/10 px-2 py-1 text-[12.5px] text-fg">
              <Check className="size-3.5 text-exact" strokeWidth={2.5} /> {r}
            </li>
          ))}
        </ul>
      )}

      {runner && (
        <table className="tabular w-full border-t border-rule text-[13px]">
          <thead>
            <tr className="text-left text-[11.5px] text-fg-3">
              <th className="w-24 py-2 pl-4 font-medium" />
              <th className="py-2 pr-3 font-medium text-fg">{win.target.name}</th>
              <th className="py-2 pr-4 font-medium">{runner.target.name}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const side = row.key ? better(row.key, win, runner) : undefined
              return (
                <tr key={row.label} className="border-t border-rule/60">
                  <td className="py-2 pl-4 text-[12px] text-fg-3">{row.label}</td>
                  <td className={cx('py-2 pr-3', row.key && 'font-mono text-[12.5px]', side === 'b' ? 'text-fg-3' : 'text-fg')}>
                    <span className="inline-flex items-center gap-1.5">{row.a}{side === 'a' && <Check className="size-3.5 text-exact" strokeWidth={2.5} aria-label="better" />}</span>
                  </td>
                  <td className={cx('py-2 pr-4', row.key && 'font-mono text-[12.5px]', side === 'b' ? 'text-fg' : 'text-fg-3')}>
                    <span className="inline-flex items-center gap-1.5">{row.b}{side === 'b' && <Check className="size-3.5 text-exact" strokeWidth={2.5} aria-label="better" />}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {approve && (
        <div className="flex flex-wrap items-center gap-3 border-t border-rule px-4 py-3">
          <span className="text-[13px] text-fg-2">{approved ? 'Approved. The agent won’t pay without you.' : 'Stopped before paying. Nothing spent.'}</span>
          {approved ? (
            <Check className="ml-auto size-4 text-exact" />
          ) : (
            <button onClick={onApprove} className="ml-auto h-10 rounded-xl bg-accent px-4 text-[14px] font-semibold text-white transition hover:bg-accent-2">
              {approve}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------------- Price against budget ---------------- */

export function PriceChart({ found, budget }: { found: Found[]; budget?: { amount: number; cur: string } }) {
  const [hover, setHover] = useState<string | null>(null)
  if (!found.length || (!budget && found.length < 2)) return null
  const cur = found[0].cur
  const values = [...found.map((f) => f.unit), ...(budget ? [budget.amount] : [])]
  const span = Math.max(...values) - Math.min(...values) || Math.max(...values) * 0.2
  const lo = Math.max(0, Math.min(...values) - span * 0.25)
  const hi = Math.max(...values) + span * 0.2
  const x = (v: number) => ((v - lo) / (hi - lo)) * 100
  const byPrice = [...found].sort((a, b) => a.unit - b.unit)
  // Round ticks, kept clear of the budget line's own label.
  const ticks = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1].map((v) => Math.round(v / 10) * 10)
    .filter((v) => !budget || Math.abs(x(v) - x(budget.amount)) > 8)
  const qty = found[0].qty
  const best = found[0]

  return (
    <div className="rounded-xl bg-panel p-4 ring-1 ring-rule">
      <div className="text-[13px] font-medium">Price each{budget && ` against your ${money(budget.amount, budget.cur)} budget`}</div>
      <div className="relative mt-3 h-[96px]">
        {budget && (
          <>
            <div className="absolute inset-y-0 right-0 rounded-r bg-fg/[0.04]" style={{ left: `${x(budget.amount)}%` }} />
            <div className="absolute inset-y-0 border-l border-dashed border-fg-3" style={{ left: `${x(budget.amount)}%` }} />
            <span className="absolute top-0 ml-1.5 text-[11px] text-fg-3" style={{ left: `${x(budget.amount)}%` }}>Over budget</span>
          </>
        )}
        <div className="absolute inset-x-0 top-[52px] h-px bg-rule" />
        {byPrice.map((f, i) => {
          const above = i % 2 === 0
          const on = hover === f.target.id
          return (
            <div key={f.target.id} className="absolute top-[52px] transition-[left] duration-700" style={{ left: `${x(f.unit)}%` }}>
              <button
                className="absolute -top-4 -left-4 grid size-8 place-items-center rounded-full"
                onMouseEnter={() => setHover(f.target.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(f.target.id)}
                onBlur={() => setHover(null)}
                aria-label={`${f.target.name}: ${money(f.unit, f.cur)}${f.overBudget ? ', over budget' : ''}`}
              >
                <span
                  className="animate-slide-in block size-3 rounded-full ring-2 ring-panel"
                  style={f.overBudget ? { background: 'transparent', boxShadow: 'inset 0 0 0 2px var(--color-fg-3)' } : { background: siteColor(f.target.index) }}
                />
              </button>
              <span className={cx('pointer-events-none absolute -translate-x-1/2 whitespace-nowrap text-[11.5px]', above ? 'bottom-3' : 'top-3', f.overBudget ? 'text-fg-3' : 'text-fg-2')}>
                {f.target.name}
              </span>
              {on && (
                <span className="pointer-events-none absolute bottom-6 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg glass-pop px-2 py-1 text-[12px] text-fg">
                  <span className="tabular font-mono font-semibold">{money(f.unit, f.cur)}</span>
                  {f.overBudget && budget ? ` · ${money(f.unit - budget.amount, f.cur)} over` : budget ? ` · ${money(budget.amount - f.unit, f.cur)} under` : ''}
                </span>
              )}
            </div>
          )
        })}
        {ticks.map((v) => (
          <span key={v} className="tabular absolute bottom-0 -translate-x-1/2 font-mono text-[10.5px] text-fg-3" style={{ left: `${x(v)}%` }}>
            {money(v, cur)}
          </span>
        ))}
      </div>

      {budget && qty > 1 && <BasketBar total={best.total} limit={budget.amount * qty} qty={qty} cur={cur} />}
    </div>
  )
}

function BasketBar({ total, limit, qty, cur }: { total: number; limit: number; qty: number; cur: string }) {
  const max = Math.max(total, limit) * 1.04
  const over = total > limit
  return (
    <div className="mt-4 border-t border-rule pt-3">
      <div className="flex items-baseline justify-between text-[12.5px]">
        <span className="text-fg-2">Basket for {qty} at the best pick</span>
        <span className="tabular font-mono">
          {money(total, cur)} <span className="text-fg-3">of {money(limit, cur)}</span>
        </span>
      </div>
      <div className="relative mt-2 h-2.5 rounded-full bg-chip">
        <div className={cx('h-full rounded-full transition-[width] duration-700', over ? 'bg-heal' : 'bg-accent')} style={{ width: `${(total / max) * 100}%` }} />
        <div className="absolute -inset-y-1 w-0.5 rounded bg-fg" style={{ left: `${(limit / max) * 100}%` }} title="Budget" />
      </div>
      <div className={cx('mt-1.5 text-[12px]', over ? 'text-heal' : 'text-fg-3')}>
        {over ? `${money(total - limit, cur)} over budget` : `${money(limit - total, cur)} left in the budget`}
      </div>
    </div>
  )
}

/* ---------------- Receipt ---------------- */

export function Receipt({ run, steps, stats, shop }: { run: RunState; steps: number; stats?: SkillStats; shop: boolean }) {
  const ok = run.targets.filter((t) => t.status === 'ok').length
  const actions = run.targets.reduce((n, t) => n + t.tiers.filter((x) => x && x !== 'skipped').length, 0)
  const phrases = run.heals.length
  const took = (run.finishedAt ?? Date.now()) - run.startedAt
  const perSite = stats?.recordedMs ?? steps * 20_000
  const saved = perSite * ok - took
  const items: [string, string][] = [
    [`${ok}/${run.targets.length}`, run.targets.length === 1 ? 'site done' : 'sites done'],
    [String(actions), 'actions'],
    [String(phrases), phrases === 1 ? 'new phrase learned' : 'new phrases learned'],
    ...(shop ? [['£0', 'spent'] as [string, string]] : []),
    saved >= 60_000 ? [`${Math.round(saved / 60_000)} min`, 'saved vs by hand'] : [clock(took), 'run time'],
  ]

  return (
    <div className="animate-slide-in">
      <div className="perforated h-2" />
      <div className="rounded-b-xl bg-panel px-4 pt-3 pb-4 ring-1 ring-rule">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:flex sm:justify-between">
          {items.map(([value, label]) => (
            <div key={label}>
              <dt className="sr-only">{label}</dt>
              <dd className="tabular font-mono text-[20px] font-semibold">{value}</dd>
              <dd className="text-[12px] text-fg-3">{label}</dd>
            </div>
          ))}
        </dl>
        {saved >= 60_000 && (
          <p className="mt-3 text-[11.5px] text-fg-3">
            Estimate: your recording took {Math.max(1, Math.round(perSite / 60_000))} min per site, the agent took {clock(took)} for all of them.
          </p>
        )}
      </div>
    </div>
  )
}

/* ---------------- Evidence ---------------- */

export function EvidenceModal({ run, targetId, kind, onClose }: { run: RunState; targetId: string; kind: 'shop' | 'quote'; onClose: () => void }) {
  const t = run.targets.find((x) => x.id === targetId)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    closeBtn.current?.focus()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    if (el.clientWidth) setScale(el.clientWidth / 480)
    const ro = new ResizeObserver(([e]) => e.contentRect.width && setScale(e.contentRect.width / 480))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  if (!t) return null
  const value = t.result ? String(t.result.unit ?? t.result.price ?? t.result.total ?? '') : ''

  return createPortal(
    <div className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/55 p-4 backdrop-blur-md" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`Where ${t.name}’s price came from`} className="glass-pop animate-slide-in w-full max-w-[640px] overflow-hidden rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 border-b border-rule px-4 py-3">
          <Avatar name={t.name} size={22} color={siteColor(t.index)} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-medium">{t.name}</div>
            <div className="truncate font-mono text-[11px] text-fg-3">{hostOf(t.url)}</div>
          </div>
          <button ref={closeBtn} onClick={onClose} className="grid size-8 place-items-center rounded-lg text-fg-3 hover:bg-chip hover:text-fg" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div ref={box} className="relative aspect-[16/10] overflow-hidden bg-white">
          {t.evidence ? (
            <img src={t.evidence} alt={`Screenshot of ${t.name} when the result was read`} className="h-full w-full object-cover object-top" />
          ) : USE_MOCK ? (
            <div className="absolute top-0 left-0" style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
              <SimPage kind={kind} site={t.index} name={t.name} scene={4} ring="transparent" vars={run.variables} done={false} evidence />
            </div>
          ) : (
            <div className="grid h-full place-items-center bg-side px-6 text-center text-[13px] text-fg-3">This site didn’t send a screenshot.</div>
          )}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-[13px]">
          <span className="tabular font-mono font-semibold">{value}</span>
          <span className="text-fg-2">read from this page{t.foundAt !== undefined && ` ${clock(t.foundAt)} into the run`}</span>
          {USE_MOCK && <span className="ml-auto text-[11.5px] text-fg-3">Demo page</span>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
