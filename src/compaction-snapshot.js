/**
 * dsh-mnemos 折叠快照 + 元记录（F-2）
 *
 * 起因（实测）：DSH 的上下文折叠（`dsh-compaction-basic`）**按位置**丢最旧一段 ——
 * 它读不到任何"这段重要"的标记，所以只能按位置选。已发生 11 次折叠、遮蔽 187.8 万 token。
 * **实证损失**：某会话折叠后，摘要丢了「pip/npm cache blocked，不要再试」这一条，
 * 导致模型重踩已放弃的路线（同一个坑踩第二遍）。
 *
 * 这里做什么：折叠发生时，把**被遮蔽区域**摘成**一条记忆**（原文有界保留 + 三类硬事实）。
 * 原文不会被删除，所以折叠后仍读得到 —— 这一条只是把"读得到"变成"日后召得回"。
 *
 * 它**不**做什么（必须说清，否则会产生虚假的安全感）：
 *   · 不做语义判断、不调 LLM —— 只有确定性正则与位置信息
 *   · 不注入上下文 —— 只写记忆（召回是模型自己的事，注入是另一项的事）
 *   · 不干预折叠本身，也不碰宿主的 compaction 服务（本模块对 DSH 零依赖）
 *   · 不是"不丢信息"的保证 —— 保底原文有字符上限，超出只留头尾
 *
 * ★ 宿主接口（**已在源码与真实日志两处核实**，不是推测）：
 *   1. `compaction/summary` 是普通会话事件，`session/event` 观察者收得到。
 *      依据：`dsh-session/lib/index.js:79-92`（KNOWN_SESSION_EVENT_TYPES 含 "compaction/summary"）。
 *   2. 观察者签名 `(session, event)`，其中第一个参数**就是 Session 实例**。
 *      依据：`dsh-session/lib/index.js:1465` `const callbackArgs = [this, event]`，
 *      而 `this` 所属类正是定义 `eventAt`/`append` 的 Session（同文件 1363/1441 行）。
 *   3. 事件形状：`event.data.shadowedSeqs`（数组）、`shadowedRange {start,end}`、
 *      `shadowedTokenCount`（数字）。
 *      依据：`dsh-compaction-basic/lib/index.js:634-649`（append "compaction/summary" 的真实字段），
 *      并用真实会话日志复核过（`session-e64d27bc`：seq 1494 那次 data 键 = compactionId,
 *      summary, shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model, maxTokens, usage）。
 *   4. 读被折原文的 API 与宿主**同源**：`session.deriveEventMessage(session.eventAt(seq))`。
 *      依据：`dsh-compaction-basic/lib/index.js:699`；`eventAt` 见 `dsh-session:1363`，
 *      `deriveEventMessage` 见 `dsh-session:1576`（投影）与 `dsh-session:214-227`（映射规则）。
 *   5. 观察者的返回**不被 await**，且抛错/拒绝由宿主隔离并只记 warn。
 *      依据：`dsh-session/lib/index.js:1228-1237`。→ 即便如此，本模块仍内部吞错：
 *      不靠宿主的兜底，也不给日志制造噪声。
 *
 * ★★ 2026-10-17 用户拍板的两处改动（都在这里体现）：
 *   ① **只在大折叠时存**：`compaction/prune` 通道**移除**。生产实测（32 条真快照里 25 条是 prune）
 *      显示 25/25 都是"工具失败 0 条、用户请求 0 条、只靠负面结论过闸门"，而那些"负面结论"
 *      是**读文档/读记忆时正文里的模式命中**（不是会话结论）—— 零真阳性，纯噪音。
 *   ② **折叠后给模型注入一条提醒**：只写记忆不够 —— 那次的成功案例也是模型回头自己想到才用上。
 *      现在写完记忆立刻往会话里注入一句「刚才折叠了多大、抽出多少条、存成哪条记忆（id）」，
 *      注入走 `agent.inject()`（`send(input,'next-step',false)`：进下一步、**不唤醒、不新开一轮**）。
 *      这是本模块唯一会碰上下文的地方，且只注入**指针**（id + 计数），不注入正文。
 *
 * ⚠ `session.eventAt` 被宿主标注为 @deprecated（`dsh-session:1358`，"new calls are prohibited"），
 *   但它是**唯一**能读到被遮蔽原文的入口，且宿主自己的折叠实现就在用（compaction-basic:699）。
 *   因此这里照用，并做**能力探测**：取不到就安全跳过，绝不猜结构。
 *
 * ★ 凭据拒写 → 打码后**只重试一次**（不再整条丢掉）：
 *   `store.remember()` 在疑似含凭据时抛错（`secret-patterns.js`）。快照是**机械产物**，
 *   模型没法重写它 —— 对它"拒写"等于纯损失。因此命中凭据时用 `redactSecrets` 打码重试一次；
 *   打码只作用于**要写入的内容**，命中的凭据内容不进任何地方（含告警与审计）。
 *
 * ★ 真实案例离线复跑结论（`session-e64d27bc`，seq 1494，shadowedRange 1069→1193，104 节点，59,869 token）：
 *   · 目标结论**捞到了**：seq 1069 的 `[do-not-en]` 条目 = 「**pip and npm cache are blocked**」那句。
 *   · 但**字面中文模式 `不要再?试` 在该区命中 0 次** —— 原文是英文（"do not retry"）。
 *     → 别按"中文模式应该会命中"来设计；中英两套是互补的，不是冗余的。
 *   · 精度提示（有意保留、交由规则主人决定）：该区 5 条负面结论里只有 1 条是真结论，
 *     另 4 条是**宿主注入的技能目录**里的 "do not call the skill tool again" 等样板句。
 *     `do not` 对技能目录样板有稳定的误报；要提精度可在扫描时按 `source.kind` 跳过
 *     host 注入类（skill-catalog / runtime-context），**但不能**简单白名单只留 user/assistant ——
 *     因为那条真结论恰恰躺在 `source.kind === 'compact-checkpoint'` 的历次摘要里。
 *   · 保底原文（4000 字符，头尾保留）在该区**覆盖不到**那句（原文 50,316 字符，省略 48,180）——
 *     即 A 与 B 是**互补**的，任缺其一这条结论就丢了。这是"两类都留"的实证理由。
 */
