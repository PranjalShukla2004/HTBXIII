import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ExternalLink, Hand, MousePointer2 } from 'lucide-react'
import { useStore } from '../store'
import type { FocusReason, TargetState } from '../store'
import { USE_MOCK } from '../api'
import { TIER_META, cx, hostOf, siteColor } from '../lib/ui'
import { Avatar, Field, Strip, Ticks } from './Strip'
import type { Tone } from './Strip'
import { SimPage } from './SimPage'
import { money, parseMoney } from '../lib/results'

const REASON: Record<FocusReason, string> = { heal: 'Self-heal', needs: 'Needs you', price: 'Price found', live: 'Live' }
const STATUS_LABEL: Record<TargetState['status'], string> = {
  queued: 'Queued', running: 'Running', ok: 'Completed', failed: 'Failed', needs_human: 'Needs attention', stopped: 'Stopped',
}
const STATUS_TEXT: Record<TargetState['status'], string> = {
  queued: 'text-fg-3', running: 'text-accent-2', ok: 'text-fg-2', failed: 'text-heal', needs_human: 'text-fuzzy', stopped: 'text-fg-3',
}
const HEAL_MS = 3400

type Pt = { x: number; y: number }

export function SiteWindow({
  msgId, t, kind, vars, variant, reason, onPick,
}: {
  msgId: string
  t: TargetState
  kind: 'shop' | 'quote'
  vars: Record<string, string>
  variant: 'spot' | 'thumb'
  reason?: FocusReason
  onPick?: () => void
}) {
  const takeOver = useStore((s) => s.takeOver)
  const handBack = useStore((s) => s.handBack)
  const box = useRef<HTMLDivElement>(null)
  const page = useRef<HTMLDivElement>(null)
  const ghostPage = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.6)
  const [agent, setAgent] = useState<Pt | null>(null)
  const [ghost, setGhost] = useState<Pt | null>(null)
  const [trail, setTrail] = useState<Pt[]>([])
  const trailByScene = useRef(new Map<number, Pt>())
  const healing = useHealMoment(t.heal?.at)
  const spot = variant === 'spot'

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / 480))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const total = t.totalSteps || (USE_MOCK ? 7 : 0)
  const scene = Math.min(t.stepIndex, Math.max(total - 1, 0))
  const tier = t.tiers[scene]
  const ring = t.blocked ? 'var(--color-fuzzy)' : tier && tier !== 'skipped' ? TIER_META[tier].color : '#7c6bff'
  const sim = USE_MOCK && !t.frame && t.status !== 'queued'
  const done = t.status === 'ok'

  // Point the cursors at whatever the page marks as being acted on.
  useLayoutEffect(() => {
    if (!sim) return
    const centre = (root: HTMLElement | null, s: number): Pt | null => {
      const hot = root?.querySelector('[data-hot]')
      if (!root || !hot) return null
      const a = root.getBoundingClientRect()
      const b = hot.getBoundingClientRect()
      return { x: (b.left - a.left + b.width / 2) / s, y: (b.top - a.top + b.height / 2) / s }
    }
    const a = centre(page.current, scale)
    setAgent(a)
    if (spot) {
      const g = t.blocked ? null : centre(ghostPage.current, scale)
      if (g) trailByScene.current.set(scene, g)
      setGhost(g)
      setTrail([...trailByScene.current.entries()].sort(([a], [b]) => a - b).map(([, p]) => p))
    }
  }, [sim, scene, scale, spot, t.blocked, t.status, t.takeover])

  const tone: Tone = t.status === 'queued' ? 'ghost' : t.blocked ? 'warn' : ['failed', 'stopped'].includes(t.status) ? 'warn' : done ? 'chip' : t.learned ? 'warn' : 'sel'
  const raw = t.result ? t.result.unit ?? t.result.price ?? t.result.total : undefined
  const amount = parseMoney(raw)
  const price = amount === undefined ? String(raw ?? '') : money(amount, String(raw).match(/[£$€]/)?.[0] ?? '£')
  const footer = t.takeover ? 'Your turn. Tick the box in the window.' : t.blocked ? t.blocked.message
    : t.status === 'queued' ? hostOf(t.url) : done && USE_MOCK ? 'Finished' : (t.currentStep ?? 'Opening the site')

  return (
    <div
      className={cx(
        'overflow-hidden rounded-xl bg-panel ring-1 transition-[opacity,box-shadow]',
        t.blocked ? 'needs ring-fuzzy/70' : 'ring-rule',
        t.status === 'queued' && 'opacity-55',
        onPick && 'cursor-pointer hover:ring-rule-2',
      )}
      onClick={onPick}
      role={onPick ? 'button' : undefined}
      tabIndex={onPick ? 0 : undefined}
      onKeyDown={onPick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick()) : undefined}
      aria-label={onPick ? `Show ${t.name} in the spotlight` : undefined}
    >
      <Strip tone={tone} className={cx('rounded-none border-0 border-b', spot ? 'h-10' : 'h-8')}>
        <Field className="pr-0">
          <Avatar name={t.name} size={spot ? 20 : 16} color={siteColor(t.index)} />
        </Field>
        <Field className="flex-1">
          <span className={cx('truncate font-medium', spot ? 'text-[13px]' : 'text-[12px]')}>{t.name}</span>
          {spot && reason && (
            <span className={cx('ml-2 shrink-0 rounded px-1.5 py-px text-[11px] font-medium',
              reason === 'heal' ? 'bg-heal/15 text-heal' : reason === 'needs' ? 'bg-fuzzy/15 text-fuzzy' : reason === 'price' ? 'bg-exact/15 text-exact' : 'bg-accent/15 text-accent-2')}>
              {REASON[reason]}
            </span>
          )}
        </Field>
        <Field className="pr-2.5">
          {done && price ? (
            <span className="tabular font-mono text-[12px] font-semibold">{price}</span>
          ) : (
            <Ticks total={total} tiers={t.tiers} active={t.status === 'running' ? t.stepIndex : undefined} />
          )}
        </Field>
      </Strip>

      <div ref={box} className="relative aspect-[16/10] overflow-hidden bg-white">
        {t.status === 'queued' ? (
          <div className="grid h-full place-items-center bg-side text-[12px] text-fg-3">Waiting</div>
        ) : t.frame ? (
          spot ? (
            <a href={t.frame} target="_blank" rel="noopener noreferrer" title="Open the screenshot full size" className="block h-full">
              <img src={t.frame} alt={`${t.frameFinal ? 'Final' : 'Live'} view of ${t.name}`} className="h-full w-full object-cover object-top" />
            </a>
          ) : (
            <img src={t.frame} alt={`${t.frameFinal ? 'Final' : 'Live'} view of ${t.name}`} className="h-full w-full object-cover object-top" />
          )
        ) : sim ? (
          <div className="absolute top-0 left-0" style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
            <div ref={page} className={cx(!t.takeover && 'pointer-events-none')}>
              <SimPage kind={kind} site={t.index} name={t.name} scene={scene} ring={ring} vars={vars} done={done}
                blocked={!!t.blocked && t.status === 'needs_human'} onSolve={t.takeover ? () => void handBack(msgId, t.id) : undefined} />
            </div>
            {spot && (
              // The recorded layout, measured off-screen to find where you clicked.
              <div ref={ghostPage} className="pointer-events-none invisible absolute top-0 left-0" aria-hidden>
                <SimPage kind={kind} site={0} name="" scene={scene} ring="transparent" vars={vars} done={done} />
              </div>
            )}
            <Cursors agent={t.takeover ? null : agent} ghost={spot ? ghost : null} trail={spot && !done ? trail : []} scene={scene} labels={spot} />
          </div>
        ) : (
          <div className="grid h-full place-items-center bg-side px-4 text-center text-[12px] text-fg-3">
            {t.status === 'running' ? (
              <span className="flex items-center gap-2">
                <span className="size-1.5 animate-blink rounded-full bg-accent" /> Watch the agent in its Chrome window
              </span>
            ) : t.status === 'needs_human' ? 'Needs your attention' : t.status === 'failed' ? 'Could not complete this site' : t.status === 'stopped' ? 'Stopped' : 'Run complete · no screenshot'}
          </div>
        )}

        {healing && t.heal && (spot ? <HealMoment from={t.heal.from} to={t.heal.to} /> : <span className="heal-flash pointer-events-none absolute inset-0" />)}
        {t.learned && !(healing && spot) && (
          <span className="animate-slide-in absolute top-2 right-2 max-w-[80%] rounded-md bg-black/80 px-2 py-1 text-[11.5px] font-medium text-fuzzy ring-1 ring-fuzzy/40 backdrop-blur">
            Learned “{t.learned}”
          </span>
        )}
      </div>

      <div className={cx('flex items-center gap-2 px-3 text-[12px] text-fg-2', spot ? 'min-h-10 py-1.5' : 'h-7')}>
        {t.status === 'running' && <span className="size-1.5 shrink-0 animate-blink rounded-full bg-accent" />}
        {t.blocked && <Hand className="size-3.5 shrink-0 text-fuzzy" />}
        <span className={cx('min-w-0 flex-1', t.blocked && 'text-fuzzy')} title={t.detail ?? footer}>
          <span className={cx('block', spot ? 'leading-snug' : 'truncate')}>{footer}</span>
          {spot && t.blocked && t.attention?.options.length ? (
            <span className="mt-0.5 block truncate font-mono text-[11px] text-fg-2" title={t.attention.options.join(' · ')}>{t.attention.options.join(' · ')}</span>
          ) : null}
        </span>
        {!(spot && t.blocked) && <span className={cx('shrink-0 font-medium', spot ? 'text-[11px]' : 'text-[10.5px]', STATUS_TEXT[t.status])}>{STATUS_LABEL[t.status]}</span>}
        {spot && !t.blocked && !USE_MOCK && t.status !== 'queued' && (
          <a href={t.lastUrl ?? t.url} target="_blank" rel="noopener noreferrer" title={t.lastUrl ?? t.url} onClick={(e) => e.stopPropagation()}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-fg-2 ring-1 ring-rule-2 hover:text-fg">
            <ExternalLink className="size-3.5" /> Open site
          </a>
        )}
        {t.blocked && spot && (
          t.blocked.resumable ? (
            t.takeover ? (
              <button onClick={(e) => (e.stopPropagation(), void handBack(msgId, t.id))} className="h-7 shrink-0 rounded-lg px-2.5 text-[12px] font-medium text-fg ring-1 ring-rule-2 hover:ring-fg-3">
                Hand back
              </button>
            ) : (
              <button onClick={(e) => (e.stopPropagation(), takeOver(msgId, t.id))} className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-fuzzy px-2.5 text-[12px] font-semibold text-black hover:brightness-110">
                <MousePointer2 className="size-3.5" /> Take over
              </button>
            )
          ) : (
            <a href={t.lastUrl ?? t.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-fuzzy px-2.5 text-[12px] font-semibold text-black hover:brightness-110">
              <ExternalLink className="size-3.5" /> Open site
            </a>
          )
        )}
      </div>
    </div>
  )
}

