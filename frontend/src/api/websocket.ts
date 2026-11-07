import { parseFrame, TERMINAL } from './backend.ts'
import type { JobFrame } from './backend.ts'

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error'
type Socket = Pick<WebSocket, 'onopen' | 'onmessage' | 'onerror' | 'onclose' | 'close'>

export function websocketUrl(base: string, path: string, after = 0): string {
  const url = new URL(path, base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('after', String(after))
  return url.href
}

/** One read-only subscription, with its own replay cursor and deterministic cleanup. */
export function subscribeJob(options: {
  base: string
  path: string
  jobId: string
  channel: 'llm' | 'events'
  onFrame: (frame: JobFrame) => void | Promise<void>
  onState?: (state: ConnectionState) => void
  onError: (error: Error) => void
  makeSocket?: (url: string) => Socket
  retryDelay?: number
  maxRetries?: number
}) {
  let socket: Socket | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let cursor = 0
  let attempts = 0
  let stopped = false
  let delivery = Promise.resolve()
  const create = options.makeSocket ?? ((url: string) => new WebSocket(url))

  const detach = () => {
    if (!socket) return
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
    socket.close()
    socket = undefined
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    detach()
  }
  const fail = (message: string) => {
    stop()
    options.onState?.('error')
    options.onError(new Error(message))
  }
  const retry = (code?: number) => {
    if (stopped || timer) return
    if (code === 1008 || code === 1003 || attempts >= (options.maxRetries ?? 6)) {
      fail(code === 1008 ? 'The job stream is unavailable or its Origin is not allowed.' : 'Connection lost. Stop this job or try again once the agent is available.')
      return
    }
    detach()
    options.onState?.('reconnecting')
    const delay = Math.min((options.retryDelay ?? 500) * 2 ** attempts++, 10000)
    timer = setTimeout(() => { timer = undefined; open() }, delay)
  }
  const open = () => {
    if (stopped) return
    options.onState?.(attempts ? 'reconnecting' : 'connecting')
    try {
      const current = create(websocketUrl(options.base, options.path, cursor))
      socket = current
      current.onopen = () => { if (!stopped) options.onState?.('connected') }
      current.onmessage = ({ data }) => {
        delivery = delivery.then(async () => {
          if (stopped) return
          let parsed: unknown
          try { parsed = JSON.parse(String(data)) } catch { return }
          const frame = parseFrame(parsed, options.jobId, options.channel)
          if (!frame || frame.seq <= cursor) return
          await options.onFrame(frame)
          cursor = frame.seq
          attempts = 0
          if (TERMINAL.has(frame.type)) {
            options.onState?.('closed')
            stop()
          }
        }).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
      }
      current.onerror = () => { if (socket === current) retry() }
      current.onclose = ({ code }) => {
        // Let already-delivered terminal frames finish before deciding to reconnect.
        void delivery.then(() => { if (socket === current) retry(code) })
      }
    } catch {
      retry()
    }
  }
  open()
  return stop
}
