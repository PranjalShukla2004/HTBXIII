import { httpApi } from './http'
import { mockApi } from './mock'
import type { AgentApi } from './types'

/** Flip VITE_USE_MOCK=false in .env.local once the backend is running. */
export const USE_MOCK = (import.meta.env.VITE_USE_MOCK ?? 'true') !== 'false'

export const api: AgentApi = USE_MOCK ? mockApi : httpApi
export type * from './types'
