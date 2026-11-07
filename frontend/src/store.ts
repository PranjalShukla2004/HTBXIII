import { create } from 'zustand'
import { api } from './api'
import type { RecordedAction, ResultTable, RunEvent, RunTarget, Skill, SkillDraft, Tier } from './api'

const uid = () => Math.random().toString(36).slice(2, 10)

export interface TargetState extends RunTarget {
  status: 'queued' | 'running' | 'ok' | 'failed'
  stepIndex: number
  totalSteps: number
  currentStep?: string
  tiers: (Tier | 'skipped')[]
  browserOpen: boolean
  result?: Record<string, string | number>
  /** Latest live preview from the backend (real mode). */
  frame?: string
  /** Phrase learned by self-heal on this site. */
  learned?: string
}

export interface LogLine {
  id: string
  ts: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  target?: string
}

export interface RunState {
  runId?: string
  status: 'starting' | 'planning' | 'running' | 'done' | 'failed' | 'stopped'
  startedAt: number
  finishedAt?: number
  plan?: string
  variables: Record<string, string>
  targets: TargetState[]
  logs: LogLine[]
  heals: { target: string; message: string; phrase?: string }[]
  summary?: string
  table?: ResultTable
  needsApproval?: string
  approved?: boolean
  error?: string
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
}

interface Store {
  skills: Skill[]
  skillsLoaded: boolean
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

  startRecording(url: string): Promise<void>
  stopRecording(): Promise<void>
  cancelRecording(): Promise<void>
  saveDraft(name: string, description: string): Promise<void>
}

let recUnsub: (() => void) | null = null

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
          targets: e.targets.map((t) => ({ ...t, status: 'queued', stepIndex: 0, totalSteps: 0, tiers: [], browserOpen: false })),
        }
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
            stepIndex: e.status === 'running' ? e.stepIndex : e.stepIndex + 1,
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
        return patchTarget(r, e.targetId, (t) => ({ ...t, frame: e.image }))
      case 'browser':
        return patchTarget(r, e.targetId, (t) => ({ ...t, browserOpen: e.status === 'opened' }))
      case 'log':
        return {
          ...r,
          logs: [
            ...r.logs,
            {
              id: uid(),
              ts: e.ts,
              level: e.level,
              message: e.message,
              target: e.targetId ? r.targets.find((t) => t.id === e.targetId)?.name : undefined,
            },
          ],
        }
      case 'target_done':
        return patchTarget(r, e.targetId, (t) => ({
          ...t,
          status: e.status,
          result: e.result,
          stepIndex: t.totalSteps,
          browserOpen: false,
        }))
      case 'done':
        return { ...r, status: 'done', finishedAt: Date.now(), summary: e.summary, table: e.table, needsApproval: e.needsApproval }
      case 'error':
        return {
          ...r,
          status: r.status === 'stopped' ? 'stopped' : 'failed',
          error: e.message,
          finishedAt: Date.now(),
          targets: r.targets.map((t) => ({ ...t, browserOpen: false })),
        }
    }
  }

  const launch = async (skillIds: string[], prompt: string) => {
    const msgId = uid()
    const run: RunState = { status: 'starting', startedAt: Date.now(), variables: {}, targets: [], logs: [], heals: [] }
    set((s) => ({ messages: [...s.messages, { id: msgId, role: 'assistant', kind: 'run', skillIds, run }] }))
    try {
      const { runId } = await api.startRun({ skillIds, prompt })
      patchRun(msgId, (r) => ({ ...r, runId, status: 'planning' }))
      const unsub = api.onRunEvents(runId, (e) => {
        patchRun(msgId, (r) => reduce(r, e))
        if (e.type === 'done' || e.type === 'error') {
          unsub()
          void get().loadSkills()
        }
      })
    } catch (err) {
      patchRun(msgId, (r) => ({ ...r, status: 'failed', error: String(err), finishedAt: Date.now() }))
    }
  }

  return {
    skills: [],
    skillsLoaded: false,
    attached: [],
    messages: [],
    recording: { status: 'idle', url: '', actions: [] },
    inspectId: null,
    justSavedId: null,

    async loadSkills() {
      try {
        const skills = await api.listSkills()
        set({ skills, skillsLoaded: true })
      } catch {
        set({ skillsLoaded: true })
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
      await api.deleteSkill(id)
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
      if (!msg || msg.role !== 'assistant' || msg.kind !== 'run' || !msg.run.runId) return
      patchRun(msgId, (r) => ({ ...r, status: 'stopped' }))
      await api.stopRun(msg.run.runId)
    },
    approve(msgId) {
      patchRun(msgId, (r) => ({ ...r, approved: true }))
    },
    newChat() {
      set({ messages: [], attached: [] })
    },

    async startRecording(url) {
      set({ recording: { status: 'starting', url, actions: [] } })
      try {
        const { sessionId } = await api.startRecording(url)
        set({ recording: { status: 'recording', url, sessionId, startedAt: Date.now(), actions: [] } })
        recUnsub = api.onRecordingEvents(sessionId, (a) =>
          set((s) => ({ recording: { ...s.recording, actions: [...s.recording.actions, a] } })),
        )
      } catch (err) {
        set({ recording: { status: 'idle', url, actions: [], error: `Couldn’t start the recorder: ${String(err)}` } })
      }
    },
    async stopRecording() {
      const rec = get().recording
      if (!rec.sessionId) return
      recUnsub?.()
      recUnsub = null
      set({ recording: { ...rec, status: 'compiling' } })
      try {
        const draft = await api.stopRecording(rec.sessionId)
        set({ recording: { ...get().recording, status: 'review', draft } })
      } catch (err) {
        set({ recording: { ...rec, status: 'idle', error: `Recording failed to compile: ${String(err)}` } })
      }
    },
    async cancelRecording() {
      const rec = get().recording
      recUnsub?.()
      recUnsub = null
      if (rec.sessionId && rec.status === 'recording') await api.cancelRecording(rec.sessionId).catch(() => {})
      set({ recording: { status: 'idle', url: rec.url, actions: [] } })
    },
    async saveDraft(name, description) {
      const rec = get().recording
      if (!rec.draft) return
      const skill = await api.saveSkill({ ...rec.draft, name, description })
      set((s) => ({
        skills: [skill, ...s.skills.filter((k) => k.id !== skill.id)],
        recording: { status: 'idle', url: rec.url, actions: [] },
        justSavedId: skill.id,
      }))
      setTimeout(() => set({ justSavedId: null }), 2400)
    },
  }
})