import { extractUserText } from './user-signals.js'
import { findSecrets, redactSecrets, describeHits, auditSecretBlock, secretBlocksFileFor } from './secret-patterns.js'

/** 事件类型：**只处理大折叠**（`compaction/summary`）。 */
export const COMPACTION_SUMMARY_EVENT = 'compaction/summary'

/** 本模块处理的事件类型集合（**单一真相源**）。 */
export const COMPACTION_SNAPSHOT_EVENTS = [COMPACTION_SUMMARY_EVENT]

/** 写进记忆的标签。**日后筛掉/召回快照都靠它**，不要改名。 */
export const COMPACTION_SNAPSHOT_TAG = 'compaction-snapshot'

/** 每类硬事实最多列几条（有界：条数）。 */
export const MAX_ITEMS_PER_CLASS = 8
/** 每条硬事实最多多少字符（有界：字符）。 */
export const MAX_ITEM_CHARS = 300
/** 每类最多收集多少条（内存硬上限，只影响"共 N 条"的计数精度之外的截断）。 */
export const MAX_COLLECT_PER_CLASS = 200
/** 保底原文的字符上限（一次折叠可能遮蔽上百个节点）。 */
export const SNAPSHOT_TEXT_CHARS = 4000
/** 单个会话最多写多少条折叠快照记忆（防止刷爆记忆库）。 */
export const MAX_SNAPSHOTS_PER_SESSION = 5
/** 元数据里最多列出多少个 shadowedSeqs。 */
export const SHADOWED_SEQ_PREVIEW = 20
/** 凭据打码审计的 `where` 字段值。 */
export const SNAPSHOT_AUDIT_WHERE = 'compaction-snapshot'
/** 打码写入时追加到 summary 的标记（**不含命中内容**，只说明"有内容被屏蔽了"）。 */
export const REDACTED_SUMMARY_SUFFIX = '（含已屏蔽内容）'

