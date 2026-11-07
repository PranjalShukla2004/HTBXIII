import test from 'node:test'
import assert from 'node:assert/strict'
import { recordingAction, runEvents, skillFromBackend } from '../src/api/mapping.ts'
import { frame } from './helpers.ts'

const skill = skillFromBackend({ id: 'shopping_demo', goal: 'Find {{query}}', arguments: { query: { type: 'string', default: 'ps5' } },
  steps: [{ op: 'search', target: 'Product search', value: '{{query}}' }, { op: 'extract', target: 'Cart total' }] })

test('maps the saved skill schema into existing skill strips and step details', () => {
  assert.equal(skill.name, 'shopping demo')
  assert.deepEqual(skill.variables, [{ name: 'query', example: 'ps5' }])
  assert.equal(skill.steps[0].intent, 'fill')
  assert.equal(skill.steps[0].slot, 'query')
  assert.equal(skill.steps[1].intent, 'extract')
  assert.equal(skill.runs, undefined)
})

test('planned actions stay running; only completed actions advance the ticks', () => {
  const planned = runEvents(frame('agent', { kind: 'step', message: 'Searching', data: { step: 0 } }), skill, 'site')
  assert.equal(planned[0].type, 'step')
  assert.equal('status' in planned[0] && planned[0].status, 'running')
  for (const data of [{ partial: true }, { navigation_hop: true }, { repeat: 3, repetition: 2 }]) {
    const event = runEvents(frame('action', { step: 0, ...data }), skill, 'site')[0]
    assert.equal('status' in event && event.status, 'running')
  }
  const complete = runEvents(frame('action', { step: 0, repeat: 3, repetition: 3 }), skill, 'site')[0]
  assert.equal('status' in complete && complete.status, 'ok')
  assert.equal('tier' in complete && complete.tier, 'complete')
})

test('cached, extracted, verified, skipped and failed steps keep their actual meaning', () => {
  for (const [message, data, status] of [
    ['replayed from cache', { step: 0, cached: true }, 'ok'],
    ['extract total', { step: 1, outputs: { total: '$49' } }, 'ok'],
    ["verify 'cart': True (visible)", { step: 0 }, 'ok'],
    ["verify 'cart': False (missing)", { step: 0 }, 'failed'],
    ['optional step skipped', { step: 0 }, 'skipped'],
  ] as const) {
    const event = runEvents(frame('agent', { message, data }), skill, 'site')[0]
    assert.equal('status' in event && event.status, status)
  }
  assert.deepEqual(runEvents(frame('agent', { message: 'Searching', data: {} }), skill, 'site'), [])
  assert.deepEqual(runEvents(frame('action', { step: 900 }), skill, 'site'), [])
})

test('terminal text retains partial and severity data; model deltas are separate view events', () => {
  const log = runEvents(frame('log', { message: 'Added to cart', partial: true, level: 'warning' }, 9), skill, 'site')[0]
  assert.deepEqual(log, { type: 'log', id: 'job:events:9', targetId: 'site', ts: '2027-01-15T08:00:00.000Z',
    message: 'Added to cart', partial: true, source: 'console', jobId: 'job', level: 'warn' })
  const delta = runEvents(frame('llm.delta', { call_id: 'a', attempt: 1, tag: 'ground', text: '{"op":' }, 1, 'llm'), skill)[0]
  assert.equal(delta.type, 'model')
  assert.equal('id' in delta && delta.id, 'job:a:1')
  assert.equal('text' in delta && delta.text, '{"op":')
})

test('recorder events become readable summaries and replay-stable IDs in the REC bar', () => {
  const action = recordingAction(frame('recorder', { kind: 'click', url: 'https://shop.example', el: { text: 'Add to cart' } }, 7))!
  assert.equal(action.summary, 'Clicked “Add to cart”')
  assert.equal(action.id, 'job:7')
  assert.equal(recordingAction(frame('log', { message: 'hello' })), null)
})
