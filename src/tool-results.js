/**
 * 工具返回值的**纯构造函数**（F-15 的一半：把"实际返回什么"变成可单测的东西）。
 *
 * 为什么单独一层：index.js 顶层 import 了宿主的 `@deepseek-ai/schemastery`，
 * 纯 node 单测**import 不了**它 —— 而"声明 vs 实际是否对齐"恰恰必须被断言
 * （这正是 schema 脱节类缺陷复发 4 次却始终没被测试抓住的原因）。
 * 把构造搬到这里后：
 *   · 单测可以喂**真实**输入（真 MemoryStore 的返回值、真 heartbeat.run 的结果、
 *     以及 null —— F-15 现场就是 null）来核对形状；
 *   · index.js 的 `execute` 只剩一句 `return xxxResult(...)`，测试里有一条静态断言盯着它。
 *
 * 纪律：本文件**不 import 任何宿主依赖**，也不做 I/O。
 */

/** 把一条记忆记录投影成回执用的紧凑形状（index.js 里原来叫 summarize）。 */
export function summarize(rec) {
  const out = {
    id: rec.id,
    summary: rec.summary,
    tags: rec.tags,
    layer: rec.layer,
    salience: rec.salience,
  }
  // ★ F-5：只有**真的发生**时才带上这两个字段（省略即"不适用"）。
  //   dormantUnscoped=true 表示 source=dormant 但当时没有 sessionId →
  //   降权**没有发生**，回执必须明说，不许照旧回一句"已写入"。
  if (rec.dormantUnscoped) out.dormantUnscoped = true
  if (rec.scope) out.scope = rec.scope
  return out
}

/**
 * mnemos_remember 的回执形状。
 * @param {object} rec store.remember 的记录
 * @param {{superseded?: any[], possibleSupersedes?: any[]}} [extra] 由调用方决定的策略输入
 */
export function rememberResult(rec, extra = {}) {
  const out = summarize(rec)
  if (extra.superseded) out.superseded = extra.superseded
  if (extra.possibleSupersedes && extra.possibleSupersedes.length) {
    out.possibleSupersedes = extra.possibleSupersedes
  }
  return out
}

/** mnemos_recall：数组（两段式第一段）。非数组一律折成空数组 —— 形状必须可判定。 */
export function recallResult(list) {
  return Array.isArray(list) ? list : []
}

/** mnemos_validate：两个字段都强制成声明的类型（summary 缺失时给空串而不是 null）。 */
export function validateResult(validated, summary) {
  return { validated: !!validated, summary: String(summary ?? '') }
}

/** mnemos_constitution：字符串（未初始化时空串 → 由 self-text 的警告负责可见性）。 */
export function constitutionResult(text) {
  return typeof text === 'string' ? text : ''
}

/** mnemos_delete：只回摘要列表（原来就是 `deleted ? map(summary) : []`）。 */
export function deleteResult(deleted) {
  return { deleted: deleted ? deleted.map((d) => d.summary) : [] }
}

/** mnemos_deprecate：按 ok 分成两摞（`already` 保留，回执要说明"此前已作废"）。 */
export function deprecateResult(done) {
  const list = Array.isArray(done) ? done : []
  return { deprecated: list.filter((d) => d.ok), failed: list.filter((d) => !d.ok) }
}

/** mnemos_dormant：同型 + `unmarked` 如实反映"这次是撤销还是标记"。 */
export function dormantResult(done, unmarked = false) {
  const list = Array.isArray(done) ? done : []
  return { marked: list.filter((d) => d.ok), failed: list.filter((d) => !d.ok), unmarked: !!unmarked }
}

/**
 * mnemos_open：**永不返回 null**（F-15 现场之一）。
 * `store.open(id)` 查不到就返回 null，而声明是 `{type:'object'}` → 宿主报
 * "value must be an object"。改成 `{found:false}`：形状永远可判定，渲染据此回一句"未找到"。
 */
export function openResult(rec) {
  if (!rec || typeof rec !== 'object') return { found: false }
  return { found: true, ...rec }
}

