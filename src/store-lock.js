/**
 * 跨进程写保护（store.js 的配套模块）。
 *
 * 问题：多个 DSH 实例（Web GUI + TUI）共用同一个 DSH_HOME 时，各自持一份 memory.json 的
 * 内存副本，而 save() 是**全量重写** → 后写的覆盖先写的 → **静默丢记录**。
 * 单进程内已由 store.js 的 saveChain 串行化解决；跨进程由本模块解决。
 *
 * 两层机制（缺一不可）：
 *   ① 互斥：写前在数据文件同目录创建 `memory.json.lock`（`wx` = 已存在即失败，天然互斥量）。
 *   ② 合并：拿到锁后**必须 re-read 磁盘**再按 id 合并。
 *      只加锁而不 re-read 是无效的 —— 本进程内存里那份旧副本
 *      （在等锁期间别的进程刚写进去的记录它根本没有）仍会把别人的新记录覆盖掉。
 *      锁解决"同时写"，re-read 解决"内存副本过期"，二者是两件事。
 *
 * 失败语义：**fail-open**。拿不到锁 / 目录不可写 → onWarn 告警后照旧写。
 * 宁可冒极小概率覆盖风险，也不能让记忆**写不进去**（那是更大的损失）。
 *
 * 一个额外发现（用数据说话，见 test 77 的扰动自证）：
 *   只做 re-read 就已经足够防丢记录了 —— 本模块的扰动实验里，
 *   去掉锁、只留 re-read，测试 77 第 ① ② 条仍然全过（0 失败）。
 *   锁不是"防丢"的必要条件，它的价值在别处：避免两个进程在同一瞬间取值→落盘造成交错，
 *   以及让"读-改-写"整段成为临界区（否则本进程刚合并的结果可能被后到的进程用更旧的快照盖掉）。
 *   所以两层都留，但不要在注释里把锁说成防丢的唯一原因。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 陈旧锁阈值：默认 30 秒。超过即视为崩溃残留，可抢占。 */
export const DEFAULT_STALE_MS = 30000
/** 抢锁重试：默认 5 次，退避 50/80/120/160/200ms（总等待 610ms，控制在一秒内）。 */
export const DEFAULT_RETRIES = 5
export const DEFAULT_BACKOFF_MS = [50, 80, 120, 160, 200]
/** 墓碑上限：默认 2000 条，超出按时间淘汰最旧的（防无限增长）。 */
export const MAX_TOMBSTONES = 2000

export function lockPathFor(dataFile) {
  return `${dataFile}.lock`
}

