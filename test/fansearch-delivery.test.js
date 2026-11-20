import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises'
import { createFansearchDelivery } from '../src/fansearch-delivery.js'
import { FanSearchState, searchAssociative } from '../src/fansearch.js'
import { createEmbeddingClient } from '../src/embedding.js'

const exec = (sid = 's', extra = {}) => ({ name: 'run_code', agent: { session: { id: sid } }, ...extra })
const result = { content: [{ type: 'text', text: 'base' }] }
const accept = { kind: 'accept' }
const found = (mode, id = mode) => ({ mode, items: [{ id, source: 'test', kind: 'relevant', fragment: id }] })
const prime = (state, sid = 's', turn = 1) => {
  state.onTurn(sid, turn)
  for (let step = 1; step <= 3; step++) state.onAssistant(sid, turn, step, 'x'.repeat(160), true)
}

async function waitFor(predicate) {
  const end = Date.now() + 2000
  while (!predicate()) {
    assert.ok(Date.now() < end, 'background condition did not settle')
    await delay(5)
  }
}

test('no waiting; a late hint rides a later tool result in the same session once', async t => {
  const state = new FanSearchState(); prime(state)
  const job = Promise.withResolvers(); let starts = 0
  const delivery = createFansearchDelivery({ mode: 'embedding', state, embedder: {},
    search: () => { starts++; return job.promise } })
  t.after(delivery.dispose)
  const outer = exec(), inner = exec('s', { name: 'read', parent: {} })
  delivery.start(inner); delivery.start(outer); delivery.start(outer)
  assert.equal(delivery.attach(outer, result, accept), accept)
  await tick(); assert.equal(starts, 1)
  state.onTurn('s', 2)
  job.resolve(found('embedding', 'late')); await tick()
  assert.equal(delivery.attach(exec('other'), result, accept), accept)
  assert.equal(delivery.attach(inner, result, accept), accept)
  assert.equal(delivery.attach(exec(), result, { kind: 'accept', value: 1 }).content, undefined)
  assert.equal(delivery.attach(outer, { ...result, isError: true }, accept), accept)
  const attached = delivery.attach(outer, result, accept)
  assert.match(attached.content[1].text, /late/)
  assert.equal(delivery.attach(outer, result, accept), accept)
  assert.equal(result.content.length, 1)
})

test('embedding runs alone, times out, uses parallel fallback until recovery', async t => {
  const state = new FanSearchState(), held = Promise.withResolvers()
  let network = 'hang', calls = [], signal
  const delivery = createFansearchDelivery({ mode: 'embedding', state, embedder: {}, timeoutMs: 40,
    search: (_query, opts) => {
      calls.push(opts.mode)
      if (opts.mode === 'mechanical') return found(opts.mode, `m${calls.length}`)
      signal = opts.signal
      return network === 'hang' ? held.promise : found(opts.mode, `e${calls.length}`)
    } })
  t.after(delivery.dispose)
  const tool = exec()
  prime(state); delivery.start(tool); await tick()
  assert.deepEqual(calls, ['embedding'])
  assert.equal(delivery.attach(tool, result, accept), accept)
  await waitFor(() => calls.length === 2); await tick()
  assert.ok(signal.aborted)
  assert.match(delivery.attach(tool, result, accept).content[1].text, /m2/)
  prime(state, 's', 2); delivery.start(tool); await tick()
  assert.deepEqual(calls.slice(2).sort(), ['embedding', 'mechanical'])
  await waitFor(() => signal.aborted); await tick()
  assert.match(delivery.attach(tool, result, accept).content[1].text, /m3/)
  network = 'ok'; prime(state, 's', 3); delivery.start(tool); await tick()
  assert.deepEqual(calls.slice(4).sort(), ['embedding', 'mechanical'])
  assert.match(delivery.attach(tool, result, accept).content[1].text, /e6/)
  prime(state, 's', 4); delivery.start(tool); await tick()
  assert.deepEqual(calls.slice(6), ['embedding'])
  assert.match(delivery.attach(tool, result, accept).content[1].text, /e7/)
  held.resolve(found('embedding', 'stale')); await tick()
  assert.equal(delivery.attach(tool, result, accept), accept)
})

