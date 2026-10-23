/**
 * `mnemos_propose_skill` 的**面向模型的文本**（工具描述 + 回执）。
 *
 * 为什么单独一个模块（而不是写在 index.js 里）：
 *   · F-9 的验收是「工具描述**不再含劝退表述**」—— 而 `index.js` 顶层 import 了宿主注入的
 *     peerDependency `@deepseek-ai/schemastery`（本机插件目录没有 node_modules）→
 *     纯 node 下**根本加载不了**（实测 `ERR_MODULE_NOT_FOUND`），描述文本就断言不到、
 *     只能靠"我记得改过"。所以正文放在无依赖的模块里，index.js 只负责消费它。
 *   · F-11 的验收是「达上限时回执要说明、不静默」—— 回执文本同理必须可断言。
 *   · 纪律层的教训：**凡"靠模型自觉/靠人记得"的地方都会以同一方式失败**，
 *     所以把"描述写了什么"从"我记得写过"下沉成"测试能扫到"。
 */
import { SOURCE_REF_FORMAT_HINT } from './skill-source-ref.js'

/**
 * 工具描述。三件事必须说清（旧版本三个都没说，等于劝退）：
 *   ① 触发时机：什么时候**该**提交（失败→修好、且做法可复用）
 *   ② 会过哪些护栏：反例+正例 / 来源标识 / 查重 / 凭据扫描 / 独立验证
 *   ③ 落盘后的去向：默认进技能目录并立即可用；上限或关闭写回时落 skill-proposals 并说明
 *
 * ★ 刻意删掉的旧句子：「是否真的落盘取决于 reviewWriteBack 配置」——
 *   那是一句劝退：模型读到"提了也可能白提"，合理反应就是干脆不提
 *   （实测全库 `mnemos_propose_skill` 只在开发实测会话里被调用过 5 次，日常会话 0 次）。
 */
export const PROPOSE_SKILL_DESCRIPTION =
  '把一条可复用的做法沉淀成任务型技能。何时该用（由你判断，不必先犯错）：' +
  '① 成功路径上的新做法，且换一个任务还会用到；② 少量失败换来的经验；' +
  '③ 同一类问题在记忆里反复出现（origin=memory-recurring：≥3 个真实事件、跨 2 个会话）；' +
  '④ 外部技能改写（origin=external-rewrite：自己搜到或用户提供；保留需用户同意）。' +
  'F-8 的「失败→修好」提示只是其中一种典型时机，不是唯一入口。' +
  '一次性经验写记忆即可；每轮都要遵守的纪律型内容不进技能库，应当建议写进系统提示。' +
  '审核会挡错的，不用担心提错。' +
  '护栏（都在落盘前自动跑）：failure-fixed 必须同时给出反例与正例，反例必须带来源标识（' +
  SOURCE_REF_FORMAT_HINT +
  '）且会被机械核对；memory-recurring 用 events 里至少 3 个记忆 id（跨 ≥2 会话）作证据，' +
  '反例/正例至少一种即可；external-rewrite 必须记录 source（self-found / user-provided + 链接或文件名），' +
  '不要求本地反例。名字不得与现有技能重复（改已有技能走评审，不新建）；正文过凭据扫描；' +
  '通过后由独立验证者判定（含与现有技能查重，并在能取到原文时对照原文）。' +
  '去向：failure-fixed / memory-recurring 默认直接写入任务型技能目录（createWriteBack=false 时落暂存区）；' +
  'external-rewrite **一律先落 skill-proposals/**，默认不自动入目录（externalSkillWriteBack=true 才可能直接写回）——' +
  '保留前请向用户确认。技能数达到 maxSkills 上限时不再入目录，改为暂存并在回执里说明原因。'

/**
 * 回执文本（工具结果给模型看的那几行）。★ 每个分支都必须**说明去向与原因** ——
 * "没进目录"却不说为什么，是这一层最容易出现的静默失败。
 */
export function renderProposeSkillResult(v) {
  const lines = []
  const verdict = v?.verdict
  if (verdict === 'created') {
    lines.push(`已创建技能：${v.path}`)
    lines.push('（已进技能目录、本次会话即可用；下一次同名的提议会被直接拒，修订请走评审流程）')
  } else if (verdict === 'proposed') {
    if (v.requiresUserConsent) {
      lines.push(`外部来源：已验证并暂存，但**未进技能目录**：${v.path}`)
      lines.push(
        '（保留需用户确认；请先问用户，不要自己移入技能根。用户同意后可手动移入，或开启 externalSkillWriteBack）'
      )
    } else {
      lines.push(`验证通过，但写回关闭 → 已暂存：${v.path}`)
      lines.push('（未进技能目录，暂不影响行为；确认后把 createWriteBack 设为 true，或手动移入技能根）')
    }
  } else if (verdict === 'capped') {
    lines.push(`验证通过，但技能目录已达上限 ${v.capLimit} 个 → 已暂存：${v.path}`)
    lines.push(
      `（未入目录，暂不影响行为；请人工清理技能目录里的 ${v.existingCount} 个技能后再重提，` +
        '或调大 maxSkills 配置。本条提议没有丢，就一直放在暂存区）'
    )
  } else {
    lines.push(`未创建：${v.reason || ''}`)
  }
  if (v?.origin) lines.push(`来源类型：${v.origin}`)
  if (v?.externalSource) lines.push(`外部来源：${v.externalSource.kind} · ${v.externalSource.ref}`)
  if (v?.origin === 'memory-recurring' && Number.isFinite(v.eventsCount)) {
    lines.push(`记忆事件：${v.eventsCount} 个（已按记忆 id 解析）`)
  }
  if (v?.missing && v.missing.length) lines.push(`缺少：${v.missing.join('、')}`)
  if (verdict !== 'rejected' && v?.reason) lines.push(`验证意见：${v.reason}`)
  if (v?.sourceNotVerified) lines.push(`来源未核实（已降级通过）：${v.sourceNotVerified}`)
  return lines
}