/**
 * 「负面结论」模式表 —— **单一真相源**（照 `secret-patterns.js` 的风格）。
 *
 * 它抓的是"已放弃的路线/已排除的可能"这类**硬事实**：模型重踩的正是这些。
 * 刻意保持**小而确定**：宁可少抓，也不要让噪声淹掉真信号。
 * 中英都要、大小写不敏感（`re` 一律带 i 标志；不用 g，避免 lastIndex 状态）。
 *
 * ⚠ 真实案例的教训（`session-e64d27bc`：seq 1069 那条 compact-checkpoint）：
 *   中文 `不要再?试` 在该遮蔽区里命中 **0 次** —— 原文写的是英文
 *   「**SAPI is dead** — do not retry. ... **pip and npm cache are blocked**」。
 *   即：这句话是靠 `do not` 捞回来的。要扩中文/英文变体请**改这张表**，别在别处再加一套。
 */
export const NEGATIVE_CONCLUSION_PATTERNS = [
  { name: 'retry-stop-zh', re: /不要再?试/i },
  { name: 'ruled-out-zh', re: /已排除/i },
  { name: 'dead-end-zh', re: /走不通/i },
  { name: 'infeasible-zh', re: /不可行/i },
  { name: 'abandon-zh', re: /不再/i },
  { name: 'failure-reason-zh', re: /失败原因/i },
  { name: 'blocked-by-zh', re: /是.*拦/i },
  { name: 'do-not-en', re: /do not/i },
  { name: 'dont-en', re: /don't/i },
  { name: 'ruled-out-en', re: /ruled out/i },
  { name: 'not-possible-en', re: /not possible/i },
]

/** 单个字符数上限的截断（`head…tail` + 省略量）。 */
export function clip(text, maxChars = MAX_ITEM_CHARS) {
  const s = String(text ?? '').trim()
  return s.length > maxChars ? s.slice(0, maxChars) + '…' : s
}

/** 取第一行非空内容（工具错误/用户请求都用它取"首行"）。 */
export function firstLine(text, maxChars = MAX_ITEM_CHARS) {
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim()
    if (t) return clip(t, maxChars)
  }
  return ''
}

/**
 * Mnemos **自己注入**的标记行前缀。
 *
 * ★ 为什么需要它（实测）：`src/index.js` 的 post-execute 钩子会给 web_search / web_fetch 的
 *   结果**前置**一段标记。于是失败的 web_fetch 结果里，第一个 text 块是
 *   `[外部信息 · web_fetch · 可能过时或有偏，需验证]`，**错误正文在后面**。
 *   真实日志例子：seq 935（session-e64d27bc）取到的"错误首行"就是这个标记，
 *   而不是真正的失败原因 —— 那等于把**我们自己的注入**当成原文记下来。
 *   所以取"错误首行"时要跳过它们；若整段只有标记，则退回首行（失败这件事本身不能丢）。
 */
export const INJECTED_MARKER_PREFIXES = ['[外部信息 ·', '⚠️[外部指令/技能 ·', '[外部信息结束]', '⚠️[外部指令/技能结束]']

/** 取"错误首行"：跳过我们自己注入的标记行。整段只有标记时退回真正的首行。 */
export function firstMeaningfulLine(text, maxChars = MAX_ITEM_CHARS, skipPrefixes = INJECTED_MARKER_PREFIXES) {
  let fallback = ''
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (!fallback) fallback = t
    if (skipPrefixes.some((p) => t.startsWith(p))) continue
    return clip(t, maxChars)
  }
  return clip(fallback, maxChars)
}

/** 是否被某条负面模式命中（返回模式名，未命中返回 null）。 */
export function matchNegative(line, patterns = NEGATIVE_CONCLUSION_PATTERNS) {
  const s = String(line ?? '')
  if (!s) return null
  for (const { name, re } of patterns) {
    re.lastIndex = 0 // 防御：调用方可能传入带 g 的自定义模式
    if (re.test(s)) return name
  }
  return null
}

/**
 * 取一个会话节点的**派生消息**（可能与 `deriveEventMessage` 一样返回 null）。
 * 两个方法都在 session 实例上（见文件头接口核实 2/4）；取不到就返回 null，不抛错。
 */
