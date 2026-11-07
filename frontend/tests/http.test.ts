import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHttpApi } from '../src/api/http.ts'
import type { BackendJob, BackendSkill } from '../src/api/backend.ts'
import type { RecordingEvent, RunEvent } from '../src/api/types.ts'
import { FakeSocket, frame, until } from './helpers.ts'

function harness(t: TestContext, outcome = 'done') {
  const originalFetch = globalThis.fetch
  const originalSocket = globalThis.WebSocket
  const jobs = new Map<string, BackendJob>()
  const skills = new Map<string, BackendSkill>([['shopping', { id: 'shopping', goal: 'Buy {{query}}',
    arguments: { query: { type: 'string', default: 'shoes' } }, steps: [{ op: 'search', target: 'Product search' }] }]])
  const sockets: ReplaySocket[] = []
  const cancelled: string[] = []
  let planningFinished = false
  let runsStarted = 0
  let logRequests = 0
  const makeJob = (kind: BackendJob['kind'], skillId: string) => {
    const id = `${kind}-${jobs.size}`
    const job: BackendJob = { job_id: id, kind, skill_id: skillId, url: 'https://shop.example', status: 'queued', result: null, error: null,
      created_at: 0, log_url: `/api/jobs/${id}/logs`, streams: { events: `/ws/jobs/${id}/events`, llm: `/ws/jobs/${id}/llm` } }
    jobs.set(id, job)
    return job
  }
  const finish = (job: BackendJob) => {
    for (const socket of sockets.filter((item) => item.jobId === job.job_id && !item.closed)) {
      socket.publish(job.status === 'done' ? 'completed' : job.status, { status: job.status, result: job.result, error: job.error })
    }
  }
  class ReplaySocket extends FakeSocket {
    jobId: string
    channel: 'llm' | 'events'
    seq = 0
    constructor(url: string) {
      super(url)
      const parts = new URL(url).pathname.split('/')
      this.jobId = parts[3]; this.channel = parts[4] as 'llm' | 'events'
      sockets.push(this)
      queueMicrotask(() => {
        this.open()
        const job = jobs.get(this.jobId)!
        if (job.kind === 'recording') {
          if (this.channel === 'events') this.publish('recorder', { kind: 'click', el: { text: 'Add to cart' }, url: job.url })
          return
        }
        if (job.kind === 'plan') {
          job.result = { variables: { query: 'ps5' }, sites: ['https://shop.example'], summary: 'Find a PS5' }
          job.status = 'done'
          if (this.channel === 'events') this.publish('completed', { status: 'done', result: job.result, error: null })
          else {
            this.publish('llm.start', { call_id: 'plan', tag: 'plan', attempt: 1 })
            this.publish('llm.delta', { call_id: 'plan', tag: 'plan', attempt: 1, text: 'generated plan' })
            setTimeout(() => { planningFinished = true; this.publish('completed', { status: 'done', result: job.result, error: null }) }, 15)
          }
          return
        }
        if (outcome === 'block') return
        job.status = outcome === 'truncated' ? 'done' : outcome
        job.result = { outputs: { price: '$499', details: { quantity: 1 } }, screenshot: `/api/jobs/${job.job_id}/screenshot`, error: outcome === 'done' ? null : 'Please check the page' }
        if (this.channel === 'events') {
          this.publish('gap', { after: 0 })
          this.publish('log', { message: 'old duplicate from replay' })
          this.seq = 21
          this.publish('action', { step: 0, op: 'search', value: 'ps5' })
          this.publish('log', { message: 'Added this item to cart', level: 'info' })
        } else this.publish('llm.delta', { call_id: 'ground', tag: 'ground', attempt: 1, text: 'generated action' })
        this.publish(job.status === 'done' ? 'completed' : job.status, outcome === 'truncated' ? { truncated: true } : { status: job.status, result: job.result, error: null })
      })
    }
    publish(type: string, data: Record<string, unknown>) { this.send(frame(type, data, ++this.seq, this.channel, this.jobId)) }
  }
  globalThis.WebSocket = ReplaySocket as unknown as typeof WebSocket
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const parts = path.split('/')
    if (path === '/api/skills') return Response.json({ skills: [...skills.values()] })
    if (path === '/api/recordings' && method === 'POST') return Response.json(makeJob('recording', body.skill_id))
    if (parts[2] === 'recordings' && parts[4] === 'stop') {
      const job = jobs.get(parts[3])!
      const skill = { ...skills.get('shopping')!, id: job.skill_id, site: { url: job.url, title: 'Shop' } }
      skills.set(skill.id, skill)
      job.status = 'done'; job.result = { skill }
      sockets.filter((socket) => socket.jobId === job.job_id && socket.channel === 'events').forEach((socket) => socket.publish('status', { status: 'processing' }))
      finish(job)
      return Response.json(job)
    }
    if (parts[2] === 'skills') {
      if (parts[4] === 'plans') return Response.json(makeJob('plan', parts[3]))
      if (parts[4] === 'runs') {
        assert.equal(planningFinished, true, 'must consume the late LLM terminal before starting the browser job')
        assert.deepEqual(body.arguments, { query: 'ps5' })
        runsStarted++
        return Response.json(makeJob('run', parts[3]))
      }
      if (method === 'DELETE') { skills.delete(parts[3]); return new Response(null, { status: 204 }) }
      if (method === 'PATCH') { const skill = { ...skills.get(parts[3])!, ...body }; skills.set(skill.id, skill); return Response.json(skill) }
      return Response.json(skills.get(parts[3]))
    }
    const job = jobs.get(parts[3])!
    if (parts[4] === 'logs') { logRequests++; return new Response('Complete recovered log\n', { headers: { 'X-Log-Sequence': '20' } }) }
    if (parts[4] === 'cancel') {
      cancelled.push(job.job_id)
      if (!['done', 'failed', 'needs_human'].includes(job.status)) { job.status = 'cancelled'; finish(job) }
    }
    return Response.json(job)
  }
  t.after(() => { globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; sockets.forEach((socket) => socket.close()) })
  return { api: createHttpApi('http://agent.example'), sockets, jobs, cancelled, skills, get runsStarted() { return runsStarted }, get logRequests() { return logRequests } }
}

