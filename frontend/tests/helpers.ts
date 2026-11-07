import type { JobFrame } from '../src/api/backend.ts'

export const wait = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms))
export async function until(check: () => boolean, description = 'condition') {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await wait()
  }
  throw new Error(`Timed out waiting for ${description}`)
}

export function frame(type: string, data: Record<string, unknown> = {}, seq = 1, channel: 'events' | 'llm' = 'events', jobId = 'job'): JobFrame {
  return { v: 1, job_id: jobId, channel, seq, type, data, t: 1_800_000_000 }
}

export class FakeSocket {
  url: string
  closed = false
  onopen: WebSocket['onopen'] = null
  onmessage: WebSocket['onmessage'] = null
  onerror: WebSocket['onerror'] = null
  onclose: WebSocket['onclose'] = null
  constructor(url: string) { this.url = url }
  open() { this.onopen?.call(this as unknown as WebSocket, {} as Event) }
  send(value: unknown) {
    this.onmessage?.call(this as unknown as WebSocket, { data: JSON.stringify(value) } as MessageEvent)
  }
  disconnect(code = 1006) { this.onclose?.call(this as unknown as WebSocket, { code } as CloseEvent) }
  close() { this.closed = true }
}
