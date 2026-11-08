import { create } from 'zustand'
import { api } from './api'
import { perItemChoice } from './api/mapping'
import type { ActivityItem, RecordedAction, ResultTable, RunConstraints, RunEvent, RunTarget, Skill, SkillDraft, Tier } from './api'
import { loadStats, saveStats, withRun } from './lib/stats'
import type { SkillStats } from './lib/stats'
import { RUN_EVENT } from './lib/commentator'

const uid = () => Math.random().toString(36).slice(2, 10)
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface TargetState extends RunTarget {
  /** found: it read the product's name, price and link but couldn't add it to the basket. */
  status: 'queued' | 'running' | 'ok' | 'found' | 'failed' | 'needs_human' | 'stopped'
  stepIndex: number
  totalSteps: number
  currentStep?: string
  tiers: (Tier | 'skipped')[]
  browserOpen: boolean
  result?: Record<string, string | number>
  /** Latest live preview from the backend (real mode). */
  frame?: string
  frameFinal?: boolean
  /** Phrase learned by self-heal on this site. */
  learned?: string
  /** Position in the run; fixes the site's colour. */
  index: number
  /** The self-heal moment: what you clicked when recording, and what this site calls it. */
  heal?: { from?: string; to: string; stepIndex: number; at: number }
  /** Paused for a person. */
  blocked?: { message: string; resumable: boolean; at: number }
  /** The person has taken over this site. */
  takeover?: boolean
  /** Milliseconds into the run when the result was read. */
  foundAt?: number
  /** Screenshot at the moment the result was read, when the backend sent one. */
  evidence?: string
  /** Readable agent activity for this site only (each site is tracked independently). */
  activity: ActivityItem[]
  /** Page the browser was on after its last completed action. */
  lastUrl?: string
  /** The question the agent stopped on, when it needs a person. */
  attention?: { question: string; options: string[] }
  /** The backend's original error text, kept for inspection. */
  detail?: string
  /** The site is paused until the shopper answers this (e.g. a size the page asks for). */
  question?: { field: string; question: string; options: string[]; sending?: boolean; error?: string }
  /** Different products this site put in the basket, when several were asked for. */
  items?: Record<string, string | number>[]
}

export type FocusReason = 'heal' | 'needs' | 'price' | 'live'

export interface LogLine {
  id: string
  ts: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  target?: string
  targetId?: string
  jobId?: string
  source?: string
  partial?: boolean
  modelText?: string
}

export interface RunState {
  runId?: string
  prompt: string
  status: 'starting' | 'planning' | 'running' | 'done' | 'failed' | 'stopped' | 'needs_human'
  startedAt: number
  finishedAt?: number
  plan?: string
  variables: Record<string, string>
  /** Product options from the message and the shopper's answers; sent to every site run. */
  choices?: Record<string, string>
  /** Budget, number of different products and requirements the planner read from the message. */
  constraints?: RunConstraints
  targets: TargetState[]
  logs: LogLine[]
  heals: { target: string; message: string; phrase?: string }[]
  summary?: string
  table?: ResultTable
  needsApproval?: string
  approved?: boolean
  error?: string
  stopping?: boolean
  connections?: Record<string, string>
  /** Which site the spotlight shows, chosen by the director. */
  focus?: { id: string; reason: FocusReason; prio: number; at: number }
  /** Site the person clicked; overrides the director until cleared. */
  pinned?: string | null
}

export type ChatMessage =
  | { id: string; role: 'user'; text: string; skillIds: string[] }
  | { id: string; role: 'assistant'; kind: 'text'; text: string }
  | { id: string; role: 'assistant'; kind: 'pick-skill'; text: string; prompt: string }
  | { id: string; role: 'assistant'; kind: 'run'; skillIds: string[]; run: RunState }

export interface Recording {
  status: 'idle' | 'starting' | 'recording' | 'compiling' | 'review'
  url: string
  sessionId?: string
  startedAt?: number
  stoppedAt?: number
  actions: RecordedAction[]
  draft?: SkillDraft
  error?: string
  connection?: string
  saving?: boolean
}

interface Store {
  skills: Skill[]
  skillsLoaded: boolean
  skillsError?: string
  agentConnected: boolean
  attached: string[]
  messages: ChatMessage[]
  recording: Recording
  inspectId: string | null
  justSavedId: string | null
  stats: Record<string, SkillStats>

