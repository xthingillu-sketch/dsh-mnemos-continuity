/**
 * dsh-mnemos 技能使用记录 + 自评提示。
 *
 * 设计要点（都是本会话踩出来的）：
 *
 * 1. **用钩子捕获，不靠模型自觉。**
 *    本会话最硬的教训：凡是"靠模型自觉"的地方，都以完全相同的方式失败了。
 *    所以"用了哪个技能"必须由 tools/post-execute 钩子自动记录 —— 这是客观事实，
 *    而"这次好不好用"才是模型的主观补充。
 *
 * 2. **使用记录单独落 append-only JSONL，不进记忆体。**
 *    使用记录是高频、机器消费的数据；memory.json 会随记忆增长到数百 KB，
 *    每次 save() 全量重写 —— 每加载一次技能就重写一遍代价太大，且会在召回里制造噪音。
 *    评价（低频、有意义、需要被"调取相关记忆"用到）才进记忆体。
 *
 * 3. **记录技能正文的短哈希**，用于把后续反馈归因到具体的技能 revision。
 *    （技能改了以后，旧反馈不该算在新版头上。）
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 使用记录文件：与 memory.json 同级。 */
export function usageFileFor(dataFile) {
  return path.join(path.dirname(dataFile), 'skill-usage.jsonl')
}

/** 技能正文的短哈希（归因到具体 revision 用）。 */
export function revisionOf(content) {
  return crypto.createHash('sha256').update(String(content ?? '')).digest('hex').slice(0, 12)
}

/** 追加一条使用记录（append-only，绝不重写整个文件）。 */
export async function appendUsage(file, rec) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf8')
}

/** 读取全部使用记录。坏行跳过并告警，不因一行损坏丢掉整个文件。 */
export async function readUsages(file, onWarn = () => {}) {
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
    try {
      out.push(JSON.parse(t))
    } catch {
      onWarn(`跳过损坏的使用记录行：${t.slice(0, 60)}`)
    }
  }
  return out
}

/**
 * 自评提示。刻意只请模型记"异常"：
 * 强逼它每次长篇评价，它会开始编造好评 —— 而编造好评本身污染数据，比不评价更糟。
 */
export function selfReviewHint(skillName) {
  return (
    `[Mnemos] 已登记本次技能使用（${skillName}）。` +
    '若这次**感到困难、绕路或返工**，请用 mnemos_remember 写一条评价：' +
    `tags 含 skill-feedback 与 "${skillName}"，写明哪里不好用 + 改进建议；` +
    '顺利则不必写 —— 只记异常，避免制造无信息的噪音。'
  )
}

/**
 * 构造技能使用钩子的决策函数（与外部信息标记钩子同形）。
 * 只有加载**成功**才算一次使用；失败不算。
 *
 * @param deps.skillRoot 技能根，用于读取正文算 revision
 * @param deps.usageFile 使用记录文件
 * @param deps.onWarn
 * @returns async (exec, result, next) => decision
 */
export function makeSkillUsageRecorder({ skillRoot, usageFile, onWarn = () => {}, onUsed = () => {} }) {
  return async function recordSkillUsage(exec, result, next) {
    const decision = await next()
    // 只有成功加载才算使用；出错或已带 value 的结果不动
    if (!decision || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
    if (exec?.name !== 'skill') return decision
    // 注意：DSH 传给工具的入参挂在 exec.arguments 上（不是 exec.args）。
    // 这里曾写成 exec.args.name，导致钩子永远提前 return —— 而单元测试因为
    // 假 exec 也用了 args 而"通过"，验证的是假设而不是现实。
    const skillName = exec?.arguments?.name
    if (typeof skillName !== 'string' || !skillName) return decision

    const content = decision.content ?? result?.content
    if (!Array.isArray(content) || content.length === 0) return decision

    // 算 revision（读不到就算了，不因为记账失败影响技能加载）
    let revision = null
    try {
      const raw = await fs.readFile(path.join(skillRoot, skillName, 'SKILL.md'), 'utf8')
      revision = revisionOf(raw)
    } catch (e) {
      onWarn(`无法读取技能正文以计算 revision：${skillName}（${e.code || e.message}）`)
    }

    const rec = {
      t: Date.now(),
      session: exec?.agent?.session?.id ?? null,
      skill: skillName,
      revision,
    }
    try {
      await appendUsage(usageFile, rec)
      onUsed(rec.session) // 让用户信号捕获知道"这个会话已经用过技能"
    } catch (e) {
      onWarn(`写入使用记录失败：${e.message}`)
    }

    // 追加自评提示（出现在"刚用完"这个最相关的时刻）
    return { kind: 'accept', content: [...content, { type: 'text', text: selfReviewHint(skillName) }] }
  }
}
