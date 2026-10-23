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
      // ★ V6-01：**先刷新磁盘，再跑维护任务**（顺序不能反）。
      //   别的实例刚写入的短时记录要先被"看到"，归档才会觉得有活干；
      //   否则可见性依赖写盘、写盘又依赖"觉得有活干"，形成死环。
      let refresh = null
      try {
        refresh = typeof store?.refreshFromDisk === 'function' ? await store.refreshFromDisk() : null
      } catch (e) {
        // 刷新失败不阻断维护：维护在旧视图上跑，至少不会整轮不跑。
        refresh = { ok: false, error: String((e && e.message) || e) }
      }
      const results = []
      for (const [name, task] of tasks) {
        try {
          const result = await task.run(store)
          results.push({ name, ok: true, result })
        } catch (e) {
          results.push({ name, ok: false, error: String((e && e.message) || e) })
        }
      }
      return { ranAt: Date.now(), refresh, results }
    },
  }
}
