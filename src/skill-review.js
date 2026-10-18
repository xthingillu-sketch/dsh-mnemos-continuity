/**
 * dsh-mnemos 技能评审（阶段 3b 归因 + 3c 评审/试改/回归门）
 *
 * 设计重心是「不改」，不是「能改」：
 *   技能改动不可逆，而证据在冷启动期天然稀缺 —— 所以有六条拦截规则，
 *   默认行为是"什么都不做"。
 *
 * 六条「不改」：
 *   1 无未消费记录           → 不改
 *   2 只有使用、无负反馈     → 不改（沉默 ≠ 满意）
 *   3 反馈的 revision ≠ 当前 → 不改（技能已改过，旧反馈不算新版头上）
 *   4 归因不可证伪（指不出哪条规则）→ 记观察项，不改
 *   5 缺反例（说不出具体场景）→ 不改
 *   6 回归门不过             → 丢弃
 *
 * 归因靠一座已存在的桥（跨对话的关键）：
 *   反馈带 (session, t)；使用记录带 (session, t)；
 *   →"同会话、时间在反馈之前、最近的那次使用"就是候选归因。
 *   记忆体里的产物带 (sessionId, createdAt)，也走同一座桥。
 *
 * ★ 这是**推断**，不是事实 —— 所以带 confidence，且第 3~6 条会兜底。
 *
 * 水位语义（易错，务必保持）：
 *   **只有被处理过的反馈才能推进水位。** 被 maxPerCycle 推迟的技能，
 *   其信号必须留在水位之后等下一轮，否则反馈会被静默丢弃。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readUsages, revisionOf } from './skill-usage.js'
import { readUserSignals } from './user-signals.js'
import { parseSkillFile, listSkills } from './skill-provider.js'
import { LEARNING_PROTOCOL } from './learning-protocol.js'
import { readMisses } from './skill-miss.js'
import { findSecrets, hasSecret, redactSecrets, describeHits, auditSecretBlock } from './secret-patterns.js'
import { parseSourceRef, resolveSourceRef, SOURCE_REF_FORMAT_HINT } from './skill-source-ref.js'

// ============ F-9：两个写回开关（新建 / 修改）=================================
/**
 * ★ 「新建」与「修改」是**两种不同风险**，所以拆成两个开关（F-9）：
 *   · **新建 = 增量**：技能目录里多一条。没通过验证的提议进暂存区、不进目录；
 *     真进来的东西**还没有被任何真实使用验证过**，所以副作用上限是"多了一条候选"——
 *     最坏情况只是目录里多一条，删掉即可，可逆。
 *   · **修改 = 退化**：动的是一个**已经被真实使用过**的东西。改了它，正在依赖它的
 *     会话会立刻拿到不同的行为。风险更高，所以最初的设计是"只出建议、要人批"。
 *
 * ★★ 2026-10-17 用户决定：**修改也改成默认写回**（reviewWriteBack 默认 true）。
 *   理由有两面，第二面是实测出来的：
 *   ① "人批"这一层能提供的保护，其实已经被**评审 + 独立验证者 + 回归门**承担了 ——
 *      一次改动要过：可证伪（指得出具体规则点）→ 有反例 → 有正例 → 独立验证者判 pass
 *      → miss 驱动时还有"只许改 description"的机械闸门 → 正文过凭据扫描。
 *   ② **人不在场时"要人批"等于"永远不批"**：实测两条已经过完整评审的提案
 *      （o-w-f-o 的沙箱拒绝判据、h-i-v 的描述扩写）在技能目录里躺了 **7 天**没人批，
 *      而评审线还在每 30 分钟为它们重跑归因。也就是说这个默认值并没有带来安全，
 *      只带来了"提案墓地"。
 *   风险提示（如实）：写回是**不可逆的行为变化**；要停就设 `reviewWriteBack: false`。
 * 配置侧（index.js）从这两个常量取默认值，保证"测到的默认值"就是"真实默认值"。
 */
export const DEFAULT_CREATE_WRITE_BACK = true
export const DEFAULT_REVIEW_WRITE_BACK = true

/** F-11：技能目录的容量上限默认值（达到后不再自动入目录，改落暂存区并说明）。 */
export const DEFAULT_MAX_SKILLS = 30

/**
 * 从插件配置里解析出两个写回开关。**单一真相源**：index.js 的 Schema 默认值也取自上面两个常量，
 * 所以测试里测到的默认值不可能与真实默认值漂移。
 */
export function resolveSkillWriteBacks(config) {
  const c = config || {}
  return {
    createWriteBack: c.createWriteBack === undefined ? DEFAULT_CREATE_WRITE_BACK : c.createWriteBack === true,
    reviewWriteBack: c.reviewWriteBack === undefined ? DEFAULT_REVIEW_WRITE_BACK : c.reviewWriteBack === true,
  }
}

// ============ 技能全文分段（「只许改描述」的机械闸门用）============
/** 拆出 frontmatter 与正文。 */
export function splitSkillContent(content) {
  const s = String(content ?? '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(s)
  if (!m) return { front: '', body: s }
  return { front: m[1], body: s.slice(m[0].length) }
}

/**
 * ★ 机械闸门：本次改动是否**只动了 `description`**。
 *
 * 为什么必须机械校验：`miss`（该用未用）证据**不能证明规则正文有问题** ——
 * 它只证明"描述没能让模型在该场景加载它"。所以哪怕评审提示词里写了限制，
 * 也要在代码里**再挡一道**，而不是信任模型遵守。
 *
 * fail-closed：frontmatter 里出现多行值等无法可靠比较的情形，一律判为"不是只改描述"。
 */
export function isDescriptionOnlyChange(oldContent, newContent) {
  const a = splitSkillContent(oldContent)
  const b = splitSkillContent(newContent)
  if (a.body.replace(/\s+$/, '') !== b.body.replace(/\s+$/, '')) return false
  const strip = (front) =>
    front.split(/\r?\n/).filter((l) => !/^\s*description\s*:/.test(l)).join('\n').trim()
  const multiline = (front) => front.split(/\r?\n/).some((l) => /^\s*description\s*:\s*[|>]/.test(l))
  if (multiline(a.front) || multiline(b.front)) return false
  return strip(a.front) === strip(b.front)
}

// ============ 文件路径 ============
export function reviewStateFileFor(dataFile) {
  return path.join(path.dirname(dataFile), 'skill-review-state.json')
}
export function feedbackFileFor(dataFile) {
  return path.join(path.dirname(dataFile), 'skill-feedback.jsonl')
}
export function historyFileFor(skillDir) {
  return path.join(skillDir, 'history.jsonl')
}
export function versionsDirFor(skillDir) {
  return path.join(skillDir, 'versions')
}
export function regressionFileFor(skillDir) {
  return path.join(skillDir, 'regression.jsonl')
}
/** 写回关闭时，修订建议落这里 —— 否则 "proposed" 无从审核（history 里只有哈希）。 */
export function proposalsDirFor(skillDir) {
  return path.join(skillDir, 'proposals')
}

// ============ 状态 ============
const DEFAULT_STATE = { usageCount: 0, signalCount: 0, selfReviewT: 0, pending: [], skills: {} }
const PENDING_MAX = 200

export async function loadReviewState(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'))
    return { ...DEFAULT_STATE, ...s, skills: s.skills ?? {}, pending: s.pending ?? [] }
  } catch (e) {
    if (e.code === 'ENOENT') return { ...DEFAULT_STATE, skills: {}, pending: [] }
    throw e
  }
}