/**
 * mnemos_consolidate：**永不返回 null**（F-15 的直接病灶）。
 *
 * ★ 顺带修掉一个真 bug：回执原来用 `value.scope === '__unassigned__' || !value.sessionId`
 *   判"未作用域化"，而旧 `summarize()` 里**根本没有 sessionId** → `!undefined` 恒为真 →
 *   **有会话的归档也会被说成"当前会话没有 id"**。判定搬到构造函数（这里能看见 rec 的全部字段），
 *   产出显式的 `unscoped` 布尔，渲染只读它。
 */
export function consolidateResult(rec, report = null) {
  // ★ 归档闸门（2026-10-17）：受保护记录不参与归档，回执必须说清"有几条被留下"，
  //   否则"没有可归档的短时记忆"会被误读成"真的没有记录"。
  const kept = report && Number.isFinite(report.protected) ? report.protected : 0
  const protectedField = kept > 0 ? { protected: kept } : {}
  if (!rec || typeof rec !== 'object') return { archived: false, unscoped: false, ...protectedField }
  const out = { archived: true, ...summarize(rec) }
  out.unscoped = rec.scope === '__unassigned__' || !rec.sessionId
  return { ...out, ...protectedField }
}

/** mnemos_heartbeat：取 heartbeat.run 的 {ranAt, results}；非对象一律折成合法空形状。 */
export function heartbeatResult(run) {
  const r = run && typeof run === 'object' ? run : {}
  return {
    ranAt: Number.isFinite(r.ranAt) ? r.ranAt : Date.now(),
    results: Array.isArray(r.results) ? r.results : [],
  }
}

/** mnemos_maintenance_list：数组。 */
export function maintenanceListResult(list) {
  return Array.isArray(list) ? list : []
}

/** mnemos_heartbeat_toggle：只回一个布尔。 */
export function toggleResult(enabled) {
  return { enabled: !!enabled }
}

/**
 * mnemos_learner_kick（诊断工具）：把 runLearnerKick 的结果折成形状固定的回执。
 * ★ 为什么要有这个构造器：宿主 "value must be an object" 那条错，本项目栽过多次
 *   （mnemos_consolidate 返回 null、mnemos_open id 不存在），所以关键字段必须显式给默认值。
 */
export function learnerKickResult(r) {
  const v = r && typeof r === 'object' ? r : {}
  const out = {
    sessionId: typeof v.sessionId === 'string' ? v.sessionId : '',
    skipped: !!v.skipped,
  }
  if (typeof v.reason === 'string') out.reason = v.reason
  if (Number.isFinite(v.minutesUntil)) out.minutesUntil = v.minutesUntil
  if (typeof v.created === 'boolean') out.created = v.created
  if (typeof v.resumed === 'boolean') out.resumed = v.resumed
  if (Number.isFinite(v.staleRemoved)) out.staleRemoved = v.staleRemoved
  if (v.sent) out.sent = true
  if (typeof v.waited === 'boolean') out.waited = v.waited
  if (typeof v.waitReason === 'string') out.waitReason = v.waitReason
  if (typeof v.statusAfter === 'string') out.statusAfter = v.statusAfter
  if (typeof v.getError === 'string') out.getError = v.getError
  if (typeof v.error === 'string') out.error = v.error
  // ★ 会话重建（2026-10-17 加）：诊断时要能看出"这次是不是把会话删掉重建了、为什么"
  if (v.recycle && typeof v.recycle === 'object') {
    out.recycled = true
    if (typeof v.recycle.from === 'string') out.recycleFrom = v.recycle.from
    if (typeof v.recycle.to === 'string') out.recycleTo = v.recycle.to
    if (typeof v.recycle.reason === 'string') out.recycleReason = v.recycle.reason
    // 人话版本由 learner-loop.js 的 describeLearnerRecycle 生成（措辞只有一处）
    if (typeof v.recycle.text === 'string') out.recycleWhy = v.recycle.text
  }
  return out
}

