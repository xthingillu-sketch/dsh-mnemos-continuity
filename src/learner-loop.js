/**
 * dsh-mnemos 空闲学习：把"到点踢一脚"送进一个**专用会话**，由它自己去学。
 *
 * ★ 为什么必须是它（而不是往当前上下文注入一句话）：
 *   往当前上下文注入 = 把空闲信息塞进一个正在做事的上下文里 —— 既打扰当前任务，
 *   也容易被当成背景噪音忽略。宿主提供了正确的通道：agent 的 **inbox**。
 *
 * ★ 接口依据（都在宿主源码里核过，不是猜的）：
 *   - `ctx.agents.get(id)` / `ctx.agents.create({ sessionId, agentOptions, meta, setup })`
 *     （@deepseek-ai/dsh-agent，create 委托 factory）
 *   - `handle.agent.followup(input)` → 内部 `send(input, 'next-turn', true)`：**入队并唤醒 driver**
 *   - `handle.agent.whenIdle()` → 等整个 agent 静默（空闲判据就在这里）
 *   - `handle.agent.steer/inject/cancel`（本模块**不用** cancel）
 *
 * ★ 三条自律（写在这里，别改）：
 *   1. **绝不调用 `dispose()`** —— 它是唯一能"移除会话"的路（会真删掉学习记录）。本模块不 import 它。
 *   2. **结论靠记忆，不靠会话**：这个会话只是草稿纸，被删/被清都无所谓；
 *      所以**不需要 resume**，也不需要恢复历史 —— get 不到就 create 一个新的。
 *   3. **不打扰**：agent 在忙（未 idle）就跳过本次，绝不 steer/inject 打断它。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
// ★ 注入消息的唯一构造点（role/id 一起补齐）。详见 host-message.js 文件头的事故记录。
import { buildInjectedUserMessage } from './host-message.js'

/** 诊断工具的名字（供 index.js 引用：让这串字面量**只在 toolDefs 注册处出现一次**）。 */
export const LEARNER_TOOL_NAME = 'mnemos_learner_kick'

/** 专用会话的默认 id（固定，便于代码定位；名字表示"用途"而非"某个人"）。 */
export const DEFAULT_LEARNER_SESSION_ID = 'mnemos-learner'

/**
 * ★ 默认的 `agentPreset` —— **它决定这个 agent 挂哪些子插件，工具集就从这些插件来**。
 *
 * 实测：不放它时 learner agent 只有 18 个工具（记忆 + context7 + 两个宿主只读工具），**没有联网工具**；
 * （v1.6 后实际 31 个；18 是当时基线，别当当前值。）
 * 而本会话（`agentPreset: "standard"`）有 44 个工具、含 `web_search` / `web_fetch`。
 * 后果很实在：**不能联网的"学习"是跛脚的** —— 用户当场指出了这一点。
 */
export const DEFAULT_LEARNER_AGENT_PRESET = 'standard'

/** 默认间隔：**1 小时**（用户最初的要求）。0 = 关掉（由配置项控制）。 */
export const DEFAULT_LEARNER_INTERVAL_MS = 60 * 60 * 1000

/** 等待"跑完"的上限：超过就不再等（不取消它，只是本次心跳不再阻塞）。 */
export const DEFAULT_WAIT_LIMIT_MS = 10 * 60 * 1000

/** 任务文件默认文件名（与 memory.json 同目录）。 */
export const LEARNER_TASKS_FILENAME = 'learner-tasks.md'

/**
 * 任务文件首次生成时的模板。
 * ★ 说明整段包在 **HTML 注释** 里：读取时会剥掉注释，所以你**写的内容**才会被送进模型，
 *   模板本身不会变成"噪音任务"。写在注释之后的任何文字都算你的任务。
 */
export const LEARNER_TASKS_TEMPLATE = `<!--
这是「空闲学习」的任务文件（可自由编辑，随便改）。

· 你在下面写的内容，会在每次到点踢模型时**原样**送给它。
· 放的是**开放学习类**的事，不是明确工单 —— 比如"把 X 弄明白""搞清楚 Y 为什么慢"。
· 不用管"做完没做完"：它每轮都会读一遍，也会自己翻记忆，不会因为没删就重复做同一件事。
· 想让它别再做某件事，**你把那段删掉**即可（这个文件在它的工作区之外，它写不到这里；
  这是沙箱挡住的，不是"它没有写文件的能耐"）。
· 这里全是说明，整段是个 HTML 注释 —— 你在**注释结束之后**写任务。

写完后不用再做什么，到点它会自己看到。
-->

`

/**
 * 任务文件路径：与 `memory.json` **同目录**（用户好找，和台账/状态文件一个习惯）。
 */
export function learnerTasksFileFor(dataFile) {
  return path.join(path.dirname(dataFile), LEARNER_TASKS_FILENAME)
}

/**
 * 确保任务文件存在（首次自动生成带说明的模板）。**绝不覆盖已有文件**。
 * @returns true = 本次新建了
 */
export async function ensureLearnerTasksFile(file) {
  try {
    await fs.access(file)
    return false
  } catch { /* 不存在 → 建 */ }
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, LEARNER_TASKS_TEMPLATE, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 读任务文件。**剥掉 HTML 注释**（模板说明就藏在注释里），只回用户真正写的内容。
 * @returns {{tasks: string, error: string|null}}
 */
export async function readLearnerTasks(file) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return { tasks: raw.replace(/<!--[\s\S]*?-->/g, '').trim(), error: null }
  } catch (e) {
    if (e?.code === 'ENOENT') return { tasks: '', error: null } // 没这个文件 = 没有任务
    return { tasks: '', error: String(e?.message || e) }
  }
}

