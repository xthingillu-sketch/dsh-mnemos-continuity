/**
 * dsh-mnemos 记忆存储（纯逻辑，无 DSH 依赖，可独立测试）。
 * 记忆是外部存储，不是上下文。
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { findSecrets, describeHits } from './secret-patterns.js'
import { defaultDataFile } from './paths.js'
import {
  acquireLock, releaseLock, mergeMemories, atomicWriteFile,
  readTombstones, mergeTombstones, capTombstones, writeTombstones,
  tombstonePathFor, lockPathFor, MAX_TOMBSTONES,
  DEFAULT_STALE_MS, DEFAULT_RETRIES, DEFAULT_BACKOFF_MS,
} from './store-lock.js'

export const SALIENCE_WEIGHT = { low: 1, normal: 2, high: 3 }

/** "会话存档型巨物"的体积阈值（detail 字符数 / tags 个数）——见 isArchiveLike 的注释。 */
const ARCHIVE_LIKE_DETAIL_CHARS = 20000
const ARCHIVE_LIKE_TAGS = 200
export const LAYERS = ['short', 'hot', 'cold', 'permanent']
export const SOURCES = ['internal', 'external', 'deprecated', 'dormant', 'validation', 'autobiography']
export const SALIENCES = ['low', 'normal', 'high']

/** 任务图的标签前缀（`task:<taskId>`）。**与归档闸门共用这一处**，别在别处硬编码字符串。 */
export const TASK_TAG_PREFIX = 'task:'
/** 标记"这是任务图本身"的标签。 */
export const TASK_GRAPH_TAG = 'task-graph'
/** 任务图未收尾的标签。收尾时把这条记录改成 `TASK_CLOSED_TAG`（唯一写者是主模型）。 */
export const TASK_OPEN_TAG = 'open'
export const TASK_CLOSED_TAG = 'closed'
/** 收尾时写出的"任务结论"记录的标签。 */
export const TASK_RESULT_TAG = 'task-result'
/** 任务过程中的临时中间结果（`scratch`）—— 收尾时**默认丢弃**。 */
export const TASK_SCRATCH_TAG = 'scratch'
/** 打了这个标签的 scratch 才在收尾时保留（并进长期结论）。 */
export const TASK_KEEP_TAG = 'keep'
/** 超时被机制强制归档的任务（长期结论与图都会带上它）。 */
export const TASK_EXPIRED_TAG = 'expired'
/**
 * 任务图最长保留多久（**没有任何进展**才算过期）：默认 **7 天**。
 *
 * 为什么需要它：图在收尾前受归档闸门保护 —— 如果会话崩了、图没收尾，那批记录会永远不被归档
 * （也删不掉），变成"孤儿任务图"。这是引入闸门时**新产生的悬空风险**，必须有回收。
 * 为什么不短一点：用户要求"尽量给任务图留长一点"，而且正常长任务会不断 update（刷新 lastActivityAt），
 * 所以只要还在推进就不会被误收；7 天是为了回收**真正被遗忘**的图。
 */
export const DEFAULT_TASK_OPEN_MAX_MS = 7 * 24 * 3600 * 1000
/** 分工允许的完成状态。 */
export const TASK_STATUSES = ['pending', 'done', 'partial', 'blocked']

/* ───────── V6-21：任务图的"任务档案"扩展（只存元数据，正文留在记忆里） ───────── */

/** 已完成里程碑的文字上限（代码强制，防止图膨胀）。 */
export const TASK_DONE_TEXT_MAX = 80
/** 依赖项 `why` 的字数上限。 */
export const TASK_USE_WHY_MAX = 80
/** 前序图 `why` 的字数上限（必填）。 */
export const TASK_LINK_WHY_MAX = 120
/** 依赖项条数上限（结构性上限，超了直接拒绝）。 */
export const TASK_USES_MAX = 30
/** 前序图条数上限。 */
export const TASK_LINKS_MAX = 5
/** 视图里最多渲染多少条已完成里程碑。 */
export const TASK_DONE_RENDER_MAX = 20
/** 标"重要结论"的标签（图读时据此派生，不复制正文）。 */
export const TASK_CONCLUSION_TAG = 'conclusion'
/** 前序图的关系类型（具体原因放 `why`）。 */
export const TASK_LINK_RELATIONS = ['continues', 'depends', 'supersedes', 'evidence', 'related']

/** 统一裁字：折叠空白、去首尾、超长截断；回执要能看出"截过"。 */
function clipText(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return { text: s, truncated: false }
  return { text: s.slice(0, max), truncated: true }
}

/**
 * 外部信息隔离验证记录（`source=validation`）的保留窗口 —— 超出即**销毁**（双条件都要满足）。
 * 为什么要有界：这类记录受归档闸门保护、永不进长期，不销毁就会无限堆积。
 * 50 条 ≈ 按当前节奏（约 1 条/天）够看三周多；7 天保证"刚验证完的结论"不会被清掉。
 */
export const DEFAULT_VALIDATION_KEEP_RECENT = 50
export const DEFAULT_VALIDATION_KEEP_MS = 7 * 24 * 3600 * 1000

/**
 * ★ 归档闸门（2026-10-17 加）：**哪些短时记录不许被任何自动归档路径吃掉**。
 *
 * 为什么必须在这里（存储层）而不是在提示词里：归档有三条入口 ——
 * `archiveSession`（`mnemos_consolidate` 走它）、心跳的 `archive_due`（按年龄）、
 * 心跳的 `archive_when_full`（按总量）。只拦一条等于没拦，而"按年龄/按总量"那两条
 * 是**无人值守自动跑**的，最容易把东西悄悄吃掉。
 *
 * 两类受保护：
 *   1. **外部信息隔离验证**（`source === 'validation'`）—— 它本来就是"只存短期、不转长期"，
 *      以前这句话只是**约定**（落 `layer='short'`，但没有任何闸门拦着归档），现在才是机制；
 *   2. **未收尾任务里的记录**（标签里带 `task:<taskId>`，且该 taskId 的任务图仍是 `open`）——
 *      子代理写的交接记忆要等主模型 `task_close` 之后才允许归档。
 *
 * @param {object} m 记忆记录
 * @param {Set<string>} openTaskIds 当前**未收尾**的任务 id 集合（见 collectOpenTaskIds）
 * @returns {boolean} true = 受保护，**不许归档**
 */
export function isArchiveProtected(m, openTaskIds = new Set()) {
  if (!m || m.layer !== 'short') return false
  if (m.source === 'validation') return true
  for (const tag of m.tags || []) {
    if (typeof tag !== 'string' || !tag.startsWith(TASK_TAG_PREFIX)) continue
    if (openTaskIds.has(tag.slice(TASK_TAG_PREFIX.length))) return true
  }
  return false
}

/**
 * 从记忆集合里收集**未收尾**的任务 id（任务图记录 = 带 `task-graph` + `open` + `task:<id>`）。
 * 图本身也是短时记录，所以它同样受保护（否则心跳会把图自己归档掉，闸门就失去了判据）。
 */
export function collectOpenTaskIds(memories) {
  const out = new Set()
  for (const m of memories || []) {
    const tags = m && Array.isArray(m.tags) ? m.tags : null
    if (!tags || !tags.includes(TASK_GRAPH_TAG) || !tags.includes(TASK_OPEN_TAG)) continue
    for (const tag of tags) {
      if (typeof tag === 'string' && tag.startsWith(TASK_TAG_PREFIX)) out.add(tag.slice(TASK_TAG_PREFIX.length))
    }
  }
  return out
}


// ★ 默认路径不在这里算 —— 唯一实现在 src/paths.js（profile 优先于 home）。
//   这里曾有一份 `DSH_HOME || cwd` 的本地副本，与脚本侧规则不一致 → F-3。

/** 墓碑表是否真的变了（变了才多写一次盘 —— 每次 save 都写会是纯开销）。 */
function tombstoneChanged(a, b) {
  const ka = Object.keys(a || {})
  const kb = Object.keys(b || {})
  if (ka.length !== kb.length) return true
  for (const k of kb) if (a[k] !== b[k]) return true
  return false
}

/**
 * 重读数据文件时**可重试**的错误码（F-16）。
 *
 * Windows 上别人正在 `rename` 覆盖同名文件的那一瞬间，`readFile` 会抛 EPERM/EACCES/EBUSY
 * （而**不是** ENOENT）。旧实现"非 ENOENT 一律抛出"→ 一次瞬时共享冲突就让整次保存失败
 * （`remember` 跟着失败，工具调用直接报错）。这不是"保护"，只是把瞬时冲突当成真损坏。
 * ★ 失败策略**没有放松**：只有这几种瞬时码才重试，重试耗尽照旧抛回调用者；
 *   JSON 解析失败（真损坏）依旧立刻抛。
 */
const RETRYABLE_READ_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const READ_RETRY_MS = [5, 15, 40]
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

export class MemoryStore {
  /**
   * @param {string} dataFile memory.json 路径
   * @param {object} [opts]
   * @param {(msg:string)=>void} [opts.onWarn] 跨进程锁告警出口（降级/抢锁/超时都走这里）
   * @param {number} [opts.lockStaleMs] 陈旧锁阈值（默认 30s）
   * @param {number} [opts.lockRetries] 抢锁重试次数（默认 5）
   * @param {number[]} [opts.lockBackoffMs] 每次重试前的退避（总时长控制在一秒内）
   * @param {number} [opts.maxTombstones] 墓碑上限（默认 2000）
   */
  constructor(dataFile, {
    onWarn = null,
    lockStaleMs = DEFAULT_STALE_MS,
    lockRetries = DEFAULT_RETRIES,
    lockBackoffMs = DEFAULT_BACKOFF_MS,
    maxTombstones = MAX_TOMBSTONES,
  } = {}) {
    this.dataFile = dataFile || defaultDataFile()
    this.memories = new Map()
    this.loaded = false   // ★ 是否已成功 load 完成（见 ensureLoaded）
    this.loading = null   // 进行中的 load promise（并发只跑一次）
    this.saveChain = Promise.resolve()  // ★ 写入串行化链（见 save）
    // ★ 跨进程写保护（见 store-lock.js）
    this.onWarn = typeof onWarn === 'function' ? onWarn : () => {}
    this.lockStaleMs = lockStaleMs
    this.lockRetries = lockRetries
    this.lockBackoffMs = lockBackoffMs
    this.maxTombstones = maxTombstones
    this.tombstones = new Map()  // id → deletedAt（硬删除的墓碑，合并时过滤）
    // ★ 合并基线（三方合并用）：load 那一刻每条记录的原样快照。
    //   为什么需要它（不能只按 recency 取大者）：recency **存在记录里**，
    //   于是"我读到的旧副本"与"别人刚改的新副本"在合并时无法区分谁更新 ——
    //   典型反例：B 读到 recency=T 的旧副本 → A 作废该条（remember 别条不改它）→
    //   B 一保存，按 recency 取大者反而是 B 的旧副本胜出 → **A 的作废被静默回滚**。
    //   有了基线就能判断"这一侧到底动没动过"，只有两侧都动过才需要靠 recency 裁决。
    this.baseline = new Map()    // id → JSON 串（用于判定"这一侧是否被改过"）
    // ★ V6-01：磁盘新鲜度签名（mtimeNs:size）与刷新计数。见 refreshFromDisk()。
    this.diskSig = null
    this.refreshStats = { checks: 0, reads: 0, skipped: 0, errors: 0 }
    this.lockStats = { acquired: 0, stolen: 0, degraded: 0 }  // 观测用（测试断言用）
  }

