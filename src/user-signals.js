/**
 * dsh-mnemos 用户信号捕获（阶段 3a）—— 纯机械，不做任何判断。
 *
 * 为什么只做机械捕获、判断留给事后：
 *   用户反馈往往**不在"使用的那一刻"产生** —— 它可能在另一个对话里、几天之后才出现，
 *   甚至是"复用时偶然发现问题"这种纯事后观点。此刻的钩子没有这个视角，
 *   所以它只负责**如实记下**，判断交给周期性的归因层（那里才有记忆和全貌）。
 *
 * 为什么要有"本会话已用过技能"这个前置条件：
 *   1. 语义上：没用过技能的会话，其消息与技能无关，记了也没用
 *   2. 隐私上：只落在技能使用之后的消息，暴露面大幅收窄
 *   3. 成本上：绝大多数会话消息不会被写入
 *
 * 桥（跨对话归因的基础）：
 *   这里的信号带 (t, session)；记忆体里的产物带 (sessionId, createdAt)；
 *   使用记录带 (session, t)。三者可反查 —— 详见归因层。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { findSecrets, redactSecrets, auditSecretBlock, secretBlocksFileFor } from './secret-patterns.js'

/** 用户信号文件：与 memory.json 同级。 */
export function userSignalsFileFor(dataFile) {
  return path.join(path.dirname(dataFile), 'user-signals.jsonl')
}

/** 「技能被提供过」的记录（只有名单，不含正文）。 */
export function skillOffersFileFor(dataFile) {
  return path.join(path.dirname(dataFile), 'skill-offers.jsonl')
}

/** 「该用未用」通道用的**有界任务指纹**（与反馈通道分开存，各自目的单一）。 */
export function sessionTasksFileFor(dataFile) {
  return path.join(path.dirname(dataFile), 'session-tasks.jsonl')
}

/** 任务指纹的字符上限（有界，是隐私边界的一部分）。 */
export const TASK_FINGERPRINT_CHARS = 300
/** 每个会话最多记多少条任务指纹（有界）。 */
export const TASK_MAX_PER_SESSION = 20

/**
 * 从技能目录文本里抽出技能名。
 * 目录条目形如：`- \`skill-name\`: 描述…`
 * **只取名字** —— 描述与正文都不落盘（这是「记录提供过」与「记录内容」的分界）。
 */
