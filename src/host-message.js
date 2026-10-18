/**
 * 把一段文本包成**宿主 inbox 能接受、且能长期存活**的 user 消息。
 *
 * ★ 为什么需要这个文件（2026-10-17 的真实事故，不要拆掉）：
 *   折叠快照的「【折叠提醒】」原来直接把 `{ content, source }` 交给 `agent.inject()`，
 *   **没有 `role`、也没有 `id`**。宿主两处口径不一致：
 *     · **写入很宽**：dsh-agent-loop 的 `inject()/followup()/steer()` → inbox → 原样
 *       `session.append('user/message', message, { surfaceOp: 'append' })`，不校验；
 *     · **加载很严**：dsh-session 的 `assertMessageEventShape` 要求 user/message 的
 *       `message.role === 'user'` 且 `id` 是非空字符串，否则 resume/打开会话直接抛。
 *   于是这条消息同时埋了两颗雷：
 *     1) 投影 `deriveEventMessage` 对 user/message 是 `return event.data`（原样），
 *        DeepSeek Messages 适配器 `wireRole = message.role === 'tool' ? 'user' : message.role`
 *        **没有默认值** → `role: undefined` → 序列化丢字段 → 服务端
 *        `422 ... messages[459]: missing field 'role'`，而且这条消息留在会话里，之后**每轮都炸**；
 *     2) 重启后重新加载这条会话时过不了上面的严格校验 → 会话再也打不开。
 *   pi-ai 适配器（learner 走的 aliyun 路由）恰好有"不认识的一律当 user"的兜底，所以同一个 bug
 *   在两条路由上表现完全不同 —— 别拿"learner 一直好好的"当反证。
 *
 * ★ 结论（这就是"往下沉一层"的落点）：**注入消息只能由一个构造点生成，不许在内联字面量里手搓。**
 *   测试里既有形状断言，也有一条源码级机械检查（src 里出现 `agent.inject({` / `.followup({` /
 *   `.steer({` 这种内联字面量就算失败），所以再加注入点时绕不过去。
 */

import { randomUUID } from 'node:crypto'

/**
 * 构造一条可注入的 user 消息。
 *
 * @param {string} text 要注入的纯文本（自带标记，避免被当成用户真说话）
 * @param {{id?: string}} [options] 仅在需要固定 id 的测试里传
 * @returns {{id: string, role: 'user', content: Array<{type: 'text', text: string}>, source: {kind: 'user'}}}
 *   `role` 是模型侧必需（DeepSeek 路由不兜底）；`id` 是宿主**加载**侧必需（resume 校验）。
 *   `source.kind='user'` 是宿主 inbox 的"生产者来源"白名单里唯一可用的值（`{kind:'plugin'}` 会被拒）。
 */
export function buildInjectedUserMessage(text, { id } = {}) {
  return {
    id: typeof id === 'string' && id !== '' ? id : randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source: { kind: 'user' },
  }
}

/**
 * 宿主加载期的消息校验（`assertMessageEventShape`）在 user/message 上的等价规则。
 *
 * 放这里有三个用处：① 测试拿它当"能不能活过重启"的判据；② 让下一个人一眼看到规则原文的要点；
 * ③ 与 `buildInjectedUserMessage` 摆在同一个文件里 —— 构造与校验不该分居两地。
 *
 * @param {unknown} message user/message 事件的 `data`（宿主就是把它当消息对象）
 * @returns {string[]} 不合格原因；空数组表示这条消息能通过加载校验
 */
export function userMessageShapeProblems(message) {
  const problems = []
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return ['不是消息对象']
  if (message.role !== 'user') problems.push(`role 必须是 "user"（实际 ${JSON.stringify(message.role)}）`)
  if (typeof message.id !== 'string' || message.id === '') problems.push('id 必须是非空字符串')
  if (!Array.isArray(message.content)) problems.push('content 必须是数组')
  if (typeof message.source !== 'object' || message.source === null
    || typeof message.source.kind !== 'string' || message.source.kind === '') {
    problems.push('source.kind 必须是非空字符串')
  }
  return problems
}