/**
 * 那一脚的内容 —— 少量提示词，故意**不规定学什么**，并**显式允许零产出**。
 *
 * ★ 任务文件由**代码读进来内联**在这里，不让模型自己去读文件：
 *   learner agent 没有任何文件工具（实测它的工具集是 context7/记忆/只读审计），
 *   所以"你自己去读那份文件"在这条链上是做不到的 —— 内联反而更简单、必定可见。
 *
 * @param {{tasks?: string, tasksFile?: string, tasksReadFailed?: string}} [deps]
 */
export function buildLearnerMessage(deps = {}) {
  const { tasks = '', tasksFile = '', tasksReadFailed = '' } = deps
  const hasTasks = tasks.trim().length > 0
  const lines = [
    '【空闲学习时间】现在没有等你处理的用户请求，这一轮由你自己安排。',
    '',
    '【先看这里】用户在任务文件里给你留的东西：',
    `文件：${tasksFile || '(未配置)'}`,
  ]
  if (tasksReadFailed) {
    lines.push(`（读这个文件失败了：${tasksReadFailed}）`)
  } else if (hasTasks) {
    lines.push('内容如下：')
    lines.push('')
    lines.push(tasks.trim())
  } else {
    lines.push('（文件是空的，或只有说明文字 —— 这一轮没有指定任务）')
  }
  lines.push('')
  lines.push('【怎么做】')
  lines.push('- 上面**有**要做的 → 就做它；')
  lines.push('- 上面**没有** → 做默认的空闲任务：学点你想弄明白的东西（最近做过的、卡过的、或纯粹好奇的都行）；')
  lines.push('- 也可以**什么都不做** —— 直接回一句「这次不学」就算处理完了，不会有人催你。')
  lines.push('- **不要申请提权/审批**：用户不在旁边，提权请求会把这一轮卡住；需要提权的操作直接跳过，并在回报里说明原因。')
  lines.push('')
  lines.push('【结束后】用**一两句话**简短回报你做了什么、有什么结论就够了，不要长篇大论。')
  lines.push('若有值得跨会话留住的结论，用记忆工具写下来（会话本身随时可能被清掉）。')
  return lines.join('\n')
}

/**
 * 取（或建）那个专用 agent。
 * ★ 三级兜底 **get → resume → create**：
 *   - `get`：本次进程里活着的就复用。
 *   - **`resume`：把"已落盘但当前没活着"的会话恢复成活着的 agent** —— 这一级不能省：
 *     宿主 GUI 打开会话要先"查得到"（否则报 `session/not-found`）。我原先按
 *     "会话是草稿纸、丢了不心疼"就**不 resume**，结果重启后那个会话在 GUI 里打不开 —— 设计漏了一半。
 *   - `create`：确实不存在（或 resume 失败，比如被删了）→ 建一个新的。
 *   `resume` 失败不抛，直接落到 `create`（这正是"被删掉就自建"的路径）。
 */
