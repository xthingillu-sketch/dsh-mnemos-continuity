import { performance } from 'node:perf_hooks'
import { formatAssociativeHint } from './fansearch.js'

/** Background retrieval. The result hook only consumes ready data, never a Promise. */
export function createFansearchDelivery({ mode, state, search, embedder, timeoutMs = 20_000, onShadow, onError }) {
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 2_147_483_647) : 20_000
  const pending = new Map()
  const ready = new Map()
  let disposed = false
  let degraded = false
  let attempt = 0
  let latestOutcome = 0

  // DSH pipeline.ts carries exec.parent for PTC bindings; ptc.ts returns only
  // value to the program. Ride the model-visible outer tool result instead.
  const carrier = exec => exec?.agent?.session?.id && exec.parent === undefined
    && !exec.signal?.aborted && !String(exec.name || '').startsWith('mnemos_')

  function report(error) {
    try { onError?.(error) } catch { /* diagnostics cannot affect delivery */ }
  }

  async function run(sid, query, exclude, controller) {
    const started = performance.now()
    let mechanical
    const fallback = () => mechanical ??= Promise.resolve().then(() => {
      if (disposed) return null
      return search(query, { exclude, mode: 'mechanical' })
    }).catch(error => { report(error); return null })
    if (mode === 'shadow' || (mode === 'embedding' && degraded)) void fallback()
    if (mode === 'mechanical') return fallback()

    const id = ++attempt
    let timer
    let onAbort
    let embeddingError = null
    let primary = null
    try {
      if (!embedder) throw new Error('embedding is not configured')
      const cancellation = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      timer = setTimeout(() => controller.abort(new Error('embedding deadline exceeded')), budget)
      const candidate = await Promise.race([
        cancellation,
        Promise.resolve().then(() => search(query, { exclude, mode: 'embedding', embedder, signal: controller.signal, fallback: false })),
      ])
      if (performance.now() - started >= budget) throw new Error('embedding deadline exceeded')
      if (candidate?.mode !== 'embedding') throw new Error(candidate?.embeddingError || 'embedding query unavailable')
      primary = candidate
    } catch (error) {
      embeddingError = String(error?.message || error)
      controller.abort(error)
    } finally {
      clearTimeout(timer)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    }
    if (disposed) return null
    if (mode === 'embedding' && id > latestOutcome) {
      latestOutcome = id
      degraded = !primary
    }
    const selected = primary ?? await fallback()
    if (mode === 'shadow' && onShadow) {
      // Recording both routes is independent of ready-queue publication.
      void fallback().then(shadow => {
        if (!disposed) return onShadow({ sessionId: sid, query, primary: selected, shadow,
          elapsedMs: Math.round(performance.now() - started), embeddingError })
      }).catch(report)
    }
    return selected
  }

  function start(exec) {
    if (disposed || !carrier(exec)) return
    const sid = exec.agent.session.id
    if (pending.has(sid) || !state.shouldScan(sid)) return
    const query = state.queryFor(sid, exec.arguments)
    const exclude = state.seenFor(sid)
    for (const id of ready.get(sid)?.keys() ?? []) exclude.add(id)
    const controller = new AbortController()
    state.markScanned(sid)
    // Defer even synchronous local scoring out of the pre/post hook stack.
    const handle = setImmediate(() => {
      void run(sid, query, exclude, controller).then(result => {
        if (disposed || !result?.items?.length) return
        let queue = ready.get(sid)
        if (!queue) ready.set(sid, queue = new Map())
        const seen = state.seenFor(sid)
        for (const item of result.items) if (!seen.has(item.id) && !queue.has(item.id)) queue.set(item.id, item)
      }).catch(report).finally(() => pending.delete(sid))
    })
    pending.set(sid, { controller, handle })
  }

  function attach(exec, result, decision) {
    if (disposed || !carrier(exec) || decision?.kind !== 'accept' || result?.isError
        || Object.hasOwn(decision, 'value')) return decision
    const content = decision.content ?? result?.content
    if (!Array.isArray(content) || !content.length) return decision
    const sid = exec.agent.session.id
    const queue = ready.get(sid)
    if (!queue) return decision
    const seen = state.seenFor(sid)
    const items = []
    for (const [id, item] of queue) {
      queue.delete(id)
      if (!seen.has(id)) items.push(item)
      if (items.length === 5) break
    }
    if (!queue.size) ready.delete(sid)
    if (!items.length) return decision
    state.markSeen(sid, items.map(item => item.id), 'fansearch')
    return { ...decision, content: [...content, { type: 'text', text: formatAssociativeHint(items) }] }
  }

  function dispose() {
    disposed = true
    for (const { controller, handle } of pending.values()) {
      clearImmediate(handle)
      controller.abort(new Error('fansearch disposed'))
    }
    pending.clear()
    ready.clear()
  }

  return { start, attach, dispose }
}
