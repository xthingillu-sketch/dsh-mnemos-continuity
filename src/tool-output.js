/**
 * 工具返回值形状的**唯一真相源**（F-15 结构性修复）。
 *
 * 背景：`value must be an object` 是 **schema 脱节类缺陷的第 4 次复发**
 * （前三次：`value.path` 必须是字符串 → 加 omitNulls()；漏声明 `unmarked`；漏加返回路径字段）。
 * 按项目第 17 条原则：**同类复发 = 修法层次不够** —— 所以这次不补字段，改结构：
 *
 *   ① **形状只写一遍**。`TOOL_OUTPUT_SPECS` 一张表同时产出两样东西：
 *      · `buildOutputSchema(name)` —— 交给宿主的 JSON Schema（每个工具的 `output.schema`
 *        **必须**由它生成，测试里有静态断言盯着）；
 *      · `checkToolOutput(name, value)` —— 同一份规格的**运行时结构校验**。
 *      于是"声明 vs 实际"不可能再各说各话：改一处，两边同时改。
 *   ② 每个工具的返回值由 `tool-results.js` 的**纯构造函数**产出（可被单测直接喂真实输入，
 *      包括 null —— 那正是 F-15 现场）。
 *   ③ 注册处统一过一道闸门 `withToolOutputGate`：先规范化（null 一律省略），再结构校验，
 *      不合规就**大声告警**。生产上是 **fail-open**（只告警、不改写返回值 ——
 *      绝不让新校验把工具打瘸）；测试里用同一个 `checkToolOutput` 直接断言，所以
 *      "下一次漏字段"在测试里就会挂，而不是等真机报 `value must be...`。
 *
 * 为什么 null 必须**永不返回**（而不是给 schema 加 nullable）：
 *   宿主 schema 里没有 null 类型。`{type:'object'}` + `return null` 就是
 *   "value must be an object" 的确切来源 —— `mnemos_consolidate`（没东西可归档时）
 *   与 `mnemos_open`（id 不存在时）都真的会返回 null。
 *   修法是把"没有"也表达成对象：`{archived:false}` / `{found:false}` ——
 *   形状永远可判定，渲染函数也永远拿到一个对象。
 */

/** 一个属性规格 = JSON Schema 的一个子集（够用即可，不引入校验库）。 */
const str = () => ({ type: 'string' })
const num = () => ({ type: 'number' })
const bool = () => ({ type: 'boolean' })
const arr = (items) => (items ? { type: 'array', items } : { type: 'array' })

/**
 * 工具名 → 返回值规格。**所有** 13 个工具都在这里，一个都不能少
 * （少一个 = 该工具的形状没人管；有单测断言"注册的工具名集合 == 本表的键集合"）。
 *
 * `additionalProperties`：对象默认 false（未声明的字段即缺陷）。
 * 唯一的例外是 `mnemos_open`（它透传记忆记录本身，字段随 store 演进，见该条注释）。
 */
