/** Wire types for the existing Python API, separate from the dashboard view model. */
export interface BackendStep {
  op: string
  target: string
  value?: string | null
  output?: string | null
  optional?: boolean
}

export interface BackendSkill {
  id: string
  goal: string
  name?: string
  description?: string
  site?: { url: string; title: string } | null
  created_at?: string
  arguments: Record<string, { type: string; default: string }>
  steps: BackendStep[]
}

export interface BackendResult {
  url?: string
  status?: string
  bindings?: { step: number; action?: string; value?: string; locator: Record<string, unknown> }[]
  outputs?: Record<string, unknown>
  variables?: Record<string, string>
  screenshot?: string | null
  error?: string | null
  skill?: BackendSkill
  summary?: string
  sites?: string[]
  [key: string]: unknown
}

export interface BackendJob {
  job_id: string
  kind: 'run' | 'recording' | 'plan'
  skill_id: string
  url: string
  status: string
  created_at: number
  result: BackendResult | null
  error: { code: string; message: string } | null
  log_url: string
  streams: { llm: string; events: string }
}

export interface JobFrame {
  v: 1
  job_id: string
  channel: 'llm' | 'events'
  seq: number
  type: string
  data: Record<string, unknown>
  t: number
}

export const TERMINAL = new Set(['completed', 'failed', 'needs_human', 'cancelled'])
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function parseFrame(value: unknown, jobId: string, channel: string): JobFrame | null {
  if (!isRecord(value) || value.v !== 1 || value.job_id !== jobId || value.channel !== channel ||
      !Number.isSafeInteger(value.seq) || Number(value.seq) < 1 || typeof value.type !== 'string' ||
      typeof value.t !== 'number' || !Number.isFinite(value.t) || !isRecord(value.data)) return null
  return value as unknown as JobFrame
}
