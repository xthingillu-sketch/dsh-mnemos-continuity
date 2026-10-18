/**
 * dsh-mnemos 心跳机制：预定义维护功能的注册表。
 * 预留接口：register(name, description, run) 让未来功能可扩展
 * （路径 B 理解 diff、skill 更新、归档到期任务等）。
 */
export function createHeartbeat() {
  const tasks = new Map()
  return {
    register(name, description, run) {
      tasks.set(name, { name, description, run })
    },
    list() {
      return [...tasks.values()].map(({ name, description }) => ({ name, description }))
    },
    async run(store) {
      const results = []
      for (const [name, task] of tasks) {
        try {
          const result = await task.run(store)
          results.push({ name, ok: true, result })
        } catch (e) {
          results.push({ name, ok: false, error: String((e && e.message) || e) })
        }
      }
      return { ranAt: Date.now(), results }
    },
  }
}