export function tombstonePathFor(dataFile) {
  return path.join(path.dirname(dataFile), 'memory-tombstones.json')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** rename 可重试的错误码 + 退避（F-16：Windows 上目标被短暂占用时的瞬时失败；见 atomicWriteFile）。 */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_RETRY_MS = [5, 15, 40]

/** 锁文件内容：便于人工判断陈旧锁是谁留下的。 */
export function lockBody(pid = process.pid, host = os.hostname(), at = Date.now()) {
  return JSON.stringify({ pid, host, at })
}

/**
 * 锁文件状态：**四态**。
 *
 * 为什么不能是"陈旧 / 不陈旧"两态（F-16 根因）：
 *   旧 `isStaleLock` 把**任何** stat 失败都折成 `true`（陈旧），调用方随即走**抢占**分支 →
 *   打出「锁文件已陈旧（疑似崩溃残留），已抢占」并 `lockStats.stolen++`。
 *   可真争用下最常见的 stat 失败是 **ENOENT —— 持有者刚刚正常释放**（B 在 `open wx` 撞到
 *   EEXIST 之后、probe 之前，A 恰好释放并删了锁文件）。那根本不是陈旧，也不是竞争失败，
 *   更不是崩溃残留 —— 是一个**假报告** + 一个被凭空抬高的 stolen 计数。
 *   实测（60 轮两实例真争用）：15 轮打出该假告警。
 */
export const LOCK_MISSING = 'missing' // 文件已不存在（持有者刚释放）→ 立刻重试建锁，不告警、不抢占
export const LOCK_STALE = 'stale'     // mtime 超过阈值 → 崩溃残留，可抢占（告警 + stolen++）
export const LOCK_FRESH = 'fresh'     // 有人在正常持锁 → 退避重试
export const LOCK_UNKNOWN = 'unknown' // stat 失败但不是 ENOENT（权限/占用…）→ 证据不足，**不抢占**，退避重试

/**
 * 探测锁文件状态（不抛错）。
 * @returns {Promise<'missing'|'stale'|'fresh'|'unknown'>}
 */
export async function probeLock(lockPath, staleMs = DEFAULT_STALE_MS, now = Date.now()) {
  try {
    const st = await fs.stat(lockPath)
    return now - st.mtimeMs > staleMs ? LOCK_STALE : LOCK_FRESH
  } catch (e) {
    return e && e.code === 'ENOENT' ? LOCK_MISSING : LOCK_UNKNOWN
  }
}

/**
 * 该锁文件是否已陈旧 → 视为崩溃残留、允许抢占。
 *
 * ★ F-16 语义修正：**只有"明确探到 mtime 超龄"才算陈旧**。
 *   旧实现"取不到 stat 就返回 true"，与本函数注释里写的"让调用方按没有锁处理"并不一致 ——
 *   调用方拿到 true 后走的是**抢占**（告警 + stolen++），于是"刚被释放"被报成"崩溃残留"。
 *   想区分"文件不在"的调用方请直接用 `probeLock`。
 */
export async function isStaleLock(lockPath, staleMs = DEFAULT_STALE_MS, now = Date.now()) {
  return (await probeLock(lockPath, staleMs, now)) === LOCK_STALE
}

/**
 * 创建锁文件时**可重试**的错误码。
 * ★ Windows：别人正在删除/替换同名锁文件时，`open(..., 'wx')` 会抛 EPERM/EACCES/EBUSY
 *   而**不是** EEXIST —— 实测 60 轮里撞到 1 次。旧实现把它归入"不可重试"，一次就降级
 *   （等于这次写完全没受锁保护）；按占用重试才是对的。fail-open 语义不变：重试耗尽仍降级写入。
 */
const RETRYABLE_OPEN_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ETXTBSY'])

/**
 * 尝试获取跨进程锁。
 *
 * @returns {{ok: true, lockPath: string, stale?: boolean} | {ok: false, reason: string, lockPath: string, heldBy?: object|null, staleMs?: number}}
 *   **不抛错** —— 所有异常都折成 `{ok:false}`，由调用方 fail-open。
 */
export async function acquireLock(dataFile, {
  staleMs = DEFAULT_STALE_MS,
  retries = DEFAULT_RETRIES,
  backoffMs = DEFAULT_BACKOFF_MS,
  onWarn = () => {},
} = {}) {
  const lockPath = lockPathFor(dataFile)
  const body = lockBody()
  try {
    await fs.mkdir(path.dirname(dataFile), { recursive: true })
  } catch (e) {
    // 目录建不出来 → 明确告警后降级（调用方会照旧写，让写盘自己报错/成功）
    onWarn(`[mnemos-lock] 锁目录不可用，跳过跨进程锁（降级写入）：${e && e.message}`)
    return { ok: false, reason: 'mkdir-failed', lockPath }
  }

  let stolenOnce = false   // ★ 本次获取是否已抢过一次（抢第二次即让位，避免两个进程反复互删）
  let waited = 0
  let sawRetryableOpen = null // 记下"创建锁文件时反复收到的瞬时错误码"（仅用于把告警说准）

  for (let i = 0; i <= retries; i++) {
    let busy = false
    try {
      // ★ 'wx'：文件已存在则失败 → 对同一路径的两个进程天然只有一个能创建成功
      const fh = await fs.open(lockPath, 'wx')
      try {
        await fh.writeFile(body, 'utf8')
      } catch (e) {
        // 内容写失败（磁盘满等）→ 不当作持锁，清掉残留再降级
        try { await fh.close() } catch {}
        try { await fs.rm(lockPath, { force: true }) } catch {}
        onWarn(`[mnemos-lock] 锁文件写入失败，跳过跨进程锁（降级写入）：${e && e.message}`)
        return { ok: false, reason: 'write-failed', lockPath }
      }
      await fh.close()

      // ★ 自检：确认磁盘上那把锁真的是**我**的。
      //   必要性：抢陈旧锁时可能"两个进程都判定它陈旧、都去删、都重建"，
      //   最后建的人才是真持锁者；先建的人若不复核就会以为自己拿到了锁 → 双持锁。
      //   复核把窗口从"open 到 writeFile 之间"压到一次读+比（Windows 上 stat 的 mtime
      //   还要等 NTFS 元数据刷写才可见，仅靠 stat 不够，所以以文件内容为准）。
      let mine = true
      try {
        mine = (await fs.readFile(lockPath, 'utf8')) === body
      } catch {
        mine = false
      }
      if (mine) return stolenOnce ? { ok: true, lockPath, stale: true } : { ok: true, lockPath }
      busy = true // 被别人换掉了 → 当作没拿到，按占用处理
    } catch (e) {
      const code = e && e.code
      if (code === 'EEXIST') {
        busy = true
      } else if (RETRYABLE_OPEN_CODES.has(code)) {
        // ★ F-16：Windows 下这几种是**瞬时**的（别人正删除/替换同名锁文件），按"被占用"重试，
        //   而不是一次就判定不可重试、直接降级（那会让这次写完全不设防）。
        busy = true
        sawRetryableOpen = code
      } else {
        // 权限不足 / 路径非法等（非瞬时）→ 不可重试
        onWarn(`[mnemos-lock] 无法创建锁文件（降级写入）：${code} ${e && e.message}`)
        return { ok: false, reason: 'open-failed', lockPath }
      }
    }

    if (busy) {
      // ★ F-16：四态判定（旧实现是"stat 失败即陈旧"，会把"刚被释放"误报成"崩溃残留"）
      const state = await probeLock(lockPath, staleMs)
      if (state === LOCK_MISSING) {
        // 持有者刚刚正常释放 → 不是陈旧、不是失败：不抢占、不告警、不记 stolen，立刻重试建锁。
        continue
      }
      if (state === LOCK_STALE) {
        if (!stolenOnce) {
          let heldBy = null
          try { heldBy = JSON.parse(await fs.readFile(lockPath, 'utf8')) } catch {}
          try {
            await fs.rm(lockPath, { force: true })
            onWarn(
              `[mnemos-lock] 锁文件已陈旧（mtime 超过 ${staleMs}ms，疑似崩溃残留），已抢占：` +
              `${lockPath} 原持有者=${heldBy ? `pid ${heldBy.pid}@${heldBy.host}` : '内容不可读'}`
            )
          } catch (rmErr) {
            onWarn(`[mnemos-lock] 陈旧锁删除失败（降级写入）：${rmErr && rmErr.message}`)
            return { ok: false, reason: 'steal-failed', lockPath }
          }
          stolenOnce = true
          continue // ★ 不 sleep：刚删掉，立刻重试建锁
        }
        // 抢过一次还是被占 → 别再来回删（会让双方都不断重建），直接让位给 fail-open
        onWarn(`[mnemos-lock] 抢占陈旧锁后仍被占用，不再抢占（降级写入）：${lockPath}`)
        return { ok: false, reason: 'stolen-twice', lockPath }
      }
      // fresh / unknown → 退避重试。
      //   ★ unknown（stat 拿不到、又不是 ENOENT）刻意**不抢占**：抢占的依据是"mtime 确实超龄"
      //     这个证据，没有证据就只能等；重试耗尽后照旧 fail-open 写下去，写不进去的风险没变大。
    }

    if (i === retries) break
    const d = backoffMs[Math.min(i, backoffMs.length - 1)] ?? 100
    waited += d
    await sleep(d)
  }

  let heldBy = null
  try { heldBy = JSON.parse(await fs.readFile(lockPath, 'utf8')) } catch {}
  if (sawRetryableOpen && !heldBy) {
    onWarn(
      `[mnemos-lock] 创建锁文件时反复收到 ${sawRetryableOpen}（通常是别的进程正在删除/替换该锁文件）`
    )
  }
  return { ok: false, reason: 'timeout', lockPath, heldBy, staleMs, waitedMs: waited }
}

/**
 * 释放锁。**只在仍由自己持有时删除**（比对 body），
 * 避免删掉"我误判为陈旧而抢走、但其实是别人新锁"的文件。
 * 不抛错：释放失败不该让一次成功的 save 变成失败。
 */
export async function releaseLock(dataFile) {
  const lockPath = lockPathFor(dataFile)
  try {
    const cur = await fs.readFile(lockPath, 'utf8')
    const mine = JSON.parse(cur)
    if (mine && mine.pid === process.pid && mine.host === os.hostname()) {
      await fs.rm(lockPath, { force: true })
    }
  } catch {
    // 文件已不在 / 内容不可读 → 无事可做
  }
}

/**
 * 按 id 合并两份记录集 —— **三方合并**，而不是"按 recency 取大者"。
 *
 * 为什么不能只按 recency 取大者（实测反例，见 test 77 第 ⑥ 条）：
 *   recency 是**存在记录里**的字段，所以"我读到的旧副本"和"别人刚改好的新副本"
 *   在合并时根本区分不出来。反例：B 读到 recency=T 的副本 → A 把该条作废
 *   （作废 appjs 只改 source/version/deprecatedAt，**不动 recency**）→
 *   B 一保存，`bT > aT` 为假，于是保留 B 的旧副本 → **A 的作废被静默回滚**。
 *   同理 `layer` 衰减、`dormIn` 标记都会被旧副本回滚。
 *
 * 三方判定（base = 本进程 load 那一刻的原样）：
 *   ① 只有 disk 侧变过 → 取 disk（别人的改动生效）
 *   ② 只有 mine 侧变过 → 取 mine（我的改动不被别人的旧副本回滚）
 *   ③ 两侧都没变过 → 取 disk，让重放收敛
 *   ④ 两侧都变过 → 靠 recency 裁决（真冲突；平局取 disk，保证可收敛）
 *
 * @param {Map<string, object>} base 本进程内存视图（按 id）
 * @param {object[]} diskArr 磁盘上的记录
 * @param {Map<string, string>} baseline id → load 时的 JSON 串（可省略 = 退化为按 recency 取大者）
 * @returns {Map<string, object>} 合并结果
 */
export function mergeMemories(base, diskArr, baseline = new Map()) {
  const merged = new Map(base)
  const fp = (r) => JSON.stringify(r)
  for (const rec of Array.isArray(diskArr) ? diskArr : []) {
    if (!rec || typeof rec.id !== 'string') continue
    const key = fp(rec)
    const mine = merged.get(rec.id)
    if (!mine) { merged.set(rec.id, rec); continue }
    if (mine === rec) continue

    const baseJson = baseline.get(rec.id)
    const mineChanged = baseJson === undefined || fp(mine) !== baseJson
    const diskChanged = baseJson === undefined || key !== baseJson

    if (diskChanged && !mineChanged) { merged.set(rec.id, rec); continue }  // ①
    if (mineChanged && !diskChanged) continue                              // ②
    if (!mineChanged && !diskChanged) { merged.set(rec.id, rec); continue } // ③

    // ④ 真冲突：recency 大者胜（createdAt 兜底）；平局取磁盘侧以便收敛
    const mineT = mine.recency || mine.createdAt || 0
    const diskT = rec.recency || rec.createdAt || 0
    if (diskT > mineT) merged.set(rec.id, rec)
  }
  return merged
}

/**
 * 原子替换写：先写 `<target>.tmp` 再 rename 覆盖。
 * rename 前**不 unlink** —— POSIX 上 rename 直接覆盖；Windows 上 Node 用的是
 * MoveFileExW(REPLACE_EXISTING)，也能覆盖。若目标被别的程序独占而失败，交给调用方处置。
 *
 * ★ F-16：rename 会**瞬时**失败 —— Windows 上目标文件刚好被另一个句柄打开/删除时，
 *   MoveFileExW 抛 EPERM/EACCES/EBUSY（同一台机器上两个实例同时写就会撞上）。
 *   旧实现一次失败就直接抛给调用方（整次保存失败）。这里对这几种码做有界重试；
 *   其余错误（路径非法、磁盘满…）立刻抛，**不改变失败语义**：重试耗尽照旧抛出。
 *
 * 无论成功失败都不留 `.tmp`：成功时它已被 rename 掉，失败时在这里主动清掉
 * （否则磁盘上会积累一堆半截文件；测试 81 断言这一点）。
 */
export async function atomicWriteFile(target, text) {
  const tmp = `${target}.tmp`
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(tmp, text, 'utf8')
  let lastErr = null
  for (let attempt = 0; attempt <= RENAME_RETRY_MS.length; attempt++) {
    try {
      await fs.rename(tmp, target)
      return
    } catch (e) {
      lastErr = e
      if (!RETRYABLE_RENAME_CODES.has(e && e.code) || attempt === RENAME_RETRY_MS.length) break
      await sleep(RENAME_RETRY_MS[attempt])
    }
  }
  try { await fs.rm(tmp, { force: true }) } catch {}
  throw lastErr
}

/** 读墓碑表（缺失/损坏一律当作空表 —— 墓碑读不出来不该阻塞任何写入）。 */
export async function readTombstones(dataFile) {
  try {
    const raw = await fs.readFile(tombstonePathFor(dataFile), 'utf8')
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      if (typeof k === 'string' && k) out[k] = Number(v) || 0
    }
    return out
  } catch {
    return {}
  }
}

