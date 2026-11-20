import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createEmbeddingIndex, startEmbeddingWarmup } from '../src/embedding-index.js'
import { collectAssociativeSentences, searchAssociative } from '../src/fansearch.js'

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'mnemos-index-test-'))
  const cacheFile = join(root, 'legacy.json')
  await writeFile(cacheFile, '{"old":[]}')
  const calls = []
  const opts = { cacheFile, url: 'http://localhost/a', model: 'test', request: async texts => {
    calls.push([...texts]); return texts.map(() => [1, 0])
  } }
  return { cacheFile, calls, opts, open: overrides => createEmbeddingIndex({ ...opts, ...overrides }) }
}

test('persists only new content, reopens without inference, leaves legacy unchanged', async () => {
  const { cacheFile, calls, open } = await fixture()
  const a = open()
  assert.deepEqual(await a.warm(['alpha', 'alpha', 'beta']), { added: 2, indexed: 2 })
  assert.deepEqual(await a.warm(['beta', 'alpha']), { added: 0, indexed: 2 })
  assert.deepEqual(await a.warm(['beta', 'gamma']), { added: 1, indexed: 3 })
  const b = open()
  assert.deepEqual(await b.warm(['gamma', 'alpha', 'beta']), { added: 0, indexed: 3 })
  assert.deepEqual(calls, [['alpha', 'beta'], ['gamma']])
  assert.deepEqual(b.corpusVectors(['alpha']).get('alpha'), new Float32Array([1, 0]))
  assert.equal(await readFile(cacheFile, 'utf8'), '{"old":[]}')
  for (const override of [{ model: 'next' }, { url: 'http://localhost/b' }]) {
    const other = open(override)
    assert.throws(() => other.corpusVectors(['alpha']), /warming/)
    assert.equal((await other.warm(['alpha'])).added, 1)
  }
  assert.equal(calls.length, 4)
})

test('cold and incomplete scans do not embed; hot scan computes only query', async () => {
  const { calls, open } = await fixture()
  const index = open()
  const item = (id, summary, extra = {}) => ({ id, summary, ...extra })
  const memories = [item('one', '第一句。第二句。'), item('d', '不应索引', { source: 'deprecated' }),
    item('i', '不应索引', { source: 'autobiography', category: 'identity' }), item('l', 'x'.repeat(601))]
  const options = { mode: 'embedding', embedder: index }
  assert.equal((await searchAssociative(memories, '查询', options)).mode, 'mechanical')
  assert.deepEqual(calls, [])
  const corpus = collectAssociativeSentences(memories)
  assert.deepEqual([...corpus], ['第一句。', '第二句。'])
  await index.warm(corpus)
  const found = await searchAssociative(memories, '查询', options)
  assert.equal(found.mode, 'embedding')
  assert.equal(found.embeddingError, null)
  assert.deepEqual(calls, [['第一句。', '第二句。'], ['查询']])
  memories.push(item('new', '新增句。'))
  await assert.rejects(searchAssociative(memories, '查询', { ...options, fallback: false }), /warming/)
  assert.equal(calls.length, 2)
  await index.warm(collectAssociativeSentences(memories))
  assert.deepEqual(calls.at(-1), ['新增句。'])
})

test('concurrent immutable batches reopen together; corrupt and pending files are ignored', async () => {
  const { cacheFile, open } = await fixture()
  await Promise.all([open().warm(['alpha']), open().warm(['beta'])])
  const parent = `${cacheFile}.vectors-v1`
  const directory = join(parent, (await readdir(parent))[0])
  await writeFile(join(directory, '00000000-0000-0000-0000-000000000000.jsonl'), 'malformed')
  await writeFile(join(directory, '00000000-0000-0000-0000-000000000000.pending'), 'unfinished')
  let warnings = 0
  const c = open({ onError: () => warnings++ })
  assert.deepEqual(await c.warm(['alpha', 'beta']), { added: 0, indexed: 2 })
  assert.equal(warnings, 1)
})

test('warmup schedules single-flight work and stops on unload', async () => {
  const ready = Promise.withResolvers()
  let runs = 0, signal
  const stop = startEmbeddingWarmup({ intervalMs: 5, collect: () => ['alpha'], warm: async (_, current) => {
    signal = current; runs++; ready.resolve(); await delay(35)
  } })
  await Promise.race([ready.promise, delay(500).then(() => { throw Error('scheduler not started') })])
  await delay(15)
  assert.equal(runs, 1)
  stop()
  assert.equal(signal.aborted, true)
  await delay(40)
  assert.equal(runs, 1)
})