/** True for a few seconds after a self-heal. */
function useHealMoment(at?: number) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!at) return
    const left = HEAL_MS - (Date.now() - at)
    if (left <= 0) return
    setOn(true)
    const timer = setTimeout(() => setOn(false), left)
    return () => clearTimeout(timer)
  }, [at])
  return on
}

function HealMoment({ from, to }: { from?: string; to: string }) {
  return (
    <div className="animate-fade-in absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 px-4 text-center backdrop-blur-[2px] sm:flex-row sm:gap-0">
      {from && (
        <>
          <div className="animate-slide-in">
            <div className="text-[11.5px] text-fg-3">You clicked</div>
            <div className="mt-1 rounded-md bg-fg px-3 py-1.5 text-[14px] font-semibold text-bg">{from}</div>
          </div>
          <div className="relative h-8 w-px sm:mx-4 sm:mt-5 sm:h-px sm:w-20">
            <span className="animate-draw absolute inset-0 origin-top bg-heal sm:origin-left" />
          </div>
        </>
      )}
      <div className="animate-slide-in [animation-delay:500ms]">
        <div className="text-[11.5px] text-fg-3">This site calls it</div>
        <div className="mt-1 rounded-md bg-heal/15 px-3 py-1.5 text-[14px] font-semibold text-heal ring-1 ring-heal/60">{to}</div>
      </div>
      <div className="animate-slide-in absolute bottom-3 text-[11.5px] text-fg-2 [animation-delay:1100ms]">Learned. It’s in the phrase library now.</div>
    </div>
  )
}

