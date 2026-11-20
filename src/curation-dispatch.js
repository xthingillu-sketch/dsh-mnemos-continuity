/**
 * 自动 curation 的会话投递：找一个空闲会话，把“调用 mnemos_curate”的任务注入进去。
 *
 * 不新建 curator 子代理，也不要求 auxProvider/auxModel；
 * 目标会话自己的模型和工具负责执行，mnemos_curate 内部仍走隔离子代理。
 */

/**
 * 维护型子会话的识别口径（2026-11-16 修）。
 *
 * ★ 为什么不能只靠 id 正则：实测真实 id 形状是 `session-<uuid>`（顶层）或裸 `<uuid>`
 *   （子代理），**没有** `mnemos-curation-*` 这种前缀 —— 旧正则 `/^mnemos-(curation|validator)-/`
 *   在真实运行中一条都匹配不上（只有测试 fixture 造得出来），于是"排除自己踢自己"形同虚设。
 *   现在按 preset / label / id 三路判，任一命中即排除。
 *
 * preset / label 取值来自 index.js：CURATOR_PRESET_ID='mnemos-curator'、
 * VALIDATOR_PRESET_ID='mnemos-validator'，子会话 label 分别是 'mnemos-curator' / 'mnemos-validation'。
 */
const MAINTENANCE_ID_PATTERN = /^mnemos-(curation|validator)-/
const MAINTENANCE_PRESETS = new Set(['mnemos-curator', 'mnemos-validator'])
const MAINTENANCE_LABELS = new Set(['mnemos-curator', 'mnemos-validation'])

/** 这个 agent 是否是维护型子会话（curation / validation）。 */
export function isMaintenanceSession(a) {
  if (!a || typeof a !== 'object') return false
  const id = String(a.id || a.session?.id || '')
  if (MAINTENANCE_ID_PATTERN.test(id)) return true
  const preset = String(a.agentPreset || a.preset || a.session?.agentPreset || a.session?.preset || '')
  if (MAINTENANCE_PRESETS.has(preset)) return true
  const label = String(a.label || a.session?.label || '')
  if (MAINTENANCE_LABELS.has(label)) return true
  return false
}

export function buildCurationDispatchMessage(action) {
  const label = action === 'identity' ? '身份' : '经验'
  return [
    '[自动维护任务 · curation]',
    `请调用一次 mnemos_curate({ action: '${action}' }) 整理${label}。`,
    '只做这一件事；不要展开新任务，不要修改其他记忆。',
  ].join('\n')
}

/**
 * 只挑真正空闲、能接收 followup 的会话。
 * 排除 curation/validator 子会话，避免自己踢自己。
 */
export function pickIdleCurationAgent(list) {
  const arr = Array.isArray(list) ? list : []
  for (const a of arr) {
    if (!a || typeof a !== 'object') continue
    if (typeof a.followup !== 'function') continue
    if (a.status !== 'idle') continue
    if (isMaintenanceSession(a)) continue
    return a
  }
  return null
}
