// Synthetic supplier pages drawn in the mini browser while the mock agent runs.
// With the real backend, the window shows `frame` screenshots instead.
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

export function SimPage({
  kind,
  site,
  name,
  scene,
  ring,
  vars,
  done,
}: {
  kind: 'shop' | 'quote'
  site: number
  name: string
  scene: number
  ring: string
  vars: Record<string, string>
  done: boolean
}) {
  const th = (kind === 'shop' ? SHOP_THEMES : QUOTE_THEMES)[site % 3]
  const R = (on: boolean) =>
    on && !done ? { outline: `2.5px solid ${ring}`, outlineOffset: 2, boxShadow: `0 0 0 7px color-mix(in srgb, ${ring} 22%, transparent)`, transition: 'outline-color .3s' } : undefined

  return (
    <div className="h-[300px] w-[480px] overflow-hidden text-[12px]" style={{ background: th.bg, color: th.ink, fontFamily: th.font }}>
      <div className="flex h-10 items-center gap-3 px-4" style={{ background: th.brand, color: site === 0 && kind === 'shop' ? '#111' : '#fff' }}>
        <b className="text-[14px] tracking-tight">{name}</b>
        {kind === 'shop' && (
          <div
            className="ml-auto flex h-6 w-52 items-center rounded bg-white px-2 text-[11px] text-neutral-800"
            style={{ borderRadius: th.radius, ...R(scene === 1) }}
          >
            {scene >= 1 ? vars.product ?? 'laptop' : <span className="text-neutral-400">Search</span>}
            {scene === 1 && !done && <span className="ml-px h-3 w-px animate-caret bg-neutral-800" />}
          </div>
        )}
        {kind === 'quote' && <span className="ml-auto text-[11px] opacity-80">Trade · Quotes · Contact</span>}
      </div>
      {kind === 'shop' ? <Shop th={th} scene={scene} R={R} vars={vars} site={site} done={done} /> : <Quote th={th} scene={scene} R={R} vars={vars} done={done} />}
    </div>
  )
}

type RFn = (on: boolean) => React.CSSProperties | undefined

function Skel({ w, h = 10, className }: { w: number | string; h?: number; className?: string }) {
  return <div className={cx('rounded bg-black/8', className)} style={{ width: w, height: h }} />
}

function Shop({ th, scene, R, vars, site, done }: { th: Theme; scene: number; R: RFn; vars: Record<string, string>; site: number; done: boolean }) {
  const budget = Number((vars.budget ?? '£1000').replace(/[^\d.]/g, '')) || 1000
  // Same unit price and model the mock agent reports for this site.
  const chosen = { name: `${['Nimbus 14 Pro', 'Aero Book S', 'Lumen 15 Air'][site % 3]} ${vars.product ?? ''}`.trim(), price: Math.round(budget * [0.94, 0.86, 0.91][site % 3]) }
  const items = [1.18, 0, 1.05, 1.3].map((f, i) =>
    i === 1 ? chosen : { name: `${['Vale', '', 'Orbit', 'Summit'][i]} ${vars.product ?? 'item'}`, price: Math.round(budget * f) },
  )
  const pick = 1
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
        <div className="mb-3 flex items-center gap-2 text-[11px]">
          <span className="opacity-60">{scene >= 2 ? `${items.length * 31} results` : 'Popular'}</span>
          <span className="ml-auto rounded border border-black/15 px-2 py-0.5" style={{ borderRadius: th.radius, ...R(scene === 2) }}>
            Price: low to high
          </span>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {items.map((it, i) => (
            <div key={i} className="space-y-1.5 bg-white p-1.5" style={{ borderRadius: th.radius, ...R(scene === 3 && i === pick) }}>
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
      <div className="flex gap-4 p-4">
        <div className="h-[200px] w-[180px] rounded" style={{ background: `color-mix(in srgb, ${th.brand} 22%, #e9e9e9)`, borderRadius: th.radius }} />
        <div className="flex-1 space-y-2.5">
          <b className="block text-[15px]">{items[pick].name}</b>
          <div className="text-[18px] font-bold">£{items[pick].price}</div>
          <Skel w="90%" />
          <Skel w="70%" />
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[11px] opacity-70">Qty</span>
            <span className="grid h-7 w-12 place-items-center border border-black/20 bg-white" style={{ borderRadius: th.radius, ...R(scene === 4) }}>
              {scene >= 4 ? (vars.qty ?? 1) : 1}
            </span>
          </div>
          <span
            className="inline-block px-4 py-2 font-bold"
            style={{ background: th.brand, color: site === 0 ? '#111' : '#fff', borderRadius: th.radius, ...R(scene === 5) }}
          >
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
        <span className="flex-1">{items[pick].name}</span>
        <span>× {qty}</span>
        <b>£{(items[pick].price * qty).toLocaleString('en-GB')}</b>
      </div>
      <div className="mt-4 flex items-center">
        <span className="opacity-60">Delivery free</span>
        <span
          className="ml-auto px-5 py-2 font-bold"
          style={{ background: th.brand, color: site === 0 ? '#111' : '#fff', borderRadius: th.radius, ...R(scene === 6) }}
        >
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

function Quote({ th, scene, R, vars, done }: { th: Theme; scene: number; R: RFn; vars: Record<string, string>; done: boolean }) {
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
        </div>
      </div>
    )
  return (
    <div className="relative p-4">
      <b className="text-[15px]">Request a trade quote</b>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
        {fields.map(([label, val], i) => (
          <label key={label} className="block">
            <span className="mb-1 block text-[10.5px] opacity-70">{label}</span>
            <span className="flex h-7 items-center border border-black/20 bg-white px-2" style={{ borderRadius: th.radius, ...R(scene === i + 2) }}>
              {scene > i + 2 || scene === i + 2 ? val : ''}
            </span>
          </label>
        ))}
      </div>
      <span className="mt-4 inline-block px-5 py-2 font-bold text-white" style={{ background: th.brand, borderRadius: th.radius, ...R(scene === 6) }}>
        {th.submitLabel}
      </span>
      {scene <= 1 && (
        <div className="absolute inset-x-3 bottom-[-150px] flex items-center gap-3 bg-neutral-900 p-3 text-white" style={{ borderRadius: th.radius, top: 190 }}>
          <span className="flex-1 text-[11px]">We use cookies to improve your experience.</span>
          <span className="rounded bg-white px-3 py-1 text-[11px] font-bold text-black" style={R(scene === 1)}>
            Accept all
          </span>
        </div>
      )}
    </div>
  )
}
