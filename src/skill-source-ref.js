/**
 * 反例的「来源标识」（F-10）—— 把"编造的槽反例"挡在**机械**闸门之外。
 *
 * 起因（实证）：`createSkill` 的硬门槛只检查 `counterexample` 非空 →
 *   拦得住"没写"，拦不住"编的"；而独立验证者只拿到提议者的**自述**、
 *   无原文可对照，于是"编一个具体场景"能稳定通过。
 *
 * 这里只做三件**纯机械**的事（正则/查表，不调 LLM、不判断真伪）：
 *   ① 解析：反例文本里必须出现 `session=<会话ID>` 与 `seq=<序号>`（格式单一真相源见下）
 *   ② 核实：宿主给了会话日志（Session 实例）时，按 seq 取那条事件原文，交给验证者对照
 *   ③ 降级：取不到原文时**明说"来源未核实"** —— 允许通过，但绝不假装核对过
 *
 * 接口核实（写代码前核对过，不凭印象）：
 *   · 工具执行入参：`ToolExecutionInput = { callId, name, arguments, agent, signal }`
 *     （`@deepseek-ai/dsh-agent-loop` lib 源码 `executeToolCalls`：`planned = toolCalls.map(block => ({block, exec:{callId,name,arguments,agent,signal}}))`），
 *     而 `agent.session` 就是 Session 实例 → 所以 `execute(args, exec)` 里能拿到会话日志。
 *   · `Session.eventAt(seq)` 返回 `this.log[seq]`（`dsh-session/lib/index.js:1363`，宿主标注 @deprecated 但仍在用），
 *     `Session.seq` = 日志长度（同文件 1401），`deriveEventMessage(event)`（同文件 1576）→
 *     原文提取复用 compaction-snapshot 里已核对过的那条路（`derivedMessage` / `nodeText`）。
 */
import { derivedMessage, nodeText } from './compaction-snapshot.js'

/**
 * 来源标识的**书写格式**（单一真相源）。
 * 注入给模型的提示（F-8）、工具参数说明（index.js）、本模块的解析器三处共用这一个字符串，
 * 避免"提示教一种写法、解析器只认另一种"。
 */
export const SOURCE_REF_FORMAT_HINT = '来源：session=<会话ID> seq=<事件序号>'

/** 工具参数里对 counterexample 的说明（索引到同一个格式真相源）。 */
export const COUNTEREXAMPLE_PARAM_DESCRIPTION =
  `反例：没有这个技能时会做错的具体场景（必填）。必须可溯源：正文里写清 ${SOURCE_REF_FORMAT_HINT}，` +
  '缺来源会被机械拒绝（不调模型判断，只解析格式 + 按 seq 核对原文）。'

const SESSION_RE = /session\s*[=＝:：]\s*([A-Za-z0-9._-]+)/i
const SEQ_RE = /seq\s*[=＝:：]\s*([0-9]+)/i
const KEYWORD_RE = /session|seq/i

/** 原文交给验证者时的字符上限（省 token，够对照即可）。 */
export const SOURCE_TEXT_CHARS = 600

/** 拼一条可被本模块解析回来的来源标识。 */
export function formatSourceRef(sessionId, seq) {
  const sid = String(sessionId ?? '').trim() || '<会话ID>'
  const s = Number.isSafeInteger(Number(seq)) && Number(seq) >= 0 ? Number(seq) : '<事件序号>'
  return `来源：session=${sid} seq=${s}`
}

/**
 * 机械解析反例文本里的来源标识。**纯正则**，不看语义。
 *
 * @returns {{ok:false,kind:'missing'|'malformed',reason:string}}
 *        | {{ok:true,session:string,seq:number,raw:string}}
 */
export function parseSourceRef(text) {
  const s = String(text ?? '')
  const sm = SESSION_RE.exec(s)
  const qm = SEQ_RE.exec(s)
  if (sm && qm) {
    const seq = Number(qm[1])
    if (!Number.isSafeInteger(seq) || seq < 0) {
      return {
        ok: false,
        kind: 'malformed',
        reason: `反例的来源序号不合法（seq=${qm[1]}）：${SOURCE_REF_FORMAT_HINT}`,
      }
    }
    return { ok: true, session: sm[1], seq, raw: sm[0] + ' ' + qm[0] }
  }
  if (KEYWORD_RE.test(s)) {
    // 出现了 session/seq 关键字却没解析出来（缺一半、或写了非数字的 seq）
    return {
      ok: false,
      kind: 'malformed',
      reason:
        `反例的来源格式不合法：需要同时给出会话与序号，形如「${SOURCE_REF_FORMAT_HINT}」` +
        `（当前只解析到 ${sm ? '会话' : ''}${sm && !qm ? '、缺 seq' : ''}${!sm && qm ? '序号、缺 session' : ''}）`,
    }
  }
  return {
    ok: false,
    kind: 'missing',
    reason: `反例缺来源标识：需要按「${SOURCE_REF_FORMAT_HINT}」写清这段反例来自哪个会话的哪个事件（不调模型判断，只机械核对）`,
  }
}

/**
 * 按来源标识去会话日志里取原文（取不到就降级，不猜、不假装）。
 *
 * @param ref parseSourceRef 的结果
 * @param deps.session 宿主 Session 实例（可为 null：无日志 → 降级）
 * @returns {{verified:boolean, exists:boolean|null, note:string, text:string|null, type:string|null}}
 *   `exists === false` 表示**拿到了日志却查不到这个 seq** —— 那是"来源不存在"，
 *   调用方据此拒绝；`exists === null` 表示本机根本没有日志可比对 → 只能降级标注。
 */
export function resolveSourceRef(ref, { session = null } = {}) {
  const base = { verified: false, exists: null, note: '', text: null, type: null }
  if (!ref?.ok) return { ...base, note: '来源格式不合法，未核实' }
  if (!session || typeof session.eventAt !== 'function') {
    return { ...base, note: '本机取不到该会话的日志 → 来源未核实（按提议者自述对待，不要假设它已被核对）' }
  }
  const sid = session.id ?? null
  if (sid && ref.session !== sid) {
    return {
      ...base,
      note: `来源声称的会话（${ref.session}）不是当前会话（${sid}）→ 本机无法核实该 seq 的原文`,
    }
  }
  const end = Number.isFinite(Number(session.seq)) ? Number(session.seq) : null
  if (end !== null && ref.seq >= end) {
    return { ...base, exists: false, note: `会话日志里没有 seq=${ref.seq}（日志共 ${end} 个事件，序号只到 ${end - 1}）` }
  }
  const { ev, msg } = derivedMessage(session, ref.seq)
  if (!ev) return { ...base, exists: false, note: `会话日志在 seq=${ref.seq} 处没有事件` }
  const text = nodeText(ev, msg) || ''
  return {
    verified: true,
    exists: true,
    note: '',
    text: text.slice(0, SOURCE_TEXT_CHARS),
    type: ev.type ?? null,
  }
}
