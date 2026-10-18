/**
 * dsh-mnemos 卡住检测（机制，不靠模型自觉）
 *
 * 起因（实测）：sensenova 会话里用户连说 **5 次「已重启」**，模型每次换一种恢复方式继续试，
 * **从未就该问题 recall 过一次** —— 而答案早 13 小时就写在记忆库里。
 * 同一会话里它在**换方向**时（turn 7）会主动 recall → **能力有，缺的是触发条件**。
 *
 * 而本项目的硬教训是：**凡是"靠模型自觉"的地方，都会以完全相同的方式失败。**
 * 所以这里不满足于往系统提示里加一条规则（那仍是靠自觉），而是**机械检测 + 注入**：
 * 一旦出现"卡住"的客观信号，就在工具结果后追加一行提示，让模型在**当场**想起来去查记忆。
 *
 * 与 `tool-guidance.js` 同形，也遵守同一条接口事实（已核实）：
 * DSH 明确让 unknown-tool 失败也走 post-execute，且 `postExecute` 只禁止替换 failed result 的
 * `value`，**不禁止替换 `content`** —— 所以这里只**追加 content**，从不改 value。
 *
 * 刻意克制：有阈值、有冷却、每会话独立，且提示只有三行 —— 它不该变成噪声。
 */
import { plain } from './plain-text.js'
import { isToolFailure } from './compaction-snapshot.js'
import { formatSourceRef } from './skill-source-ref.js'

/** 连续失败多少次算卡住。 */
export const STUCK_FAIL_THRESHOLD = 3
/** 同一调用（工具名 + 入参）重复多少次算卡住。 */
export const STUCK_REPEAT_THRESHOLD = 3
/** 提示之后的冷却（按该会话的调用次数），避免刷屏。 */
export const STUCK_COOLDOWN_CALLS = 8
/** 入参指纹的长度上限。 */
const ARG_DIGEST_CHARS = 200
/** 回扫"最后一个失败结果"时最多看多少个事件（提示只在极少数时刻发出，代价值得）。 */
const FAILURE_LOOKBACK_EVENTS = 200

/** 用「工具名 + 入参指纹」作为"同一次调用"的判据。 */
export function callKey(exec) {
  const name = exec?.name ?? '?'
  let args = ''
  try {
    args = JSON.stringify(exec?.arguments ?? {})
  } catch {
    args = '<不可序列化>'
  }
  return `${name}::${args.slice(0, ARG_DIGEST_CHARS)}`
}

/** 从执行记录里判断这次是否失败。 */
export function isFailed(result) {
  if (!result) return false
  if (result.isError === true) return true
  const err = result.error
  return Boolean(err && (err.code || err.name))
}

/**
 * 组装卡住提示文本。`reason` 说明触发的客观依据（连续失败 / 重复调用）。
 */
export function buildStuckHint(reason) {
  return plain([
    '[卡住提示 · 先查记忆再换方法]',
    `触发依据（客观计数）：${reason}。`,
    '在换下一个方法之前，先做一次 `mnemos_recall`，查询词就用你正困惑的那件事。',
    '答案不在你的上下文里，不等于不存在 —— 记忆体是跨会话的，别人（或过去的你）可能已经写过一遍。',
  ].join('\n'))
}

/**
 * F-8：这段「失败 → 修好」值得沉淀 —— 在**成功结束**之后追加的引导（不调 LLM、零额外成本）。
 *
 * 为什么不在"卡住当下"说：那一刻模型还不知道能不能解决，说了也只是噪声；
 * 只有"失败流**以成功结束**"才证明做法存在、可复用。
 *
 * `seq` 是回扫会话日志找到的**最后一个失败结果事件**的序号：把它写进提示，
 * 模型才有东西可以照抄进 `counterexample` 的来源标识（F-10 的机械闸门要求 session + seq），
 * 否则闸门就成了够不着的门槛（提示教一种写法、却给不出可用的值）。
 */
export function buildSkillProposalHint({ reason, sessionId = null, seq = null } = {}) {
  const ref = seq === null ? null : formatSourceRef(sessionId, seq)
  return plain([
    '[失败→修好 · 值得沉淀]',
    `触发依据（客观计数）：${reason}。`,
    '如果刚才的修法是可复用的做法，用 `mnemos_propose_skill` 把它记成任务型技能：' +
      '`counterexample` 引用刚才的失败原文并写清来源，`positiveCase` 引用修好后的做法。',
    ref
      ? `可直接引用的来源标识：${ref}（该 seq 是最后一个失败结果事件）。`
      : '来源标识要写清会话与事件序号（形如 来源：session=... seq=...），缺了会被机械拒绝。',
    '一次性的经验写记忆就够，别建技能；每轮都要遵守的纪律型内容也不进技能库。',
  ].join('\n'))
}

/**
 * 回扫会话日志，取**最后一个失败的工具结果事件**的 seq（取不到就 null，不猜）。
 *
 * 接口核实：`Session.eventAt(seq)` / `Session.seq` 都在 Session 实例上
 * （`dsh-session/lib/index.js:1363` / `1401`，见 skill-source-ref.js 文件头）；
 * `isToolFailure` 判失败用的是已核对过的 `tool/result` 形状。
 */
export function findLastFailureSeq(session, { maxScan = FAILURE_LOOKBACK_EVENTS } = {}) {
  try {
    const end = Number(session?.seq)
    if (!Number.isFinite(end) || typeof session?.eventAt !== 'function') return null
    const from = Math.max(0, end - maxScan)
    for (let seq = end - 1; seq >= from; seq--) {
      const ev = session.eventAt(seq)
      if (ev?.type !== 'tool/result') continue
      if (isToolFailure(ev)) return seq
    }
  } catch {
    /* 取不到就不带具体 seq：提示照发，只是要求模型自己写来源 */
  }
  return null
}