  get lockPath() { return lockPathFor(this.dataFile) }
  get tombstonePath() { return tombstonePathFor(this.dataFile) }

  /** 墓碑表的纯对象视图（测试/排查用）。 */
  tombstoneTable() {
    return Object.fromEntries([...this.tombstones.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
  }

  async load() {
    // 墓碑与数据一起读：否则别的进程删掉的记录会被本进程的旧副本重新合并回来。
    // 墓碑读不出来不阻塞 load（readTombstones 内部已兜住）。
    const tombs = await readTombstones(this.dataFile)
    this.tombstones = new Map(Object.entries(tombs))
    // ★ V6-01：用"前后签名一致"的快照读法（文件不存在时返回空数组，不再靠 ENOENT 分支）。
    const snap = await this._readMemorySnapshot()
    for (const m of snap.arr) {
      if (m && typeof m.id === 'string') this.memories.set(m.id, m)
    }
    // ★ 磁盘上的墓碑同样要应用（别的进程删过、但本进程的 memory.json 副本还没跟上时）
    this.applyTombstones()
    this.loaded = true
    this.diskSig = snap.sig
    this.recordBaseline()
  }

  /** 磁盘文件的新鲜度签名（mtimeNs + size）。文件不存在 → 'absent'。 */
  async _statSig() {
    try {
      const st = await fs.stat(this.dataFile, { bigint: true })
      return `${st.mtimeNs}:${st.size}`
    } catch (e) {
      if (e && e.code === 'ENOENT') return 'absent'
      throw e
    }
  }

  /**
   * 读一份"前后签名一致"的磁盘快照。
   *
   * 为什么不是一次 readFile：读的窗口里别的实例可能刚 rename 了新文件 —— 那样读到的内容
   * 与"记下来的签名"会错位，下一次刷新就会拿一个更新的签名去跳过本应发生的读取。
   * 返回 { sig, arr }；文件不存在 → { sig:'absent', arr: [] }。
   */
  async _readMemorySnapshot() {
    let lastErr = null
    for (let round = 0; round < 3; round++) {
      const sig = await this._statSig()
      if (sig === 'absent') return { sig, arr: [] }
      let raw = null
      for (let attempt = 0; attempt <= READ_RETRY_MS.length; attempt++) {
        try {
          raw = await fs.readFile(this.dataFile, 'utf8')
          lastErr = null
          break
        } catch (e) {
          lastErr = e
          if (e && e.code === 'ENOENT') return { sig: 'absent', arr: [] }
          if (!RETRYABLE_READ_CODES.has(e && e.code) || attempt === READ_RETRY_MS.length) break
          await sleepMs(READ_RETRY_MS[attempt])
        }
      }
      if (lastErr) throw lastErr
      const after = await this._statSig()
      if (after !== sig) continue // 读的期间被改过 → 重来一轮
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr)) throw new Error('mnemos: memory file is not an array')
      return { sig, arr }
    }
    throw new Error('mnemos: memory file keeps changing while reading')
  }

  /** 记下"我刚从磁盘读到的原样"，供 writeToDisk 的三方合并判断哪一侧改动过。 */
  recordBaseline() {
    this.baseline = new Map()
    for (const [id, m] of this.memories) this.baseline.set(id, JSON.stringify(m))
  }

  /** 按墓碑过滤内存视图（不删磁盘 —— 磁盘上的过滤在 writeToDisk/合并时做）。 */
  applyTombstones() {
    let removed = 0
    for (const id of this.tombstones.keys()) {
      if (this.memories.delete(id)) removed++
    }
    return removed
  }

  /**
   * ★ 幂等：**所有写入路径**都必须先 await 它。
   *
   * 为什么：`save()` 是**全量重写**。若在 `load()` 完成前就写入，`this.memories` 里只有刚写的那一条，
   * 一存盘就把整个 memory.json 覆盖成一条 —— **静默丢掉全部历史**。
   * （已复现：写入 3 条 → 新建 store 不 load → remember 1 条 → 文件只剩 1 条。）
   * 并发时共用一个 promise，只真正 load 一次。
   */
  async ensureLoaded() {
    if (this.loaded) return
    if (!this.loading) this.loading = this.load()
    try {
      await this.loading
    } finally {
      this.loading = null
    }
  }

  /**
   * ★ V6-01：把磁盘上**别的实例**写入的变化合并进内存（只读，不写盘）。
   *
   * 为什么需要它：`ensureLoaded()` 只加载一次；而 `save()` 只在"本地确实有变化"时才发生。
   * 于是桌面端空闲时，网页端写入的记录既看不到、也不会被归档（归档要先"看到"才会觉得有活干）——
   * 形成一个环：可见性依赖写盘，写盘又依赖"觉得有活干"。
   *
   * 调用点（两处，都是读路径）：
   *   · 心跳开始处：先刷新再跑维护任务（归档就能看到别的实例写的短时记录）；
   *   · `mnemos_recall` / `mnemos_open` 工具入口：让跨端读写不依赖"本端恰好写过一次盘"。
   *
   * 串到 `saveChain` 上：避免与正在落盘的 save 交错（save 自己会 re-read 并三方合并）。
   * 幂等：文件签名没变时只做一次 stat，不读文件。
   */
  async refreshFromDisk() {
    await this.ensureLoaded()
    const run = this.saveChain.then(() => this._refreshFromDiskInner())
    this.saveChain = run.then(() => {}, () => {})
    return run
  }

  async _refreshFromDiskInner() {
    this.refreshStats.checks += 1
    let snap
    try {
      snap = await this._readMemorySnapshot()
    } catch (e) {
      this.refreshStats.errors += 1
      // 读失败**保留内存现状**（不清空、不覆盖），下次再试。
      this.onWarn(`[mnemos-refresh] 读磁盘失败，保留内存现状：${e?.message || e}`)
      return { ok: false, refreshed: false, error: String(e?.message || e) }
    }
    if (snap.sig === this.diskSig) {
      this.refreshStats.skipped += 1
      return { ok: true, refreshed: false }
    }
    this.refreshStats.reads += 1
    const before = new Set(this.memories.keys())
    // 墓碑与数据一起合并：别的实例删掉的记录不许被本进程的旧副本复活。
    const diskTombs = await readTombstones(this.dataFile)
    const union = mergeTombstones(Object.fromEntries(this.tombstones), diskTombs)
    const capped = capTombstones(union, this.maxTombstones)
    this.tombstones = new Map(Object.entries(capped.table))
    const merged = mergeMemories(this.memories, snap.arr, this.baseline)
    let tombstoned = 0
    for (const id of this.tombstones.keys()) if (merged.delete(id)) tombstoned++
    let added = 0
    for (const id of merged.keys()) if (!before.has(id)) added++
    this.memories = merged
    // 基线更新为"刚合并进来的这份"：下一次 save 的三方合并才判断得准。
    this.recordBaseline()
    this.diskSig = snap.sig
    return { ok: true, refreshed: true, added, tombstoned, total: this.memories.size }
  }

  /**
   * ★ 全量重写 + **串行化**（一次只有一个 writeFile 在跑）+ **跨进程锁**。
   *
   * 为什么必须串行（实测竞态，不是理论洁癖）：`JSON.stringify([...this.memories.values()])`
   * 是在**调用那一刻**同步取值的，落盘却是异步的。两个写者并发时：
   *   A 先取值（还没有 B 的记录）→ B 后取值（含 A+B）并落盘 → **A 的落盘更晚**
   *   → 磁盘上只剩 A 的内容，**B 的记录静默丢失**（内存里却还在，直到下次重载才发现）。
   * 宿主折叠事件触发的异步写者（compaction-snapshot）让这个竞态比以前更容易撞上。
   *
   * 做法：所有写入排在一条 promise 链上，**后一次一定在前一次落盘之后才开始取值**，
   * 因此最后落盘的那次必然包含此前全部记录。
   *
   * 错误语义（两条都要）：
   *   · 链上**吞掉**错误 —— 一次失败不许让后续所有保存都 reject；
   *   · 但**本次调用者**要收到该错误 —— 所以 `return` 的是未吞错的 promise。
   *
   * 注：temp+rename（原子替换）只保证文件不被写坏，**不保证不丢记录**
   * （A 的旧内容仍会覆盖 B 的新内容），因此它不能替代串行化。
   *
   * ★ 跨进程（本轮新增）：saveChain 只管得住**本进程**。
   *   两个 DSH 实例共用 DSH_HOME 时各持一份内存副本，链是各跑各的 → 仍然会互相覆盖。
   *   因此每次落盘都在 `store-lock.js` 的跨进程锁内做「re-read + 按 id 合并 + 墓碑过滤」，
   *   详见 writeToDisk 与 store-lock.js 顶部的说明。
   */
  save() {
    const run = this.saveChain.then(() => this.writeToDisk())
    this.saveChain = run.then(() => {}, () => {})
    return run
  }