export const TOOL_OUTPUT_SPECS = {
  mnemos_remember: {
    type: 'object',
    required: ['id', 'summary'],
    properties: {
      id: str(), summary: str(), tags: arr({ type: 'string' }), layer: str(), salience: str(),
      superseded: arr(), possibleSupersedes: arr(), dormantUnscoped: bool(), scope: str(),
    },
  },
  mnemos_recall: {
    type: 'array',
    // 两段式第一段：只回摘要（无 detail）。字段由 store.recall 投影决定，已对齐。
    items: {
      type: 'object',
      required: ['id', 'summary', 'salience', 'layer'],
      additionalProperties: true, // 投影字段随召回层演进（dormantHere/sessionId/createdAt…）
      properties: {
        id: str(), summary: str(), tags: arr({ type: 'string' }), taskId: str(), salience: str(),
        layer: str(), source: str(), dormantHere: bool(), sessionId: str(), createdAt: num(),
      },
    },
  },
  mnemos_validate: {
    type: 'object',
    required: ['validated'],
    properties: { validated: bool(), summary: str() },
  },
  mnemos_constitution: { type: 'string' },
  mnemos_delete: {
    type: 'object',
    required: ['deleted'],
    properties: { deleted: arr({ type: 'string' }) },
  },
  mnemos_deprecate: {
    type: 'object',
    required: ['deprecated'],
    properties: {
      deprecated: arr({ type: 'object', required: ['id'], additionalProperties: true, properties: { id: str(), summary: str(), ok: bool(), already: bool(), from: str() } }),
      failed: arr({ type: 'object', required: ['id'], additionalProperties: true, properties: { id: str(), reason: str() } }),
    },
  },
  mnemos_dormant: {
    type: 'object',
    required: ['marked'],
    properties: {
      marked: arr({ type: 'object', required: ['id'], additionalProperties: true, properties: { id: str(), summary: str(), ok: bool(), already: bool(), sessionId: str() } }),
      failed: arr({ type: 'object', required: ['id'], additionalProperties: true, properties: { id: str(), reason: str() } }),
      unmarked: bool(),
    },
  },
  mnemos_open: {
    type: 'object',
    required: ['found'],
    // ★ 唯一允许 additionalProperties:true 的工具：它**透传记忆记录本身**
    //   （id/summary/tags/detail/layer/salience/source/dormIn/supersededBy…
    //   还有 store 内部的 recency/version/createdAt/sessionId）。逐字段声明会让
    //   "记录多一个内部字段"变成一次假的形状失败 —— 那不是我们要防的脱节。
    additionalProperties: true,
    properties: {
      found: bool(), id: str(), summary: str(), tags: arr({ type: 'string' }), layer: str(),
      salience: str(), source: str(), detail: str(), dormIn: arr({ type: 'string' }), supersededBy: str(),
    },
  },
  mnemos_consolidate: {
    type: 'object',
    required: ['archived'],
    properties: {
      archived: bool(), unscoped: bool(), id: str(), summary: str(), tags: arr({ type: 'string' }),
      layer: str(), salience: str(), scope: str(),
      // ★ 归档闸门（2026-10-17）：被闸门留下、没参与归档的条数
      protected: num(),
    },
  },
  mnemos_heartbeat: {
    type: 'object',
    required: ['ranAt', 'results'],
    properties: {
      ranAt: num(),
      results: arr({
        type: 'object',
        required: ['name', 'ok'],
        additionalProperties: true,
        properties: { name: str(), ok: bool(), result: {}, error: str() },
      }),
      // ★ V6-01：心跳开始处的磁盘刷新回执（让"先刷新再维护"可见，而不是只有内部知道）
      refresh: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: bool(), refreshed: bool(), added: num(), tombstoned: num(), total: num(), error: str() },
      },
    },
  },
  mnemos_maintenance_list: {
    type: 'array',
    items: { type: 'object', required: ['name', 'description'], properties: { name: str(), description: str() } },
  },
  mnemos_heartbeat_toggle: {
    type: 'object',
    required: ['enabled'],
    properties: { enabled: bool() },
  },
  // ★ 诊断工具：立刻踢一次空闲学习，并如实回报每个分支（到点判定/resume/create/入队）
  mnemos_learner_kick: {
    type: 'object',
    required: ['sessionId', 'skipped'],
    properties: {
      sessionId: str(),
      skipped: bool(),
      reason: str(),
      minutesUntil: num(),
      created: bool(),
      resumed: bool(),
      staleRemoved: num(),
      sent: bool(),
      waited: bool(),
      waitReason: str(),
      statusAfter: str(),
      getError: str(),
      error: str(),
      // ★ 会话重建（2026-10-17 加）：本次是否把会话删掉重建、为什么
      recycled: bool(),
      recycleFrom: str(),
      recycleTo: str(),
      recycleReason: str(),
      recycleWhy: str(),
    },
  },
  mnemos_propose_skill: {
    // 构造函数 = skill-review.js 的 createSkill（自己已有 omitNulls 与 100~103 节的断言）；
    // tool-results.js 里的 proposeSkillResult 只兜底"必须是个对象"。
    type: 'object',
    required: ['ok', 'verdict'],
    properties: {
      ok: bool(), verdict: str(), reason: str(), path: str(), missing: arr(), overlaps: arr(),
      sourceNotVerified: str(), capLimit: num(), existingCount: num(),
      origin: str(), requiresUserConsent: bool(), eventsCount: num(),
      externalSource: {
        type: 'object',
        properties: { kind: str(), ref: str(), note: str() },
      },
    },
  },
  // ── 任务图（多 agent 协作，2026-10-17）：开图 / 填回执 / 收尾 ──
  //   ★ 三个工具共用 `ok` 作为必需字段：成功与拒绝**形状同构**（拒绝时只有 ok:false + reason），
  //     免得"出错时返回 null"那种 F-15 老病灶再出现。
  mnemos_task_open: {
    type: 'object',
    required: ['ok'],
    properties: {
      ok: bool(), reason: str(), taskId: str(), graphId: str(), ownerSession: str(),
      assignments: arr({ type: 'string' }),
      links: arr({ type: 'string' }),
      linkTruncated: bool(),
    },
  },
  mnemos_task_update: {
    type: 'object',
    required: ['ok'],
    properties: {
      ok: bool(), reason: str(), taskId: str(), assign: str(), status: str(),
      handoffId: str(), graphVersion: num(),
    },
  },
  mnemos_task_close: {
    type: 'object',
    required: ['ok'],
    properties: {
      ok: bool(), reason: str(), taskId: str(), longTermId: str(),
      rolled: arr({ type: 'object', properties: { assign: str(), status: str(), handoffId: str(), note: str() } }),
      missing: arr({ type: 'object', properties: { id: str(), task: str(), status: str() } }),
      unlabeledHandoffs: arr({ type: 'object', properties: { id: str(), handoffId: str() } }),
      discarded: {
        type: 'object',
        properties: { count: num(), items: arr({ type: 'object', properties: { id: str(), summary: str() } }) },
      },
      keptScratch: num(),
      doneCount: num(), usesCount: num(), linksCount: num(),
    },
  },
  mnemos_task_done: {
    type: 'object',
    required: ['ok'],
    properties: { ok: bool(), reason: str(), taskId: str(), doneCount: num(), truncated: bool() },
  },
  mnemos_task_cite: {
    type: 'object',
    required: ['ok'],
    properties: {
      ok: bool(), reason: str(), taskId: str(),
      added: num(), skipped: num(), usesCount: num(), truncated: bool(),
    },
  },
}

