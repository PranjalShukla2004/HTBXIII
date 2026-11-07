// Shared contract between the dashboard and the agent backend.
// Mirrors the scope doc: steps store *meaning* (intent + fingerprint), never selectors.
// Full HTTP description lives in API.md.

/** How the matcher found an element on an unseen page. Drives the colour coding. */
export type Tier = 'exact' | 'synonym' | 'fuzzy' | 'heal' | 'complete'

export interface Fingerprint {
  role?: string
  name?: string
  label?: string
  placeholder?: string
  text?: string
  heading?: string
}

export type StepIntent = 'navigate' | 'fill' | 'click' | 'select' | 'check' | 'chat' | 'wait' | 'verify' | 'extract'

export interface Step {
  id: string
  intent: StepIntent
  /** Plain-English line shown to the user, e.g. "Enter the quantity". */
  description: string
  /** Synonym-library key, e.g. "field.quantity" or "submit_quote". */
  action_type?: string
  /** Variable this step reads, e.g. "qty". */
  slot?: string
  /** Literal or template value, e.g. "{{qty}}". */
  value?: string
  optional?: boolean
  fingerprint?: Fingerprint
}

export interface SkillVariable {
  name: string
  /** Value captured during the recording. */
  example: string
  description?: string
}

export interface Skill {
  id: string
  name: string
  description: string
  site: { url: string; title: string }
  steps: Step[]
  variables: SkillVariable[]
  createdAt: string
  runs?: number
}

/** A compiled-but-unsaved skill returned when recording stops. */
export type SkillDraft = Omit<Skill, 'id' | 'createdAt' | 'runs'> & { backendId?: string }

/** One raw action captured live by the recorder. */
export interface RecordedAction {
  id: string
  kind: 'navigate' | 'click' | 'change' | 'submit'
  /** Short human summary, e.g. 'Typed "500" into Quantity'. */
  summary: string
  url: string
  ts: string
}

export type RecordingEvent =
  | { type: 'action'; action: RecordedAction }
  | { type: 'processing' }
  | { type: 'compiled'; draft: SkillDraft }
  | { type: 'error'; message: string }
  | { type: 'connection'; state: 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error' }

export interface RunTarget {
  id: string
  name: string
  url: string
}

export interface ResultTable {
  columns: string[]
  rows: (string | number)[][]
  /** Index of the row to highlight as best. */
  bestRow?: number
}

export type RunEvent =
  | { type: 'plan'; summary: string; variables: Record<string, string>; targets: RunTarget[] }
  | { type: 'target_start'; targetId: string; totalSteps: number }
  | {
      type: 'step'
      targetId: string
      stepIndex: number
      description: string
      status: 'running' | 'ok' | 'failed' | 'skipped'
      tier?: Tier
    }
  /** `recorded` is the label the user clicked while recording; `phrase` is what this site calls it. */
  | { type: 'heal'; targetId: string; stepIndex: number; message: string; learned?: { action_type: string; phrase: string; recorded?: string } }
  /** The site stopped mid-run for a person (captcha, login). `resumable` means `resumeTarget` can continue it. */
  | { type: 'needs_human'; targetId: string; message: string; resumable?: boolean }
  | { type: 'browser'; targetId: string; status: 'opened' | 'closed'; url: string }
  /** Live preview for the mini browser window. JPEG data URL or http URL, ~2-4 fps is plenty. */
  | { type: 'frame'; targetId: string; image: string; url?: string; final?: boolean }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; targetId?: string; ts: string; id?: string; partial?: boolean; source?: string; jobId?: string }
  | { type: 'model'; id: string; tag: string; text: string; targetId?: string; ts: string; reset?: boolean }
  | { type: 'connection'; channel: string; state: 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error'; targetId?: string }
  | { type: 'logs_snapshot'; targetId?: string; text: string; ts: string; jobId?: string }
  | { type: 'target_done'; targetId: string; status: 'ok' | 'failed' | 'needs_human'; result?: Record<string, string | number>; message?: string }
  | { type: 'done'; summary: string; table?: ResultTable; needsApproval?: string; status?: 'done' | 'failed' | 'needs_human' }
  | { type: 'error'; message: string; stopped?: boolean }

export type Unsubscribe = () => void

export interface AgentApi {
  listSkills(): Promise<Skill[]>
  saveSkill(draft: SkillDraft): Promise<Skill>
  deleteSkill(id: string): Promise<void>

  startRecording(startUrl: string): Promise<{ sessionId: string }>
  onRecordingEvents(sessionId: string, cb: (event: RecordingEvent) => void): Unsubscribe
  stopRecording(sessionId: string): Promise<SkillDraft>
  cancelRecording(sessionId: string): Promise<void>

  startRun(req: { skillIds: string[]; prompt: string }): Promise<{ runId: string }>
  onRunEvents(runId: string, cb: (e: RunEvent) => void): Unsubscribe
  stopRun(runId: string): Promise<void>
  /** Continue a site after the person has handled it. Only the mock supports this today. */
  resumeTarget?(runId: string, targetId: string): Promise<void>
}