  /**
   * 真正落盘的那一步（只被 save 的串行链调用；单独抽出来是为了让"取值→写盘"整段都在链内）。
   *
   * 跨进程临界区（顺序不能变）：
   *   lock() → fresh = 读磁盘 → 按 id **三方合并** → 应用墓碑 → 原子写 → unlock()
   *
   * **re-read 是这一步的核心**：不加它，即使有锁，本进程内存里那份旧副本
   * （等锁期间别的进程刚写进去的记录它根本没有）照样会把别人的新记录覆盖掉 —— 加了锁也白加。
   * 合并规则见 store-lock.js 的 mergeMemories（不是"按 recency 取大者"，
   * 而是用 load 时的基线判断哪一侧真被改过；纯按 recency 会把别人的作废/衰减回滚掉）。
   */
  async writeToDisk() {
    await fs.mkdir(path.dirname(this.dataFile), { recursive: true })
    const lock = await acquireLock(this.dataFile, {
      staleMs: this.lockStaleMs,
      retries: this.lockRetries,
      backoffMs: this.lockBackoffMs,
      onWarn: this.onWarn,
    })
    if (lock.ok) {
      this.lockStats.acquired++
      if (lock.stale) this.lockStats.stolen++
    } else {
      // ★ fail-open：拿不到锁也照旧写。
      //   理由是**错的代价不对称**：极小的覆盖概率 vs "记忆根本写不进去"（后者损失更大）。
      this.lockStats.degraded++
      if (lock.reason === 'timeout') {
        const who = lock.heldBy ? `pid ${lock.heldBy.pid}@${lock.heldBy.host}` : '持有者不可读'
        this.onWarn(
          `[mnemos-lock] 抢锁超时（重试 ${this.lockRetries} 次 / 约 ${lock.waitedMs}ms，持有者=${who}），` +
          `降级为无锁写入：可能存在极小概率的覆盖风险，但不会让本次记忆写不进去。`
        )
      }
    }

    try {
      // ── ① re-read 磁盘（可能已被别的进程更新过）──
      // ★ F-16：读也会**瞬时**失败（见 RETRYABLE_READ_CODES）。有界重试，失败策略不变。
      let freshArr = []
      {
        let lastErr = null
        for (let attempt = 0; attempt <= READ_RETRY_MS.length; attempt++) {
          try {
            const raw = await fs.readFile(this.dataFile, 'utf8')
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) freshArr = parsed
            lastErr = null
            break
          } catch (e) {
            lastErr = e
            if (e && e.code === 'ENOENT') { freshArr = []; lastErr = null; break } // 文件不存在（首次写）
            if (!RETRYABLE_READ_CODES.has(e && e.code) || attempt === READ_RETRY_MS.length) break
            await sleepMs(READ_RETRY_MS[attempt])
          }
        }
        if (lastErr) throw lastErr
      }

      // ── ② 按 id 合并（三方：用 load 时的基线判断哪一侧真被改过）──
      let merged = mergeMemories(this.memories, freshArr, this.baseline)

      // ── ③ 墓碑：磁盘上已有的 + 本进程刚记的，合并后过滤掉这些 id ──
      const diskTombs = await readTombstones(this.dataFile)
      const union = mergeTombstones(Object.fromEntries(this.tombstones), diskTombs)
      const capped = capTombstones(union, this.maxTombstones)
      if (capped.evicted > 0) {
        this.onWarn(`[mnemos-lock] 墓碑超过上限 ${this.maxTombstones}，已淘汰最旧的 ${capped.evicted} 条`)
      }
      this.tombstones = new Map(Object.entries(capped.table))
      for (const id of this.tombstones.keys()) merged.delete(id)

      const before = this.memories.size
      this.memories = merged
      if (merged.size < before) {
        // 只可能是墓碑过滤导致的减少（合并不会减条目）
        this.onWarn(`[mnemos-lock] 合并时按墓碑过滤掉 ${before - merged.size} 条已删除记录`)
      }

      // ── ④ 落盘：先 .tmp 再 rename（原子替换，不会留下半个文件）──
      const arr = [...this.memories.values()]
      await atomicWriteFile(this.dataFile, JSON.stringify(arr, null, 2))
      // ★ 在**持锁期间**记签名：别的实例要写也得先拿锁，不会出现"签名其实是别人的"这种错位。
      this.diskSig = await this._statSig().catch(() => null)
      // ★ 基线更新为"刚合并并落盘的这份"：下一次 save 才判断得准
      this.recordBaseline()

      // 墓碑表与数据分开落盘；只有真的变过才写，避免每次 save 都多一次写盘
      if (tombstoneChanged(diskTombs, capped.table)) {
        await writeTombstones(this.dataFile, capped.table)
      }
    } finally {
      if (lock.ok) await releaseLock(this.dataFile)
    }
  }

  async remember({ content, summary, tags, taskId, salience, source, sessionId, supersedes }) {
    await this.ensureLoaded()
    // ★ 凭据卡口（写入收口）：记忆是**跨会话共享 + 会被反复召回**的明文文件，
    //   一个 key 进了记忆会在每次相关会话里被注入上下文，比一次性泄露更糟。
    //   策略 = **拒写**（模型可以改写后重试，所以无损）；错误信息里**不含命中内容**。
    const hits = findSecrets(`${summary || ''}\n${content || ''}`)
    if (hits.length) {
      throw new Error(
        `拒绝写入记忆：内容里疑似含凭据（命中模式：${describeHits(hits)}）。` +
        `记忆体是跨会话明文存储且会被反复召回，因此不落盘。` +
        `请移除该段内容后重试；若它是占位符或示例，请改用明显不可用的形式（如 <YOUR_KEY>）。`
      )
    }
    const id = randomUUID()
    const now = Date.now()
    // 「暂时无关」是**会话级判断**，不是记忆的来源，因此不写进 source：
    // source 只表示真实来源（internal/external/validation/autobiography）。
    // 若把它写成 source='dormant'，标记会随一次次记录永久累积，
    // 最终几乎所有条目都成了 dormant —— 降权也就等于没有了。
    // 它记在 dormIn（会话 id 列表）里：只在该会话内降权，换个会话自然失效。
    const wantDormant = source === 'dormant'
    // ★ F-5：`source='dormant'` 但**没有 sessionId** 时，dormIn 只能是空数组 ——
    //   即"降权"完全没发生。旧代码此时**回执照样说「已写入」**（最隐蔽的一处谎报）。
    //   选择（见交付说明）：**如实回执 + 按普通内部记忆存储**，不用哨兵值伪造作用域。
    //   理由：dormant 的语义是"只在本会话让位"，它必须以**真实会话 id** 为作用域；
    //   拿 '__unassigned__' 之类的哨兵当作用域，会把所有"无会话"记忆在一次标记里
    //   一起降权（越积越多），且换会话也失效不了 —— 正好是 dormant 当初被修掉的病。
    const dormantUnscoped = wantDormant && !sessionId
    const rec = {
      id,
      taskId: taskId || null,
      tags: Array.isArray(tags) ? tags.map(String) : [],
      summary: summary || '',
      detail: content || '',
      layer: source === 'autobiography' ? 'permanent' : 'short',
      salience: SALIENCES.includes(salience) ? salience : 'normal',
      recency: now,
      createdAt: now,
      version: 1,
      source: SOURCES.includes(source) && source !== 'dormant' ? source : 'internal',
      dormIn: wantDormant && sessionId ? [sessionId] : [],
      sessionId: sessionId || null,
    }
    if (dormantUnscoped) rec.dormantUnscoped = true // 回执要如实说出来（不许静默）
    if (taskId) {
      // ★ V6-21：只有"存在 open 图 + 调用者就是创建者会话"时才自动补 task 标签。
      //   `taskId` 同时是通用分组（生产里 125 条字段-only 并不是图），不能一概打标签。
      const g = this.findOpenTask(taskId)
      if (g && sessionId && g.sessionId === sessionId) {
        const t = `${TASK_TAG_PREFIX}${taskId}`
        if (!rec.tags.includes(t)) rec.tags.push(t)
      }
    }
    this.memories.set(id, rec)
    // 「写纠正 + 作废旧条」必须在同一个动作里完成：
    // 否则只新建一条纠正、旧结论仍以原 source 被召回，记忆库会同时存在互相矛盾的结论。
    const superseded = supersedes ? this.applyDeprecation(supersedes, id) : []
    if (superseded.length) rec.superseded = superseded
    await this.save()
    return rec
  }

  /**
   * 把一组记忆标记为 deprecated（已证伪废弃；recall 会自动过滤，不再召回）。
   * 只改 source，不删除 —— 对应「废弃 = 降权，不是删除」。
   * @param {string[]|string} ids 要作废的记忆 id
   * @param {string|null} supersededBy 取代它们的新记忆 id；可空，表示仅作废无替代
   * @returns {Array<{id:string, ok:boolean, already?:boolean, from?:string, reason?:string, summary?:string}>}
   */
  applyDeprecation(ids, supersededBy = null) {
    const list = Array.isArray(ids) ? ids : [ids]
    const done = []
    for (const raw of list) {
      const tid = String(raw == null ? '' : raw).trim()
      if (!tid) continue
      const target = this.memories.get(tid)
      if (!target) {
        done.push({ id: tid, ok: false, reason: 'not-found' })
        continue
      }
      if (supersededBy && target.id === supersededBy) {
        done.push({ id: tid, ok: false, reason: 'self' })
        continue
      }
      if (target.source === 'deprecated') {
        done.push({ id: tid, ok: true, already: true })
        continue
      }
      const prev = target.source
      target.source = 'deprecated'
      target.supersededBy = supersededBy || null
      target.deprecatedAt = Date.now()
      target.version = (target.version || 1) + 1
      done.push({ id: tid, ok: true, from: prev, summary: target.summary })
    }
    return done
  }

  /**
   * 独立作废入口：用于「没有新结论要写，只想作废某条旧结论」的场景。
   */
  async deprecate(ids, { supersededBy = null, reason = null } = {}) {
    await this.ensureLoaded()
    const done = this.applyDeprecation(ids, supersededBy)
    if (reason) {
      for (const d of done) {
        if (!d.ok) continue
        const m = this.memories.get(d.id)
        if (m) m.deprecatedReason = String(reason)
      }
    }
    if (done.some((d) => d.ok && !d.already) || reason) await this.save()
    return done
  }

  /**
   * 把一组已有记忆标记为「本会话内暂时无关」：降权，不隐藏、不删除。
   * 与 deprecated 的关键区别：这是**会话级判断**，只往 dormIn 追加当前会话 id，
   * source（真实来源）保持不变；换一个会话标记自动失效，因此不会越积越多。
   * @param {string[]|string} ids 要标记的记忆 id
   * @param {string|null} sessionId 当前会话 id；为空则无法作用域化，拒绝写入
   * @param {string|null} reason 可选，仅作记录
   */
  async markDormant(ids, sessionId, reason = null) {
    await this.ensureLoaded()
    const list = Array.isArray(ids) ? ids : [ids]
    const sid = sessionId ? String(sessionId) : null
    const done = []
    for (const raw of list) {
      const tid = String(raw == null ? '' : raw).trim()
      if (!tid) continue
      const target = this.memories.get(tid)
      if (!target) {
        done.push({ id: tid, ok: false, reason: 'not-found' })
        continue
      }
      if (target.source === 'deprecated') {
        done.push({ id: tid, ok: false, reason: 'deprecated' })
        continue
      }
      if (!sid) {
        done.push({ id: tid, ok: false, reason: 'no-session' })
        continue
      }
      if (!Array.isArray(target.dormIn)) target.dormIn = []
      if (target.dormIn.includes(sid)) {
        done.push({ id: tid, ok: true, already: true, summary: target.summary })
        continue
      }
      target.dormIn.push(sid)
      if (reason) target.dormReason = String(reason)
      target.version = (target.version || 1) + 1
      done.push({ id: tid, ok: true, sessionId: sid, summary: target.summary })
    }
    if (done.some((d) => d.ok && !d.already)) await this.save()
    return done
  }

  /**
   * 取消「本会话内暂时无关」标记（撤销误标/判断变了）。
   * 只从 dormIn 移除当前会话，不动 source，也不影响其它会话的标记。
   */
  async unmarkDormant(ids, sessionId) {
    await this.ensureLoaded()
    const list = Array.isArray(ids) ? ids : [ids]
    const sid = sessionId ? String(sessionId) : null
    const done = []
    for (const raw of list) {
      const tid = String(raw == null ? '' : raw).trim()
      if (!tid) continue
      const target = this.memories.get(tid)
      if (!target) {
        done.push({ id: tid, ok: false, reason: 'not-found' })
        continue
      }
      if (!sid || !Array.isArray(target.dormIn) || !target.dormIn.includes(sid)) {
        done.push({ id: tid, ok: false, reason: 'not-marked' })
        continue
      }
      target.dormIn = target.dormIn.filter((s) => s !== sid)
      target.version = (target.version || 1) + 1
      done.push({ id: tid, ok: true, summary: target.summary })
    }
    if (done.some((d) => d.ok)) await this.save()
    return done
  }

  /**
   * 写时冲突提示：找出与「即将写入的这条」可能冲突的现存记忆，供工具回给模型一句提醒。
   * 判定保守（宁可少报也不刷屏）：标签 Jaccard 重叠 >= minOverlap，
   * 且排除已废弃记录与自身；若给了 taskId，则只在本任务内比较。
   */
  findConflicts({ taskId, tags, excludeId, minOverlap = 0.6, limit = 3 } = {}) {
    const newTags = new Set((Array.isArray(tags) ? tags : []).map(String))
    if (newTags.size === 0) return []
    const hits = []
    for (const m of this.memories.values()) {
      if (m.id === excludeId) continue
      if (m.source === 'deprecated') continue
      if (taskId && m.taskId && m.taskId !== taskId) continue
      const old = new Set(m.tags || [])
      if (old.size === 0) continue
      const inter = [...newTags].filter((t) => old.has(t)).length
      const union = new Set([...newTags, ...old]).size
      const overlap = union === 0 ? 0 : inter / union
      if (overlap >= minOverlap) {
        hits.push({
          id: m.id,
          summary: m.summary,
          salience: m.salience,
          overlap: Number(overlap.toFixed(2)),
        })
      }
    }
    hits.sort((a, b) => b.overlap - a.overlap)
    return hits.slice(0, limit)
  }

  tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .split(/[^\w\u4e00-\u9fff]+/)
      .filter(Boolean)
  }

  /**
   * 这条记忆是不是"会话存档型巨物"（归档时把一大堆短时压成一条的产物）。
   *
   * 为什么需要单独认它（2026-10-18，用户提出）：这种记录**有存在价值** ——
   * 它是"整个会话的存档"，需要时应该还在。但它有几个特性会**系统性地抬高它的召回排名**：
   *   ① 全文当检索面：summary 8.7K 字符、detail 86K、tags 440 个 → 关键词命中数天然比小记录多；
   *   ② 它的每个 tag 都同时挂在别的记录上（实测"专属 tag = 0"）→ 不提供任何新入口，只是重复占位；
   *   ③ 召回要把它 8.7K 字符的 summary 整条带进上下文 → 每次命中都白付一次钱。
   * 所以：**不删它、不改它**，默认把它挡在召回之外（`includeArchives:true` 才放回），
   * 需要看时用 `open(id)` 或显式标签查 —— 错召回一次就会吃掉大量上下文。
   *
   * 判定用"体积/标记"这种可机械核对的量，不靠语义：
   *   - 显式标记 `archiveOf` 或 tag `session-archive`（新归档会打）
   *   - 历史存档（标记是后加的，按体积兜底：detail ≥ 20K 字符 或 tags ≥ 200）
   */
  isArchiveLike(m) {
    if (!m) return false
    if (m.archiveOf) return true
    const tags = m.tags || []
    if (tags.includes('session-archive')) return true
    return String(m.detail || '').length >= ARCHIVE_LIKE_DETAIL_CHARS || tags.length >= ARCHIVE_LIKE_TAGS
  }

  recall({ query, tags, taskId, sessionId, mode, limit, includeArchives = false }) {
    let list = [...this.memories.values()]
    list = list.filter((m) => m.source !== 'deprecated') // 废弃的错误内容不召回
    // ★ V6-21 P2：会话存档默认不进召回（存档是给人回看的快照，不是模型查询入口）。
    if (!includeArchives) list = list.filter((m) => !this.isArchiveLike(m))
    if (taskId) {
      const tag = `${TASK_TAG_PREFIX}${taskId}`
      list = list.filter((m) => m.taskId === taskId || (m.tags || []).includes(tag))
    }
    if (tags && tags.length) {
      list = list.filter((m) => tags.every((t) => (m.tags || []).includes(t)))
    }

    // 每记忆算四个分：关键词 / 会话亲和 / 来源（dormant 降权）/ 分层
    const scored = list.map((m) => {
      let keywordScore = 0
      if (query) {
        const q = String(query).toLowerCase()
        const tokens = this.tokenize(query)
        const hay = `${m.summary} ${(m.detail || '')} ${(m.tags || []).join(' ')}`.toLowerCase()
        if (q && hay.includes(q)) keywordScore += 20
        for (const t of tokens) if (t && hay.includes(t)) keywordScore += 2
      }
      const sessionScore = sessionId && m.sessionId === sessionId ? 2 : 0
      // 「暂时无关」是会话级判断，只降权、绝不过滤：本会话内标记过=0，否则=1。
      // 它排在「关键词」「会话亲和」之后、「分层」「重要性」之前，因此只在同等相关时让位；
      // 若它比别的更相关，仍会排在前面——原始判断无关、执行中却要用到时依然召得回。
      // 换到别的会话时 dormIn 里没有它，降权自然失效，不会永久累积。
      const dormantHere = !!(sessionId && Array.isArray(m.dormIn) && m.dormIn.includes(sessionId))
      const sourceScore = dormantHere ? 0 : 1
      const layerScore = m.layer === 'short' ? 2 : m.layer === 'hot' ? 1 : 0
      // ★ 会话存档型巨物：**降权但不过滤**。关键词分先打 1/4 —— 因为它把 8.7K summary +
      //   86K detail + 440 tags 全当检索面，命中数天然虚高；不打折就会把小记录挤掉。
      const archiveLike = this.isArchiveLike(m)
      const archivePenalty = archiveLike ? 1 : 0
      const effKeyword = archiveLike ? Math.floor(keywordScore / 4) : keywordScore
      const effSession = archiveLike ? 0 : sessionScore
      return { m, keywordScore: effKeyword, sessionScore: effSession, sourceScore, layerScore, archivePenalty }
    })

    const bySession = mode === 'session'
    // mode='keyword'（默认）：有关键词匹配就只返回匹配的；无匹配则保留全部（session 亲和兜底）
    // 注意：dormant 不参与这里的过滤，只是排序靠后——保证它永远还有机会被召回。
    let filtered = scored
    if (!bySession) {
      const hasMatch = scored.some((x) => x.keywordScore > 0)
      if (hasMatch) filtered = scored.filter((x) => x.keywordScore > 0)
    }
    filtered.sort((a, b) => {
      const session = b.sessionScore - a.sessionScore
      const keyword = b.keywordScore - a.keywordScore
      const source = b.sourceScore - a.sourceScore
      const layer = b.layerScore - a.layerScore
      const salience = (SALIENCE_WEIGHT[b.m.salience] || 2) - (SALIENCE_WEIGHT[a.m.salience] || 2)
      const recency = b.m.recency - a.m.recency
      // 前两位是「谁更相关」：默认关键词优先再会话，session 模式反之。
      // 其后全是「同等条件下让位」：dormant 降权 → 分层 → 重要性 → 新旧。
      // archivePenalty：非存档=0、存档=1 → 排序时非存档（0）优先。放在"都更相关"之后，
      // 所以它只在**同等相关**时让位；比别的记录更相关时仍然排前面（降权不是封杀）。
      const archive = a.archivePenalty - b.archivePenalty
      return bySession
        ? session || keyword || source || archive || layer || salience || recency
        : keyword || session || source || archive || layer || salience || recency
    })

    const n = Math.max(1, Math.min(limit || 5, 50))
    // 召回阶段只返回摘要，不返回 detail（两段式第一段）
    return filtered.slice(0, n).map((x) => x.m).map((m) => ({
      id: m.id,
      summary: m.summary,
      tags: m.tags,
      taskId: m.taskId,
      salience: m.salience,
      layer: m.layer,
      source: m.source,
      dormantHere: !!(sessionId && Array.isArray(m.dormIn) && m.dormIn.includes(sessionId)),
      sessionId: m.sessionId ?? null,
      createdAt: m.createdAt,
    }))
  }

  async open(id) {
    const m = this.memories.get(id)
    if (!m) return null
    m.recency = Date.now()
    await this.save()
    // ★ V6-21：任务图 open 返回**读时投影**（不写回 detail，避免副本与陈旧）。
    if ((m.tags || []).includes(TASK_GRAPH_TAG) && m.task) {
      const brief = this.renderTaskBrief(m.task.id)
      if (brief) return { ...m, detail: brief }
    }
    return m
  }

  async delete(id) {
    await this.ensureLoaded()
    // 真删除：从存储中移除（不可恢复）。
    const m = this.memories.get(id)
    if (!m) return null
    this.memories.delete(id)
    // ★ 墓碑（跨进程必需）：delete 是**硬删除**，磁盘上那条记录的消失本身不是"信息" ——
    //   别的进程内存里仍留着它的旧副本，下次保存时会连同它一起全量重写回来（"复活"）。
    //   墓碑就是这次删除的**事实**：合并时按墓碑过滤，旧副本就复活不了。
    //   deprecate 是软删除（改 source）→ 记录仍在，走正常合并即可，不需要墓碑。
    this.tombstones.set(id, Date.now())
    await this.save()
    return [m]
  }

  async consolidate(taskId, newSummary) {
    await this.ensureLoaded()
    const group = [...this.memories.values()].filter(
      (m) => m.taskId === taskId && m.layer !== 'permanent'
    )
    if (group.length === 0) return null
    const summary =
      newSummary || group.map((m) => m.summary).filter(Boolean).join('；')
    const detail = group
      .map((m) => `[${m.id} v${m.version}] ${m.detail || ''}`)
      .join('\n\n')
    const tags = [...new Set(group.flatMap((m) => m.tags || []))]
    const maxWeight = group.reduce(
      (a, m) => Math.max(a, SALIENCE_WEIGHT[m.salience] || 2),
      0
    )
    const salience =
      Object.keys(SALIENCE_WEIGHT).find((k) => SALIENCE_WEIGHT[k] === maxWeight) || 'normal'
    const now = Date.now()
    const consolidated = {
      id: randomUUID(),
      taskId,
      tags,
      summary,
      detail,
      layer: 'hot',
      salience,
      recency: now,
      createdAt: now,
      version: 1,
      source: 'internal',
    }
    // 原始记录降为冷存储、版本递增（保留，不删除）
    for (const m of group) {
      m.layer = 'cold'
      m.version += 1
    }
    this.memories.set(consolidated.id, consolidated)
    await this.save()
    return consolidated
  }

  shortBySession() {
    // 短时记忆按会话框（sessionId）分组
    const bySession = new Map()
    for (const m of this.memories.values()) {
      if (m.layer !== 'short') continue
      if (m.source === 'validation') continue // 验证结果不归档（临时交接）
      const sid = m.sessionId || '__unassigned__'
      if (!bySession.has(sid)) bySession.set(sid, [])
      bySession.get(sid).push(m)
    }
    return bySession
  }

  autobiographyEntries() {
    // 自传体完整版（permanent 层，source=autobiography）
    return [...this.memories.values()].filter((m) => m.source === 'autobiography')
  }

  /** 取某个隔离验证会话写过的那条验证结论（最新一条；没有就 null）。
   *
   * 为什么需要它：新宿主（0.2.x）把 subagents 的"一次调用拿结果"改成了异步激活 ——
   * 验证子代理的结论没法再从返回值里拿。于是改成"子代理自己写进记忆 → 父会话按 sessionId 取回"。
   * 只认 `source='validation'`：这样不会误取子代理顺手写的其它记忆。
   */
  validationBySession(sessionId) {
    if (!sessionId) return null
    let best = null
    for (const m of this.memories.values()) {
      if (m.source !== 'validation' || m.sessionId !== sessionId) continue
      if (!best || (m.createdAt || 0) > (best.createdAt || 0)) best = m
    }
    return best
  }

  /**
   * 自传体紧凑版：按类目给出摘要，受**字符预算**约束。
   *
   * 类目与优先级（高→低）：决策 decision > 能力 ability > 事件 event > 其他。
   * 「其他」是 F-4 的**代码兜底**：permanent 层但**没带**这三类标签的条目
   * 以前被**静默丢弃**（无计数无告警；实测现行库 10 条永久层里有 1 条永不注入）。
   * 现在按 recency 排进「其他」，同样受预算约束 —— 不再消失。
   *
   * ★ 三条规则（F-6 / F-7，都是拿真实数据换来的）：
   *   ① 某条放不下时**跳过它继续试下一条**（`continue`，不是 `break`）——
   *      以前一条超长 summary 会让它后面**本可以放得下的小条目**全部被放弃。
   *   ② 每个**出现过的**类目先拿一份**保底配额**（floor），再按优先级分剩余预算 ——
   *      否则决策能 100% 占满预算，能力/事件即使存在也永远拿不到一个字。
   *      「出现过的」是关键：空类目不占额度，预算不会被浪费在没人排队的窗口上。
   *   ③ 装不下就跳过，`used` 永远不会被任何一条撑破预算。
   *
   * ⑨ 「其他」是兜底，**排在最后**（优先级最低）。注意**实际行为**：floor 是对 `CATS` 里
   *     **每个非空类目**发的，`other` 也在其中 —— 所以「其他」非空时**同样**拿到那份保底配额，
   *     只是它的条目永远排在最后竞争剩余预算。这条注释以前写成"没有保底配额"，**与实现不符**
   *     （2026-10-17 千问评审在文档里抓到同一句，回头核对源码才发现注释先错、文档跟着抄）。
   *     若以后真要让它零配额，改这里的同时必须改 CATS/floor 分配并补测试 —— 别只改注释。
   *
   * @param {{budget?:number, floorRatio?:number, floorMin?:number}} [o]
   * @returns {{entries:{category:string,label:string,summary:string}[],
   *            used:number, budget:number, unselected:number,
   *            unselectedByCategory:{ability:number,event:number,other:number}}}
   *   `unselected` 与 `unselectedByCategory` 是**实数**（F-12 那一行要用真值，不许"可能还有"）。
   */
  autobiographyCompact({ budget = 2000, floorRatio = 0.15, floorMin = 200 } = {}) {
    // 类目定义。`other` 是兜底类目：只要带了三类标签里**任意一个**就不算其他。
    const CATS = [
      { key: 'decision', label: '决策', tag: 'decision' },
      { key: 'ability', label: '能力', tag: 'ability' },
      { key: 'event', label: '事件', tag: 'event' },
      { key: 'other', label: '其他', tag: null },
    ]
    const TAGGED = ['decision', 'ability', 'event']
    const cap = Math.max(0, Number(budget) || 0)

    /** 某个类目的条目，按 recency 从新到旧。 */
    const entriesFor = (cat) => {
      const list = [...this.autobiographyEntries()]
      if (cat.tag) {
        return list
          .filter((m) => (m.tags || []).includes(cat.tag))
          .sort((a, b) => b.recency - a.recency)
      }
      // 其他 = 三类标签一个都没有（不会重复计入前三个类目）
      return list
        .filter((m) => !TAGGED.some((t) => (m.tags || []).includes(t)))
        .sort((a, b) => b.recency - a.recency)
    }

    const pending = new Map() // key → 尚未取用的条目（从新到旧）
    for (const c of CATS) pending.set(c.key, entriesFor(c))

    // ── 保底配额（F-7）：只给**非空**类目 ──
    // 为什么各类**独立**取 floor、而不是约束"总和不超预算"：能力/事件通常只有 1~2 条，
    // 若为了"总和恰好装得下"把它们中的一个挤成 0，就等于又回到"决策吃光预算"。
    // 单类上限 25% 保证 floor 自己不会把预算吃穿（4 类 × 25% = 100%）；
    // 4 类同时取 floor 时和可能 > 预算，那也没关系：装不下的会被预算挡住，
    // 且**下一轮 relaxed 会把额度放开**，剩余预算一定有人能用掉（实测见测试 93）。
    const floor = Math.min(
      Math.max(0, cap * floorRatio),
      Math.max(0, floorMin),
      Math.floor(cap * 0.25)
    )
    const allocated = new Map()
    for (const c of CATS) {
      allocated.set(c.key, floor > 0 && pending.get(c.key).length > 0 ? floor : 0)
    }

    const result = []
    const usedIds = new Set()
    let used = 0
    const remaining = () => cap - used
    // 当前这一类在本轮还能用多少额度：拿到配额的类目受 `used额度+配额` 限制，
    // 没拿到的类目只受总预算。配额一旦用完，多出来的额度自然流回按优先级分配。
    const softCapFor = (key) =>
      allocated.get(key) > 0 ? used + allocated.get(key) : cap

    // 轮转式填充：每一轮按优先级过一遍类目、每类推进一条。
    // 为什么不"先填满决策再轮到能力"：那样决策会一直吃到预算见底，
    // 轮到能力时已经没有空间 —— 配额就形同虚设（测试 92 正是在构造这个场景）。
    //
    // ★ 第二阶段（relaxed）是必须的，否则配额会**帮倒忙**：
    //   若某类目的队首条目比它自己的配额还长（很常见：一条 100 字决策 vs 75 字配额），
    //   严格额度会让它被跳过 —— 若此时**别的类目都取不出东西了**，
    //   那 75 字的额度就白白浪费（预算还剩 400 却只注入了 1 个字）。
    //   所以：本轮如果**所有**类目都取不出（=剩下的额度谁也拿不走），
    //   就放弃额度上限，让最高优先级的类目先把剩余预算用掉 —— 不浪费预算、也不空转。
    let relaxed = false
    while (remaining() > 0) {
      let progressed = false
      // ★ 记「**类目**是否全被挡」，不是「被挡了几条」—— 这里踩过一次：
      //   用条数比 `present`（类目数）时，一个类目里的多条会把它顶到 > present，
      //   于是 relaxed 那一轮**永远进不去**，配额就成了硬墙（预算还剩一大半却停止注入）。
      const blockedCategories = new Set()
      let present = 0
      // 本轮每类的**游标**：放不下就往前挪一条继续试 —— 这才是 F-6 的完整语义。
      // （只在"账本"上挪，真取用时才 `splice` 出队；没取用的条目仍算 unselected。）
      const cursor = new Map()
      for (const c of CATS) {
        const list = pending.get(c.key)
        if (list && list.length) { present++; cursor.set(c.key, 0) }
      }
      for (const c of CATS) {
        if (!cursor.has(c.key)) continue
        const list = pending.get(c.key)
        // 本轮每类**至多推进一条** —— 这样配额才能保证"各类轮流"，而不是被最高优先级一口气吃穿。
        for (let guard = 0; guard < list.length; guard++) {
          const at = cursor.get(c.key)
          if (at >= list.length) break
          const m = list[at]
          const text = m.summary || ''
          // ★ 放不下就**跳过这一条**试下一条（F-6）——
          //   旧实现 `break` 跳出的是**整个类目/整轮**：一条超长 summary 会让它后面的
          //   小条目**全部被放弃**（实测：`[小, 大, 小]` 只剩第一个小）。
          const tooBig = text.length > remaining()
          const overQuota = !relaxed && used + text.length > softCapFor(c.key)
          if (tooBig || overQuota) {
            blockedCategories.add(c.key)
            cursor.set(c.key, at + 1) // 跳过它继续试下一条
            continue // ★F6-KEEP
          }
          list.splice(at, 1)
          result.push({ category: c.key, label: c.label, summary: text })
          usedIds.add(m.id)
          used += text.length
          progressed = true
          break // 本轮这一类到此为止（下一条下一轮再说）
        }
      }
      if (!progressed) {
        // 谁都没取到：若**每个有内容的类目**都被挡，说明是**配额**挡的（不是真装不下）
        // → 放开配额上限再试一轮，让最高优先级把剩余预算用掉（不浪费、也不空转）。
        if (!relaxed && present > 0 && blockedCategories.size === present) { relaxed = true; continue }
        break // 有类目的条目真装不下、且没有别的类目在等 → 到此为止（不空转）
      }
      relaxed = false // 真的取出了东西 → 下一轮恢复配额约束（配额继续起作用）
    }

    // ── 未注入的**实数**（F-12 那一行要用）：按类目统计，用**对象身份**判定 ──
    // 不用"比对摘要文本"：两条摘要恰好相同（"无。"这类）时文本比对会数错，身份不会。
    const unselectedByCategory = { ability: 0, event: 0, other: 0 }
    for (const m of this.autobiographyEntries()) {
      if (usedIds.has(m.id)) continue
      const tags = m.tags || []
      if (tags.includes('decision')) continue // 决策类目不进 F-12 那句话（它只点能力/事件/其他）
      const key = tags.includes('ability') ? 'ability' : tags.includes('event') ? 'event' : 'other'
      unselectedByCategory[key]++
    }
    const unselected =
      unselectedByCategory.ability + unselectedByCategory.event + unselectedByCategory.other
    return { entries: result, used, budget: cap, unselected, unselectedByCategory }
  }

  /**
   * 归档某会话的短时记忆 → 一条长期。
   *
   * ★ 归档闸门（2026-10-17）：受保护记录（外部信息隔离验证 / 未收尾任务）**不参与归档**，
   *   原样留在短时层；其余照旧归档。闸门放在这里 = `mnemos_consolidate` 与两条心跳归档路径
   *   **一次覆盖**（它们都走这个函数）。
   *
   * @param report 可选：被填入 `{ total, protected, archived }`，供工具如实说明"为什么没归档它"
   * @returns 归档出的长期记录；**没有任何可归档记录时返回 null**
   */
  async archiveSession(sessionId, newSummary, report = null) {
    await this.ensureLoaded()
    // 归档：把某会话框的短时记忆合并为长期。
    // ★ F-5：`null` 会话必须退化为 `'__unassigned__'` 分组 —— 与 shortBySession() 的口径一致。
    //   以前写成 `(m.sessionId || '__unassigned__') === sessionId`，`sessionId=null` 时
    //   永远匹配不上 → 返回 null → 工具回执谎报"没有可归档的短时记忆"，
    //   而记录其实都在 `__unassigned__` 组里（真实可达：现行库 28/197 条 sessionId 为 null）。
    const scope = sessionId || '__unassigned__'
    const openTaskIds = collectOpenTaskIds(this.memories.values())
    const inScope = [...this.memories.values()].filter(
      (m) => m.layer === 'short' && (m.sessionId || '__unassigned__') === scope
    )
    const group = inScope.filter((m) => !isArchiveProtected(m, openTaskIds))
    // ★ V6-21 P2：会话存档要"完整"到任务层面 —— 把该会话**已收尾、尚未入过档**的 task-result
    //   作为"任务"一节收进来。只收任务结论，不复制成员正文（成员在收尾时已经转 cold）。
    const taskResults = [...this.memories.values()].filter(
      (m) =>
        m.layer === 'hot' &&
        (m.tags || []).includes(TASK_RESULT_TAG) &&
        (m.sessionId || '__unassigned__') === scope &&
        m.archivedIn !== scope
    )
    if (report && typeof report === 'object') {
      report.total = inScope.length
      report.protected = inScope.length - group.length
      report.archived = group.length
      report.tasks = taskResults.length
    }
    if (group.length === 0 && taskResults.length === 0) return null
    const summary =
      newSummary ||
      [...group, ...taskResults].map((m) => m.summary).filter(Boolean).join('；')
    const groupDetail = group.map((m) => `[${m.id} v${m.version}] ${m.detail || ''}`).join('\n\n')
    const taskDetail = taskResults
      .map((m) => `[任务 ${m.taskId || '?'}] ${m.summary}\n${m.detail || ''}`)
      .join('\n\n')
    const detail = [groupDetail, taskDetail].filter(Boolean).join('\n\n')
    const tags = [...new Set([...group, ...taskResults].flatMap((m) => m.tags || []))]
    const maxWeight = [...group, ...taskResults].reduce(
      (a, m) => Math.max(a, SALIENCE_WEIGHT[m.salience] || 2),
      0
    )
    const salience =
      Object.keys(SALIENCE_WEIGHT).find((k) => SALIENCE_WEIGHT[k] === maxWeight) || 'normal'
    const now = Date.now()
    const consolidated = {
      id: randomUUID(),
      taskId: null,
      // ★ 显式标记"这条是会话存档"（2026-10-18，用户要求：这种巨物是整会话存档、有价值，只降召回优先级）。
      //   召回排序用 isArchiveLike() 认它：**新存档认标记、历史存档认体积**，两条路都在。
      archiveOf: scope,
      tags: [...new Set([...tags, 'session-archive'])],
      summary,
      detail,
      layer: 'hot',
      salience,
      recency: now,
      createdAt: now,
      version: 1,
      source: 'internal',
      sessionId: sessionId || null,
      scope, // 供回执如实说明"归到哪个作用域"（null 会话 → '__unassigned__'）
    }
    // 原始记录降为冷存储、版本递增（保留，不删除）
    for (const m of group) {
      m.layer = 'cold'
      m.version += 1
    }
    // 任务结论只记"已入过档"（保持 hot：图/召回仍可指向它），避免下次归档重复收
    for (const m of taskResults) m.archivedIn = scope
    this.memories.set(consolidated.id, consolidated)
    await this.save()
    return consolidated
  }

  async decay({ thresholdMs = 7 * 24 * 3600 * 1000 } = {}) {
    await this.ensureLoaded()
    // 衰减 = 降权：hot 记忆闲置超过阈值 → 降为 cold（保留，不删除）
    const now = Date.now()
    let demoted = 0
    for (const m of this.memories.values()) {
      if (m.layer === 'hot' && now - (m.recency || m.createdAt) > thresholdMs) {
        m.layer = 'cold'
        m.version += 1
        demoted++
      }
    }
    if (demoted > 0) await this.save()
    return { demoted }
  }

  /**
   * ★ 外部信息隔离验证记录的**有界化**（2026-10-17 用户提出）：这类记录受归档闸门保护、
   *   **永远不进长期**，所以如果不销毁就会无限堆积（现在只有 7 条、约 1 条/天，但那是机制缺陷，
   *   不是"刚好没长"）。
   *
   * 规则：**同时满足"不在最近 keepRecent 条内"且"超过 keepMs"** 才销毁（双条件 = 双保险）；
   *   其余保留。销毁走 `delete()` → **带墓碑**（跨进程旧副本复活不了）。
   *
   * 为什么不"归档为长期"：那正好违反"只存短期、不转长期"，而且 cold 记录照样会被召回（噪音）。
   * 为什么销毁要留台账：销毁不可逆，至少要让"删过什么"可查 —— 往 `validation-prune.jsonl`
   *   （与 memory.json 同级）追加一行 id / 时间 / 摘要首段 / 字符数。
   *
   * @param opts.keepRecent 保留最近多少条（默认 50）
   * @param opts.keepMs     保留多少毫秒内的（默认 7 天）
   * @param opts.now        可注入的"当前时间"（测试用）
   * @returns {{scanned:number, deleted:number, kept:number, auditFile:string|null}}
   */
  async pruneValidation({
    keepRecent = DEFAULT_VALIDATION_KEEP_RECENT,
    keepMs = DEFAULT_VALIDATION_KEEP_MS,
    now = Date.now(),
    audit = true,
  } = {}) {
    await this.ensureLoaded()
    const list = [...this.memories.values()]
      .filter((m) => m.source === 'validation')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    if (list.length === 0) return { scanned: 0, deleted: 0, kept: 0, auditFile: null }

    const keep = new Set()
    list.forEach((m, i) => {
      const recentEnough = i < keepRecent
      const freshEnough = now - (m.createdAt || m.recency || 0) < keepMs
      if (recentEnough || freshEnough) keep.add(m.id)
    })
    const doomed = list.filter((m) => !keep.has(m.id))

    let auditFile = null
    if (doomed.length && audit && typeof this.dataFile === 'string' && this.dataFile) {
      auditFile = path.join(path.dirname(this.dataFile), 'validation-prune.jsonl')
      const lines = doomed
        .map((m) =>
          JSON.stringify({
            t: Date.now(),
            id: m.id,
            createdAt: m.createdAt ?? null,
            summary: String(m.summary || '').slice(0, 120),
            detailChars: String(m.detail || '').length,
            reason: 'validation-record-beyond-window',
          })
        )
        .join('\n')
      try {
        await fs.appendFile(auditFile, lines + '\n', 'utf8')
      } catch {
        auditFile = null // 台账写不了不阻塞销毁本身（但回执里如实为 null）
      }
    }
    for (const m of doomed) await this.delete(m.id)
    return { scanned: list.length, deleted: doomed.length, kept: keep.size, auditFile }
  }

  /* ───────────────── 任务图（多 agent 协作的协调中枢，2026-10-17 定稿）─────────────────
   *
   * 形状（用户拍板）：
   *   主模型派活前 `openTask` 写一张图（taskId + 各分工 id/内容）→ 派活只把**图的记忆 id** 交给子代理
   *   → 子代理把交接结论写成**短时记忆**（tags 必含 `task:<id>` 与 `assign:<分工id>`）并把
   *   `{handoffId, status}` 回执给主模型 → 主模型 `updateTask` 把回执填进图（**唯一写者** → 无并发冲突）
   *   → `closeTask` 按 taskId 汇成一条长期结论，未完成的如实标，**scratch 默认丢弃**。
   *
   * 为什么图和状态只允许主模型写：并发更新同一条记录会丢更新（store 的合并是**按整条记录**的），
   * 单写者是这里唯一能保证"回执不丢"的简单做法。
   */

  /** 找到一张任务图（open 或 closed 都算）。 */
  findTaskGraph(taskId) {
    const tag = `${TASK_TAG_PREFIX}${taskId}`
    for (const m of this.memories.values()) {
      const tags = m.tags || []
      if (tags.includes(TASK_GRAPH_TAG) && tags.includes(tag) && m.task) return m
    }
    return null
  }

  /** 找到一张**未收尾**的任务图（按 taskId）。 */
  findOpenTask(taskId) {
    const g = this.findTaskGraph(taskId)
    return g && (g.tags || []).includes(TASK_OPEN_TAG) ? g : null
  }

  /** 任务图的展示文本（每次更新后重渲染，让 recall 一眼看到进度）。 */
  renderTaskGraph(task) {
    const lines = [`目标：${task.goal}`, '分工：']
    for (const a of task.assignments || []) {
      lines.push(
        `- ${a.id}［${a.status}］${a.task}` +
          (a.handoffId ? ` → handoff ${a.handoffId}` : '') +
          (a.note ? `（${a.note}）` : '')
      )
    }
    if (task.links?.length) lines.push(`前序：${task.links.map((l) => `${l.taskId}（${l.relation}）`).join('、')}`)
    if (task.done?.length) lines.push(`已完成：${task.done.length} 条`)
    if (task.uses?.length) lines.push(`依赖：${task.uses.length} 条`)
    if (task.notes) lines.push(`备注：${task.notes}`)
    lines.push(`任务 id：${task.id}（未收尾）`)
    return lines.join('\n')
  }

  /**
   * 开一张任务图。**只该由主模型调用。**
   * @returns `{ok:true, taskId, graphId, assignments}` 或 `{ok:false, reason}`
   */
  async openTask({ goal, assignments = [], notes = '', links = [], sessionId = null } = {}) {
    await this.ensureLoaded()
    const g = String(goal || '').trim()
    if (!g) return { ok: false, reason: 'goal 不能为空' }
    const cleaned = []
    for (const a of Array.isArray(assignments) ? assignments : []) {
      const id = String(a?.id || '').trim()
      const taskText = String(a?.task || '').trim()
      if (!id || !taskText) return { ok: false, reason: '每个分工都要有 id 与 task' }
      if (cleaned.some((x) => x.id === id)) return { ok: false, reason: `分工 id 重复：${id}` }
      cleaned.push({ id, task: taskText, status: 'pending', handoffId: null, note: '' })
    }
    const newId = `t-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`
    const now = Date.now()
    const tag = `${TASK_TAG_PREFIX}${newId}`

    // ★ V6-21：前序图链接（单向；不改旧图）。`why` 必填 —— 链接要写"为什么接上它"，
    //   不是旧图的内容摘要（旧图本身就是结论）。
    const cleanedLinks = []
    let linkTruncated = false
    for (const l of Array.isArray(links) ? links : []) {
      const targetId = String(l?.taskId || '').trim()
      if (!targetId) return { ok: false, reason: 'links 每项都要有 taskId' }
      if (targetId === newId) return { ok: false, reason: '不能链接自己' }
      if (cleanedLinks.some((x) => x.taskId === targetId)) {
        return { ok: false, reason: `links 里重复链接 ${targetId}` }
      }
      const target = this.findTaskGraph(targetId)
      if (!target) {
        return { ok: false, reason: `links 指向的 ${targetId} 不是任务图` }
      }
      const relation = String(l?.relation || 'related').trim()
      if (!TASK_LINK_RELATIONS.includes(relation)) {
        return { ok: false, reason: `links 的 relation 只能是 ${TASK_LINK_RELATIONS.join(' / ')}` }
      }
      const why = clipText(l?.why, TASK_LINK_WHY_MAX)
      if (!why.text) return { ok: false, reason: 'links 的 why 必填（为什么链接这张图）' }
      if (why.truncated) linkTruncated = true
      cleanedLinks.push({ taskId: targetId, relation, why: why.text })
    }
    if (cleanedLinks.length > TASK_LINKS_MAX) {
      return { ok: false, reason: `links 最多 ${TASK_LINKS_MAX} 条` }
    }

    const task = {
      id: newId,
      goal: g,
      notes: String(notes || ''),
      assignments: cleaned,
      done: [],
      uses: [],
      links: cleanedLinks,
      openedAt: now,
      lastActivityAt: now,
    }
    const rec = {
      id: randomUUID(),
      taskId: null,
      tags: [TASK_GRAPH_TAG, TASK_OPEN_TAG, tag, 'task'],
      summary: `任务图 ${newId}：${g.slice(0, 60)}`,
      detail: this.renderTaskGraph(task),
      layer: 'short',
      salience: 'normal',
      recency: now,
      createdAt: now,
      version: 1,
      source: 'internal',
      sessionId: sessionId || null,
      task,
    }
    this.memories.set(rec.id, rec)
    await this.save()
    return {
      ok: true,
      taskId: newId,
      graphId: rec.id,
      assignments: cleaned.map((a) => a.id),
      links: cleanedLinks.map((x) => x.taskId),
      linkTruncated,
      ownerSession: rec.sessionId,
    }
  }

  /**
   * 把某个分工的回执填进任务图。**只该由图的创建者会话调用**（单写者）。
   * @returns `{ok:true,...}` 或 `{ok:false, reason}`
   */
  async updateTask({ taskId, assign, status, handoffId = null, note = '', sessionId = null } = {}) {
    await this.ensureLoaded()
    const graph = this.findOpenTask(taskId)
    if (!graph) return { ok: false, reason: `找不到未收尾的任务 ${taskId}（可能已收尾或不存在）` }
    if (graph.sessionId && sessionId && graph.sessionId !== sessionId) {
      return { ok: false, reason: '只有创建这张任务图的会话能更新它（单写者，避免并发丢更新）' }
    }
    const a = (graph.task.assignments || []).find((x) => x.id === assign)
    if (!a) return { ok: false, reason: `任务 ${taskId} 里没有分工 ${assign}` }
    const st = String(status || '').trim()
    if (!TASK_STATUSES.includes(st)) return { ok: false, reason: `status 只能是 ${TASK_STATUSES.join(' / ')}` }
    if (handoffId) {
      const h = this.memories.get(String(handoffId))
      if (!h) return { ok: false, reason: `handoffId ${handoffId} 不存在` }
      if (!(h.tags || []).includes(`${TASK_TAG_PREFIX}${taskId}`)) {
        return { ok: false, reason: `handoffId ${handoffId} 不属于任务 ${taskId}` }
      }
      // ★ V6-07（2026-10-21）：交接记录必须**标明属于哪个分工**。
      //   只校验"属于本图"时，同一个 handoff 能同时交给 p1/p2/p3 ——
      //   "谁交付了什么"就只剩正文里的手写说明，机械层面无法核对。
      const assignTag = `assign:${a.id}`
      if (!(h.tags || []).includes(assignTag)) {
        return {
          ok: false,
          reason:
            `handoffId ${handoffId} 缺 ${assignTag} 标签（交接记录必须标明属于哪个分工；` +
            `同一 handoff 不能交给多个分工）`,
        }
      }
      a.handoffId = String(handoffId)
    }
    a.status = st
    if (note) a.note = String(note)
    graph.version += 1
    graph.recency = Date.now()
    graph.task.lastActivityAt = Date.now() // ★ 有进展就不算孤儿（过期回收看的是这个字段）
    graph.detail = this.renderTaskGraph(graph.task)
    await this.save()
    return { ok: true, taskId, assign: a.id, status: a.status, handoffId: a.handoffId, graphVersion: graph.version }
  }

  /**
   * ★ V6-21：追加一条**已完成里程碑**（只追加，不整表替换）。
   * `memoryId` 可选：有产物/证据时指向那条记忆（它必须带本任务的 tag）。
   */
  async appendTaskDone({ taskId, text, memoryId = null, sessionId = null } = {}) {
    await this.ensureLoaded()
    const graph = this.findOpenTask(taskId)
    if (!graph) return { ok: false, reason: `找不到未收尾的任务 ${taskId}` }
    if (graph.sessionId && sessionId && graph.sessionId !== sessionId) {
      return { ok: false, reason: '只有创建这张任务图的会话能更新它（单写者）' }
    }
    const clipped = clipText(text, TASK_DONE_TEXT_MAX)
    if (!clipped.text) return { ok: false, reason: 'text 不能为空' }
    let id = null
    if (memoryId) {
      const m = this.memories.get(String(memoryId))
      if (!m) return { ok: false, reason: `memoryId ${memoryId} 不存在` }
      if (!(m.tags || []).includes(`${TASK_TAG_PREFIX}${taskId}`)) {
        return { ok: false, reason: `memoryId ${memoryId} 不属于任务 ${taskId}` }
      }
      id = m.id
    }
    const now = Date.now()
    graph.task.done = Array.isArray(graph.task.done) ? graph.task.done : []
    graph.task.done.push({ text: clipped.text, at: now, ...(id ? { id } : {}) })
    graph.version += 1
    graph.recency = now
    graph.task.lastActivityAt = now
    graph.detail = this.renderTaskGraph(graph.task)
    await this.save()
    return { ok: true, taskId, doneCount: graph.task.done.length, truncated: clipped.truncated }
  }

  /**
   * ★ V6-21：登记"本任务依赖的既有记忆"（调取已有结论/外部输入）。
   * 只存 `{id, why?}`：外部性/作废状态读时从记忆现取，**不复制**。
   */
  async citeTaskMemories({ taskId, ids = [], why = '', sessionId = null } = {}) {
    await this.ensureLoaded()
    const graph = this.findOpenTask(taskId)
    if (!graph) return { ok: false, reason: `找不到未收尾的任务 ${taskId}` }
    if (graph.sessionId && sessionId && graph.sessionId !== sessionId) {
      return { ok: false, reason: '只有创建这张任务图的会话能更新它（单写者）' }
    }
    const list = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || '').trim()).filter(Boolean))]
    if (!list.length) return { ok: false, reason: 'ids 不能为空' }
    for (const id of list) {
      const m = this.memories.get(id)
      if (!m) return { ok: false, reason: `记忆 ${id} 不存在` }
      if ((m.tags || []).includes(TASK_GRAPH_TAG)) {
        return { ok: false, reason: `${id} 是任务图；任务图请用 links 链接，不要放进 uses` }
      }
    }
    const clipped = clipText(why, TASK_USE_WHY_MAX)
    graph.task.uses = Array.isArray(graph.task.uses) ? graph.task.uses : []
    const existing = new Set(graph.task.uses.map((u) => u.id))
    const fresh = list.filter((id) => !existing.has(id))
    const skipped = list.length - fresh.length
    if (graph.task.uses.length + fresh.length > TASK_USES_MAX) {
      return { ok: false, reason: `uses 最多 ${TASK_USES_MAX} 条（已有 ${graph.task.uses.length}）` }
    }
    for (const id of fresh) graph.task.uses.push({ id, ...(clipped.text ? { why: clipped.text } : {}) })
    if (fresh.length) {
      const now = Date.now()
      graph.version += 1
      graph.recency = now
      graph.task.lastActivityAt = now
      graph.detail = this.renderTaskGraph(graph.task)
      await this.save()
    }
    return { ok: true, taskId, added: fresh.length, skipped, usesCount: graph.task.uses.length, truncated: clipped.truncated }
  }

  /**
   * ★ V6-21：`open(图)` 的**读时投影**：目标/前序/已完成/依赖/重要结论/其他引用/分工。
   * 不复制结论正文 —— 结论就是带 `task:<id>` 标签的记忆，这里只列 id + summary。
   */
  renderTaskBrief(taskId) {
    const graph = this.findTaskGraph(taskId)
    if (!graph) return null
    const task = graph.task || {}
    const isOpen = (graph.tags || []).includes(TASK_OPEN_TAG)
    const lines = [`任务 ${taskId}［${isOpen ? 'open' : 'closed'}］`, `目标：${task.goal || ''}`]

    if (Array.isArray(task.links) && task.links.length) {
      lines.push('', `前序（${task.links.length}）：`)
      for (const l of task.links) {
        const old = this.findTaskGraph(l.taskId)
        const state = old ? ((old.tags || []).includes(TASK_OPEN_TAG) ? 'open' : 'closed') : '已删除'
        const when = old ? new Date(old.createdAt).toISOString().slice(0, 10) : '?'
        lines.push(`- ${l.taskId}［${state} ${when}］— ${l.relation} — 为什么：${l.why}`)
      }
    }

    if (Array.isArray(task.done) && task.done.length) {
      const shown = task.done.slice(-TASK_DONE_RENDER_MAX)
      lines.push('', `已完成（${task.done.length}）：`)
      for (const d of shown) {
        const when = new Date(d.at).toISOString().slice(0, 10)
        lines.push(`- ${when} ${d.text}` + (d.id ? `（${d.id}）` : ''))
      }
      if (task.done.length > shown.length) lines.push(`- …另有 ${task.done.length - shown.length} 条`)
    }

    if (Array.isArray(task.uses) && task.uses.length) {
      lines.push('', `依赖（${task.uses.length}）：`)
      for (const u of task.uses) {
        const m = this.memories.get(u.id)
        const src = m ? (m.source === 'external' ? '外部' : '内部') : '已删除'
        const dead = !m ? '（已删除）' : m.source === 'deprecated' ? '（已作废）' : ''
        const cross = m && m.taskId && m.taskId !== taskId ? `［来自任务 ${m.taskId}］` : ''
        lines.push(`- ［${src}］${u.why || '（未注明）'}（${u.id}）${cross}${dead}`)
      }
    }

    const members = [...this.memories.values()].filter(
      (m) => m.id !== graph.id && (m.tags || []).includes(`${TASK_TAG_PREFIX}${taskId}`)
    )
    const isArchive = (m) => Boolean(m.archiveOf) || (m.tags || []).includes('session-archive')
    const archives = members.filter(isArchive)
    const live = members.filter((m) => !isArchive(m))
    const doneIds = new Set((task.done || []).map((d) => d.id).filter(Boolean))
    const handoffIds = new Set((task.assignments || []).map((a) => a.handoffId).filter(Boolean))
    const conclusions = live
      .filter((m) => (m.tags || []).includes(TASK_CONCLUSION_TAG))
      .sort((a, b) => a.createdAt - b.createdAt)
    const results = live.filter((m) => (m.tags || []).includes(TASK_RESULT_TAG))
    const others = live.filter(
      (m) =>
        !(m.tags || []).includes(TASK_CONCLUSION_TAG) &&
        !(m.tags || []).includes(TASK_RESULT_TAG) &&
        !handoffIds.has(m.id) &&
        !doneIds.has(m.id)
    )

    if (conclusions.length) {
      lines.push('', `重要结论（${conclusions.length}）：`)
      for (const m of conclusions) {
        const dead = m.source === 'deprecated' ? '（已作废）' : m.supersededBy ? '（已被取代）' : ''
        lines.push(`- [${new Date(m.createdAt).toISOString().slice(0, 10)}] ${m.summary}（${m.id}）${dead}`)
      }
    }
    if (results.length) {
      lines.push('', `收尾结论（${results.length}）：`)
      for (const m of results) lines.push(`- ${m.summary}（${m.id}）`)
    }
    if (others.length) {
      const shown = others.slice(0, 8)
      lines.push('', `其他引用（${others.length}）：`)
      for (const m of shown) {
        const dead = m.source === 'deprecated' ? '（已作废）' : ''
        lines.push(`- ${m.summary}（${m.id}）${dead}`)
      }
      if (others.length > shown.length) {
        lines.push(`- …另有 ${others.length - shown.length} 条（用 recall taskId 取全）`)
      }
    }
    if (archives.length) {
      lines.push('', `会话存档（${archives.length}）：${archives.map((a) => a.id).join('、')}`)
    }

    if (Array.isArray(task.assignments) && task.assignments.length) {
      lines.push('', '分工：')
      for (const a of task.assignments) {
        lines.push(
          `- ${a.id}［${a.status}］${a.task}` +
            (a.handoffId ? ` → handoff ${a.handoffId}` : '') +
            (a.note ? `（${a.note}）` : '')
        )
      }
    }
    if (task.notes) lines.push('', `备注：${task.notes}`)
    return lines.join('\n')
  }

  /**
   * 收尾一张任务图：按 taskId 汇成**一条**长期结论，未完成的如实标注，
   * `scratch` 临时中间结果**默认丢弃**（打了 `keep` 标签的才保留并进结论）。
   * 收尾后图标签 open→closed → 归档闸门不再保护这批记录。
   * @returns `{ok:true, longTermId, rolled, missing, discarded, keptScratch}` 或 `{ok:false, reason}`
   */
  /**
   * 收尾一张任务图（唯一入口的内部实现，`closeTask` / `expireTask` 都走这里）。
   *
   * `mode`：
   *   · `close`  —— 主模型正常收尾：**只接受图的创建者会话**（单写者）；
   *   · `expire` —— 超时强制归档：**跳过所有者校验**（它不是"谁在收尾"，而是机制在回收孤儿图），
   *     并在长期结论里明确写清"超时未收尾"，绝不假装它完成了。
   */
  async _archiveTask({ taskId, conclusion = '', newSummary = '', sessionId = null, mode = 'close' } = {}) {
    await this.ensureLoaded()
    const graph = this.findOpenTask(taskId)
    if (!graph) return { ok: false, reason: `找不到未收尾的任务 ${taskId}（可能已收尾或不存在）` }
    if (mode !== 'expire' && graph.sessionId && sessionId && graph.sessionId !== sessionId) {
      return { ok: false, reason: '只有创建这张任务图的会话能收尾它（单写者）' }
    }
    const expired = mode === 'expire'
    const now = Date.now()
    const task = graph.task
    const idleHours = Math.round((now - (task?.lastActivityAt || graph.createdAt || now)) / 3600000)
    const tag = `${TASK_TAG_PREFIX}${taskId}`
    const members = [...this.memories.values()].filter((m) => m.id !== graph.id && (m.tags || []).includes(tag))
    const handoffIds = new Set((task.assignments || []).map((a) => a.handoffId).filter(Boolean))
    const handoffs = members.filter(
      (m) =>
        handoffIds.has(m.id) ||
        (m.tags || []).some((t) => typeof t === 'string' && t.startsWith('assign:'))
    )
    for (const h of handoffs) handoffIds.add(h.id)
    const scratch = members.filter((m) => (m.tags || []).includes(TASK_SCRATCH_TAG) && !handoffIds.has(m.id))
    const keptScratch = scratch.filter((m) => (m.tags || []).includes(TASK_KEEP_TAG))
    const discarded = scratch.filter((m) => !(m.tags || []).includes(TASK_KEEP_TAG))
    const missing = (task.assignments || [])
      .filter((a) => a.status === 'pending' || !a.handoffId)
      .map((a) => ({ id: a.id, task: a.task, status: a.status }))

    // ★ V6-07：有 handoff 但缺 assign 标签的分工 —— 历史用法会在这里现形。
    //   不阻断收尾（否则那 5 张旧图永远收不了），列为警告写进结论。
    const unlabeledHandoffs = (task.assignments || [])
      .filter((a) => {
        if (!a.handoffId) return false
        const h = this.memories.get(a.handoffId)
        return !h || !(h.tags || []).includes(`assign:${a.id}`)
      })
      .map((a) => ({ id: a.id, handoffId: a.handoffId }))

    const rolled = (task.assignments || []).map((a) => ({
      assign: a.id,
      status: a.status,
      handoffId: a.handoffId,
      note: a.note,
    }))
    // ★ 过期强制归档：结论位不能留空，也不能假装完成 —— 写清"超时未收尾"
    const effConclusion = expired
      ? (String(conclusion || '').trim() ||
         `（超时未收尾：超过保留窗口，闲置 ${idleHours} 小时没有任何进展，被机制强制归档）`)
      : (String(conclusion || '').trim() || '（未填）')
    const detailLines = [
      `结论：${effConclusion}`,
      ...(expired ? ['', `■ 归档方式：过期强制归档（图仍处于 open 且闲置 ${idleHours} 小时）`] : []),
      '',
      `任务 id：${taskId}`,
      `目标：${task.goal}`,
      '',
      '■ 分工完成情况',
      ...(task.assignments || []).map(
        (a) =>
          `- ${a.id}［${a.status}］${a.task}` +
          (a.handoffId ? ` → handoff ${a.handoffId}` : '') +
          (a.note ? `（${a.note}）` : '')
      ),
      '',
      missing.length
        ? `■ 未完成（${missing.length}）：${missing.map((m) => m.id).join(', ')}`
        : '■ 每个分工都有回执',
      '',
      ...(unlabeledHandoffs.length
        ? [
            `■ 交接缺 assign 标签（${unlabeledHandoffs.length}）：${unlabeledHandoffs.map((x) => x.id).join(', ')}`,
            '  （历史遗留；v1.6 起 task_update 会拒绝这类交接——同一个 handoff 不能交给多个分工）',
            '',
          ]
        : []),
      ...(task.links?.length
        ? ['', `■ 前序图（${task.links.length}）：${task.links.map((l) => `${l.taskId}（${l.relation}）`).join('、')}`, '']
        : []),
      ...(task.uses?.length
        ? ['', `■ 依赖（${task.uses.length}）：${task.uses.map((u) => u.id).join(', ')}`, '']
        : []),
      ...(task.done?.length ? ['', `■ 已完成里程碑（${task.done.length}）`, ''] : []),
      keptScratch.length
        ? `■ 保留的中间结果（${keptScratch.length}）：\n${keptScratch.map((m) => `- ${m.id}：${String(m.summary || '').slice(0, 80)}`).join('\n')}`
        : '■ 无保留的中间结果',
      '',
      discarded.length
        ? `■ 已丢弃的临时中间结果（${discarded.length}，默认丢弃；要留请打 ${TASK_KEEP_TAG} 标签）：\n${discarded
            .slice(0, 10)
            .map((m) => `- ${m.id}：${String(m.summary || '').slice(0, 80)}`)
            .join('\n')}`
        : '■ 无丢弃的临时中间结果',
    ]
    const consolidated = {
      id: randomUUID(),
      taskId,
      tags: [tag, TASK_RESULT_TAG, 'task', ...(expired ? [TASK_EXPIRED_TAG] : [])],
      summary:
        newSummary ||
        `任务 ${taskId} ${expired ? '超时强制归档' : '结论'}：${effConclusion.slice(0, 60)}`,
      detail: detailLines.join('\n'),
      layer: 'hot',
      salience: missing.length ? 'normal' : 'high',
      recency: now,
      createdAt: now,
      version: 1,
      source: 'internal',
      sessionId: graph.sessionId || null,
      scope: graph.sessionId || '__unassigned__',
    }
    // 图收尾：open → closed（闸门据此解除对这批判记录的保护）
    graph.tags = (graph.tags || []).map((t) => (t === TASK_OPEN_TAG ? TASK_CLOSED_TAG : t))
    if (expired && !graph.tags.includes(TASK_EXPIRED_TAG)) graph.tags.push(TASK_EXPIRED_TAG)
    graph.version += 1
    graph.recency = now
    // ★ V6-21：收尾即把**全部成员**转冷（permanent 除外）——任务档案不再属于会话短时工作集。
    //   archiveSession 只收 short，所以不会把任务成员吞进会话存档，id 保持个体可寻址。
    for (const m of [graph, ...members]) {
      if (m.layer === 'permanent') continue
      m.layer = 'cold'
      m.version += 1
    }
    this.memories.set(consolidated.id, consolidated)
    // ★ 默认丢弃 scratch：不可逆，所以在长期结论里**留了清单**（不是悄悄消失）
    for (const m of discarded) await this.delete(m.id)
    await this.save()
    return {
      ok: true,
      taskId,
      longTermId: consolidated.id,
      rolled,
      missing,
      unlabeledHandoffs,
      discarded: {
        count: discarded.length,
        items: discarded.slice(0, 5).map((m) => ({ id: m.id, summary: String(m.summary || '').slice(0, 60) })),
      },
      keptScratch: keptScratch.length,
      doneCount: (task.done || []).length,
      usesCount: (task.uses || []).length,
      linksCount: (task.links || []).length,
      ...(expired ? { expired: true, idleHours } : {}),
    }
  }

  /** 正常收尾（主模型调用）：只接受创建图的会话。 */
  async closeTask(opts = {}) {
    return this._archiveTask({ ...opts, mode: 'close' })
  }

  /** 超时强制归档（机制调用）：跳过所有者校验，结论里写清"超时未收尾"。 */
  async expireTask({ taskId, conclusion = '' } = {}) {
    return this._archiveTask({ taskId, conclusion, mode: 'expire' })
  }

  /**
   * ★ 孤儿任务图回收（2026-10-17）：把**闲置超过 maxOpenMs** 的未收尾任务强制归档。
   *
   * 为什么需要：图在收尾前受归档闸门保护 —— 会话崩了/忘了收尾，那批记录就永远不被归档，
   * 成了"孤儿"。这是闸门带来的新风险，必须有出口。
   * 判据用 `task.lastActivityAt`（open 与每次 update 都会刷新）：**只要还在推进就不会被误收**。
   *
   * @returns `{scanned, archived:[{taskId, idleHours, longTermId, missing}]}`
   */
  async reclaimStaleTasks({ maxOpenMs = DEFAULT_TASK_OPEN_MAX_MS, now = Date.now() } = {}) {
    await this.ensureLoaded()
    const stale = []
    for (const m of this.memories.values()) {
      const tags = m.tags || []
      if (!tags.includes(TASK_GRAPH_TAG) || !tags.includes(TASK_OPEN_TAG) || !m.task) continue
      const last = m.task.lastActivityAt || m.createdAt || 0
      if (now - last >= maxOpenMs) {
        stale.push({ taskId: m.task.id, idleHours: Math.round((now - last) / 3600000) })
      }
    }
    const archived = []
    for (const s of stale) {
      const r = await this._archiveTask({ taskId: s.taskId, mode: 'expire' })
      if (r && r.ok) {
        archived.push({ taskId: s.taskId, idleHours: s.idleHours, longTermId: r.longTermId, missing: r.missing })
      }
    }
    return { scanned: stale.length, archived }
  }
}
