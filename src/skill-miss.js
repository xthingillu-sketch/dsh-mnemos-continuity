/**
 * dsh-mnemos 「该用未用」判定（第三条评审因素 · B2）
 *
 * 为什么需要它（死区）：
 *   前两条证据（用户反馈 / 自评）都要求**先用了**。而闭环的燃料就是「使用」——
 *   没有使用 → 归因没有落点 → 六条「不改」的第 1 条把该技能**永久冻结在出生状态**。
 *   用户的原话点得最准：*"完全不去调技能就永远不知道出了什么问题，怎么进化"*。
 *
 *   更尖锐的说法：本架构硬性要求「归因必须可证伪」，却**没给「不归因」留通道**。
 *
 * 做法：
 *   找出「**被提供过技能、却一个都没加载**」的会话，拿它的**有界任务指纹**去问一个独立 LLM：
 *   这些技能里有没有本该触发却没被加载的？为什么？
 *
 * ★ 两条边界（刻意的收窄）：
 *   1. **只判本插件自己的技能**（存在于 skillRoot 的那些）。内置技能（office-* 等）我改不了，
 *      判了也无法行动 —— 不越界。
 *   2. 判定**宁可漏、不可误**：只有"任务确实落在触发条件内、且加载会实质改变做法"才算该触发。
 *      下游要据此改技能，误判的代价比漏判高得多。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readUsages } from './skill-usage.js'
import { listSkills } from './skill-provider.js'
import { callLlm, parseJsonReply } from './skill-review.js'

/** 判定状态（哪些会话已经判过，避免重复花钱）。 */
export function missStateFileFor(dataFile) {
  return path.join(path.dirname(dataFile), 'skill-miss-state.json')
}

/** 判定结果（`miss` 证据，B3 消费）。 */
export function missFileFor(dataFile) {
  return path.join(path.dirname(dataFile), 'skill-miss.jsonl')
}

const DEFAULT_STATE = { judged: [] }
const JUDGED_KEEP = 500

export async function loadMissState(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'))
    return { ...DEFAULT_STATE, ...s, judged: s.judged ?? [] }
  } catch (e) {
    if (e.code === 'ENOENT') return { ...DEFAULT_STATE, judged: [] }
    throw e
  }
}

export async function saveMissState(file, state) {
  state.judged = state.judged.slice(-JUDGED_KEEP)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

export async function appendMiss(file, rec) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf8')
}

export async function readMisses(file, onWarn = () => {}) {
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const out = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { onWarn(`跳过损坏的 miss 行：${t.slice(0, 60)}`) }
  }
  return out
}

/** 判定允许的「为什么没被用」取值。 */
export const MISS_REASONS = ['name-unclear', 'description-scope', 'description-vague', 'model-ignored', 'not-applicable']

export function buildMissPrompt({ offered, tasks, feedback }) {
  const sk = offered
    .map((s, i) => `${i + 1}. ${s.name}\n   触发条件（描述）：${s.description}`)
    .join('\n')
  const tk = (tasks || []).map((t, i) => `${i + 1}. ${t.text}`).join('\n') || '（无）'
  const fb = (feedback || []).map((f, i) => `${i + 1}. ${f.text}`).join('\n') || '（无）'
  return [
    '你是「技能投递」的独立审查者。有一个会话被提供了一组技能，但**一个都没有加载**。',
    '请判断：这些技能里，有没有**本该在这个会话中触发、却没被加载**的？',
    '',
    '【该会话中被提供过的技能（本插件自己的）】',
    sk,
    '',
    '【该会话的任务】（用户原话摘录，有界、可能不全）',
    tk,
    '',
    '【该会话中用户的其它反馈（若有）】',
    fb,
    '',
    '【判断要求】',
    '- 只有「任务确实落在该技能的**触发条件**内、且加载它会**实质改变做法**」才算该触发。',
    '- 只是"沾边""可能有用"**不算**。**宁可漏判，不要误判** —— 下游要据此改技能，误判代价高得多。',
    '- 若判定该触发，必须说明**为什么没被用**，从下面五个里**选一个**：',
    `  · name-unclear      名字看不出用途`,
    `  · description-scope 描述把范围写窄或写偏了（例如写死了某种做法）`,
    `  · description-vague 描述太泛，无法判断何时该用`,
    `  · model-ignored     描述没问题，是模型没做匹配（**不是技能的问题**）`,
    `  · not-applicable    其实不适用（不必改）`,
    '- 若某个技能不该触发，**不要**把它列出来。',
    '',
    '【输出】只输出一个 JSON，不要任何多余文字：',
    '{"misses":[{"skill":"技能名","reason":"上面五个之一","why":"为什么该触发（要具体到该会话的任务）",',
    ' "suggestion":"对**描述或名字**的具体修改建议"}],"note":"可选：整体观察"}',
  ].join('\n')
}

