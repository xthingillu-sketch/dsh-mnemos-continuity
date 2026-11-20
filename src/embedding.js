import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { createEmbeddingIndex } from './embedding-index.js'

/**
 * 可选 embedding 客户端（OpenAI-compatible /embeddings）。
 *
 * 只服务联想激活；默认不启用。配置来自环境变量或 profile：
 *   MNEMOS_EMBEDDING_URL   e.g. https://.../v1/embeddings
 *   MNEMOS_EMBEDDING_MODEL e.g. bge-m3:567m
 *   MNEMOS_EMBEDDING_API_KEY
 * apiKeyFile 可选：从已有 credentials YAML 读取 NBU_API_KEY，不在 profile 复制 key。
 *
 * 调用失败由 searchAssociative 回退到机械模式；这里不静默返回假向量。
 */
function readKeyFile(file) {
  if (!file) return ''
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const m = /(?:^|\n)\s*NBU_API_KEY:\s*["']?([^\s"']+)/.exec(raw)
    return m ? m[1] : ''
  } catch { return '' }
}

export function createEmbeddingClient({ url, model, apiKey, apiKeyFile, cacheFile, onIndexError, timeoutMs = 60000 } = {}) {
  if (!url || !model) return null
  const key = apiKey || readKeyFile(apiKeyFile)
  async function post(texts, signal) {
    const headers = { 'Content-Type': 'application/json' }
    if (key) headers.Authorization = `Bearer ${key}`
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted()
      try {
        const requestTimeout = AbortSignal.timeout(timeoutMs)
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, input: texts }),
          signal: signal ? AbortSignal.any([signal, requestTimeout]) : requestTimeout,
        })
        if (!res.ok) {
          const retryable = res.status === 429 || res.status >= 500
          // An upstream error body can echo the request. Never carry it to logs.
          void res.body?.cancel().catch(() => {})
          const err = new Error(`embedding HTTP ${res.status}`)
          if (!retryable) throw err
          lastError = err
        } else {
          const data = await res.json()
          if (!data || !Array.isArray(data.data)) throw new Error('embedding response missing data')
          signal?.throwIfAborted()
          if (data.data.length !== texts.length) throw new Error('embedding response count mismatch')
          const vectors = data.data.map((x) => x && x.embedding)
          const dimensions = vectors[0]?.length
          if (!dimensions || vectors.some(v => !Array.isArray(v) || v.length !== dimensions || !v.every(Number.isFinite))) {
            throw new Error('invalid embedding vector')
          }
          return vectors
        }
      } catch (e) {
        signal?.throwIfAborted()
        lastError = e
      }
      // Interactive retrieval falls back on a known failure instead of retrying.
      if (signal) break
      if (attempt < 2) await delay(400 * (attempt + 1))
    }
    throw lastError || new Error('embedding failed')
  }

  // The persistent corpus and per-query inference are separate. The legacy
  // low-level caller can still submit arbitrary batches without persisting queries.
  const index = createEmbeddingIndex({ cacheFile, url, model, request: post, onError: onIndexError })
  async function embed(texts, { signal } = {}) {
    const list = (texts || []).map(text => String(text ?? ''))
    const result = []
    for (let i = 0; i < list.length; i += 64) {
      signal?.throwIfAborted()
      result.push(...await post(list.slice(i, i + 64), signal))
    }
    return result
  }
  return { model, ...index, embed, async embedOne(text) { return (await embed([text]))[0] } }
}