test('shadow always runs both routes and never awaits shadow logging', async t => {
  const state = new FanSearchState(); prime(state)
  const firstMechanical = Promise.withResolvers(), log = Promise.withResolvers()
  const calls = [], rows = []
  const delivery = createFansearchDelivery({ mode: 'shadow', state, embedder: {},
    search: (_, opts) => { calls.push(opts.mode); return opts.mode === 'mechanical' && calls.length === 1
      ? firstMechanical.promise : found(opts.mode, `shadow-${calls.length}`) },
    onShadow: row => { rows.push(row); return log.promise } })
  t.after(delivery.dispose)
  delivery.start(exec()); await tick()
  assert.deepEqual(calls.sort(), ['embedding', 'mechanical'])
  assert.equal(rows.length, 0)
  assert.match(delivery.attach(exec(), result, accept).content[1].text, /shadow-2/)
  firstMechanical.resolve(found('mechanical')); await tick(); assert.equal(rows.length, 1)
  prime(state, 's', 2); delivery.start(exec()); await tick()
  assert.equal(calls.length, 4); assert.equal(rows.length, 2)
  assert.match(delivery.attach(exec(), result, accept).content[1].text, /shadow-4/)
  log.resolve()
})

test('shadow fallback reuses the mechanical result and retains the failure reason', async t => {
  const state = new FanSearchState(); prime(state)
  const calls = [], rows = []
  const delivery = createFansearchDelivery({ mode: 'shadow', state, embedder: {},
    search: (_, opts) => {
      calls.push(opts.mode)
      if (opts.mode === 'embedding') throw new Error('offline fixture')
      return found('mechanical', 'fallback-hint')
    }, onShadow: row => { rows.push(row) } })
  t.after(delivery.dispose)
  delivery.start(exec()); await tick()
  assert.deepEqual(calls.sort(), ['embedding', 'mechanical'])
  assert.match(delivery.attach(exec(), result, accept).content[1].text, /fallback-hint/)
  assert.equal(rows[0].primary, rows[0].shadow)
  assert.equal(rows[0].embeddingError, 'offline fixture')
})

test('disposal aborts active retrieval and suppresses later delivery', async () => {
  const state = new FanSearchState(); prime(state)
  const job = Promise.withResolvers()
  let signal, calls = 0
  const delivery = createFansearchDelivery({ mode: 'embedding', state, embedder: {},
    search: (_, opts) => { calls++; signal = opts.signal; return job.promise } })
  delivery.start(exec()); await tick(); assert.equal(calls, 1)
  delivery.dispose(); assert.ok(signal.aborted)
  job.resolve(found('embedding')); await tick()
  assert.equal(calls, 1)
  assert.equal(delivery.attach(exec(), result, accept), accept)
})

test('embedding deadline aborts the in-flight HTTP request and starts no further batches', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  const started = Promise.withResolvers()
  let requests = 0
  globalThis.fetch = async (_url, { signal }) => {
    requests++
    started.resolve(signal)
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const embedder = createEmbeddingClient({ url: 'https://unused.invalid', model: 'test' })
  const controller = new AbortController()
  const embedding = embedder.embed(Array.from({ length: 128 }, (_, i) => `input-${i}`), { signal: controller.signal })
  const httpSignal = await started.promise
  controller.abort(new Error('deadline fixture'))
  await assert.rejects(embedding, /deadline fixture/)
  assert.ok(httpSignal.aborted)
  assert.equal(requests, 1)
})

test('interactive embedding failure does not retry or split the batch', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('offline fixture') }
  const embedder = createEmbeddingClient({ url: 'https://unused.invalid', model: 'test' })
  const signal = new AbortController().signal
  await assert.rejects(embedder.embed(['one', 'two', 'three'], { signal }), /offline fixture/)
  assert.equal(requests, 1)
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })
  await embedder.warm(['indexed sentence'], signal)
  globalThis.fetch = async () => { requests++; throw new Error('offline fixture') }
  await assert.rejects(searchAssociative([{ id: 'm', summary: 'indexed sentence' }], 'query', {
    mode: 'embedding', embedder, signal, fallback: false,
  }), /offline fixture/)
  assert.equal(requests, 2)
})
