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
  /** Plan only: product options the user stated (e.g. size). Sent to each run as `choices`. */
  choices?: Record<string, string>
  /** Plan only: the Google Sheet to log results to, and whether the user asked for it. */
  sheet_url?: string | null
  log_to_sheet?: boolean
  /** Plan only: budget, number of different products, requirements. Sent to runs as-is. */
  constraints?: BackendConstraints
  /** Run only, with constraints: one entry per different product put in the basket. */
  items?: Record<string, unknown>[]
  /** Run only: e.g. "added 2 of 3 items; ...". */
  note?: string | null
  [key: string]: unknown
}

export interface BackendConstraints {
  items?: number
  max_price?: number | null
  total_budget?: number | null
  currency?: string | null
  requirements?: string[]
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
  /** Set while a run waits for the shopper (POST /api/jobs/{id}/answer continues it). */
  question?: { field: string; question: string; options: string[] } | null
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