/** Your recorded click (faint, dashed path) next to where the agent is clicking now. */
function Cursors({ agent, ghost, trail, scene, labels }: { agent: Pt | null; ghost: Pt | null; trail: Pt[]; scene: number; labels: boolean }) {
  return (
    <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width={480} height={300} aria-hidden>
      {trail.length > 1 && (
        <polyline points={trail.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#000" strokeOpacity={0.28} strokeWidth={1.5} strokeDasharray="3 5" strokeLinecap="round" />
      )}
      {ghost && (
        <g style={{ transform: `translate(${ghost.x}px, ${ghost.y}px)`, transition: 'transform .6s cubic-bezier(.16,1,.3,1)' }}>
          <path d="M0 0 L0 17 L4.5 13 L7.5 20 L10.5 18.8 L7.6 12.2 L13 12 Z" fill="#fff" fillOpacity={0.6} stroke="#000" strokeOpacity={0.45} strokeWidth={1.2} strokeDasharray="2 2" />
          {labels && (
            <g transform="translate(-6 24)">
              <rect width={30} height={16} rx={4} fill="#000" fillOpacity={0.45} />
              <text x={15} y={11.5} textAnchor="middle" fontSize={10} fontFamily="Geist Variable, sans-serif" fill="#fff">You</text>
            </g>
          )}
        </g>
      )}
      {agent && (
        <g style={{ transform: `translate(${agent.x}px, ${agent.y}px)`, transition: 'transform .7s cubic-bezier(.65,0,.35,1)' }}>
          <circle key={scene} r={6} fill="none" stroke="#7c6bff" strokeWidth={2} className="animate-ripple" />
          <path d="M0 0 L0 17 L4.5 13 L7.5 20 L10.5 18.8 L7.6 12.2 L13 12 Z" fill="#7c6bff" stroke="#fff" strokeWidth={1.4} strokeLinejoin="round" />
          {labels && (
            <g transform="translate(14 18)">
              <rect width={42} height={16} rx={4} fill="#7c6bff" />
              <text x={21} y={11.5} textAnchor="middle" fontSize={10} fontWeight={600} fontFamily="Geist Variable, sans-serif" fill="#fff">Agent</text>
            </g>
          )}
        </g>
      )}
    </svg>
  )
}
