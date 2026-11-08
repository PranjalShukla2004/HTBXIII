// Live commentator: listens to the run events the dashboard already receives and yaps about them.
// Lines come from the dev server's /__commentary helper (Gemini writes, ElevenLabs speaks).
// Purely decorative: it never sends anything to the agent backend and never blocks a run.
import { create } from 'zustand'
import type { RunEvent } from '../api'
import { chattiness } from './personalities'

export type RunEventDetail = { e: RunEvent; prompt: string; runKey: string }
export const RUN_EVENT = 'copycat:run-event'

const STALE_MS = 9000         // a moment older than this isn't worth saying any more

type Moment = { kind: string; priority: number; at: number; [k: string]: unknown }

export interface CommentatorSettings {
  enabled: boolean
  persona: string
  /** 1 wholesome · 2 cheeky · 3 out of pocket */
  spice: number
  /** 1 chill · 2 chatty · 3 nonstop */
  chattiness: number
}

interface CommentatorState extends CommentatorSettings {
  caption: string | null
  speaking: boolean
  previewing: boolean
  toggle(): void
  configure(patch: Partial<CommentatorSettings>): void
  preview(): void
}

const KEY = 'copycat:commentator'
const DEFAULTS: CommentatorSettings = { enabled: true, persona: 'pundit', spice: 2, chattiness: 2 }
const saved = ((): CommentatorSettings => {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === 'off') return { ...DEFAULTS, enabled: false }
    return { ...DEFAULTS, ...(raw && raw.startsWith('{') ? JSON.parse(raw) : {}) }
  } catch { return DEFAULTS }
})()
const persist = (s: CommentatorSettings) => {
  try { localStorage.setItem(KEY, JSON.stringify({ enabled: s.enabled, persona: s.persona, spice: s.spice, chattiness: s.chattiness })) } catch { /* private mode */ }
}

export const useCommentator = create<CommentatorState>((set, get) => ({
  ...saved,
  caption: null,
  speaking: false,
  previewing: false,
  toggle() {
    const enabled = !get().enabled
    if (!enabled) stopAudio()
    set({ enabled, ...(enabled ? {} : { caption: null, speaking: false }) })
    persist(get())
  },
  configure(patch) {
    set(patch)
    persist(get())
  },
  async preview() {
    if (get().previewing) return
    set({ previewing: true })
    try {
      const { persona, spice } = get()
      const r = await fetch('/__commentary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sample: true, persona, spice }) })
      if (r.ok) {
        const { text, audio: b64 } = (await r.json()) as { text?: string; audio?: string | null }
        if (text) await play(text, b64 ?? null)
      }
    } catch { /* silence is fine */ } finally {
      set({ previewing: false })
    }
  },
}))

// ---- per-run memory ----
let runKey = ''
let prompt = ''
let names: Record<string, string> = {}
let said: string[] = []
let count = 0
let busy = false
let pending: Moment | null = null
let lastSpokeAt = 0
let running = false
let idleTimer: ReturnType<typeof setInterval> | undefined
const latestStep: Record<string, string> = {}
let audio: HTMLAudioElement | null = null

function stopAudio() {
  audio?.pause()
  audio = null
}

function reset(key: string, p: string) {
  runKey = key
  prompt = p
  names = {}
  said = []
  count = 0
  pending = null
  running = false
  for (const k of Object.keys(latestStep)) delete latestStep[k]
}

const site = (id?: string) => (id && names[id]) || id || 'a site'

function queue(m: { kind: string; priority: number; [k: string]: unknown }) {
  const st = useCommentator.getState()
  if (!st.enabled || (count >= chattiness(st.chattiness).maxLines && m.priority < 4)) return
  const moment = { ...m, at: Date.now() } as Moment
  // Only one line waits at a time: keep the most important (or the newest of equal importance).
  if (!pending || moment.priority >= pending.priority) pending = moment
  void pump()
}

async function pump() {
  if (busy || !pending) return
  const m = pending
  pending = null
  if (m.priority < 3 && Date.now() - m.at > STALE_MS) return void pump()
  busy = true
  count++
  try {
    const r = await fetch('/__commentary', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ moment: { ...m, request: prompt, sites: Object.values(names) }, said,
        persona: useCommentator.getState().persona, spice: useCommentator.getState().spice }),
    })
    if (!r.ok || r.status === 204) return
    const { text, audio: b64 } = (await r.json()) as { text?: string; audio?: string | null }
    if (!text || !useCommentator.getState().enabled) return
    said.push(text)
    await play(text, b64 ?? null)
  } catch {
    // Silence is fine.
  } finally {
    busy = false
    lastSpokeAt = Date.now()
    if (pending) void pump()
  }
}

