import test from 'node:test'
import assert from 'node:assert/strict'
import { subscribeJob, websocketUrl } from '../src/api/websocket.ts'
import { FakeSocket, frame, until, wait } from './helpers.ts'

test('uses the API origin, secure scheme and independent replay cursor', () => {
  assert.equal(websocketUrl('https://agent.example', '/ws/jobs/a/llm', 8), 'wss://agent.example/ws/jobs/a/llm?after=8')
  assert.equal(websocketUrl('http://localhost:8000', '/ws/jobs/a/events'), 'ws://localhost:8000/ws/jobs/a/events?after=0')
})

test('validates envelopes, ignores duplicates and resumes after the last delivered frame', async () => {
  const sockets: FakeSocket[] = []
  const delivered: number[] = []
  const states: string[] = []
  const stop = subscribeJob({ base: 'http://localhost:8000', path: '/ws/jobs/job/events', jobId: 'job', channel: 'events',
    makeSocket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket },
    retryDelay: 1, onState: (state) => states.push(state), onError: assert.fail,
    onFrame: async (event) => { await wait(); delivered.push(event.seq) },
  })
  try {
    const socket = sockets[0]
    socket.open()
    socket.send({ ...frame('log'), v: 2 })
    socket.send(frame('log', {}, 1, 'llm'))
    socket.send(frame('log', {}, 1, 'events', 'another-job'))
    socket.send({ ...frame('log'), data: [] })
    socket.send(frame('log', {}, 1))
    socket.send(frame('log', {}, 1))
    socket.send(frame('log', {}, 2))
    socket.disconnect()
    await until(() => sockets.length === 2)
    assert.deepEqual(delivered, [1, 2])
    assert.equal(new URL(sockets[1].url).searchParams.get('after'), '2')
    assert.ok(states.includes('reconnecting'))
    sockets[1].send(frame('log', {}, 2))
    sockets[1].send(frame('completed', { status: 'done' }, 3))
    sockets[1].disconnect(1000)
    await until(() => states.includes('closed'))
    await wait(15)
    assert.deepEqual(delivered, [1, 2, 3])
    assert.equal(sockets.length, 2)
    assert.ok(sockets.every((item) => item.closed && item.onmessage === null))
  } finally { stop() }
})

test('unsubscribe closes the socket, detaches listeners and cancels a pending retry', async () => {
  const sockets: FakeSocket[] = []
  const stop = subscribeJob({ base: 'http://localhost:8000', path: '/ws/jobs/job/events', jobId: 'job', channel: 'events',
    makeSocket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket },
    retryDelay: 20, onFrame: assert.fail, onError: assert.fail,
  })
  sockets[0].disconnect()
  await wait()
  stop(); stop()
  await wait(30)
  assert.equal(sockets.length, 1)
  assert.equal(sockets[0].closed, true)
  assert.equal(sockets[0].onclose, null)
})

test('policy rejection fails visibly without retrying', async () => {
  const socket = new FakeSocket('')
  const errors: Error[] = []
  subscribeJob({ base: 'http://localhost:8000', path: '/ws/jobs/job/events', jobId: 'job', channel: 'events',
    makeSocket: () => socket, onFrame: assert.fail, onError: (error) => errors.push(error),
  })
  socket.disconnect(1008)
  await until(() => errors.length === 1)
  assert.match(errors[0].message, /Origin/)
  assert.equal(socket.closed, true)
})

test('bounds reconnect attempts even if sockets open but deliver no data', async () => {
  const sockets: FakeSocket[] = []
  const errors: Error[] = []
  subscribeJob({ base: 'http://localhost:8000', path: '/ws/jobs/job/events', jobId: 'job', channel: 'events', maxRetries: 2, retryDelay: 1,
    makeSocket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket },
    onFrame: assert.fail, onError: (error) => errors.push(error),
  })
  for (let i = 0; i < 3; i++) {
    await until(() => sockets.length > i)
    sockets[i].open(); sockets[i].disconnect()
  }
  await until(() => errors.length === 1)
  assert.equal(sockets.length, 3)
})

test('serialises gap recovery ahead of subsequent replay frames', async () => {
  const socket = new FakeSocket('')
  const order: string[] = []
  const stop = subscribeJob({ base: 'http://localhost:8000', path: '/ws/jobs/job/events', jobId: 'job', channel: 'events',
    makeSocket: () => socket, onError: assert.fail,
    async onFrame(event) { if (event.type === 'gap') await wait(20); order.push(event.type) },
  })
  try {
    socket.send(frame('gap', {}, 10)); socket.send(frame('log', {}, 11))
    await until(() => order.length === 2)
    assert.deepEqual(order, ['gap', 'log'])
  } finally { stop() }
})
