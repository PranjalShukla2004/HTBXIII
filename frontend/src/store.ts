import { create } from 'zustand'
import { api } from './api'
import type { ActivityItem, RecordedAction, ResultTable, RunEvent, RunTarget, Skill, SkillDraft, Tier } from './api'

const uid = () => Math.random().toString(36).slice(2, 10)
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface TargetState extends RunTarget {
  status: 'queued' | 'running' | 'ok' | 'failed' | 'needs_human' | 'stopped'
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
  /** Readable agent activity for this site only (each site is tracked independently). */
  activity: ActivityItem[]
  /** Page the browser was on after its last completed action. */
  lastUrl?: string
  /** The question the agent stopped on, when it needs a person. */
  attention?: { question: string; options: string[] }
  /** The backend's original error text, kept for inspection. */
  detail?: string
}

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
  status: 'starting' | 'planning' | 'running' | 'done' | 'failed' | 'stopped' | 'needs_human'
  startedAt: number
  finishedAt?: number
  plan?: string
  variables: Record<string, string>
  /** Product options the planner read from the message (not sent to runs; see API.md). */
  choices?: Record<string, string>
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

  loadSkills(): Promise<void>
  toggleAttach(id: string): void
  setAttached(ids: string[]): void
  inspect(id: string | null): void
  deleteSkill(id: string): Promise<void>

  send(text: string): Promise<void>
  runWith(msgId: string, skillId: string): void
  stopRun(msgId: string): Promise<void>
  approve(msgId: string): void
  newChat(): void
  dispose(): void

  startRecording(url: string): Promise<void>
  stopRecording(): Promise<void>
  cancelRecording(): Promise<void>
  saveDraft(name: string, description: string): Promise<void>
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
          targets: e.targets.map((t) => ({ ...t, status: 'queued', stepIndex: 0, totalSteps: 0, tiers: [], browserOpen: false, activity: [] })),
        }
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
        return patchTarget(r, e.targetId, (t) => ({ ...t, status: 'running', totalSteps: e.totalSteps }))
      case 'step':
        return patchTarget(r, e.targetId, (t) => {
          const tiers = [...t.tiers]
          if (e.status === 'ok' && e.tier) tiers[e.stepIndex] = e.tier
          if (e.status === 'skipped') tiers[e.stepIndex] = 'skipped'
          return {
            ...t,
            currentStep: e.description,
            stepIndex: Math.max(t.stepIndex, e.status === 'running' ? e.stepIndex : e.stepIndex + 1),
            tiers,
            status: e.status === 'failed' ? 'failed' : t.status,
          }
        })
      case 'heal': {
        const name = r.targets.find((t) => t.id === e.targetId)?.name ?? e.targetId
        const next = { ...r, heals: [...r.heals, { target: name, message: e.message, phrase: e.learned?.phrase }] }
        return patchTarget(next, e.targetId, (t) => ({ ...t, learned: e.learned?.phrase ?? e.message }))
      }
      case 'frame':
        return patchTarget(r, e.targetId, (t) => ({ ...t, frame: e.image, frameFinal: e.final }))
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
      case 'target_done':
        return patchTarget(r, e.targetId, (t) => ({
          ...t,
          status: e.status,
          result: e.result,
          stepIndex: e.status === 'ok' ? t.totalSteps : t.stepIndex,
          browserOpen: false,
          detail: e.detail,
          currentStep: e.message ?? (e.status === 'ok' ? 'Finished' : t.currentStep),
        }))
      case 'done':
        return { ...r, status: e.status ?? 'done', finishedAt: Date.now(), summary: e.summary, table: e.table,
          needsApproval: e.needsApproval, error: e.status && e.status !== 'done' ? e.summary : undefined }
      case 'error':
        return {
          ...r,
          status: r.status === 'stopped' || e.stopped ? 'stopped' : 'failed',
          error: e.message,
          finishedAt: Date.now(),
          targets: r.targets.map((t) => ({ ...t, browserOpen: false,
            ...(['queued', 'running'].includes(t.status) ? { status: e.stopped || r.status === 'stopped' ? 'stopped' as const : 'failed' as const, currentStep: e.message } : {}) })),
        }
    }
  }

  const launch = async (skillIds: string[], prompt: string) => {
    const msgId = uid()
    const run: RunState = { status: 'starting', startedAt: Date.now(), variables: {}, targets: [], logs: [], heals: [] }
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

  return {
    skills: [],
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
      patchRun(msgId, (r) => ({ ...r, status: 'stopped', stopping: true, finishedAt: Date.now(), targets: r.targets.map((target) => ({ ...target, browserOpen: false,
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
          else if (event.type === 'processing') set((s) => ({ recording: { ...s.recording, status: 'compiling' } }))
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
      set({ recording: { ...rec, status: 'compiling' } })
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
      set((s) => ({
        skills: [skill, ...s.skills.filter((k) => k.id !== skill.id)],
        recording: { status: 'idle', url: rec.url, actions: [] },
        justSavedId: skill.id,
      }))
      setTimeout(() => set({ justSavedId: null }), 2400)
    },
  }
})