/** 表中声明的工具名（有序，便于报错/清单）。 */
export const TOOL_NAMES = Object.keys(TOOL_OUTPUT_SPECS)

/** 规格 → 宿主用的 JSON Schema（结构与校验共用一份规格，所以不会漂移）。 */
export function buildOutputSchema(name) {
  const spec = TOOL_OUTPUT_SPECS[name]
  if (!spec) throw new Error(`[mnemos-tool-output] 未声明的工具形状：${name}（新增工具必须先在 TOOL_OUTPUT_SPECS 里声明）`)
  return toJsonSchema(spec)
}

function toJsonSchema(spec) {
  if (!spec || typeof spec.type !== 'string') return {} // 空规格 = 任意值（如 heartbeat 每个 result 的内容）
  const out = { type: spec.type }
  if (spec.type === 'object') {
    out.additionalProperties = spec.additionalProperties === true
    if (spec.properties) {
      out.properties = {}
      for (const [k, p] of Object.entries(spec.properties)) out.properties[k] = toJsonSchema(p)
    }
    if (Array.isArray(spec.required) && spec.required.length) out.required = [...spec.required]
  }
  if (spec.type === 'array' && spec.items) out.items = toJsonSchema(spec.items)
  return out
}

const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? '数组' : typeof v)

function checkValue(spec, v, at, errors) {
  switch (spec.type) {
    case 'string':
      if (typeof v !== 'string') errors.push(`${at}: 应为字符串，实际 ${typeName(v)}`)
      return
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${at}: 应为数字，实际 ${typeName(v)}`)
      return
    case 'boolean':
      if (typeof v !== 'boolean') errors.push(`${at}: 应为布尔，实际 ${typeName(v)}`)
      return
    case 'array':
      if (!Array.isArray(v)) { errors.push(`${at}: 应为数组，实际 ${typeName(v)}`); return }
      if (spec.items) v.forEach((it, i) => checkValue(spec.items, it, `${at}[${i}]`, errors))
      return
    case 'object': {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        // ★ 这一条就是 F-15 现场（mnemos_consolidate 返回 null → "value must be an object"）
        errors.push(`${at}: 应为对象，实际 ${typeName(v)}`)
        return
      }
      for (const k of spec.required || []) {
        if (!(k in v)) errors.push(`${at}.${k}: 缺少必需字段`)
      }
      for (const [k, p] of Object.entries(spec.properties || {})) {
        if (k in v) checkValue(p, v[k], `${at}.${k}`, errors)
      }
      if (spec.additionalProperties !== true) {
        const declared = new Set(Object.keys(spec.properties || {}))
        for (const k of Object.keys(v)) {
          if (!declared.has(k)) errors.push(`${at}.${k}: 未声明的字段（additionalProperties: false）`)
        }
      }
      return
    }
    default:
      return // 空规格 = 任意值（如 heartbeat 的每个 result 内容）
  }
}

/**
 * 结构校验（不抛错）。
 * @returns {{ok: boolean, errors: string[]}} errors 里每一条都带字段路径，便于直接贴进报告。
 */
export function checkToolOutput(name, value) {
  const spec = TOOL_OUTPUT_SPECS[name]
  if (!spec) return { ok: false, errors: [`未知工具 ${name}（形状表里没有它）`] }
  const errors = []
  checkValue(spec, value, name, errors)
  return { ok: errors.length === 0, errors }
}

/**
 * 规范化：**递归省略 null / undefined 的字段**（数组元素保留，只清对象键）。
 *
 * 理由：宿主 schema 里没有 null 类型（这正是前三次复发的一半来源，项目里已有 `omitNulls` 的做法），
 * 而"省略即不适用"是本项目一贯的语义。统一在出口做一次，就不必每个工具各写一遍。
 */
export function normalizeToolValue(value) {
  if (Array.isArray(value)) return value.map(normalizeToolValue)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue
    out[k] = normalizeToolValue(v)
  }
  return out
}

/**
 * 统一出口闸门：`execute` 的返回值先规范化、再按声明的形状校验。
 *
 * fail-open 是本项目的硬约束（见 store-lock.js）：校验失败**只告警、不改写返回值** ——
 * 宁可让一次回执长得不合规格，也不能让工具直接坏掉。判别力放在测试里（同一个 checkToolOutput）。
 *
 * @param {object} tool 工具定义
 * @param {{onWarn?: (msg:string)=>void}} [o]
 */
export function withToolOutputGate(tool, { onWarn = null, onExecute = null } = {}) {
  const name = tool.name
  const orig = tool.execute
  if (typeof orig !== 'function') return tool
  return {
    ...tool,
    async execute(args, exec) {
      // ★ 给调用方一个"工具被调用"的钩子：Mnemos 用它记住**当前活着的 agent**
      //   （宿主的派活要求父会话是活 agent，而定时器触发的空闲学习没有调用方）。钩子出错不影响工具本身。
      if (typeof onExecute === 'function') {
        try {
          onExecute(args, exec)
        } catch {
          // 忽略：这是旁路观察，绝不该影响工具执行
        }
      }
      const value = normalizeToolValue(await orig.call(this, args, exec))
      const r = checkToolOutput(name, value)
      if (!r.ok && typeof onWarn === 'function') {
        onWarn(
          `[mnemos-tool-output] ${name} 的返回值与声明的形状不符（F-15 要防的就是这类脱节）：` +
          r.errors.join('；')
        )
      }
      return value
    },
  }
}