/**
 * 跑一轮「该用未用」判定。
 *
 * @param deps.store         记忆体（用于召回该会话的相关记忆，可选）
 * @param deps.skillRoot     技能根（**只判这里的技能**）
 * @param deps.offersFile / tasksFile / usageFile / stateFile / missFile
 * @param deps.llm           缺省则只挑候选、不判定
 */
export async function detectMissedUsage(deps) {
  const {
    skillRoot, offersFile, tasksFile, usageFile, stateFile, missFile,
    llm, provider, model, maxSessionsPerCycle = 3, onWarn = () => {}, onInfo = () => {},
  } = deps

  const state = await loadMissState(stateFile)
  const judged = new Set(state.judged)

  const offers = await readMissOrEmpty(offersFile, onWarn)
  const tasks = await readMissOrEmpty(tasksFile, onWarn)
  const usages = await readUsages(usageFile, onWarn)

  const usedSessions = new Set(usages.map((u) => u?.session).filter(Boolean))
  const bySession = new Map()
  for (const o of offers) {
    if (!o?.session) continue
    if (!bySession.has(o.session)) bySession.set(o.session, new Set())
    for (const n of o.skills || []) bySession.get(o.session).add(n)
  }
  const taskBySession = new Map()
  for (const t of tasks) {
    if (!t?.session || !t.text) continue
    if (!taskBySession.has(t.session)) taskBySession.set(t.session, [])
    taskBySession.get(t.session).push(t)
  }

  // 候选：被提供过技能 ∧ 一个都没用 ∧ 有任务指纹 ∧ 没判过
  const candidates = [...bySession.keys()].filter(
    (s) => !usedSessions.has(s) && !judged.has(s) && (taskBySession.get(s)?.length ?? 0) > 0
  )

  if (!candidates.length) {
    return { step: 'idle', offers: bySession.size, used: usedSessions.size, judged: judged.size }
  }
  if (!llm) {
    return { step: 'no-llm', candidates: candidates.length }
  }

  // 只判本插件自己的技能（内置技能改了也没用 —— 不越界）
  let mine = []
  try {
    mine = await listSkills(skillRoot)
  } catch (e) {
    onWarn(`读取技能目录失败：${e.message}`)
    return { step: 'no-skills', candidates: candidates.length }
  }
  const byName = new Map(mine.map((s) => [s.name, s]))

  const results = []
  let misses = 0
  for (const sessionId of candidates.slice(0, maxSessionsPerCycle)) {
    const offeredNames = [...bySession.get(sessionId)]
    const offered = offeredNames.filter((n) => byName.has(n)).map((n) => byName.get(n))
    const skippedBuiltin = offeredNames.filter((n) => !byName.has(n))

    if (!offered.length) {
      judged.add(sessionId) // 该会话提供过的都不是本插件的 → 没什么可判
      results.push({ session: sessionId, step: 'no-own-skill', skipped: skippedBuiltin.length })
      continue
    }

    let reply = null
    try {
      reply = parseJsonReply(
        await callLlm(llm, { provider, model }, buildMissPrompt({
          offered, tasks: taskBySession.get(sessionId) ?? [], feedback: [],
        }))
      )
    } catch (e) {
      onWarn(`「该用未用」判定调用失败（${sessionId}）：${e.message}`)
      results.push({ session: sessionId, step: 'error', reason: e.message })
      continue // 不标 judged：下轮重试
    }

    const list = Array.isArray(reply?.misses) ? reply.misses : []
    const valid = list.filter(
      (m) => m && byName.has(m.skill) && MISS_REASONS.includes(m.reason)
    )
    const dropped = list.length - valid.length

    for (const m of valid) {
      if (m.reason === 'not-applicable') continue // 明确说不适用 → 不写成证据
      await appendMiss(missFile, {
        t: Date.now(), session: sessionId, skill: m.skill, reason: m.reason,
        why: m.why ?? null, suggestion: m.suggestion ?? null,
      })
      misses++
    }
    judged.add(sessionId)
    results.push({
      session: sessionId, step: 'judged', offered: offered.length,
      skippedBuiltin: skippedBuiltin.length, misses: valid.length, dropped,
      note: reply?.note ?? null,
    })
    if (valid.length) onInfo(`该用未用：${sessionId} 判定出 ${valid.length} 条`)
  }

  state.judged = [...judged]
  await saveMissState(stateFile, state)
  return {
    step: 'judged', candidates: candidates.length,
    processed: results.length, misses, results,
    remaining: Math.max(0, candidates.length - results.length),
  }
}

async function readMissOrEmpty(file, onWarn) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const out = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try { out.push(JSON.parse(t)) } catch { /* 坏行跳过 */ }
    }
    return out
  } catch (e) {
    if (e.code === 'ENOENT') return []
    onWarn(`读取 ${path.basename(file)} 失败：${e.message}`)
    return []
  }
}
