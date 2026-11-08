import { isRecord, TERMINAL } from './backend.ts'
import type { BackendJob, BackendResult, BackendSkill, JobFrame } from './backend.ts'
import { describeError, recordingAction, runEvents, skillFromBackend } from './mapping.ts'
import { subscribeJob } from './websocket.ts'
import type { ConnectionState } from './websocket.ts'
import type { AgentApi, RecordingEvent, RunEvent, Skill, SkillDraft, Unsubscribe } from './types.ts'

const BASE = (import.meta.env?.VITE_API_URL as string | undefined) ?? 'http://localhost:8000'
/** Sites shopped at the same time after the first one. Keep in step with MAX_PARALLEL_RUNS on the backend. */
const MAX_PARALLEL = Math.max(1, Number(import.meta.env?.VITE_MAX_PARALLEL ?? 4) || 4)
const abortError = () => new DOMException('Stopped.', 'AbortError')
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError'
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const cell = (value: unknown): string | number => value == null ? '—' :
  typeof value === 'string' || typeof value === 'number' ? value : JSON.stringify(value)

export function createHttpApi(baseUrl: string): AgentApi {
  const base = baseUrl.replace(/\/$/, '')
  const runs = new Map<string, { controller: AbortController; first: BackendJob; skillIds: string[]; prompt: string; jobs: Set<string>; started: boolean }>()
  const recordings = new Map<string, { job: BackendJob; listeners: Set<(event: RecordingEvent) => void>; controller: AbortController; done?: Promise<BackendJob>; draft?: SkillDraft }>()

  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetch(new URL(path, base), {
        ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
      })
    } catch (error) {
      if (isAbort(error)) throw error
      // CORS/origin rejections and a stopped server both surface as a bare network error.
      const origin = typeof location === 'undefined' ? 'this page' : location.origin
      throw new Error(`Can’t reach the agent at ${base}. Check the backend is running and that ${origin} is in its FRONTEND_ORIGINS.`)
    }
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`
      try {
        const body = await response.json()
        detail = body.error?.message ?? (typeof body.detail === 'string' ? body.detail : detail)
      } catch { /* A proxy/server failure may return a non-JSON response. */ }
      throw new Error(detail)
    }
    return response.status === 204 ? undefined as T : response.json() as Promise<T>
  }
  const post = <T>(path: string, body?: unknown) => req<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
  const getJob = (id: string) => req<BackendJob>(`/api/jobs/${encodeURIComponent(id)}`)
  const cancel = (id: string) => post<BackendJob>(`/api/jobs/${encodeURIComponent(id)}/cancel`)

  function monitor(job: BackendJob, signal: AbortSignal, frame: (event: JobFrame) => void | Promise<void>, state: (channel: string, value: ConnectionState) => void): Promise<BackendJob> {
    return new Promise((resolve, reject) => {
      const subscriptions: Unsubscribe[] = []
      const finished = new Set<string>()
      let settled = false
      let final = job
      const cleanup = () => { subscriptions.forEach((close) => close()); signal.removeEventListener('abort', aborted) }
      const fail = (error: Error) => { if (!settled) { settled = true; cleanup(); reject(error) } }
      const aborted = () => fail(abortError())
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) { aborted(); return }
      for (const channel of ['events', 'llm'] as const) subscriptions.push(subscribeJob({ base, path: job.streams[channel], jobId: job.job_id, channel,
        onState: (value) => state(channel, value), onError: fail,
        async onFrame(event) {
          await frame(event)
          if (TERMINAL.has(event.type)) {
            final = event.data.truncated || typeof event.data.status !== 'string' ? await getJob(job.job_id) :
              { ...job, status: event.data.status, result: event.data.result as BackendResult | null,
                error: event.data.error as BackendJob['error'] }
            finished.add(channel)
            if (finished.size === 2 && !settled) { settled = true; cleanup(); resolve(final) }
          }
        },
      }))
    })
  }

  function recordingDraft(job: BackendJob): SkillDraft {
    const raw = job.result?.skill
    if (!raw) throw new Error(job.error?.message || 'The recording did not produce a skill.')
    const skill = skillFromBackend(raw)
    return { name: '', description: skill.description, site: skill.site, steps: skill.steps,
      variables: skill.variables, backendId: skill.id }
  }
  function startRecordingMonitor(id: string) {
    const recording = recordings.get(id)
    if (!recording) throw new Error('Recording session not found.')
    if (!recording.done) {
      const emit = (event: RecordingEvent) => recording.listeners.forEach((listener) => listener(event))
      const connections = new Map<string, ConnectionState>()
      recording.done = monitor(recording.job, recording.controller.signal, (frame) => {
        const action = recordingAction(frame)
        if (action) emit({ type: 'action', action })
        if (frame.channel === 'events' && frame.type === 'status' && ['processing', 'stopping'].includes(String(frame.data.status))) emit({ type: 'processing' })
      }, (channel, state) => {
        connections.set(channel, state)
        const values = [...connections.values()]
        const aggregate = (['error', 'reconnecting', 'connecting', 'connected', 'closed'] as const).find((value) => values.includes(value))!
        emit({ type: 'connection', state: aggregate })
      }).then((job) => {
        if (job.status !== 'done') throw new Error(job.error?.message || (job.status === 'cancelled' ? 'Recording cancelled.' : 'Recording could not be compiled.'))
        recording.draft = recordingDraft(job)
        emit({ type: 'compiled', draft: recording.draft })
        return job
      })
      void recording.done.catch((error) => {
        if (!isAbort(error)) { emit({ type: 'error', message: message(error) }); void cancel(id).catch(() => {}) }
      })
    }
    return recording.done
  }

  async function followRunJob(job: BackendJob, signal: AbortSignal, skill: Skill, emit: (event: RunEvent) => void,
                              targetId?: string, vars?: Record<string, string>, seen: { lastUrl?: string } = {}) {
    let logCursor = 0
    return monitor(job, signal, async (frame) => {
      if (frame.type === 'action' && typeof frame.data.url === 'string') seen.lastUrl = frame.data.url
      if (frame.type === 'gap') {
        if (frame.channel === 'events') {
          const response = await fetch(new URL(job.log_url, base), { signal })
          if (!response.ok) throw new Error('Could not recover the saved job log.')
          const text = await response.text()
          logCursor = Number(response.headers.get('X-Log-Sequence') || frame.seq)
          emit({ type: 'logs_snapshot', targetId, jobId: job.job_id, text, ts: new Date().toISOString() })
        } else emit({ type: 'log', targetId, level: 'warn', ts: new Date().toISOString(), message: 'Some earlier model detail expired; current job progress is still available.' })
      }
      if (frame.type === 'log' && frame.seq <= logCursor) return
      for (const event of runEvents(frame, skill, targetId, vars)) emit(event)
    }, (channel, state) => emit({ type: 'connection', channel, state, targetId }))
  }

  async function executeRun(id: string, emit: (event: RunEvent) => void) {
    const session = runs.get(id)!
    const signal = session.controller.signal
    try {
      const plans: { skill: Skill; variables: Record<string, string>; choices: Record<string, string>; sites: string[]; summary: string }[] = []
      for (const [index, skillId] of session.skillIds.entries()) {
        if (signal.aborted) throw abortError()
        const skill = skillFromBackend(await req<BackendSkill>(`/api/skills/${encodeURIComponent(skillId)}`))
        const job = index === 0 ? session.first : await post<BackendJob>(`/api/skills/${encodeURIComponent(skillId)}/plans`, { prompt: session.prompt })
        session.jobs.add(job.job_id)
        const result = await followRunJob(job, signal, skill, emit)
        if (result.status !== 'done' || !Array.isArray(result.result?.sites)) throw new Error(result.error?.message || 'The agent could not plan this task.')
        const choices = result.result.choices
        plans.push({ skill, variables: result.result.variables ?? {}, sites: result.result.sites, summary: String(result.result.summary || skill.description),
          choices: isRecord(choices) ? Object.fromEntries(Object.entries(choices).map(([key, value]) => [key, String(value)])) : {} })
      }
      const targets = plans.flatMap((plan, planIndex) => plan.sites.map((url, index) => {
        let name = url
        try { name = new URL(url).hostname.replace(/^www\./, '') } catch { /* keep the planner's text */ }
        return { id: `${id}:${planIndex}:${index}`, url, name, plan }
      }))
      if (!targets.length) throw new Error('The planner did not choose any sites.')
      emit({ type: 'plan', summary: plans.map((plan) => plan.summary).join(' · '), variables: Object.assign({}, ...plans.map((plan) => plan.variables)),
        choices: Object.assign({}, ...plans.map((plan) => plan.choices)),
        targets: targets.map(({ id, url, name, plan }) => ({ id, url, name, skillId: plan.skill.id })) })
      const label = (status: string) => status === 'done' ? 'Done' : status === 'needs_human' ? 'Needs attention' : status === 'cancelled' ? 'Stopped' : 'Failed'
      type TargetResult = { target: typeof targets[number]; job: BackendJob; lastUrl?: string; note: string }
      const runTarget = async (target: typeof targets[number]): Promise<TargetResult> => {
        if (signal.aborted) throw abortError()
        const job = await post<BackendJob>(`/api/skills/${encodeURIComponent(target.plan.skill.id)}/runs`, {
          url: target.url, arguments: target.plan.variables,
        })
        session.jobs.add(job.job_id)
        if (signal.aborted) { await cancel(job.job_id); throw abortError() }
        emit({ type: 'target_start', targetId: target.id, totalSteps: target.plan.skill.steps.length })
        const seen: { lastUrl?: string } = {}
        const final = await followRunJob(job, signal, target.plan.skill, emit, target.id, target.plan.variables, seen)
        if (final.status === 'cancelled') throw abortError()
        const result = final.result
        const status = final.status === 'done' ? 'ok' : final.status === 'needs_human' ? 'needs_human' : 'failed'
        // Agent errors live in result.error; service failures such as a timeout in job.error.
        const detail = result?.error || final.error?.message || ''
        const note = detail ? describeError(detail) : ''
        if (result?.screenshot) emit({ type: 'frame', targetId: target.id, image: new URL(result.screenshot, base).href, final: true })
        emit({ type: 'target_done', targetId: target.id, status, result: {
          Site: target.name, Status: label(final.status),
          ...Object.fromEntries(Object.entries(result?.outputs ?? {}).map(([key, value]) => [key, cell(value)])),
        }, message: note || undefined, detail: detail || undefined })
        return { target, job: final, lastUrl: seen.lastUrl, note }
      }
      // The first site runs alone (it warms the cache and surfaces problems early);
      // the rest share a pool of up to MAX_PARALLEL browsers, each in its own window.
      const results: TargetResult[] = new Array(targets.length)
      results[0] = await runTarget(targets[0])
      let next = 1
      const worker = async () => {
        while (next < targets.length) {
          const index = next++
          results[index] = await runTarget(targets[index])
        }
      }
      await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, targets.length - 1) }, worker))
      // One row per site, with only the columns the backend actually returned.
      const outputKeys = [...new Set(results.flatMap(({ job }) => Object.keys(job.result?.outputs ?? {})))]
      const showPage = !outputKeys.includes('product_url') && results.some(({ lastUrl }) => lastUrl)
      const showNotes = results.some(({ note }) => note)
      const columns = ['Site', 'Status', ...outputKeys, ...(showPage ? ['Final page'] : []), ...(showNotes ? ['Notes'] : [])]
      const rows = results.map(({ target, job, lastUrl, note }) => [target.name, label(job.status),
        ...outputKeys.map((key) => cell(job.result?.outputs?.[key])),
        ...(showPage ? [lastUrl ?? '—'] : []), ...(showNotes ? [note || '—'] : [])])
      const completed = results.filter(({ job }) => job.status === 'done').length
      const outcome = results.some(({ job }) => job.status === 'needs_human') ? 'needs_human' : completed < results.length ? 'failed' : 'done'
      emit({ type: 'done', status: outcome, summary: outcome === 'done' ? `Completed ${results.length} ${results.length === 1 ? 'site' : 'sites'}.` :
        outcome === 'needs_human' ? `${completed} of ${results.length} sites completed. The agent needs your attention on the rest.` :
        `${completed} of ${results.length} sites completed. Check the site details and activity.`,
        table: { columns, rows } })
    } catch (error) {
      await Promise.allSettled([...session.jobs].map(cancel))
      emit({ type: 'error', message: isAbort(error) ? 'Stopped.' : message(error), stopped: isAbort(error) })
    }
  }

  const api: AgentApi = {
    async listSkills() {
      const result = await req<{ skills: BackendSkill[] }>('/api/skills')
      const provisional = new Set([...recordings.values()].map((recording) => recording.job.skill_id))
      return result.skills.filter((skill) => !provisional.has(skill.id)).map(skillFromBackend)
    },
    async saveSkill(draft) {
      if (!draft.backendId) throw new Error('This draft has no saved backend skill. Record the workflow again.')
      const skill = await req<BackendSkill>(`/api/skills/${encodeURIComponent(draft.backendId)}`, { method: 'PATCH',
        body: JSON.stringify({ name: draft.name, description: draft.description }) })
      for (const [id, recording] of recordings) if (recording.job.skill_id === skill.id) recordings.delete(id)
      return skillFromBackend(skill)
    },
    deleteSkill: (id) => req<void>(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    async startRecording(url) {
      const job = await post<BackendJob>('/api/recordings', { url, skill_id: `recorded_${crypto.randomUUID().replaceAll('-', '')}` })
      recordings.set(job.job_id, { job, listeners: new Set(), controller: new AbortController() })
      return { sessionId: job.job_id }
    },
    onRecordingEvents(id, callback) {
      const recording = recordings.get(id)
      if (!recording) throw new Error('Recording session not found.')
      recording.listeners.add(callback)
      void startRecordingMonitor(id)
      return () => {
        recording.listeners.delete(callback)
        if (!recording.listeners.size && !recording.draft) {
          recording.controller.abort()
          recording.controller = new AbortController()
          recording.done = undefined
        }
      }
    },
    async stopRecording(id) {
      await post(`/api/recordings/${encodeURIComponent(id)}/stop`)
      await startRecordingMonitor(id)
      return recordings.get(id)!.draft!
    },
    async cancelRecording(id) {
      const recording = recordings.get(id)
      if (!recording) return
      await cancel(id)
      recording.controller.abort()
      const job = await getJob(id)
      if (job.status === 'done' && job.result?.skill) await api.deleteSkill(job.result.skill.id)
      recordings.delete(id)
    },
    async startRun({ skillIds, prompt }) {
      if (!skillIds.length) throw new Error('Choose a skill first.')
      const first = await post<BackendJob>(`/api/skills/${encodeURIComponent(skillIds[0])}/plans`, { prompt })
      runs.set(first.job_id, { first, skillIds, prompt, jobs: new Set([first.job_id]), controller: new AbortController(), started: false })
      return { runId: first.job_id }
    },
    onRunEvents(id, callback) {
      const session = runs.get(id)
      if (!session || session.started) throw new Error('Run session is unavailable or already subscribed.')
      session.started = true
      void executeRun(id, callback)
      return () => { session.controller.abort(); runs.delete(id) }
    },
    async stopRun(id) {
      const session = runs.get(id)
      if (!session) return
      session.controller.abort()
      await Promise.allSettled([...session.jobs].map(cancel))
      if (!session.started) runs.delete(id)
    },
  }
  return api
}

export const httpApi = createHttpApi(BASE)