export async function ensureLearnerAgent(agents, opts = {}) {
  const sessionId = opts.sessionId ?? DEFAULT_LEARNER_SESSION_ID
  const agentOptions = opts.agentOptions ?? {}
  const meta = opts.meta

  // ① get：活着的就复用
  let agent = null
  let getError = null
  try {
    agent = agents.get?.(sessionId) ?? null
  } catch (e) {
    getError = 'get-failed: ' + (e?.message || e)
  }
  if (agent) return { agent, created: false, resumed: false, getError }

  // ② resume：让它重新"活着"（GUI 才查得到）
  // ★★ 字段名是 **`resumeSessionId`**，不是 `sessionId` —— 这是**读宿主源码**得到的结论
  //    （dsh-agent-loop：`async resumeWith(ownerCtx, persistence, options) { const id = options.resumeSessionId; … }`），
  //    而且两者**互斥**（`sessionId and resumeSessionId are mutually exclusive`）。
  //    传错的后果：id 变成 undefined → `persistence.open(undefined)` →
  //    `Cannot read properties of undefined (reading 'length')` → resume 永远失败 → 每次踢都新建一个会话。
  // ★ 2026-10-17：换了新 id（回收/重启后重建）时**不要 resume** —— 磁盘上没有它，resume 只会白失败一次；
  //   更重要的是：resume 出来的旧会话补不上 preset（宿主锁定首轮），工具集会退化。
  //   所以 `opts.skipResume` 时直接落到 create（新会话 = created=true = 一定选 preset）。
  // ★★ 2026-10-18：resume 是"工具集再次退化"的高风险面（**非唯一来源**，归因见下方修正），默认**关掉**。
  //   这里旧版写成"实测"的归因已被反证：曾说"04:51 定时踢回退老路 → resume 了**宿主代建**出来的
  //   子会话（UUID id）→ preset 没重新挂上 → 退化成只剩 mnemos + context7"。但那次 resume 正是
  //   kick#62 本身：该轮实测工具集**完整**（read/glob/grep/write/联网全在场，日志与源码都是它读的）。
  //   修正：宿主代建会话的完整工具集是创建时从父 agent 带来的、不依赖 preset，resume 不会让它退化；
  //   真实退化（10-17 第 17 轮，mnemos-learner-1）是"插件自建、工具全靠 agentPreset.select 挂上"的
  //   命名会话跨重启被 resume —— select 只允许首轮之前调用，恢复后补不上 → 退化成最小基线。
  //   默认关 resume 依然正确：两种形态一次封死，不必赌"这个会话是哪一种"。
  //   用户的规则一直是"会话是草稿纸，结论都在记忆里" —— 那就不需要 resume：
  //   **每一脚都用 create 起一个全新的**（created=true 才会选 preset）。要 resume 必须显式 `allowResume: true`。
  //   修复后实测：kick#63（10-18 05:23）走 create+select 建出 mnemos-learner-9，该轮工具集实测完整。
  if (opts.allowResume === true && !opts.skipResume && typeof agents.resume === 'function') {
    try {
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        ...(meta ? { meta } : {}),
      })
      const a = handle?.agent ?? handle
      if (a) return { agent: a, created: false, resumed: true, getError }
    } catch (e) {
      // 落回 create（会话确实不存在、或持久化不可用）
      getError = (getError ? getError + ' | ' : '') + 'resume-failed: ' + (e?.message || e)
    }
  }

  // ③ create：自己建（不需要用户手动开一个对话）
  //
  // ★★ 冲突处理（用户明确要求"不然每次调用都会堆出一个新对话"）：
  //   磁盘上可能残留同名会话（前几次失败/被中断留下的），此时 resume 会失败、create 会报
  //   "session ... already exists"。**旧的兜底是"换一个 id 再建"——那正是会话越堆越多的根源**
  //   （mnemos-learner → -2 → -3 …），已废弃。
  //   现在改为：**先清掉同名的残留（会话目录 + 投影缓存），再用同一个 id 重建**。
  //   依据：用户已明确授权——"会话被删了、重建后连消息都不需要恢复"；结论都在记忆里。
  //   只在 `get()` 取不到（即它当前**不活着**）时才会走到这里，所以不会误删活着的会话。
  let lastError = null
  let staleRemoved = 0
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await agents.create({ sessionId, agentOptions, ...(meta ? { meta } : {}) })
      const a = handle?.agent ?? handle
      if (!a) return { agent: null, created: false, error: 'create-returned-no-agent', getError, sessionId }
      return { agent: a, created: true, resumed: false, getError, sessionId, staleRemoved }
    } catch (e) {
      lastError = e?.message || String(e)
      if (!/already exists/i.test(String(lastError))) break
      if (attempt === 0 && typeof opts.removeStale === 'function') {
        // 只有"同名残留"这一种可绕过的冲突才清；清完再试一次**同一个 id**
        try {
          staleRemoved = await opts.removeStale(sessionId)
        } catch (e2) {
          getError = (getError ? getError + ' | ' : '') + 'removeStale-failed: ' + (e2?.message || e2)
          break
        }
        if (!staleRemoved) break // 什么都没清掉，再试也是白试
      } else break
    }
  }
  return { agent: null, created: false, error: 'create-failed: ' + lastError, getError, staleRemoved }
}

