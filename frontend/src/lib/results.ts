// Turns per-site results into prices, a ranking and the reasons the winner won.
// Works on mock results (unit/total/delivery) and real backend outputs (price/product_name).
import type { RunState, TargetState } from '../store'

export interface Found {
  target: TargetState
  product?: string
  /** Price of one item. */
  unit: number
  /** Price for the requested quantity. */
  total: number
  qty: number
  cur: string
  delivery?: string
  rating?: number
  extras: [string, string][]
  overBudget: boolean
}

const UNIT_KEYS = ['unit', 'price', 'each', 'Price', 'Each']
const TOTAL_KEYS = ['total', 'Total']
const PRODUCT_KEYS = ['product', 'product_name', 'Product', 'title', 'name']
const DELIVERY_KEYS = ['delivery', 'lead', 'Delivery', 'Lead time']
const HIDDEN = /^(site|shop|supplier|status|qty|product_url|url|ref|unit|price|each|total|product|product_name|title|name|delivery|lead|rating|lead time)$/i

export function parseMoney(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v !== 'string') return undefined
  const m = v.replace(/,/g, '').match(/\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : undefined
}

/** The currency a price is written in: '£24.99' / '29.99 GBP' -> '£', 'Rs. 500' -> '₹'; undefined if it doesn't say. */
export function currencyOf(v: unknown): string | undefined {
  const s = String(v ?? '')
  const symbol = s.match(/[£$€₹]/)?.[0]
  if (symbol) return symbol
  const code = s.match(/\b(GBP|USD|EUR|INR|Rs)\b/i)?.[1].toUpperCase()
  return code ? ({ GBP: '£', USD: '$', EUR: '€', INR: '₹', RS: '₹' } as Record<string, string>)[code] : undefined
}

export function money(n: number, cur = '£') {
  return cur + n.toLocaleString('en-GB', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })
}

const pick = (r: Record<string, string | number>, keys: string[]) => {
  for (const k of keys) if (r[k] !== undefined && r[k] !== '') return r[k]
  return undefined
}

export function quantity(run: RunState) {
  return Math.max(1, Number(run.variables.qty ?? run.variables.quantity) || 1)
}

/** Per-item budget from the skill variables or the request ("under £1000"). */
export function budgetOf(run: RunState): { amount: number; cur: string } | undefined {
  // The planner's reading of the message ("under 30 pounds") comes first.
  const planned = run.constraints?.maxPrice
  if (planned) {
    const code = run.constraints?.currency?.toUpperCase()
    return { amount: planned, cur: code === 'USD' || code === '$' ? '$' : code === 'EUR' || code === '€' ? '€' : '£' }
  }
  const raw = run.variables.budget ?? run.prompt.match(/(?:under|below|less than|max(?:imum)?|budget(?: of)?|up to)\s*([£$€]\s?\d[\d,]*(?:\.\d+)?)/i)?.[1]
  const amount = parseMoney(raw)
  if (!raw || amount === undefined) return undefined
  return { amount, cur: raw.match(/[£$€]/)?.[0] ?? '£' }
}

export function foundResults(run: RunState): Found[] {
  const budget = budgetOf(run)
  const qtyAsked = quantity(run)
  const out: Found[] = []
  for (const t of run.targets) {
    if (t.status !== 'ok' || !t.result) continue
    const r = t.result
    const unitRaw = pick(r, UNIT_KEYS)
    const totalRaw = pick(r, TOTAL_KEYS)
    const qty = Number(r.qty) || qtyAsked
    let unit = parseMoney(unitRaw)
    let total = parseMoney(totalRaw)
    if (unit === undefined && total === undefined) continue
    unit ??= total! / qty
    total ??= unit * qty
    const stated = currencyOf(unitRaw ?? totalRaw)
    const cur = stated ?? budget?.cur ?? '£'
    out.push({
      target: t, unit, total, qty, cur,
      product: pick(r, PRODUCT_KEYS)?.toString(),
      delivery: pick(r, DELIVERY_KEYS)?.toString(),
      rating: Number(r.rating) || undefined,
      extras: Object.entries(r).filter(([k, v]) => !HIDDEN.test(k) && v !== '' && v != null).map(([k, v]) => [k.replace(/_/g, ' '), String(v)]),
      // A price in another currency (e.g. Rs. 500 against a £ budget) can't be compared.
      overBudget: budget && (!stated || stated === budget.cur) ? unit > budget.amount : false,
    })
  }
  // Under budget first, then cheapest.
  return out.sort((a, b) => Number(a.overBudget) - Number(b.overBudget) || a.total - b.total)
}

const DAYS: [RegExp, number][] = [[/today|same/i, 0], [/tomorrow|next day|1 day/i, 1]]
function days(s?: string) {
  if (!s) return undefined
  for (const [re, n] of DAYS) if (re.test(s)) return n
  const n = s.match(/(\d+)/)
  if (!n) return /week/i.test(s) ? 7 : undefined
  return Number(n[1]) * (/week/i.test(s) ? 7 : 1)
}

/** Plain reasons, best first. */
export function whyItWon(win: Found, all: Found[], budget?: { amount: number; cur: string }): string[] {
  const out: string[] = []
  const runner = all.find((f) => f !== win)
  if (runner && runner.total > win.total) out.push(`${money(runner.total - win.total, win.cur)} cheaper than ${runner.target.name}`)
  if (budget && !win.overBudget) out.push(`${money(budget.amount - win.unit, win.cur)} under your ${money(budget.amount, budget.cur)} budget`)
  const d = days(win.delivery)
  if (d !== undefined && all.every((f) => f === win || (days(f.delivery) ?? 99) >= d)) out.push(`Fastest delivery, ${win.delivery!.toLowerCase()}`)
  if (win.rating && all.every((f) => (f.rating ?? 0) <= win.rating!)) out.push(`Best rated, ${win.rating.toFixed(1)} stars`)
  if (!runner) out.push('The only site with a price')
  return out.slice(0, 3)
}

/** Which of two values is better for a compare row, or undefined when it can't tell. */
export function better(key: 'unit' | 'total' | 'delivery' | 'rating', a: Found, b: Found): 'a' | 'b' | undefined {
  const pair = key === 'delivery' ? [days(a.delivery), days(b.delivery)] : [a[key], b[key]]
  const [x, y] = pair as (number | undefined)[]
  if (x === undefined || y === undefined || x === y) return undefined
  return (key === 'rating' ? x > y : x < y) ? 'a' : 'b'
}

export interface Added {
  product?: string
  url?: string
  /** The site confirmed the basket changed. */
  confirmed: boolean
}

const NOT_A_PRODUCT = /add(ed)? to (cart|basket|bag)|view product|^products?$|search|cookie|accept|consent|checkout|continue|close|menu|sign in|log ?in/i

/**
 * What a finished site put in the basket, read from its log lines
 * (`Clicked "Blue Jeans" on https://…`, `basket check: True (…)`). Used when the skill
 * doesn't extract a price.
 */
export function addedToBasket(run: RunState, targetId: string): Added {
  let product: string | undefined
  let url: string | undefined
  let confirmed = false
  for (const line of run.logs) {
    if (line.targetId !== targetId) continue
    for (const m of line.message.matchAll(/Clicked "\s*([^"]+?)\s*" on (https?:\/\/\S+)/g)) {
      if (NOT_A_PRODUCT.test(m[1])) {
        if (/view product/i.test(m[1])) url = m[2]
        continue
      }
      product = m[1]
      url = m[2]
    }
    if (/basket check: True/i.test(line.message)) confirmed = true
  }
  return { product, url, confirmed }
}
