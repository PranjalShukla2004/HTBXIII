// What each skill has done so far, kept in this browser (the backend has no history yet).
import { USE_MOCK } from '../api'

export interface SkillStats {
  runs: number
  /** Per site: how many times it finished, out of how many tries. */
  sites: Record<string, { ok: number; tries: number }>
  /** Phrases learned by self-heal. */
  phrases: string[]
  /** How long the recording took, used to estimate time saved. */
  recordedMs?: number
}

const KEY = 'copycat.skill-stats.v1'

const MOCK_SEED: Record<string, SkillStats> = {
  sk_shop: { runs: 1, sites: { VoltMart: { ok: 1, tries: 1 } }, phrases: [], recordedMs: 3.5 * 60_000 },
  sk_quote: { runs: 3, sites: { 'Northwind Supply': { ok: 3, tries: 3 }, 'Ferro Direct': { ok: 2, tries: 3 } }, phrases: [], recordedMs: 4 * 60_000 },
}

export function loadStats(): Record<string, SkillStats> {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as Record<string, SkillStats>
  } catch {
    /* ignore */
  }
  return USE_MOCK ? MOCK_SEED : {}
}

export function saveStats(stats: Record<string, SkillStats>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(stats))
  } catch {
    /* ignore */
  }
}

export const emptyStats = (): SkillStats => ({ runs: 0, sites: {}, phrases: [] })

export function withRun(s: SkillStats | undefined, sites: { name: string; ok: boolean }[], phrases: string[]): SkillStats {
  const next = { ...emptyStats(), ...s, sites: { ...s?.sites } }
  next.runs += 1
  for (const site of sites) {
    const prev = next.sites[site.name] ?? { ok: 0, tries: 0 }
    next.sites[site.name] = { ok: prev.ok + Number(site.ok), tries: prev.tries + 1 }
  }
  next.phrases = [...new Set([...(s?.phrases ?? []), ...phrases])]
  return next
}

export function successRate(s?: SkillStats) {
  const all = Object.values(s?.sites ?? {})
  const tries = all.reduce((n, x) => n + x.tries, 0)
  return tries ? { ok: all.reduce((n, x) => n + x.ok, 0), tries } : undefined
}