function play(text: string, b64: string | null) {
  useCommentator.setState({ caption: text, speaking: true })
  const done = () => {
    useCommentator.setState({ speaking: false })
    setTimeout(() => { if (useCommentator.getState().caption === text) useCommentator.setState({ caption: null }) }, 1800)
  }
  if (!b64) {
    // No voice (no key or it failed): show the caption for a reading-length moment.
    return new Promise<void>((resolve) => setTimeout(() => (done(), resolve()), 1200 + text.length * 45))
  }
  return new Promise<void>((resolve) => {
    stopAudio()
    audio = new Audio(`data:audio/mpeg;base64,${b64}`)
    const finish = () => (done(), resolve())
    audio.onended = finish
    audio.onerror = finish
    audio.play().catch(finish)
  })
}

function startIdleYap() {
  clearInterval(idleTimer)
  idleTimer = setInterval(() => {
    if (!running) return clearInterval(idleTimer)
    if (busy || pending || Date.now() - lastSpokeAt < chattiness(useCommentator.getState().chattiness).idleMs) return
    const ids = Object.keys(latestStep)
    if (!ids.length) return
    const id = ids[Math.floor(Math.random() * ids.length)]
    queue({ kind: 'filler: yap about what this site is doing right now', site: site(id), doing: latestStep[id], priority: 0 })
  }, 1500)
}

function onEvent({ e, prompt: p, runKey: key }: RunEventDetail) {
  if (key !== runKey) reset(key, p)
  switch (e.type) {
    case 'plan':
      for (const t of e.targets) names[t.id] = t.name
      running = true
      lastSpokeAt = Date.now()
      startIdleYap()
      queue({ kind: 'opening: introduce the run, what we are after and which shops we are raiding', summary: e.summary,
        variables: e.variables, budget: e.constraints?.maxPrice ?? e.constraints?.totalBudget, currency: e.constraints?.currency, priority: 4 })
      break
    case 'step':
      if (e.status === 'running') latestStep[e.targetId] = e.description
      break
    case 'heal':
      queue({ kind: 'self-heal: the site used different wording and the agent adapted', site: site(e.targetId), detail: e.message,
        learned: e.learned?.phrase, priority: 2 })
      break
    case 'needs_human':
      queue({ kind: 'blocked: the site wants a human (captcha, login, cookie wall)', site: site(e.targetId), detail: e.message, priority: 2 })
      break
    case 'question':
      queue({ kind: 'the agent paused to ask the shopper something', site: site(e.targetId), question: e.question, priority: 2 })
      break
    case 'target_done': {
      delete latestStep[e.targetId]
      const result = e.result ? Object.fromEntries(Object.entries(e.result).filter(([k]) => !/url|image|screenshot/i.test(k)).slice(0, 6)) : undefined
      queue({ kind: e.status === 'ok' ? 'a site finished and got the item in the basket' : e.status === 'found' ? 'a site found the product but could not add it to the basket'
        : e.status === 'failed' ? 'a site failed' : 'a site is stuck waiting for a human', site: site(e.targetId), result, detail: e.message, priority: e.status === 'failed' ? 2 : 3 })
      break
    }
    case 'done':
      running = false
      clearInterval(idleTimer)
      queue({ kind: 'closing: wrap up the whole run with a final verdict', summary: e.summary, status: e.status ?? 'done', priority: 5 })
      break
    case 'error':
      running = false
      clearInterval(idleTimer)
      queue({ kind: 'the run hit an error, console everyone', detail: e.message, priority: 5 })
      break
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(RUN_EVENT, (ev) => onEvent((ev as CustomEvent<RunEventDetail>).detail))
}
