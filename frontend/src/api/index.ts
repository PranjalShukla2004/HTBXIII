import { httpApi } from './http'
import { mockApi } from './mock'
import type { AgentApi } from './types'

/** Real backend by default; VITE_USE_MOCK=true keeps the original offline demo. */
export const USE_MOCK = (import.meta.env.VITE_USE_MOCK ?? 'false') !== 'false'

export const api: AgentApi = USE_MOCK ? mockApi : httpApi
export type * from './types'
