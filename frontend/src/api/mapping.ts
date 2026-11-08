import { isRecord } from './backend.ts'
import type { BackendConstraints, BackendSkill, JobFrame } from './backend.ts'
import type { ActivityItem, RecordedAction, RunConstraints, RunEvent, Skill, StepIntent } from './types.ts'

/** The planner's constraints as a view model; undefined when the shopper asked for nothing extra. */
export function constraintsFromBackend(raw: unknown): RunConstraints | undefined {
  if (!isRecord(raw)) return undefined
  const c = raw as BackendConstraints
  const positive = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined)
  const view: RunConstraints = {
    items: Math.max(1, Math.round(positive(c.items) ?? 1)),
    maxPrice: positive(c.max_price), totalBudget: positive(c.total_budget),
    currency: typeof c.currency === 'string' && c.currency ? c.currency : undefined,
    requirements: Array.isArray(c.requirements) ? c.requirements.map(String).filter(Boolean) : [],
  }
  return view.items > 1 || view.maxPrice || view.totalBudget || view.requirements.length ? view : undefined
}

/** The wire shape the run endpoint accepts. */
export function constraintsToBackend(c?: RunConstraints): BackendConstraints | undefined {
  if (!c) return undefined
  return { items: c.items, max_price: c.maxPrice ?? null, total_budget: c.totalBudget ?? null,
    currency: c.currency ?? null, requirements: c.requirements }
}

export function skillFromBackend(skill: BackendSkill): Skill {
  const intents: Record<string, StepIntent> = { navigate_to: 'navigate', search: 'fill', press: 'click' }
  return {
    id: skill.id, name: skill.name || skill.id.replace(/[_-]/g, ' '),
    description: skill.description || skill.goal,
    site: skill.site ?? { url: '', title: '' }, createdAt: skill.created_at ?? '',
    variables: Object.entries(skill.arguments).map(([name, argument]) => ({ name, example: argument.default })),
    steps: skill.steps.map((step, index) => ({ id: `${skill.id}:${index}`,
      intent: intents[step.op] ?? step.op as StepIntent, description: step.target,
      value: step.value ?? undefined, optional: step.optional,
      slot: (step.value ?? step.target).match(/\{\{(\w+)\}\}/)?.[1],
    })),
  }
}

export function recordingAction(frame: JobFrame): RecordedAction | null {
  const data = frame.data
  if (frame.type !== 'recorder' || typeof data.kind !== 'string' || typeof data.url !== 'string') return null
  const element = isRecord(data.el) ? data.el : {}
  const label = String(element.label || element.aria_label || element.placeholder || element.text || element.css || 'element')
  const value = data.value == null ? '' : String(data.value)
  const summary = data.kind === 'navigate' ? `Opened ${data.url}` :
    data.kind === 'click' ? `Clicked “${label}”` :
    data.kind === 'fill' ? `Typed “${value}” into ${label}` :
    data.kind === 'select' ? `Selected “${value}” in ${label}` :
    data.kind === 'press' ? `Pressed ${value} on ${label}` :
    data.kind === 'extract' ? `Captured ${label}` : `Changed ${label} to ${value}`
  return { id: `${frame.job_id}:${frame.seq}`, url: data.url, ts: new Date(frame.t * 1000).toISOString(),
    kind: data.kind === 'navigate' ? 'navigate' : data.kind === 'click' ? 'click' : data.kind === 'press' ? 'submit' : 'change', summary }
}

// ---------- readable activity ----------
// Every function below rewords an event the backend actually sent. Nothing is inferred
// beyond what the message says; the original wording stays available as `raw`.

const VERB: Record<string, string> = {
  navigate_to: 'go to', search: 'search', click: 'click', click_text: 'click', fill: 'fill in',
  select: 'choose', check: 'set', press: 'press', verify: 'check', extract: 'read',
}
const verb = (op: string) => VERB[op] ?? op.replace(/_/g, ' ')
const sentence = (text: string) => {
  const t = text.trim()
  return t ? t[0].toUpperCase() + t.slice(1) : t
}
const clip = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** Fill a skill's {{variable}} placeholders with the inputs the planner chose. An empty input is a
 *  personal choice (e.g. size) the shopper hasn't given yet; the agent asks for it if a site needs it. */
/** run.py's "shopper chose size = 14 for this product" (the suffix marks a per-product answer). */
const CHOSE = /^shopper chose (\w+) = ([\s\S]*?)( for this product)?$/

/**
 * Answers that hold for one product on one site only (mirrors PER_ITEM_FIELD in run.py): sizes are
 * labelled differently from shop to shop, so they are never passed on and each product asks again.
 */