  loadSkills(): Promise<void>
  toggleAttach(id: string): void
  setAttached(ids: string[]): void
  inspect(id: string | null): void
  deleteSkill(id: string): Promise<void>

  send(text: string): Promise<void>
  runWith(msgId: string, skillId: string): void
  stopRun(msgId: string): Promise<void>
  approve(msgId: string): void
  pin(msgId: string, targetId: string | null): void
  takeOver(msgId: string, targetId: string): void
  handBack(msgId: string, targetId: string): Promise<void>
  /** Answer the question a site is waiting on; later sites reuse the answer. */
  answer(msgId: string, targetId: string, value: string): Promise<void>
  newChat(): void
  dispose(): void

  startRecording(url: string): Promise<void>
  stopRecording(): Promise<void>
  cancelRecording(): Promise<void>
  saveDraft(name: string, description: string): Promise<void>
}

/** How long an interesting moment keeps the spotlight before something less urgent can take it. */
export const HOLD = 2800

/** The TV director: decide whether this event should move the spotlight. */
function direct(r: RunState, id: string, reason: FocusReason, prio: number): RunState {
  const now = Date.now()
  const f = r.focus
  const next = { ...r, focus: { id, reason, prio, at: now } }
  if (!f) return next
  if (f.id === id) return prio >= f.prio ? next : r
  const cur = r.targets.find((t) => t.id === f.id)
  const busy = cur && (cur.status === 'running' || (cur.status === 'needs_human' && cur.blocked?.resumable))
  // A self-heal is brief, so it may cut in on a site that is waiting for a person.
  if (reason === 'heal' && f.reason === 'needs') return next
  if (now - f.at < HOLD && prio <= f.prio) return r
  // A site waiting for a person can lose the spotlight briefly (a self-heal), then gets it back.
  const waiting = r.targets.find((t) => t.status === 'needs_human' && t.blocked?.resumable && t.id !== f.id)
  if (waiting && prio < 3 && now - f.at >= HOLD) return { ...r, focus: { id: waiting.id, reason: 'needs', prio: 3, at: now } }
  if (prio === 1 && busy) return r
  return next
}

let recUnsub: (() => void) | null = null
let recEpoch = 0
const runSubscriptions = new Map<string, () => void>()

/** Find skills mentioned in free text, e.g. "use the shopping skill". */
export function matchSkills(text: string, skills: Skill[]): Skill[] {
  const t = text.toLowerCase()
  return skills.filter((s) => {
    const name = s.name.toLowerCase()
    if (t.includes(name)) return true
    const words = name.split(/\s+/).filter((w) => w.length > 3)
    return words.some((w) => new RegExp(`\\b${w}\\b[^.]{0,12}\\bskill\\b`).test(t) || t.includes(`@${w}`))
  })
}

