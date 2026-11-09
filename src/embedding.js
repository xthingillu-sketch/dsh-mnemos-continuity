import fs from 'node:fs'

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

export function createEmbeddingClient({ url, model, apiKey, apiKeyFile, cacheFile, timeoutMs = 60000 } = {}) {
  if (!url || !model) return null
  const key = apiKey || readKeyFile(apiKeyFile)
  let cache = new Map()
  if (cacheFile) {
    try {
      const obj = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (obj && typeof obj === 'object') cache = new Map(Object.entries(obj))
    } catch { /* 没有缓存就从空开始 */ }
  }
  const MAX_CACHE = 5000

  async function post(texts) {
    const headers = { 'Content-Type': 'application/json' }
    if (key) headers.Authorization = `Bearer ${key}`
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, input: texts }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) {
          const retryable = res.status === 429 || res.status >= 500
          let detail = ''
          try { detail = (await res.text()).slice(0, 160) } catch { /* 忽略 */}
          const err = new Error(`embedding HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
          if (!retryable) throw err
          lastError = err
        } else {
          const data = await res.json()
          if (!data || !Array.isArray(data.data)) throw new Error('embedding response missing data')
          const vectors = data.data.map((x) => x && x.embedding)
          if (vectors.some((v) => !Array.isArray(v))) throw new Error('embedding vector missing')
          return vectors
        }
      } catch (e) {
        lastError = e
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
    }
    throw lastError || new Error('embedding failed')
  }

  async function embed(texts) {
    const list = (texts || []).map((t) => String(t ?? ''))
    const out = new Array(list.length)
    const todo = []
    for (let i = 0; i < list.length; i++) {
      const key = `${model}\u0000${list[i]}`
      if (cache.has(key)) out[i] = cache.get(key)
      else todo.push({ i, key, text: list[i] })
    }
    if (todo.length) {
      // 一次性把全库句子发出去会撞服务上限；按小批走，失败的对半拆。
      const saveCache = () => {
        if (!cacheFile) return
        try { fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(cache))) } catch { /* 缓存失败不影响本次结果 */ }
      }
      const fetchBatch = async (batch) => {
        try {
          return await post(batch.map((x) => x.text))
        } catch (e) {
          if (batch.length <= 1) return [null] // 单句失败只跳过该句，不伪造向量
          const mid = Math.ceil(batch.length / 2)
          const left = await fetchBatch(batch.slice(0, mid))
          const right = await fetchBatch(batch.slice(mid))
          return [...left, ...right]
        }
      }
      const BATCH = 64
      let processed = 0
      for (let start = 0; start < todo.length; start += BATCH) {
        const batch = todo.slice(start, start + BATCH)
        const vectors = await fetchBatch(batch)
        for (let j = 0; j < batch.length; j++) {
          const v = vectors[j]
          if (v) {
            cache.set(batch[j].key, v)
            out[batch[j].i] = v
          }
        }
        processed += batch.length
        if (processed % (BATCH * 5) === 0) saveCache()
      }
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value)
      saveCache()
    }
    return out
  }

  return {
    model,
    async embed(texts) { return embed(texts) },
    async embedOne(text) { return (await embed([text]))[0] },
  }
}