test('plans and runs through both streams; recovers lost logs and renders real outputs', async (t) => {
  const h = harness(t)
  const events: RunEvent[] = []
  const { runId } = await h.api.startRun({ skillIds: ['shopping'], prompt: 'Find a ps5 at shop.example' })
  const stop = h.api.onRunEvents(runId, (event) => events.push(event))
  t.after(stop)
  await until(() => events.some((event) => event.type === 'done'))
  assert.equal(h.runsStarted, 1)
  assert.equal(h.logRequests, 1)
  assert.ok(events.some((event) => event.type === 'logs_snapshot' && event.text.includes('recovered')))
  assert.ok(!events.some((event) => event.type === 'log' && event.message.includes('old duplicate')))
  assert.ok(events.some((event) => event.type === 'log' && event.message === 'Added this item to cart'))
  assert.ok(events.some((event) => event.type === 'model' && event.text === 'generated plan'))
  assert.ok(events.some((event) => event.type === 'model' && event.text === 'generated action'))
  assert.ok(events.some((event) => event.type === 'frame' && event.final && event.image.startsWith('http://agent.example/')))
  const done = events.find((event) => event.type === 'done')!
  assert.deepEqual(done.table, { columns: ['Site', 'Status', 'price', 'details'], rows: [['shop.example', 'Done', '$499', '{"quantity":1}']] })
  assert.equal(done.needsApproval, undefined)
  assert.ok(h.sockets.every((socket) => socket.closed && socket.onmessage === null))
})

for (const outcome of ['needs_human', 'failed']) test(`${outcome} stays visible instead of becoming success`, async (t) => {
  const h = harness(t, outcome)
  const events: RunEvent[] = []
  const { runId } = await h.api.startRun({ skillIds: ['shopping'], prompt: 'Find ps5' })
  t.after(h.api.onRunEvents(runId, (event) => events.push(event)))
  await until(() => events.some((event) => event.type === 'done'))
  assert.equal(events.find((event) => event.type === 'done')!.status, outcome)
  assert.equal(events.find((event) => event.type === 'target_done')!.message, 'Please check the page')
})

test('recovers oversized terminal results from the existing job endpoint', async (t) => {
  const h = harness(t, 'truncated')
  const events: RunEvent[] = []
  const { runId } = await h.api.startRun({ skillIds: ['shopping'], prompt: 'Find ps5' })
  t.after(h.api.onRunEvents(runId, (event) => events.push(event)))
  await until(() => events.some((event) => event.type === 'done'))
  assert.equal(events.find((event) => event.type === 'done')!.status, 'done')
  assert.equal(events.find((event) => event.type === 'done')!.table!.rows[0][2], '$499')
})

test('stop cancels active jobs and closes every socket', async (t) => {
  const h = harness(t, 'block')
  const events: RunEvent[] = []
  const { runId } = await h.api.startRun({ skillIds: ['shopping'], prompt: 'Find ps5' })
  t.after(h.api.onRunEvents(runId, (event) => events.push(event)))
  await until(() => h.runsStarted === 1 && h.sockets.length === 4)
  await h.api.stopRun(runId)
  await until(() => events.some((event) => event.type === 'error'))
  assert.equal(events.find((event) => event.type === 'error')!.stopped, true)
  assert.ok(h.cancelled.includes('run-1'))
  assert.ok(h.sockets.every((socket) => socket.closed && socket.onmessage === null))
})

test('recording events reach REC, compilation becomes a draft, Save persists and Discard deletes', async (t) => {
  const h = harness(t)
  for (const save of [true, false]) {
    const events: RecordingEvent[] = []
    const { sessionId } = await h.api.startRecording('https://shop.example')
    const stop = h.api.onRecordingEvents(sessionId, (event) => events.push(event))
    await until(() => events.some((event) => event.type === 'action'))
    const draft = await h.api.stopRecording(sessionId)
    assert.ok(events.some((event) => event.type === 'processing'))
    assert.ok(events.some((event) => event.type === 'compiled'))
    assert.ok(draft.backendId)
    assert.equal((await h.api.listSkills()).some((skill) => skill.id === draft.backendId), false)
    if (save) {
      const saved = await h.api.saveSkill({ ...draft, name: 'My shopping skill' })
      assert.equal(saved.name, 'My shopping skill')
      assert.ok((await h.api.listSkills()).some((skill) => skill.id === saved.id))
    } else {
      await h.api.cancelRecording(sessionId)
      assert.equal(h.skills.has(draft.backendId!), false)
    }
    stop()
  }
  assert.ok(h.sockets.every((socket) => socket.closed && socket.onmessage === null))
})