export function derivedMessage(session, seq) {
  let ev = null
  try {
    ev = session?.eventAt?.(seq) ?? null
  } catch {
    ev = null
  }
  if (!ev) return { ev: null, msg: null }
  let msg = null
  try {
    msg = session.deriveEventMessage(ev) ?? null
  } catch {
    msg = null
  }
  return { ev, msg }
}

/**
 * 节点的可读文本。
 *
 * 首选 `deriveEventMessage` 的结果（与宿主折叠**同源**，最不会读错）。
 * 若它返回 null（空内容 / 非 surface 事件 / 被投影掉），再退回**已核实的原始形状**
 * （`dsh-session/lib/index.js:214-227`：user/message → `event.data`；
 * system|developer|assistant/message 与 tool/result → `event.data.message`）。
 * —— 退回是为了「保底」这一目的：宁可多留一点原文，也不要在这里静默丢内容。
 * 形状不在已核实清单里的事件类型，一律**不猜**：返回空串。
 */
export function nodeText(ev, msg) {
  const fromDerived = msg ? extractUserText(msg) : ''
  if (fromDerived) return fromDerived
  const type = ev?.type
  const data = ev?.data
  if (!data || typeof data !== 'object') return ''
  if (type === 'user/message') return extractUserText(data)
  if (type === 'system/message' || type === 'developer/message' || type === 'assistant/message' || type === 'tool/result') {
    return extractUserText(data.message)
  }
  return ''
}

/** 这次工具结果是否失败。以派生消息的 isError 为主，原始 error 字段为辅。 */
export function isToolFailure(ev) {
  if (ev?.type !== 'tool/result') return false
  if (ev.data?.message?.isError === true) return true
  const err = ev.data?.error
  return Boolean(err && typeof err === 'object')
}

/**
 * 解析失败结果对应的**工具名**。
 *
 * ★ 为什么不能只在本区域内找：实测（`session-e64d27bc` seq 1494 的遮蔽区）
 *   `tool/call` **不是 surface 节点**，104 个遮蔽节点里 0 个 tool/call —— 名字只能顺着
 *   `tool/result.sourceEventSeqs[0]` 回到日志里那个 tool/call 上取。
 *   （`sourceEventSeqs` 是 surface 元数据，见 `dsh-session:1444`。）
 * 取不到就返回 '?'：**不猜**。
 */
export function toolNameForCall(session, ev) {
  const callId = ev?.data?.message?.toolCallId ?? null
  const seqs = Array.isArray(ev?.sourceEventSeqs) ? ev.sourceEventSeqs : []
  for (const cseq of seqs) {
    try {
      if (!Number.isFinite(cseq)) continue
      const call = session?.eventAt?.(cseq)
      if (call?.type !== 'tool/call') continue
      if (callId && call.data?.callId && call.data.callId !== callId) continue
      if (typeof call.data?.name === 'string' && call.data.name) return call.data.name
    } catch {
      /* 单个 seq 取不到就跳过，不影响其余 */
    }
  }
  return '?'
}

/**
 * 从被遮蔽的节点里抽出三类硬事实（**确定性，不做语义判断**）。
 *
 * @returns {{nodes: {seq:number,type:string,text:string}[], failures: object[],
 *            userRequests: object[], negatives: object[], textChars: number,
 *            totals: {failures:number,userRequests:number,negatives:number}}}
 */
