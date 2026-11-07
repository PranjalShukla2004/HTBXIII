import { isRecord } from './backend.ts'
import type { BackendSkill, JobFrame } from './backend.ts'
import type { RecordedAction, RunEvent, Skill, StepIntent } from './types.ts'

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

/** Wire facts become existing view events; a model plan alone never completes an action. */
export function runEvents(frame: JobFrame, skill: Skill, targetId?: string): RunEvent[] {
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
    if (index < 0 || index >= skill.steps.length) return []
    const complete = !data.navigation_hop && !data.partial &&
      (typeof data.repeat !== 'number' || typeof data.repetition !== 'number' || data.repetition >= data.repeat)
    return [{ type: 'step', targetId, stepIndex: index, status: complete ? 'ok' : 'running', tier: complete ? 'complete' : undefined,
      description: skill.steps[index].description + (data.value ? ` · ${String(data.value)}` : '') }]
  }
  if (frame.type === 'agent') {
    const detail = isRecord(data.data) ? data.data : {}
    if (data.kind === 'status' && data.message === 'acting') return [{ type: 'browser', targetId, status: 'opened', url: String(data.site || '') }]
    const message = typeof data.message === 'string' ? data.message : ''
    if (!Number.isInteger(detail.step)) return []
    const index = Number(detail.step)
    if (!Number.isInteger(index) || index < 0 || index >= skill.steps.length) return []
    if (message.includes('skipped')) return [{ type: 'step', targetId, stepIndex: index, status: 'skipped', description: skill.steps[index].description }]
    const verified = /^verify .*: True \(/.test(message)
    const failed = /^verify .*: False \(/.test(message)
    const complete = detail.cached === true || /-> already_done\b/.test(message) || verified || isRecord(detail.outputs)
    return [{ type: 'step', targetId, stepIndex: index, description: message || skill.steps[index].description,
      status: failed ? 'failed' : complete ? 'ok' : 'running', tier: complete ? 'complete' : undefined }]
  }
  return []
}