export const useStore = create<Store>((set, get) => {
  const patchRun = (msgId: string, fn: (r: RunState) => RunState) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === msgId && m.role === 'assistant' && m.kind === 'run' ? { ...m, run: fn(m.run) } : m)),
    }))

  const patchTarget = (r: RunState, id: string, fn: (t: TargetState) => TargetState): RunState => ({
    ...r,
    targets: r.targets.map((t) => (t.id === id ? fn(t) : t)),
  })

  const reduce = (r: RunState, e: RunEvent): RunState => {
    switch (e.type) {
      case 'plan':
        return {
          ...r,
          status: 'running',
          plan: e.summary,
          variables: e.variables,
          choices: e.choices,
          constraints: e.constraints,
          targets: e.targets.map((t, index) => ({ ...t, index, status: 'queued', stepIndex: 0, totalSteps: 0, tiers: [], browserOpen: false, activity: [] })),
        }
      case 'question':
        return direct(patchTarget(r, e.targetId, (t) => ({ ...t, question: { field: e.field, question: e.question, options: e.options },
          currentStep: `Waiting for you: ${e.question}` })), e.targetId, 'needs', 3)
      case 'answered':
        return { ...patchTarget(r, e.targetId, (t) => ({ ...t, question: undefined })),
          choices: e.perItem ? r.choices : { ...r.choices, [e.field]: e.value } }
      case 'activity':
        return patchTarget(r, e.targetId, (t) => t.activity.some((item) => item.id === e.item.id) ? t : ({
          ...t,
          activity: [...t.activity, e.item].slice(-300),
          currentStep: e.item.text,
          lastUrl: e.item.url ?? t.lastUrl,
        }))
      case 'attention':
        return patchTarget(r, e.targetId, (t) => ({ ...t, attention: { question: e.question, options: e.options } }))
      case 'target_start':
        return direct(patchTarget(r, e.targetId, (t) => ({ ...t, status: 'running', totalSteps: e.totalSteps })), e.targetId, 'live', 1)
      case 'step': {
        const next = patchTarget(r, e.targetId, (t) => {
          const tiers = [...t.tiers]
          if (e.status === 'ok' && e.tier) tiers[e.stepIndex] = e.tier
          if (e.status === 'skipped') tiers[e.stepIndex] = 'skipped'
          return {
            ...t,
            currentStep: e.description,
            stepIndex: Math.max(t.stepIndex, e.status === 'running' ? e.stepIndex : e.stepIndex + 1),
            tiers,
            status: e.status === 'failed' ? 'failed' : t.blocked ? 'running' : t.status,
            blocked: undefined,
            takeover: false,
          }
        })
        return direct(next, e.targetId, 'live', 1)
      }
      case 'heal': {
        const name = r.targets.find((t) => t.id === e.targetId)?.name ?? e.targetId
        const next = { ...r, heals: [...r.heals, { target: name, message: e.message, phrase: e.learned?.phrase }] }
        const to = e.learned?.phrase ?? e.message
        return direct(patchTarget(next, e.targetId, (t) => ({ ...t, learned: to,
          heal: { from: e.learned?.recorded, to, stepIndex: e.stepIndex, at: Date.now() } })), e.targetId, 'heal', 3)
      }
      case 'needs_human':
        return direct(patchTarget(r, e.targetId, (t) => ({ ...t, status: 'needs_human', currentStep: e.message,
          blocked: { message: e.message, resumable: !!e.resumable && !!api.resumeTarget, at: Date.now() } })), e.targetId, 'needs', 3)
      case 'frame':
        return patchTarget(r, e.targetId, (t) => ({ ...t, frame: e.image, frameFinal: e.final, evidence: e.final ? e.image : t.evidence }))
      case 'browser':
        return patchTarget(r, e.targetId, (t) => ({ ...t, browserOpen: e.status === 'opened' }))
      case 'connection':
        return { ...r, connections: { ...r.connections, [`${e.targetId ?? 'plan'}:${e.channel}`]: e.state } }
      case 'model': {
        const existing = r.logs.find((line) => line.id === e.id)
        const text = (e.reset ? '' : existing?.modelText ?? '') + e.text
        const line: LogLine = { id: e.id, ts: e.ts, level: 'debug', modelText: text,
          message: `Gemini · ${e.tag}\n${text || 'Waiting for generated text…'}`,
          targetId: e.targetId, target: r.targets.find((target) => target.id === e.targetId)?.name }
        return { ...r, logs: existing ? r.logs.map((old) => old.id === e.id ? line : old) : [...r.logs, line] }
      }
      case 'logs_snapshot':
        return { ...r, logs: [...r.logs.filter((line) => !(line.source === 'console' && line.jobId === e.jobId)),
          { id: uid(), ts: e.ts, level: 'info', message: e.text, source: 'console', jobId: e.jobId, targetId: e.targetId,
            target: r.targets.find((target) => target.id === e.targetId)?.name }] }
      case 'log': {
        if (e.id && r.logs.some((line) => line.id === e.id)) return r
        const previous = r.logs.at(-1)
        if (e.source === 'console' && previous?.source === 'console' && previous.partial && previous.jobId === e.jobId) {
          return { ...r, logs: [...r.logs.slice(0, -1), { ...previous, message: previous.message + e.message,
            partial: e.partial, level: e.level === 'error' ? 'error' : previous.level }] }
        }
        return {
          ...r,
          logs: [
            ...r.logs,
            {
              id: e.id ?? uid(),
              ts: e.ts,
              level: e.level,
              message: e.message,
              target: e.targetId ? r.targets.find((t) => t.id === e.targetId)?.name : undefined,
              targetId: e.targetId, jobId: e.jobId, source: e.source, partial: e.partial,
            },
          ],
        }
      }
      case 'target_done': {
        const next = patchTarget(r, e.targetId, (t) => ({
          ...t,
          status: e.status,
          result: e.result,
          stepIndex: e.status === 'ok' ? t.totalSteps : t.stepIndex,
          browserOpen: false,
          detail: e.detail,
          question: undefined,
          items: e.items,
          currentStep: e.message ?? (e.status === 'ok' ? 'Finished' : t.currentStep),
          foundAt: e.result ? Date.now() - r.startedAt : undefined,
          evidence: t.evidence ?? t.frame,
          blocked: e.status === 'needs_human' ? { message: e.message ?? 'Needs a person', resumable: false, at: Date.now() } : undefined,
          takeover: false,
        }))
        if (e.status === 'needs_human') return direct(next, e.targetId, 'needs', 3)
        // Real results always carry Site/Status; only an actual price earns the "Price found" spotlight.
        const priced = !!e.result && Object.keys(e.result).some((key) => /^(unit|price|each|total)$/i.test(key))
        return (e.status === 'ok' || e.status === 'found') && priced ? direct(next, e.targetId, 'price', 2) : next
      }
      case 'done':
        return { ...r, status: e.status ?? 'done', finishedAt: Date.now(), summary: e.summary, table: e.table,
          needsApproval: e.needsApproval, error: e.status && e.status !== 'done' ? e.summary : undefined }
      case 'error':
        return {
          ...r,
          status: r.status === 'stopped' || e.stopped ? 'stopped' : 'failed',
          error: e.message,
          finishedAt: Date.now(),
          targets: r.targets.map((t) => ({ ...t, browserOpen: false, question: undefined,
            ...(['queued', 'running'].includes(t.status) ? { status: e.stopped || r.status === 'stopped' ? 'stopped' as const : 'failed' as const, currentStep: e.message } : {}) })),
        }
    }
  }

  const launch = async (skillIds: string[], prompt: string) => {
    const msgId = uid()
    const run: RunState = { status: 'starting', prompt, startedAt: Date.now(), variables: {}, targets: [], logs: [], heals: [] }
    set((s) => ({ messages: [...s.messages, { id: msgId, role: 'assistant', kind: 'run', skillIds, run }] }))
    try {
      const { runId } = await api.startRun({ skillIds, prompt })
      const current = get().messages.find((item) => item.id === msgId)
      if (!current || current.role !== 'assistant' || current.kind !== 'run' || current.run.status === 'stopped') {
        await api.stopRun(runId)
        return
      }
      patchRun(msgId, (r) => ({ ...r, runId, status: 'planning' }))
      let finished = false
      const unsub = api.onRunEvents(runId, (e) => {
        patchRun(msgId, (r) => reduce(r, e))
        // Read-only copy for the live commentator (src/lib/commentator.ts); changes nothing here.
        window.dispatchEvent(new CustomEvent(RUN_EVENT, { detail: { e, prompt, runKey: msgId } }))
        if (e.type === 'done') remember(msgId, skillIds[0])
        if (e.type === 'done' || e.type === 'error') {
          finished = true
          runSubscriptions.get(msgId)?.()
          runSubscriptions.delete(msgId)
          void get().loadSkills()
        }
      })
      if (finished) unsub()
      else runSubscriptions.set(msgId, unsub)
    } catch (err) {
      patchRun(msgId, (r) => r.status === 'stopped' ? r : ({ ...r, status: 'failed', error: errText(err), finishedAt: Date.now() }))
    }
  }

  /** Fold a finished run into the skill's history. */
  const remember = (msgId: string, skillId: string) => {
    const msg = get().messages.find((m) => m.id === msgId)
    if (!msg || msg.role !== 'assistant' || msg.kind !== 'run') return
    const r = msg.run
    const sites = r.targets.filter((t) => t.status !== 'queued').map((t) => ({ name: t.name, ok: t.status === 'ok' }))
    const phrases = r.heals.flatMap((h) => (h.phrase ? [h.phrase] : []))
    const stats = { ...get().stats, [skillId]: withRun(get().stats[skillId], sites, phrases) }
    saveStats(stats)
    set({ stats })
  }

  return {
    skills: [],
    stats: loadStats(),
    skillsLoaded: false,
    agentConnected: false,
    attached: [],
    messages: [],
    recording: { status: 'idle', url: '', actions: [] },
    inspectId: null,
    justSavedId: null,

    async loadSkills() {
      try {
        const skills = await api.listSkills()
        set({ skills, skillsLoaded: true, agentConnected: true, skillsError: undefined })
      } catch (error) {
        set({ skillsLoaded: true, agentConnected: false, skillsError: `Couldn’t load skills: ${errText(error)}` })
      }
    },
    toggleAttach(id) {
      set((s) => ({ attached: s.attached.includes(id) ? s.attached.filter((x) => x !== id) : [...s.attached, id] }))
    },
    setAttached(ids) {
      set({ attached: ids })
    },
    inspect(id) {
      set({ inspectId: id })
    },
    async deleteSkill(id) {
      try { await api.deleteSkill(id) } catch (error) { set({ skillsError: errText(error) }); return }
      set((s) => ({
        skills: s.skills.filter((k) => k.id !== id),
        attached: s.attached.filter((x) => x !== id),
        inspectId: s.inspectId === id ? null : s.inspectId,
      }))
    },

    async send(text) {
      const { attached, skills } = get()
      let ids = attached
      if (!ids.length) ids = matchSkills(text, skills).map((s) => s.id)
      set((s) => ({ messages: [...s.messages, { id: uid(), role: 'user', text, skillIds: ids }], attached: [] }))
      if (!ids.length) {
        set((s) => ({
          messages: [
            ...s.messages,
            {
              id: uid(),
              role: 'assistant',
              kind: 'pick-skill',
              prompt: text,
              text: skills.length
                ? 'Which skill should I use for this?'
                : 'I don’t know how to do anything yet. Record a skill first, then ask again.',
            },
          ],
        }))
        return
      }
      await launch(ids, text)
    },
    runWith(msgId, skillId) {
      const msg = get().messages.find((m) => m.id === msgId)
      if (!msg || msg.role !== 'assistant' || msg.kind !== 'pick-skill') return
      set((s) => ({ messages: s.messages.filter((m) => m.id !== msgId) }))
      set((s) => ({
        messages: s.messages.map((m, i, arr) =>
          i === arr.length - 1 && m.role === 'user' ? { ...m, skillIds: [skillId] } : m,
        ),
      }))
      void launch([skillId], msg.prompt)
    },
    async stopRun(msgId) {
      const msg = get().messages.find((m) => m.id === msgId)
      if (!msg || msg.role !== 'assistant' || msg.kind !== 'run') return
      patchRun(msgId, (r) => ({ ...r, status: 'stopped', stopping: true, finishedAt: Date.now(), targets: r.targets.map((target) => ({ ...target, browserOpen: false, question: undefined,
        ...(['queued', 'running'].includes(target.status) ? { status: 'stopped' as const, currentStep: 'Stopped' } : {}) })) }))
      try { if (msg.run.runId) await api.stopRun(msg.run.runId) }
      finally {
        runSubscriptions.get(msgId)?.()
        runSubscriptions.delete(msgId)
        patchRun(msgId, (r) => ({ ...r, stopping: false }))
      }
    },
    approve(msgId) {
      patchRun(msgId, (r) => ({ ...r, approved: true }))
    },
    pin(msgId, targetId) {
      patchRun(msgId, (r) => ({ ...r, pinned: targetId }))
    },
    takeOver(msgId, targetId) {
      patchRun(msgId, (r) => ({ ...patchTarget(r, targetId, (t) => ({ ...t, takeover: true })), pinned: targetId }))
    },
    async handBack(msgId, targetId) {
      const msg = get().messages.find((m) => m.id === msgId)
      if (!msg || msg.role !== 'assistant' || msg.kind !== 'run' || !msg.run.runId) return
      patchRun(msgId, (r) => ({ ...patchTarget(r, targetId, (t) => ({ ...t, takeover: false, currentStep: 'Handing back to the agent' })), pinned: null }))
      await api.resumeTarget?.(msg.run.runId, targetId)
    },
    async answer(msgId, targetId, value) {
      const msg = get().messages.find((m) => m.id === msgId)
      if (!msg || msg.role !== 'assistant' || msg.kind !== 'run' || !msg.run.runId || !api.answerTarget || !value.trim()) return
      const setQuestion = (fn: (q: NonNullable<TargetState['question']>) => TargetState['question']) =>
        patchRun(msgId, (r) => patchTarget(r, targetId, (t) => (t.question ? { ...t, question: fn(t.question) } : t)))
      setQuestion((q) => ({ ...q, sending: true, error: undefined }))
      try {
        await api.answerTarget(msg.run.runId, targetId, value.trim())
        const field = msg.run.targets.find((t) => t.id === targetId)?.question?.field
        patchRun(msgId, (r) => ({ ...patchTarget(r, targetId, (t) => ({ ...t, question: undefined, currentStep: `Carrying on with your answer: ${value.trim()}` })),
          // A size is for that one product on that one site, so it isn't shown as a choice for the whole run.
          choices: field && !perItemChoice(field) ? { ...r.choices, [field]: value.trim() } : r.choices }))
      } catch (error) {
        setQuestion((q) => ({ ...q, sending: false, error: errText(error) }))
      }
    },
    newChat() {
      for (const msg of get().messages) {
        if (msg.role === 'assistant' && msg.kind === 'run' && msg.run.runId && ['starting', 'planning', 'running'].includes(msg.run.status)) void api.stopRun(msg.run.runId).catch(() => {})
      }
      runSubscriptions.forEach((close) => close())
      runSubscriptions.clear()
      set({ messages: [], attached: [] })
    },
    dispose() {
      for (const msg of get().messages) if (msg.role === 'assistant' && msg.kind === 'run' && ['starting', 'planning', 'running'].includes(msg.run.status)) void get().stopRun(msg.id)
      runSubscriptions.forEach((close) => close())
      runSubscriptions.clear()
      if (get().recording.status !== 'idle') void get().cancelRecording()
    },

    async startRecording(url) {
      const epoch = ++recEpoch
      set({ recording: { status: 'starting', url, actions: [] } })
      try {
        const { sessionId } = await api.startRecording(url)
        if (epoch !== recEpoch) { await api.cancelRecording(sessionId); return }
        set({ recording: { status: 'recording', url, sessionId, startedAt: Date.now(), actions: [] } })
        recUnsub = api.onRecordingEvents(sessionId, (event) => {
          if (get().recording.sessionId !== sessionId || epoch !== recEpoch) return
          if (event.type === 'action') set((s) => ({ recording: { ...s.recording,
            actions: s.recording.actions.some((action) => action.id === event.action.id) ? s.recording.actions : [...s.recording.actions, event.action] } }))
          else if (event.type === 'processing') set((s) => ({ recording: { ...s.recording, status: 'compiling', stoppedAt: s.recording.stoppedAt ?? Date.now() } }))
          else if (event.type === 'connection') set((s) => ({ recording: { ...s.recording, connection: event.state } }))
          else if (event.type === 'compiled') {
            set((s) => ({ recording: { ...s.recording, status: 'review', draft: event.draft } }))
            recUnsub?.(); recUnsub = null
          } else if (event.type === 'error') {
            set((s) => ({ recording: { ...s.recording, status: 'idle', error: event.message } }))
            recUnsub?.(); recUnsub = null
          }
        })
      } catch (err) {
        if (epoch === recEpoch) set({ recording: { status: 'idle', url, actions: [], error: `Couldn’t start the recorder: ${errText(err)}` } })
      }
    },
    async stopRecording() {
      const rec = get().recording
      if (!rec.sessionId) return
      set({ recording: { ...rec, status: 'compiling', stoppedAt: Date.now() } })
      try {
        const draft = await api.stopRecording(rec.sessionId)
        if (get().recording.sessionId === rec.sessionId) {
          set({ recording: { ...get().recording, status: 'review', draft } })
          recUnsub?.(); recUnsub = null
        }
      } catch (err) {
        if (get().recording.sessionId === rec.sessionId) set({ recording: { ...rec, status: 'idle', error: `Recording failed to compile: ${errText(err)}` } })
      }
    },
    async cancelRecording() {
      const rec = get().recording
      ++recEpoch
      recUnsub?.()
      recUnsub = null
      set({ recording: { status: 'idle', url: rec.url, actions: [] } })
      if (rec.sessionId) await api.cancelRecording(rec.sessionId).catch((error) => set((s) => ({ recording: { ...s.recording, error: errText(error) } })))
    },
    async saveDraft(name, description) {
      const rec = get().recording
      if (!rec.draft) return
      set((s) => ({ recording: { ...s.recording, saving: true, error: undefined } }))
      let skill: Skill
      try { skill = await api.saveSkill({ ...rec.draft, name, description }) }
      catch (error) { set((s) => ({ recording: { ...s.recording, saving: false, error: errText(error) } })); return }
      const recordedMs = rec.startedAt ? (rec.stoppedAt ?? Date.now()) - rec.startedAt : undefined
      const stats = { ...get().stats, [skill.id]: { runs: 0, sites: {}, phrases: [], recordedMs } }
      saveStats(stats)
      set((s) => ({
        stats,
        skills: [skill, ...s.skills.filter((k) => k.id !== skill.id)],
        recording: { status: 'idle', url: rec.url, actions: [] },
        justSavedId: skill.id,
      }))
      setTimeout(() => set({ justSavedId: null }), 2400)
    },
  }
})
