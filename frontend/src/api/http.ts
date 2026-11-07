import type { AgentApi, RecordedAction, RunEvent, Skill, SkillDraft } from './types'

// Real backend client. Endpoints are documented in API.md.
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8000'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`)
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/** Server-Sent Events stream; each `data:` line is one JSON event. */
function stream<T>(path: string, cb: (e: T) => void) {
  const es = new EventSource(BASE + path)
  es.onmessage = (m) => {
    try {
      cb(JSON.parse(m.data) as T)
    } catch (err) {
      console.warn('Bad event', m.data, err)
    }
  }
  return () => es.close()
}

export const httpApi: AgentApi = {
  listSkills: () => req<Skill[]>('/skills'),
  saveSkill: (draft: SkillDraft) => req<Skill>('/skills', { method: 'POST', body: JSON.stringify(draft) }),
  deleteSkill: (id) => req<void>(`/skills/${id}`, { method: 'DELETE' }),

  startRecording: (startUrl) =>
    req<{ sessionId: string }>('/record/start', { method: 'POST', body: JSON.stringify({ startUrl }) }),
  onRecordingEvents: (id, cb) => stream<RecordedAction>(`/record/${id}/events`, cb),
  stopRecording: (id) => req<SkillDraft>(`/record/${id}/stop`, { method: 'POST' }),
  cancelRecording: (id) => req<void>(`/record/${id}/cancel`, { method: 'POST' }),

  startRun: (body) => req<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify(body) }),
  onRunEvents: (id, cb) => stream<RunEvent>(`/runs/${id}/events`, cb),
  stopRun: (id) => req<void>(`/runs/${id}/stop`, { method: 'POST' }),
}