export function extractShadowedFacts(session, shadowedSeqs, options = {}) {
  const {
    maxItemChars = MAX_ITEM_CHARS,
    maxCollectPerClass = MAX_COLLECT_PER_CLASS,
    patterns = NEGATIVE_CONCLUSION_PATTERNS,
  } = options

  const nodes = []
  const failures = []
  const userRequests = []
  const negatives = []
  const totals = { failures: 0, userRequests: 0, negatives: 0 }
  const seenNegative = new Set()
  let textChars = 0

  for (const seq of Array.isArray(shadowedSeqs) ? shadowedSeqs : []) {
    if (!Number.isFinite(seq)) continue
    const { ev, msg } = derivedMessage(session, seq)
    if (!ev) continue
    const text = nodeText(ev, msg)
    nodes.push({ seq, type: ev.type, text })
    if (!text) continue
    textChars += text.length

    // ① 工具失败：工具名 + 错误首行（跳过 Mnemos 自己注入的标记行）
    if (isToolFailure(ev)) {
      totals.failures++
      if (failures.length < maxCollectPerClass) {
        failures.push({ seq, tool: toolNameForCall(session, ev), error: firstMeaningfulLine(text, maxItemChars) })
      }
    }

    // ② 用户原始请求：source.kind === 'user'（白名单；skill-catalog / compact-checkpoint 等不算）
    if (ev.type === 'user/message' && ev.data?.source?.kind === 'user') {
      totals.userRequests++
      if (userRequests.length < maxCollectPerClass) {
        userRequests.push({ seq, text: firstLine(text, maxItemChars) })
      }
    }

    // ③ 负面结论：逐行匹配确定性模式表（markdown 要点即"句"；超长行按匹配窗口截取）
    for (const line of text.split('\n')) {
      const hit = matchNegative(line, patterns)
      if (!hit) continue
      const item = clip(line, maxItemChars)
      const key = item.replace(/\s+/g, ' ')
      if (seenNegative.has(key)) continue // 同一句在多处重复（如历次 checkpoint 互相包含）：只留第一处
      seenNegative.add(key)
      totals.negatives++
      if (negatives.length < maxCollectPerClass) negatives.push({ seq, pattern: hit, text: item })
    }
  }

  return { nodes, failures, userRequests, negatives, textChars, totals }
}

/**
 * 有界截断：超出上限时保留**头尾**，并标注省略了多少字符。
 * 返回值里的 `omitted` 是**精确**的：`原文长度 - 实际保留长度`。
 * （返回值总长 = maxChars + 标记长度；标记本身远小于上限。）
 */
export function truncateWithOmission(text, maxChars = SNAPSHOT_TEXT_CHARS) {
  const s = String(text ?? '')
  const max = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0
  if (s.length <= max) return { text: s, omitted: 0 }
  const headChars = Math.ceil(max / 2)
  const tailChars = Math.max(0, max - headChars)
  const head = s.slice(0, headChars)
  const tail = tailChars > 0 ? s.slice(s.length - tailChars) : ''
  const omitted = s.length - head.length - tail.length
  const marker = `\n…（此处省略 ${omitted} 字符）…\n`
  return { text: head + marker + tail, omitted }
}

/** 把被遮蔽区域拼成一段**有界**的保底原文（不猜内容，只按节点顺序如实拼接）。 */
export function buildFallbackText(nodes, maxChars = SNAPSHOT_TEXT_CHARS) {
  const parts = []
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n?.text) continue
    parts.push(`[seq ${n.seq} · ${n.type}]\n${n.text}`)
  }
  return truncateWithOmission(parts.join('\n\n'), maxChars)
}

/** 一句话摘要（含条数概要）。条数取**真实总数**（totals），不是被列出条数。 */
export function buildSnapshotSummary({ nodeCount, tokenCount, facts, omitted = 0 }) {
  const f = facts?.totals?.failures ?? facts?.failures?.length ?? 0
  const u = facts?.totals?.userRequests ?? facts?.userRequests?.length ?? 0
  const n = facts?.totals?.negatives ?? facts?.negatives?.length ?? 0
  const base = `折叠快照：遮蔽 ${nodeCount} 节点 / ${tokenCount} token，工具失败 ${f} 条、用户请求 ${u} 条、负面结论 ${n} 条`
  return omitted > 0 ? `${base}；保底原文超限省略 ${omitted} 字符` : base
}

function listSection(title, total, items, limit, render) {
  const shown = items.slice(0, limit)
  const more = total > shown.length ? `，仅列出前 ${shown.length} 条` : ''
  const lines = [`[${title} 共 ${total} 条${more}]`]
  if (!shown.length) lines.push('（无）')
  else for (const it of shown) lines.push(`- ${render(it)}`)
  return lines.join('\n')
}