/**
 * mnemos_propose_skill：真正的构造函数是 skill-review.js 的 `createSkill`
 * （它自己已有 omitNulls 与 100~103 节的断言）。这里只做**最后一道兜底**：
 * null/undefined 到宿主那里就是 "value must be an object"，所以折成一个形状合法的拒绝回执。
 */
export function proposeSkillResult(r) {
  if (r && typeof r === 'object' && !Array.isArray(r)) return r
  return { ok: false, verdict: 'rejected', reason: '内部错误：技能提议没有返回结果对象' }
}

/* ───────── 任务图（多 agent 协作，2026-10-17）：三个形状固定的构造函数 ─────────
 *
 * 共同纪律：**成功与拒绝形状同构** —— 拒绝时只有 `{ok:false, reason}`，绝不返回 null，
 * 也绝不把 reason 之外的字段泄漏出去（F-15 的老病灶就是不存在的形状）。
 */

/** mnemos_task_open：开图回执。 */
export function taskOpenResult(r) {
  const v = r && typeof r === 'object' ? r : {}
  const out = { ok: v.ok === true }
  if (typeof v.reason === 'string') out.reason = v.reason
  if (typeof v.taskId === 'string') out.taskId = v.taskId
  if (typeof v.graphId === 'string') out.graphId = v.graphId
  if (typeof v.ownerSession === 'string') out.ownerSession = v.ownerSession
  if (Array.isArray(v.assignments)) out.assignments = v.assignments.filter((x) => typeof x === 'string')
  return out
}

/** mnemos_task_update：把回执填进图后的回执。 */
export function taskUpdateResult(r) {
  const v = r && typeof r === 'object' ? r : {}
  const out = { ok: v.ok === true }
  if (typeof v.reason === 'string') out.reason = v.reason
  if (typeof v.taskId === 'string') out.taskId = v.taskId
  if (typeof v.assign === 'string') out.assign = v.assign
  if (typeof v.status === 'string') out.status = v.status
  if (typeof v.handoffId === 'string') out.handoffId = v.handoffId
  if (Number.isFinite(v.graphVersion)) out.graphVersion = v.graphVersion
  return out
}

/** mnemos_task_close：收尾回执（含未完成清单与"丢弃了哪些临时中间结果"）。 */
export function taskCloseResult(r) {
  const v = r && typeof r === 'object' ? r : {}
  const out = { ok: v.ok === true }
  if (typeof v.reason === 'string') out.reason = v.reason
  if (typeof v.taskId === 'string') out.taskId = v.taskId
  if (typeof v.longTermId === 'string') out.longTermId = v.longTermId
  if (Array.isArray(v.rolled)) {
    out.rolled = v.rolled
      .filter((x) => x && typeof x === 'object')
      .map((x) => ({
        assign: typeof x.assign === 'string' ? x.assign : '',
        status: typeof x.status === 'string' ? x.status : '',
        ...(typeof x.handoffId === 'string' ? { handoffId: x.handoffId } : {}),
        ...(typeof x.note === 'string' && x.note ? { note: x.note } : {}),
      }))
  }
  if (Array.isArray(v.missing)) {
    out.missing = v.missing
      .filter((x) => x && typeof x === 'object')
      .map((x) => ({
        id: typeof x.id === 'string' ? x.id : '',
        task: typeof x.task === 'string' ? x.task : '',
        status: typeof x.status === 'string' ? x.status : '',
      }))
  }
  if (v.discarded && typeof v.discarded === 'object') {
    out.discarded = {
      count: Number.isFinite(v.discarded.count) ? v.discarded.count : 0,
      items: Array.isArray(v.discarded.items)
        ? v.discarded.items
            .filter((x) => x && typeof x === 'object')
            .map((x) => ({
              id: typeof x.id === 'string' ? x.id : '',
              summary: typeof x.summary === 'string' ? x.summary : '',
            }))
        : [],
    }
  }
  if (Number.isFinite(v.keptScratch)) out.keptScratch = v.keptScratch
  return out
}
