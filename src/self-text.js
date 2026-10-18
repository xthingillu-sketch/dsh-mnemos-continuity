/**
 * 自传体注入文本的组装（从 index.js 拆出来，为了能独立测试）。
 *
 * 拆出来的理由：这段文本直接决定「模型看不看得见自己的身份与红线」，
 * 而 index.js 里有 `@deepseek-ai/schemastery` 这类宿主依赖、单测里 import 不了 ——
 * 于是「宪法缺失」这条最该被测的路径反而测不到。放这里就绕不过测试。
 *
 * ★ 两件事必须写死在这里（F-3 的病根）：
 *   ① 宪法**未初始化时不能返回空串** —— 返回 "" 会被宿主当成"这个变量没内容"而丢掉，
 *      于是模型**完全不知道**身份/红线不存在（静默失效）。至少要说出来。
 *   ② 说的时候要给**真实解析到的绝对路径**（不是占位符、不是猜的），
 *      持有者才知道该把宪法初始化到哪里。
 */
import { plain } from './plain-text.js'

/** 命令行里带空格的路径要用引号（否则复制粘贴直接跑不起来）。 */
function quotedForCli(p) {
  return /[\s"]/.test(p) ? `"${p}"` : p
}

/**
 * 宪法未初始化时注入的可见警告。
 *
 * ⚠️ 本段是**注入给模型**的文本：**纯文本，不要用 `**`**
 *    （项目栽过四次字面星号，见 plain-text.js 的注释；本文件出口统一过 plain()）。
 *
 * @param {string} constitutionFile 真实解析到的宪法文件绝对路径
 */
export function constitutionMissingWarning(constitutionFile) {
  const p = constitutionFile || '(路径未知)'
  return plain(
    [
      '⚠️【宪法 · 未初始化】Mnemos 的身份与红线尚未生效。',
      `期望路径：${p}`,
      `请由持有者运行：node scripts/init-constitution.mjs --file=${quotedForCli(p)}`,
      '（宪法只读，且必须由人设密码，Mnemos 自己无法初始化。）',
    ].join('\n')
  )
}

/**
 * 组装注入给模型的自传体文本。
 *
 * 宪法段：已初始化 → 注入正文；未初始化 → 注入**可见警告**（绝不静默变空）。
 * 自传体段：照旧，为空则不注入。
 * ★ F-12：自传体段被预算截断时，末尾**多一行**说清"另有 N 条没进来"，
 *   并指路 mnemos_recall —— 口径由持有者定死：既要让它知道有内容未注入，
 *   又要提醒它按需召回（不许凭印象认为没记过）。N 是**实数**（来自 store），不是"可能还有"。
 *
 * @param {{read:()=>string|null, dataFile?:string}} constitution ConstitutionStore 或同形对象
 * @param {{autobiographyCompact:(o:{budget:number})=>{
 *   entries:{label:string,summary:string}[],
 *   unselected?:number, budget?:number}}} store
 * @param {number} budget 自传体紧凑版字符预算
 */
export function buildSelfText(constitution, store, budget) {
  const parts = []
  const con = constitution.read()
  if (con) {
    parts.push(`【宪法 · 身份/红线（系统只读，不可变）】\n${con}`)
  } else {
    // 未初始化（或文件存在但正文为空）→ 必须说出去，不能整段消失
    parts.push(constitutionMissingWarning(constitution.dataFile || ''))
  }
  const auto = store.autobiographyCompact({ budget })
  if (auto.entries.length) {
    const lines = auto.entries.map((e) => `[${e.label}] ${e.summary}`)
    // 实数（store 如实统计；缺省视为 0 —— 同形 stub 也不该凭空吓人）
    const n = Number(auto.unselected) || 0
    // 预算用**实际生效**的值（store 回传的），拿不到才退回入参
    const b = Number(auto.budget) || budget
    if (n > 0) {
      lines.push(
        `【自传体 · 尚未注入】另有 ${n} 条自传体（能力/事件/其他类目）未进本段：` +
          `本段只受 ${b} 字符预算约束。需要时用 mnemos_recall 检索（不要凭印象认为没记过）。`
      )
    }
    parts.push('【自传体 · 自我历史（紧凑版，按需召回详情）】\n' + lines.join('\n'))
  }
  return parts.join('\n\n')
}