/** 三段式正文：① 三类抽取 ② 保底原文 ③ 元数据。 */
export function buildSnapshotContent({
  facts,
  fallback,
  range,
  shadowedSeqs,
  shadowedTokenCount,
  compactionId,
  eventType = COMPACTION_SUMMARY_EVENT,
  maxTextChars = SNAPSHOT_TEXT_CHARS,
  maxItems = MAX_ITEMS_PER_CLASS,
}) {
  const seqs = Array.isArray(shadowedSeqs) ? shadowedSeqs : []
  const total = facts?.totals ?? { failures: facts?.failures?.length ?? 0, userRequests: facts?.userRequests?.length ?? 0, negatives: facts?.negatives?.length ?? 0 }
  const rangeText = range && Number.isFinite(range.start) && Number.isFinite(range.end)
    ? `${range.start} → ${range.end}`
    : '（无）'

  return [
    '① 三类硬事实（确定性抽取：模式匹配 + 事件字段，不做语义判断、不调 LLM）',
    listSection('工具失败', total.failures, facts?.failures ?? [], maxItems, (it) => `seq ${it.seq} · ${it.tool}：${it.error}`),
    listSection('用户原始请求', total.userRequests, facts?.userRequests ?? [], maxItems, (it) => `seq ${it.seq}：${it.text}`),
    listSection('负面结论', total.negatives, facts?.negatives ?? [], maxItems, (it) => `seq ${it.seq} [${it.pattern}]：${it.text}`),
    '',
    `② 保底原文（有界 ${maxTextChars} 字符，超出保留头尾；原文未删除，仍可由日志读回）`,
    fallback?.text || '（无可投影文本）',
    '',
    '③ 元数据',
    `event: ${eventType}`,
    `compactionId: ${compactionId ?? '（无）'}`,
    `shadowedRange: ${rangeText}`,
    `shadowedTokenCount: ${Number.isFinite(shadowedTokenCount) ? shadowedTokenCount : '（无）'}`,
    `shadowedSeqs: 共 ${seqs.length} 个，前 ${Math.min(SHADOWED_SEQ_PREVIEW, seqs.length)} 个：${seqs.slice(0, SHADOWED_SEQ_PREVIEW).join(', ')}`,
    `可投影文本总字符数: ${facts?.textChars ?? 0}`,
    `保底原文省略字符数: ${fallback?.omitted ?? 0}`,
  ].join('\n')
}

/**
 * 写一条快照记忆：**疑似凭据被拒 → 打码后只重试一次**。
 *
 * 为什么打码而不是丢弃：快照是**机械产物**，模型无法重写它 —— 拒写在这里等于纯损失。
 * 纪律：
 *   · 只有"内容里确实命中凭据模式"才走打码重试；**其它错误原样抛出**（交由调用方处理，不掩盖真故障）
 *   · **只重试一次**：第二次仍失败就抛出（外层吞掉 + onWarn），绝不循环
 *   · 打码只作用于**要写入的内容**；命中的凭据内容不进正文、不进 summary、不进告警、不进审计
 *   · 成功写入后记一条 `action:'redacted'` 审计（`where:'compaction-snapshot'`）
 *
 * @returns {{redacted: boolean, hits: number}}
 */
async function rememberSnapshot(store, rec, { auditFile = null, onWarn = () => {} } = {}) {
  try {
    const record = await store.remember(rec)
    return { redacted: false, hits: 0, record }
  } catch (firstErr) {
    const hits = findSecrets(`${rec.summary || ''}\n${rec.content || ''}`)
    if (!hits.length) throw firstErr // 不是凭据问题：如实抛出，不掩盖真故障
    const redactedRec = {
      ...rec,
      summary: `${redactSecrets(rec.summary || '')}${REDACTED_SUMMARY_SUFFIX}`,
      content: redactSecrets(rec.content || ''),
    }
    const record = await store.remember(redactedRec) // ← 第二次（也是最后一次）：再失败就往上抛
    await auditSecretBlock(auditFile, { where: SNAPSHOT_AUDIT_WHERE, hits, action: 'redacted' })
    onWarn(`折叠快照含疑似凭据（${describeHits(hits)}）：已打码后写入（只重试一次）`)
    return { redacted: true, hits: hits.length, record }
  }
}