export const perItemChoice = (field: string) => /size|waist|length|leg|inseam|cup|width|fit/i.test(field)

export function render(text: string, vars: Record<string, string> = {}) {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => vars[name] === '' ? '(you choose)' : vars[name] ?? whole)
}

const stepTarget = (skill: Skill, index: number, vars?: Record<string, string>) =>
  skill.steps[index] ? render(skill.steps[index].description, vars) : `step ${index + 1}`

/** Turn a backend SiteResult.error string into a sentence; unknown shapes pass through. */
export function describeError(error: string): string {
  let m = error.match(/^step \d+ \((\w+) '(.*)'\): (\w+) - ([\s\S]*)$/)
  if (m) return `Couldn’t ${verb(m[1])} ${m[2]}: ${m[4].trim() || m[3].replace(/_/g, ' ')}`
  m = error.match(/^step (\d+) made no progress after (\d+) attempts \(([\s\S]*)\)$/)
  if (m) return `Step ${Number(m[1]) + 1} made no progress after ${m[2]} attempts${m[3] ? `: ${m[3]}` : ''}`
  m = error.match(/^item was not added to the basket \(([\s\S]*)\)$/)
  if (m) return `The item didn’t reach the basket: ${m[1]}`
  m = error.match(/^verify failed: ([\s\S]*)$/)
  if (m) return `Couldn’t confirm ${m[1]}`
  m = error.match(/^refused forbidden (?:element|text): ([\s\S]*)$/)
  if (m) return `Stopped before a restricted action (${clip(m[1], 60)})`
  return error
}

function describeAction(data: Record<string, unknown>): string {
  const element = isRecord(data.element) ? data.element : {}
  const label = clip(String(['label', 'aria', 'text', 'title', 'ph', 'name'].map((key) => element[key]).find(Boolean) ?? data.target ?? 'element').trim(), 60)
  const value = data.value == null ? '' : clip(String(data.value), 60)
  const op = String(data.op)
  const text = {
    click: `Clicked “${label}”`,
    click_text: `Clicked “${value || label}”`,
    navigate_to: `Clicked “${label}” to reach ${data.target ?? 'the next page'}`,
    search: `Searched for “${value}” using “${label}”`,
    fill: `Entered “${value}” in “${label}”`,
    select: `Selected “${value}” in “${label}”`,
    check: `Set “${label}” to “${value}”`,
    press: `Pressed ${value} on “${label}”`,
  }[op] ?? `Performed ${op.replace(/_/g, ' ')} on “${label}”`
  const repeat = typeof data.repeat === 'number' && data.repeat > 1 && typeof data.repetition === 'number' ? ` (${data.repetition} of ${data.repeat})` : ''
  return text + repeat
}

type Described = { text: string; tone: ActivityItem['tone']; step?: number; stepStatus?: 'running' | 'ok' | 'failed' | 'skipped' }

