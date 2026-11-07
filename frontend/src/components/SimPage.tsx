// Synthetic supplier pages drawn in the mini browser while the mock agent runs.
// With the real backend, the window shows `frame` screenshots instead.
// The element being acted on carries `data-hot`, so the window can point a cursor at it.
// Each site lays things out differently; site 0 is the layout the skill was recorded on.
import { cx } from '../lib/ui'

interface Theme {
  brand: string
  bg: string
  ink: string
  font: string
  radius: number
  addLabel: string
  submitLabel: string
}

const SHOP_THEMES: Theme[] = [
  { brand: '#ffd400', bg: '#ffffff', ink: '#111', font: 'Arial, sans-serif', radius: 2, addLabel: 'Add to basket', submitLabel: '' },
  { brand: '#5b2be0', bg: '#f6f3ff', ink: '#1d1238', font: 'Georgia, serif', radius: 14, addLabel: 'Pop it in the bag', submitLabel: '' },
  { brand: '#127a3e', bg: '#f4f7f2', ink: '#132016', font: 'Verdana, sans-serif', radius: 6, addLabel: 'Add to cart', submitLabel: '' },
]
const QUOTE_THEMES: Theme[] = [
  { brand: '#1b3a6b', bg: '#ffffff', ink: '#14223a', font: 'Arial, sans-serif', radius: 3, addLabel: '', submitLabel: 'Send enquiry' },
  { brand: '#b4321e', bg: '#fbf7f2', ink: '#2a1510', font: 'Georgia, serif', radius: 10, addLabel: '', submitLabel: 'Get my price' },
  { brand: '#0f7c7a', bg: '#f3f8f8', ink: '#0f2928', font: 'Verdana, sans-serif', radius: 4, addLabel: '', submitLabel: 'Request quote' },
]

/** Where things sit on each shop. */
const SHOP_LAYOUT = [
  { search: 256, sortLeft: false, pick: 1, flip: false },
  { search: 150, sortLeft: true, pick: 3, flip: true },
  { search: 210, sortLeft: false, pick: 0, flip: false },
]

export const SHOP_PRICE = [0.94, 0.86, 0.91]
const SHOP_MODEL = ['Nimbus 14 Pro', 'Aero Book S', 'Lumen 15 Air']

type Hot = (on: boolean, base?: React.CSSProperties) => { style: React.CSSProperties; 'data-hot'?: '' }

export interface SimProps {
  kind: 'shop' | 'quote'
  site: number
  name: string
  scene: number
  ring: string
  vars: Record<string, string>
  done: boolean
  /** Paused on a human check. */
  blocked?: boolean
  /** The person is in control: the check can be clicked. */
  onSolve?: () => void
  /** Show the page where the price was read, with the price marked. */
  evidence?: boolean
}

export function SimPage({ kind, site, name, scene, ring, vars, done, blocked, onSolve, evidence }: SimProps) {
  const th = (kind === 'shop' ? SHOP_THEMES : QUOTE_THEMES)[site % 3]
  const live = !done && !evidence
  const H: Hot = (on, base = {}) =>
    on && live
      ? { 'data-hot': '', style: { ...base, outline: `2.5px solid ${ring}`, outlineOffset: 2, boxShadow: `0 0 0 7px color-mix(in srgb, ${ring} 22%, transparent)`, transition: 'outline-color .3s' } }
      : { style: base }
  const L = SHOP_LAYOUT[site % 3]
  const shopScene = evidence ? 4 : scene

  return (
    <div className="relative h-[300px] w-[480px] overflow-hidden text-[12px]" style={{ background: th.bg, color: th.ink, fontFamily: th.font }}>
      <div className="relative flex h-10 items-center gap-3 px-4" style={{ background: th.brand, color: site % 3 === 0 && kind === 'shop' ? '#111' : '#fff' }}>
        <b className="text-[14px] tracking-tight">{name}</b>
        {kind === 'shop' && (
          <div
            className="absolute top-2 flex h-6 w-52 items-center rounded bg-white px-2 text-[11px] text-neutral-800"
            {...H(shopScene === 1 && !blocked, { left: L.search, borderRadius: th.radius })}
          >
            {shopScene >= 1 ? vars.product ?? 'laptop' : <span className="text-neutral-400">Search</span>}
            {shopScene === 1 && live && <span className="ml-px h-3 w-px animate-caret bg-neutral-800" />}
          </div>
        )}
        {kind === 'quote' && <span className="ml-auto text-[11px] opacity-80">Trade · Quotes · Contact</span>}
      </div>
      {kind === 'shop' ? (
        <Shop th={th} scene={shopScene} H={H} vars={vars} site={site % 3} done={done && !evidence} evidence={evidence} blocked={blocked} />
      ) : (
        <Quote th={th} scene={scene} H={H} vars={vars} site={site % 3} done={done || !!evidence} evidence={evidence} />
      )}
      {blocked && <HumanCheck th={th} onSolve={onSolve} />}
    </div>
  )
}