/** 原子保存（临时文件 + rename，避免半截状态）。 */
export async function saveReviewState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

// ============ 归因（3b）============
/**
 * 把一条反馈 (session, t) 归因到某次技能使用。
 * @returns {skill, revision, usageT, confidence, reason} | null（归因失败）
 */
export function attribute({ session, t }, usages) {
  if (!session || typeof t !== 'number') return null
  const candidates = (usages || []).filter(
    (u) => u && u.session === session && typeof u.t === 'number' && u.t <= t
  )
  if (!candidates.length) return null
  const best = candidates.reduce((a, b) => (b.t > a.t ? b : a))
  return {
    skill: best.skill,
    revision: best.revision ?? null,
    usageT: best.t,
    confidence: candidates.length > 1 ? 'low' : 'high',
    reason:
      candidates.length > 1
        ? `同会话内该时刻前有 ${candidates.length} 次技能使用，取最近一次`
        : '同会话内该时刻前唯一一次技能使用',
  }
}

// ============ 规则点 ============
/** 抽规则点：`1. xxx` / `1、xxx` / `①xxx`。用于冷启动期的覆盖检查与版本 diff。 */
/** 稳定的短哈希（用于把"这一批证据"压成一个可比较的指纹）。 */
function shortHash(text) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(16)
}

/**
 * 一批评审证据的指纹：`mode + revision + 反馈序号集 + miss 时间集`。
 *
 * 用途：**同一批证据已经判过 no-change，就别再花一次 LLM 再判一遍**。
 * 起因（实测）：`no-change` 分支不推进任何水位，同一批 87 条反馈在 24 小时里被重评 30+ 轮，
 * 每轮判词几乎逐字相同（连模型自己在判词里都写"同输入别再转了"）。
 * 指纹变了（新反馈、revision 变了、新的 miss）才算新证据，才重评。
 */
export function batchFingerprint({ mode, revision, feedback = [], misses = [] }) {
  // ★ 按**文本内容**取指纹，不是按序号/时间：
  //   实测中同一句反馈会以不同的信号序号反复出现（同一段对话被多次切片），
  //   按序号算"批次变了"，评审就照做 —— 那正是"同一个输入被判 30+ 轮"的样子。
  //   去重后再排序：重复的同文本反馈折叠成一个，这才是"同一批证据"。
  const fb = [...new Set(feedback.map((f) => String(f.text || '').trim()).filter(Boolean))].sort().join('\u0001')
  const ms = [...new Set(misses.map((m) => String(m.reason || m.text || '').trim()).filter(Boolean))].sort().join('\u0001')
  return shortHash(`${mode}|${revision ?? ''}|${fb}|${ms}`)
}

export function extractRulePoints(content) {
  const out = []
  for (const line of String(content ?? '').split(/\r?\n/)) {
    const m = /^\s*(?:(\d+)\s*[.、)]|([①-⑳]))\s*(\S.*)$/.exec(line)
    if (m) out.push({ id: (m[1] ?? m[2]).trim(), text: m[3].trim() })
  }
  return out
}

// ============ 自评反馈（从记忆体里取）============
/**
 * 收集模型按自评提示写下的评价（tags 含 skill-feedback）。
 * 它们和用户信号走**同一座桥**：记忆带 (sessionId, createdAt) → 反查使用记录。
 */
export function collectSelfReviews(memories, { sinceT = 0 } = {}) {
  const out = []
  for (const m of memories || []) {
    if (!m) continue
    const tags = Array.isArray(m.tags) ? m.tags : []
    if (!tags.includes('skill-feedback')) continue
    if (m.source === 'deprecated') continue
    const t = m.createdAt ?? m.recency
    if (typeof t !== 'number' || t <= sinceT) continue
    out.push({ t, session: m.sessionId ?? null, text: m.detail || m.summary || '', from: 'self' })
  }
  return out
}