function describeAgent(kind: string, message: string, detail: Record<string, unknown>, skill: Skill, vars?: Record<string, string>): Described {
  const target = (index: number) => stepTarget(skill, index, vars)
  const step = Number.isInteger(detail.step) ? Number(detail.step) : undefined
  let m: RegExpMatchArray | null

  if (kind === 'status') {
    if (message === 'acting') return { text: detail.cached ? 'Page open. Reusing saved matches from an earlier run on this site.' : 'Page open. Matching each step to this site.', tone: 'info' }
    if (message === 'done') return { text: 'All steps finished.', tone: 'ok' }
    if (message === 'needs_human') return { text: `Needs your attention: ${String(detail.reason || 'the agent cannot continue on its own')}`, tone: 'warn' }
    if (message === 'needs_input') return { text: `Asking you: ${String(detail.question || 'a choice is needed')}`, tone: 'warn' }
    return { text: sentence(message.replace(/_/g, ' ')), tone: 'info' }
  }
  if (kind === 'error') return { text: describeError(message), tone: 'error' }

  if ((m = message.match(/^\[(\d+)\] (\w+) replayed from cache$/))) {
    const index = Number(m[1])
    return { text: `Reused a saved match to ${verb(m[2])} ${target(index)}`, tone: 'ok', step: index, stepStatus: 'ok' }
  }
  if ((m = message.match(/^\[(\d+)\] (\w+)(?: x\d+)? -> (\w+) \[(?:None|-?\d+|'[\s\S]*?'|"[\s\S]*?")\] ?([\s\S]*)$/))) {
    const [index, op, status, reason] = [Number(m[1]), m[2], m[3], m[4].trim()]
    const what = `${verb(op)} ${target(index)}`
    const described: Record<string, Described> = {
      ok: { text: sentence(reason || what), tone: 'plan', step: index, stepStatus: 'running' },
      partial: { text: sentence(reason || what), tone: 'plan', step: index, stepStatus: 'running' },
      move: { text: `Going to another page first${reason ? `: ${reason}` : ''}`, tone: 'plan', step: index, stepStatus: 'running' },
      already_done: { text: `Already done: ${reason || target(index)}`, tone: 'ok', step: index, stepStatus: 'ok' },
      not_found: { text: `Couldn’t find ${target(index)}${reason ? `: ${reason}` : ''}`, tone: 'warn', step: index, stepStatus: 'running' },
      needs_input: { text: `The page needs a choice${reason ? `: ${reason}` : ''}`, tone: 'warn', step: index, stepStatus: 'running' },
      needs_human: { text: `Needs a person${reason ? `: ${reason}` : ''}`, tone: 'warn', step: index, stepStatus: 'running' },
    }
    return described[status] ?? { text: sentence(message), tone: 'info', step: index, stepStatus: 'running' }
  }
  if ((m = message.match(/^verify '([\s\S]*)': (True|False|None) \(([\s\S]*)\)$/))) {
    const passed = m[2] === 'True'
    return { text: `${passed ? 'Confirmed' : 'Couldn’t confirm'} ${m[1]}${m[3] && m[3] !== 'None' ? ` — ${m[3]}` : ''}`,
      // runEvents marks a failed required check as failed; an optional one does not fail the site.
      tone: passed ? 'ok' : 'warn', step, stepStatus: passed ? 'ok' : 'running' }
  }
  if ((m = message.match(/^basket check: (True|False) \(([\s\S]*)\)$/))) {
    const passed = m[1] === 'True'
    // The basket check is extra evidence for the add step; it does not change step ticks.
    return { text: `${passed ? 'Basket check passed' : 'Basket check didn’t see the item yet'}${m[2] && m[2] !== 'None' ? ` — ${m[2]}` : ''}`, tone: passed ? 'ok' : 'warn' }
  }
  if (/^extract /.test(message) && isRecord(detail.outputs)) {
    const keys = Object.keys(detail.outputs)
    return { text: `Captured ${keys.length ? keys.map((key) => key.replace(/_/g, ' ')).join(', ') : 'page details'}`, tone: 'ok', step, stepStatus: 'ok' }
  }
  if ((m = message.match(/^cache miss at step (\d+)/))) {
    return { text: `Saved match didn’t fit here; asking the model to find ${target(Number(m[1]))}`, tone: 'info', step: Number(m[1]), stepStatus: 'running' }
  }
  // These two messages carry the step only in their text.
  if ((m = message.match(/^skipped (?:intermediate )?verify (\d+)(?: \(([^)]*)\))?/))) {
    return { text: `Skipped the check “${target(Number(m[1]))}”${m[2] ? ` (${m[2]})` : ''}`, tone: 'info', step: Number(m[1]), stepStatus: 'skipped' }
  }
  if ((m = message.match(/^skipped optional step (\d+)/))) {
    return { text: `Skipped optional step: ${target(Number(m[1]))}`, tone: 'info', step: Number(m[1]), stepStatus: 'skipped' }
  }
  // The shopper's answers and the budget / item-count checks (run.py).
  if ((m = message.match(CHOSE))) return { text: `You chose ${m[1].replace(/_/g, ' ')}: ${m[2]}${m[3] ? ' (this product only)' : ''}`, tone: 'ok' }
  if ((m = message.match(/^product rejected: ([\s\S]*?) - ([\s\S]*)$/))) return { text: `Skipped ${m[1]}: ${m[2]}`, tone: 'warn' }
  if ((m = message.match(/^product check passed: ([\s\S]*?)(?: - ([\s\S]*))?$/))) return { text: `Picked ${m[1]}${m[2] ? ` (${m[2]})` : ''}`, tone: 'ok' }
  if (/^item \d+ of \d+ in the basket: /.test(message)) return { text: sentence(message), tone: 'ok' }
  if (/^(stopped looking after|this skill has no product-choosing step)/.test(message)) return { text: sentence(message), tone: 'warn' }
  return { text: sentence(message), tone: 'info' }
}