/**
 * 把"刚才发生了什么、存到哪了"说成一句可注入的提醒。**措辞只在这里生成**。
 *
 * 为什么要有注入（2026-10-17 用户要求）：只写记忆不够 —— 生产上 32 条快照没有一条被打开过，
 * 折叠后的模型并不知道"刚才那段的原文被抢救到哪了"。所以要**主动告诉它一次**：
 * 多少条、存在哪条记忆（id）、需要时怎么取。
 *
 * @param {{id?: string, counts: {failures: number, userRequests: number, negatives: number},
 *          nodeCount: number, tokenCount: number}} info
 * @returns 注入文本（不含任何正文内容，只有指针与计数）
 */
export function buildFoldNotice(info) {
  const { id, counts, nodeCount, tokenCount } = info || {}
  const c = counts || {}
  const lines = [
    '【折叠提醒】上一段上下文刚被折叠（这是宿主按位置丢最旧一段，摘要可能丢掉结论）。',
    `遮蔽规模：${nodeCount ?? '?'} 个节点 / 约 ${tokenCount ?? '?'} tokens。`,
    `其中的原始材料已抽成一条记忆：`,
    `· 用户原始请求 ${c.userRequests ?? 0} 条 · 工具失败 ${c.failures ?? 0} 条 · 负面结论 ${c.negatives ?? 0} 条 + 有界保底原文`,
    id ? `· 记忆 id：${id} —— 需要原始细节时 \`mnemos_open ${id}\`；也可 \`mnemos_recall "折叠快照"\` 检索。` : '· 记忆 id 未能取到（写入回执没有 id）。',
    '原始事件未被删除，仍在会话日志里；这条提醒只是指针，不占正文。',
  ]
  return lines.join('\n')
}

/**
 * 构造 `session/event` 钩子：**大折叠**发生时把被遮蔽区域写一条记忆，并注入一句提醒。
 *
 * 纪律（照 `stuck-detector.js` 的既有做法）：
 *   · **永不抛错**：内部 try/catch + onWarn，写记忆或注入失败都不影响 DSH 的折叠
 *   · 事件只处理一次（按 event.seq）；shadowedSeqs 为空直接跳过
 *   · 同一 shadowedRange 只写一次（去重）
 *   · 单会话上限 MAX_SNAPSHOTS_PER_SESSION
 *   · 不改变任何宿主状态 —— 观察者是**旁路**；返回值只是给调用方/测试看的回执
 *   · **只处理 `compaction/summary`**：`compaction/prune` 通道 2026-10-17 已移除（生产 25/25 全是噪音，
 *     理由见文件头）
 *
 * @param deps.store 记忆存储（缺它就只观察不写）
 * @param deps.onWarn 内部出错时的告警
 * @param deps.injectReminder `(sessionId, text) => boolean|Promise<boolean>`：把提醒送进会话。
 *   **由 index.js 提供**（要用宿主的 `agent.inject()`），本模块保持对 DSH 零依赖；
 *   缺省 = 不注入（测试/无宿主场景）。
 * @param deps.secretBlocksFile 凭据打码审计文件；缺省从 `store.dataFile` 推导（无则不打审计）
 */
