/**
 * 工具名未找到时的引导（unknown-tool guidance）。
 *
 * 起因（实测，非推测）：sensenova 免费模型在写「微信接入成功」那条记忆时，
 * 调用了**不存在的** `mnemos_reremember`，只收到一句 `unknown tool "..."` 就作罢，
 * 随后改用 `mnemos_remember` 才成功。
 * 它伸手要的是「更新/纠正一条已有记忆」的语义 —— **系统本可以告诉它怎么做。**
 *
 * ★ 接口已核实，不是猜的（这是本项目的硬教训）：
 *   DSH 的 `@deepseek-ai/dsh-tools` 源码里，`dispatchScheduledExecution` 的 JSDoc 明确写着
 *   「Tool and unknown-tool failures still receive post-execute」；
 *   且 `postExecute` 只在 `Object.hasOwn(decision, 'value')` 且 `result.isError` 时抛错，
 *   **不禁替换 `content`**。所以这里安全地只追加 content，从不改 value。
 *
 * 作用域刻意收窄：**只处理 `mnemos_*` 这一类未知名**。
 * 理由：只有对自己的工具名，我才能给出「权威」的引导文本；
 * 且工具名清单由注册处收集（单一真相源），不会漂移。
 */
import { plain } from './plain-text.js'

/** 归一化工具名：小写、去掉非字母数字（便于 `webSearch` / `web-search` 之类比较）。 */
function normalizeToolName(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 编辑距离（仅用于近似匹配，输入很短）。 */
export function editDistance(a, b) {
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/**
 * 在已知工具名里找最接近的一个（用于「你是想调用 X 吗？」）。
 * @returns {name, score, reason} | null
 */
export function nearestToolName(wanted, knownNames) {
  const w = normalizeToolName(wanted)
  if (!w) return null
  let best = null
  for (const name of knownNames || []) {
    const k = normalizeToolName(name)
    if (!k) continue
    let score = 0
    let reason = ''
    if (k === w) {
      score = 100; reason = '同名的规范化形式'
    } else if (k.startsWith(w) || w.startsWith(k)) {
      score = 80; reason = '前缀相同'
    } else {
      const d = editDistance(w, k)
      const maxLen = Math.max(w.length, k.length)
      if (d <= 2 || (maxLen >= 8 && d / maxLen <= 0.3)) {
        score = 60 - d; reason = `编辑距离 ${d}`
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { name, score, reason }
  }
  return best
}

/** 从工具结果里判断「工具名未找到」，并取回模型请求的名字。 */
export function detectUnknownTool(result, requestedName) {
  const err = result?.error
  if (err && (err.code === 'UNKNOWN_TOOL' || err.name === 'ToolNotFoundError')) {
    return { requested: requestedName ?? null }
  }
  const parts = Array.isArray(result?.content) ? result.content : []
  for (const p of parts) {
    const t = typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''
    const m = /unknown tool\s+"([^"]+)"/i.exec(t)
    if (m) return { requested: m[1] }
  }
  return null
}

/**
 * 生成引导文本。返回 null 表示「不插手」（不是未找到工具，或不属于本插件管辖范围）。
 *
 * @param result        工具结果（用于识别 unknown tool）
 * @param requestedName exec.name（模型请求的工具名）
 * @param knownNames    本插件**实际注册**的工具名（由注册处收集，单一真相源）
 */
export function buildUnknownToolGuidance(result, requestedName, knownNames) {
  const hit = detectUnknownTool(result, requestedName)
  if (!hit) return null
  const requested = hit.requested ?? requestedName ?? ''
  // 只处理本插件命名空间：只有这里我能给出权威引导
  if (!/^mnemos[_-]/i.test(requested)) return null

  const known = [...(knownNames || [])].sort()
  const lines = [`[工具名未找到 · 引导]`, `你调用了不存在的工具 "${requested}"。`]
  if (known.length) lines.push(`本插件实际提供的工具是：${known.join('、')}`)

  const near = nearestToolName(requested, known)
  if (near && normalizeToolName(near.name) !== normalizeToolName(requested)) {
    lines.push(`最接近的是 \`${near.name}\`（${near.reason}）—— 如果你要的是它，请改用该名字。`)
  }

  // 「更新/纠正已有记忆」是最常见的臆造动机（实测就是它）：
  // 只有当相关工具确实存在时才提，避免写出一份会漂移的说明。
  const has = (n) => known.includes(n)
  if (has('mnemos_remember') || has('mnemos_deprecate')) {
    lines.push('')
    lines.push('若你要的是「更新或纠正一条已有记忆」，正确做法是：')
    if (has('mnemos_remember')) {
      lines.push('  · 写新条并同时作废旧条：`mnemos_remember` 传 `supersedes: ["旧条 id"]` —— 一步完成，不要只写新条。')
    }
    if (has('mnemos_deprecate')) {
      lines.push('  · 只想作废、没有新结论要写：`mnemos_deprecate({ ids: ["旧条 id"] })`。')
    }
    if (has('mnemos_recall')) {
      lines.push('  · 旧条 id 用 `mnemos_recall` 检索获得；不要臆造工具名。')
    }
  }
  // ★ 出口过 plain()：注入给模型的文本不是 markdown 渲染的，星号会原样显示。
  //   本项目同类缺陷出现过四次，所以不靠"记得写"，靠构造器出口统一约束。
  return plain(lines.join('\n'))
}

/**
 * 构造 `tools/post-execute` 钩子。
 * 只在「mnemos_* 的未知工具」这一种情形下追加引导，其余一律原样放行。
 */
export function makeUnknownToolGuide({ knownNames, onWarn = () => {} }) {
  return async function guideUnknownTool(exec, result, next) {
    const decision = await next()
    try {
      if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
      const content = decision.content ?? result?.content
      const probe = { error: result?.error, content }
      const text = buildUnknownToolGuidance(probe, exec?.name, knownNames)
      if (!text) return decision
      // 只追加 content，绝不改 value（failed result 的 value 不允许替换）
      // ★ 在**注入边界**再过一次 plain()：构造器可能忘，边界不会忘。
      return { kind: 'accept', content: [...(Array.isArray(content) ? content : []), { type: 'text', text: plain(text) }] }
    } catch (e) {
      onWarn(`工具名引导失败：${e?.message || e}`)
      return decision
    }
  }
}