/** 带超时的等待（不改动对方，只是不再阻塞本次心跳）。 */
async function waitIdle(agent, limitMs) {
  if (typeof agent.whenIdle !== 'function') return { waited: false, reason: 'no-whenIdle' }
  let timer = null
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), limitMs) }),
    ])
    return { waited: true }
  } catch (e) {
    return { waited: false, reason: 'whenIdle-threw: ' + (e?.message || e) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 状态文件（与 memory.json 同级）：只记"上次踢的时间"和累计次数。
 * 为什么要落盘：心跳重启后会从 0 开始，不记就会重启即踢。
 */
export function learnerStateFileFor(dataFile) {
  return path.join(path.dirname(dataFile), 'learner-state.json')
}

/** 状态里最多保留多少代"已退休"的会话 id（供"它不活着时顺手清文件"）。 */
const MAX_RETIRED_IDS = 20

/**
 * 把**磁盘上的任意形状**归一成状态对象 —— 容错都在这一处，别让调用方各写一份。
 *
 * 为什么要归一层：状态文件是用户可见、可手改的；缺字段/写错类型都不该让踢的流程炸掉。
 * `activeSessionId` 为空 = 还没回收过，用配置的基础 id。
 */
export function normalizeLearnerState(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const retired = Array.isArray(src.retired)
    ? src.retired.filter((x) => typeof x === 'string' && x.length > 0)
    : []
  const num = (v, d = 0) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : d
  }
  return {
    lastKickAt: Number(src.lastKickAt) || 0,
    kicks: num(src.kicks),
    activeSessionId: typeof src.activeSessionId === 'string' ? src.activeSessionId : '',
    recycled: num(src.recycled),
    retired: retired.slice(-MAX_RETIRED_IDS),
    kicksSinceRecycle: num(src.kicksSinceRecycle),
  }
}

export async function loadLearnerState(file) {
  try {
    return normalizeLearnerState(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch (e) {
    if (e.code === 'ENOENT') return normalizeLearnerState({})
    throw e
  }
}

export async function saveLearnerState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

/** 诊断日志（与 memory.json 同级）：**面向使用者排错** —— console.warn 看不到，必须落盘。 */
export function learnerLogFileFor(dataFile) {
  return path.join(path.dirname(dataFile), 'learner.log')
}

/** 追加一行诊断。任何失败都不抛：诊断绝不能反过来咬主流程。 */
export async function appendLearnerLog(file, line) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch { /* 忽略 */ }
}

/**
 * 会话工作目录（**核实过**：`SessionStore.prepare` 从 `meta.cwd` 取，写进会话头，
 * 必须是绝对路径 —— 没有它就会被分到 `_no-cwd` 那个"未分组工作区"，GUI 里很别扭）。
 *
 * 取值顺序：
 *   ① 配置显式给的 `learnerWorkspace`
 *   ② DSH 的默认工作区（`~/Documents/deepseek-harness/default-workspace`，实际见过这个目录）
 *   ③ 插件进程的当前目录
 * 都不存在时返回 null（那就不传 meta，退回旧行为 —— 宁可分组难看，也不要乱指路径）。
 */
export function resolveLearnerWorkspace(configured, env = {}) {
  const fsSync = env.existsSync ?? (() => false)
  if (configured && typeof configured === 'string') return configured
  if (env.defaultWorkspace && fsSync(env.defaultWorkspace)) return env.defaultWorkspace
  if (env.cwd && fsSync(env.cwd)) return env.cwd
  return null
}

/* ─────────────────── 会话回收：每 5 轮 / 上下文过长 → 删掉重建 ───────────────────
 *
 * ★ 为什么需要它（2026-10-17 实测事故）：那个专用会话通宵跑了 14 轮，日志涨到**压缩 620KB /
 *   解压 1.90MB 字符**，第 13、14 轮**整轮**被宿主拒（`pi-ai detected context overflow`,
 *   `code=CONTEXT_WINDOW_EXCEEDED`）→ 会话永久卡死（只要再踢就继续失败）。
 *   外在表现像"工具失败"，实际工具**全部成功（0 条 isError）**，是整轮在发出请求前就死了。
 *
 * ★ 最后采用**最简单**的规则（用户 2026-10-17 拍板）：
 *   ① **每踢满 5 轮**，下一次调用就换一个新会话（结论都在记忆里，会话只要留最近 5 轮能看到）；
 *   ② 另加一个上下文上限（日志 350KB）：太大也直接换。
 *   不去判断"声明的窗口准不准"、也不去量 token —— 数轮数不会骗人。
 *
 * ★ 为什么"重建 = 换一个新会话 id"，而不是删文件：
 *   ① 本模块硬约束**绝不调用 `dispose()`**（它是唯一能移除会话的路，模块根本不 import 它）；
 *   ② learner agent 在**同一个 DSH 进程内一直活着被复用**（kick 回执 `created:false, resumed:false`
 *      就是证据）→ 历史在**内存**里，**删磁盘文件并不能让它变短**。
 *   所以：换 id（`<base>-<n>`），旧代**只在"它确实不活着"时**才顺手清文件（尊重"不删活着的会话"）。
 */

/**
 * 会话回收的**轮数**判据：**每隔 5 轮就重建一次**（无条件，2026-10-17 用户定的最简单设计）。
 *
 * 理由（用户原话）：结论都已经在记忆里，会话只需要"留最近 5 轮能看到"就够了。
 * 所以不必判断窗口准不准、也不必量日志有多大 —— **数轮数最硬**：它不依赖任何测量，
 * 谁也骗不了它（"量不到大小"这种实测真会发生的怪事因此不再是问题）。
 */
export const DEFAULT_LEARNER_RECYCLE_KICKS = 5

/**
 * 上下文限制（第二道判据）：会话日志的**压缩字节数**超过它 → 下次调用也直接重建。
 *
 * 为什么不只看轮数：一轮也可能长得离谱（比如 web_fetch 抓回一大篇），5 轮还没数满、
 * 上下文却已经过大 → 撞宿主窗口墙时整轮被拒、会话卡死。
 * 量不到大小（磁盘上根本没有这个会话的文件，**实测真会这样**）时**不按字节判** ——
 * 轮数判据会兜住，所以"量不到"不再需要单独的兜底分支。
 */
export const DEFAULT_LEARNER_RECYCLE_BYTES = 350 * 1024

/**
 * 该不该重建？（纯函数，便于单测）
 *
 * 两条判据，**轮数优先**（它一定能算出来，不依赖任何测量）：
 *   ① 已经踢满 `maxKicks` 轮（默认 5）        → 重建（reason=kicks）
 *   ② 量得到大小 且 ≥ `maxBytes`（默认 350KB）→ 重建（reason=log-bytes）
 * 其余情况不重建。
 *
 * @param {{logBytes?: number|null, kicksSinceRecycle?: number}} [probe]
 * @param {{maxBytes?: number, maxKicks?: number}} [limits]
 * @returns {{recycle: boolean, reason: string, logBytes: number|null, measured: boolean, kicks: number}}
 */
export function shouldRecycleLearnerSession(probe = {}, limits = {}) {
  const k = Number(probe.kicksSinceRecycle)
  const kicks = Number.isFinite(k) && k > 0 ? Math.trunc(k) : 0
  const b = Number(probe.logBytes)
  const measured = Number.isFinite(b) && b > 0
  const logBytes = measured ? b : null

  const maxBytes = limits.maxBytes ?? DEFAULT_LEARNER_RECYCLE_BYTES
  const maxKicks = limits.maxKicks ?? DEFAULT_LEARNER_RECYCLE_KICKS
  const bytesOk = Number.isFinite(maxBytes) && maxBytes > 0
  const kicksOk = Number.isFinite(maxKicks) && maxKicks > 0

  if (kicksOk && kicks >= maxKicks) {
    return { recycle: true, reason: 'kicks', logBytes, measured, kicks }
  }
  if (bytesOk && measured && b >= maxBytes) {
    return { recycle: true, reason: 'log-bytes', logBytes, measured, kicks }
  }
  return { recycle: false, reason: measured ? 'under-limits' : 'unmeasured-under-kicks', logBytes, measured, kicks }
}

/**
 * 第 `recycledCount` 代会话 id：`<=0` 用基础 id，之后依次 `base-1`、`base-2`…
 * （纯函数：id 生成规则只有这一处，别在调用点拼字符串。）
 */
export function nextLearnerSessionId(baseId, recycledCount) {
  const base = typeof baseId === 'string' ? baseId.trim() : ''
  if (!base) return ''
  const n = Number(recycledCount)
  if (!Number.isFinite(n) || n <= 0) return base
  return `${base}-${Math.trunc(n)}`
}

/**
 * 量一个会话的日志有多大（**压缩字节数**），量不到就返回 0。
 *
 * 路径与 `removeStaleSessionFiles` 同一套：`<DSH_HOME>/sessions/<分组>/<id>/session.v4.jsonl[.zstd]`，
 * DSH_HOME 由 `dataFile` 反推（`<DSH_HOME>/profiles/<profile>/mnemos/memory.json`）。
 * 遍历**所有分组**累加（同一个 id 可能落在多个分组下）。
 */
export async function learnerSessionLogBytes(sessionId, dataFile) {
  if (!sessionId || typeof sessionId !== 'string') return 0
  // 防路径穿越：id 里出现路径片段一律当"量不到"
  if (/[\\/]/.test(sessionId) || sessionId.includes('..')) return 0
  const dshHome = path.resolve(path.dirname(dataFile), '..', '..', '..')
  const sessionsDir = path.join(dshHome, 'sessions')
  let groups = []
  try {
    groups = await fs.readdir(sessionsDir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const g of groups) {
    if (!g.isDirectory()) continue
    for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
      try {
        total += (await fs.stat(path.join(sessionsDir, g.name, sessionId, name))).size
      } catch { /* 该分组下没有这个会话/这种日志，正常 */ }
    }
  }
  return total
}

/**
 * 把"重建"这件事说成人话（**只有这一处**：日志、工具回执都用它，避免三处各写一份措辞）。
 *
 * @param {{from?: string, to?: string, reason?: string, logBytes?: number|null, kicks?: number}} recycle
 * @returns 形如 `mnemos-learner → mnemos-learner-1（已踢满 5 轮）`；没有重建就给空串
 */
export function describeLearnerRecycle(recycle) {
  if (!recycle || typeof recycle !== 'object') return ''
  const from = recycle.from || '?'
  const to = recycle.to || '?'
  const why =
    recycle.reason === 'restarted'
      // ★ 这里**不能**断言"宿主重启过"：真实判据只是 `agents.get(id)` 取不到，
      //   取不到也可能是"上次根本没建成/被删"。把不确定的因果写成确定，就是撒谎（D-2，learner 自查发现）。
      ? '原会话取不到了（可能宿主重启、也可能上次没建成）'
      : recycle.reason === 'kicks'
        ? `已踢满 ${Number(recycle.kicks) || 0} 轮`
        : `日志 ${Math.round((Number(recycle.logBytes) || 0) / 1024)} KB 超上限`
  return `${from} → ${to}（${why}）`
}

/**
 * 心跳任务主体：到点踢一脚。
 * @returns { skipped:true, reason } 或 { sent:true, ... }
 */
export async function runLearnerKick(deps = {}) {
  const {
    agents,
    sessionId = DEFAULT_LEARNER_SESSION_ID,
    agentOptions = {},
    meta,
    intervalMs = DEFAULT_LEARNER_INTERVAL_MS,
    minGapMs = 0,
    waitLimitMs = DEFAULT_WAIT_LIMIT_MS,
    now = Date.now(),
    lastKickAt = 0,
    text = buildLearnerMessage(),
    onInfo = () => {},
    // ★ 把 agentPreset **真正选中**（挂上它的子插件 = 给这个 agent 工具集）。
    //   只写 meta.agentPreset **不够**（实测：工具数不变，仍无联网工具）。
    selectPreset,
    removeStale, // ★ 清同名残留会话的回调（由 index.js 提供：删会话目录 + 投影缓存）
    // ★★ 2026-10-17：优先用**宿主的派活通道**起这一轮的学习子会话（由 index.js 提供）。
    //   为什么：`agents.create` 自建的 agent 走 DeepSeek 自家路由必 `TRANSPORT`（实测 5 次重试全败），
    //   而宿主代建的子会话在同一路由上能跑（实测 ROUTE-OK / completed）。用它就能"默认只用一个模型"。
    //   签名：`launchChild({ text, agentOptions }) => Promise<childId | null>`；不给就退回老的 ensure 路径。
    launchChild,
    // ★ 会话回收相关（2026-10-17 加）：
    state, //            上次落盘的状态（含 activeSessionId/recycled/retired/kicksSinceRecycle）
    measureLogBytes, //  量"某个会话 id 的日志压缩字节数"的回调（由 index.js 提供）
    recycleBytes = DEFAULT_LEARNER_RECYCLE_BYTES,
    recycleKicks = DEFAULT_LEARNER_RECYCLE_KICKS,
  } = deps

  if (!agents || typeof agents.create !== 'function') {
    return { skipped: true, reason: 'no-agents-service' }
  }

  // 到点才踢（心跳可能更频繁）
  const since = now - (lastKickAt || 0)
  if (since < intervalMs) {
    return { skipped: true, reason: 'not-yet', minutesUntil: Math.ceil((intervalMs - since) / 60000) }
  }

  // ── 会话回收：换 id（绝不 dispose，也不删活着的会话）─────────────────────────
  // 状态迁移全在这里算一次；调用点只负责"把 nextState 存回去"，避免两处各写一份而漂移。
  const prevState = normalizeLearnerState({ ...(state || {}), lastKickAt })
  let activeSessionId = prevState.activeSessionId || sessionId
  let recycledCount = prevState.recycled
  let retired = prevState.retired
  let kicksSinceRecycle = prevState.kicksSinceRecycle
  let recycleInfo = null
  let retiredCleaned = 0

  let logBytes = null
  // ★★ 走宿主派活时**根本不需要回收**：每一脚都是一个全新的子会话（结论都在记忆里）。
  //   继续算回收只会产生无意义的"会话重建"日志、并让 recycled 每脚 +1（learner 自查 D-2 时也点了这个噪音）。
  const usingHostLaunch = typeof launchChild === 'function'
  if (typeof measureLogBytes === 'function' && activeSessionId && !usingHostLaunch) {
    try {
      logBytes = await measureLogBytes(activeSessionId)
    } catch {
      logBytes = null // 量不到 → 交给兜底判据（按轮数），绝不让测量失败咬掉整次踢
    }
  }
  const verdict = usingHostLaunch
    ? { recycle: false, reason: null, logBytes: null, measured: false, kicks: kicksSinceRecycle }
    : shouldRecycleLearnerSession(
        { logBytes, kicksSinceRecycle },
        { maxBytes: recycleBytes, maxKicks: recycleKicks }
      )
  // ★★ 2026-10-17 修的真缺口：宿主重启后，learner 的 agent 不在内存里 → 下一次会走 `resume` 把旧会话捞回来。
  //   但宿主的 `agentPresets.select()` **只允许在会话第一轮之前**调用，恢复出来的会话补不上 preset，
  //   于是工具集退化成"只有 mnemos + context7"（没有 read/glob/grep、没有联网工具）——
  //   表现很像"网络坏了"，其实是它手上没有联网工具（实测：learner 第 17 轮连发 3 次 unknown tool "read"）。
  //   所以：**只要这个 id 在本进程里不活着，就直接换新**（结论都在记忆里，会话是草稿纸）。
  //   取不准（get 抛错）时按"活着"处理 —— 宁可这一轮少踢，也不要误伤正在跑的会话。
  let aliveInProcess = true
  if (!usingHostLaunch && typeof agents.get === 'function' && activeSessionId) {
    try {
      aliveInProcess = Boolean(agents.get(activeSessionId))
    } catch {
      aliveInProcess = true
    }
  }
  const restarted = !aliveInProcess
  if (verdict.recycle || restarted) {
    const from = activeSessionId
    recycledCount += 1
    activeSessionId = nextLearnerSessionId(sessionId, recycledCount)
    retired = [...retired, from].slice(-MAX_RETIRED_IDS)
    kicksSinceRecycle = 0 // 新一代从 0 开始数
    recycleInfo = {
      from,
      to: activeSessionId,
      // 谁先触发就报谁：轮数/字节上限成立时那是主因（重启只是恰好同时发生）；只有在"没到上限、纯粹因为重启"时才报 restarted。
      reason: verdict.recycle ? verdict.reason : 'restarted',
      logBytes: verdict.logBytes,
      measured: verdict.measured,
      kicks: verdict.kicks,
    }
    // 人话版本（日志/回执直接用它 —— 措辞只在一个地方生成，避免三处各写一份而漂移）
    recycleInfo.text = describeLearnerRecycle(recycleInfo)
    onInfo(`空闲学习：会话重建 —— ${recycleInfo.text}`)

    // 顺手清**确实不活着**的旧代会话文件（活着的绝不动：删活着的会话会破坏运行中的状态）。
    // 取不准（get 抛错）时一律当"活着" —— 宁可少删，不要误删。
    if (typeof removeStale === 'function' && typeof agents.get === 'function') {
      const keep = []
      for (const id of retired) {
        let alive = true
        try {
          alive = Boolean(agents.get(id))
        } catch {
          alive = true
        }
        if (alive) {
          keep.push(id)
          continue
        }
        try {
          retiredCleaned += await removeStale(id)
        } catch { keep.push(id) } // 清不掉就留着，下次再试
      }
      retired = keep.slice(-MAX_RETIRED_IDS)
    }
  }

  // 状态怎么落：**只有 `sent` 才算"踢过一轮"**（kicks / lastKickAt / kicksSinceRecycle 都只在那时推进）。
  // 但回收本身即使这次没踢成也要记下（否则会反复对同一个旧 id 做同样的决策）。
  const nextState = (extra = {}) =>
    normalizeLearnerState({
      ...prevState,
      activeSessionId,
      recycled: recycledCount,
      retired,
      kicksSinceRecycle,
      ...extra,
    })

  // ★★ D-1：**换代只有在"真的起了一个能用的会话"之后才算数**。
  //   之前的问题：回收决策先把 activeSessionId / recycled 推进，然后 create 失败 → 这些已然落盘，
  //   于是每次失败都烧掉一个 id、代数计数器失真（learner 自查时发现状态停在从未建成的 mnemos-learner-7）。
  //   失败路径统一用这个：保留上一代的全部字段，下一次踢会重新做同样的决策（可重试，不会空转烧 id）。
  const noCommit = () => ({
    activeSessionId: prevState.activeSessionId,
    recycled: prevState.recycled,
    retired: prevState.retired,
    kicksSinceRecycle: prevState.kicksSinceRecycle,
  })

  // ★ 2026-10-18 用户决定：**空闲学习回退到"必须配第三方 api"的老形式**，不再走宿主派活。
  //   两条理由（用户原话的意思）：
  //   ① 后台运行时几乎不存在"活着的父会话"（夜里没有用户会话），宿主派活注定频繁走不通；
  //   ② 宿主派活的子会话挂在**父会话的智能体**下面，人不好看见 —— 这违背"可观测"。
  //   所以 learner 一律自己 create（`created=true` 才会选 preset，工具集才完整），
  //   并且要求显式配 `learnerProvider` + `learnerModel`（见 index.js 的守卫）。

  const ensured = await ensureLearnerAgent(agents, {
    sessionId: activeSessionId,
    agentOptions,
    meta,
    removeStale,
    // ★ 一律不 resume（resume 出来的会话挂不上 preset，工具集会退化）；
    //   每脚都是 create → created=true → 才会去 selectPreset。
    skipResume: true,
  })

  if (!ensured.agent) {
    return {
      skipped: true, reason: ensured.error || 'no-agent', getError: ensured.getError,
      recycle: recycleInfo, activeSessionId, nextState: nextState(noCommit()),
    }
  }
  const agent = ensured.agent

  // ★★ 把 preset **真正选中** —— 它才会把该 preset 的子插件挂进这个 agent 的 ctx（**工具集就是这么来的**）。
  //
  // 实测教训：只在 `meta` 里写 `agentPreset` 只是"记了个号"，**不挂插件**：
  //   会话头里 agentPreset="standard" 了，工具数却仍是 18、没有 web_search/web_fetch。
  // 宿主的 API（`dsh-agent-preset-registry`）：
  //   `async select(agent, agentPreset)` —— 内部 `recompose(agent.ctx, id)` 挂载插件并 `emit("tools/change")`；
  //   且**必须在会话开始第一轮之前**调用，否则抛 `agent-preset/locked`
  //   （源码：`if (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0) throw ...`）。
  // 所以只在**本次新建**（会话还没跑过任何一轮）时选；已跑过的会话按宿主设计不许再换。
  let presetResult = null
  if (typeof selectPreset === 'function' && ensured.created) {
    try {
      presetResult = await selectPreset(agent)
      onInfo(`空闲学习：已为会话 ${activeSessionId} 选中 agentPreset=${presetResult}（子插件已挂上）`)
    } catch (e) {
      presetResult = 'failed: ' + (e?.message || e)
      onInfo(`空闲学习：选 agentPreset 失败 —— ${presetResult}（这个 agent 会少掉该 preset 的工具）`)
    }
  }

  // ★ 不打扰：它还在忙就跳过（宿主 `get status()` 真实返回 'idle' | 'running'）
  const status = typeof agent.status === 'string' ? agent.status : null
  if (status && status !== 'idle') {
    // ★★ 2026-10-21 修（V6-02）：这里**不能用 noCommit**。
    //   noCommit 是给"create 失败"用的（见上面 D-1）：那种情况换代根本没发生，必须退回旧 id。
    //   但走到这一行时 ensure 已经成功、agent 是真的存在（只是忙），**换代已经是既成事实**；
    //   再用 noCommit 会把已提交的新代整组写回旧代，下一 tick 就从旧 id 重新决策 ——
    //   重复执行 create / 清旧代文件这些非幂等副作用（实测日志：同一 12→13、13→14 各出现两次）。
    //   跳过时只该"不推进 kicks/lastKickAt"（nextState() 的默认语义），不该回滚换代字段。
    return {
      skipped: true, reason: 'busy', status, created: ensured.created, resumed: ensured.resumed,
      recycle: recycleInfo, activeSessionId, nextState: nextState(),
    }
  }

  // ★ followup 是**同步入队**（源码：send → inbox.splice + wakeDriver）。
  //   它不抛错 ≠ 那一轮跑成功 —— 所以这里把"入队成功"和"后续是否真的跑了"分开报。
  // ★ `source` 只能用**宿主允许的生产者来源**：实测 `{ kind: 'plugin', plugin: … }` 会被
  //   `format v4 message requires a producer-owned source kind` 直接拒（那是 steer 的写法）；
  //   followup 用 `{ kind: 'user' }`（宿主 README 的 followup 示例即如此）。
  // ★ **role/id 必须由构造器补齐**：learner 走 aliyun（pi-ai 会把没有 role 的消息兜底当 user），
  //   所以这里缺 role 不会报错 —— 但那条消息同样过不了宿主的**加载**校验（缺 id/role 即拒），
  //   重启后这个学习会话就 resume 不回来了。两条路由一起按同一形状写，别赌兜底。
  try {
    agent.followup(buildInjectedUserMessage(text))
  } catch (e) {
    // ★★ 2026-10-21 修（V6-02）：与 busy 同理 —— agent 已经起来了、换代是既成事实，
    //   只有"入队"这一步失败。这里若用 noCommit 退回旧 id，下一 tick 会再换一次代。
    return {
      skipped: true, reason: 'followup-threw: ' + (e?.message || e), created: ensured.created,
      recycle: recycleInfo, activeSessionId, nextState: nextState(),
    }
  }
  const usedId = ensured.sessionId || activeSessionId
  onInfo(`空闲学习：已把这一脚送进 ${usedId}${ensured.created ? '（本次新建会话）' : ''}${ensured.staleRemoved ? `（先清了 ${ensured.staleRemoved} 处同名残留）` : ''}`)

  const waited = await waitIdle(agent, waitLimitMs)
  return {
    sent: true,
    sessionId: usedId,
    created: ensured.created,
    resumed: ensured.resumed,
    staleRemoved: ensured.staleRemoved || 0,
    preset: presetResult,
    waited: waited.waited,
    waitReason: waited.reason ?? null,
    statusAfter: typeof agent.status === 'string' ? agent.status : null,
    kickedAt: now,
    // ★ 回收相关：本次是否换了会话、换成了哪个、以及"存回去就对了"的完整状态
    recycle: recycleInfo,
    activeSessionId,
    retiredCleaned,
    nextState: nextState({
      lastKickAt: now,
      kicks: prevState.kicks + 1,
      kicksSinceRecycle: kicksSinceRecycle + 1,
    }),
  }
}

/**
 * 清掉「同名的残留会话」：会话目录（`<DSH_HOME>/sessions/<分组>/<id>/`）+ 投影缓存。
 *
 * ★ 为什么需要它：`create` 遇到同名会话会报 `session "…" already exists`。
 *   旧兜底是**换一个 id 再建**（`mnemos-learner` → `-2` → `-3` …），结果**每次调用都堆出一个新对话**——
 *   用户明确要求不要这样。现在改为：**清掉同名残留 → 用同一个 id 重建**，id 永远稳定。
 *   依据：用户已授权"会话被删了、重建后连消息都不需要恢复"（结论都在记忆里）。
 *
 * ★ 安全前提：**只在 `agents.get(id)` 取不到（会话当前不活着）时才会被调用**，
 *   不会删掉活着的会话（那会真的破坏运行中的状态）。
 *
 * @returns 实际清掉的路径数（0 = 什么都没清，调用方应放弃重试）
 */
export async function removeStaleSessionFiles(sessionId, dataFile) {
  if (!sessionId || typeof sessionId !== 'string') return 0
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) return 0 // 防路径穿越
  const dshHome = path.resolve(path.dirname(dataFile), '..', '..', '..')
  let removed = 0

  // ① 会话目录：sessions/<分组>/<sessionId>
  const sessionsDir = path.join(dshHome, 'sessions')
  let groups = []
  try {
    groups = await fs.readdir(sessionsDir, { withFileTypes: true })
  } catch { /* 读不到就算了 */ }
  for (const g of groups) {
    if (!g.isDirectory()) continue
    const target = path.join(sessionsDir, g.name, sessionId)
    try {
      const st = await fs.stat(target)
      if (st.isDirectory()) {
        await fs.rm(target, { recursive: true, force: true })
        removed++
      }
    } catch { /* 该分组下没有这个会话，正常 */ }
  }

  // ② 投影缓存：storages/session_projcache/sessions/<sessionId>.json
  const cacheFile = path.join(dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  try {
    await fs.stat(cacheFile)
    await fs.rm(cacheFile, { force: true })
    removed++
  } catch { /* 没有缓存，正常 */ }

  return removed
}

/**
 * ★ 自指守卫（纯函数，便于单测）：**learner 会话自己不许调"空闲学习踢"**。
 *
 * 为什么需要它（2026-10-16 实测）：本地小模型连跑三轮，每轮都只调 `mnemos_learner_kick`
 * （"把自己又踢一次"），零学习产出 —— 弱模型把**工具名（空闲学习踢）**当成了**任务（空闲学习）**。
 * 平台没有"按 agent 隐藏某个工具"的接口（`ctx.tools.register` 是全局的，也没有独立的工具策略插件），
 * 所以闸门只能放在**执行处**：让这个动作物理上做不到，并当场告诉它该去做什么。
 *
 * @param {string|null|undefined} callerSessionId 调用方会话 id（`exec?.agent?.session?.id`）。
 *   **取不到时（null）一律放行** —— 宁可放过，也不要误伤正常的诊断调用。
 * @param {string} learnerSessionId 空闲学习专用会话 id。
 * @returns {null | { refused: 'self', error: string }} null = 放行；否则返回拒绝原因（含给模型的指路）。
 */
export function selfKickRefusal(callerSessionId, learnerSessionId) {
  if (typeof callerSessionId !== 'string' || callerSessionId.length === 0) return null
  if (typeof learnerSessionId !== 'string' || learnerSessionId.length === 0) return null
  if (callerSessionId !== learnerSessionId) return null
  return {
    refused: 'self',
    error:
      'learner 自己不要调用这个工具 —— 你就是被踢的那一方，自己踢自己没有任何效果。' +
      '请直接开始这一轮的学习：任务文件里有事就做那件事；没有就自己挑一个值得弄清的问题' +
      '（先 mnemos_recall 看有没有做过），做完把结论用 mnemos_remember 写进记忆，最后简短回报。',
  }
}
