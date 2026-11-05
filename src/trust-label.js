/**
 * 记忆信任标签与外部信息工具判定。
 *
 * 这里只做展示层提醒，不做检索排序、过滤、升级或自动改写。
 * 信任 = 对信息的实际掌控权：可检查、可追溯、可修正的程度。
 */

const AUTO_LABEL = {
  experience: '经验',
  decision: '决策',
  event: '事件',
  other: '其他',
}

export function memoryTrustLabel(m) {
  if (!m || typeof m !== 'object') return ''
  if (m.source === 'autobiography') {
    // 身份固定注入，不参与常规召回；若被显式召回，只保留来源标记，不冒充普通背景。
    if (m.category === 'identity') return '[自传体·身份] '
    return `[自传体·${AUTO_LABEL[m.category] || '其他'} · 实际掌控权高/可修正 · 不是普通背景] `
  }
  if (m.source === 'external') return '[外部信息 · 非自己掌握/未验证 · 不可直接采信] '
  if (m.source === 'validation') return '[验证结果] '
  return ''
}

/** 工具结果是否属于外部信息通道；只决定加提示，不决定采信。 */
export function isExternalInfoToolName(name) {
  const n = String(name || '')
  return n === 'web_search'
    || n === 'web_fetch'
    || n === 'list_mcp_resources'
    || n === 'list_mcp_resource_templates'
    || n === 'read_mcp_resource'
    || n.startsWith('mcp__')
}