/** Wire facts become existing view events; a model plan alone never completes an action. */
export function runEvents(frame: JobFrame, skill: Skill, targetId?: string, vars?: Record<string, string>): RunEvent[] {
  const data = frame.data
  const ts = new Date(frame.t * 1000).toISOString()
  const id = `${frame.job_id}:${frame.channel}:${frame.seq}`
  if (frame.type === 'log' && typeof data.message === 'string') return [{ type: 'log', id, targetId, ts, message: data.message,
    partial: data.partial === true, source: 'console', jobId: frame.job_id,
    level: data.level === 'warning' ? 'warn' : data.level === 'error' ? 'error' : data.level === 'debug' ? 'debug' : 'info' }]
  if (frame.type === 'llm.start' || frame.type === 'llm.delta') {
    if (typeof data.call_id !== 'string') return []
    return [{ type: 'model', id: `${frame.job_id}:${data.call_id}:${data.attempt}`, targetId,
      tag: String(data.tag || 'model'), ts, text: typeof data.text === 'string' ? data.text : '', reset: frame.type === 'llm.start' }]
  }
  if (frame.type === 'llm.retry' || frame.type === 'llm.error') return [{ type: 'log', id, targetId, ts,
    level: frame.type === 'llm.retry' ? 'warn' : 'error', message: frame.type === 'llm.retry' ?
      `Gemini ${String(data.tag)}: retrying after ${String(data.code)}` : `Gemini ${String(data.tag)}: ${String(data.code)}` }]
  if (!targetId) return []

  if (frame.type === 'action' && Number.isInteger(data.step)) {
    const index = Number(data.step)
    const url = typeof data.url === 'string' ? data.url : undefined
    const text = describeAction(data)
    const activity: RunEvent = { type: 'activity', targetId, item: { id, ts, text, tone: 'ok', url,
      raw: `action ${String(data.op)} step ${index}${data.value != null ? ` value=${JSON.stringify(data.value)}` : ''}${url ? ` @ ${url}` : ''}` } }
    if (index < 0 || index >= skill.steps.length) return []
    const complete = !data.navigation_hop && !data.partial &&
      (typeof data.repeat !== 'number' || typeof data.repetition !== 'number' || data.repetition >= data.repeat)
    return [{ type: 'step', targetId, stepIndex: index, status: complete ? 'ok' : 'running', tier: complete ? 'complete' : undefined, description: text }, activity]
  }

  if (frame.type === 'agent') {
    const detail = isRecord(data.data) ? data.data : {}
    const kind = typeof data.kind === 'string' ? data.kind : ''
    const message = typeof data.message === 'string' ? data.message : ''
    const described = describeAgent(kind, message, detail, skill, vars)
    const events: RunEvent[] = []
    if (kind === 'status' && message === 'acting') events.push({ type: 'browser', targetId, status: 'opened', url: String(data.site || '') })
    let index = described.step
    let status = described.stepStatus
    if (index === undefined && Number.isInteger(detail.step)) {
      // Unrecognised wording with a step index: keep the generic meaning of its data.
      index = Number(detail.step)
      status = detail.cached === true || /-> already_done\b/.test(message) || isRecord(detail.outputs) ? 'ok' : /skipped/.test(message) ? 'skipped' : 'running'
    }
    // A failed check on a required step fails the site (the agent raises right after it).
    if (index !== undefined && /^verify .*: False \(/s.test(message) && !skill.steps[index]?.optional) status = 'failed'
    if (index !== undefined && index >= 0 && index < skill.steps.length && status) {
      events.push({ type: 'step', targetId, stepIndex: index, status,
        tier: status === 'ok' ? 'complete' : undefined, description: described.text })
    }
    // AgentEvent.kind is always one of these; anything else is not a real agent event.
    if (['log', 'status', 'step', 'error', 'done'].includes(kind)) {
      events.push({ type: 'activity', targetId, item: { id, ts, text: described.text, tone: described.tone,
        raw: `[${kind}] ${message}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}` } })
    }
    if (kind === 'status' && message === 'needs_human' && typeof detail.reason === 'string') {
      events.push({ type: 'attention', targetId, question: detail.reason,
        options: Array.isArray(detail.options) ? detail.options.map(String) : [] })
    }
    // The run is paused until the shopper answers (only sent when the backend can wait for one).
    if (kind === 'status' && message === 'needs_input') {
      const field = typeof detail.field === 'string' && detail.field ? detail.field : 'choice'
      events.push({ type: 'question', targetId, field,
        question: typeof detail.question === 'string' && detail.question ? detail.question : `Which ${field.replace(/_/g, ' ')} would you like?`,
        options: Array.isArray(detail.options) ? detail.options.map(String) : [] })
    }
    const chose = kind === 'log' ? message.match(CHOSE) : null
    if (chose) events.push({ type: 'answered', targetId, field: chose[1], value: chose[2], perItem: !!chose[3] || perItemChoice(chose[1]) })
    return events
  }
  return []
}