export function parseCatalogSkills(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(/^\s*-\s*`([^`]+)`\s*:/gm)) out.push(m[1])
  return out
}

/** 把一条用户消息压成有界的任务指纹（折叠空白 + 截断）。 */
export function taskFingerprint(text, max = TASK_FINGERPRINT_CHARS) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * 从 user/message 的 data 里取纯文本。
 * 只取 text 块；没有文本（纯附件/纯图片）返回空串。
 */
export function extractUserText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : []
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/**
 * 追加一条用户信号（append-only）。
 * 刻意**不判断**是不是负反馈 —— 那是归因层的事。
 */
export async function appendUserSignal(file, rec) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf8')
}

/** 读取全部用户信号；坏行跳过并告警。 */
export async function readUserSignals(file, onWarn = () => {}) {
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
      onWarn(`跳过损坏的用户信号行：${t.slice(0, 60)}`)
    }
  }
  return out
}

/**
 * 追踪"哪些会话用过技能"。
 * 内存优先；未命中时**惰性扫一次使用记录**并缓存整个会话集合
 * —— 这样重启之后也能正确判断，而不是丢掉整个会话。
 */
export function makeSessionUsageTracker(usageFile, onWarn = () => {}) {
  const used = new Set()
  let loaded = false
  return {
    mark(sessionId) {
      if (sessionId) used.add(sessionId)
    },
    async has(sessionId) {
      if (!sessionId) return false
      if (used.has(sessionId)) return true
      if (!loaded) {
        loaded = true
        try {
          const raw = await fs.readFile(usageFile, 'utf8')
          for (const line of raw.split('\n')) {
            const t = line.trim()
            if (!t) continue
            try {
              const r = JSON.parse(t)
              if (r && typeof r.session === 'string') used.add(r.session)
            } catch {
              /* 坏行忽略：追踪器只关心有哪些会话 */
            }
          }
        } catch (e) {
          if (e.code !== 'ENOENT') onWarn(`读取使用记录以追踪会话失败：${e.message}`)
        }
      }
      return used.has(sessionId)
    },
  }
}

/**
 * 追踪"哪些会话被提供过技能"（用于「该用未用」通道）。
 * 与使用追踪器同样的惰性回填策略：重启后也认得。
 *
 * 为什么需要它：反馈通道的闸门是"本会话**用过**技能"，而「该用未用」恰恰只发生在
 * **没用过**技能的会话里 —— 若沿用同一个闸门，唯一的证据源就被关在门外了。
 * 所以这里用**另一个更宽的、但仍有界的**闸门：本会话**被提供过**技能。
 */
export function makeSessionOfferTracker({ offersFile, tasksFile, onWarn = () => {} }) {
  const offered = new Set()
  const taskCounts = new Map()
  let loaded = false

  async function load() {
    if (loaded) return
    loaded = true
    for (const [file, apply] of [
      [offersFile, (r) => { if (typeof r?.session === 'string') offered.add(r.session) }],
      [tasksFile, (r) => {
        if (typeof r?.session === 'string') taskCounts.set(r.session, (taskCounts.get(r.session) ?? 0) + 1)
      }],
    ]) {
      if (!file) continue
      try {
        const raw = await fs.readFile(file, 'utf8')
        for (const line of raw.split('\n')) {
          const t = line.trim()
          if (!t) continue
          try { apply(JSON.parse(t)) } catch { /* 坏行忽略：追踪器只关心集合 */ }
        }
      } catch (e) {
        if (e.code !== 'ENOENT') onWarn(`读取 ${path.basename(file)} 以追踪会话失败：${e.message}`)
      }
    }
  }

  return {
    /** 记一次技能目录投递（只记名单）。 */
    async recordOffering(sessionId, skills) {
      if (!sessionId) return
      offered.add(sessionId)
      await appendUserSignal(offersFile, { t: Date.now(), session: sessionId, skills: [...(skills || [])] })
    },
    async hasOffering(sessionId) {
      if (!sessionId) return false
      if (offered.has(sessionId)) return true
      await load()
      return offered.has(sessionId)
    },
    /** 本会话已记了多少条任务指纹（用于每会话上限）。 */
    async taskCount(sessionId) {
      if (!sessionId) return 0
      if (!taskCounts.has(sessionId)) await load()
      return taskCounts.get(sessionId) ?? 0
    },
    bumpTask(sessionId) {
      if (sessionId) taskCounts.set(sessionId, (taskCounts.get(sessionId) ?? 0) + 1)
    },
  }
}

/**
 * 构造 session/event 监听器。采纳 DSH 的约定：session/event 是**观察者**
 * （其抛错由宿主隔离并只记日志），所以这里不返回任何东西，也不抛错。
 *
 * ★ 必须按 source.kind 过滤：实测发现 DSH 会把**技能目录变更提醒**
 *   也作为 user/message 投递（source.kind = "skill-catalog"），每条 1~2 KB。
 *   若不滤掉，它们会挤满信号文件并污染归因（目录文本里恰好含有技能名）。
 *   采用**白名单**（只认 kind === 'user'）而非黑名单 —— 出现新的注入类型时，
 *   宁可漏掉一条信号，也不要放进噪声。
 *
 * 两种 kind 走**两条目的单一**的通道（互斥，不重复落盘）：
 *   · kind = "skill-catalog" → `skill-offers.jsonl`：只记**技能名单**（A）
 *   · kind = "user" 且本会话**用过**技能 → `user-signals.jsonl`：**全文**反馈候选（既有通道）
 *   · kind = "user" 且本会话**只被提供过**技能 → `session-tasks.jsonl`：**有界指纹**（B1）
 *   · 其余 → 不落盘
 */
export function makeUserSignalRecorder({
  signalsFile,
  tracker,
  offersFile,
  tasksFile,
  offerTracker,
  secretBlocksFile,
  onWarn = () => {},
}) {
  return async function recordUserSignal(session, event) {
    try {
      if (!event || event.type !== 'user/message') return
      const kind = event.data?.source?.kind
      const sessionId = session?.id ?? null
      if (!sessionId) return

      // —— A：技能目录被投递过（只记名单，不记正文）——
      if (kind === 'skill-catalog') {
        if (!offersFile || !offerTracker) return
        await offerTracker.recordOffering(sessionId, parseCatalogSkills(extractUserText(event.data)))
        return
      }

      if (kind !== 'user') return // 白名单：其余注入类型一律不落盘

      let text = extractUserText(event.data)
      if (!text) return // 纯附件/纯图片：没有可判断的文本

      // ★ 凭据卡口（信号通道）：策略 = **打码后落盘**，不是拒写。
      //   因为这里存的是**用户原话**，拒写会丢掉反馈；而密钥本身几乎不承载反馈含义。
      const hits = findSecrets(text)
      if (hits.length) {
        text = redactSecrets(text)
        await auditSecretBlock(secretBlocksFile, { where: 'signal-capture', hits, action: 'redacted' })
      }

      // —— 既有通道：本会话用过技能 → 全文反馈候选 ——
      if (tracker && (await tracker.has(sessionId))) {
        await appendUserSignal(signalsFile, { t: Date.now(), session: sessionId, source: kind, text })
        return
      }

      // —— B1：本会话只被提供过技能、一个都没用 → 有界任务指纹（供「该用未用」判定）——
      if (!tasksFile || !offerTracker) return
      if (!(await offerTracker.hasOffering(sessionId))) return
      const n = await offerTracker.taskCount(sessionId)
      if (n >= TASK_MAX_PER_SESSION) return
      await appendUserSignal(tasksFile, { t: Date.now(), session: sessionId, text: taskFingerprint(text) })
      offerTracker.bumpTask(sessionId)
    } catch (e) {
      onWarn(`记录用户信号失败：${e?.message || e}`)
    }
  }
}