// ============ JSON 回复解析 ============
/** 从模型回复里抠出第一个 JSON 对象（容忍代码围栏、前后废话、嵌套）。 */
export function parseJsonReply(text) {
  let t = String(text ?? '').trim()
  t = t.replace(/^```(?:json|markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim()
  try {
    return JSON.parse(t)
  } catch {
    /* 落到括号配对 */
  }
  const start = t.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < t.length; i++) {
    const c = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

// ============ 提示词 ============
export function buildReviewPrompt({ skillName, currentContent, revision, feedback, memories, rulePoints, history, mode = 'feedback', misses = [] }) {
  const fb = feedback
    .map((f, i) => `${i + 1}. [${f.from === 'self' ? '自评' : '用户'}｜置信度 ${f.confidence ?? 'n/a'}] ${f.text}`)
    .join('\n')
  const mem = (memories || []).map((m, i) => `${i + 1}. ${m}`).join('\n') || '（无）'
  const rp = (rulePoints || []).map((r) => `${r.id}. ${r.text}`).join('\n') || '（无编号规则点）'
  const hist = (history || []).map((h, i) => `${i + 1}. ${h}`).join('\n') || '（无）'
  const isMiss = mode === 'miss'
  const ms = misses
    .map((m, i) => `${i + 1}. 该技能在某个会话被提供过，但**没有被加载**。判定原因：${m.reason}\n   为什么该触发：${m.why || '（未记）'}\n   建议：${m.suggestion || '（未记）'}`)
    .join('\n')

  const header = isMiss
    ? '你是技能评审者。本次证据是「**该用未用**」：技能被提供过，但在该会话里**没有被加载**。' +
      '请判断是否值得修改**触发条件（描述）**，并给出修订。'
    : '你是技能评审者。一个「任务型技能」被使用后收到了反馈。请判断是否值得修改，并给出修订。'

  const requirements = isMiss
    ? [
        '【★ 本次证据的特别限制（务必遵守）】',
        '- 本次证据是「该用未用」，它只能证明**描述没能让模型在该场景加载它**，',
        '  **不能证明规则正文有问题**。',
        '- 因此你**只能修改 frontmatter 里的 `description`（触发条件）**。',
        '- **正文（# 标题与所有规则点）一字不许动** —— 改了会被代码层的机械闸门直接丢弃。',
        '- 若你认为问题出在正文规则，请回 {"change": false, "reason": "..."}。',
        '',
        '【对本次任务的直接要求】',
        '- 一次只改一个小点。',
        '- 新描述必须**仍然写明「什么时候该用」**，且**不得放宽到「什么任务都沾」** ——',
        '  那会让它变成常驻噪声，比不被加载更糟。',
        '- 无证据不改：若这些判定不足以支持修改，就回 {"change": false, "reason": "..."}。',
        '- `counterexample` 填：**该会话的任务场景 + 旧描述为什么没能让它被加载**。',
        '- `positiveCase` 填：**同类任务 + 新描述会让它被加载，且不会在不相关任务上被加载**。',
      ]
    : [
        '【对本次任务的直接要求】',
        '- 一次只改一个小点。',
        '- 无证据不改：这些反馈若不足以支持任何修改，就回 {"change": false, "reason": "..."}。',
        '- 归因必须可证伪：必须指出「改掉或新增哪一条规则会让这条反馈消失」。指不出具体规则点就不要改。',
        '- 反例必须有具体场景：说不出「改之前会做错、改之后应做对」的具体场景，就不要改。',
      ]

  return [
    header,
    '',
    `【当前技能】${skillName}（revision ${revision}）`,
    '---',
    currentContent,
    '---',
    '',
    isMiss ? '【该用未用的判定】' : '【反馈】',
    isMiss ? ms : fb,
    '',
    '【相关记忆】',
    mem,
    '',
    '【当前规则点】',
    rp,
    '',
    '【修改历史】',
    hist,
    '',
    '【学习协议】（你必须遵循；它是本系统的宪法，人工专属，不会被自动修改）',
    LEARNING_PROTOCOL,
    '',
    ...requirements,
    '',
    '【输出】只输出一个 JSON，不要任何多余文字：',
    '{"change": true, "why": "为什么改（一句话）", "rulePoint": "涉及哪条规则（引用编号或原文片段）",',
    ' "counterexample": "反例：一个具体场景", "positiveCase": "正例：一个具体场景", "newContent": "修订后的技能全文（含 frontmatter）"}',
  ].join('\n')
}

export function buildVerifyPrompt({ skillName, oldContent, newContent, counterexample, positiveCase, oldRulePoints, coldStart, mode = 'feedback' }) {
  const rp = (oldRulePoints || []).map((r) => `${r.id}. ${r.text}`).join('\n')
  const extra = coldStart
    ? ['', '【冷启动期的额外要求】旧版规则点如下：', rp || '（无）', '新版必须**逐条覆盖**这些规则点（措辞可改，语义要点不能丢）。有缺失即判不通过。']
    : []
  return [
    '你是独立验证者。有人提出了一份技能修改。',
    '**你看不到修改者的理由**，这是故意的 —— 请只依据新旧文本与下面两个用例来判断。',
    '',
    `【旧版】${skillName}`,
    '---',
    oldContent,
    '---',
    '',
    '【新版】',
    '---',
    newContent,
    '---',
    '',
    '【反例】改之前应做错、改之后应做对：',
    counterexample || '（未提供）',
    '',
    '【正例】改之前做对、改之后必须仍然做对：',
    positiveCase || '（未提供）',
    ...extra,
    '',
    ...(mode === 'miss'
      ? [
          '【本次是「该用未用」驱动的改动 —— 只许改描述】',
          '1. **正文是否一字未改？**（改了即判不通过）',
          '2. 新描述是否**仍然是「什么时候该用」**（而不是「它能做什么」）？',
          '3. 新描述是否更可能在该类任务上被加载？',
          '4. ★ 新描述是否**没有放宽到「什么任务都沾」**？宽泛化比不被加载更糟 —— 会让它成为常驻噪声。',
          '5. 新描述是否与技能正文的实际内容**一致**（不能承诺正文做不到的事）？',
        ]
      : [
          '【判断】',
          '1. 新版是否解决了反例？',
          '2. 新版是否仍然做对正例？',
          '3. 新版是否丢掉了旧版的规则点？',
          '4. 是否只改了一个小点（而非大改）？',
        ]),
    '',
    '【输出】只输出一个 JSON：{"pass": true/false, "reason": "...", "missingRulePoints": ["编号"...]}',
  ].join('\n')
}

// ============ LLM 调用 ============
/** 单次补全（与旧实现同形：llm.stream → text-delta / finish.reason）。 */
export async function callLlm(llm, { provider, model }, prompt) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  let text = ''
  let error = null
  for await (const chunk of llm.stream({ provider, model, messages })) {
    if (chunk.type === 'text-delta') text += chunk.text || ''
    if (chunk.type === 'finish') {
      const r = chunk.reason
      if (r && (r.kind === 'error' || r.kind === 'aborted')) {
        error = (r.failure && r.failure.message) || r.kind
      }
    }
  }
  if (error) throw new Error(error)
  return text.trim()
}

// ============ 落盘辅助 ============
/**
 * 追加一行 JSON。★ 走**记录类**凭据策略：命中即**打码后保留**（不拒写）——
 * 这些是对证据的记账（history/regression/feedback），拒写会损失审计。
 * 会改变模型行为的**内容类**写入（SKILL.md / proposals）另有 assertNoSecretInSkill 拒写。
 */
export async function appendJsonl(file, obj) {
  let line = JSON.stringify(obj)
  if (hasSecret(line)) line = redactSecrets(line)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, line + '\n', 'utf8')
}

// ============ 凭据卡口 ============
/**
 * 技能相关写入的凭据卡口。
 *
 * 分两种，判据同前：**这份内容丢了会不会有损失**。
 *   · **技能正文 / 提议**（会改变模型行为）→ **拒写**：技能里本来就不该含密钥，
 *     而 `description` 会进每一次会话的技能目录，属于**永久反复暴露**，比进记忆更糟。
 *   · **history / regression**（只是记录）→ **打码保留**：那是对证据的记账，丢了会损失审计。
 *
 * ★ 错误信息里**不含命中内容** —— 否则"过滤"本身就成了另一个泄露渠道。
 */
export function assertNoSecretInSkill(label, text) {
  const hits = findSecrets(text)
  if (!hits.length) return null
  return new Error(
    `拒绝写入${label}：疑似含凭据（命中模式：${describeHits(hits)}）。` +
    `技能正文会进技能目录（description 每次都注入），因此不落盘。` +
    `请移除该段内容后重试；若是示例，请改用明显不可用的形式。`
  )
}

/** 记录类写入：打码后保留（不拒写），并可选记审计。 */
async function appendJsonlRedacted(file, obj, audit) {
  let line = JSON.stringify(obj)
  const hits = findSecrets(line)
  if (hits.length) {
    line = redactSecrets(line)
    if (audit) await auditSecretBlock(audit, { where: `skill-record:${path.basename(file)}`, hits, action: 'redacted' })
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, line + '\n', 'utf8')
}

/** 原子写回技能正文；写前把旧版全文存进 versions/（保证可回滚）。 */
export async function writeBackSkill(skillDir, oldContent, oldRevision, newContent) {
  const bad = assertNoSecretInSkill('技能正文', newContent)
  if (bad) throw bad
  const vdir = versionsDirFor(skillDir)
  await fs.mkdir(vdir, { recursive: true })
  if (oldContent) await fs.writeFile(path.join(vdir, `${oldRevision}.md`), oldContent, 'utf8')
  const file = path.join(skillDir, 'SKILL.md')
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, newContent, 'utf8')
  await fs.rename(tmp, file)
}

/** 读技能修改历史（人可读的一行一条）。 */
export async function readHistory(file) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          const h = JSON.parse(l)
          const when = typeof h.t === 'number' ? new Date(h.t).toISOString().slice(0, 10) : '?'
          return `${when} ${h.verdict}：${h.why || h.reason || ''}`
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .slice(-10)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

// ============ 编排 ============
/**
 * 跑一轮技能评审。
 *
 * @param deps.store        记忆体（也用于读自评反馈）
 * @param deps.skillRoot    技能根
 * @param deps.usageFile / signalsFile / stateFile / feedbackFile
 * @param deps.llm          可选；缺省则只归因、不评审
 * @param deps.writeBack    **是否真的改写 SKILL.md**（默认取 DEFAULT_REVIEW_WRITE_BACK = true，
 *   2026-10-17 起修改也自动落盘；调用方应传 `resolveSkillWriteBacks(config).reviewWriteBack`）
 */
export async function runSkillReview(deps) {
  const {
    store,
    skillRoot,
    usageFile,
    signalsFile,
    stateFile,
    feedbackFile,
    missFile,
    llm,
    provider,
    model,
    writeBack = DEFAULT_REVIEW_WRITE_BACK,
    maxPerCycle = 3,
    freezeAfterCycles = 3,
    limitMemories = 8,
    onWarn = () => {},
    onInfo = () => {},
  } = deps

  const state = await loadReviewState(stateFile)
  const usages = await readUsages(usageFile, onWarn)
  const signals = await readUserSignals(signalsFile, onWarn)
  const memories = [...(store?.memories?.values?.() ?? [])]

  const sigFrom = state.signalCount || 0
  const selfFrom = state.selfReviewT || 0
  const newSignals = signals.slice(sigFrom).map((s, i) => ({ ...s, _idx: sigFrom + i }))
  const newSelfReviews = collectSelfReviews(memories, { sinceT: selfFrom })
  const usageGrew = usages.length > (state.usageCount || 0)

  // ---- 第三条证据：该用未用（miss）----
  // ★ 必须在这里读（**在 idle 早退之前**）：否则"只有 miss、没有任何信号/使用"的会话
  //   会被 idle 直接挡掉，miss 永远到不了评审 —— 这正是第一次跑测试时踩到的坑。
  // ★ 它只能证明「描述没能让模型在该场景加载它」，**不能**证明规则正文有问题 ——
  //   所以 miss 驱动的评审另有一道**机械闸门**（只许改 description）。
  // 消费靠时间水位：miss 不携带 revision（它针对描述，不是正文内容）。
  const missFrom = state.missT || 0
  const missBySkill = new Map()
  let newMisses = []
  let retrievalGaps = 0
  if (missFile) {
    let all = []
    try {
      all = await readMisses(missFile, onWarn)
    } catch (e) {
      onWarn(`读取 miss 失败：${e.message}`)
    }
    newMisses = all.filter((m) => m && typeof m.t === 'number' && m.t > missFrom)
    for (const m of newMisses) {
      if (!m.skill) continue
      // ★ `model-ignored` 的含义是「描述没问题，是模型没做匹配」—— **不是技能的问题**。
      //   所以它仍然记录、仍然计数（这是"检索触发缺口"的证据，属纪律层），
      //   但**不驱动技能评审**。实测教训：把它喂进评审，会花两次 LLM 调用才得出
      //   「no-change，真实缺口在检索路径」—— 与判定者说的是同一件事。
      if (m.reason === 'model-ignored') {
        retrievalGaps++
        continue
      }
      if (!missBySkill.has(m.skill)) missBySkill.set(m.skill, [])
      missBySkill.get(m.skill).push(m)
    }
  }

  if (!newSignals.length && !newSelfReviews.length && !usageGrew && !newMisses.length) {
    return {
      step: 'idle',
      usages: usages.length,
      signals: signals.length,
      misses: newMisses.length,
      retrievalGaps,
      frozen: frozenNames(state),
    }
  }

  // ---- 归因（3b）----
  const attributed = []
  const unattr = []
  const attributeOne = (item, from) => {
    const a = attribute({ session: item.session, t: item.t }, usages)
    if (!a) {
      unattr.push({ kind: from, t: item.t, session: item.session, reason: '同会话内找不到更早的技能使用' })
      return null
    }
    return { t: item.t, session: item.session, from, text: item.text, _idx: item._idx, _selfT: from === 'self' ? item.t : undefined, ...a }
  }
  for (const s of newSignals) {
    const f = attributeOne(s, 'user')
    if (f) attributed.push(f)
  }
  for (const r of newSelfReviews) {
    const f = attributeOne(r, 'self')
    if (f) attributed.push(f)
  }

  // ★★ 只评审"自家"技能（2026-10-17 修活锁 —— 这一步不是优化，是**止血**）：
  //   `skillRoot` 下读不到 SKILL.md 的技能（宿主的 office-* 内置技能在 app.asar 里）**改不了**，
  //   但它们的反馈是会被正常归因出来的（主会话真在用 office-docx）。旧代码把它们也塞进
  //   待评审队列 → `missing-skill` → `deferred` → 底部水位 `Math.min(...deferredIdx)`
  //   被**永久钉死**在那个索引 → 每个心跳周期重读全量旧反馈、重新归因、重新评审自家技能：
  //   实测连续 4~5 天、20~65+ 个周期、零产出，而且开销无上界（这是空闲学习连续 4 轮回
  //   上报的同一个缺陷，根因就在这几行）。
  //   修法与 skill-miss 侧早就有的"只判自家"纪律**完全一致**：改不了的，归观察项**消费掉**，
  //   不 defer、不进评审。别再改成"missing-skill 时不 defer"那种散点补丁 —— 那只是让水位
  //   冒过一格，下一条内置技能反馈又会把它钉住；闸门要放在**入口**（谁能进待评审队列）。
  //   fail-open：读不到自家名单时**不过滤**（宁可退化成旧行为，也不要凭空关掉评审）。
  const foreignNames = []
  try {
    const own = new Set((await listSkills(skillRoot, onWarn)).map((s) => s.name))
    if (own.size === 0) {
      // ★ fail-open：自家名单为空（技能目录还没建/读不到）时**不过滤** ——
      //   否则"一切都算外来"，反馈会被当观察项吞掉，评审彻底停摆。宁可退化成旧行为。
      onWarn('评审：自家技能名单为空，本轮不做"只判自家"过滤（等技能目录就绪后自动恢复）')
    } else {
      for (let i = attributed.length - 1; i >= 0; i--) {
        const n = attributed[i].skill
        if (own.has(n)) continue
        foreignNames.push(n)
        unattr.push({
          kind: attributed[i].from,
          t: attributed[i].t,
          session: attributed[i].session,
          reason: `不是本插件的技能（${n} 改不了，只作观察）`,
        })
        attributed.splice(i, 1)
      }
      for (const [name, list] of [...missBySkill.entries()]) {
        if (own.has(name)) continue
        foreignNames.push(name)
        missBySkill.delete(name)
        for (const m of list) {
          unattr.push({ kind: 'miss', t: m.t, session: m.session, reason: `不是本插件的技能（${name} 改不了，只作观察）` })
        }
      }
      if (foreignNames.length) {
        onInfo(`评审：跳过 ${new Set(foreignNames).size} 个非本插件技能（${[...new Set(foreignNames)].join(', ')}）—— 改不了，只作观察`)
      }
    }
  } catch (e) {
    onWarn(`读取自家技能名单失败（本轮不做"只判自家"过滤）：${e?.message || e}`)
  }

  // 归因失败的也消费掉（进观察项，避免反复重试）
  state.pending = [...(state.pending ?? []), ...unattr].slice(-PENDING_MAX)

  // ---- 按技能分组 ----
  const bySkill = new Map()
  for (const f of attributed) {
    if (!f.skill) continue
    if (!bySkill.has(f.skill)) bySkill.set(f.skill, [])
    bySkill.get(f.skill).push(f)
  }

  // ---- 第三条证据已在上面读过（必须在 idle 早退之前）----

  // 有使用但本轮没有反馈的技能 → 累加静默计数（到阈值则冻结）
  if (usageGrew) {
    for (const name of new Set(usages.map((u) => u?.skill).filter(Boolean))) {
      if (bySkill.has(name) || missBySkill.has(name)) continue
      const st = (state.skills[name] ??= { frozen: false, silentCycles: 0 })
      st.silentCycles = (st.silentCycles || 0) + 1
      if (st.silentCycles >= freezeAfterCycles && !st.frozen) {
        st.frozen = true
        onInfo(`技能 ${name} 连续 ${st.silentCycles} 个静默周期 → 冻结`)
      }
    }
  }

  const allSkills = [...new Set([...bySkill.keys(), ...missBySkill.keys()])]

  // 命中 no-change 水位、因此**没花 LLM** 的技能数（给心跳回执用：让「省了没省」可见）
  let cached = 0

  // 只有使用、没有可归因的反馈、也没有该用未用的判定 → 不评审（沉默 ≠ 满意），但仍要落盘水位
  if (allSkills.length === 0) {
    state.signalCount = signals.length
    state.selfReviewT = newSelfReviews.length
      ? Math.max(state.selfReviewT || 0, ...newSelfReviews.map((r) => r.t))
      : state.selfReviewT
    state.usageCount = usages.length
    state.missT = newMisses.length ? Math.max(missFrom, ...newMisses.map((m) => m.t)) : missFrom
    await saveReviewState(stateFile, state)
    return {
      step: 'usage-only',
      cached,
      usages: usages.length,
      signals: signals.length,
      unattributed: unattr.length,
      misses: newMisses.length,
      retrievalGaps,
      frozen: frozenNames(state),
      // ★ 只判自家：被跳过（改不了）的非本插件技能 —— 让"为什么没评审它"可见
      foreign: new Set(foreignNames).size,
      foreignSkills: [...new Set(foreignNames)],
    }
  }

  const results = []
  let reviews = 0
  const deferred = new Set() // 被推迟的技能（其反馈/miss 不能消费）
  const deferredMissT = []

  for (const name of allSkills) {
    const fbs = bySkill.get(name) ?? []
    const missList = missBySkill.get(name) ?? []
    // 反馈证据更强（"用了之后出错"），有它就按反馈模式；否则才是 miss 模式
    const mode = fbs.length ? 'feedback' : 'miss'
    const st = (state.skills[name] ??= { frozen: false, silentCycles: 0 })
    const skillDir = path.join(skillRoot, name)

    let currentContent = null
    let revision = null
    try {
      currentContent = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8')
      revision = revisionOf(currentContent)
    } catch (e) {
      results.push({ skill: name, step: 'missing-skill', reason: `读不到 SKILL.md：${e.code || e.message}` })
      deferred.add(name)
      if (missList.length) deferredMissT.push(...missList.map((m) => m.t))
      continue
    }

    // 规则 3：只认 revision 与当前一致的反馈（miss 不适用 —— 它针对描述，不带 revision）
    const valid = fbs.filter((f) => f.revision === revision)
    if (mode === 'feedback' && !valid.length) {
      results.push({ skill: name, step: 'stale-feedback', reason: `反馈指向旧 revision（当前 ${revision}）` })
      continue
    }

    st.frozen = false // 有新证据 → 解冻
    st.silentCycles = 0

    if (reviews >= maxPerCycle) {
      // ★ 推迟：不评审，且**不消费**它的证据（水位会退回）
      deferred.add(name)
      if (missList.length) deferredMissT.push(...missList.map((m) => m.t))
      results.push({ skill: name, step: 'deferred', reason: `本轮已达评审上限 ${maxPerCycle}` })
      continue
    }

    // ★★ 同一批证据已判过 no-change → 跳过（不花 LLM、不重复产出近似的长判词）。
    //   指纹涵盖 mode/revision/反馈序号/miss 时间：任何一项变了都会重新评审。
    const batchFp = batchFingerprint({ mode, revision, feedback: valid, misses: missList })
    if (st.noChangeFp && st.noChangeFp === batchFp && st.noChangeRev === revision) {
      cached += 1
      results.push({
        skill: name,
        step: 'no-change-cached',
        mode,
        reason: `同一批证据已判过 no-change（${st.noChangeAt ? new Date(st.noChangeAt).toISOString() : '此前'}），不重评`,
      })
      continue
    }

    if (!llm) {
      deferred.add(name)
      if (missList.length) deferredMissT.push(...missList.map((m) => m.t))
      results.push({ skill: name, step: 'no-llm', reason: '未挂载 LLM 服务', mode })
      continue
    }

    reviews++

    // 相关记忆（简单策略：按技能名召回）
    let memTexts = []
    try {
      const r = store.recall({ query: name, limit: limitMemories })
      memTexts = (r || []).map((m) => `${m.summary}${m.tags?.length ? `（${m.tags.join(',')}）` : ''}`)
    } catch (e) {
      onWarn(`召回相关记忆失败：${e.message}`)
    }

    const history = await readHistory(historyFileFor(skillDir))

    // ---- 评审 ----
    let rev = null
    try {
      const reply = await callLlm(llm, { provider, model }, buildReviewPrompt({
        skillName: name, currentContent, revision, feedback: valid,
        memories: memTexts, rulePoints: extractRulePoints(currentContent), history,
        mode, misses: missList,
      }))
      rev = parseJsonReply(reply)
    } catch (e) {
      deferred.add(name)
      if (missList.length) deferredMissT.push(...missList.map((m) => m.t))
      results.push({ skill: name, step: 'review-error', reason: e.message, mode })
      continue
    }

    if (!rev || rev.change !== true) {
      const reason = rev?.reason || '模型回复无法解析或未给出修订'
      // ★ 记下"这批证据已判 no-change"，下一轮同指纹直接跳过（见 batchFingerprint 注释）
      st.noChangeFp = batchFp
      st.noChangeRev = revision
      st.noChangeAt = Date.now()
      await appendJsonl(historyFileFor(skillDir), { t: Date.now(), skill: name, revision, verdict: 'no-change', mode, reason, feedback: valid.length, misses: missList.length })
      results.push({ skill: name, step: 'no-change', mode, reason })
      continue
    }

    // 有修订可走 → 这批证据已被消费，清掉"已判 no-change"的记忆
    st.noChangeFp = null
    st.noChangeRev = null
    st.noChangeAt = null

    // 规则 4：归因必须可证伪
    if (!rev.rulePoint || !String(rev.rulePoint).trim()) {
      state.pending = [...state.pending, { kind: 'review', skill: name, mode, reason: '归因不可证伪（未指出具体规则点）', why: rev.why }].slice(-PENDING_MAX)
      await appendJsonl(historyFileFor(skillDir), { t: Date.now(), skill: name, revision, verdict: 'rejected', mode, reason: '归因不可证伪（未指出具体规则点）' })
      results.push({ skill: name, step: 'unfalsifiable', mode, reason: '归因未指出具体规则点' })
      continue
    }

    // 规则 5：缺反例不改
    if (!rev.counterexample || !String(rev.counterexample).trim()) {
      await appendJsonl(historyFileFor(skillDir), { t: Date.now(), skill: name, revision, verdict: 'rejected', mode, reason: '缺反例' })
      results.push({ skill: name, step: 'no-counterexample', mode, reason: '缺反例' })
      continue
    }

    if (!rev.newContent || !String(rev.newContent).trim()) {
      await appendJsonl(historyFileFor(skillDir), { t: Date.now(), skill: name, revision, verdict: 'rejected', mode, reason: '未给出修订全文' })
      results.push({ skill: name, step: 'no-content', mode, reason: '未给出修订全文' })
      continue
    }

    // ★★ miss 模式的机械闸门：只许改 description。提示词里写了没用 —— 代码里再挡一道。
    if (mode === 'miss' && !isDescriptionOnlyChange(currentContent, rev.newContent)) {
      await appendJsonl(historyFileFor(skillDir), {
        t: Date.now(), skill: name, revision, verdict: 'rejected', mode,
        reason: '该用未用只能改描述：修订改动了正文（被机械闸门拦下）',
      })
      results.push({ skill: name, step: 'body-changed', mode, reason: '该用未用只许改描述；本次改动了正文' })
      continue
    }

    // ---- 规则 6：回归门（独立验证者，拿不到修订理由）----
    let verdict = null
    try {
      const reply = await callLlm(llm, { provider, model }, buildVerifyPrompt({
        skillName: name,
        oldContent: currentContent,
        newContent: rev.newContent,
        counterexample: rev.counterexample,
        positiveCase: rev.positiveCase,
        oldRulePoints: extractRulePoints(currentContent),
        // 冷启动的「规则点覆盖」只对正文有意义的改动适用；miss 模式正文根本不许动
        coldStart: mode !== 'miss',
        mode,
      }))
      verdict = parseJsonReply(reply)
    } catch (e) {
      deferred.add(name)
      if (missList.length) deferredMissT.push(...missList.map((m) => m.t))
      results.push({ skill: name, step: 'verify-error', mode, reason: e.message })
      continue
    }

    const pass = verdict?.pass === true
    const newRevision = revisionOf(rev.newContent)

    // 归因结果留档（供审计）
    for (const f of valid) {
      await appendJsonl(feedbackFile, { t: Date.now(), ...f, _idx: undefined, _selfT: undefined })
    }
    // 回归用例入库（只增不减）
    await appendJsonl(regressionFileFor(skillDir), { t: Date.now(), kind: 'counter', scenario: rev.counterexample, revision })
    if (rev.positiveCase) {
      await appendJsonl(regressionFileFor(skillDir), { t: Date.now(), kind: 'positive', scenario: rev.positiveCase, revision })
    }

    let wrote = false
    let proposalPath = null
    if (pass && writeBack) {
      await writeBackSkill(skillDir, currentContent, revision, rev.newContent)
      wrote = true
    } else if (pass) {
      // ★ 写回关闭时必须把修订正文落盘 —— 否则 history 里只有一个哈希，
      //   人无从审核"它到底提议改了什么"，proposed 就失去意义。
      // ★ 凭据卡口：proposals 是**内容类**写入（可能被误当技能用），与 SKILL.md 同策略 —— 拒写。
      const bad = assertNoSecretInSkill('修订建议', rev.newContent)
      if (bad) {
        await appendJsonl(historyFileFor(skillDir), {
          t: Date.now(), skill: name, revision, mode, verdict: 'rejected',
          reason: '修订建议疑似含凭据，已拒绝落盘',
        })
        results.push({ skill: name, mode, step: 'secret-rejected', reason: '修订建议疑似含凭据，已拒绝落盘' })
        continue
      }
      const pdir = proposalsDirFor(skillDir)
      await fs.mkdir(pdir, { recursive: true })
      proposalPath = path.join(pdir, `${newRevision}.md`)
      await fs.writeFile(proposalPath, rev.newContent, 'utf8')
    }

    await appendJsonl(historyFileFor(skillDir), {
      t: Date.now(), skill: name, revision, newRevision, mode,
      verdict: pass ? (wrote ? 'applied' : 'proposed') : 'rejected',
      why: rev.why, rulePoint: rev.rulePoint,
      counterexample: rev.counterexample, positiveCase: rev.positiveCase ?? null,
      verifyReason: verdict?.reason ?? null,
      missingRulePoints: verdict?.missingRulePoints ?? [],
      writeBack: wrote,
      proposal: proposalPath,
      ...(mode === 'miss' ? { missDriven: true, misses: missList.length } : {}),
    })

    results.push({
      skill: name,
      mode,
      step: pass ? (wrote ? 'applied' : 'proposed') : 'rejected',
      why: rev.why,
      verifyReason: verdict?.reason ?? null,
      proposal: proposalPath,
    })
  }

  // ---- 水位：只推进到"未被推迟"的位置 ----
  const deferredIdx = attributed.filter((f) => deferred.has(f.skill) && f.from === 'user').map((f) => f._idx)
  state.signalCount = deferredIdx.length ? Math.min(...deferredIdx) : signals.length
  const deferredSelf = attributed.filter((f) => deferred.has(f.skill) && f.from === 'self').map((f) => f._selfT)
  const maxSelf = newSelfReviews.length ? Math.max(...newSelfReviews.map((r) => r.t)) : selfFrom
  state.selfReviewT = deferredSelf.length ? Math.min(...deferredSelf) : maxSelf
  state.usageCount = usages.length
  // miss 的时间水位：只推进到"未被推迟"的位置（与信号水位同样的纪律）
  const maxMissT = newMisses.length ? Math.max(missFrom, ...newMisses.map((m) => m.t)) : missFrom
  state.missT = deferredMissT.length ? Math.min(...deferredMissT) : maxMissT

  await saveReviewState(stateFile, state)
  return {
    step: 'reviewed',
    cached,
    results,
    feedback: attributed.length,
    unattributed: unattr.length,
    misses: newMisses.length,
    retrievalGaps,
    deferred: [...deferred],
    frozen: frozenNames(state),
    writeBack,
    // ★ 只判自家：被跳过（改不了）的非本插件技能 —— 让"为什么没评审它"可见
    foreign: new Set(foreignNames).size,
    foreignSkills: [...new Set(foreignNames)],
  }
}

/** 当前被冻结的技能名（连续静默达到阈值；有新反馈会自动解冻）。 */
export function frozenNames(state) {
  return Object.entries(state?.skills ?? {})
    .filter(([, v]) => v && v.frozen)
    .map(([k]) => k)
}

// ============ 新建技能（阶段 4a）：生成门槛 + 独立验证 ============
/**
 * 新技能的暂存区。
 * 写回关闭时新技能落这里，**不进技能目录** —— 没通过的技能不该出现在模型可用目录里
 * （目录里出现什么，直接改变模型的行为）。
 */
export function newSkillStagingDirFor(dataFile, name) {
  return path.join(path.dirname(dataFile), 'skill-proposals', name)
}

/**
 * 新建技能的验证提示词。
 * 与"修订"不同：这里没有旧版可比，所以判定改为
 * 「反例是否真的成立 / 描述是否写的是触发条件 / 是否与现有技能重复 / 规则点是否可执行」。
 *
 * ★ F-10：`source` 是把反例的**原文**一并交给验证者（能取到时）。
 *   在此之前验证者只能看提议者的自述 —— 于是"编一个具体场景"能稳定通过；
 *   现在有原文可对照，且**明确标出**"这个来源没能核实"，不让它把自述当证据。
 */
export function buildNewSkillVerifyPrompt({ name, description, body, counterexample, positiveCase, why, existingSkills, source = null }) {
  const ex = (existingSkills || []).map((s) => `- ${s.name}：${s.description}`).join('\n') || '（无）'
  const sourceBlock = []
  if (source?.verified === true) {
    sourceBlock.push(
      '',
      '【反例的来源原文（来自会话日志，已按 seq 取到）】',
      `来源：session=${source.ref?.session ?? '?'} seq=${source.ref?.seq ?? '?'}（事件类型 ${source.type || '未知'}）`,
      '---',
      source.text || '（该事件取不到可读文本）',
      '---'
    )
  } else {
    sourceBlock.push(
      '',
      '【反例的来源】⚠ 未能核实：' + (source?.note || '本机没有可比对的会话日志'),
      `提议者自报：session=${source?.ref?.session ?? '?'} seq=${source?.ref?.seq ?? '?'}`,
      '注意：这一段**只是自述**，不要假设它已被核对过。若反例的具体性完全依赖这段无法核实的细节，请谨慎通过。'
    )
  }
  return [
    '你是独立验证者。有人提议新建一个技能。你看不到提议者的更多解释，请只依据下面的内容判断。',
    '',
    `【提议的技能名】${name}`,
    `【触发条件（描述）】${description}`,
    `【动机】${why || '（未提供）'}`,
    '',
    '【技能正文】',
    '---',
    body,
    '---',
    '',
    '【反例】没有这个技能时会做错的具体场景：',
    counterexample || '（未提供）',
    ...sourceBlock,
    '',
    '【正例】有这个技能后仍然必须做对的具体场景：',
    positiveCase || '（未提供）',
    '',
    '【现有技能】',
    ex,
    '',
    '【判断】',
    '1. 反例是否真的是「没有这个技能就会做错」的具体场景？（不是泛泛而谈）',
    '2. 正例是否成立？',
    '3. 描述是否写的是「什么时候该用」（而不是「它能做什么」）？模型只能靠它决定加不加载。',
    '4. 是否与现有技能重复？重复就不该新建。',
    '5. 正文的规则点是否具体、可执行？',
    '6. 若上面给了【来源原文】：反例的描述是否与那段原文**一致**（不是同一件事 → 不通过）；' +
      '若标了「未能核实」：就按自述对待，不要把它的细节当成已证实的证据。',
    '',
    '【输出】只输出一个 JSON：{"pass": true/false, "reason": "...", "overlaps": ["技能名"...]}',
  ].join('\n')
}

/**
 * 新建技能。**生成门槛**：做不了「反例 + 正例」两个验证，就不许生成。
 *
 * 四重校验（前三重不依赖 LLM）：
 *   ① 必需项齐全 —— 缺反例或缺正例直接拒绝
 *   ② F-10 反例可溯源 —— 纯机械：正则解析 session+seq，并按 seq 去会话日志核对（取不到则降级标注）
 *   ③ 内容用 provider 的**同一个解析器**校验 —— 能建出来就一定加载得起来
 *   ④ 独立验证者判定（含与现有技能查重；能取到原文时把原文一并交给它对照）
 *   ⑤ F-11 目录容量上限 —— 达上限则改落暂存区并说明（不静默丢弃）
 *
 * @returns {ok, verdict: 'created'|'proposed'|'capped'|'rejected', reason, path, missing?, sourceNotVerified?}
 */
/**
 * 省略 null/undefined 字段。
 *
 * ★ 工具输出必须能通过它自己的 schema 校验 —— 而 `null` 不是 `string`。
 *   这类错误在本项目里出现过三次（undeclared `unmarked`、返回 `null` 给 string、
 *   未声明 `overlaps`），共同点是：**返回值是自然写出来的，schema 是另一处手写的**，
 *   两者之间没有强制校验。所以凡是给工具用的返回值都从这里过一道。
 */
function omitNulls(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue
    out[k] = v
  }
  return out
}

export async function createSkill(deps, input) {
  return omitNulls(await createSkillInner(deps, input))
}

async function createSkillInner(deps, input) {
  const {
    skillRoot, dataFile, llm, provider, model, writeBack = DEFAULT_CREATE_WRITE_BACK,
    session = null, maxSkills = DEFAULT_MAX_SKILLS,
  } = deps
  const name = String(input?.name ?? '').trim()
  const description = String(input?.description ?? '').trim()
  const body = String(input?.body ?? '').trim()
  const counterexample = String(input?.counterexample ?? '').trim()
  const positiveCase = String(input?.positiveCase ?? '').trim()
  const why = String(input?.why ?? '').trim()

  // ① 硬门槛：反例与正例是**必需**的（用户的规则：做不了两个验证就不许生成）
  const missing = []
  if (!name) missing.push('name')
  if (!description) missing.push('description')
  if (!body) missing.push('body')
  if (!counterexample) missing.push('counterexample（反例）')
  if (!positiveCase) missing.push('positiveCase（正例）')
  if (missing.length) {
    return {
      ok: false,
      verdict: 'rejected',
      path: null,
      missing,
      reason: `缺少必需项：${missing.join('、')} —— 做不了「反例 + 正例」两个验证的技能不许生成`,
    }
  }

  // ①b F-10：反例必须**可溯源**。与上面同一道硬门槛（缺来源 → 直接拒），
  //     只是判据换成"纯机械"的正则解析 —— 不调 LLM、不判断真伪。
  const src = parseSourceRef(counterexample) // ★F10-SOURCE-GATE
  if (!src.ok) {
    return {
      ok: false,
      verdict: 'rejected',
      path: null,
      missing: [src.kind === 'missing' ? 'counterexample 来源（session + seq）' : 'counterexample 来源格式'],
      reason: src.reason,
    }
  }
  // 有来源格式 ≠ 来源存在：宿主给了会话日志时，按 seq 去核对。
  // 拿到了日志却查不到这个 seq → 这条"来源"是编的/抄错的 → 拒（这是 F-10 真正想拦的东西）。
  const source = resolveSourceRef(src, { session })
  if (source.exists === false) {
    return {
      ok: false,
      verdict: 'rejected',
      path: null,
      missing: ['counterexample 来源（指向的事件不存在）'],
      reason: `反例来源不存在（机械核对，未调模型）：${source.note}。请引用真实发生过的失败事件，或换一条能核实的来源。`,
    }
  }

  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`

  // ② 用 provider 的同一个解析器校验：能建出来就一定能被加载
  try {
    parseSkillFile(content, name)
  } catch (e) {
    return { ok: false, verdict: 'rejected', path: null, reason: `技能内容不合法：${e.message}` }
  }

  if (!llm) {
    return { ok: false, verdict: 'rejected', path: null, reason: '未挂载 LLM 服务，无法验证' }
  }

  let existing = []
  try {
    existing = await listSkills(skillRoot)
  } catch (e) {
    /* 技能目录读不到就当没有：后面验证者还会查重 */
  }
  if (existing.some((s) => s.name === name)) {
    return {
      ok: false,
      verdict: 'rejected',
      path: null,
      reason: `同名技能已存在：${name} —— 改动已有技能应当走评审流程，而不是新建`,
    }
  }

  // ③ 独立验证者。★ F-10：把反例的**来源原文**（能取到时）一并交出去 ——
  //     验证者在此之前只能读到提议者的自述，于是"编一个具体场景"能稳定通过。
  let verdict = null
  try {
    verdict = parseJsonReply(
      await callLlm(
        llm,
        { provider, model },
        buildNewSkillVerifyPrompt({
          name, description, body, counterexample, positiveCase, why,
          existingSkills: existing,
          source: { ref: src, verified: source.verified === true, exists: source.exists, note: source.note, text: source.text, type: source.type },
        })
      )
    )
  } catch (e) {
    return { ok: false, verdict: 'rejected', path: null, reason: `验证调用失败：${e.message}` }
  }
  if (verdict?.pass !== true) {
    return {
      ok: false,
      verdict: 'rejected',
      path: null,
      reason: verdict?.reason || '验证未通过',
      overlaps: verdict?.overlaps ?? [],
    }
  }

  // ★ 凭据卡口（内容类写入）：技能正文里不该有密钥。放在**所有落盘之前**，两种去向一起挡。
  const secretErr = assertNoSecretInSkill('新技能正文', content)
  if (secretErr) return { ok: false, verdict: 'rejected', path: null, reason: secretErr.message }

  const revision = revisionOf(content)
  const record = {
    t: Date.now(), skill: name, revision, why: why || null,
    counterexample, positiveCase,
    // F-10：来源与"是否核对过"一并记账 —— 降级通过的那条**必须**看得出没核实
    counterexampleSource: { session: src.session, seq: src.seq, verified: source.verified === true },
    verifyReason: verdict.reason ?? null,
  }
  // 取不到原文时的降级标注（会进回执，不假装核实过）；null 会被 omitNulls 省掉
  const sourceNotVerified = source.verified === true ? null : source.note

  const stageProposal = async (v, extra = {}) => {
    const sdir = newSkillStagingDirFor(dataFile, name)
    await fs.mkdir(sdir, { recursive: true })
    const sp = path.join(sdir, 'SKILL.md')
    await fs.writeFile(sp, content, 'utf8')
    await appendJsonl(path.join(sdir, 'history.jsonl'), { ...record, verdict: v, ...extra })
    return {
      ok: true,
      verdict: v,
      path: sp,
      reason: verdict.reason ?? null,
      sourceNotVerified,
      ...extra,
    }
  }

  // ④ F-11：技能目录容量上限。达到上限 → 停止自动入目录（**但不静默丢弃提议**），
  //    改落暂存区，并在回执里明说"已达上限 N，请人工清理"。
  if (writeBack && existing.length >= maxSkills) {
    return stageProposal('capped', { capLimit: maxSkills, existingCount: existing.length })
  }

  if (writeBack) {
    const dir = path.join(skillRoot, name)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'SKILL.md'), content, 'utf8')
    await appendJsonl(historyFileFor(dir), { ...record, verdict: 'created' })
    await appendJsonl(regressionFileFor(dir), { t: Date.now(), kind: 'counter', scenario: counterexample, revision })
    await appendJsonl(regressionFileFor(dir), { t: Date.now(), kind: 'positive', scenario: positiveCase, revision })
    return { ok: true, verdict: 'created', path: path.join(dir, 'SKILL.md'), reason: verdict.reason ?? null, sourceNotVerified }
  }

  // 写回关闭 → 暂存，不进技能目录
  return stageProposal('proposed')
}