function HumanCheck({ th, onSolve }: { th: Theme; onSolve?: () => void }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-black/35">
      <div className="w-[260px] bg-white p-4 text-neutral-800 shadow-xl" style={{ borderRadius: th.radius, fontFamily: 'Arial, sans-serif' }}>
        <b className="block text-[13px]">Quick check</b>
        <p className="mt-1 text-[11px] text-neutral-500">Before you continue, confirm you’re a person.</p>
        <button
          type="button"
          onClick={onSolve}
          disabled={!onSolve}
          data-hot=""
          className={cx('mt-3 flex w-full items-center gap-2.5 rounded border border-neutral-300 bg-neutral-50 p-2.5 text-left text-[12px]', onSolve && 'cursor-pointer hover:border-neutral-500')}
        >
          <span className={cx('size-5 rounded-sm border-2 border-neutral-400 bg-white', onSolve && 'animate-blink')} />
          I’m not a robot
        </button>
      </div>
    </div>
  )
}

function Skel({ w, h = 10, className }: { w: number | string; h?: number; className?: string }) {
  return <div className={cx('rounded bg-black/8', className)} style={{ width: w, height: h }} />
}

function Shop({ th, scene, H, vars, site, done, evidence, blocked }: { th: Theme; scene: number; H: Hot; vars: Record<string, string>; site: number; done: boolean; evidence?: boolean; blocked?: boolean }) {
  const L = SHOP_LAYOUT[site]
  const budget = Number((vars.budget ?? '£1000').replace(/[^\d.]/g, '')) || 1000
  // Same unit price and model the mock agent reports for this site.
  const chosen = { name: `${SHOP_MODEL[site]} ${vars.product ?? ''}`.trim(), price: Math.round(budget * SHOP_PRICE[site]) }
  const others = ['Vale', 'Orbit', 'Summit'].map((n, i) => ({ name: `${n} ${vars.product ?? 'item'}`, price: Math.round(budget * [1.18, 1.05, 1.3][i]) }))
  const items = [...others]
  items.splice(L.pick, 0, chosen)
  const onBrand = site === 0 ? '#111' : '#fff'
  const hot = (on: boolean, base?: React.CSSProperties) => H(on && !blocked, base)

  if (scene === 0)
    return (
      <div className="grid grid-cols-4 gap-3 p-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="space-y-2">
            <Skel w="100%" h={56} />
            <Skel w="80%" />
          </div>
        ))}
      </div>
    )
  if (scene <= 3)
    return (
      <div className="p-4">
        <div className={cx('mb-3 flex items-center gap-2 text-[11px]', L.sortLeft && 'flex-row-reverse')}>
          <span className="opacity-60">{scene >= 2 ? `${items.length * 31} results` : 'Popular'}</span>
          <span className={cx('rounded border border-black/15 px-2 py-0.5', L.sortLeft ? 'mr-auto' : 'ml-auto')} {...hot(scene === 2, { borderRadius: th.radius })}>
            Price: low to high
          </span>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {items.map((it, i) => (
            <div key={i} className="space-y-1.5 bg-white p-1.5" {...hot(scene === 3 && i === L.pick, { borderRadius: th.radius })}>
              <div className="h-16 rounded" style={{ background: `color-mix(in srgb, ${th.brand} ${14 + i * 6}%, #e9e9e9)`, borderRadius: th.radius }} />
              <div className="truncate text-[10.5px]">{it.name}</div>
              <b className="text-[11px]">£{it.price}</b>
            </div>
          ))}
        </div>
      </div>
    )
  if (scene <= 5)
    return (
      <div className={cx('flex gap-4 p-4', L.flip && 'flex-row-reverse')}>
        <div className="h-[200px] w-[180px] shrink-0 rounded" style={{ background: `color-mix(in srgb, ${th.brand} 22%, #e9e9e9)`, borderRadius: th.radius }} />
        <div className="flex-1 space-y-2.5">
          <b className="block text-[15px]">{chosen.name}</b>
          <div
            className="inline-block text-[18px] font-bold"
            style={evidence ? { outline: '2.5px solid var(--color-accent)', outlineOffset: 3, borderRadius: 3, boxShadow: '0 0 0 8px color-mix(in srgb, var(--color-accent) 25%, transparent)' } : undefined}
          >
            £{chosen.price}
          </div>
          <Skel w="90%" />
          <Skel w="70%" />
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[11px] opacity-70">Qty</span>
            <span className="grid h-7 w-12 place-items-center border border-black/20 bg-white" {...hot(scene === 4, { borderRadius: th.radius })}>
              {scene >= 4 && !evidence ? (vars.qty ?? 1) : 1}
            </span>
          </div>
          <span className="inline-block px-4 py-2 font-bold" {...hot(scene === 5, { background: th.brand, color: onBrand, borderRadius: th.radius })}>
            {th.addLabel}
          </span>
        </div>
      </div>
    )
  const qty = Number(vars.qty ?? 1)
  return (
    <div className="p-4">
      <b className="text-[15px]">Your basket</b>
      <div className="mt-3 flex items-center gap-3 bg-white p-2.5" style={{ borderRadius: th.radius }}>
        <div className="size-10 rounded" style={{ background: `color-mix(in srgb, ${th.brand} 22%, #e9e9e9)` }} />
        <span className="flex-1">{chosen.name}</span>
        <span>× {qty}</span>
        <b>£{(chosen.price * qty).toLocaleString('en-GB')}</b>
      </div>
      <div className={cx('mt-4 flex items-center', L.flip && 'flex-row-reverse')}>
        <span className="opacity-60">Delivery free</span>
        <span className={cx('px-5 py-2 font-bold', L.flip ? 'mr-auto' : 'ml-auto')} {...hot(scene === 6, { background: th.brand, color: onBrand, borderRadius: th.radius })}>
          Checkout
        </span>
      </div>
      {done && (
        <div className="mt-6 inline-block -rotate-2 rounded border-2 border-[#d23f2b] px-3 py-1 text-[13px] font-bold text-[#d23f2b]">
          Paused before payment
        </div>
      )}
    </div>
  )
}

