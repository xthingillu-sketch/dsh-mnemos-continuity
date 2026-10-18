/**
 * 启动痕迹落**文件**（F-17）。
 *
 * 为什么非要有这个文件：F-3 让插件把"本轮解析到的 dataFile/constitutionFile/解析依据"
 * 打了出来，但出口是 `ctx.logger.info → ctx.get('logger').info → console.info`。
 * 持有者实测：重启后在 DSH 的任何日志文件里**搜不到**这一行（0 命中）—— 于是
 * "启动时到底读了哪个文件"这件事**依然无法验证**。打印了却看不见，等于没打印。
 *
 * 做法：**双写**。原来那条 logger 链路一字不动（它在有 logger 的宿主里是有用的），
 * 另外**追加**一份到 `<dataFile 同目录>/mnemos.log`：那是插件自己的数据目录，
 * 一定能写、一定找得到，与宿主日志是否落盘无关。
 *
 * 三条纪律（都是踩过的坑，不是洁癖）：
 *   ① best-effort：**写日志失败绝不许影响启动**（try/catch 吞掉，只往 console 说一声）。
 *   ② 滚动上限：文件超过 MAX_BYTES 就只留**最后 KEEP_BYTES**（否则跑几个月变成大文件）。
 *      只留尾部而不是整删 —— 整删会把"上一次启动痕迹"也清掉。
 *   ③ 每行带时间戳，且**一次启动 = 一次写入**：这样三条线不会被别的启动插进来割裂。
 *
 * ⚠️ 本文件刻意**不 import 任何宿主依赖**（与 self-text.js 同样的理由）：
 *    index.js 里有 `@deepseek-ai/schemastery`，单测 import 不了它 ——
 *    而"日志到底写没写、写失败会不会抛"恰恰是必须被断言的部分。
 *    所以取 logger、滚动、追加都放这里，index.js 只负责调用。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

/**
 * 超过它就滚动一次。
 *
 * ★ 这个数（1MB）是**拍的**，不是量出来的：同目录的 memory.json 已经 1.06MB，
 *   而 256KB 只装得下几百次启动 —— 滚得太勤，反而把"上次/上上次启动"一起滚没了。
 *   取 1MB = 与数据文件同量级，够翻很多次启动痕迹，又不至于让日志成为大文件。
 *   （持有者认可的理由就这一条：滚动窗口要能覆盖记忆体本身的规模。）
 */
export const MAX_BYTES = 1024 * 1024
/**
 * 滚动后保留的尾部字节数 = 上限的一半（同为拍的：留一半够翻好几次启动，
 * 又保证文件确实被削小；只留尾部而不是整删，见本文件顶部纪律②）。
 */
export const KEEP_BYTES = MAX_BYTES / 2

/** 取宿主日志出口：ctx.logger → ctx.get('logger') → console。任一步不可用都不许抛错。 */
export function pickLogger(ctx) {
  const candidates = []
  try { candidates.push(ctx && ctx.logger) } catch { /* getter 可能抛错 */ }
  try { candidates.push(ctx && typeof ctx.get === 'function' ? ctx.get('logger') : undefined) } catch { /* 同上 */ }
  for (const c of candidates) {
    if (c && typeof c.info === 'function') return c
  }
  return console
}

/**
 * 日志文件位置：**与 dataFile 同目录**（插件自己的数据目录，确定可写）。
 * 显式传 logFile 时用显式值（单测/排查用）。
 */
export function pickLogFile(dataFile, explicit) {
  if (explicit) return explicit
  if (!dataFile) return null
  return path.join(path.dirname(String(dataFile)), 'mnemos.log')
}

/**
 * 滚动：文本超过 `maxBytes` → 只保留**末尾若干完整行**，并从**行边界**起（不留半个行）。
 * 返回 `{ text, rolled }`。没超就原样返回（`rolled:false`，内容一字不动）。
 *
 * 不变量（两条，都是为了"下次还看得懂"）：
 *   ① 结果**结尾**与原文一致（留的是尾部，不是开头/中段）；
 *   ② 结果由**完整行**组成、不出现半个多字节字符（UTF-8 边界安全）。
 * 代价：单行特别长时结果可能略大于 `maxBytes`（要到下一个换行才收手）——
 *   宁可留整行也不留半个行；下界由 `keepBytes` 保证（至少留这么多，再往前补到行首）。
 */
