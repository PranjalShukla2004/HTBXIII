// In-browser fake of the agent backend so the UI can be built and demoed
// before the Playwright side exists. Skills persist in localStorage.
import type {
  AgentApi,
  RecordedAction,
  RunEvent,
  RunTarget,
  Skill,
  SkillDraft,
  Step,
  Tier,
} from './types'

const KEY = 'copycat.mock.skills.v1'
const uid = () => Math.random().toString(36).slice(2, 10)
const now = () => new Date().toISOString()

const SEED: Skill[] = [
  {
    id: 'sk_quote',
    name: 'Supplier quote',
    description: 'Fill a supplier’s quote form with product, quantity, delivery date and email, then submit.',
    site: { url: 'http://localhost:5173/northwind', title: 'Northwind Supply' },
    createdAt: new Date(Date.now() - 1000 * 60 * 42).toISOString(),
    runs: 3,
    variables: [
      { name: 'product', example: 'Ergonomic office chair' },
      { name: 'qty', example: '500' },
      { name: 'delivery_date', example: '2026-12-01' },
      { name: 'email', example: 'buyer+northwind@demo.local' },
    ],
    steps: [
      { id: 's1', intent: 'navigate', description: 'Open the supplier’s quote page' },
      { id: 's2', intent: 'click', description: 'Dismiss the cookie banner', action_type: 'dismiss_popup', optional: true },
      { id: 's3', intent: 'select', description: 'Choose the product', action_type: 'field.product', slot: 'product', value: '{{product}}' },
      { id: 's4', intent: 'fill', description: 'Enter the quantity', action_type: 'field.quantity', slot: 'qty', value: '{{qty}}' },
      { id: 's5', intent: 'fill', description: 'Set the delivery date', action_type: 'field.delivery_date', slot: 'delivery_date', value: '{{delivery_date}}' },
      { id: 's6', intent: 'fill', description: 'Enter the contact email', action_type: 'field.email', slot: 'email', value: '{{email}}' },
      { id: 's7', intent: 'click', description: 'Submit the quote request', action_type: 'submit_quote' },
    ],
  },
  {
    id: 'sk_shop',
    name: 'Shopping',
    description: 'Search for a product, pick the best match within budget, set the quantity and add it to the basket.',
    site: { url: 'http://localhost:5173/voltmart', title: 'VoltMart' },
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
    runs: 1,
    variables: [
      { name: 'product', example: 'laptop' },
      { name: 'qty', example: '2' },
      { name: 'budget', example: '£800' },
    ],
    steps: [
      { id: 'h1', intent: 'navigate', description: 'Open the shop' },
      { id: 'h2', intent: 'fill', description: 'Search for the product', action_type: 'field.search', slot: 'product', value: '{{product}}' },
      { id: 'h3', intent: 'click', description: 'Sort or filter by price', action_type: 'sort_price', optional: true },
      { id: 'h4', intent: 'click', description: 'Open the best result under budget', action_type: 'open_result', slot: 'budget' },
      { id: 'h5', intent: 'fill', description: 'Set the quantity', action_type: 'field.quantity', slot: 'qty', value: '{{qty}}' },
      { id: 'h6', intent: 'click', description: 'Add it to the basket', action_type: 'add_to_basket' },
      { id: 'h7', intent: 'click', description: 'Go to checkout and stop before paying', action_type: 'checkout' },
    ],
  },
]