export const QUOTE_UNIT = [4.2, 3.85, 4.6]

function Quote({ th, scene, H, vars, site, done, evidence }: { th: Theme; scene: number; H: Hot; vars: Record<string, string>; site: number; done: boolean; evidence?: boolean }) {
  const fields: [string, string | undefined][] = [
    ['Product', vars.product],
    ['Units required', vars.qty],
    ['Needed by', vars.delivery_date],
    ['Work email', vars.email],
  ]
  if (done)
    return (
      <div className="grid h-[260px] place-items-center text-center">
        <div>
          <div className="text-[16px] font-bold">Thanks, your quote is on its way</div>
          <div className="mt-1 opacity-60">Check your inbox in a few minutes.</div>
          <div
            className="mt-4 inline-block px-3 py-1.5 text-[13px] font-bold"
            style={evidence ? { outline: '2.5px solid var(--color-accent)', outlineOffset: 3, borderRadius: 3, boxShadow: '0 0 0 8px color-mix(in srgb, var(--color-accent) 25%, transparent)' } : undefined}
          >
            Indicative price: £{QUOTE_UNIT[site].toFixed(2)} per unit
          </div>
        </div>
      </div>
    )
  return (
    <div className="relative p-4">
      <b className="text-[15px]">Request a trade quote</b>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
        {fields.map(([label, val], i) => (
          // Site 1 swaps the two columns, so the same field sits somewhere else.
          <label key={label} className="block" style={site === 1 ? { order: i % 2 ? i - 1 : i + 1 } : undefined}>
            <span className="mb-1 block text-[10.5px] opacity-70">{label}</span>
            <span className="flex h-7 items-center border border-black/20 bg-white px-2" {...H(scene === i + 2, { borderRadius: th.radius })}>
              {scene >= i + 2 ? val : ''}
            </span>
          </label>
        ))}
      </div>
      <div className={cx('mt-4 flex', site === 2 && 'justify-end')}>
        <span className="inline-block px-5 py-2 font-bold text-white" {...H(scene === 6, { background: th.brand, borderRadius: th.radius })}>
          {th.submitLabel}
        </span>
      </div>
      {scene <= 1 && (
        <div className="absolute inset-x-3 flex items-center gap-3 bg-neutral-900 p-3 text-white" style={{ borderRadius: th.radius, top: 190 }}>
          <span className="flex-1 text-[11px]">We use cookies to improve your experience.</span>
          <span className="rounded bg-white px-3 py-1 text-[11px] font-bold text-black" {...H(scene === 1)}>
            Accept all
          </span>
        </div>
      )}
    </div>
  )
}