export function rollText(text, { maxBytes = MAX_BYTES, keepBytes = KEEP_BYTES } = {}) {
  const s = String(text ?? '')
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { text: s, rolled: false }
  const buf = Buffer.from(s, 'utf8')
  const bound = Math.max(0, Math.min(keepBytes, maxBytes - 1))
  // ① 从"最后 bound 字节"往上翻第一个换行 —— 不能从中间切字符/切行
  let q = Math.max(0, buf.length - bound)
  while (q > 0 && buf[q - 1] !== 0x0a) q--
  // ② 从 q 起收集完整行
  let pos = q
  const lines = []
  while (pos < buf.length) {
    let nl = buf.indexOf(0x0a, pos)
    if (nl === -1) nl = buf.length
    lines.push(buf.subarray(pos, nl))
    pos = nl + 1
  }
  // ③ 全留会太大 → 从**前面**丢行（先丢最旧的），直到不超过 maxBytes - 1
  let total = lines.reduce((a, l) => a + l.length + 1, 0) - 1
  let first = 0
  while (first < lines.length - 1 && total > maxBytes - 1) {
    total -= lines[first].length + 1
    first++
  }
  let picked = lines.slice(first)
  let b = Buffer.concat(picked.map((l) => Buffer.concat([l, Buffer.from('\n')])))
  if (picked.length) b = b.subarray(0, b.length - 1) // 去掉末尾多余的换行
  // ④ 兜底：若首行仍从多字节字符中间开始（续字节 0x80~0xBF），退到下一个换行之后
  if (b.length && b[0] >= 0x80 && b[0] <= 0xbf) {
    const nl = b.indexOf(0x0a)
    b = nl === -1 ? Buffer.alloc(0) : b.subarray(nl + 1)
  }
  return { text: b.toString('utf8'), rolled: true }
}

/**
 * 追加一份启动痕迹（best-effort）。
 *
 * @param {{text:string, logFile?:string|null, ctx?:any, now?:()=>Date, onError?:(e:any)=>void}} o
 * @returns {Promise<{written:boolean, logFile:string|null, rolled?:boolean, error?:string}>}
 *          **永不 reject** —— 调用方可以 `void` 掉，也可以 await 拿结果（单测用）。
 */
export async function appendStartupLog({ text, logFile = null, ctx = null, now = () => new Date(), onError = null } = {}) {
  const say = (m, e) => {
    try {
      const f = pickLogger(ctx)
      if (typeof f.error === 'function') f.error(m, e)
      else if (typeof f.info === 'function') f.info(`${m} ${e && e.message ? e.message : e}`)
    } catch { /* 连报错都喊不出去就算了 —— 绝不许影响启动 */ }
  }
  try {
    if (!logFile) return { written: false, logFile: null }
    await fsp.mkdir(path.dirname(logFile), { recursive: true })
    // 滚动：先看当前大小，超了才读全文（正常每次都是一次 stat，代价可忽略）
    let rolled = false
    try {
      const st = await fsp.stat(logFile)
      if (st.size > MAX_BYTES) {
        const old = await fsp.readFile(logFile, 'utf8')
        const r = rollText(old)
        await fsp.writeFile(logFile, r.text, 'utf8')
        rolled = r.rolled
      }
    } catch { /* 文件不存在（首次）：正常 */ }
    const stamp = now().toISOString()
    // 每行都带时间戳：多行共用同一个时间戳表示"同一次启动"
    const body = String(text ?? '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => `[${stamp}] ${l}`)
      .join('\n')
    await fsp.appendFile(logFile, body + '\n', 'utf8')
    return { written: true, logFile, rolled }
  } catch (e) {
    // ★ 失败绝不许抛：只报告（F-17 验收明确要求"写失败不抛错"）
    say('mnemos: 启动日志追加失败（不影响启动）', e)
    if (typeof onError === 'function') { try { onError(e) } catch { /* 同上 */ } }
    return { written: false, logFile, error: String((e && e.message) || e) }
  }
}