/**
 * 构造 `tools/post-execute` 钩子。按会话独立计数，命中阈值后追加一次提示并进入冷却。
 *
 * @param deps.onWarn 内部出错时的告警（钩子绝不能影响工具结果）
 */
export function makeStuckDetector({ onWarn = () => {} } = {}) {
  /** sessionId → { failStreak, lastKey, repeat, sinceHint, episodeFailHit, episodeFails } */
  const state = new Map()

  const bucket = (sid) => {
    let b = state.get(sid)
    if (!b) {
      b = {
        failStreak: 0,
        lastKey: null,
        repeat: 0,
        sinceHint: STUCK_COOLDOWN_CALLS,
        // F-8：这一"段"失败流里是否曾达到客观失败阈值（跨过卡住提示的计数清零）
        episodeFailHit: false,
        // 该段失败流里累计的失败次数（成功结束时报进提示依据）
        episodeFails: 0,
      }
      state.set(sid, b)
    }
    return b
  }

  /**
   * 只做计数，返回本次该注入什么（纯逻辑，便于测试）。
   *
   * 两种注入**共用**同一套计数与冷却钟（`sinceHint`）：
   *   · `stuck`   —— 卡住当下：连续失败 ≥ 阈值 / 同一调用重复 ≥ 阈值
   *   · `recovery`—— F-8：这段失败流**以成功结束**（"失败→修好"）
   * 冷却只挡"卡住提示"的重复刷屏；"修好"是这一段失败流**唯一一次**的收尾
   * （`episodeFailHit` 随即清零），所以它不必再被冷却挡住 —— 否则它永远发不出来
   * （卡住提示刚刚把冷却钟归零），变成死代码。
   *
   * @returns {null | {kind:'stuck'|'recovery', reason:string}}
   */
  function observeEvent(sessionId, exec, result) {
    const b = bucket(sessionId)
    b.sinceHint++

    const failed = isFailed(result)
    if (failed) {
      b.failStreak++
      b.episodeFails++
      if (b.failStreak >= STUCK_FAIL_THRESHOLD) b.episodeFailHit = true
    }

    const key = callKey(exec)
    if (key === b.lastKey) b.repeat++
    else { b.lastKey = key; b.repeat = 1 }

    const failHit = b.failStreak >= STUCK_FAIL_THRESHOLD
    const repeatHit = b.repeat >= STUCK_REPEAT_THRESHOLD
    if ((failHit || repeatHit) && b.sinceHint >= STUCK_COOLDOWN_CALLS) {
      const reason = failHit
        ? `同一会话内已连续 ${b.failStreak} 次工具失败`
        : `同一调用（${exec?.name ?? '?'} + 相同入参）已重复 ${b.repeat} 次`
      // 触发后清计数并进入冷却，避免连续刷屏
      b.failStreak = 0
      b.repeat = 0
      b.lastKey = null
      b.sinceHint = 0
      return { kind: 'stuck', reason }
    }

    // ★ F-8：这段失败流是否**以成功结束**（"之后成功了"，不是"卡住当下"）。
    //   判定只用已有的客观计数（episodeFailHit 由 STUCK_FAIL_THRESHOLD 置位），不新造一套阈值。
    const resolvedBySuccess = b.episodeFailHit && !failed // ★F8-SUCCESS-GATE
    if (resolvedBySuccess) {
      const fails = b.episodeFails
      // 一次失败流只收尾一次；共用同一冷却钟（重置），之后照旧要等冷却
      b.failStreak = 0
      b.repeat = 0
      b.lastKey = null
      b.sinceHint = 0
      b.episodeFailHit = false
      b.episodeFails = 0
      return { kind: 'recovery', reason: `同一会话内连续 ${fails} 次工具失败之后成功修好` }
    }

    if (!failed) {
      // 这一段失败流结束了（没到阈值 → 不提示），从头再计
      b.failStreak = 0
      b.episodeFailHit = false
      b.episodeFails = 0
    }
    return null
  }

  /** 旧契约：只返回"卡住提示"的客观依据（字符串），F-8 的收尾提示不走这里。 */
  function observe(sessionId, exec, result) {
    const d = observeEvent(sessionId, exec, result)
    return d && d.kind === 'stuck' ? d.reason : null
  }

  return {
    /** 供测试直接观察计数（旧契约：字符串 reason）。 */
    observe,
    /** 供测试观察两类注入的完整判定。 */
    observeEvent,
    /** post-execute 钩子本体。 */
    hook: async function stuckDetector(exec, result, next) {
      const decision = await next()
      try {
        if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
        const sessionId = exec?.agent?.session?.id ?? null
        if (!sessionId) return decision
        const d = observeEvent(sessionId, exec, result)
        if (!d) return decision
        const text = d.kind === 'stuck'
          ? buildStuckHint(d.reason)
          : buildSkillProposalHint({
              reason: d.reason,
              sessionId,
              seq: findLastFailureSeq(exec?.agent?.session),
            })
        const content = decision.content ?? result?.content
        return {
          kind: 'accept',
          // ★ 在**注入边界**再过一次 plain()：构造器可能忘，边界不会忘。
          content: [...(Array.isArray(content) ? content : []), { type: 'text', text: plain(text) }],
        }
      } catch (e) {
        onWarn(`卡住检测失败：${e?.message || e}`)
        return decision
      }
    },
  }
}

