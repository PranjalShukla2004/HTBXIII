import type { Tier } from '../api'

export const TIER_META: Record<Tier | 'skipped', { label: string; color: string; hint: string }> = {
  exact: { label: 'Exact', color: 'var(--color-exact)', hint: 'Same role and label as the recording' },
  synonym: { label: 'Synonym', color: 'var(--color-synonym)', hint: 'Matched through the synonym library' },
  fuzzy: { label: 'Fuzzy', color: 'var(--color-fuzzy)', hint: 'Similar label or nearby text' },
  heal: { label: 'Self-heal', color: 'var(--color-heal)', hint: 'The model looked at the page and picked it' },
  complete: { label: 'Completed', color: 'var(--color-accent-2)', hint: 'The backend completed this step; no matcher tier was reported' },
  skipped: { label: 'Skipped', color: 'var(--color-rule)', hint: 'Optional step, not needed here' },
}

const AVATAR = ['#9d90ff', '#60a5fa', '#4ade80', '#fbbf24', '#f472b6', '#22d3ee', '#fb923c']
export function avatarColor(name: string) {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return AVATAR[h % AVATAR.length]
}

/** Four-letter strip code, like a callsign: "Parcel & Pixel" → "PRCL". */
export function stripCode(name: string) {
  const words = name.replace(/[^a-z0-9 ]/gi, ' ').split(/\s+/).filter(Boolean)
  if (words.length >= 2) return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase() + (words.length === 2 ? words[1][1]?.toUpperCase() ?? '' : '')
  const w = (words[0] ?? 'SKL').toUpperCase()
  const consonants = w[0] + w.slice(1).replace(/[AEIOU]/g, '')
  return (consonants.length >= 4 ? consonants : w).slice(0, 4)
}

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function hostOf(url: string) {
  try {
    const u = new URL(url)
    return u.host + (u.pathname !== '/' ? u.pathname : '')
  } catch {
    return url
  }
}

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')