/** 合并墓碑表：同 id 取较晚的 deletedAt。 */
export function mergeTombstones(a, b) {
  const out = { ...(a || {}) }
  for (const [k, v] of Object.entries(b || {})) {
    const t = Number(v) || 0
    if (!(k in out) || t > out[k]) out[k] = t
  }
  return out
}

/**
 * 墓碑上限裁剪：超出 max 条时按 deletedAt 淘汰**最旧**的。
 * 注意这是有损的 —— 被裁掉的墓碑若对应的旧副本还在某个进程内存里，那条记录仍可能被合并复活。
 * 因此 max 取足够大（默认 2000），且淘汰的必然是最老的删除。
 * @returns {{table: object, evicted: number}}
 */
export function capTombstones(table, max = MAX_TOMBSTONES) {
  const keys = Object.keys(table || {})
  if (keys.length <= max) return { table: { ...(table || {}) }, evicted: 0 }
  keys.sort((x, y) => (table[y] || 0) - (table[x] || 0)) // 新→旧
  const kept = keys.slice(0, max)
  const out = {}
  for (const k of kept) out[k] = table[k]
  return { table: out, evicted: keys.length - max }
}

/** 写墓碑表（原子替换 + 确定性 key 顺序，便于人工 diff）。 */
export async function writeTombstones(dataFile, table) {
  const sorted = {}
  for (const k of Object.keys(table || {}).sort()) sorted[k] = table[k]
  await atomicWriteFile(tombstonePathFor(dataFile), JSON.stringify(sorted, null, 2))
}

/** 清掉数据文件旁边可能残留的 .tmp（测试 81 用；正常路径下 atomicWriteFile 已自清）。 */
export async function cleanTmp(dataFile) {
  try { await fs.rm(`${dataFile}.tmp`, { force: true }) } catch {}
  try { await fs.rm(`${tombstonePathFor(dataFile)}.tmp`, { force: true }) } catch {}
}
