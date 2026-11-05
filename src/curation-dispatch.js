/**
 * 自动 curation 的会话投递：找一个空闲会话，把“调用 mnemos_curate”的任务注入进去。
 *
 * 不新建 curator 子代理，也不要求 auxProvider/auxModel；
 * 目标会话自己的模型和工具负责执行，mnemos_curate 内部仍走隔离子代理。
 */

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
    const id = String(a.id || a.session?.id || '')
    if (/^mnemos-(curation|validator)-/.test(id)) continue
    return a
  }
  return null
}