export function makeCompactionSnapshot({
  store,
  onWarn = () => {},
  maxSnapshotsPerSession = MAX_SNAPSHOTS_PER_SESSION,
  maxTextChars = SNAPSHOT_TEXT_CHARS,
  maxItemChars = MAX_ITEM_CHARS,
  maxItemsPerClass = MAX_ITEMS_PER_CLASS,
  patterns = NEGATIVE_CONCLUSION_PATTERNS,
  secretBlocksFile = null,
  injectReminder = null,
} = {}) {
  /** sessionId → { count, seenSeqs:Set, seenRanges:Set } */
  const state = new Map()

  // 审计文件：显式传入优先，否则与 memory.json 同级推导（记忆存储自己知道路径，模块不引入新依赖）
  const auditFile = secretBlocksFile
    || (typeof store?.dataFile === 'string' && store.dataFile ? secretBlocksFileFor(store.dataFile) : null)

  const bucket = (sid) => {
    const key = sid == null ? '' : String(sid)
    let b = state.get(key)
    if (!b) {
      b = { count: 0, seenSeqs: new Set(), seenRanges: new Set() }
      state.set(key, b)
    }
    return b
  }

  function rangeKey(range, seqs) {
    if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) return `${range.start}-${range.end}`
    return seqs.join(',')
  }

  /** 处理一个事件。返回写入回执或 null（跳过/失败）。**不抛错。** */
  async function observe(session, event) {
    try {
      if (!event || !COMPACTION_SNAPSHOT_EVENTS.includes(event.type)) return null
      const data = event.data
      if (!data || typeof data !== 'object') return null
      const seqs = Array.isArray(data.shadowedSeqs) ? [...new Set(data.shadowedSeqs.filter((s) => Number.isFinite(s)))] : []
      if (!seqs.length) return null // 没有遮蔽区：什么都不做

      const sid = session?.id ?? null
      const b = bucket(sid)

      // 每个事件只处理一次
      if (Number.isFinite(event.seq)) {
        if (b.seenSeqs.has(event.seq)) return null
        b.seenSeqs.add(event.seq)
      }

      // 同一遮蔽区只写一次（去重）
      const rkey = rangeKey(data.shadowedRange, seqs)
      if (b.seenRanges.has(rkey)) return null
      b.seenRanges.add(rkey)

      // 单会话上限
      if (b.count >= maxSnapshotsPerSession) return null

      if (!store || typeof store.remember !== 'function') return null

      const facts = extractShadowedFacts(session, seqs, { maxItemChars, maxCollectPerClass: maxItemsPerClass, patterns })

      const fallback = buildFallbackText(facts.nodes, maxTextChars)
      const summary = buildSnapshotSummary({
        nodeCount: seqs.length,
        tokenCount: Number.isFinite(data.shadowedTokenCount) ? data.shadowedTokenCount : 0,
        facts,
        omitted: fallback.omitted,
      })
      const content = buildSnapshotContent({
        facts,
        fallback,
        range: data.shadowedRange,
        shadowedSeqs: seqs,
        shadowedTokenCount: data.shadowedTokenCount,
        compactionId: data.compactionId,
        eventType: event.type,
        maxTextChars: maxTextChars,
        maxItems: maxItemsPerClass,
      })

      // ★ store.remember 会先 await ensureLoaded()，并在疑似含凭据时**抛错**（secret-patterns）。
      //   快照是机械产物、模型没法重写它，所以拒写在这里等于纯损失 → 打码后只重试一次
      //   （见 rememberSnapshot）。任何最终失败都吞掉并告警：钩子绝不中断折叠流程。
      //   source 用 'internal'：这是观察到的会话事实，不是自传体，也不是外部信息。
      const wrote = await rememberSnapshot(
        store,
        {
          summary,
          content,
          tags: [COMPACTION_SNAPSHOT_TAG, 'compaction'],
          sessionId: sid,
          source: 'internal',
        },
        { auditFile, onWarn },
      )
      b.count += 1

      // ★ 折叠后**主动告诉模型一次**（2026-10-17 用户要求）：只写记忆不够 —— 生产上 32 条快照
      //   0 条被打开过，模型根本不知道"刚才那段的原文被抢救到哪了"。注入失败不影响快照本身。
      let injected = false
      let injectError = null
      if (typeof injectReminder === 'function') {
        const record = wrote.record
        const id = record && typeof record === 'object' ? record.id : null
        const text = buildFoldNotice({
          id: typeof id === 'string' ? id : null,
          counts: facts.totals,
          nodeCount: seqs.length,
          tokenCount: Number.isFinite(data.shadowedTokenCount) ? data.shadowedTokenCount : 0,
        })
        try {
          injected = await injectReminder(sid, text)
        } catch (e) {
          injectError = e?.message || String(e)
          onWarn(`折叠提醒注入失败（快照已写入，不受影响）：${injectError}`)
        }
      }

      return { summary, omitted: fallback.omitted, facts, redacted: wrote.redacted, injected, injectError }
    } catch (e) {
      onWarn(`折叠快照失败：${e?.message || e}`)
      return null
    }
  }

  return {
    observe,
    /** 供测试观察内部状态。 */
    snapshotState: (sid) => bucket(sid),
  }
}
