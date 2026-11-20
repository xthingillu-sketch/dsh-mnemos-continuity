import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as yieldToHost } from 'node:timers/promises'

const BATCH = 64
const digest = (algorithm, value) => createHash(algorithm).update(value).digest('hex')
const keyOf = (model, text) => digest('sha1', `${model}\0${text}`)
const validHash = /^[0-9a-f]{40}$/
const payloadFile = /^[0-9a-f-]{36}\.jsonl$/

function encode(vector) {
  const bytes = Buffer.allocUnsafe(vector.length * 4)
  for (let i = 0; i < vector.length; i++) bytes.writeFloatLE(vector[i], i * 4)
  return bytes.toString('base64')
}

function decode(value) {
  if (typeof value !== 'string') throw new Error('invalid vector encoding')
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.length % 4 || bytes.toString('base64') !== value) throw new Error('invalid vector bytes')
  const vector = new Float32Array(bytes.length / 4)
  for (let i = 0; i < vector.length; i++) vector[i] = bytes.readFloatLE(i * 4)
  if (!vector.every(Number.isFinite)) throw new Error('non-finite vector')
  return vector
}

/** Immutable JSONL batch segments: no shared append offset, snapshot rewrite or writer lock. */
export function createEmbeddingIndex({ cacheFile, url, model, request, onError = () => {} }) {
  const namespace = digest('sha256', JSON.stringify([url, model]))
  const directory = cacheFile ? join(`${cacheFile}.vectors-v1`, namespace) : null
  const entries = new Map()
  let dimension = 0
  let loaded = false
  let warming = null

  async function load(signal) {
    if (!directory) { loaded = true; return }
    let files
    try { files = await readdir(directory) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      files = []
    }
    for (const file of files.filter(name => payloadFile.test(name)).sort()) {
      signal.throwIfAborted()
      try {
        const lines = (await readFile(join(directory, file), { encoding: 'utf8', signal })).trimEnd().split('\n')
        const header = JSON.parse(lines.shift())
        if (header.version !== 1 || header.namespace !== namespace || header.model !== model) continue
        const rows = lines.map(line => {
          const { h, v } = JSON.parse(line)
          if (!validHash.test(h)) throw new Error('invalid vector key')
          return [h, decode(v)]
        })
        const expected = dimension || rows[0]?.[1].length
        if (!expected || rows.some(([, v]) => v.length !== expected)) throw new Error('incompatible vector dimension')
        dimension = expected
        for (const [h, v] of rows) entries.set(h, v)
      } catch (error) {
        signal.throwIfAborted()
        onError(error)
      }
      await yieldToHost(undefined, { signal })
    }
    loaded = true
  }

  async function warm(texts, signal) {
    if (!loaded) await load(signal)
    signal.throwIfAborted()
    const missing = new Map()
    for (const text of texts) {
      const hash = keyOf(model, text)
      if (!entries.has(hash)) missing.set(hash, text)
    }
    const todo = [...missing]
    for (let offset = 0; offset < todo.length; offset += BATCH) {
      signal.throwIfAborted()
      const batch = todo.slice(offset, offset + BATCH)
      const vectors = await request(batch.map(([, text]) => text), signal)
      signal.throwIfAborted()
      const expected = dimension || vectors[0]?.length
      if (!expected || vectors.length !== batch.length || vectors.some(v => v.length !== expected)) {
        throw new Error('incompatible vector dimension')
      }
      const rows = batch.map(([h], i) => [h, Float32Array.from(vectors[i])])
      if (rows.some(([, v]) => !v.every(Number.isFinite))) throw new Error('invalid float32 vector')
      if (directory) {
        const base = join(directory, randomUUID())
        const body = [JSON.stringify({ version: 1, namespace, model }),
          ...rows.map(([h, v]) => JSON.stringify({ h, v: encode(v) }))].join('\n') + '\n'
        await mkdir(directory, { recursive: true })
        // Unique temp and final names across processes; readers see only committed batches.
        await writeFile(`${base}.pending`, body, { flag: 'wx', mode: 0o600 })
        await rename(`${base}.pending`, `${base}.jsonl`)
      }
      dimension = expected
      for (const [h, v] of rows) entries.set(h, v)
      await yieldToHost(undefined, { signal })
    }
    return { added: todo.length, indexed: entries.size }
  }

  return {
    warm(texts, signal = new AbortController().signal) {
      if (!warming) warming = warm(texts, signal).finally(() => { warming = null })
      return warming
    },
    corpusVectors(texts) {
      if (!loaded || !dimension) throw new Error('embedding index warming')
      const vectors = new Map()
      for (const text of texts) {
        const vector = entries.get(keyOf(model, text))
        if (!vector) throw new Error('embedding index warming')
        vectors.set(text, vector)
      }
      return vectors
    },
    async embedQuery(text, { signal } = {}) {
      const [vector] = await request([text], signal)
      if (!vector || vector.length !== dimension) throw new Error('embedding query index dimension mismatch')
      return vector
    },
  }
}

/** Single-flight scheduler; shutdown cancels the current HTTP request. */
export function startEmbeddingWarmup({ collect, warm, onError, onReady, intervalMs = 30_000 }) {
  let announced = false
  const controller = new AbortController()
  const { signal } = controller
  let timer
  const schedule = ms => {
    timer = setTimeout(async () => {
      try {
        const texts = await collect(signal)
        signal.throwIfAborted()
        const result = await warm(texts, signal)
        signal.throwIfAborted()
        if (result && (!announced || result.added > 0)) {
          announced = true
          onReady?.(result)
        }
      } catch (error) {
        if (!signal.aborted) onError?.(error)
      } finally {
        if (!signal.aborted) schedule(intervalMs)
      }
    }, ms)
    timer.unref?.()
  }
  schedule(0)
  return () => { clearTimeout(timer); controller.abort() }
}
