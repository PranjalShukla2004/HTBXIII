import type { RecordedAction } from '../api'

/** Guess the variable a typed value will become: “500” into Quantity → {qty}. */
export function learnVar(a: RecordedAction): { value: string; name: string } | null {
  const s = a.summary
  const typed = s.match(/(?:Typed|Chose|Selected) “([^”]+)” (?:into|in) (.+)$/)
  const set = s.match(/^Set (.+?) to (.+)$/)
  const picked = s.match(/^Picked (.+?) in (.+)$/)
  const [value, field] = typed ? [typed[1], typed[2]] : set ? [set[2], set[1]] : picked ? [picked[1], picked[2]] : []
  if (!value || !field) return null
  const f = field.toLowerCase()
  const name = /qty|quantit|units/.test(f) ? 'qty'
    : /search|product|item/.test(f) ? 'product'
    : /e-?mail/.test(f) ? 'email'
    : /date|needed by|deliver/.test(f) ? 'delivery_date'
    : f.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'value'
  return { value, name }
}