function load(): Skill[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as Skill[]
  } catch {
    /* ignore */
  }
  return SEED
}
function persist(s: Skill[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}
let skills = load()

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* ---------------- Recording ---------------- */

const QUOTE_SCRIPT: Omit<RecordedAction, 'id' | 'ts' | 'url'>[] = [
  { kind: 'navigate', summary: 'Opened Northwind Supply · Request a quote' },
  { kind: 'click', summary: 'Clicked “Accept cookies”' },
  { kind: 'change', summary: 'Chose “Steel bracket, 40mm” in Product' },
  { kind: 'change', summary: 'Typed “500” into Quantity' },
  { kind: 'change', summary: 'Picked 1 Dec 2026 in Delivery date' },
  { kind: 'change', summary: 'Typed “buyer@demo.local” into Work email' },
  { kind: 'click', summary: 'Clicked “Request quote”' },
  { kind: 'submit', summary: 'Form submitted · “Thanks, your quote is on its way”' },
]
const SHOP_SCRIPT: Omit<RecordedAction, 'id' | 'ts' | 'url'>[] = [
  { kind: 'navigate', summary: 'Opened the shop homepage' },
  { kind: 'change', summary: 'Typed “headphones” into Search' },
  { kind: 'click', summary: 'Clicked “Price: low to high”' },
  { kind: 'click', summary: 'Opened “Aria Wireless Headphones · £79”' },
  { kind: 'change', summary: 'Set Qty to 2' },
  { kind: 'click', summary: 'Clicked “Add to basket”' },
  { kind: 'click', summary: 'Clicked “Checkout”' },
]

const recordings = new Map<string, { url: string; script: typeof QUOTE_SCRIPT; timer?: number; emitted: number }>()

function isShop(url: string) {
  return /shop|store|mart|cart|amazon|ebay|argos|currys/i.test(url)
}

/* ---------------- Runs ---------------- */

const runs = new Map<string, { stopped: boolean; listeners: Set<(e: RunEvent) => void>; backlog: RunEvent[] }>()

function extractVars(prompt: string, skill: Skill): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const v of skill.variables) vars[v.name] = v.example
  const qty = prompt.match(/(\d[\d,]*)\s+(?:x\s+)?((?:(?!by\b|each\b|under\b|for\b|with\b|at\b|from\b)[a-z][a-z-]*\s*){1,3})/i)
  if (qty) {
    vars.qty = qty[1].replace(/,/g, '')
    if ('product' in vars) vars.product = qty[2].trim().replace(/s$/, '')
  }
  const money = prompt.match(/[£$€]\s?\d[\d,]*(?:\.\d+)?/)
  if (money && 'budget' in vars) vars.budget = money[0].replace(/\s/g, '')
  const date = prompt.match(/\b(by|before)\s+([A-Z0-9][\w ]{2,20})/i)
  if (date && 'delivery_date' in vars) vars.delivery_date = date[2].trim()
  return vars
}

function targetsFor(skill: Skill): RunTarget[] {
  if (skill.id === 'sk_shop' || isShop(skill.site.url)) {
    return [
      { id: 't1', name: 'VoltMart', url: 'http://localhost:5173/voltmart' },
      { id: 't2', name: 'Parcel & Pixel', url: 'http://localhost:5173/parcel' },
      { id: 't3', name: 'Laptop Barn', url: 'http://localhost:5173/barn' },
    ]
  }
  return [
    { id: 't1', name: 'Brackett & Co', url: 'http://localhost:5173/brackett' },
    { id: 't2', name: 'Ferro Direct', url: 'http://localhost:5173/ferro' },
    { id: 't3', name: 'Northwind Supply', url: 'http://localhost:5173/northwind' },
  ]
}

const TIER_PLAN: Tier[][] = [
  ['exact', 'synonym', 'exact', 'synonym', 'exact', 'synonym', 'synonym', 'exact'],
  ['exact', 'synonym', 'fuzzy', 'synonym', 'exact', 'heal', 'synonym', 'exact'],
  ['exact', 'exact', 'exact', 'exact', 'exact', 'exact', 'exact', 'exact'],
]

async function simulateRun(runId: string, skillIds: string[], prompt: string) {
  const r = runs.get(runId)!
  const emit = (e: RunEvent) => {
    r.backlog.push(e)
    r.listeners.forEach((l) => l(e))
  }
  const log = (message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info', targetId?: string) =>
    emit({ type: 'log', level, message, targetId, ts: now() })

  const skill = skills.find((s) => s.id === skillIds[0]) ?? skills[0]
  const shop = skill.id === 'sk_shop' || isShop(skill.site.url)
  await wait(400)
  log(`Loaded skill “${skill.name}” (${skill.steps.length} steps)`)
  log('Mapping the request onto skill variables…', 'debug')
  await wait(800)
  const vars = extractVars(prompt, skill)
  const targets = targetsFor(skill)
  emit({
    type: 'plan',
    summary: shop
      ? `${vars.qty ?? '1'} × ${vars.product ?? 'item'}${vars.budget ? `, under ${vars.budget} each` : ''}`
      : `Quote for ${vars.qty ?? '?'} × ${vars.product ?? 'item'}`,
    variables: vars,
    targets,
  })
  log(`Variables: ${JSON.stringify(vars)}`, 'debug')

  // Sites run in parallel, staggered, like three Playwright contexts.
  const runTarget = async (t: RunTarget, ti: number) => {
    await wait(ti * 1100)
    if (r.stopped) return null
    emit({ type: 'target_start', targetId: t.id, totalSteps: skill.steps.length })
    emit({ type: 'browser', targetId: t.id, status: 'opened', url: t.url })
    log(`Chromium context opened → ${t.url}`, 'info', t.id)
    for (const [si, step] of skill.steps.entries()) {
      if (r.stopped) return null
      emit({ type: 'step', targetId: t.id, stepIndex: si, description: describe(step, vars), status: 'running' })
      await wait(900 + Math.random() * 700)
      const tier = TIER_PLAN[ti % 3][si % 8]
      log(`aria_snapshot: ${18 + Math.floor(Math.random() * 30)} interactive nodes`, 'debug', t.id)
      if (step.optional && ti === 2) {
        emit({ type: 'step', targetId: t.id, stepIndex: si, description: describe(step, vars), status: 'skipped' })
        log(`Optional step “${step.description}” not needed`, 'debug', t.id)
        continue
      }
      if (tier === 'heal') {
        log(`No tier matched ${step.action_type ?? step.intent}; verifier rejected fuzzy candidate`, 'warn', t.id)
        await wait(900)
        const phrase = shop ? 'Pop it in the bag' : 'Get my price'
        emit({
          type: 'heal',
          targetId: t.id,
          stepIndex: si,
          message: `Learned “${phrase}”`,
          learned: { action_type: step.action_type ?? 'unknown', phrase },
        })
        log(`Self-heal → element 14 “${phrase}”. Added to synonym library.`, 'info', t.id)
      } else {
        log(`${tier.toUpperCase()} match for ${step.action_type ?? step.intent}`, 'debug', t.id)
      }
      emit({ type: 'step', targetId: t.id, stepIndex: si, description: describe(step, vars), status: 'ok', tier })
    }
    await wait(700)
    const res = shop ? shopResult(t, vars, ti) : quoteResult(t, vars, ti)
    emit({ type: 'target_done', targetId: t.id, status: 'ok', result: res })
    emit({ type: 'browser', targetId: t.id, status: 'closed', url: t.url })
    return res
  }
  const settled = await Promise.all(targets.map(runTarget))
  if (r.stopped) {
    emit({ type: 'error', message: 'Stopped.' })
    return
  }
  const results = settled.filter(Boolean) as Record<string, string | number>[]

  await wait(400)
  const table = shop
    ? {
        columns: ['Shop', 'Product', 'Each', 'Total'],
        rows: results.map((x) => [x.shop, x.product, x.unit, x.total]),
      }
    : {
        columns: ['Supplier', 'Each', 'Total', 'Lead time'],
        rows: results.map((x) => [x.supplier, x.unit, x.total, x.lead]),
      }
  const totals = results.map((x) => Number(String(x.total).replace(/[^\d.]/g, '')))
  const best = totals.indexOf(Math.min(...totals))
  skill.runs = (skill.runs ?? 0) + 1
  persist(skills)
  emit({
    type: 'done',
    summary: shop ? 'Stopped at checkout. Nothing paid.' : 'Quotes in. Reply drafted.',
    table: { ...table, bestRow: best },
    needsApproval: shop ? `Order from ${results[best].shop}` : `Reply to ${results[best].supplier}`,
  })
}

function describe(step: Step, vars: Record<string, string>) {
  if (!step.slot || !vars[step.slot]) return step.description
  return `${step.description} · ${vars[step.slot]}`
}

const gbp = (n: number) => '£' + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function shopResult(t: RunTarget, v: Record<string, string>, i: number) {
  const budget = Number((v.budget ?? '£1000').replace(/[^\d.]/g, '')) || 1000
  const unit = Math.round(budget * [0.94, 0.86, 0.91][i] * 100) / 100
  const qty = Number(v.qty ?? 1)
  const names = ['Nimbus 14 Pro', 'Aero Book S', 'Lumen 15 Air']
  return { shop: t.name, product: `${names[i]} ${v.product ?? ''}`.trim(), unit: gbp(unit), qty, total: gbp(unit * qty) }
}
function quoteResult(t: RunTarget, v: Record<string, string>, i: number) {
  const qty = Number(v.qty ?? 500)
  const unit = [4.2, 3.85, 4.6][i]
  return {
    supplier: t.name,
    unit: gbp(unit),
    total: gbp(unit * qty),
    lead: ['10 days', '14 days', '7 days'][i],
    ref: ['BR-' + uid().slice(0, 5), 'FD-' + uid().slice(0, 5), 'NW-' + uid().slice(0, 5)][i].toUpperCase(),
  }
}

/* ---------------- API surface ---------------- */

export const mockApi: AgentApi = {
  async listSkills() {
    await wait(150)
    return [...skills]
  },
  async saveSkill(draft: SkillDraft) {
    const s: Skill = { ...draft, id: 'sk_' + uid(), createdAt: now(), runs: 0 }
    skills = [s, ...skills]
    persist(skills)
    return s
  },
  async deleteSkill(id) {
    skills = skills.filter((s) => s.id !== id)
    persist(skills)
  },

  async startRecording(startUrl) {
    await wait(600)
    const id = 'rec_' + uid()
    recordings.set(id, { url: startUrl, script: isShop(startUrl) ? SHOP_SCRIPT : QUOTE_SCRIPT, emitted: 0 })
    return { sessionId: id }
  },
  onRecordingEvents(id, cb) {
    const rec = recordings.get(id)
    if (!rec) return () => {}
    rec.timer = window.setInterval(() => {
      const next = rec.script[rec.emitted]
      if (!next) return
      rec.emitted += 1
      cb({ type: 'action', action: { ...next, id: uid(), ts: now(), url: rec.url } })
    }, 1700)
    return () => window.clearInterval(rec.timer)
  },
  async stopRecording(id) {
    const rec = recordings.get(id)
    if (rec?.timer) window.clearInterval(rec.timer)
    recordings.delete(id)
    await wait(1400) // "compiling intents"
    const base = rec && isShop(rec.url) ? SEED[1] : SEED[0]
    let host = 'site'
    try {
      host = new URL(rec?.url ?? '').hostname || host
    } catch {
      /* ignore */
    }
    return {
      name: '',
      description: base.description,
      site: { url: rec?.url ?? base.site.url, title: host },
      steps: base.steps.map((s) => ({ ...s, id: uid() })),
      variables: base.variables,
    }
  },
  async cancelRecording(id) {
    recordings.delete(id)
  },

  async startRun({ skillIds, prompt }) {
    const runId = 'run_' + uid()
    runs.set(runId, { stopped: false, listeners: new Set(), backlog: [] })
    void simulateRun(runId, skillIds, prompt)
    return { runId }
  },
  onRunEvents(runId, cb) {
    const r = runs.get(runId)
    if (!r) return () => {}
    r.backlog.forEach(cb)
    r.listeners.add(cb)
    return () => r.listeners.delete(cb)
  },
  async stopRun(runId) {
    const r = runs.get(runId)
    if (r) r.stopped = true
  },
}
