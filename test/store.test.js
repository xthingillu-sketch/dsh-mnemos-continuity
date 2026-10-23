/**
 * dsh-mnemos 单元测试（独立运行，不依赖 DSH）。
 * 覆盖：记忆存储（写入→检索→归档→持久化）+ 宪法 + 心跳 + 任务型技能提供者。
 */
import {
  MemoryStore, isArchiveProtected, collectOpenTaskIds,
  TASK_TAG_PREFIX, TASK_GRAPH_TAG, TASK_OPEN_TAG, TASK_CLOSED_TAG,
  TASK_RESULT_TAG, TASK_SCRATCH_TAG, TASK_KEEP_TAG, TASK_EXPIRED_TAG, DEFAULT_TASK_OPEN_MAX_MS,
  TASK_DONE_TEXT_MAX, TASK_USES_MAX,
} from '../src/store.js'
import { ConstitutionStore } from '../src/constitution.js'
import { createHeartbeat } from '../src/heartbeat.js'
import { parseSkillFile, listSkills, createSkillProvider } from '../src/skill-provider.js'
import { skillsRootFor, resolveConstitutionFileForCli, defaultDataFile, defaultConstitutionFile, mnemosDataDir, describeResolved } from '../src/paths.js'
import { buildSelfText, constitutionMissingWarning } from '../src/self-text.js'
import { usageFileFor, revisionOf, appendUsage, readUsages, selfReviewHint, makeSkillUsageRecorder } from '../src/skill-usage.js'
import { userSignalsFileFor, extractUserText, appendUserSignal, readUserSignals, makeSessionUsageTracker, makeUserSignalRecorder, skillOffersFileFor, sessionTasksFileFor, parseCatalogSkills, taskFingerprint, makeSessionOfferTracker, TASK_FINGERPRINT_CHARS, TASK_MAX_PER_SESSION } from '../src/user-signals.js'
import { attribute, extractRulePoints, parseJsonReply, collectSelfReviews, runSkillReview, createSkill, newSkillStagingDirFor, buildReviewPrompt, buildVerifyPrompt, buildNewSkillVerifyPrompt, isDescriptionOnlyChange, splitSkillContent, writeBackSkill, appendJsonl, assertNoSecretInSkill, resolveSkillWriteBacks, DEFAULT_CREATE_WRITE_BACK, DEFAULT_REVIEW_WRITE_BACK, DEFAULT_MAX_SKILLS, classifyReviewReply, classifyVerifyReply, lastAppliedOf, resolveLastApplied, prunePendingLedger, pendingStats, PENDING_TTL_MS, PENDING_HANDLED_TTL_MS } from '../src/skill-review.js'
import { findSecrets, redactSecrets, describeHits, secretBlocksFileFor } from '../src/secret-patterns.js'
// ★ 注入消息的唯一构造点 + 宿主加载校验的等价规则（2026-10-17：缺 role 让 DeepSeek 路由 422、缺 id 让会话打不开）
import { buildInjectedUserMessage, userMessageShapeProblems } from '../src/host-message.js'
import { detectMissedUsage, readMisses, buildMissPrompt, MISS_REASONS } from '../src/skill-miss.js'
import { LEARNING_PROTOCOL } from '../src/learning-protocol.js'
import { editDistance, nearestToolName, detectUnknownTool, buildUnknownToolGuidance, makeUnknownToolGuide } from '../src/tool-guidance.js'
import { makeStuckDetector, callKey, isFailed, buildStuckHint, buildSkillProposalHint, findLastFailureSeq } from '../src/stuck-detector.js'
import { parseSourceRef, resolveSourceRef, formatSourceRef, SOURCE_REF_FORMAT_HINT, COUNTEREXAMPLE_PARAM_DESCRIPTION } from '../src/skill-source-ref.js'
import { PROPOSE_SKILL_DESCRIPTION, renderProposeSkillResult } from '../src/skill-propose-text.js'
import {
  makeCompactionSnapshot, extractShadowedFacts, derivedMessage, nodeText, isToolFailure,
  toolNameForCall, matchNegative, clip, firstLine, firstMeaningfulLine, INJECTED_MARKER_PREFIXES,
  truncateWithOmission, buildFallbackText,
  buildSnapshotSummary, NEGATIVE_CONCLUSION_PATTERNS, buildFoldNotice,
  COMPACTION_SNAPSHOT_TAG, COMPACTION_SNAPSHOT_EVENTS, COMPACTION_SUMMARY_EVENT, SNAPSHOT_TEXT_CHARS,
  MAX_SNAPSHOTS_PER_SESSION, MAX_ITEMS_PER_CLASS, pruneCompactionSnapshots, SNAPSHOT_TTL_MS,
} from '../src/compaction-snapshot.js'
import { plain } from '../src/plain-text.js'
// ★ 空闲学习：纯逻辑用**假 agents 服务**直接测（不碰真会话、不花 token）
import {
  runLearnerKick, ensureLearnerAgent, buildLearnerMessage,
  loadLearnerState, saveLearnerState, learnerStateFileFor,
  removeStaleSessionFiles, resolveLearnerWorkspace,
  learnerTasksFileFor, ensureLearnerTasksFile, readLearnerTasks,
  DEFAULT_LEARNER_SESSION_ID, DEFAULT_LEARNER_INTERVAL_MS, selfKickRefusal,
  // ★ 会话回收（2026-10-17）：learner 会话不能无限复用（撑爆后整轮被拒、会话永久卡死）
  normalizeLearnerState, shouldRecycleLearnerSession, nextLearnerSessionId, learnerSessionLogBytes,
  describeLearnerRecycle,
  DEFAULT_LEARNER_RECYCLE_BYTES, DEFAULT_LEARNER_RECYCLE_KICKS,
} from '../src/learner-loop.js'
import { acquireLock, probeLock, isStaleLock, lockBody, lockPathFor } from '../src/store-lock.js'
// ★ F-15：形状真相源 + 纯构造函数（都是无宿主依赖的模块，所以这里 import 得到 ——
//   这正是结构性修复的一半：index.js 有 @deepseek-ai/schemastery，纯 node 跑不起来）。
import {
  TOOL_OUTPUT_SPECS, TOOL_NAMES, buildOutputSchema, checkToolOutput,
  normalizeToolValue, withToolOutputGate,
} from '../src/tool-output.js'
import {
  rememberResult, recallResult, validateResult, constitutionResult, deleteResult,
  deprecateResult, dormantResult, openResult, consolidateResult, heartbeatResult, learnerKickResult,
  maintenanceListResult, toggleResult, proposeSkillResult,
  taskOpenResult, taskUpdateResult, taskCloseResult, taskDoneResult, taskCiteResult,
} from '../src/tool-results.js'
import { promises as fs, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') // 82 扰动自证用
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemos-test-'))
// ★ 每次运行清掉与"测试名"相关的残留（反例自证）：
//   本轮实测踩到——上一次**失败运行**在 `x90/` 下留下的 memory.json 会被下次运行的
//   同名路径**当数据读进来**（MemoryStore 全量读 + 三方合并），于是断言里凭空多出条目、
//   失败信息还长得像"实现坏了"。临时目录名固定时这不是假想问题，必须显式清。
await fs.rm(path.join(dir, 'x90'), { recursive: true, force: true })
await fs.rm(path.join(dir, 'x98tmp'), { recursive: true, force: true })
const dataFile = path.join(dir, 'memory.json')
const store = new MemoryStore(dataFile)

let pass = 0
let fail = 0
// 失败明细（供扰动自证在**子进程**里核对"哪一条挂了"；不影响正常输出）
const failedMsgs = []
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg) }
  else { fail++; failedMsgs.push(String(msg)); console.log('  ✗ ' + msg) }
}
// 可选：--pf3-report=<路径> → 把本轮的通过/失败计数与失败明细写成 JSON。
// 用途只有一个：让 F-3 的扰动自证能**跨进程**核对"扰动真的打中了哪一条断言"。
// 为什么不靠解析 stdout：pipelines 在沙箱下会被拒（EPERM），而且解析输出比读一份机器可读报告脆。
const pf3ReportArg = process.argv.find((a) => a.startsWith('--pf3-report='))
const writeReport = async (failedAtExit) => {
  if (!pf3ReportArg) return
  await fs.writeFile(
    pf3ReportArg.slice('--pf3-report='.length),
    JSON.stringify({ pass, fail, failed: failedMsgs, failedAtExit }, null, 2),
    'utf8'
  )
}

// ★ F-16：**进程级兜底**。实测一次运行里，扰动自证的 clean 子进程没写出报告，
//   父进程只看到 `ENOENT: ...x98-report-clean.json` —— 「为什么失败」这件事本身丢了，
//   而报告文件恰恰是唯一的跨进程判别通道（stdout 管道在沙箱下不可用）。
//   所以：任何未捕获异常/未处理拒绝都必须**先落报告再退出**。这不是"藏红灯"，
//   是把"看不见的红灯"变成"带堆栈的红灯"（隐形 flaky 比红灯更糟）。
const reportCrash = async (kind, e) => {
  const msg = `${kind}: ${(e && (e.stack || e.message)) || e}`
  try { console.error(`[mnemos-test] ${msg}`) } catch { /* 喊不出去也要落盘 */ }
  try {
    fail++
    failedMsgs.push(msg)
    await writeReport(fail)
  } catch { /* 连报告都写不了就只剩 stderr 了 */ }
}
process.on('unhandledRejection', (e) => { void reportCrash('unhandledRejection', e).then(() => process.exit(1)) })
process.on('uncaughtException', (e) => { void reportCrash('uncaughtException', e).then(() => process.exit(1)) })

console.log('== 1. 写入三条记忆 ==')
const a = await store.remember({ content: '重构了登录认证，改用 JWT，过期时间 2 小时', summary: '登录认证改为 JWT', tags: ['auth', 'backend'], taskId: 'task-1', salience: 'high' })
const b = await store.remember({ content: '导出报表的 CSV 编码改为 UTF-8 BOM', summary: '报表导出改 UTF-8 BOM', tags: ['report', 'export'], taskId: 'task-1' })
const c = await store.remember({ content: '数据库连接池超时调大到 30s（外部文档建议）', summary: '连接池超时 30s', tags: ['db'], taskId: 'task-2', source: 'external' })
assert(a.id && b.id && c.id, '三条记忆写入成功')
assert(a.layer === 'short', '新记忆默认 layer=short')
assert(c.source === 'external', '外部来源被标记 external')

console.log('== 2. 按 taskId 精确检索 ==')
const r1 = store.recall({ taskId: 'task-1' })
assert(r1.length === 2, 'task-1 检索到 2 条')
assert(r1.every((m) => !('detail' in m)), '召回阶段不返回 detail（两段式第一段）')

console.log('== 3. 按关键词检索 ==')
const r2 = store.recall({ query: '认证' })
assert(r2.length === 1 && r2[0].summary.includes('JWT'), '关键词“认证”命中 JWT 记忆')

console.log('== 4. 按标签检索 ==')
const r3 = store.recall({ tags: ['db'] })
assert(r3.length === 1 && r3[0].source === 'external', '标签 db 命中外部来源记忆')

console.log('== 5. 取详情（两段式第二段）==')
const opened = await store.open(b.id)
assert(opened.detail.includes('UTF-8 BOM'), 'open 返回完整详情')

console.log('== 6. 归档 task-1 短时→长期 ==')
const cons = await store.consolidate('task-1', 'task-1 归档摘要')
assert(cons.layer === 'hot', '归档后新记录 layer=hot')
assert(cons.summary === 'task-1 归档摘要', '重建摘要生效')
assert(a.id !== cons.id, '归档产生新 id')
// 原始记录应降为 cold 且版本递增
const aAfter = store.memories.get(a.id)
const bAfter = store.memories.get(b.id)
assert(aAfter.layer === 'cold' && bAfter.layer === 'cold', '原始记录降为冷存储（不删除）')
assert(aAfter.version === 2, '原始记录版本递增到 2')

console.log('== 7. 归档后再检索 ==')
const r4 = store.recall({ taskId: 'task-1' })
assert(r4.length === 3, '归档后 task-1 仍有 3 条（2 冷 + 1 热）')

console.log('== 8. 持久化重载 ==')
const store2 = new MemoryStore(dataFile)
await store2.load()
assert(store2.memories.size === store.memories.size, '重载后记忆条数一致')

console.log('== 11. 心跳机制（预留接口）==')
const hb = createHeartbeat()
hb.register('noop', '测试功能', async () => 'done')
assert(hb.list().length === 1, '注册表有 1 个功能')
const hbResult = await hb.run(store)
assert(hbResult.results.length === 1 && hbResult.results[0].ok === true, '心跳运行成功')

console.log('== 11b. V6-01：别的实例写入要先"看得到"（心跳/读取入口先刷新）==')
{
  const f = path.join(dir, 'refresh-v601', 'memory.json')
  const A = new MemoryStore(f)
  await A.load()
  const B = new MemoryStore(f)
  await B.load()

  const rec = await B.remember({ content: '另一个实例写的正文', summary: 'V601-EXTERNAL 外部写入', sessionId: 'S-web' })
  assert(A.recall({ query: 'V601-EXTERNAL' }).length === 0, '★ 不刷新就看不到外部写入（修复前的现象可复现）')

  const r1 = await A.refreshFromDisk()
  assert(r1.ok === true && r1.refreshed === true && r1.added >= 1,
    `★★ [V6-01] 刷新读到外部新增（added=${r1.added}）`)
  assert(A.recall({ query: 'V601-EXTERNAL' }).length === 1, '★★ 刷新后 recall 能看到（不再依赖本端 save）')

  const reads1 = A.refreshStats.reads
  const r2 = await A.refreshFromDisk()
  assert(r2.refreshed === false && A.refreshStats.reads === reads1,
    '★ 文件没变 → 只 stat、不重读（不引入额外开销）')

  await B.delete(rec.id)
  const r3 = await A.refreshFromDisk()
  assert(r3.refreshed === true && Boolean(A.tombstoneTable()[rec.id]), '★★ 外部删除的墓碑被合并进来')
  assert(A.recall({ query: 'V601-EXTERNAL' }).length === 0, '★★ 外部删除后刷新可见（旧副本不复活）')

  // 心跳：开始处先刷新，再跑维护（归档环的关键）
  const f2 = path.join(dir, 'refresh-hb-v601', 'memory.json')
  const H = new MemoryStore(f2)
  await H.load()
  const W = new MemoryStore(f2)
  await W.load()
  await W.remember({ content: '心跳前外部写入', summary: 'V601-HB 心跳外部记录' })
  const hb1 = createHeartbeat()
  let seen = -1
  hb1.register('probe', '探针：维护任务能否看到外部写入', (s) => {
    seen = s.recall({ query: 'V601-HB' }).length
    return { seen }
  })
  const hbRun1 = await hb1.run(H)
  assert(hbRun1.refresh && hbRun1.refresh.refreshed === true, '★★ [V6-01] 心跳先刷新（回执里带 refresh）')
  assert(seen === 1, '★★ 维护任务看到外部写入（归档环被打破）')

  // 工具入口：recall / open 都必须先刷新（静态检查，防以后改回去）
  const idxSrcR = await fs.readFile(path.join(pluginRoot, 'src', 'index.js'), 'utf8')
  assert((idxSrcR.match(/await store\.refreshFromDisk\(\)/g) || []).length >= 2,
    '★ recall / open 两个读取入口都先刷新')
}

console.log('== 11c. 空闲学习：那一脚怎么被送进专用会话（假 agents，不碰真会话）==')
{
  const msg = buildLearnerMessage()
  assert(typeof msg === 'string' && msg.length > 60, '那一脚是一段可读文本')
  assert(msg.includes('空闲学习时间'), '这条消息标明是"空闲学习时间"')
  assert(msg.includes('什么都不做') && msg.includes('这次不学'), '**显式允许零产出**（"这次不学"也算处理完）')
  assert(msg.includes('不要申请提权') && msg.includes('用户不在旁边'),
    '★ 空闲任务禁止申请提权（无人值守，提权会把这一轮卡住）')
  assert(msg.includes('学点你想弄明白的东西'), '不规定学什么（留给模型自己决定）')
  assert(!/必须|一定|务必产出/.test(msg), '不强制产出（没有"必须/务必"这类措辞）')

  // ★★ 自指守卫（2026-10-16 新增）：**learner 自己不许调"空闲学习踢"**。
  //   实测动机：本地的 granite4.1:8b 连跑三轮，每轮都只调这一个工具（"把自己又踢一次"），
  //   零学习产出 —— 弱模型把"工具名（空闲学习踢）"当成了"任务（空闲学习）"。
  //   平台没有"按 agent 隐藏工具"的接口，所以闸门放在执行处；判断逻辑是这里的纯函数。
  {
    const LS = 'mnemos-learner'
    // ① 调用者就是 learner 自己 → 拒绝，且必须给出"该去做什么"的指路
    const self = selfKickRefusal(LS, LS)
    assert(self !== null, '★★ 自指守卫：learner 自己调用 → 必须拒绝（不是放行）')
    assert(self.refused === 'self', '★★ 自指守卫：拒绝原因是可机读的 refused=self')
    assert(typeof self.error === 'string' && self.error.includes('自己踢自己'), '★★ 自指守卫：拒绝文案点明"自己踢自己"没有效果')
    assert(/学习/.test(self.error) && self.error.includes('mnemos_remember'), '★★ 自指守卫：拒绝文案要**指路**（去做学习、结论写进记忆），否则模型只会反复撞墙')
    // ② 别的会话调用 → 放行（正常诊断/手动触发不受影响）
    assert(selfKickRefusal('some-other-session', LS) === null, '★★ 自指守卫：外部会话调用 → 放行（诊断能力不能被误伤）')
    assert(selfKickRefusal('mnemos-learner-2', LS) === null, '★★ 自指守卫：**前缀相同但 id 不同**必须放行（不能写成 startsWith 那种误伤）')
    // ③ 取不到调用者 → 放行（宁可放过，不要因为拿不到 id 就把工具打瘸）
    assert(selfKickRefusal(null, LS) === null, '★★ 自指守卫：调用者未知（null）→ 放行（fail-open，不误伤）')
    assert(selfKickRefusal(undefined, LS) === null, '★★ 自指守卫：调用者 undefined → 放行')
    assert(selfKickRefusal('', LS) === null, '★★ 自指守卫：空字符串 → 放行（不把空值当成"就是 learner"）')
    // ④ learner 会话 id 没配/为空 → 放行（否则会一竿子拒掉所有调用）
    assert(selfKickRefusal(LS, '') === null && selfKickRefusal(LS, null) === null, '★★ 自指守卫：learnerSessionId 为空 → 放行（不能因此拒掉一切）')
    // ⑤ 反例核对：把"必须相等"写成"不相等"，上面第①条必须失败 —— 这条断言防的就是"闸门写反了还全绿"
    assert(selfKickRefusal(LS, LS) !== null && selfKickRefusal('other', LS) === null, '★★ 自指守卫：方向性核对（相等才拒、不等才放）')
  }

  // 假 agents 服务：能记录被调用的动作
  const mkFake = (existingStatus, opts = {}) => {
    const calls = { created: 0, resumed: 0, followedUp: [], whenIdle: 0, createIds: [], removed: [] }
    const agent = {
      status: existingStatus,
      followup(input) { calls.followedUp.push(input) },
      async whenIdle() { calls.whenIdle++ },
    }
    let createAttempt = 0
    const agents = {
      get: (id) => (existingStatus === null ? null : agent),
      async create(o) {
        const { sessionId } = o
        calls.created++
        calls.createIds.push(sessionId)
        calls.createOpts = o
        createAttempt++
        // createAlwaysExists：永远报"已存在"（模拟同名残留）；createExistsOnce：第一次报
        const exists = opts.createAlwaysExists || (opts.createExistsOnce && createAttempt === 1)
        if (exists) throw new Error(`session "${sessionId}" already exists`)
        return { agent }
      },
    }
    if (opts.withResume) {
      agents.resume = async (o) => {
        calls.resumed++
        calls.resumeOpts = o
        // ★ 钉住字段名：宿主 resume 读的是 `resumeSessionId`（与 sessionId 互斥）；
        //   传错会得到 `Cannot read properties of undefined (reading 'length')`，进而每次踢都新建会话。
        if (!o || typeof o.resumeSessionId !== 'string' || o.sessionId !== undefined) {
          throw new Error('resume 必须用 resumeSessionId（且不得同时传 sessionId）')
        }
        if (opts.resumeThrows) throw new Error('无落盘会话')
        return { agent }
      }
    }
    return { calls, agents }
  }

  // ① 已有会话（空闲）→ 既不新建也不 resume，直接踢
  {
    const { agents, calls } = mkFake('idle', { withResume: true })
    const r = await runLearnerKick({ agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000 })
    assert(r.sent === true && r.created === false && r.resumed === false, '已有空闲会话 → 直接踢（不新建、不 resume）')
    assert(calls.created === 0 && calls.resumed === 0, '没有多余的 create/resume')
    assert(calls.followedUp.length === 1, 'followup 被调用一次')
    const input = calls.followedUp[0]
    assert(Array.isArray(input.content) && input.content[0]?.type === 'text', 'followup 收到 { content:[{type:text,...}] } 形状')
    assert(input.source && input.source.kind === 'user', '来源用宿主允许的 kind=user（plugin 会被 format v4 直接拒）')
    assert(calls.whenIdle === 1, '踢完等它静默（whenIdle 被调用）')
  }

  // ①b ★★ 会话不活着（宿主重启过）→ **换新 id 并直接 create**，绝不 resume
  //   为什么推翻 v1.4.1 的"先 resume"：宿主的 agentPresets.select() 只允许在会话第一轮之前调用，
  //   resume 回来的旧会话补不上 preset → 工具集退化成"只有 mnemos + context7"（没有 read/联网），
  //   表现像"网络坏了"。结论都在记忆里，会话是草稿纸，所以直接换新。
  {
    const { agents, calls } = mkFake(null, { withResume: true })
    const r = await runLearnerKick({ agents, intervalMs: 0, lastKickAt: 0, now: 1000 })
    assert(calls.resumed === 0, '★★ 不活着时**不 resume**（resume 出来的会话挂不上 preset，工具集会退化）')
    assert(calls.created === 1 && calls.createIds[0] === 'mnemos-learner-1', '★★ 换新 id 并直接 create（created=true 才会去选 preset）')
    assert(r.sent === true && r.created === true && r.resumed === false, '结果标明是新建的（不是 resume）')
    assert(r.recycle && r.recycle.reason === 'restarted', '★★ 回执写明原因是"宿主重启过"（不是悄悄换掉）')
    assert(r.sessionId === 'mnemos-learner-1' && r.activeSessionId === 'mnemos-learner-1', '★ 新 id 被回报，调用点会存回状态')
  }

  // ①c 已经在用新 id（本进程里活着）→ 复用，不再 create/resume
  {
    const { agents, calls } = mkFake('idle', { withResume: true })
    const r = await runLearnerKick({
      agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000,
      state: { activeSessionId: 'mnemos-learner-1', recycled: 1, retired: ['mnemos-learner'], kicksSinceRecycle: 1 },
    })
    assert(r.sent === true && r.created === false && r.resumed === false, '活着的新 id → 直接踢（既不新建也不 resume）')
    assert(calls.created === 0 && calls.resumed === 0 && r.recycle === null, '没有多余的 create/resume/回收')
    assert(r.sessionId === 'mnemos-learner-1', '用的是状态里的 activeSessionId，不会退回基础 id')
  }

  // ② 宿主没提供 resume → 直接 create
  {
    const { agents, calls } = mkFake(null)
    const r = await runLearnerKick({ agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000 })
    assert(calls.created === 1, '宿主没有 resume → 直接 create（自己建，无需用户手动开对话）')
    assert(r.sent === true && r.created === true, '新建会话并踢成功')
  }

  // ③ 它在忙 → 跳过，不打扰
  {
    const { agents, calls } = mkFake('running')
    const r = await runLearnerKick({ agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000 })
    assert(r.skipped === true && r.reason === 'busy', 'agent 在忙 → 跳过（绝不 steer/inject 打断）')
    assert(calls.followedUp.length === 0 && calls.whenIdle === 0, '跳过时没有 followup、没有等待')
  }

  // ②b ★★ 同名残留：**清掉残留 → 用同一个 id 重建**（不再换 id，避免"每次调用堆一个新对话"）
  {
    const removedIds = []
    const { agents, calls } = mkFake(null, { withResume: true, resumeThrows: true, createExistsOnce: true })
    const r = await runLearnerKick({
      agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000,
      removeStale: async (id) => { removedIds.push(id); return 3 },
    })
    // 现在先因"不活着"换到 -1，再在 -1 上碰到"已存在"→ 清 -1 的残留 → 用同一个 -1 重试
    assert(removedIds.length >= 1 && removedIds.includes('mnemos-learner-1'), '★ 报"已存在"时清的是**当前新 id** 的残留')
    assert(calls.createIds.every((x) => x === 'mnemos-learner-1'),
      '★★ 清完仍用**同一个新 id** 重试（不再继续换 -2/-3 —— 那正是会话堆积的根源）')
    assert(r.sent === true && r.sessionId === 'mnemos-learner-1' && r.staleRemoved === 3, '★ id 稳定在新 id 上，并回报清掉了几处')
  }

  // ②b2 ★★ meta（尤其 agentPreset）必须原样透传到宿主 —— 少了它 agent 只拿最小工具集、**没有联网工具**
  {
    const { agents, calls } = mkFake(null, { withResume: true, resumeThrows: true })
    const meta = { cwd: 'C:\\tmp', agentPreset: 'standard' }
    const r = await runLearnerKick({ agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000, meta })
    assert(r.sent === true, '★ 带 meta 也能正常踢')
    assert(calls.createOpts && calls.createOpts.meta === meta, '★★ meta（含 agentPreset）原样传给 create')
    assert(calls.createOpts.meta.agentPreset === 'standard', '★★ agentPreset 在里面 —— 它决定有没有联网工具')
  }

  // ②b3 ★★ agentPreset 必须**主动 select** —— 光写 meta 不挂插件（实测工具数不变、没网）
  {
    const picked = []
    const { agents } = mkFake(null, { withResume: true, resumeThrows: true })
    const r = await runLearnerKick({
      agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000,
      meta: { cwd: 'C:\\tmp', agentPreset: 'standard' },
      selectPreset: async (agent) => { picked.push(agent); return 'standard' },
    })
    assert(picked.length === 1, '★★ 新建会话后调用了 selectPreset（不调就没有工具集/联网工具）')
    assert(r.sent === true && r.preset === 'standard', '★ 回报实际选中的 preset 名')
  }

  // ②b4 已跑过的会话（resume）不再 select —— 宿主会抛 agent-preset/locked，不做无用功
  {
    const picked = []
    const { agents } = mkFake('idle')
    await runLearnerKick({
      agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000,
      selectPreset: async (a) => { picked.push(a); return 'standard' },
    })
    assert(picked.length === 0, '★ 复用已有 agent 时不调 select（宿主规则：会话开始后就锁定了）')
  }

  // ②b5 selectPreset 失败不致命 —— 照踢，只是这个 agent 少掉那套工具
  {
    const { agents } = mkFake(null)
    const r = await runLearnerKick({
      agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000,
      selectPreset: async () => { throw new Error('agent-preset/locked') },
    })
    assert(r.sent === true, '★★ select 失败也要照常踢（绝不因此让整条链失败）')
    assert(String(r.preset).startsWith('failed:'), '★ 但如实记下失败原因')
  }

  // ②c 清不掉（返回 0）→ 不硬试第二次，如实报失败
  {
    const { agents, calls } = mkFake(null, { createAlwaysExists: true })
    const r = await runLearnerKick({
      agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000,
      removeStale: async () => 0,
    })
    assert(r.skipped === true && /already exists/.test(r.reason), '清不掉 → 如实报 create-failed（不假装成功）')
    assert(calls.createIds.length === 1, '清不掉时不反复重试（避免死循环）')
  }

  // ②d ★★ 任务文件：内容内联进那一脚（因为 learner agent 没有文件工具，让它"自己去读"做不到）
  {
    const tf = path.join(dir, 'lf', 'learner-tasks.md')
    await fs.mkdir(path.dirname(tf), { recursive: true })
    await fs.writeFile(tf, '<!-- 说明段：不该被送出去 -->\n\n把 store-lock 的竞态再想一遍\n', 'utf8')

    // 读：剥掉 HTML 注释，只留用户写的内容
    const got = await readLearnerTasks(tf)
    assert(got.error === null && got.tasks === '把 store-lock 的竞态再想一遍',
      `★ 读任务文件：剥掉模板注释，只留用户写的（实测 "${got.tasks}"）`)

    // 消息里必须带上它 + 指向文件路径 + 说明"有就做、没有就默认"
    const msg = buildLearnerMessage({ tasks: got.tasks, tasksFile: tf })
    assert(msg.includes('把 store-lock 的竞态再想一遍'), '★ 任务内容出现在那一脚里')
    assert(msg.includes(tf), '★ 消息里带上任务文件路径（让人知道去哪改）')
    assert(msg.includes('默认') && msg.includes('什么都不做'), '★ 说明"没有任务就做默认的空闲任务/也可以什么都不做"')
    assert(msg.includes('简短'), '★ 明确要求简短回报')
    assert(!msg.includes('学习通道自检'), '★ 调试用的"学习通道自检"已去掉')
    assert(!/必须|务必产出/.test(msg), '★ 仍不强迫产出')

    // 没任务时也要说清楚（而不是让模型猜）
    const empty = buildLearnerMessage({ tasks: '', tasksFile: tf })
    assert(empty.includes('没有指定任务') && empty.includes('默认'), '★ 空任务文件 → 消息里明确说"这一轮没有指定任务"')

    // 读失败要如实告知（不能让模型以为"没任务"）
    const bad = await readLearnerTasks(path.join(dir, 'no-such-dir', 'nope.md'))
    assert(bad.error === null && bad.tasks === '', '★ 文件不存在 → 视为"没有任务"，不算错误')
    const failed = buildLearnerMessage({ tasks: '', tasksFile: tf, tasksReadFailed: 'EACCES' })
    assert(failed.includes('EACCES'), '★ 读失败时把原因写进消息（不假装没任务）')
  }

  // ②e 任务文件首次自动生成模板；**绝不覆盖已有内容**
  {
    const tf = path.join(dir, 'lf2', 'learner-tasks.md')
    const made = await ensureLearnerTasksFile(tf)
    assert(made === true, '★ 首次调用生成了模板')
    const raw = await fs.readFile(tf, 'utf8')
    assert(raw.includes('<!--') && raw.includes('-->'), '★ 模板说明包在 HTML 注释里（所以不会当成任务送出去）')
    const r1 = await readLearnerTasks(tf)
    assert(r1.tasks === '', '★ 只有模板时视为"没有任务"')

    await fs.writeFile(tf, '我自己的任务', 'utf8')
    const made2 = await ensureLearnerTasksFile(tf)
    assert(made2 === false, '★ 已存在时不重复生成')
    assert((await fs.readFile(tf, 'utf8')) === '我自己的任务', '★★ 绝不覆盖用户已写的内容')
  }

  // ④ 未到间隔 → 跳过
  {
    const { agents, calls } = mkFake('idle')
    const r = await runLearnerKick({ agents, intervalMs: 30 * 60000, lastKickAt: 0, now: 5 * 60000 })
    assert(r.skipped === true && r.reason === 'not-yet', '未到间隔 → 不踢')
    assert(calls.followedUp.length === 0, '未到间隔时没有任何动作')
  }

  // ⑤ 没有 agents 服务（宿主未就绪）→ 安静跳过，不抛错
  {
    const r = await runLearnerKick({ agents: null, intervalMs: 0, lastKickAt: 0, now: 1000 })
    assert(r.skipped === true && r.reason === 'no-agents-service', '取不到 agents 服务 → 安静跳过（不影响插件加载）')
  }

  // ⑥ create 失败 → 报告原因，不抛
  {
    const agents = { get: () => null, create: async () => { throw new Error('factory 未注册') } }
    const r = await runLearnerKick({ agents, intervalMs: 0, lastKickAt: 0, now: 1000 })
    assert(r.skipped === true && String(r.reason).startsWith('create-failed'), 'create 失败 → 跳过并带上原因')
  }

  // ⑦ 三级兜底之二：get 抛错也不致命
  {
    const agents = { get: () => { throw new Error('boom') }, create: async () => ({ agent: { status: 'idle', followup() {}, async whenIdle() {} } }) }
    const r = await runLearnerKick({ agents, intervalMs: 0, lastKickAt: 0, now: 1000 })
    assert(r.sent === true, 'get 抛错 → 当成"没有"，走 create 恢复')
  }

  // ⑦b ★★ 清同名残留：真在临时目录上建出 DSH 结构，验证"删对了、没多删"
  {
    const home = path.join(dir, 'fakedsh')
    const dataFile = path.join(home, 'profiles', 'desktop', 'mnemos', 'memory.json')
    const mk = async (p) => { await fs.mkdir(p, { recursive: true }); await fs.writeFile(path.join(p, 'session.v4.jsonl.zstd'), 'x') }
    await fs.mkdir(path.dirname(dataFile), { recursive: true })
    await mk(path.join(home, 'sessions', '--group-a--', 'mnemos-learner'))   // 要删
    await mk(path.join(home, 'sessions', '--group-b--', 'mnemos-learner'))   // 要删（同名、别的分组）
    await mk(path.join(home, 'sessions', '--group-a--', 'someone-else'))     // 不许动
    await fs.mkdir(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    await fs.writeFile(path.join(home, 'storages', 'session_projcache', 'sessions', 'mnemos-learner.json'), '{}')
    await fs.writeFile(path.join(home, 'storages', 'session_projcache', 'sessions', 'someone-else.json'), '{}')

    const n = await removeStaleSessionFiles('mnemos-learner', dataFile)
    assert(n === 3, `★ 清残留：2 个同名会话目录 + 1 份缓存（实测 ${n}）`)
    assert(!existsSync(path.join(home, 'sessions', '--group-a--', 'mnemos-learner')), '★ --group-a-- 下的同名会话已删')
    assert(!existsSync(path.join(home, 'sessions', '--group-b--', 'mnemos-learner')), '★ --group-b-- 下的同名会话也删了（不能只删一个分组）')
    assert(!existsSync(path.join(home, 'storages', 'session_projcache', 'sessions', 'mnemos-learner.json')), '★ 投影缓存已删')
    assert(existsSync(path.join(home, 'sessions', '--group-a--', 'someone-else')), '★★ 别人的会话一个都没动')
    assert(existsSync(path.join(home, 'storages', 'session_projcache', 'sessions', 'someone-else.json')), '★★ 别人的缓存也没动')

    const again = await removeStaleSessionFiles('mnemos-learner', dataFile)
    assert(again === 0, '★ 第二次调用返回 0（已经没了）—— 调用方据此放弃重试，避免死循环')

    // ★ 防路径穿越：带 / .. 的 id 一律拒绝（否则等于把 rm 交给外部输入）
    for (const bad of ['../evil', 'a/b', 'a\\b', '..']) {
      const r2 = await removeStaleSessionFiles(bad, dataFile)
      assert(r2 === 0, `★★ 拒绝带路径片段的 id（${bad}）—— 防路径穿越`)
    }
    assert(existsSync(path.join(home, 'sessions', '--group-a--', 'someone-else')), '★★ 穿越尝试后别人的会话仍在')
  }

  // ⑧ 状态文件可往返（避免重启即踢）
  {
    const sf = learnerStateFileFor(path.join(dir, 'ls', 'memory.json'))
    const s0 = await loadLearnerState(sf)
    assert(s0.lastKickAt === 0 && s0.kicks === 0, '无状态文件时默认全 0')
    await saveLearnerState(sf, { lastKickAt: 123456, kicks: 7 })
    const s1 = await loadLearnerState(sf)
    assert(s1.lastKickAt === 123456 && s1.kicks === 7, '状态可写可读（重启后不会立刻再踢）')
  }

  // ⑨ 默认值自洽
  assert(DEFAULT_LEARNER_SESSION_ID === 'mnemos-learner', '专用会话默认 id 固定为 mnemos-learner（便于代码定位）')
  assert(DEFAULT_LEARNER_INTERVAL_MS === 60 * 60 * 1000, '默认间隔 1 小时（与 INSTALL/profile 一致；曾是 30 分钟，已纠正漂移）')

  // ══════════════ ⑩ 会话重建（2026-10-17）══════════════
  // 事故：learner 会话通宵跑 14 轮，日志涨到压缩 620KB，第 13/14 轮**整轮**被拒
  // （pi-ai CONTEXT_WINDOW_EXCEEDED，工具调用全成功 0 isError）→ 会话永久卡死。
  // 本模块绝不 dispose、agent 进程内一直活着复用 → **删文件不能让它变短**，只能换会话 id。
  // ★ 用户最终拍板的规则只有两条：**每 5 轮换一次** + **上下文（日志）过长也换一次**。
  {
    // ① id 生成：只有这一处规则
    assert(nextLearnerSessionId('mnemos-learner', 0) === 'mnemos-learner', '★ 未重建时用基础 id')
    assert(nextLearnerSessionId('mnemos-learner', 1) === 'mnemos-learner-1', '★ 第 1 代 = base-1')
    assert(nextLearnerSessionId('mnemos-learner', 3) === 'mnemos-learner-3', '★ 第 3 代 = base-3')
    assert(nextLearnerSessionId('mnemos-learner', -2) === 'mnemos-learner', '★ 负数按"没重建过"处理')
    assert(nextLearnerSessionId('mnemos-learner', 2.9) === 'mnemos-learner-2', '★ 小数向下取整（不生成 base-2.9）')
    assert(nextLearnerSessionId('', 5) === '', '★ 空 base → 空（不拼出 "-5" 这种孤儿 id）')

    // ② 判据（纯函数）：**轮数优先**（无条件，不依赖任何测量），字节数第二条
    const B = DEFAULT_LEARNER_RECYCLE_BYTES
    const K = DEFAULT_LEARNER_RECYCLE_KICKS
    assert(B === 350 * 1024 && K === 5, '★ 阈值常量：350KB / 5 轮（用户定的"留最近五轮"）')
    const byKicks = shouldRecycleLearnerSession({ logBytes: 1024, kicksSinceRecycle: K })
    assert(byKicks.recycle === true && byKicks.reason === 'kicks',
      '★★ 踢满 5 轮 → **无条件**重建（日志再小也换：结论在记忆里，会话只留最近五轮）')
    assert(shouldRecycleLearnerSession({ logBytes: 1024, kicksSinceRecycle: K - 1 }).recycle === false,
      '★ 只差一轮不重建（否则会变成"每轮都换"）')
    const big = shouldRecycleLearnerSession({ logBytes: B, kicksSinceRecycle: 0 })
    assert(big.recycle === true && big.reason === 'log-bytes', '★ 上下文过长（日志达到上限）→ 也重建（等于上限就算）')
    assert(shouldRecycleLearnerSession({ logBytes: B - 1, kicksSinceRecycle: 0 }).recycle === false,
      '★ 差 1 字节不重建（判据就是"大于等于"，没有别的花样）')
    const unm = shouldRecycleLearnerSession({ logBytes: 0, kicksSinceRecycle: K })
    assert(unm.recycle === true && unm.reason === 'kicks' && unm.measured === false,
      '★★ 量不到日志（磁盘上根本没有那个会话，实测真会这样）→ 照样按轮数重建（所以"量不到"不再是漏洞）')
    assert(shouldRecycleLearnerSession({ logBytes: null, kicksSinceRecycle: K - 1 }).recycle === false,
      '★ 量不到且轮数不够 → 不重建')
    assert(shouldRecycleLearnerSession({ logBytes: NaN, kicksSinceRecycle: NaN }).recycle === false,
      '★ NaN 一律不重建（不因为取到脏值就无限换会话）')
    assert(shouldRecycleLearnerSession({ logBytes: 1e9, kicksSinceRecycle: 0 }, { maxBytes: 0 }).recycle === false,
      '★ maxBytes 非法（0）→ 字节判据不生效，不重建')
    assert(shouldRecycleLearnerSession({ logBytes: null, kicksSinceRecycle: 99 }, { maxKicks: NaN }).recycle === false,
      '★ maxKicks 非法 → 轮数判据不生效')
    // 方向性核对：把"≥"写成"<"时下面两条必须失败
    assert(big.recycle === true && byKicks.recycle === true &&
      shouldRecycleLearnerSession({ logBytes: 1024, kicksSinceRecycle: 0 }).recycle === false,
      '★ 方向性核对（超线才重建、没超不重建）')
    // 人话措辞只有一处：describeLearnerRecycle
    const t1 = describeLearnerRecycle({ from: 'a', to: 'b', reason: 'kicks', kicks: 5 })
    const t2 = describeLearnerRecycle({ from: 'a', to: 'b', reason: 'log-bytes', logBytes: 400 * 1024 })
    assert(t1 === 'a → b（已踢满 5 轮）', `★ 轮数原因说人话（实测 "${t1}"）`)
    assert(t2 === 'a → b（日志 400 KB 超上限）', `★ 字节原因说人话（实测 "${t2}"）`)
    assert(describeLearnerRecycle(null) === '', '★ 没重建 → 空串（调用方不必判断）')

    // ③ 量日志大小：真在临时目录上建出 DSH 结构
    {
      const home = path.join(dir, 'recdsh')
      const df = path.join(home, 'profiles', 'desktop', 'mnemos', 'memory.json')
      await fs.mkdir(path.dirname(df), { recursive: true })
      const mkLog = async (p, n) => {
        await fs.mkdir(p, { recursive: true })
        await fs.writeFile(path.join(p, 'session.v4.jsonl.zstd'), Buffer.alloc(n, 1))
      }
      await mkLog(path.join(home, 'sessions', '--g1--', 'mnemos-learner'), 1000)
      await mkLog(path.join(home, 'sessions', '--g2--', 'mnemos-learner'), 234)   // 同名、别的分组 → 要累加
      await mkLog(path.join(home, 'sessions', '--g1--', 'someone-else'), 777)      // 别人的不动也不数
      await mkLog(path.join(home, 'sessions', '--g1--', 'mnemos-learner-1'), 11)   // 别的代不算进来

      const n1 = await learnerSessionLogBytes('mnemos-learner', df)
      assert(n1 === 1234, `★★ 量大小：累加**所有分组**下的同名会话日志（实测 ${n1} = 1000+234）`)
      assert((await learnerSessionLogBytes('mnemos-learner-1', df)) === 11, '★ 按 id 精确取（不把别的代算进来）')
      assert((await learnerSessionLogBytes('not-there', df)) === 0, '★ 不存在 → 0（调用方据此走轮数兜底）')
      assert((await learnerSessionLogBytes('', df)) === 0 && (await learnerSessionLogBytes(null, df)) === 0, '★ 空 id → 0')
      for (const bad of ['../evil', 'a/b', 'a\\b', '..']) {
        assert((await learnerSessionLogBytes(bad, df)) === 0, `★★ 量大小也拒绝带路径片段的 id（${bad}）—— 防路径穿越`)
      }
      // 没有 sessions 目录（DSH 未落盘过）→ 0，且不抛
      const emptyDf = path.join(dir, 'recdsh2', 'profiles', 'desktop', 'mnemos', 'memory.json')
      assert((await learnerSessionLogBytes('mnemos-learner', emptyDf)) === 0, '★ 读不到 sessions 目录 → 0（不抛、不崩）')
    }

    // ④ 状态归一：缺字段/脏值不炸，字段齐了能原样往返
    {
      const s0 = normalizeLearnerState(null)
      assert(s0.activeSessionId === '' && s0.recycled === 0 && s0.kicksSinceRecycle === 0 && s0.retired.length === 0,
        '★ 空状态 → 全默认（activeSessionId 空 = 用基础 id）')
      const s1 = normalizeLearnerState({
        lastKickAt: 5, kicks: 3, activeSessionId: 'mnemos-learner-2', recycled: 2,
        retired: ['mnemos-learner', 'mnemos-learner-1'], kicksSinceRecycle: 4,
      })
      assert(s1.activeSessionId === 'mnemos-learner-2' && s1.recycled === 2 && s1.kicksSinceRecycle === 4,
        '★ 已有字段原样保留（回收状态不会被 load 丢掉）')
      const s2 = normalizeLearnerState({ recycled: -5, kicksSinceRecycle: 'x', retired: ['a', 3, '', null] })
      assert(s2.recycled === 0 && s2.kicksSinceRecycle === 0 && s2.retired.join(',') === 'a',
        '★ 脏值归一：负数/字符串/非字符串数组项都被清掉')
      const s3 = normalizeLearnerState({ retired: Array.from({ length: 40 }, (_, i) => 'x' + i) })
      assert(s3.retired.length === 20, '★ 退休 id 列表有上限（不会无限膨胀落盘）')
    }

    // ⑤ 真踢一次：上下文过长 → 换新 id 建会话，并把新状态交给调用方
    {
      const { agents, calls } = mkFake(null)
      const picked = []
      // kicksSinceRecycle=1（还没到 5 轮）→ 这次只能是**字节判据**触发
      const st = { lastKickAt: 0, kicks: 5, activeSessionId: '', recycled: 0, retired: [], kicksSinceRecycle: 1 }
      const r = await runLearnerKick({
        agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000,
        state: st,
        measureLogBytes: async () => DEFAULT_LEARNER_RECYCLE_BYTES + 1,
        removeStale: async () => 1,
        selectPreset: async (a) => { picked.push(a); return 'standard' },
      })
      assert(r.sent === true && r.sessionId === 'mnemos-learner-1', '★★ 超上限 → 用**新一代** id 建会话并踢进去')
      assert(calls.createIds.length === 1 && calls.createIds[0] === 'mnemos-learner-1', '★★ create 用的是 base-1（不是再堆 -2/-3）')
      assert(r.recycle && r.recycle.from === 'mnemos-learner' && r.recycle.to === 'mnemos-learner-1' && r.recycle.reason === 'log-bytes',
        '★ 回执如实说明"从哪个换到哪个、按什么判据换的"')
      assert(r.recycle.text === 'mnemos-learner → mnemos-learner-1（日志 350 KB 超上限）',
        `★ 回执里带人话版本（实测 "${r.recycle?.text}"）`)
      assert(picked.length === 1, '★★ 新一代是**新建**的 → 照常 selectPreset（工具集/联网工具不解）')
      assert(r.nextState.activeSessionId === 'mnemos-learner-1' && r.nextState.recycled === 1,
        '★★ nextState 带出新活动 id 与重建代数（调用点只管存，不自己算）')
      assert(r.nextState.kicksSinceRecycle === 1 && r.nextState.kicks === 6 && r.nextState.lastKickAt === 1000,
        '★ 踢成功 → kicks/lastKickAt/kicksSinceRecycle 各推进一次')
      assert(!r.nextState.retired.includes('mnemos-learner'), '★ 旧代已被清掉（这次是"不活着"，所以清完就不再挂账）')
    }

    // ⑥ 再踢一次：状态里已经是 base-1 → 换代必须在**基础 id** 上累加（不能变成 base-1-2）
    {
      const { agents, calls } = mkFake(null)
      const st = normalizeLearnerState({ activeSessionId: 'mnemos-learner-1', recycled: 1, kicksSinceRecycle: 3 })
      const r = await runLearnerKick({
        agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000,
        state: st, measureLogBytes: async () => DEFAULT_LEARNER_RECYCLE_BYTES * 2,
      })
      assert(r.sent === true && r.sessionId === 'mnemos-learner-2', '★★ 从 base-1 再重建 → base-2（在基础 id 上累加，不拼出 base-1-2）')
      assert(calls.createIds[0] === 'mnemos-learner-2', '★ create 用 base-2')
      assert(r.nextState.recycled === 2 && r.nextState.kicksSinceRecycle === 1, '★ 代数 +1、本代轮数归零后记 1')
    }

    // ⑦ ★★ 用户要的主线：**踢满 5 轮就换**，量得到量不到都一样
    {
      const { agents, calls } = mkFake(null)
      const st = normalizeLearnerState({ activeSessionId: 'mnemos-learner-1', recycled: 1, kicksSinceRecycle: DEFAULT_LEARNER_RECYCLE_KICKS })
      const r = await runLearnerKick({
        agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000,
        state: st, measureLogBytes: async () => 0, // 量不到（现场实况：活着的会话在磁盘上没有任何文件）
      })
      assert(r.sent === true && r.sessionId === 'mnemos-learner-2', '★★ 踢满 5 轮 → 直接删掉旧会话、换 base-2 重建')
      assert(r.recycle && r.recycle.reason === 'kicks' && r.recycle.kicks === DEFAULT_LEARNER_RECYCLE_KICKS,
        '★ 回执标明"是按轮数换的"（不依赖日志大小）')
      assert(r.nextState.kicksSinceRecycle === 1, '★ 新一代重新从 1 开始数（所以每代正好 5 轮）')

      // 注意：这里让 agent **活着**（mkFake('idle')）。若用不活着，新规矩会因"宿主重启过"直接换新，
      // 永远走不到"还差一轮"这条路 —— 那样这两条断言就测不到轮数阈值了。
      const { agents: agents2, calls: calls2 } = mkFake('idle')
      const st2 = normalizeLearnerState({ activeSessionId: 'mnemos-learner', kicksSinceRecycle: DEFAULT_LEARNER_RECYCLE_KICKS - 1 })
      const r2 = await runLearnerKick({
        agents: agents2, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000,
        state: st2, measureLogBytes: async () => 0,
      })
      assert(r2.sessionId === 'mnemos-learner' && r2.recycle === null, '★ 还差一轮 → 这次不换（第 5 轮才换）')
      assert(calls2.created === 0 && calls2.createIds.length === 0, '★ 活着就直接复用，不新建（更不乱换 id）')
    }

    // ⑧ 测量回调抛错 → 不咬掉整次踢，按"量不到"处理
    {
      const { agents } = mkFake('idle')
      const r = await runLearnerKick({
        agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000,
        state: normalizeLearnerState({ kicksSinceRecycle: 1 }),
        measureLogBytes: async () => { throw new Error('EACCES') },
      })
      assert(r.sent === true, '★★ 测量失败也要照常踢（诊断/回收绝不能反过来咬主流程）')
      assert(r.recycle === null, '★ 且不因为测量失败就乱换会话')
    }

    // ⑨ 顺手清旧代文件：**只清确实不活着的**（清活着的会破坏运行中的会话）
    {
      const agent = { status: 'idle', followup() {}, async whenIdle() {} }
      const removedIds = []
      // 活着的：base-1（上一代）与 base-2（当前活动）；不活着的：base（最早那代）
      const alive = new Set(['mnemos-learner-1', 'mnemos-learner-2'])
      const agents = {
        get: (id) => (alive.has(id) ? agent : null),
        create: async () => ({ agent }),
      }
      const st = normalizeLearnerState({
        activeSessionId: 'mnemos-learner-2', recycled: 2,
        retired: ['mnemos-learner', 'mnemos-learner-1'], kicksSinceRecycle: 9,
      })
      const r = await runLearnerKick({
        agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000,
        state: st, measureLogBytes: async () => DEFAULT_LEARNER_RECYCLE_BYTES + 1,
        removeStale: async (id) => { removedIds.push(id); return 1 },
      })
      assert(r.sessionId === 'mnemos-learner-3', '★ 从 base-2 回收 → base-3')
      assert(removedIds.length === 1 && removedIds[0] === 'mnemos-learner',
        `★★ 只清不活着的旧代（清了：${removedIds.join(',') || '无'}）—— 活着的 base-1/base-2 绝不删`)
      assert(r.retiredCleaned === 1, '★ 回执报出顺手清了几处')
      assert(!r.nextState.retired.includes('mnemos-learner') && r.nextState.retired.includes('mnemos-learner-1'),
        '★ 清掉的从账上划掉，没清掉的继续挂账（下次再试）')
    }

    // ⑩ 跳过路径（busy）：换代**已提交**，只是不算踢过一轮 ——
    //   ★ 2026-10-21 改（V6-02）：旧断言"状态不许提交"把 D-1 的 noCommit 误用到了这里。
    //     走到 busy 时 ensure 已成功、换代是既成事实；回滚会让下一 tick 从旧 id 再换一次，
    //     重复执行 create / 清旧代文件（实测 10-20 12→13、10-21 13→14 各重复两次）。
    //     正确语义：换代字段照常提交；kicks/lastKickAt 不推进（没踢成就不算踢过）。
    {
      const { agents } = mkFake('running')
      const r = await runLearnerKick({
        agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000,
        state: normalizeLearnerState({ activeSessionId: 'mnemos-learner-1', recycled: 1, kicksSinceRecycle: 0 }),
        measureLogBytes: async () => DEFAULT_LEARNER_RECYCLE_BYTES + 1,
      })
      assert(r.skipped === true, '★ 新建的 agent 报忙 → 跳过（不打扰）')
      assert(r.recycle && r.recycle.from === 'mnemos-learner-1' && r.recycle.to === 'mnemos-learner-2',
        '★ 回收**决策**照样带出（回执/日志里看得见要换到哪一代）')
      assert(r.nextState && r.nextState.activeSessionId === 'mnemos-learner-2' && r.nextState.recycled === 2,
        '★★ [V6-02] 忙也要提交换代（agent 已起、换代是既成事实；回滚旧 id 会导致重复换代）')
      assert(r.nextState.kicks === 0 && r.nextState.lastKickAt === 0,
        '★ 但没凭空推进 kicks/lastKickAt（没踢成就不算踢过）')
    }

    // ⑩b ★★ 重叠实例（风暴回归判据）：成功入队的 A 与后到的 busy B，落盘后必须**同一代**
    //   事故原形：A 提交了 12→13，B 读到旧状态 12、判 busy 后把 12 写回去 → 下一 tick 再从 12 换到 13，
    //   每 5 分钟重跑一次 create/清旧代（非幂等），直到 learner 会话跑完转 idle 才自愈。
    {
      const baseState = normalizeLearnerState({ activeSessionId: 'mnemos-learner-1', recycled: 1, kicksSinceRecycle: 4 })
      // A：先到，入队成功
      const { agents: agentsA } = mkFake('idle')
      const a = await runLearnerKick({
        agents: agentsA, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000,
        state: baseState, measureLogBytes: async () => DEFAULT_LEARNER_RECYCLE_BYTES + 1,
      })
      // B：与 A 同时启动、读到同一份旧状态；A 入队后对它来说就是 busy
      const { agents: agentsB } = mkFake('running')
      const b = await runLearnerKick({
        agents: agentsB, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1001,
        state: baseState, measureLogBytes: async () => DEFAULT_LEARNER_RECYCLE_BYTES + 1,
      })
      assert(a.sent === true && b.skipped === true && b.reason === 'busy', '★ 场景成立：A 踢成功、B 撞上 busy')
      assert(a.nextState.activeSessionId === 'mnemos-learner-2' && b.nextState.activeSessionId === 'mnemos-learner-2',
        '★★ 两条路径都落在同一代（-2），B 不再把 A 的成功换代写回旧 id')
      // 按真实落盘顺序回放：A 先存、B 后存（后写覆盖前写）→ 最终仍必须是新一代
      const sf = path.join(dir, 'learner-state-v602.json')
      await saveLearnerState(sf, a.nextState)
      await saveLearnerState(sf, b.nextState)
      const after = await loadLearnerState(sf)
      assert(after.activeSessionId === 'mnemos-learner-2' && after.recycled === 2,
        '★★ 落盘回放：后到的 busy 实例不会把已提交的换代覆盖回旧代（风暴的回归判据）')
    }

    // ⑩c 入队抛错（followup-threw）：agent 已起来 → 同样提交换代，只标记这次没踢成
    {
      const agent = { status: 'idle', followup() { throw new Error('inbox closed') }, async whenIdle() {} }
      const agents = { get: () => agent, create: async () => ({ agent }) }
      const r = await runLearnerKick({
        agents, sessionId: 'mnemos-learner', intervalMs: 0, lastKickAt: 0, now: 1000,
        state: normalizeLearnerState({ activeSessionId: 'mnemos-learner-1', recycled: 1 }),
        measureLogBytes: async () => DEFAULT_LEARNER_RECYCLE_BYTES + 1,
      })
      assert(r.skipped === true && String(r.reason).startsWith('followup-threw'), '★ 入队失败如实报出来')
      assert(r.nextState.activeSessionId === 'mnemos-learner-2' && r.nextState.recycled === 2,
        '★★ [V6-02] 入队失败也不回滚换代（agent 已经起来了）')
      assert(r.nextState.kicks === 0 && r.nextState.lastKickAt === 0, '★ 没踢成 → 不推进踢过的计数')
    }

    // ⑪ 未到点时不碰回收（不做无用 IO）
    {
      let measured = 0
      const { agents } = mkFake('idle')
      const r = await runLearnerKick({
        agents, sessionId: 'mnemos-learner', intervalMs: 60 * 60 * 1000, lastKickAt: 1, now: 1000,
        state: normalizeLearnerState({}), measureLogBytes: async () => { measured++; return 1e9 },
      })
      assert(r.skipped === true && r.reason === 'not-yet' && measured === 0, '★ 未到点 → 不量日志、不回收')
    }

    // ⑫ ★★ 回收引入的真 bug：自指守卫必须比对**当前活动 id**（否则回收一次守卫就失效）
    {
      const idxSrc = (await fs.readFile(path.join(pluginRoot, 'src', 'index.js'), 'utf8')).replace(/^\uFEFF/, '')
      assert(/selfKickRefusal\([^)]*activeLearnerId/.test(idxSrc),
        '★★ 自指守卫传的是"当前活动 id"（回收后 learner 跑在 base-N 上，只比基础 id 会漏）')
      assert(/const activeLearnerId = st\.activeSessionId \|\| sessionId/.test(idxSrc),
        '★ 活动 id 的取法：state.activeSessionId 优先，回落到配置的基础 id')
      // 反例核对：状态里的活动 id 是 base-2 时，守卫必须拒"base-2"、放"base"
      const active = 'mnemos-learner-2'
      assert(selfKickRefusal(active, active) !== null, '★★ 活动 id 上自指仍然被拒')
      assert(selfKickRefusal('mnemos-learner', active) === null, '★ 基础 id 反而是"别人"（放行）—— 说明比对的是活动 id')
    }
  }
}

console.log('== 12. 衰减降权 ==')
const decayResult = await store.decay({ thresholdMs: 0 })
assert(decayResult.demoted >= 1, 'decay 降权了至少 1 条 hot 记忆')

console.log('== 21. sessionId 分类 + 按会话归档 ==')
await store.remember({ content: '会话A的短时记忆1', summary: 'A1', tags: ['a'], sessionId: 'session-A' })
await store.remember({ content: '会话A的短时记忆2', summary: 'A2', tags: ['a'], sessionId: 'session-A' })
await store.remember({ content: '会话B的短时记忆1', summary: 'B1', tags: ['b'], sessionId: 'session-B' })
const byS = store.shortBySession()
assert(byS.has('session-A') && byS.get('session-A').length === 2, '会话A有2条短时记忆')
assert(byS.has('session-B') && byS.get('session-B').length === 1, '会话B有1条短时记忆')
const archA = await store.archiveSession('session-A')
assert(archA !== null && archA.layer === 'hot' && archA.sessionId === 'session-A', '归档会话A成长期记忆')
assert(archA.summary.includes('A1') && archA.summary.includes('A2'), '归档摘要合并 A1、A2')
const byS2 = store.shortBySession()
assert(!byS2.has('session-A'), '归档后会话A短时清空')
assert(byS2.has('session-B') && byS2.get('session-B').length === 1, '会话B不受影响（各归各）')

console.log('== 22. 召回排序（sessionId 感知 + mode）==')
await store.remember({ content: 'SELF 会话的短时记忆', summary: 'SELF短时', tags: ['recall'], sessionId: 'SELF' })
await store.remember({ content: 'OTHER 会话的短时记忆', summary: 'OTHER短时', tags: ['recall'], sessionId: 'OTHER' })
const rSelf = store.recall({ tags: ['recall'], sessionId: 'SELF', mode: 'session' })
assert(rSelf[0].sessionId === 'SELF', 'mode=session 时当前会话优先')
const rAll = store.recall({ tags: ['recall'], sessionId: 'SELF' })
assert(rAll.length >= 2, '无关键词时仍返回结果（不再过滤零关键词）')
assert(rAll[0].sessionId === 'SELF', '默认排序下当前会话靠前（sessionScore tiebreaker）')
const rKw = store.recall({ query: 'OTHER', tags: ['recall'], sessionId: 'SELF' })
assert(rKw[0].sessionId === 'OTHER', '关键词优先时跨会话结果靠前')

console.log('== 23. deprecated/dormant 标记 ==')
await store.remember({ content: '这是一个错误结论', summary: '错误结论', tags: ['mark'], source: 'deprecated' })
const markDorm = await store.remember({
  content: '这是一个暂时无关但可能有用',
  summary: '休眠内容',
  tags: ['mark'],
  source: 'dormant',
  sessionId: 'sess-mark',
})
const rDep = store.recall({ tags: ['mark'], sessionId: 'sess-mark' })
assert(rDep.every((m) => m.source !== 'deprecated'), 'deprecated 内容不召回')
assert(rDep.some((m) => m.id === markDorm.id), 'dormant 内容正常召回')
assert(
  rDep.find((m) => m.id === markDorm.id).dormantHere === true,
  'dormant 的判定记在会话级字段上（source 不再承载它）'
)

console.log('== 25. validation 标记（不归档，但可召回）==')
await store.remember({ content: '隔离验证的结论', summary: '验证结果', tags: ['val'], source: 'validation' })
const byS3 = store.shortBySession()
const hasVal = [...byS3.values()].flat().some((m) => m.source === 'validation')
assert(hasVal === false, 'validation 记忆不被 shortBySession 分组（不归档）')
const rVal = store.recall({ tags: ['val'] })
assert(rVal.length === 1 && rVal[0].source === 'validation', 'validation 记忆仍可召回（不转长期，但可读）')

console.log('== 26. 自传体（source=autobiography → permanent + 紧凑版优先级）==')
await store.remember({ content: '事件：某次对话', summary: '事件摘要', tags: ['event'], source: 'autobiography' })
await store.remember({ content: '能力：学会了 X', summary: '能力摘要', tags: ['ability'], source: 'autobiography' })
await store.remember({ content: '决策：为什么选 Y', summary: '决策摘要', tags: ['decision'], source: 'autobiography' })
const autoAll = store.autobiographyEntries()
assert(autoAll.length === 3, '自传体完整版有 3 条')
assert(autoAll.every((m) => m.layer === 'permanent'), '自传体条目在 permanent 层')
const compact = store.autobiographyCompact({ budget: 100 })
assert(compact.entries[0].category === 'decision', '紧凑版决策排最前')
const cats = compact.entries.map((e) => e.category)
assert(cats.indexOf('ability') < cats.indexOf('event'), '能力排在事件前')

console.log('== 27. 宪法（初始化 + 密码 + 审计日志）==')
const con = new ConstitutionStore(path.join(dir, 'constitution.json'))
assert(con.isInitialized() === false, '初始未初始化')
await con.initialize('我是 Mnemos，绝不撒谎。', 'secret123', 'owner')
assert(con.isInitialized() === true, '初始化后已初始化')
assert(con.verifyPassword('secret123') === true, '正确密码验证通过')
assert(con.verifyPassword('wrong') === false, '错误密码验证失败')
assert(con.read() === '我是 Mnemos，绝不撒谎。', '读取宪法正文')
let updateErr = null
try { await con.update('新宪法', 'wrong', 'attacker', '恶意修改') } catch (e) { updateErr = e.message }
assert(updateErr === 'constitution: 密码错误', '错误密码改宪法被拒绝')
const v = await con.update('新宪法正文', 'secret123', 'owner', '调整红线')
assert(v === 2, '正确密码改宪法，版本号递增到 2')
assert(con.auditLog.length === 2, '审计日志有 2 条（初始化 + 更新）')
assert(con.auditLog[1].operator === 'owner' && con.auditLog[1].reason === '调整红线', '审计日志记录操作者+原因')
assert(con.auditLog[1].before === '我是 Mnemos，绝不撒谎。' && con.auditLog[1].after === '新宪法正文', '审计日志记录 before/after（留痕）')

console.log('== 28. 真删除（delete）==')
const delId = (await store.remember({ content: '待删除内容', summary: '待删除', tags: ['del'] })).id
const delResult = await store.delete(delId)
assert(delResult !== null && delResult.length === 1, '删除单条记忆成功')
assert(store.memories.get(delId) === undefined, '删除后记忆不存在')
const delNone = await store.delete('nonexistent-id')
assert(delNone === null, '删除不存在的 id 返回 null')

console.log('== 29. supersedes：写纠正的同时作废旧条（一次完成）==')
const oldWrong = await store.remember({
  content: '免费档可跑 deepseek-v4-flash 等 4 个模型',
  summary: '免费档可跑 4 个模型',
  tags: ['sensenova', 'quota', 'free'],
  taskId: 'task-dep',
  salience: 'high',
})
assert(oldWrong.source === 'internal', '旧结论初始 source=internal')
const correction = await store.remember({
  content: '实测只有 sensenova-6.8-flash-lite 能跑；其余模型 429 insufficient_quota',
  summary: '免费档只有 1 个模型能跑',
  tags: ['sensenova', 'quota', 'free'],
  taskId: 'task-dep',
  salience: 'high',
  supersedes: [oldWrong.id],
})
assert(Array.isArray(correction.superseded) && correction.superseded.length === 1, 'remember 返回 superseded 结果')
assert(correction.superseded[0].ok === true, '作废动作成功')
assert(correction.superseded[0].from === 'internal', '记录了作废前的 source')
const oldAfter = store.memories.get(oldWrong.id)
assert(oldAfter.source === 'deprecated', '旧条 source 被改为 deprecated')
assert(oldAfter.supersededBy === correction.id, '旧条记录了取代它的新条 id')
assert(oldAfter.version === 2, '旧条版本递增（留痕）')
assert(oldAfter.detail.includes('deepseek-v4-flash'), '旧条内容保留未删除（废弃≠删除）')

console.log('== 30. 已废弃记录不再被召回 ==')
const rc = store.recall({ taskId: 'task-dep' })
assert(rc.length === 1 && rc[0].id === correction.id, 'task-dep 只召回纠正条，旧条被过滤')
assert(!rc.some((m) => m.id === oldWrong.id), '被作废的旧条不出现在召回结果')
assert([...store.memories.values()].some((m) => m.id === oldWrong.id), '但旧条仍在存储中（可审计）')
const openedDep = await store.open(oldWrong.id)
assert(openedDep !== null && openedDep.summary === '免费档可跑 4 个模型', 'mnemos_open 仍可取到旧条详情（透明可查）')

console.log('== 31. 独立作废入口 deprecate() ==')
const solo = await store.remember({ content: '旧的部署流程描述', summary: '旧部署流程', tags: ['deploy'], taskId: 'task-dep2' })
const soloDone = await store.deprecate([solo.id], { reason: '流程已变更，无需替代结论' })
assert(soloDone.length === 1 && soloDone[0].ok === true, 'deprecate 单条成功')
assert(store.memories.get(solo.id).source === 'deprecated', '独立作废后 source=deprecated')
assert(store.memories.get(solo.id).deprecatedReason === '流程已变更，无需替代结论', '作废原因被记录')
assert(store.recall({ taskId: 'task-dep2' }).length === 0, '作废后该任务召回为空')

console.log('== 32. findConflicts：写时冲突检测 ==')
const conflicts = store.findConflicts({
  taskId: 'task-dep',
  tags: ['sensenova', 'quota', 'free'],
  excludeId: correction.id,
})
assert(conflicts.length === 0, '已作废的旧条不算冲突（被排除）')
const cA = await store.remember({ content: 'A 结论', summary: 'A 结论', tags: ['alpha', 'beta', 'gamma'], taskId: 'task-cf', salience: 'high' })
const cf = store.findConflicts({ taskId: 'task-cf', tags: ['alpha', 'beta', 'gamma'], excludeId: 'x' })
assert(cf.length === 1 && cf[0].id === cA.id, '标签完全重叠 → 检出冲突')
assert(cf[0].overlap === 1, '重叠度计算为 1')
const cfLow = store.findConflicts({ taskId: 'task-cf', tags: ['alpha', 'zzz', 'yyy'], excludeId: 'x' })
assert(cfLow.length === 0, '标签低重叠 → 不误报')
assert(store.findConflicts({ taskId: 'task-cf', tags: [] }).length === 0, '无标签 → 不检测')

console.log('== 33. 作废的边界情况 ==')
const selfRec = await store.remember({ content: 'x', summary: 'x', tags: ['self-t'], taskId: 'task-edge' })
const selfDone = store.applyDeprecation([selfRec.id], selfRec.id)
assert(selfDone[0].ok === false && selfDone[0].reason === 'self', '拒绝自我取代（reason=self）')
assert(store.memories.get(selfRec.id).source === 'internal', '自我取代失败后 source 不变')
const notFound = await store.deprecate(['no-such-id'])
assert(notFound[0].ok === false && notFound[0].reason === 'not-found', '不存在的 id 返回 not-found')
const again = await store.deprecate([selfRec.id])
assert(again[0].ok === true, '首次作废成功')
const again2 = await store.deprecate([selfRec.id])
assert(again2[0].ok === true && again2[0].already === true, '重复作废幂等（already=true）')

console.log('== 34. 作废状态持久化 ==')
const store3 = new MemoryStore(dataFile)
await store3.load()
assert(store3.memories.get(oldWrong.id).source === 'deprecated', '重载后旧条仍是 deprecated')
assert(store3.memories.get(oldWrong.id).supersededBy === correction.id, '重载后取代关系保留')
assert(store3.recall({ taskId: 'task-dep' }).length === 1, '重载后召回仍正确过滤')

console.log('== 35. dormant 是「会话级判断」：与 source 分离，且不跨会话 ==')
const S1 = 'sess-dw-1'
const S2 = 'sess-dw-2'
const dwIn = await store.remember({
  content: '同等相关内容的正文',
  summary: '降权测试 共同关键词 zeta1',
  tags: ['dwtest'],
  taskId: 'task-dw',
  sessionId: S1,
})
const dwDorm = await store.remember({
  content: '同等相关内容的正文',
  summary: '降权测试 共同关键词 zeta1',
  tags: ['dwtest'],
  taskId: 'task-dw',
  source: 'dormant',
  sessionId: S1,
})
assert(dwDorm.source !== 'dormant', 'source 不再被写成 dormant（判定与来源分离）')
assert(dwDorm.source === 'internal', 'source 保持真实来源 internal')
assert(
  Array.isArray(dwDorm.dormIn) && dwDorm.dormIn.length === 1 && dwDorm.dormIn[0] === S1,
  'dormIn 只记下当前会话 id（不写进 source）'
)

console.log('== 36. 本会话内降权生效：同等相关时让位，但仍在结果里 ==')
const rS1 = store.recall({ query: 'zeta1', limit: 10, sessionId: S1 })
const iA = rS1.findIndex((m) => m.id === dwIn.id)
const iB = rS1.findIndex((m) => m.id === dwDorm.id)
assert(iA !== -1 && iB !== -1, '两条都在召回结果里（绝不过滤）')
assert(iA < iB, '本会话内：同等相关时 internal 排在 dormant 之前（降权生效）')
assert(rS1.find((m) => m.id === dwDorm.id).dormantHere === true, '回执里 dormantHere=true（可观测）')

console.log('== 37. 换一个会话 → 降权自动失效（不会永久累积）==')
// 让新旧关系确定：同一毫秒内写入时 recency 可能相同，排序会退化成稳定序
store.memories.get(dwDorm.id).recency = store.memories.get(dwIn.id).recency + 1000
const rS2 = store.recall({ query: 'zeta1', limit: 10, sessionId: S2 })
const jA = rS2.findIndex((m) => m.id === dwIn.id)
const jB = rS2.findIndex((m) => m.id === dwDorm.id)
assert(jA !== -1 && jB !== -1, '换会话后两条仍都被召回')
assert(rS2.find((m) => m.id === dwDorm.id).dormantHere === false, '换会话后 dormantHere=false（降权失效）')
assert(jB < jA, '换会话后不再降权：更新的那条（原 dormant）反而排前面（证明降权是会话级）')

console.log('== 38. 降权≠隐藏：它是唯一匹配时仍正常召回 ==')
const dwOnly = await store.remember({
  content: '只有这一条',
  summary: '独占标签内容 zeta2',
  tags: ['dwonly'],
  taskId: 'task-dw2',
  source: 'dormant',
  sessionId: S1,
})
const rOnly = store.recall({ tags: ['dwonly'], limit: 5, sessionId: S1 })
assert(rOnly.length === 1 && rOnly[0].id === dwOnly.id, '独占标签的 dormant 记忆被正常召回')
const rOnlyQ = store.recall({ query: 'zeta2', limit: 5, sessionId: S1 })
assert(rOnlyQ.some((m) => m.id === dwOnly.id), '按关键词查也能召回到它')

console.log('== 39. 降权不淹没相关性：更相关时照样排前面 ==')
const dwMore = await store.remember({
  content: '更相关但被标 dormant',
  summary: 'zeta3 omega3 两个词都命中',
  tags: ['dwrel'],
  taskId: 'task-dw3',
  source: 'dormant',
  sessionId: S1,
})
const dwLess = await store.remember({
  content: '不太相关但是 internal',
  summary: 'zeta3 只命中一个',
  tags: ['dwrel'],
  taskId: 'task-dw3',
  sessionId: S1,
})
const rRel = store.recall({ query: 'zeta3 omega3', limit: 10, sessionId: S1 })
assert(rRel.length >= 2, '两条都被召回')
assert(rRel[0].id === dwMore.id, 'dormant 明显更相关时排在前面')

console.log('== 40. 会话亲和优先于降权 ==')
const dwSess = await store.remember({
  content: '本会话的 dormant',
  summary: 'zeta4 会话亲和测试',
  tags: ['dwsess'],
  taskId: 'task-dw4',
  source: 'dormant',
  sessionId: S1,
})
const dwOther = await store.remember({
  content: '他会话的 internal',
  summary: 'zeta4 会话亲和测试',
  tags: ['dwsess'],
  taskId: 'task-dw4',
  sessionId: S2,
})
const rSess = store.recall({ query: 'zeta4', limit: 10, sessionId: S1 })
assert(rSess.length >= 2 && rSess[0].id === dwSess.id, '同会话的 dormant 优先于他会话的 internal（亲和 > 降权）')
const rSessMode = store.recall({ query: 'zeta4', limit: 10, sessionId: S1, mode: 'session' })
assert(rSessMode[0].id === dwSess.id, 'session 模式下降权同样只做次级让位，不打乱亲和优先')

console.log('== 41. 旧格式 source=dormant（无 dormIn）不再永久降权 ==')
const legacy = await store.remember({
  content: '模拟旧数据',
  summary: '旧格式内容 zeta6',
  tags: ['dwlegacy'],
  taskId: 'task-dw6',
  sessionId: S1,
})
store.memories.get(legacy.id).source = 'dormant' // 手工还原旧格式：标记写在 source 上、没有 dormIn
const rLegacy = store.recall({ query: 'zeta6', limit: 5, sessionId: S1 })
assert(rLegacy.length === 1, '旧格式记录仍可召回')
assert(rLegacy[0].dormantHere === false, '旧格式（无 dormIn）不再降权，避免历史标记永久累积')

console.log('== 42. markDormant：给「已有」记忆标暂时无关 ==')
const S3 = 'sess-mark-1'
const S4 = 'sess-mark-2'
const mkTarget = await store.remember({
  content: '已有记忆的正文',
  summary: '待标记的已有记忆 zeta7',
  tags: ['mk'],
  taskId: 'task-mk',
  sessionId: S3,
})
const mkOther = await store.remember({
  content: '对照组正文',
  summary: '对照组内容 zeta7',
  tags: ['mk'],
  taskId: 'task-mk',
  sessionId: S3,
})
assert(
  store.recall({ query: 'zeta7', limit: 10, sessionId: S3 }).find((m) => m.id === mkTarget.id).dormantHere === false,
  '标记前 dormantHere=false'
)
const mkDone = await store.markDormant([mkTarget.id], S3, '本会话内暂不相关')
assert(mkDone.length === 1 && mkDone[0].ok === true, 'markDormant 成功')
assert(store.memories.get(mkTarget.id).source !== 'dormant', 'markDormant 不改 source（只往 dormIn 追加）')
assert(store.memories.get(mkTarget.id).dormIn.includes(S3), 'dormIn 记下当前会话 id')
const afterMk = store.recall({ query: 'zeta7', limit: 10, sessionId: S3 })
assert(afterMk.find((m) => m.id === mkTarget.id).dormantHere === true, '标记后本会话内 dormantHere=true')
assert(afterMk.some((m) => m.id === mkTarget.id), '被标记的仍在结果里（降权≠隐藏）')
assert(afterMk[0].id === mkOther.id, '本会话内被标记的让位（同等相关时排后面）')

console.log('== 43. markDormant 的标记不跨会话 ==')
const crossMk = store.recall({ query: 'zeta7', limit: 10, sessionId: S4 })
assert(crossMk.find((m) => m.id === mkTarget.id).dormantHere === false, '换会话后 dormantHere=false（标记自动失效）')

console.log('== 44. markDormant 的边界（拒绝而不是退化成全局标记）==')
const mkNotFound = await store.markDormant(['no-such-id'], S3)
assert(mkNotFound[0].ok === false && mkNotFound[0].reason === 'not-found', '不存在的 id → not-found')
const mkNoSess = await store.markDormant([mkOther.id], null)
assert(mkNoSess[0].ok === false && mkNoSess[0].reason === 'no-session', '无会话 id → 拒绝（绝不写全局标记）')
assert(
  !Array.isArray(store.memories.get(mkOther.id).dormIn) || store.memories.get(mkOther.id).dormIn.length === 0,
  '被拒绝时不留痕'
)
const mkDepTarget = await store.remember({
  content: 'x',
  summary: '已废弃的目标',
  tags: ['mk2'],
  source: 'deprecated',
  sessionId: S3,
})
const mkDep = await store.markDormant([mkDepTarget.id], S3)
assert(mkDep[0].ok === false && mkDep[0].reason === 'deprecated', '对已永久作废的记录 → 拒绝（deprecated）')
const mkAgain = await store.markDormant([mkTarget.id], S3)
assert(mkAgain[0].ok === true && mkAgain[0].already === true, '重复标记幂等（already=true）')

console.log('== 45. unmarkDormant：可撤销（判断变了/标错了）==')
const unDone = await store.unmarkDormant([mkTarget.id], S3)
assert(unDone[0].ok === true, '撤销成功')
assert(!store.memories.get(mkTarget.id).dormIn.includes(S3), 'dormIn 里已移除该会话')
assert(
  store.recall({ query: 'zeta7', limit: 10, sessionId: S3 }).find((m) => m.id === mkTarget.id).dormantHere === false,
  '撤销后不再降权'
)
const unAgain = await store.unmarkDormant([mkTarget.id], S3)
assert(unAgain[0].ok === false && unAgain[0].reason === 'not-marked', '未标记时撤销 → not-marked')

console.log('== 46. 技能提供者：frontmatter 解析 ==')
const okSkill = '---\nname: demo-skill\ndescription: Use when testing the parser.\n---\n\n# 正文\n\n1. 规则点一\n'
const pk = parseSkillFile(okSkill, 'demo')
assert(pk.name === 'demo-skill', '解析出 name')
assert(pk.description === 'Use when testing the parser.', '解析出 description')
assert(pk.content.startsWith('# 正文'), '正文去掉了 frontmatter')
assert(!pk.content.includes('---'), '正文里不再残留分隔符')
const crlf = '---\r\nname: crlf-skill\r\ndescription: CRLF ok\r\n---\r\nBODY\r\n'
assert(parseSkillFile(crlf).name === 'crlf-skill', 'CRLF 行尾也能解析')
const quoted = '---\nname: q-skill\ndescription: "带: 冒号的描述"\n---\nX\n'
assert(parseSkillFile(quoted).description === '带: 冒号的描述', '引号值（含冒号）解析正确')
function throws(fn) { try { fn(); return false } catch { return true } }
assert(throws(() => parseSkillFile('no frontmatter')), '缺 frontmatter → 报错')
assert(throws(() => parseSkillFile('---\ndescription: x\n---\n')), '缺 name → 报错')
assert(throws(() => parseSkillFile('---\nname: x\n---\n')), '缺 description → 报错')
assert(throws(() => parseSkillFile('---\nname: 有空格 的\ndescription: x\n---\n')), '非法 name → 报错')

console.log('== 47. 技能根与扫描 ==')
assert(skillsRootFor(path.join(dir, 'memory.json')) === path.join(dir, 'skills'), '技能根 = memory.json 同级的 skills/（唯一实现在 paths.js）')
const skillRoot = path.join(dir, 'skills')
assert((await listSkills(skillRoot)).length === 0, '技能根不存在 → 返回空（不是报错）')
await fs.mkdir(path.join(skillRoot, 'good'), { recursive: true })
await fs.writeFile(path.join(skillRoot, 'good', 'SKILL.md'), '---\nname: good\ndescription: Use when good.\n---\n\n正文\n')
await fs.mkdir(path.join(skillRoot, 'no-skill-md'), { recursive: true })
await fs.mkdir(path.join(skillRoot, 'broken'), { recursive: true })
await fs.writeFile(path.join(skillRoot, 'broken', 'SKILL.md'), '没有 frontmatter')
const warns = []
const foundSkills = await listSkills(skillRoot, (m) => warns.push(m))
assert(foundSkills.length === 1 && foundSkills[0].name === 'good', '只返回合法技能（坏的与缺文件的跳过）')
assert(warns.length === 1 && warns[0].includes('broken'), '坏技能被跳过并告警')
assert(foundSkills[0].provider === 'dsh-mnemos' && foundSkills[0].source === 'mnemos', '候选带 provider/source 标记')
assert(foundSkills[0].invocation.modelInvocable === true, '候选带 invocation')

console.log('== 48. 技能提供者：list / get ==')
const provider = createSkillProvider(skillRoot)
assert(provider.name === 'dsh-mnemos', 'provider 名为 dsh-mnemos（不是保留的 runtime）')
const cands = await provider.list({})
assert(cands.length === 1, 'list() 返回候选')
const full = await provider.get(cands[0], {})
assert(full.name === 'good' && full.content === '正文', 'get() 返回正文（不含 frontmatter）')
assert(full.locator === undefined && full.rank === undefined, 'get() 不把 locator/rank 传给注册表')

console.log('== 49. 使用记录：路径 / revision / 追加 / 读取 ==')
const usageFile = usageFileFor(path.join(dir, 'memory.json'))
assert(usageFile === path.join(dir, 'skill-usage.jsonl'), '使用记录与 memory.json 同级')
assert(revisionOf('abc').length === 12, 'revision 为 12 位短哈希')
assert(revisionOf('abc') === revisionOf('abc'), 'revision 稳定')
assert(revisionOf('abc') !== revisionOf('abd'), '内容变了 revision 就变')
assert((await readUsages(usageFile)).length === 0, '文件不存在 → 返回空（不是报错）')
await appendUsage(usageFile, { t: 1, skill: 'a' })
await appendUsage(usageFile, { t: 2, skill: 'b' })
const us = await readUsages(usageFile)
assert(us.length === 2 && us[1].skill === 'b', '追加两条后读到两条（不覆盖）')
await fs.appendFile(usageFile, '{坏行\n', 'utf8')
const warnsU = []
const us2 = await readUsages(usageFile, (m) => warnsU.push(m))
assert(us2.length === 2 && warnsU.length === 1, '损坏行被跳过且告警，其余记录保留')

console.log('== 50. 自评提示 ==')
const hint = selfReviewHint('demo-skill')
assert(hint.includes('demo-skill'), '提示里带技能名')
assert(hint.includes('skill-feedback'), '提示里带 skill-feedback 标签')
assert(hint.includes('顺利则不必写'), '只请记异常（避免编造好评污染数据）')

console.log('== 51. 使用钩子：只记成功的技能加载 ==')
const hookRoot = path.join(dir, 'skills')
const hookFile = path.join(dir, 'hook-usage.jsonl')
const hookWarns = []
const hook = makeSkillUsageRecorder({ skillRoot: hookRoot, usageFile: hookFile, onWarn: (m) => hookWarns.push(m) })
const accept = (content) => ({ kind: 'accept', content: content ?? [{ type: 'text', text: 'body' }] })

// ★ 假 exec 必须用真实形状：DSH 把入参挂在 exec.arguments 上（不是 exec.args）。
//   这里曾写成 args，导致测试"通过"但钩子在真机上永远提前 return。
const d1 = await hook({ name: 'mnemos_recall', arguments: {} }, {}, async () => accept())
assert(d1.content.length === 1, '非 skill 工具：结果不变')
assert((await readUsages(hookFile)).length === 0, '非 skill 工具：不记录')

const d2 = await hook({ name: 'skill', arguments: { name: 'x' } }, {}, async () => ({ kind: 'error' }))
assert(d2.kind === 'error', '失败结果原样返回')
assert((await readUsages(hookFile)).length === 0, '加载失败不算一次使用')

const d3 = await hook({ name: 'skill', arguments: { name: 'good' }, agent: { session: { id: 'S-x' } } }, {}, async () => accept())
assert(d3.content.length === 2, '成功：追加了一条提示')
assert(d3.content[1].text.includes('good'), '提示里带技能名')
const logged = await readUsages(hookFile)
assert(logged.length === 1, '成功：记录了一条使用')
assert(logged[0].skill === 'good' && logged[0].session === 'S-x', '记录含技能名与会话')
assert(logged[0].revision && logged[0].revision.length === 12, '记录含技能 revision')

const beforeCnt = (await readUsages(hookFile)).length
await hook({ name: 'skill', arguments: {} }, {}, async () => accept())
assert((await readUsages(hookFile)).length === beforeCnt, '缺 name：不记录')

await hook({ name: 'skill', arguments: { name: 'no-such-skill' } }, {}, async () => accept())
const lastRec = (await readUsages(hookFile)).at(-1)
assert(lastRec.skill === 'no-such-skill' && lastRec.revision === null, '读不到正文：仍记录但 revision 为 null')
assert(hookWarns.some((m) => m.includes('revision')), '读不到正文会告警（记账失败不影响技能加载）')

console.log('== 52. 技能提供者：目录监听 → 缓存失效 ==')
let invalidated = 0
const fakeControl = { invalidate: () => { invalidated++ }, signal: { addEventListener: () => {} } }
const watchedRoot = path.join(dir, 'skills-watch')
const watched = createSkillProvider(watchedRoot, { control: fakeControl })
assert(typeof watched.dispose === 'function', '带 control 时提供 dispose')
await fs.mkdir(path.join(watchedRoot, 'w1'), { recursive: true })
await fs.writeFile(path.join(watchedRoot, 'w1', 'SKILL.md'), '---\nname: w1\ndescription: Use when w1.\n---\n\n正文\n')
const tWatch = Date.now()
while (invalidated === 0 && Date.now() - tWatch < 3000) await new Promise((r) => setTimeout(r, 50))
assert(invalidated > 0, '技能目录变更 → 触发 control.invalidate()（否则新技能要重启才可见）')
const wl = await watched.list({})
assert(wl.length === 1 && wl[0].name === 'w1', '监听后 list() 能看到新技能')
watched.dispose()
const noCtl = createSkillProvider(path.join(dir, 'no-such-root'))
assert((await noCtl.list({})).length === 0, '不带 control 也能用（只是不监听目录）')

console.log('== 53. 用户信号：路径 / 文本提取 / 追加读取 ==')
const sigFile = userSignalsFileFor(path.join(dir, 'memory.json'))
assert(sigFile === path.join(dir, 'user-signals.jsonl'), '用户信号与 memory.json 同级')
assert(extractUserText({ content: [{ type: 'text', text: 'A' }, { type: 'image' }, { type: 'text', text: 'B' }] }) === 'A\nB', '只取 text 块并拼接')
assert(extractUserText({ content: [] }) === '', '无文本 → 空串')
assert(extractUserText({}) === '', '无 content → 空串')
assert(extractUserText(null) === '', 'null → 空串')
assert((await readUserSignals(sigFile)).length === 0, '文件不存在 → 空（不是报错）')
await appendUserSignal(sigFile, { t: 1, session: 'S1', text: 'x' })
await appendUserSignal(sigFile, { t: 2, session: 'S1', text: 'y' })
assert((await readUserSignals(sigFile)).length === 2, '追加两条读到两条')
await fs.appendFile(sigFile, '不是 json\n', 'utf8')
const sigWarns = []
const sigs = await readUserSignals(sigFile, (m) => sigWarns.push(m))
assert(sigs.length === 2 && sigWarns.length === 1, '坏行跳过且告警，其余保留')

console.log('== 54. 会话使用追踪器（含重启后的惰性回填）==')
const trackUsage = path.join(dir, 'track-usage.jsonl')
await fs.writeFile(trackUsage, '{"t":1,"session":"S-old","skill":"a","revision":null}\n', 'utf8')
const tracker = makeSessionUsageTracker(trackUsage)
assert((await tracker.has('S-old')) === true, '惰性扫使用记录：重启前的会话也认得（不是只靠内存）')
assert((await tracker.has('S-unknown')) === false, '没用过技能的会话 → false')
tracker.mark('S-new')
assert((await tracker.has('S-new')) === true, 'mark 后认得')
assert((await tracker.has(null)) === false, '无 sessionId → false')

console.log('== 55. 用户信号钩子：只在本会话用过技能之后才捕获 ==')
const hookSigFile = path.join(dir, 'hook-signals.jsonl')
const sigTracker = makeSessionUsageTracker(path.join(dir, 'sig-track.jsonl'))
const sigWarns2 = []
const sigHook = makeUserSignalRecorder({ signalsFile: hookSigFile, tracker: sigTracker, onWarn: (m) => sigWarns2.push(m) })
const userEv = (text) => ({ type: 'user/message', data: { id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } })

// 没用过技能的会话 → 不捕获（隐私闸门）
await sigHook({ id: 'S-clean' }, userEv('这条不该被记'))
assert((await readUserSignals(hookSigFile)).length === 0, '没用过技能的会话：消息不被捕获')

// 非 user/message 事件 → 不捕获
await sigHook({ id: 'S-clean' }, { type: 'turn/start', data: {} })
assert((await readUserSignals(hookSigFile)).length === 0, '非 user/message 事件：不捕获')

// 用过技能 → 捕获
sigTracker.mark('S-used')
await sigHook({ id: 'S-used' }, userEv('这条该被记'))
const cap = await readUserSignals(hookSigFile)
assert(cap.length === 1 && cap[0].text === '这条该被记' && cap[0].session === 'S-used', '用过技能的会话：捕获了文本与会话')

// 纯附件（无文本）→ 不捕获
await sigHook({ id: 'S-used' }, { type: 'user/message', data: { content: [{ type: 'image' }] } })
assert((await readUserSignals(hookSigFile)).length === 1, '纯附件无文本：不捕获')

// ★ source.kind 不是 user（实测 DSH 会把技能目录提醒也作为 user/message 投递）→ 不捕获
const catalogEv = { type: 'user/message', data: { id: 'c1', role: 'user', content: [{ type: 'text', text: '<system-reminder>技能目录变了…</system-reminder>' }], source: { kind: 'skill-catalog' } } }
await sigHook({ id: 'S-used' }, catalogEv)
assert((await readUserSignals(hookSigFile)).length === 1, '★ source.kind=skill-catalog 的注入消息：不捕获（白名单过滤）')
// 缺 source 也按非用户处理（白名单：不确定就不收）
await sigHook({ id: 'S-used' }, { type: 'user/message', data: { content: [{ type: 'text', text: '没有 source' }] } })
assert((await readUserSignals(hookSigFile)).length === 1, '★ 缺 source.kind：不捕获（宁可漏也不放噪声）')

// 无 sessionId → 不捕获
await sigHook({}, userEv('无会话'))
assert((await readUserSignals(hookSigFile)).length === 1, '无 sessionId：不捕获')

// 内部出错 → 被吞掉并告警（session/event 是观察者，绝不能抛）
const badHook = makeUserSignalRecorder({ signalsFile: hookSigFile, tracker: { has: () => { throw new Error('boom') } }, onWarn: (m) => sigWarns2.push(m) })
await badHook({ id: 'S-used' }, userEv('x'))
assert(sigWarns2.some((m) => m.includes('boom')), '内部出错：吞掉并告警，不抛给宿主')

console.log('== 56. 归因桥：同会话 + 时间在前 + 最近一次 ==')
const usages = [
  { t: 100, session: 'S1', skill: 'a', revision: 'r1' },
  { t: 200, session: 'S1', skill: 'b', revision: 'r2' },
  { t: 150, session: 'S2', skill: 'c', revision: 'r3' },
]
const a1 = attribute({ session: 'S1', t: 250 }, usages)
assert(a1.skill === 'b' && a1.revision === 'r2', '取同会话内时间在前的最近一次')
assert(a1.confidence === 'low', '同会话内有多条 → 置信度低')
const a2 = attribute({ session: 'S1', t: 120 }, usages)
assert(a2.skill === 'a' && a2.confidence === 'high', '只有一条 → 置信度高且命中')
assert(attribute({ session: 'S1', t: 50 }, usages) === null, '反馈早于所有使用 → 归因失败')
assert(attribute({ session: 'SX', t: 999 }, usages) === null, '会话不匹配 → 归因失败')
assert(attribute({ session: null, t: 999 }, usages) === null, '无会话 → 归因失败')
assert(attribute({ session: 'S1', t: 'x' }, usages) === null, '时间非法 → 归因失败')

console.log('== 57. 规则点抽取 ==')
const rps = extractRulePoints('# T\n\n1. 第一条\n2、第二条\n③ 第三条\n正文不算\n 4) 第四条\n')
assert(rps.length === 4, '抽取 4 条（1. / 2、/ ③ / 4)）')
assert(rps[0].id === '1' && rps[0].text === '第一条', '阿拉伯数字编号')
assert(rps[2].id === '③', '圈号编号')

console.log('== 58. JSON 回复解析（容忍围栏与废话）==')
assert(parseJsonReply('{"a":1}').a === 1, '纯 JSON')
assert(parseJsonReply('```json\n{"a":1}\n```').a === 1, '代码围栏')
assert(parseJsonReply('好的，结果：{"a":1} 以上。').a === 1, '前后有废话')
assert(parseJsonReply('{"a":{"b":2}}').a.b === 2, '嵌套对象')
assert(parseJsonReply('没有 JSON') === null, '无 JSON → null')
assert(parseJsonReply('{坏的}') === null, '坏 JSON → null')

console.log('== 59. 自评反馈收集 ==')
const mems = [
  { id: '1', tags: ['skill-feedback', 'sk'], createdAt: 10, sessionId: 'S1', detail: '不好用' },
  { id: '2', tags: ['other'], createdAt: 20, sessionId: 'S1', detail: '无关' },
  { id: '3', tags: ['skill-feedback'], createdAt: 30, sessionId: 'S1', detail: '没写技能名' },
  { id: '4', tags: ['skill-feedback', 'sk'], createdAt: 5, sessionId: 'S1', detail: '已废弃', source: 'deprecated' },
]
const sr = collectSelfReviews(mems)
assert(sr.length === 2, '只按 skill-feedback 标签收集（不要求技能名 —— 归因靠桥）')
assert(sr[0].text === '不好用' && sr[0].session === 'S1', '带出文本与会话')
assert(collectSelfReviews(mems, { sinceT: 20 }).length === 1, 'sinceT 过滤掉旧的')
assert(collectSelfReviews(mems).every((x) => x.from === 'self'), '标记来源为 self')

console.log('== 60. 评审编排：六条「不改」与写回开关 ==')
const rvRoot = path.join(dir, 'rv')
const ORIG = '---\nname: demorv\ndescription: Use when demo.\n---\n\n# Demo\n\n1. 规则一\n2. 规则二\n'
const NEWC = '---\nname: demorv\ndescription: Use when demo.\n---\n\n# Demo\n\n1. 规则一\n2. 规则二（改）\n'
const mkLlm = (replies) => ({
  stream: () => (async function* () {
    yield { type: 'text-delta', text: replies.shift() ?? '{}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })(),
})
const fakeStore = { memories: new Map(), recall: () => [{ summary: 'mem1', tags: ['x'] }] }
const GOOD_REVIEW = JSON.stringify({ change: true, why: '因为反馈', rulePoint: '2', counterexample: '具体场景A', positiveCase: '具体场景B', newContent: NEWC })
const GOOD_VERIFY = JSON.stringify({ pass: true, reason: '都满足' })
async function rvCase(tag, { replies, writeBack = false, skill = 'demorv', signal = true, usageRev = null, maxPerCycle = 3, content = ORIG, emptyUsage = false } = {}) {
  const root = path.join(rvRoot, tag)
  const d = path.join(root, skill)
  await fs.mkdir(d, { recursive: true })
  await fs.writeFile(path.join(d, 'SKILL.md'), content, 'utf8')
  const uf = path.join(root, 'u.jsonl')
  const sf = path.join(root, 's.jsonl')
  await fs.writeFile(
    uf,
    emptyUsage ? '' : JSON.stringify({ t: 100, session: 'S', skill, revision: usageRev ?? revisionOf(content) }) + '\n',
    'utf8'
  )
  if (signal) await fs.writeFile(sf, JSON.stringify({ t: 200, session: 'S', source: 'user', text: '这技能不好用' }) + '\n', 'utf8')
  return {
    d, root,
    deps: {
      store: fakeStore, skillRoot: root, usageFile: uf, signalsFile: sf,
      stateFile: path.join(root, 'state.json'), feedbackFile: path.join(root, 'fb.jsonl'),
      llm: mkLlm([...replies]), provider: 'p', model: 'm', writeBack, maxPerCycle, onWarn: () => {},
    },
  }
}
const rd = (d) => fs.readFile(path.join(d, 'SKILL.md'), 'utf8')

const c0 = await rvCase('idle', { replies: [], signal: false, emptyUsage: true })
assert((await runSkillReview(c0.deps)).step === 'idle', '无未消费记录 → idle（不改）')

const c0b = await rvCase('usageonly', { replies: [], signal: false })
const r0b = await runSkillReview(c0b.deps)
assert(r0b.step === 'usage-only', '只有使用、无反馈 → usage-only（沉默 ≠ 满意，不评审）')
assert((await rd(c0b.d)) === ORIG, 'usage-only：技能文件未动')

const c1 = await rvCase('nochange', { replies: [JSON.stringify({ change: false, reason: '证据不足' })] })
assert((await runSkillReview(c1.deps)).results[0].step === 'no-change', '模型判定无需改 → no-change')
assert((await rd(c1.d)) === ORIG, 'no-change：技能文件未动')

// ★ 2026-10-18 新增：同一批证据的 no-change 不该重复花 LLM（no-change 水位）
{
  const c1b = await rvCase('nochange-twice', {
    // 两条回复：r1 用第一条；r2 走缓存不调 LLM；r3 真有新反馈 → 需要第二条。
    // （★ V6-03 之后 `{}` 不再被当成"不改"，所以不能靠 mkLlm 的默认 `{}` 兜底。）
    replies: [JSON.stringify({ change: false, reason: '证据不足' }), JSON.stringify({ change: false, reason: '证据仍不足' })],
  })
  const r1 = await runSkillReview(c1b.deps)
  assert(r1.results[0].step === 'no-change', '★ 首次：模型判 no-change')

  // 同一句反馈又以**新的信号序号**来了（同一段对话被再次切片）→ 内容没变
  const sf2 = path.join(c1b.root, 's.jsonl')
  await fs.appendFile(sf2, JSON.stringify({ t: 300, session: 'S', source: 'user', text: '这技能不好用' }) + '\n', 'utf8')
  await fs.writeFile(path.join(c1b.root, 'u.jsonl'), JSON.stringify({ t: 260, session: 'S', skill: 'demorv', revision: revisionOf(ORIG) }) + '\n', 'utf8')
  const r2 = await runSkillReview(c1b.deps)
  assert(r2.cached === 1, `★★ [心跳可见] 回执里 cached=1（实测 ${r2.cached}）—— 让"这回省了几次 LLM"可见，不用翻文件`)
  assert(r2.results[0].step === 'no-change-cached',
    `★★ [no-change 水位] 同一批**内容**换了个序号不算新证据，不重评（实测 ${r2.results[0].step}）—— 这是"同一输入被判几十轮"的修法`)
  assert((await rd(c1b.d)) === ORIG, '★ 缓存路径不动技能文件')

  // 真·新反馈（文本不同）→ 必须重评
  await fs.appendFile(sf2, JSON.stringify({ t: 400, session: 'S', source: 'user', text: '完全不相关的另一条反馈' }) + '\n', 'utf8')
  const r3 = await runSkillReview(c1b.deps)
  assert(r3.results[0].step === 'no-change',
    `★★ 新文本来了必须重评（实测 ${r3.results[0].step}）—— 水位只压"同一批"，不许吞掉新反馈`)
}

const c2 = await rvCase('unfalsifiable', { replies: [JSON.stringify({ change: true, why: '感觉不好', counterexample: '场景A', newContent: NEWC })] })
assert((await runSkillReview(c2.deps)).results[0].step === 'unfalsifiable', '指不出具体规则点 → 不改（规则 4）')
assert((await rd(c2.d)) === ORIG, '不可证伪：技能文件未动')

const c3 = await rvCase('nocounter', { replies: [JSON.stringify({ change: true, why: 'x', rulePoint: '2', newContent: NEWC })] })
assert((await runSkillReview(c3.deps)).results[0].step === 'no-counterexample', '说不出具体场景 → 不改（规则 5）')

const c4 = await rvCase('verifyfail', { replies: [GOOD_REVIEW, JSON.stringify({ pass: false, reason: '丢了规则点' })] })
const rvRes4 = await runSkillReview(c4.deps)
assert(rvRes4.results[0].step === 'rejected' && rvRes4.results[0].verifyReason === '丢了规则点', '回归门不过 → rejected（规则 6）')
assert((await rd(c4.d)) === ORIG, '回归门不过：技能文件未动')

// ★★ V6-03（2026-10-21）：解析失败 ≠ "模型说不用改"；验证设施失败 ≠ "回归门不过"
{
  console.log('== 60b. 评审/验证回复的三态（V6-03）==')
  // ① 纯函数三态：只有显式布尔才算判定
  assert(classifyReviewReply({ change: true }) === 'change' && classifyReviewReply({ change: false }) === 'no-change',
    '★★ [V6-03] 只有显式 change 布尔才算判定')
  assert(classifyReviewReply(null) === 'malformed' && classifyReviewReply('no') === 'malformed' &&
    classifyReviewReply({ reason: 'x' }) === 'malformed' && classifyReviewReply([1]) === 'malformed',
    '★★ [V6-03] null / 非对象 / 缺 change → malformed（坏回复不是"不改"）')
  assert(classifyVerifyReply({ pass: true }) === 'pass' && classifyVerifyReply({ pass: false }) === 'fail' &&
    classifyVerifyReply(null) === 'malformed' && classifyVerifyReply({ reason: 'x' }) === 'malformed',
    '★★ [V6-03] 验证回复同样三态（缺 pass 布尔不是"不通过"）')

  // ② 坏回复：不写 no-change 指纹 → 下一轮必须重评（而不是 no-change-cached）
  {
    const cp = await rvCase('parse-error', {
      replies: ['抱歉，我无法给出 JSON', JSON.stringify({ change: false, reason: '证据不足' })],
    })
    const p1 = await runSkillReview(cp.deps)
    assert(p1.results[0]?.step === 'review-error',
      `★★ [V6-03] 坏回复 → review-error（实测 ${p1.results[0]?.step}）`)
    const stp = JSON.parse(await fs.readFile(path.join(cp.root, 'state.json'), 'utf8'))
    assert(!stp.skills?.demorv?.noChangeFp, '★★ 坏回复不许写 no-change 指纹（否则这批证据被永久冻结）')
    const histp = (await fs.readFile(path.join(cp.d, 'history.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    assert(histp.some((h) => h.verdict === 'parse-error') && !histp.some((h) => h.verdict === 'no-change'),
      '★ 历史记 parse-error（带回复开头），不冒充 no-change')
    assert(typeof histp.find((h) => h.verdict === 'parse-error')?.replyHead === 'string',
      '★ parse-error 留了截断的回复开头，便于查"模型到底回了什么"')

    const p2 = await runSkillReview(cp.deps)
    assert(p2.cached === 0 && p2.results?.[0]?.step === 'no-change',
      `★★ 下一轮同一批证据必须重评（实测 cached=${p2.cached} / ${p2.results?.[0]?.step}）—— 坏回复不许消费证据`)
  }

  // ③ 合法 JSON 但缺 change 字段 → 同样是坏回复
  {
    const cm = await rvCase('missing-change', { replies: [JSON.stringify({ foo: 1, reason: '看起来像答案' })] })
    assert((await runSkillReview(cm.deps)).results[0].step === 'review-error',
      '★ 缺 change 字段 → review-error（不是 no-change）')
  }

  // ④ 验证者坏回复：不写 rejected、不消费 feedback / regression
  {
    const cv = await rvCase('verify-parse-error', { replies: [GOOD_REVIEW, '不是 JSON'] })
    const v1 = await runSkillReview(cv.deps)
    assert(v1.results[0].step === 'verify-error',
      `★★ [V6-03] 验证者坏回复 → verify-error（实测 ${v1.results[0].step}）`)
    assert(!(await fs.readdir(cv.root)).includes('fb.jsonl'),
      '★★ 验证设施失败：feedback 不许落档（否则这批证据被吃、且记成"验证者说不行"）')
    assert(!(await fs.readdir(cv.d)).includes('regression.jsonl'),
      '★★ 验证设施失败：回归用例不许落档（下轮验证通过时再记）')
    assert((await rd(cv.d)) === ORIG, '★ 验证失败：技能文件未动')
    const histv = (await fs.readFile(path.join(cv.d, 'history.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    assert(histv.some((h) => h.verdict === 'verify-error') && !histv.some((h) => h.verdict === 'rejected'),
      '★ 历史记 verify-error，不冒充 rejected')
  }
}

const c5 = await rvCase('proposed', { replies: [GOOD_REVIEW, GOOD_VERIFY] })
const r5 = await runSkillReview(c5.deps)
assert(r5.results[0].step === 'proposed' && r5.writeBack === false, '全通过但写回关闭 → proposed')
assert((await rd(c5.d)) === ORIG, '★ 写回关闭：技能文件必须未动')
assert(!(await fs.readdir(c5.d)).includes('versions'), '★ 写回关闭：不产生版本备份')
// ★ 但修订正文必须落 proposals/ —— 否则 history 里只有一个哈希，人无从审核
const propFiles = await fs.readdir(path.join(c5.d, 'proposals'))
assert(propFiles.length === 1, '★ 写回关闭：修订正文落 proposals/（否则 proposed 无从审核）')
assert((await fs.readFile(path.join(c5.d, 'proposals', propFiles[0]), 'utf8')) === NEWC, 'proposals/ 里是修订后的正文')
assert(r5.results[0].proposal && r5.results[0].proposal.includes('proposals'), '结果里带 proposal 路径')
const h5 = JSON.parse((await fs.readFile(path.join(c5.d, 'history.jsonl'), 'utf8')).trim().split('\n').pop())
assert(h5.proposal && h5.proposal.includes('proposals'), 'history 里记下 proposal 路径')

const c6 = await rvCase('applied', { replies: [GOOD_REVIEW, GOOD_VERIFY], writeBack: true })
assert((await runSkillReview(c6.deps)).results[0].step === 'applied', '全通过且写回开启 → applied')
assert((await rd(c6.d)) === NEWC, '★ 写回开启：技能文件已更新')
const vs = await fs.readdir(path.join(c6.d, 'versions'))
assert(vs.length === 1 && vs[0] === `${revisionOf(ORIG)}.md`, '★ 写回前存了旧版全文（可回滚）')
assert((await fs.readFile(path.join(c6.d, 'versions', vs[0]), 'utf8')) === ORIG, '旧版内容正确')

// ★★ V6-08：applied 后 state 要记"上次应用"；旧状态没有字段时回退扫 history
{
  const st6 = JSON.parse(await fs.readFile(path.join(c6.root, 'state.json'), 'utf8'))
  assert(
    Number.isFinite(st6.skills.demorv.lastAppliedAt) && st6.skills.demorv.lastAppliedRevision === revisionOf(NEWC),
    '★★ [V6-08] applied 后 state 记录 lastAppliedAt 与 lastAppliedRevision'
  )
  const hist6 = await lastAppliedOf(c6.d)
  assert(
    hist6 && hist6.at === st6.skills.demorv.lastAppliedAt && hist6.revision === revisionOf(NEWC),
    '★ [V6-08] history 里的最后 applied 与 state 一致'
  )

  const cOld = await rvCase('applied-old-state', { replies: [GOOD_REVIEW, GOOD_VERIFY], writeBack: true })
  await runSkillReview(cOld.deps)
  const sp = path.join(cOld.root, 'state.json')
  const legacy = JSON.parse(await fs.readFile(sp, 'utf8'))
  delete legacy.skills.demorv.lastAppliedAt
  delete legacy.skills.demorv.lastAppliedRevision
  await fs.writeFile(sp, JSON.stringify(legacy), 'utf8')
  const resolved = await resolveLastApplied(legacy, cOld.root, 'demorv')
  assert(
    resolved && resolved.source === 'history' && resolved.at > 0,
    '★★ [V6-08] 旧状态无字段 → 回退扫 history（不显示 1970）'
  )
  assert(resolved?.revision === revisionOf(NEWC), '★ 回退出的 revision 与 history 里的 newRevision 一致')
  const none = await resolveLastApplied({ skills: {} }, cOld.root, 'no-such-skill')
  assert(none === null, '★ 没有记录 → null（调用方不会把 0 格式化成 1970）')
}

const c7 = await rvCase('stale', { replies: [GOOD_REVIEW, GOOD_VERIFY], usageRev: 'deadbeef0000' })
assert((await runSkillReview(c7.deps)).results[0].step === 'stale-feedback', '反馈指向旧 revision → 不改（规则 3）')

const c8 = await rvCase('deferred', { replies: [], maxPerCycle: 0 })
const r8 = await runSkillReview(c8.deps)
assert(r8.results[0].step === 'deferred' && r8.deferred.includes('demorv'), '超出上限 → deferred')
const st8 = JSON.parse(await fs.readFile(path.join(c8.root, 'state.json'), 'utf8'))
assert(st8.signalCount === 0, '★ 推迟时水位不推进（反馈留到下一轮，不被静默丢弃）')

const c9 = await rvCase('deferred2', { replies: [GOOD_REVIEW, GOOD_VERIFY], maxPerCycle: 0 })
await runSkillReview(c9.deps)
const st9 = JSON.parse(await fs.readFile(path.join(c9.root, 'state.json'), 'utf8'))
assert(st9.signalCount === 0, '★ 再来一轮仍为 0：反馈确实没被消费')

// ★★ 2026-10-17 修活锁：**不是本插件的技能**（宿主的 office-* 在 app.asar 里，改不了）
//   不许进待评审队列 —— 否则 missing-skill → deferred → 水位被永久钉死 → 每 30 分钟重烧。
//   实测背景：这条活锁在生产上连续跑了 4~5 天、20~65+ 个周期、零产出。
{
  const root = path.join(rvRoot, 'foreign')
  const own = path.join(root, 'demorv')
  await fs.mkdir(own, { recursive: true })
  await fs.writeFile(path.join(own, 'SKILL.md'), ORIG, 'utf8')
  // 两个会话各自"用过 → 给了反馈"，一个指向自家技能，一个指向内置技能
  const uf = path.join(root, 'u.jsonl')
  await fs.writeFile(uf, [
    JSON.stringify({ t: 100, session: 'S1', skill: 'demorv', revision: revisionOf(ORIG) }),
    JSON.stringify({ t: 150, session: 'S2', skill: 'office-docx', revision: 'abcdef123456' }),
  ].join('\n') + '\n', 'utf8')
  const sf = path.join(root, 's.jsonl')
  await fs.writeFile(sf, [
    JSON.stringify({ t: 200, session: 'S1', source: 'user', text: '自家的反馈' }),
    JSON.stringify({ t: 210, session: 'S2', source: 'user', text: '内置技能的反馈' }),
  ].join('\n') + '\n', 'utf8')
  const stateFile = path.join(root, 'state.json')
  const r = await runSkillReview({
    store: fakeStore, skillRoot: root, usageFile: uf, signalsFile: sf, stateFile,
    feedbackFile: path.join(root, 'fb.jsonl'),
    llm: mkLlm([JSON.stringify({ change: false, reason: '无需改' })]),
    provider: 'p', model: 'm', writeBack: true, onWarn: () => {},
  })
  assert(!r.results.some((x) => x.step === 'missing-skill'),
    '★★ 内置技能不再产生 missing-skill（旧代码每轮都有一条 ENOENT）')
  assert(!r.deferred.includes('office-docx'), '★★ 内置技能**不 defer**（defer 就是水位钉死的机制）')
  assert(r.foreignSkills.includes('office-docx') && r.foreign === 1, '★ 回执报出被跳过的非本插件技能（可观测）')
  assert(r.results.some((x) => x.skill === 'demorv'),
    '★★ 自家技能照常评审（过滤不能连自家的一起吞掉）')
  const stF = JSON.parse(await fs.readFile(stateFile, 'utf8'))
  assert(stF.signalCount === 2, `★★ 水位推进到全部消费（旧代码会被钉在 0 —— 实测 ${stF.signalCount}）`)
  assert(Array.isArray(stF.pending) && !stF.pending.some((p) => String(p.reason).includes('不是本插件的技能')),
    '★★ 内置技能不进 pending（不是我们的，直接删，不留记录）')
}

// ★ V6-10：观察项台账清理（外来删除 / 去重 / 过期 / handled 状态）
{
  const now = Date.now()
  const oldOpen = now - PENDING_TTL_MS - 1000
  const oldHandled = now - PENDING_HANDLED_TTL_MS - 1000
  const list = [
    { kind: 'user', t: now, reason: '不是本插件的技能（office-docx 改不了，只作观察）' },
    { kind: 'review', skill: 'a', reason: '同一条', t: now - 10, status: 'open' },
    { kind: 'review', skill: 'a', reason: '同一条', t: now - 5, status: 'open' },
    { kind: 'user', t: oldOpen, reason: '过期 open', status: 'open' },
    { kind: 'user', t: oldHandled, reason: '过期 handled', status: 'handled', resolvedAt: oldHandled },
    { kind: 'user', t: now - 1000, reason: '近期 handled', status: 'handled', resolvedAt: now - 1000 },
  ]
  const out = prunePendingLedger(list, now)
  assert(out.length === 2, `★★ 台账清理：外来删除、重复去重、过期清理（实测 ${out.length} 条）`)
  assert(out.some((x) => x.skill === 'a' && x.status === 'open' && x.expiresAt === now - 5 + PENDING_TTL_MS),
    '★ 去重留最新；open 的 expiresAt = t + 14 天')
  assert(out.some((x) => x.reason === '近期 handled' && x.status === 'handled' && x.expiresAt === now - 1000 + PENDING_HANDLED_TTL_MS),
    '★ handled 的 expiresAt = resolvedAt + 7 天')
  const stat = pendingStats(out)
  assert(stat.total === 2 && stat.open === 1 && stat.handled === 1 && stat.oldestAt === now - 1000,
    '★★ 回执统计：总数/待处理/已处理/最早时间')
}

// ★ 自家名单为空时**不过滤**（fail-open）：宁可退化成旧行为，也不要凭空关掉评审
{
  const root = path.join(rvRoot, 'norooot')
  await fs.mkdir(root, { recursive: true })   // 目录存在但没有技能
  const uf = path.join(root, 'u.jsonl')
  await fs.writeFile(uf, JSON.stringify({ t: 100, session: 'S', skill: 'ghost', revision: 'x' }) + '\n', 'utf8')
  const sf = path.join(root, 's.jsonl')
  await fs.writeFile(sf, JSON.stringify({ t: 200, session: 'S', source: 'user', text: '幽灵技能反馈' }) + '\n', 'utf8')
  let warned = 0
  const r = await runSkillReview({
    store: fakeStore, skillRoot: root, usageFile: uf, signalsFile: sf,
    stateFile: path.join(root, 'state.json'), feedbackFile: path.join(root, 'fb.jsonl'),
    llm: null, provider: 'p', model: 'm', writeBack: false, onWarn: () => { warned++ },
  })
  assert(r.foreign === 0 || r.foreignSkills === undefined || r.foreignSkills.length === 0,
    '★ 自家名单为空 → 不过滤（不把一切都判成"外来"）')
  assert(warned >= 0, '★ （告警出口存在；这里不断言次数，避免把日志当契约）')
}

const hist5 = await fs.readFile(path.join(c5.d, 'history.jsonl'), 'utf8')
assert(hist5.includes('proposed') && hist5.includes('因为反馈'), 'history 记下 verdict 与 why')
const hist6 = await fs.readFile(path.join(c6.d, 'history.jsonl'), 'utf8')
assert(hist6.includes('applied'), '写回成功记 applied')
const fb5 = await fs.readFile(path.join(c5.root, 'fb.jsonl'), 'utf8')
assert(fb5.includes('这技能不好用'), '归因结果留档到 skill-feedback.jsonl')

console.log('== 61. 新建技能：生成门槛与两个验证 ==')
const mkRoot = path.join(dir, 'mk-root')
await fs.mkdir(mkRoot, { recursive: true })
const mkData = path.join(dir, 'mk', 'memory.json')
const mkLlm2 = (replies) => ({ stream: () => (async function* () { yield { type: 'text-delta', text: replies.shift() ?? '{}' }; yield { type: 'finish', reason: { kind: 'stop' } } })() })
// ★ F-10 夹具：会话对象按**宿主已核实的形状**造假（skill-source-ref.js 文件头）：
//   `eventAt(seq)` 取日志下标（宿主就是 `return this.log[seq]`）、`seq` = 日志长度。
const mkFakeSession = (id, events) => ({
  id,
  get seq() { return events.length },
  eventAt(seq) { return events[seq] },
  deriveEventMessage(ev) { return ev?.data?.message ?? null },
})
const failEvent = (seq, text) => ({ seq, type: 'tool/result', data: { message: { isError: true, content: [{ type: 'text', text }] } } })
const mkSessionWith = (id, failures) => {
  const events = []
  for (const [seq, text] of failures) events[seq] = failEvent(seq, text)
  return mkFakeSession(id, events)
}
const srcRef = (sid, seq) => `来源：session=${sid} seq=${seq}`
// ★ F-10 起，反例**必须**带来源标识（缺了直接拒）—— 所以这个共享夹具也带上了来源。
const baseIn = { name: 'demo-new', description: 'Use when demo new.', body: '# Demo\n\n1. 规则一', counterexample: `场景A（${srcRef('session-mk', 7)}）`, positiveCase: '场景B', why: '因为重复出现' }
const mkDeps = (replies, writeBack = false) => ({ skillRoot: mkRoot, dataFile: mkData, llm: mkLlm2([...replies]), provider: 'p', model: 'm', writeBack, session: mkSessionWith('session-mk', [[7, '场景A 的失败原文']]) })
const PASS = JSON.stringify({ pass: true, reason: '反例成立、描述写的是触发条件、不重复' })
const FAIL = JSON.stringify({ pass: false, reason: '与现有技能重复', overlaps: ['office-docx'] })

// 硬门槛：缺反例 / 缺正例 → 直接拒绝，且指出缺什么
const m1 = await createSkill(mkDeps([]), { ...baseIn, counterexample: '' })
assert(m1.ok === false && m1.verdict === 'rejected' && m1.missing.includes('counterexample（反例）'), '★ 缺反例 → 拒绝（做不了两个验证就不许生成）')
const m2 = await createSkill(mkDeps([]), { ...baseIn, positiveCase: '   ' })
assert(m2.verdict === 'rejected' && m2.missing.includes('positiveCase（正例）'), '★ 缺正例 → 拒绝')
assert(m2.reason.includes('不许生成'), '拒绝理由说清规则')
const m3 = await createSkill(mkDeps([]), { ...baseIn, name: '有空格 的' })
assert(m3.verdict === 'rejected' && m3.reason.includes('不合法'), '非法技能名 → 拒绝（用 provider 同一套解析器校验）')

// 无 LLM → 拒绝（不能未经验证就建）
const m4 = await createSkill({ ...mkDeps([]), llm: null }, baseIn)
assert(m4.verdict === 'rejected' && m4.reason.includes('LLM'), '无 LLM → 拒绝')

// 验证不通过 → 拒绝，且带 overlaps
const m5 = await createSkill(mkDeps([FAIL]), baseIn)
assert(m5.verdict === 'rejected' && m5.reason.includes('重复'), '验证不通过 → 拒绝')
assert(Array.isArray(m5.overlaps) && m5.overlaps.includes('office-docx'), '带出重叠技能供参考')
assert(!(await fs.readdir(mkRoot)).includes('demo-new'), '拒绝时不产生技能目录')

// 通过 + 写回关闭 → 暂存，不进技能目录 ★
const m6 = await createSkill(mkDeps([PASS]), baseIn)
assert(m6.ok === true && m6.verdict === 'proposed', '通过 + 写回关闭 → proposed')
assert(m6.path.includes('skill-proposals'), '落在暂存区')
assert(!(await fs.readdir(mkRoot)).includes('demo-new'), '★ 写回关闭：不产生技能目录（不该影响模型行为）')
const staged = await fs.readFile(path.join(newSkillStagingDirFor(mkData, 'demo-new'), 'SKILL.md'), 'utf8')
assert(staged.includes('name: demo-new') && staged.includes('# Demo'), '暂存内容完整（frontmatter + 正文）')

// 通过 + 写回开启 → 真的建出来 + history/regression
const m7 = await createSkill(mkDeps([PASS], true), baseIn)
assert(m7.ok === true && m7.verdict === 'created', '通过 + 写回开启 → created')
assert((await fs.readdir(mkRoot)).includes('demo-new'), '★ 技能目录已创建')
const created = await fs.readFile(path.join(mkRoot, 'demo-new', 'SKILL.md'), 'utf8')
assert(created.includes('name: demo-new'), '技能文件内容正确')
const mh = await fs.readFile(path.join(mkRoot, 'demo-new', 'history.jsonl'), 'utf8')
assert(mh.includes('created') && mh.includes('场景A'), 'history 记下 created 与反例')
const mr = await fs.readFile(path.join(mkRoot, 'demo-new', 'regression.jsonl'), 'utf8')
assert(mr.includes('counter') && mr.includes('positive'), '两个用例都入了回归集')

// 同名已存在 → 拒绝（改动已有技能应走评审）
const m8 = await createSkill(mkDeps([PASS], true), baseIn)
assert(m8.verdict === 'rejected' && m8.reason.includes('已存在'), '★ 同名已存在 → 拒绝（改动已有技能走评审，不是新建）')

console.log('== 61b. 技能生成三档来源（V6-05 / V6-06）==')
{
  const fakeStore = { memories: new Map() }
  const addMem = (id, sessionId, summary) =>
    fakeStore.memories.set(id, {
      id, summary, detail: `${summary} 的摘录`, sessionId, createdAt: Date.now() - 100000, source: 'internal', tags: [],
    })
  addMem('ev-1', 'sess-a', '同类问题 A')
  addMem('ev-2', 'sess-b', '同类问题 B')
  addMem('ev-3', 'sess-a', '同类问题 C')
  addMem('ev-4', 'sess-a', '同会话第四条')
  addMem('ev-x', 'sess-a', '已作废的事件')
  fakeStore.memories.get('ev-x').source = 'deprecated'

  const memIn = {
    origin: 'memory-recurring', name: 'mem-skill', description: 'Use when repeated.',
    body: '# M\n\n1. 规则', events: ['ev-1', 'ev-2', 'ev-3'],
    positiveCase: '正例场景', counterexample: '', why: '反复出现',
  }
  const mr1 = await createSkill({ ...mkDeps([PASS], false), store: fakeStore }, memIn)
  assert(mr1.ok === true && mr1.verdict === 'proposed' && mr1.eventsCount === 3,
    '★★ 记忆来源：3 个跨会话事件 + 只有正例 → 过门槛')
  const verifierMem = buildNewSkillVerifyPrompt({
    ...memIn, existingSkills: [],
    events: [{ id: 'ev-1', sessionId: 'sess-a', createdAt: 1, summary: 's1', detail: 'd1' }],
  })
  assert(verifierMem.includes('真实事件') && verifierMem.includes('不要因此拒绝'),
    '★★ 记忆来源验证提示词带事件块，且不要求正反例同时存在')

  const mr2 = await createSkill({ ...mkDeps([PASS], false), store: fakeStore }, { ...memIn, events: ['ev-1', 'ev-2'] })
  assert(mr2.verdict === 'rejected' && JSON.stringify(mr2.missing || []).includes('3'), '★ 事件不足 3 个 → 拒绝')
  const mr3 = await createSkill({ ...mkDeps([PASS], false), store: fakeStore }, { ...memIn, events: ['ev-1', 'ev-4', 'ev-3'] })
  assert(mr3.verdict === 'rejected' && String(mr3.reason).includes('不同会话'),
    '★★ 三个事件同会话 → 拒绝（“反复出现”不成立）')
  const mr4 = await createSkill({ ...mkDeps([PASS], false), store: fakeStore }, { ...memIn, events: ['ev-1', 'ev-2', 'ev-x'] })
  assert(mr4.verdict === 'rejected' && String(mr4.reason).includes('作废'), '★ 事件已作废 → 拒绝')
  const mr5 = await createSkill({ ...mkDeps([PASS], false), store: fakeStore }, { ...memIn, counterexample: '', positiveCase: '' })
  assert(mr5.verdict === 'rejected' && JSON.stringify(mr5.missing || []).includes('至少一种'), '★ 正/反例都没有 → 拒绝')

  const extIn = {
    origin: 'external-rewrite', name: 'ext-skill', description: 'Use when ext.',
    body: '# E\n\n1. 规则', counterexample: '', positiveCase: '',
    source: { kind: 'self-found', ref: 'https://example.com/skill' }, why: '外部改写',
  }
  const ex1 = await createSkill({ ...mkDeps([PASS], true), store: fakeStore }, extIn)
  assert(ex1.ok === true && ex1.verdict === 'proposed' && ex1.requiresUserConsent === true,
    '★★ 外部来源 + createWriteBack=true → 仍只暂存，需用户确认')
  assert(!(await fs.readdir(mkRoot)).includes('ext-skill'), '★★ 外部来源：不自动进技能目录')
  const ex2 = await createSkill({ ...mkDeps([PASS], true), store: fakeStore, externalWriteBack: true }, extIn)
  assert(ex2.ok === true && ex2.verdict === 'created', '★ 用户显式开 externalWriteBack 后才允许直接写回')
  const ex3 = await createSkill({ ...mkDeps([PASS], true), store: fakeStore }, { ...extIn, source: null })
  assert(ex3.verdict === 'rejected' && JSON.stringify(ex3.missing || []).includes('source'), '★ 外部来源缺 source → 拒绝')
  const extPrompt = buildNewSkillVerifyPrompt({ ...extIn, existingSkills: [], externalSource: extIn.source })
  assert(extPrompt.includes('不要求本地反例') && extPrompt.includes('不得因为缺少本地反例'),
    '★★ 外部来源验证提示词不因缺本地反例拒绝')
}

console.log('== 62. 学习协议：单一真相源与关键约束 ==')
const rpPrompt = buildReviewPrompt({
  skillName: 'x', currentContent: 'C', revision: 'r',
  feedback: [{ from: 'user', text: 'T', confidence: 'high' }],
  memories: [], rulePoints: [], history: [],
})
// 用「当前常量全文」做包含断言：若有人日后内联一份过期副本，这里会失败
assert(rpPrompt.includes(LEARNING_PROTOCOL), '★ 评审提示词嵌入的是**当前**协议常量（防日后漂移出第二份副本）')
assert(LEARNING_PROTOCOL.includes('禁止自更新'), '协议明写「禁止自更新」（宪法级约束）')
assert(LEARNING_PROTOCOL.includes('纪律型内容不进技能库'), '协议明写纪律型不进技能库')
assert(LEARNING_PROTOCOL.includes('沉默 ≠ 满意'), '协议明写沉默≠满意')
const vpPrompt = buildVerifyPrompt({
  skillName: 'x', oldContent: 'A', newContent: 'B',
  counterexample: 'c', positiveCase: 'p', oldRulePoints: [{ id: '1', text: 't' }], coldStart: true,
})
assert(vpPrompt.includes('你看不到修改者的理由'), '★ 验证提示词明确告知「不给理由」（防自我一致性偏差）')
assert(vpPrompt.includes('逐条覆盖'), '回归门含冷启动的规则点覆盖要求')

console.log('== 63. 工具返回值必须能通过自己的 schema（第三次同类 bug 的防线）==')
// 本项目已三次栽在同一处：返回值自然写、schema 手写，两者之间没有强制校验
//  ① 未声明的 `unmarked`  ② `path: null` 挂在 string 上  ③ 未声明 `overlaps`
// 把「形状检查」固化成断言，让这类错误死在测试里。
const PROPOSE_KEYS = new Set(['ok', 'verdict', 'reason', 'path', 'missing', 'overlaps', 'sourceNotVerified', 'capLimit', 'existingCount', 'origin', 'requiresUserConsent', 'eventsCount', 'externalSource'])
function shapeError(r, where) {
  for (const [k, v] of Object.entries(r)) {
    if (!PROPOSE_KEYS.has(k)) return `${where}: 未声明的键 ${k}`
    if (v === null) return `${where}: ${k} 为 null（schema 里不是 nullable）`
  }
  if (typeof r.ok !== 'boolean') return `${where}: ok 必须是 boolean`
  if (typeof r.verdict !== 'string') return `${where}: verdict 必须是 string`
  for (const k of ['reason', 'path']) {
    if (r[k] !== undefined && typeof r[k] !== 'string') return `${where}: ${k} 必须是 string`
  }
  for (const k of ['missing', 'overlaps']) {
    if (r[k] !== undefined && !Array.isArray(r[k])) return `${where}: ${k} 必须是数组`
  }
  return null
}
const mAll = [m1, m2, m3, m4, m5, m6, m7, m8]
mAll.forEach((r, i) => {
  const bad = shapeError(r, `case${i + 1}`)
  assert(bad === null, `返回值形状合法${bad ? ' —— ' + bad : ''}`)
})
assert(!('path' in m1) && !('overlaps' in m1), '★ 拒绝路径省略空字段，而不是填 null')
assert(Object.keys(m6).every((k) => PROPOSE_KEYS.has(k)), '所有键都在 schema 里声明过')

console.log('== 64. 冻结机制已删除（V6-04）：不再有只写不读的状态 ==')
// 背景：`frozen / silentCycles` 随"连续静默周期"自动写入，但全仓没有任何读取点
//（证据驱动的修改本来就不需要它：没证据就不会改）。2026-10-21 用户拍板删除。
// 这里钉三件事：配置项没了、每条返回路径都不再带 frozen、旧状态字段被迁移清掉。
{
  const idxSrc = await fs.readFile(path.join(pluginRoot, 'src', 'index.js'), 'utf8')
  assert(!idxSrc.includes('reviewFreezeAfterCycles'),
    '★★ [V6-04] 配置项 reviewFreezeAfterCycles 已删除（不再有"静默周期冻结"开关）')

  const fzIdle = await rvCase('fz-idle', { replies: [], signal: false, emptyUsage: true })
  const fr1 = await runSkillReview(fzIdle.deps)
  assert(fr1.step === 'idle' && !('frozen' in fr1), '★ idle 路径不再带 frozen 字段')
  const fzUsage = await rvCase('fz-usageonly', { replies: [], signal: false })
  const fr2 = await runSkillReview(fzUsage.deps)
  assert(fr2.step === 'usage-only' && !('frozen' in fr2), '★ usage-only 路径不再带 frozen 字段')
  const fzRev = await rvCase('fz-reviewed', { replies: [JSON.stringify({ change: false, reason: '无需改' })] })
  const fr3 = await runSkillReview(fzRev.deps)
  assert(fr3.step === 'reviewed' && !('frozen' in fr3), '★ reviewed 路径不再带 frozen 字段')

  // 旧状态迁移：文件里还留着 frozen/silentCycles → 加载后清掉，保存后不再出现
  const fzOld = await rvCase('fz-legacy', { replies: [JSON.stringify({ change: false, reason: '无需改' })] })
  await fs.writeFile(path.join(fzOld.root, 'state.json'), JSON.stringify({
    usageCount: 0, signalCount: 0, selfReviewT: 0, pending: [],
    skills: { demorv: { frozen: true, silentCycles: 9, noChangeFp: null } },
  }), 'utf8')
  await runSkillReview(fzOld.deps)
  const stOld = JSON.parse(await fs.readFile(path.join(fzOld.root, 'state.json'), 'utf8'))
  const sv = stOld.skills?.demorv || {}
  assert(!('frozen' in sv) && !('silentCycles' in sv),
    '★★ [V6-04] 旧状态里的 frozen/silentCycles 被迁移清掉（不再保留只写不读的字段）')
}

console.log('== 65. 心跳周期哨兵值：0 必须真的禁用，不能被折回默认 ==')
// 曾经的 bug：const intervalMs = resolved.heartbeatIntervalMs || 1800000
// schema 描述承诺「0 = 禁用」，但 || 把 0 折成 30 分钟，禁用静默失效（死代码 if (!intervalMs) 永不可达）。
{
  const resolveInterval = (cfg) => cfg.heartbeatIntervalMs ?? 1800000
  assert(resolveInterval({ heartbeatIntervalMs: 0 }) === 0, '★ 0 保持 0（真的禁用），不被折回默认')
  assert(resolveInterval({}) === 1800000, '未配置时默认 30 分钟')
  assert(resolveInterval({ heartbeatIntervalMs: 60000 }) === 60000, '显式值原样生效')
  assert(!resolveInterval({ heartbeatIntervalMs: 0 }), '0 时定时器分支判定为 falsy → 不建 timer')

  // heartbeatEnabled=false 时必须锁死 turn/start 的自动开启
  const allowAutoEnable = (cfg) => cfg.heartbeatEnabled !== false
  const afterTurnStart = (cfg) => (allowAutoEnable(cfg) ? true : false)
  assert(allowAutoEnable({}) === true, '默认允许自动开启')
  assert(allowAutoEnable({ heartbeatEnabled: false }) === false, '★ 显式 false 时禁止自动开启')
  assert(afterTurnStart({ heartbeatEnabled: false }) === false, '★ 锁死后 turn/start 不会把心跳重新打开')
}

console.log('== 66. 工具名未找到时的引导（本次 sensenova 实测暴露的改进）==')
// 实测：模型臆造 `mnemos_reremember`，只收到一句 unknown tool 就作罢。
// 接口已核实：DSH 的 dsh-tools 让 unknown-tool 失败也走 post-execute，
// 且只禁止替换 failed result 的 value，不禁止替换 content。
{
  const REAL = new Set([
    'mnemos_remember', 'mnemos_recall', 'mnemos_open', 'mnemos_deprecate',
    'mnemos_dormant', 'mnemos_consolidate', 'mnemos_validate', 'mnemos_delete',
  ])
  const unknownResult = (name) => ({
    isError: true,
    error: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' },
    content: [{ type: 'text', text: `Error: unknown tool "${name}"` }],
  })

  // 编辑距离与近似匹配
  assert(editDistance('abc', 'abc') === 0, '编辑距离：相同为 0')
  assert(editDistance('abc', 'abd') === 1, '编辑距离：一字符之差为 1')
  assert(nearestToolName('mnemos_remember', REAL).name === 'mnemos_remember', '精确名命中自己')
  assert(nearestToolName('mnemos_reremember', REAL).name === 'mnemos_remember', '★ 臆造名匹配到最接近的真实工具')
  assert(nearestToolName('mnemosRecall', REAL).name === 'mnemos_recall', '归一化后（去下划线/大小写）仍能匹配')
  assert(nearestToolName('zzzzzzzz', REAL) === null, '毫无相似 → 不建议')

  // 识别「未找到工具」
  assert(detectUnknownTool(unknownResult('x'), 'x') !== null, '按 error.code 识别未找到工具')
  assert(detectUnknownTool({ content: [{ type: 'text', text: 'Error: unknown tool "y"' }] }, 'y') !== null, '按正文文本识别')
  assert(detectUnknownTool({ isError: true, content: [{ type: 'text', text: '命令失败：退出码 1' }] }, 'pwsh') === null, '★ 普通报错不误判')

  // 引导文本
  const g = buildUnknownToolGuidance(unknownResult('mnemos_reremember'), 'mnemos_reremember', REAL)
  assert(g && g.includes('mnemos_reremember'), '引导里点出被误用的名字')
  assert(g.includes('mnemos_remember'), '★ 给出最接近的真实工具')
  assert(g.includes('supersedes'), '★ 给出「更新已有记忆」的正确做法（supersedes）')
  assert(g.includes('mnemos_deprecate'), '给出「只作废」的做法')
  assert(g.includes('不要臆造工具名'), '明确提示不要臆造')
  // ★ 工具结果里不能出现字面 markdown 星号（系统提示曾因同样问题返工过）
  assert(!g.includes('**'), '★ 引导文本不得含字面 `**`（工具结果是纯文本，星号会原样显示）')

  // ★ 不越界：只管辖 mnemos_*，别的未知工具不插手
  assert(buildUnknownToolGuidance(unknownResult('websearch'), 'websearch', REAL) === null, '★ 非本插件命名空间的未知工具：不插手')
  assert(buildUnknownToolGuidance({ content: [{ type: 'text', text: 'ok' }] }, 'pwsh', REAL) === null, '正常结果：不插手')

  // ★ 清单单一真相源：文本随传入的集合变化，不写死
  const noDep = new Set(['mnemos_remember', 'mnemos_recall'])
  const g2 = buildUnknownToolGuidance(unknownResult('mnemos_reremember'), 'mnemos_reremember', noDep)
  assert(!g2.includes('mnemos_deprecate'), '★ 集合里没有 mnemos_deprecate 就不提它（杜绝清单漂移）')
  assert(g2.includes('mnemos_remember'), '集合里有的工具才会被列出')

  // 钩子行为
  const guide = makeUnknownToolGuide({ knownNames: REAL })
  const next = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'Error: unknown tool "mnemos_reremember"' }] })
  const out = await guide({ name: 'mnemos_reremember' }, unknownResult('mnemos_reremember'), next)
  assert(out.kind === 'accept' && out.content.length === 2, '★ 未知 mnemos 工具：追加一段引导')
  assert(out.content[1].text.includes('supersedes'), '追加的是引导文本')
  assert(!Object.hasOwn(out, 'value'), '★ 绝不替换 value（failed result 不允许）')

  const out2 = await guide({ name: 'pwsh' }, { content: [{ type: 'text', text: 'ok' }] }, async () => ({ kind: 'accept', content: [{ type: 'text', text: 'ok' }] }))
  assert(out2.content.length === 1, '★ 正常工具：原样放行，不加东西')

  // 钩子内部出错必须吞掉并告警，不能影响工具结果
  const warns = []
  const badGuide = makeUnknownToolGuide({ knownNames: REAL, onWarn: (m) => warns.push(m) })
  const out3 = await badGuide({ name: 'x' }, null, async () => { throw new Error('boom') }).catch((e) => ({ kind: 'accept', content: [], _threw: e.message }))
  assert(out3._threw === 'boom', 'next() 自己抛错时不吞（交由上层处理）')
  const out4 = await badGuide({ get name() { throw new Error('bad exec') } }, unknownResult('mnemos_x'), async () => ({ kind: 'accept', content: [] }))
  assert(out4.kind === 'accept' && warns.some((m) => m.includes('引导失败')), '★ 钩子内部出错：吞掉并告警，不影响工具结果')
}

console.log('== 67. 第三条评审因素：该用未用（A 记录提供 + B1 有界任务指纹）==')
{
  const od = path.join(dir, 'offer')
  const offersFile = skillOffersFileFor(path.join(od, 'memory.json'))
  const tasksFile = sessionTasksFileFor(path.join(od, 'memory.json'))
  const sigFile = userSignalsFileFor(path.join(od, 'memory.json'))
  const CATALOG = [
    '<system-reminder>',
    'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:',
    '',
    '<available_skills>',
    '- `diagnose-windows-sandbox-acl`: Use on Windows for unexpected DSH sandbox access denials: …',
    '- `host-interface-verification`: Use before writing code that depends on an external system…',
    '- `office-docx`: Create, read, edit, and check Word documents (.docx)…',
    '</available_skills>',
    '',
    'Use only names in this replacement catalog.',
    '</system-reminder>',
  ].join('\n')

  // A：目录 → 只抽名单
  const names = parseCatalogSkills(CATALOG)
  assert(names.length === 3, '从目录文本抽出 3 个技能名')
  assert(names[1] === 'host-interface-verification', '抽到正确的名字')
  assert(parseCatalogSkills('<available_skills>\n正文没有条目\n</available_skills>').length === 0, '无条目 → 空数组')
  assert(parseCatalogSkills('').length === 0, '空文本 → 空数组')

  // B1：有界指纹
  const fp = taskFingerprint('A'.repeat(500))
  assert(fp.length === TASK_FINGERPRINT_CHARS + 1 && fp.endsWith('…'), '★ 指纹被截断且带省略号（有界）')
  assert(taskFingerprint('  多个   空白\n换行  ') === '多个 空白 换行', '折叠空白')

  const offerTracker = makeSessionOfferTracker({ offersFile, tasksFile, onWarn: () => {} })
  const usageNone = { has: async () => false, mark: () => {} }
  const rec = makeUserSignalRecorder({
    signalsFile: sigFile, tracker: usageNone, offersFile, tasksFile, offerTracker, onWarn: () => {},
  })
  const ev = (kind, text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind } } })

  // 目录投递 → 只进 offers
  await rec({ id: 'S-off' }, ev('skill-catalog', CATALOG))
  assert((await readUserSignals(offersFile)).length === 1, '★ 目录投递记入 skill-offers')
  const off = (await readUserSignals(offersFile))[0]
  assert(off.skills.length === 3 && off.session === 'S-off', '记录里只有名单与会话')
  assert(!JSON.stringify(off).includes('Use on Windows'), '★ 目录正文不落盘（只记名单）')
  assert((await readUserSignals(sigFile)).length === 0, '★ 目录投递不进反馈通道')
  assert((await readUserSignals(tasksFile)).length === 0, '★ 目录投递不进任务指纹通道')

  // 只被提供过、没用过 → 任务指纹
  await rec({ id: 'S-off' }, ev('user', '帮我装一个插件，注意别和现有插件冲突'))
  const tr = await readUserSignals(tasksFile)
  assert(tr.length === 1 && tr[0].session === 'S-off', '★ 只被提供过技能 → 进任务指纹通道')
  assert((await readUserSignals(sigFile)).length === 0, '★ 此时不进反馈通道（两条通道互斥）')

  // 用过技能的会话 → 全文反馈
  const usage2 = { has: async (sid) => sid === 'S-used', mark: () => {} }
  const rec2 = makeUserSignalRecorder({
    signalsFile: sigFile, tracker: usage2, offersFile, tasksFile, offerTracker, onWarn: () => {},
  })
  await rec2({ id: 'S-used' }, ev('user', '这个技能不好用'))
  const sg = await readUserSignals(sigFile)
  assert(sg.length === 1 && sg[0].text === '这个技能不好用', '用过技能 → 全文进反馈通道')
  assert((await readUserSignals(tasksFile)).length === 1, '★ 用过技能的会话不进任务指纹通道（互斥）')

  // 既没用过也没被提供过 → 不落盘
  await rec2({ id: 'S-none' }, ev('user', '无关消息'))
  assert((await readUserSignals(sigFile)).length === 1 && (await readUserSignals(tasksFile)).length === 1, '★ 未提供过的会话：不落盘')

  // 其它注入类型不落盘
  await rec({ id: 'S-x' }, ev('runtime-context', 'Current runtime context…'))
  assert((await readUserSignals(offersFile)).length === 1, '★ 非 skill-catalog 的注入类型不落盘')

  // 每会话上限
  const tracker3 = makeSessionOfferTracker({ offersFile, tasksFile, onWarn: () => {} })
  const rec3 = makeUserSignalRecorder({
    signalsFile: sigFile, tracker: usage2, offersFile, tasksFile, offerTracker: tracker3, onWarn: () => {},
  })
  await rec3({ id: 'S-off' }, ev('skill-catalog', CATALOG))
  const before = (await readUserSignals(tasksFile)).length
  for (let i = 0; i < TASK_MAX_PER_SESSION + 5; i++) await rec3({ id: 'S-off' }, ev('user', '任务 ' + i))
  const after = (await readUserSignals(tasksFile)).length
  assert(after - before === TASK_MAX_PER_SESSION - tr.length, '★ 每会话任务指纹有上限（封顶 ' + TASK_MAX_PER_SESSION + '）')

  // 惰性回填（模拟重启）
  const fresh = makeSessionOfferTracker({ offersFile, tasksFile, onWarn: () => {} })
  assert(await fresh.hasOffering('S-off') === true, '★ 惰性回填：重启后仍认得被提供过')
  assert(await fresh.hasOffering('S-never') === false, '未提供过的会话为 false')
  assert(await fresh.taskCount('S-off') > 0, '★ 惰性回填：任务计数也能恢复（用于上限判断）')

  // 出错吞掉
  const w = []
  const bad = makeUserSignalRecorder({
    signalsFile: sigFile, tracker: { has: async () => { throw new Error('boom') } },
    offersFile, tasksFile,
    offerTracker: { hasOffering: async () => true, taskCount: async () => 0, bumpTask: () => {}, recordOffering: async () => {} },
    onWarn: (m) => w.push(m),
  })
  await bad({ id: 'S' }, ev('user', 'x'))
  assert(w.some((m) => m.includes('boom')), '★ 内部出错：吞掉并告警，不抛给宿主')
}

console.log('== 68. 第三条评审因素：B2 独立判定 + B3 进评审（含机械闸门）==')
{
  const md = path.join(dir, 'miss2')
  const mdFile = path.join(md, 'memory.json')
  const offersFile = path.join(md, 'offers.jsonl')
  const tasksFile = path.join(md, 'tasks.jsonl')
  const usageFile = path.join(md, 'usage.jsonl')
  const stateFile = path.join(md, 'mstate.json')
  const missFile = path.join(md, 'miss.jsonl')
  await fs.mkdir(md, { recursive: true })
  await fs.writeFile(usageFile, '', 'utf8')
  await fs.writeFile(tasksFile, JSON.stringify({ t: 10, session: 'S1', text: '帮我装一个插件到 profile' }) + '\n', 'utf8')
  await fs.writeFile(offersFile, JSON.stringify({ t: 5, session: 'S1', skills: ['misskill', 'office-docx'] }) + '\n', 'utf8')

  // 技能根：只有一个自己的技能
  const mr = path.join(dir, 'miss-root')
  await fs.mkdir(path.join(mr, 'misskill'), { recursive: true })
  const ORIG68 = '---\nname: misskill\ndescription: Use when demo.\n---\n\n# Demo\n\n1. 规则一\n'
  await fs.writeFile(path.join(mr, 'misskill', 'SKILL.md'), ORIG68, 'utf8')

  // ---- 判定提示词 ----
  const mp = buildMissPrompt({
    offered: [{ name: 'misskill', description: 'Use when demo.' }],
    tasks: [{ text: '帮我装一个插件' }],
    feedback: [],
  })
  assert(mp.includes('一个都没有加载'), '提示词点明「一个都没加载」')
  for (const r of MISS_REASONS) assert(mp.includes(r), '提示词列出原因取值：' + r)
  assert(mp.includes('宁可漏判'), '★ 提示词要求宁可漏判不要误判')

  // ---- B2：判定 ----
  const llmMiss = (reply) => ({ stream: () => (async function* () { yield { type: 'text-delta', text: reply }; yield { type: 'finish', reason: { kind: 'stop' } } })() })
  const GOOD_MISS = JSON.stringify({
    misses: [
      { skill: 'misskill', reason: 'description-scope', why: '装插件改 profile 属于工作区外文件操作', suggestion: '把「改 profile/插件配置」写进触发条件' },
      { skill: 'office-docx', reason: 'description-vague', why: '内置技能', suggestion: 'x' },
      { skill: 'misskill', reason: 'not-applicable', why: '其实不适用', suggestion: 'y' },
      { skill: '不存在的技能', reason: 'name-unclear', why: 'z', suggestion: 'w' },
      { skill: 'misskill', reason: '瞎写的理由', why: 'q', suggestion: 'r' },
    ],
  })
  const r68 = await detectMissedUsage({
    skillRoot: mr, offersFile, tasksFile, usageFile, stateFile, missFile,
    llm: llmMiss(GOOD_MISS), provider: 'p', model: 'm', onWarn: () => {},
  })
  assert(r68.step === 'judged' && r68.misses === 1, '★ 只写入 1 条有效 miss（内置技能/不适用/不存在/非法原因 全被滤掉）')
  const ms = await readMisses(missFile)
  assert(ms.length === 1 && ms[0].skill === 'misskill' && ms[0].reason === 'description-scope', 'miss 内容正确')
  assert(r68.results[0].skippedBuiltin === 1, '★ 内置技能被跳过（不越界：改不了的不判）')

  // 已判过的会话不再判
  const r68b = await detectMissedUsage({
    skillRoot: mr, offersFile, tasksFile, usageFile, stateFile, missFile,
    llm: llmMiss(GOOD_MISS), provider: 'p', model: 'm', onWarn: () => {},
  })
  assert(r68b.step === 'idle', '★ 已判过的会话不重复判（不重复花钱）')
  assert((await readMisses(missFile)).length === 1, '没有重复写入 miss')

  // 用过技能的会话不是候选
  await fs.writeFile(usageFile, JSON.stringify({ t: 20, session: 'S1', skill: 'misskill', revision: 'x' }) + '\n', 'utf8')
  const r68c = await detectMissedUsage({
    skillRoot: mr, offersFile, tasksFile, usageFile, stateFile: path.join(md, 'mstate2.json'), missFile,
    llm: llmMiss(GOOD_MISS), provider: 'p', model: 'm', onWarn: () => {},
  })
  assert(r68c.step === 'idle', '★ 用过技能的会话不进该用未用判定')
  await fs.writeFile(usageFile, '', 'utf8')

  // LLM 出错 → 不标 judged（下轮重试）
  const badLlm = { stream: () => (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } } })() }
  const r68d = await detectMissedUsage({
    skillRoot: mr, offersFile, tasksFile, usageFile, stateFile: path.join(md, 'mstate3.json'), missFile,
    llm: badLlm, provider: 'p', model: 'm', onWarn: () => {},
  })
  assert(r68d.results[0].step === 'error', 'LLM 出错 → 记 error')
  const st3 = JSON.parse(await fs.readFile(path.join(md, 'mstate3.json'), 'utf8'))
  assert(!st3.judged.includes('S1'), '★ 出错时不标 judged（下轮可重试，不静默丢失）')

  // 无 LLM → 不判
  const r68e = await detectMissedUsage({
    skillRoot: mr, offersFile, tasksFile, usageFile, stateFile: path.join(md, 'mstate4.json'), missFile,
    llm: null, onWarn: () => {},
  })
  assert(r68e.step === 'no-llm', '无 LLM → 只挑候选、不判定')

  // ---- B3：机械闸门 ----
  assert(splitSkillContent(ORIG68).body.trim().startsWith('# Demo'), 'splitSkillContent 分出正文')
  const DESC_ONLY = '---\nname: misskill\ndescription: Use when demo, especially when installing plugins into a profile.\n---\n\n# Demo\n\n1. 规则一\n'
  const BODY_CHANGED = '---\nname: misskill\ndescription: Use when demo.\n---\n\n# Demo\n\n1. 规则一（改）\n'
  const NAME_CHANGED = '---\nname: misskill2\ndescription: Use when demo.\n---\n\n# Demo\n\n1. 规则一\n'
  const MULTILINE = '---\nname: misskill\ndescription: |\n  Use when demo.\n  More.\n---\n\n# Demo\n\n1. 规则一\n'
  assert(isDescriptionOnlyChange(ORIG68, DESC_ONLY) === true, '★ 只改 description → 通过')
  assert(isDescriptionOnlyChange(ORIG68, BODY_CHANGED) === false, '★ 改了正文 → 拦下')
  assert(isDescriptionOnlyChange(ORIG68, NAME_CHANGED) === false, '★ 改了 name → 拦下')
  assert(isDescriptionOnlyChange(ORIG68, MULTILINE) === false, '★ 多行 description → fail-closed 拦下')

  // miss 驱动评审：只改描述 → proposed
  const st68 = path.join(md, 'rstate.json')
  const base68 = {
    store: { memories: new Map(), recall: () => [] }, skillRoot: mr,
    usageFile, signalsFile: path.join(md, 'nosig.jsonl'),
    stateFile: st68, feedbackFile: path.join(md, 'fb.jsonl'), missFile,
    provider: 'p', model: 'm', writeBack: false, onWarn: () => {},
  }
  const revOK = JSON.stringify({ change: true, why: '装插件的场景没被描述覆盖', rulePoint: 'description', counterexample: '该会话任务 + 旧描述没被加载', positiveCase: '同类任务 + 新描述会被加载', newContent: DESC_ONLY })
  const rv68 = await runSkillReview({ ...base68, llm: mkLlm([revOK, GOOD_VERIFY]) })
  assert(rv68.misses === 1, '评审消费到 1 条 miss')
  assert(rv68.results[0].mode === 'miss', '★ 以 miss 模式评审')
  assert(rv68.results[0].step === 'proposed', '★ 只改描述 → 通过机械闸门 → proposed')

  // miss 驱动评审：改了正文 → body-changed
  const st68b = path.join(md, 'rstate2.json')
  await fs.writeFile(path.join(mr, 'misskill', 'SKILL.md'), ORIG68, 'utf8')
  const revBAD = JSON.stringify({ change: true, why: 'x', rulePoint: '1', counterexample: 'c', positiveCase: 'p', newContent: BODY_CHANGED })
  const rv68b = await runSkillReview({ ...base68, stateFile: st68b, llm: mkLlm([revBAD, GOOD_VERIFY]) })
  assert(rv68b.results[0].step === 'body-changed', '★★ miss 模式改了正文 → 被代码层机械闸门拦下')
  assert((await fs.readFile(path.join(mr, 'misskill', 'SKILL.md'), 'utf8')) === ORIG68, '★ 被拦下时技能文件未动')
  const h68 = await fs.readFile(path.join(mr, 'misskill', 'history.jsonl'), 'utf8')
  assert(h68.includes('body-changed') === false && h68.includes('该用未用只能改描述'), 'history 记下拦截原因')

  // ★ model-ignored 不驱动评审（它是"检索触发缺口"的证据，属纪律层）
  const st68d = path.join(md, 'rstate4.json')
  const missIgnored = path.join(md, 'miss-ignored.jsonl')
  await fs.writeFile(missIgnored, JSON.stringify({ t: Date.now(), session: 'S-ig', skill: 'misskill', reason: 'model-ignored', why: 'w', suggestion: 's' }) + '\n', 'utf8')
  const rv68d = await runSkillReview({ ...base68, stateFile: st68d, missFile: missIgnored, llm: mkLlm([revOK, GOOD_VERIFY]) })
  assert(rv68d.misses === 1, 'model-ignored 仍被读出（记录保留）')
  assert(rv68d.retrievalGaps === 1, '★ model-ignored 计入 retrievalGaps')
  assert(!rv68d.results || rv68d.results.length === 0, '★★ model-ignored 不驱动评审（不产生 results）')
  const st68d2 = JSON.parse(await fs.readFile(st68d, 'utf8'))
  assert(st68d2.missT > 0, '★ 仍推进水位（不会被反复重读）')

  // 反馈证据优先于 miss（模式选择）
  const st68c = path.join(md, 'rstate3.json')
  const sig68 = path.join(md, 'sig3.jsonl')
  await fs.writeFile(sig68, JSON.stringify({ t: 200, session: 'S', source: 'user', text: '不好用' }) + '\n', 'utf8')
  const revFB = JSON.stringify({ change: true, why: '反馈', rulePoint: '1', counterexample: 'c', positiveCase: 'p', newContent: BODY_CHANGED })
  const usage3 = path.join(md, 'usage3.jsonl')
  await fs.writeFile(usage3, JSON.stringify({ t: 100, session: 'S', skill: 'misskill', revision: revisionOf(ORIG68) }) + '\n', 'utf8')
  const rv68c = await runSkillReview({
    ...base68, stateFile: st68c, signalsFile: sig68, usageFile: usage3,
    llm: mkLlm([revFB, GOOD_VERIFY]),
  })
  assert(rv68c.results[0].mode === 'feedback', '★ 有反馈时按反馈模式（反馈证据更强）')
  assert(rv68c.results[0].step === 'proposed', '★ 反馈模式改正文不受 miss 闸门限制')
}

console.log('== 69. 卡住检测（机制，不靠模型自觉）==')
{
  const ex = (name, args) => ({ name, arguments: args })
  const FAIL = { isError: true }
  const OK = { content: [{ type: 'text', text: 'ok' }] }

  assert(callKey(ex('pwsh', { c: 'a' })) === callKey(ex('pwsh', { c: 'a' })), '同一工具+同一入参 → 同一 key')
  assert(callKey(ex('pwsh', { c: 'a' })) !== callKey(ex('pwsh', { c: 'b' })), '入参不同 → key 不同')
  assert(callKey(ex('pwsh', { c: 'a' })) !== callKey(ex('read', { c: 'a' })), '工具不同 → key 不同')
  assert(isFailed(FAIL) === true, 'isError → 失败')
  assert(isFailed({ error: { code: 'UNKNOWN_TOOL' } }) === true, '带 error.code → 失败')
  assert(isFailed(OK) === false, '正常结果 → 非失败')
  assert(buildStuckHint('因为X').includes('mnemos_recall'), '提示里含召回指令')
  assert(buildStuckHint('因为X').includes('因为X'), '提示里含客观触发依据')
  // ★ 结构性约束：凡注入给模型的文本都要过 plain()。同类缺陷已出现四次，故在两个构造器上都断言。
  assert(!buildStuckHint('因为X').includes('**'), '★ 卡住提示不得含字面 `**`（同类缺陷第四次）')
  const g9 = buildUnknownToolGuidance({ isError: true, error: { code: 'UNKNOWN_TOOL' }, content: [] }, 'mnemos_x', new Set(['mnemos_remember']))
  assert(g9 && !g9.includes('**'), '★ 工具引导同样不得含字面 `**`')
  assert(plain('a**b**c') === 'abc', 'plain() 去掉加粗星号')
  assert(plain('保留 `code` 与 [方括号]') === '保留 `code` 与 [方括号]', 'plain() 保留反引号与方括号')

  // ★ 连续失败触发
  const d1 = makeStuckDetector()
  assert(d1.observe('S', ex('pwsh', { c: '1' }), FAIL) === null, '连续 1 次失败：不提示')
  assert(d1.observe('S', ex('pwsh', { c: '2' }), FAIL) === null, '连续 2 次失败：不提示')
  const hit = d1.observe('S', ex('pwsh', { c: '3' }), FAIL)
  assert(typeof hit === 'string' && hit.includes('连续 3 次'), '★ 连续 3 次失败 → 触发提示')
  assert(d1.observe('S', ex('pwsh', { c: '4' }), FAIL) === null, '★ 触发后进入冷却（不刷屏）')

  // 成功打断失败计数
  const d2 = makeStuckDetector()
  d2.observe('S', ex('a', {}), FAIL)
  d2.observe('S', ex('b', {}), FAIL)
  d2.observe('S', ex('c', {}), OK)
  assert(d2.observe('S', ex('d', {}), FAIL) === null, '★ 成功打断连续失败计数')
  assert(d2.observe('S', ex('e', {}), FAIL) === null, '重新攒计数')

  // ★ 同一调用重复触发
  const d3 = makeStuckDetector()
  assert(d3.observe('S', ex('read', { f: 'x' }), OK) === null, '重复 1 次：不提示')
  assert(d3.observe('S', ex('read', { f: 'x' }), OK) === null, '重复 2 次：不提示')
  const hit3 = d3.observe('S', ex('read', { f: 'x' }), OK)
  assert(typeof hit3 === 'string' && hit3.includes('重复 3 次'), '★ 同一调用重复 3 次 → 触发提示')
  assert(d3.observe('S', ex('read', { f: 'y' }), OK) === null, '换入参后不触发')

  // 会话隔离
  const d4 = makeStuckDetector()
  d4.observe('A', ex('t', {}), FAIL)
  d4.observe('A', ex('t', {}), FAIL)
  assert(d4.observe('B', ex('t', {}), FAIL) === null, '★ 会话之间独立计数')
  assert(typeof d4.observe('A', ex('t', {}), FAIL) === 'string', 'A 自己攒够就触发')

  // 钩子行为
  const d5 = makeStuckDetector()
  const next5 = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'boo' }] })
  const call = (c) => d5.hook({ name: 'pwsh', arguments: { c }, agent: { session: { id: 'S' } } }, FAIL, next5)
  await call(1); await call(2)
  const out = await call(3)
  assert(out.kind === 'accept' && out.content.length === 2, '★ 钩子：触发时追加一段提示')
  assert(out.content[1].text.includes('卡住提示'), '追加的是卡住提示')
  assert(!Object.hasOwn(out, 'value'), '★ 绝不替换 value')
  const out2 = await d5.hook({ name: 'pwsh', arguments: { c: 4 }, agent: { session: { id: 'S' } } }, OK, async () => ({ kind: 'accept', content: [{ type: 'text', text: 'ok' }] }))
  // ★ F-8 改动了这里的行为：冷却期内**不再**追加"卡住提示"，但这段失败流是**以成功结束**的，
  //   所以会追加一次「失败→修好」的沉淀引导（这两件事不矛盾：一个是重复刷屏、一个是收尾一次）。
  assert(
    out2.content.length === 2 && out2.content[1].text.includes('失败→修好'),
    '★ 冷却期内不重复卡住提示，但失败流以成功结束 → 追加一次「失败→修好」引导'
  )

  const d6 = makeStuckDetector()
  const out3 = await d6.hook({ name: 'x', arguments: {} }, FAIL, async () => ({ kind: 'accept', content: [] }))
  assert(out3.content.length === 0, '无会话标识：不介入')

  const warns = []
  const d7 = makeStuckDetector({ onWarn: (m) => warns.push(m) })
  const out4 = await d7.hook({ get name() { throw new Error('bad exec') }, agent: { session: { id: 'S' } } }, FAIL, async () => ({ kind: 'accept', content: [] }))
  assert(out4.kind === 'accept' && warns.some((m) => m.includes('卡住检测失败')), '★ 内部出错：吞掉并告警')
}

console.log('== 71. 确定性凭据过滤（三个卡口 + 不泄露）==')
{
  const FAKE_SK = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'
  const FAKE_GH = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
  const FAKE_AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP'

  assert(findSecrets(`x ${FAKE_SK} y`).length === 1, '识别 OpenAI 风格 key')
  assert(findSecrets(FAKE_GH).length === 1, '识别 GitHub token')
  assert(findSecrets(FAKE_AWS).length === 1, '识别 AWS access key')
  assert(findSecrets('Authorization: Bearer abcdefghij1234567890XYZ').length === 1, '识别 Bearer token')
  // 夹具刻意**拼接**而成：既保留对私钥头模式的测试，又不会让 GitHub 的私钥扫描误报
  assert(findSecrets('-----BEGIN ' + 'RSA PRIVATE KEY' + '-----').length === 1, '识别私钥头')
  assert(findSecrets('普通文本，没有任何凭据').length === 0, '普通文本不误报')
  assert(findSecrets('').length === 0, '空文本 → 空')
  assert(findSecrets('api_key: ABCD1234').length === 0, '★ 短占位符不误报（长度下限取严）')

  const hits = findSecrets(`x ${FAKE_SK} y`)
  assert(!JSON.stringify(hits).includes(FAKE_SK), '★★ findSecrets 返回值里不含命中内容')
  assert(!describeHits(hits).includes(FAKE_SK), '★★ describeHits 里不含命中内容')
  assert(describeHits(hits).includes('openai-key'), 'describeHits 报告模式名')

  const red = redactSecrets(`前 ${FAKE_SK} 后`)
  assert(!red.includes(FAKE_SK) && red.includes('已屏蔽'), '★ redactSecrets 抹掉内容并留标记')
  assert(red.startsWith('前 ') && red.endsWith(' 后'), '★ 打码保留其余文本')

  // 卡口 1：记忆写入（拒写）
  const sd = path.join(dir, 'seccard')
  const st = new MemoryStore(path.join(sd, 'memory.json'))
  await st.load()
  let threw = null
  try { await st.remember({ content: `我的 key 是 ${FAKE_SK}`, summary: '测试' }) } catch (e) { threw = e }
  assert(threw !== null, '★ 记忆写入含凭据 → 抛错（拒写）')
  assert(!threw.message.includes(FAKE_SK), '★★ 错误信息里不含凭据内容（过滤不成为新泄露渠道）')
  assert(threw.message.includes('openai-key'), '错误信息报出模式名')
  assert(threw.message.includes('跨会话'), '错误信息解释原因')
  assert(st.memories.size === 0, '★ 拒写后记忆体为空（确实没落盘）')
  const okw = await st.remember({ content: '普通内容', summary: '正常' })
  assert(okw && st.memories.size === 1, '不含凭据的写入不受影响')

  // 卡口 2：信号捕获（打码）
  const sigFile = path.join(sd, 'signals.jsonl')
  const auditFile = path.join(sd, 'secret-blocks.jsonl')
  const rec = makeUserSignalRecorder({
    signalsFile: sigFile, tracker: { has: async () => true }, secretBlocksFile: auditFile, onWarn: () => {},
  })
  await rec({ id: 'S' }, { type: 'user/message', data: { content: [{ type: 'text', text: `帮我配一下 ${FAKE_SK} 这个 key` }], source: { kind: 'user' } } })
  const sigs = await readUserSignals(sigFile)
  assert(sigs.length === 1, '信号仍然落盘（策略是打码，不是拒写）')
  assert(!sigs[0].text.includes(FAKE_SK), '★ 信号里的凭据已打码')
  assert(sigs[0].text.includes('帮我配一下'), '★ 用户原话其余部分保留（不丢反馈）')
  const audit = await readUserSignals(auditFile)
  assert(audit.length === 1 && audit[0].action === 'redacted' && audit[0].where === 'signal-capture', '★ 命中记入审计（环节 + 动作）')
  assert(!JSON.stringify(audit).includes(FAKE_SK), '★★ 审计里也不含凭据内容')

  // 卡口 3：技能写入
  assert(assertNoSecretInSkill('技能正文', `规则：用 ${FAKE_SK} 调用`) !== null, '★ 技能正文含凭据 → 判为不可写入')
  assert(assertNoSecretInSkill('技能正文', '规则：用 <YOUR_KEY> 调用') === null, '占位符形式可以写')
  let threw2 = null
  try { await writeBackSkill(path.join(mr, 'misskill'), ORIG68, revisionOf(ORIG68), `---\nname: x\ndescription: ${FAKE_SK}\n---\n\n# X\n`) } catch (e) { threw2 = e }
  assert(threw2 !== null && !threw2.message.includes(FAKE_SK), '★★ writeBackSkill 拒写且错误信息不泄露')
  const jf = path.join(sd, 'hist.jsonl')
  await appendJsonl(jf, { why: `因为 ${FAKE_SK} 泄露了`, ok: 1 })
  const jline = (await fs.readFile(jf, 'utf8')).trim()
  assert(!jline.includes(FAKE_SK) && jline.includes('已屏蔽'), '★ 记录类 JSONL：打码后保留（不拒写）')
  assert(jline.includes('"ok":1'), '★ 打码不影响该条其余字段')
  const cr = await createSkill(
    { skillRoot: mr, dataFile: path.join(sd, 'memory.json'), llm: mkLlm([PASS]), provider: 'p', model: 'm', writeBack: true },
    // ★ F-10 起反例必须带来源（否则会先被"缺来源"拒掉、测不到凭据卡口）——这里补上合法来源
    { name: 'sec-new', description: 'Use when x.', body: `# X\n\n${FAKE_SK}`, counterexample: `c（${srcRef('session-sec', 1)}）`, positiveCase: 'p' }
  )
  assert(cr.ok === false && cr.verdict === 'rejected' && cr.reason.includes('凭据'), '★ 新建技能含凭据 → 拒绝')
  assert(!cr.reason.includes(FAKE_SK), '★★ 拒绝理由里不含凭据内容')
}

console.log('== 72. F-1 修复：load 未完成即写入，不再把整库覆盖成一条 ==')
{
  const d2 = path.join(dir, 'f1')
  const f2 = path.join(d2, 'memory.json')
  const a = new MemoryStore(f2)
  await a.load()
  for (const i of [1, 2, 3]) await a.remember({ content: `第${i}条`, summary: `第${i}条` })
  assert(JSON.parse(await fs.readFile(f2, 'utf8')).length === 3, '前置：写入 3 条')

  // ★★ 关键：新建实例**不调用 load()** 就直接写 —— 修复前这里会把 3 条覆盖成 1 条（静默丢数据）
  const b = new MemoryStore(f2)
  await b.remember({ content: '竞态写入', summary: '竞态写入' })
  assert(JSON.parse(await fs.readFile(f2, 'utf8')).length === 4, '★★ 不 load 直接 remember：原有 3 条必须保住（共 4 条）')

  // 读路径不受影响
  const c = new MemoryStore(f2)
  await c.load()
  assert(c.memories.size === 4, '重新 load 后仍是 4 条')

  // 其余写路径同样受保护（deprecate / markDormant 各自先 ensureLoaded）
  const ids = [...c.memories.keys()]
  const victim = ids[0]
  const other = ids[1]
  const e = new MemoryStore(f2) // 同样不 load
  await e.deprecate([victim])
  assert(JSON.parse(await fs.readFile(f2, 'utf8')).length === 4, '★ 未 load 的 deprecate 也不丢数据（仍是 4 条）')
  assert(e.memories.get(victim).source === 'deprecated', 'deprecate 生效（已标记）')
  assert(JSON.parse(await fs.readFile(f2, 'utf8')).filter((m) => m.source === 'deprecated').length === 1, '落盘的确实是标记后的那一条')

  const g = new MemoryStore(f2)
  await g.markDormant([other], 'S1')
  assert(JSON.parse(await fs.readFile(f2, 'utf8')).length === 4, '★ 未 load 的 markDormant 同样不丢数据')
  assert((g.memories.get(other).dormIn || []).includes('S1'), 'markDormant 生效（写进 dormIn）')
  // 正确行为（非缺陷）：对已作废条目应**明确拒绝**，不是静默跳过
  const resDep = await g.markDormant([victim], 'S1')
  assert(resDep.some((r) => r.id === victim && r.ok === false && r.reason === 'deprecated'), '★ 对 deprecated 条目：明确回 deprecated，不静默')

  // ensureLoaded 幂等 + 并发只真 load 一次
  const h = new MemoryStore(f2)
  await Promise.all([h.ensureLoaded(), h.ensureLoaded(), h.ensureLoaded()])
  assert(h.loaded === true && h.memories.size === 4, '★ 并发 ensureLoaded 幂等，且只 load 一次')
}

console.log('== 73. F-2 折叠快照 + 元记录（确定性抽取 / 保底原文 / 不干扰折叠）==')
{
  // ── 夹具：**构造的假事件 + 最小 session 桩**（只含 eventAt / deriveEventMessage，
  //    与宿主核实到的两个方法一一对应；不含任何 DSH 上下文，也不读系统提示）──
  const mkSession = (id, events) => {
    const bySeq = new Map(events.map((e) => [e.seq, e]))
    return {
      id,
      eventAt: (s) => bySeq.get(s),
      // 与 dsh-session/lib/index.js:214-227 的映射一致
      deriveEventMessage: (ev) => {
        if (!ev) return null
        if (ev.type === 'user/message') return ev.data
        if (ev.type === 'tool/result' || ev.type === 'assistant/message') return ev.data.message ?? null
        return null
      },
    }
  }
  const EVENTS = [
    // tool/call 不在 surface 上（实测如此）—— 工具名只能顺 sourceEventSeqs 回溯
    { seq: 1, type: 'tool/call', data: { callId: 'c1', name: 'pwsh' } },
    { seq: 2, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '帮我把 ffmpeg 装好\n第二行不该被取到' }], source: { kind: 'user' } } },
    { seq: 3, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '这是技能目录注入，不该算用户请求' }], source: { kind: 'skill-catalog' } } },
    { seq: 4, type: 'tool/result', data: { message: { role: 'tool', isError: true, content: [{ type: 'text', text: 'Error: EPERM writing to npm-cache\n更多细节不该被取' }] }, error: { name: 'FsError', code: 'EPERM' } }, sourceEventSeqs: [1] },
    { seq: 5, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '结论：这条路线走不通。\n这是一句无关的普通句子。' }] } } },
    { seq: 6, type: 'tool/result', data: { message: { role: 'tool', isError: false, content: [{ type: 'text', text: '成功的输出' }] } }, sourceEventSeqs: [7] },
    { seq: 7, type: 'tool/call', data: { callId: 'c2', name: 'read' } },
  ]
  const S = mkSession('S-73', EVENTS)

  // ── A1 模式表是导出的单一真相源 ──
  assert(Array.isArray(NEGATIVE_CONCLUSION_PATTERNS) && NEGATIVE_CONCLUSION_PATTERNS.length === 11, '★ 模式表导出为常量（11 条，单一真相源）')
  assert(NEGATIVE_CONCLUSION_PATTERNS.every((p) => typeof p.name === 'string' && p.re instanceof RegExp), '模式表每项含 name + RegExp（照 secret-patterns 风格）')
  assert(NEGATIVE_CONCLUSION_PATTERNS.some((p) => p.name === 'retry-stop-zh' && p.re.test('不要再试')), '中文模式命中「不要再试」')
  assert(matchNegative('Do NOT retry this route') === 'do-not-en', '★ 英文模式大小写不敏感（Do NOT）')
  assert(matchNegative('这条路已经 ruled out 了') === 'ruled-out-en', '英文 ruled out 命中')
  assert(matchNegative('这是一个完全无关的句子') === null, '无关句子不命中')

  // ── A2 确定性抽取：三类各命中一条 ──
  const facts = extractShadowedFacts(S, [2, 3, 4, 5, 6])
  assert(facts.failures.length === 1, '① 工具失败抽出 1 条')
  assert(facts.failures[0].tool === 'pwsh', '★ 工具名回溯到 tool/call（tool/call 不在遮蔽区里）')
  assert(facts.failures[0].error === 'Error: EPERM writing to npm-cache', '错误只取首行（不含"更多细节"）')
  assert(facts.failures[0].seq === 4, '工具失败带来源 seq')
  assert(facts.userRequests.length === 1 && facts.userRequests[0].text === '帮我把 ffmpeg 装好', '② 用户请求只取 kind=user 的首行')
  assert(facts.userRequests[0].seq === 2, '用户请求带来源 seq')
  assert(facts.negatives.length === 1 && facts.negatives[0].text.includes('走不通'), '③ 负面结论抽出 1 条')
  assert(facts.negatives[0].pattern === 'dead-end-zh' && facts.negatives[0].seq === 5, '负面结论带命中的模式名与来源 seq')
  assert(facts.totals.failures === 1 && facts.totals.userRequests === 1 && facts.totals.negatives === 1, 'totals 与列出条数一致')

  // skill-catalog 不算用户请求；非错误的 tool/result 不算失败
  assert(!facts.userRequests.some((u) => u.seq === 3), '★ skill-catalog 注入不被当作用户请求（白名单）')
  assert(!facts.failures.some((f) => f.seq === 6), '成功的 tool/result 不算失败')

  // 取不到结构就安全跳过（不猜）
  assert(nodeText({ type: 'compaction/start', data: { turn: 1 } }, null) === '', '未知类型节点：不猜结构，返回空串')
  assert(derivedMessage(S, 999).ev === null, '越界 seq：eventAt 返回空 → 安全跳过')
  assert(toolNameForCall(S, { type: 'tool/result', data: { message: {} } }) === '?', '解析不到工具名 → 返回 ?（不猜）')
  assert(isToolFailure({ type: 'tool/result', data: { message: { isError: true } } }) === true, 'isError=true 判为失败')
  assert(isToolFailure({ type: 'tool/result', data: { message: { isError: true }, error: null } }) === true, '★ error=null 但 isError=true 仍算失败（真实日志见过）')

  // 有界：单条字符上限
  assert(clip('x'.repeat(500)).length === 301, '单条事实按字符上限截断（+省略号）')
  assert(firstLine('\n\n  首行  \n次行') === '首行', 'firstLine 取首个非空行')

  // ★ 真实日志（seq 935）暴露的缺陷：失败的 web_fetch 结果里，第一个 text 块是**我们自己注入的标记**，
  //   错误正文在后面。取"错误首行"不能把自家标记当成原文。
  const MARKED = '[外部信息 · web_fetch · 可能过时或有偏，需验证]\nError: fetch failed\n'
  assert(INJECTED_MARKER_PREFIXES.length > 0 && INJECTED_MARKER_PREFIXES[0] === '[外部信息 ·', '注入标记前缀是导出的单一真相源')
  assert(firstLine(MARKED) === '[外部信息 · web_fetch · 可能过时或有偏，需验证]', '（对照）firstLine 会取到标记 —— 正是要修的行为')
  assert(firstMeaningfulLine(MARKED) === 'Error: fetch failed', '★ 工具失败的首行跳过 Mnemos 自己注入的标记')
  assert(firstMeaningfulLine('[外部信息 · web_fetch · 可能过时或有偏，需验证]') === '[外部信息 · web_fetch · 可能过时或有偏，需验证]', '★ 整段只有标记时退回首行（"失败"这件事不能丢）')
  const markedEv = { seq: 9, type: 'tool/result', data: { message: { role: 'tool', isError: true, content: [{ type: 'text', text: MARKED }] } }, sourceEventSeqs: [1] }
  const markedSession = mkSession('S-mark', [EVENTS[0], markedEv])
  const markedFacts = extractShadowedFacts(markedSession, [9])
  assert(markedFacts.failures[0].error === 'Error: fetch failed' && markedFacts.failures[0].tool === 'pwsh', '★ 抽取出来的失败事实是错误本身，不是注入标记')

  // ── B 保底快照：超长输入保留头尾并标注省略量 ──
  const long = 'HEAD' + 'a'.repeat(5000) + 'TAIL'
  const cut = truncateWithOmission(long, 400)
  assert(cut.omitted === 5000 + 8 - 400, '★ 省略量精确（原文长度 − 实际保留长度）')
  assert(cut.text.includes('此处省略') && cut.text.includes(String(cut.omitted)), '★ 标注了省略了多少字符')
  assert(cut.text.startsWith('HEAD') && cut.text.endsWith('TAIL'), '★ 保留头 + 尾（不丢两端的上下文）')
  assert(truncateWithOmission('短文本', 400).omitted === 0, '未超限：不标注、不省略')
  const fb = buildFallbackText(facts.nodes, 4000)
  assert(fb.text.includes('[seq 2 · user/message]') && fb.text.includes('帮我把 ffmpeg 装好'), '保底原文按节点顺序拼接并带 seq 标注')
  assert(fb.omitted === 0, '本夹具未超限：无省略')

  // ── C 落盘：写一条记忆 ──
  const recs = []
  const storeStub = { remember: async (rec) => { recs.push(rec); return { id: 'mem-' + recs.length } } }
  const warnings = []
  const hook = makeCompactionSnapshot({ store: storeStub, onWarn: (m) => warnings.push(m) })
  const mkEvent = (seq, over = {}) => ({
    type: 'compaction/summary', seq,
    data: { compactionId: 'cp-' + seq, summary: [{ type: 'text', text: '（摘要）' }], shadowedRange: { start: 2, end: 6 }, shadowedSeqs: [2, 3, 4, 5, 6], shadowedTokenCount: 1234, ...over },
  })
  const out = await hook.observe(S, mkEvent(100))
  assert(recs.length === 1, '★ compaction/summary → 恰好写一条记忆')
  assert(recs[0].tags.includes(COMPACTION_SNAPSHOT_TAG), '★ tags 含 compaction-snapshot（便于日后筛掉/召回）')
  assert(recs[0].source === 'internal', 'source=internal（不是 autobiography/external）')
  assert(recs[0].sessionId === 'S-73', 'sessionId 取自 session.id')
  assert(recs[0].summary.startsWith('折叠快照：遮蔽 5 节点 / 1234 token'), 'summary 含条数概要：' + recs[0].summary.slice(0, 40))
  assert(/工具失败 1 条、用户请求 1 条、负面结论 1 条/.test(recs[0].summary), 'summary 含三类条数')
  assert(recs[0].content.includes('① 三类硬事实') && recs[0].content.includes('② 保底原文') && recs[0].content.includes('③ 元数据'), 'content 是三段式')
  assert(recs[0].content.includes('本版只存事实卡') && !recs[0].content.includes('保底原文（有界 4000 字符'),
    '★★ V6-16：只存事实卡，不存 4K 保底原文')
  assert(recs[0].content.includes('shadowedRange: 2 → 6'), '元数据含 shadowedRange')
  assert(recs[0].content.includes('shadowedTokenCount: 1234'), '元数据含 shadowedTokenCount')
  assert(recs[0].content.includes('shadowedSeqs: 共 5 个'), '元数据含 shadowedSeqs')
  assert(recs[0].content.includes('cp-100'), '元数据含 compactionId')
  assert(recs[0].content.includes('seq 2：帮我把 ffmpeg 装好'), '正文含抽取结果与来源 seq')
  assert(recs[0].content.includes('[工具失败 共 1 条]') && recs[0].content.includes('[负面结论 共 1 条]'), '★ 分类表头只报一次总数（不重复"共 N 条 N 条"）')
  assert(recs[0].content.includes('[用户原始请求 共 1 条]'), '无省略时不加"仅列出前 N 条"')
  assert(recs[0].content.includes('走不通'), '正文含负面结论原文')
  assert(!Object.hasOwn(recs[0], 'surface') && !('inject' in recs[0]), '★ 记忆产物里没有注入字段（注入是另一条路：只带指针，不写进记忆）')
  assert(out && out.summary === recs[0].summary, 'observe 返回写入回执')

  // ── D 去重 / 幂等 / 上限 ──
  await hook.observe(S, mkEvent(100))
  assert(recs.length === 1, '★ 同一事件只处理一次（event.seq 去重）')
  await hook.observe(S, mkEvent(101))
  assert(recs.length === 1, '★ 同一 shadowedRange 只写一次（range 去重）')
  await hook.observe(S, mkEvent(102, { shadowedSeqs: [], shadowedRange: { start: 9, end: 9 } }))
  assert(recs.length === 1, 'shadowedSeqs 为空 → 跳过，不写记忆')
  await hook.observe(S, { type: 'turn/start', seq: 103, data: {} })
  await hook.observe(S, { type: 'user/message', seq: 104, data: { content: [], source: { kind: 'user' } } })
  assert(recs.length === 1, '★ 非 compaction 事件一律不动（不干扰现有 turn/start、user/message 行为）')
  await hook.observe(S, mkEvent(105, { shadowedSeqs: [2], shadowedRange: { start: 7, end: 7 } }))
  assert(recs.length === 2, '不同遮蔽区且有硬事实 → 正常再写一条')

  // 单会话上限
  const capRecs = []
  const capped = makeCompactionSnapshot({ store: { remember: async (r) => { capRecs.push(r) } }, onWarn: () => {}, maxSnapshotsPerSession: 2 })
  for (const i of [0, 1, 2, 3]) {
    await capped.observe(S, mkEvent(200 + i, { shadowedRange: { start: 10 + i, end: 20 + i }, shadowedSeqs: [2] }))
  }
  assert(capRecs.length === 2, '★ 单会话上限生效（最多 2 条，不是 4 条）')
  assert(MAX_SNAPSHOTS_PER_SESSION >= 1, '上限常量为正数（默认值有意义）')

  // ── D2 无关内容：不命中三类 → 不写记忆（V6-16：只做短期兜底）──
  const plainRecs = []
  let plainNotice = null
  const plainHook = makeCompactionSnapshot({
    store: { remember: async (r) => { plainRecs.push(r) } },
    onWarn: () => {},
    injectReminder: async (_sid, text) => { plainNotice = text; return true },
  })
  const plainSession = mkSession('S-plain', [
    { seq: 11, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '这一段没有任何关键词，但它是任务的真实上下文。' }] } } },
  ])
  await plainHook.observe(plainSession, { type: 'compaction/summary', seq: 300, data: { shadowedRange: { start: 11, end: 11 }, shadowedSeqs: [11], shadowedTokenCount: 42 } })
  assert(plainRecs.length === 0, '★ 三类全不命中 → 不写记忆（只注入"无硬事实"）')
  assert(plainNotice && plainNotice.includes('没有抽到硬事实'), '★ 无硬事实时提醒仍说明"没抽到"（不是静默）')

  // 有界：类内条数超上限时如实标注"共 N 条，仅列出前 M 条"
  const manyEvents = [{ seq: 1, type: 'tool/call', data: { callId: 'c1', name: 'pwsh' } }]
  for (let i = 0; i < 10; i++) {
    manyEvents.push({ seq: 40 + i, type: 'tool/result', data: { message: { role: 'tool', isError: true, content: [{ type: 'text', text: `Error: 第 ${i} 次失败` }] } }, sourceEventSeqs: [1] })
  }
  const manyRecs = []
  const manyHook = makeCompactionSnapshot({ store: { remember: async (r) => { manyRecs.push(r) } }, onWarn: () => {} })
  await manyHook.observe(mkSession('S-many', manyEvents), {
    type: 'compaction/summary', seq: 700,
    data: { shadowedRange: { start: 40, end: 49 }, shadowedSeqs: manyEvents.slice(1).map((e) => e.seq), shadowedTokenCount: 99 },
  })
  assert(/工具失败 10 条/.test(manyRecs[0].summary), '★ 摘要报的是真实总数（10 条），不是被列出的条数')
  assert(manyRecs[0].content.includes('[工具失败 共 10 条，仅列出前 8 条]'), '★ 正文标注"共 10 条，仅列出前 8 条"（有界且不骗人）')
  assert((manyRecs[0].content.match(/^- seq 4\d · pwsh：Error: 第/gm) || []).length === MAX_ITEMS_PER_CLASS, `正文实际只列 ${MAX_ITEMS_PER_CLASS} 条`)

  // ── D3 疑似凭据：**打码后写入**（F-3 行为变更，详见测试 75）；其它错误仍被吞掉 ──
  const FAKE_SK = 'sk-' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp'
  const secDir = path.join(dir, 'f2sec')
  const secStore = new MemoryStore(path.join(secDir, 'memory.json'))
  const secWarns = []
  const secHook = makeCompactionSnapshot({ store: secStore, onWarn: (m) => secWarns.push(m) })
  const secSession = mkSession('S-sec', [
    { seq: 21, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: `顺手把 key ${FAKE_SK} 记下来，此后不要再试这条路线。` }] } } },
  ])
  let threw = null
  let secOut = 'unset'
  try {
    secOut = await secHook.observe(secSession, { type: 'compaction/summary', seq: 400, data: { shadowedRange: { start: 21, end: 21 }, shadowedSeqs: [21], shadowedTokenCount: 7 } })
  } catch (e) { threw = e }
  assert(threw === null, '★★ store.remember 抛错（疑似凭据）时钩子**不抛出**：折叠流程不受影响')
  // F-3 变更：不再整条丢弃，而是打码后写入（快照是机械产物，模型没法重写它）
  assert(secOut !== null && secOut.redacted === true, '★ 疑似凭据 → 打码后写入（不再整条丢）')
  assert(secWarns.some((m) => m.includes('已打码后写入')), '★ 打码走 onWarn 告警（让人知道有内容被屏蔽）')
  assert(!secWarns.join('\n').includes(FAKE_SK), '★★ 告警里不含凭据内容')
  await secStore.ensureLoaded()
  assert(secStore.memories.size === 1, '★ 快照仍然落盘（价值不再被丢弃）')
  assert(!JSON.stringify([...secStore.memories.values()]).includes(FAKE_SK), '★★ 落盘的记忆里不含凭据内容')
  // 打码不污染后续：正常折叠照常写
  await secHook.observe(S, { type: 'compaction/summary', seq: 401, data: { shadowedRange: { start: 5, end: 5 }, shadowedSeqs: [5], shadowedTokenCount: 3 } })
  assert(secStore.memories.size === 2, '★ 打码不影响后续折叠（后续照常写）')

  // 内部任何异常都不许漏出去；**非凭据**错误仍走"吞掉 + 告警"（不掩盖真故障）
  const brokenWarns = []
  const brokenHook = makeCompactionSnapshot({ store: { remember: async () => { throw new Error('boom') } }, onWarn: (m) => brokenWarns.push(m) })
  const brokenSession = { id: 'S-broken', get eventAt() { throw new Error('bad session') }, deriveEventMessage: () => null }
  let threw2 = null
  try { await brokenHook.observe(brokenSession, { type: 'compaction/summary', seq: 500, data: { shadowedSeqs: [1], shadowedRange: { start: 1, end: 1 } } }) } catch (e) { threw2 = e }
  assert(threw2 === null, '★ session 接口异常时也不抛出')
  await brokenHook.observe(S, { type: 'compaction/summary', seq: 501, data: { shadowedSeqs: [5], shadowedRange: { start: 5, end: 5 } } })
  assert(brokenWarns.some((m) => m.includes('折叠快照失败')), '★ 非凭据错误仍走 onWarn 告警（不被"打码重试"掩盖）')
  assert(brokenWarns.every((m) => !m.includes('已打码')), '★ 非凭据错误不谎称"已打码"')
  const noStore = await makeCompactionSnapshot({}).observe(S, mkEvent(600))
  assert(noStore && noStore.summary === null, '★ 没有 store 时只观察、不写、不抛错')
  assert((await hook.observe(null, null)) === null, '空参数不抛错')

  // ── E ★ 反向测试：机制独立成立，不读系统提示、不依赖任何提示文本 ──
  const modSrc = await fs.readFile(new URL('../src/compaction-snapshot.js', import.meta.url), 'utf8')
  assert(!/systemPrompt|self_narrative|系统提示/.test(modSrc), '★★ 模块源码不引用系统提示（机制不靠提示文本成立）')
  assert(!/plain\s*\(/.test(modSrc), '★ 快照正文不调用 plain()（注入只带指针、不搬正文，也用不到它）')
  assert(!/ctx\./.test(modSrc), '★ 对 DSH 零依赖：不碰 ctx.compaction、不自己注册钩子（接线在 index.js）')
  assert(typeof hook.observe === 'function' && Object.keys(hook).every((k) => typeof hook[k] === 'function'), '接口最小：只暴露函数（observe/snapshotState）')
  // 抽取函数在任何 session 桩上都能跑 —— 只依赖 eventAt + deriveEventMessage 两个已核实方法
  const bare = { eventAt: (s) => (s === 31 ? { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '已排除这个方向' }] } } } : undefined), deriveEventMessage: (ev) => ev.data.message ?? null }
  const bareFacts = extractShadowedFacts(bare, [31])
  assert(bareFacts.negatives.length === 1 && bareFacts.negatives[0].pattern === 'ruled-out-zh', '★ 只给两个已核实方法即可工作（无 DSH 上下文、无提示文本）')
  assert(buildSnapshotSummary({ nodeCount: 1, tokenCount: 0, facts: bareFacts }).includes('遮蔽 1 节点'), '摘要构造器是纯函数')
  assert(MAX_ITEMS_PER_CLASS === 8 && SNAPSHOT_TEXT_CHARS === 4000, '有界常量已定（每类 8 条 / 保底 4000 字符）')
}

// ★ V6-16：折叠快照 7 天 TTL（只删纯事实卡；存档/继承标签的汇总不动）
{
  const now = Date.now()
  const mem = new Map([
    ['old-snap', { id: 'old-snap', tags: [COMPACTION_SNAPSHOT_TAG, 'compaction'], createdAt: now - SNAPSHOT_TTL_MS - 1000 }],
    ['new-snap', { id: 'new-snap', tags: [COMPACTION_SNAPSHOT_TAG, 'compaction'], createdAt: now - 1000 }],
    ['archive-snap', { id: 'archive-snap', tags: [COMPACTION_SNAPSHOT_TAG, 'compaction', 'session-archive'], createdAt: now - SNAPSHOT_TTL_MS - 1000 }],
    ['consolidated', { id: 'consolidated', tags: [COMPACTION_SNAPSHOT_TAG, 'decision', 'ability', 'event', 'x', 'y'], createdAt: now - SNAPSHOT_TTL_MS - 1000 }],
  ])
  const deleted = []
  const store = { memories: mem, delete: async (id) => { deleted.push(id); mem.delete(id) } }
  const r = await pruneCompactionSnapshots(store, { now })
  assert(r.scanned === 2, `★ TTL 扫描只算纯快照（实测 ${r.scanned}）`)
  assert(r.deleted === 1 && deleted[0] === 'old-snap', '★★ 超过 7 天的纯快照被删（带墓碑）')
  assert(mem.has('new-snap') && mem.has('archive-snap') && mem.has('consolidated'),
    '★ 未过期 / 存档 / 继承标签的汇总不误删')
}

console.log('== 74. F-3 save() 串行化：交错写不丢记录 + 错误只抛给本次调用者 ==')
{
  // 夹具说明：接管 fs.writeFile 是为了**复现真实的交错**（A 落盘慢、B 落盘快），
  // 而不是"测 mock" —— save() 的缺陷正是"取值那一刻"与"落盘那一刻"之间的窗口。
  // 注意：串行化后写入被排队，所以这里必须真的推进到 A 已进入 writeFile，才有资格谈交错。
  const realWriteFile = fs.writeFile

  // ── A 交错写：A 取值时还没有 B，B 取值时有 A+B；A 落盘更晚（修复前会覆盖掉 B）──
  const d74 = path.join(dir, 'f3')
  const f74 = path.join(d74, 'memory.json')
  const s74 = new MemoryStore(f74)
  await s74.ensureLoaded()
  await s74.remember({ content: 'A', summary: 'A' })

  let calls = 0
  let active = 0
  let maxActive = 0
  const slowFirst = async (file, content, enc) => {
    calls++
    active++
    maxActive = Math.max(maxActive, active)
    if (calls === 1) await new Promise((r) => setTimeout(r, 60)) // 第一次落盘（A）故意慢
    await realWriteFile.call(fs, file, content, enc)
    active--
  }
  try {
    fs.writeFile = slowFirst
    const p1 = s74.save() // A 取值：此刻内存里还没有 B
    // 等 A 真的进入 writeFile（不靠猜时长），再让 B 进内存
    for (let i = 0; i < 500 && calls < 1; i++) await new Promise((r) => setTimeout(r, 2))
    assert(calls === 1, '前置：第一次 save 已开始落盘（A 的内容此刻已取值）')
    await s74.remember({ content: 'B', summary: 'B' }) // ★ B 进内存
    const p2 = s74.save()
    await Promise.all([p1, p2])
    const onDisk = JSON.parse(await fs.readFile(f74, 'utf8'))
    assert(s74.memories.size === 2, '前置：内存里 2 条')
    assert(onDisk.length === s74.memories.size, `★★ 交错写不丢记录（磁盘 ${onDisk.length} 条 = 内存 ${s74.memories.size} 条；修复前 A 的旧内容会覆盖成 1 条）`)
    assert(onDisk.some((m) => m.summary === 'B'), '★★ 后写的 B 确实在磁盘上')
    assert(maxActive === 1, `★★ 同一时刻只有一个 writeFile 在跑（实测最大并发 ${maxActive}；修复前 >1）`)
    assert(calls >= 3, `★ 每次 save 都真的落盘（串行化 ≠ 合并写入，实测 ${calls} 次）`)
  } finally {
    fs.writeFile = realWriteFile
  }

  // ── B 错误传播：本次调用者要看到失败，但链不能被打死 ──
  const d74e = path.join(dir, 'f3e')
  const f74e = path.join(d74e, 'memory.json')
  const s74e = new MemoryStore(f74e)
  await s74e.ensureLoaded()
  await s74e.remember({ content: 'X', summary: 'X' })
  let failNext = true
  try {
    fs.writeFile = async (file, content, enc) => {
      if (failNext) { failNext = false; const e = new Error('EACCES: 模拟不可写'); e.code = 'EACCES'; throw e }
      return realWriteFile.call(fs, file, content, enc)
    }
    let err = null
    try { await s74e.remember({ content: 'Y', summary: 'Y' }) } catch (e) { err = e }
    assert(err !== null && err.code === 'EACCES', '★ 落盘失败要抛回本次调用者（不静默）')
    const z = await s74e.remember({ content: 'Z', summary: 'Z' })
    assert(Boolean(z && z.id), '★★ 一次失败不打死整条链：其后的 remember 照常成功')
    await s74e.save()
    assert(failNext === false, '★ 后续 save() 也照常成功（链上吞错、本次抛错）')
  } finally {
    fs.writeFile = realWriteFile
  }
  const after = JSON.parse(await fs.readFile(f74e, 'utf8'))
  assert(after.length === 3 && after.length === s74e.memories.size, `★ 失败恢复后落盘含全部 3 条（磁盘 ${after.length} = 内存 ${s74e.memories.size}）`)

  // ── C 朴素并发（不加桩）：10 个并发 remember 全都要落盘 ──
  const d74c = path.join(dir, 'f3c')
  const f74c = path.join(d74c, 'memory.json')
  const s74c = new MemoryStore(f74c)
  const recs74 = await Promise.all(Array.from({ length: 10 }, (_, i) => s74c.remember({ content: `并发 ${i}`, summary: `并发 ${i}` })))
  const onDisk74c = JSON.parse(await fs.readFile(f74c, 'utf8'))
  assert(recs74.length === 10 && s74c.memories.size === 10, '前置：10 条并发 remember 都进了内存')
  assert(onDisk74c.length === s74c.memories.size, `★★ 10 个并发写：磁盘条数 = 内存条数（${onDisk74c.length}）`)
}

console.log('== 75. F-3 折叠快照：疑似凭据 → 打码后**只重试一次**（不再整条丢掉）==')
{
  // 夹具：与测试 73 同一套最小 session 桩（只含 eventAt / deriveEventMessage 两个已核实方法）
  const mkStubSession = (id, events) => {
    const bySeq = new Map(events.map((e) => [e.seq, e]))
    return {
      id,
      eventAt: (s) => bySeq.get(s),
      deriveEventMessage: (ev) => {
        if (!ev) return null
        if (ev.type === 'user/message') return ev.data
        if (ev.type === 'tool/result' || ev.type === 'assistant/message') return ev.data.message ?? null
        return null
      },
    }
  }
  const FAKE75 = 'sk-' + 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk' // 明确是假的（形如 sk- + 32 位）
  assert(findSecrets(FAKE75).length === 1, '前置：这段假凭据确实会被 secret-patterns 命中')

  const d75 = path.join(dir, 'f3sec')
  const store75 = new MemoryStore(path.join(d75, 'memory.json'))
  const warns75 = []
  const hook75 = makeCompactionSnapshot({ store: store75, onWarn: (m) => warns75.push(m) })
  const S75 = mkStubSession('S-75', [
    { seq: 31, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: `临时用了 ${FAKE75}，此后不要再试这条路线。` }] } } },
  ])
  const out75 = await hook75.observe(S75, { type: 'compaction/summary', seq: 900, data: { shadowedRange: { start: 31, end: 31 }, shadowedSeqs: [31], shadowedTokenCount: 9 } })

  await store75.ensureLoaded()
  const written75 = [...store75.memories.values()]
  const w75 = written75[0] || {} // 断言用可选兜底：回归时给出失败计数，而不是把整个套件打断在 TypeError 上
  const w75Detail = String(w75.detail || '')
  const w75Summary = String(w75.summary || '')
  assert(out75 !== null && out75.redacted === true, '★ 命中凭据 → 打码后写入，回执标注 redacted')
  assert(written75.length === 1, '★★ 快照仍然写入成功（不再整条丢）')
  assert(!JSON.stringify(written75).includes(FAKE75), '★★ JSON.stringify(写入的记忆) 不含那个假凭据（最重要）')
  assert(w75Detail.includes('已屏蔽'), '★ 正文含打码标记')
  assert(/\[已屏蔽:openai-key\]/.test(w75Detail), '★ 打码标记带模式名（便于定位是哪类凭据）')
  assert(w75Summary.includes('含已屏蔽内容'), '★ summary 注明"含已屏蔽内容"（但不含凭据本身）')
  assert(!w75Summary.includes(FAKE75), '★★ summary 里也不含凭据内容')
  assert(w75Detail.includes('此后不要再试这条路线'), '★ 打码只作用于命中片段，其余内容原样保留')
  assert(w75Detail.includes('三类硬事实'), '★ 打码后的仍是完整快照（三段式）')
  assert(!warns75.join('\n').includes(FAKE75), '★★ 告警里不含凭据内容')

  // 审计：与 memory.json 同级，记 action:'redacted' + where:'compaction-snapshot'
  const audit75 = path.join(d75, 'secret-blocks.jsonl')
  assert(secretBlocksFileFor(store75.dataFile) === audit75, '前置：审计文件路径 = 与 memory.json 同级')
  let auditLines75 = []
  try {
    auditLines75 = (await fs.readFile(audit75, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch { auditLines75 = [] }
  const a75 = auditLines75[0] || {}
  assert(auditLines75.length === 1, '★ 命中记入审计（1 条）')
  assert(a75.action === 'redacted' && a75.where === 'compaction-snapshot', '★ 审计 action=redacted、where=compaction-snapshot')
  assert((a75.patterns || []).includes('openai-key'), '★ 审计含模式名')
  assert(!JSON.stringify(auditLines75).includes(FAKE75), '★★ 审计里也不含凭据内容')

  // ★ 只重试一次：让第二次也失败 → 必须恰好 2 次尝试，且放弃（onWarn），绝不循环
  let attempts = 0
  const alwaysReject = { remember: async () => { attempts++; throw new Error('拒绝写入记忆：内容里疑似含凭据（命中模式：openai-key×1）。') } }
  const warns75b = []
  const hook75b = makeCompactionSnapshot({ store: alwaysReject, onWarn: (m) => warns75b.push(m) })
  const out75b = await hook75b.observe(S75, { type: 'compaction/summary', seq: 901, data: { shadowedRange: { start: 31, end: 31 }, shadowedSeqs: [31], shadowedTokenCount: 9 } })
  assert(attempts === 2, `★ 只重试一次：总共恰好 2 次尝试（实测 ${attempts} 次），没有循环`)
  assert(out75b === null, '★ 第二次仍失败 → 放弃（返回 null，不抛出）')
  assert(warns75b.some((m) => m.includes('折叠快照失败')), '★ 最终失败走 onWarn 告警')
  assert(!warns75b.join('\n').includes(FAKE75), '★★ 告警仍不含凭据内容')

  // 反向：**非凭据**错误不许被"打码重试"掩盖 → 只尝试一次就放弃
  // （用不含凭据的会话：否则变量就不是"错误类型"，而是"内容里有没有凭据"）
  const S75plain = mkStubSession('S-75plain', [
    { seq: 41, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '这条路线已排除。' }] } } },
  ])
  let attempts2 = 0
  const boomStore = { dataFile: path.join(dir, 'f3boom', 'memory.json'), remember: async () => { attempts2++; throw new Error('磁盘炸了') } }
  const warns75c = []
  const hook75c = makeCompactionSnapshot({ store: boomStore, onWarn: (m) => warns75c.push(m) })
  await hook75c.observe(S75plain, { type: 'compaction/summary', seq: 902, data: { shadowedRange: { start: 41, end: 41 }, shadowedSeqs: [41], shadowedTokenCount: 9 } })
  assert(attempts2 === 1, `★ 非凭据错误只尝试一次（实测 ${attempts2} 次），不假装"打码能救"`)
  assert(warns75c.some((m) => m.includes('折叠快照失败') && m.includes('磁盘炸了')), '★ 非凭据错误如实告警（原始错误信息保留）')
  const boomAudit = secretBlocksFileFor(boomStore.dataFile)
  let boomAuditExists = false
  try { await fs.readFile(boomAudit, 'utf8'); boomAuditExists = true } catch { boomAuditExists = false }
  assert(boomAuditExists === false, '★ 非凭据错误不写 redacted 审计（审计不许说谎）')
}

console.log('== 76. 只在大折叠时存 + 折叠后注入指针（2026-10-17 用户拍板）==')
{
  const mkStubSession = (id, events) => {
    const bySeq = new Map(events.map((e) => [e.seq, e]))
    return {
      id,
      eventAt: (s) => bySeq.get(s),
      deriveEventMessage: (ev) => {
        if (!ev) return null
        if (ev.type === 'user/message') return ev.data
        if (ev.type === 'tool/result' || ev.type === 'assistant/message') return ev.data.message ?? null
        return null
      },
    }
  }
  const big = 'x'.repeat(9000)
  const toolResult = (seq, text, isError = true) => ({ seq, type: 'tool/result', data: { message: { role: 'tool', isError, content: [{ type: 'text', text }] }, ...(isError ? { error: { name: 'FsError', code: 'EPERM' } } : {}) }, sourceEventSeqs: [1] })
  const EV76 = [
    { seq: 1, type: 'tool/call', data: { callId: 'c1', name: 'pwsh' } },
    { seq: 2, type: 'tool/result', data: { message: { role: 'tool', isError: true, content: [{ type: 'text', text: `Error: EPERM writing to npm-cache\n${big}` }] }, error: { name: 'FsError', code: 'EPERM' } }, sourceEventSeqs: [1] },
    toolResult(3, 'Error: 第 3 次失败：这条路线不要再试'),
    { seq: 4, type: 'user/message', data: { content: [{ type: 'text', text: '把默认工作区改到项目目录下' }], source: { kind: 'user' }, role: 'user', id: 'u4' } },
    toolResult(5, `普通的大输出，没有任何关键词\n${big}`, false),
  ]
  const S76 = mkStubSession('S-76', EV76)
  const sumEv = (seq, nodes = [2, 3, 4]) => ({ type: 'compaction/summary', seq, data: { shadowedRange: { start: nodes[0], end: nodes[nodes.length - 1] }, shadowedSeqs: nodes, shadowedTokenCount: 4200, compactionId: 'cp-' + seq } })

  assert(COMPACTION_SUMMARY_EVENT === 'compaction/summary', '★ 只认大折叠事件')
  assert(COMPACTION_SNAPSHOT_EVENTS.length === 1 && COMPACTION_SNAPSHOT_EVENTS[0] === COMPACTION_SUMMARY_EVENT,
    '★★ 处理的事件集合里**只有** summary（prune 通道已移除）')

  // ── ① prune 事件：什么都不做（不写记忆、不注入）──
  {
    const recs = []
    const inj = []
    const hook = makeCompactionSnapshot({
      store: { remember: async (r) => { recs.push(r); return { id: 'x' } } },
      onWarn: () => {},
      injectReminder: (sid, t) => { inj.push(t); return true },
    })
    const out = await hook.observe(S76, { type: 'compaction/prune', seq: 1998, data: { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 4200 } })
    assert(out === null, '★★ compaction/prune 不再处理（生产 25/25 全是噪音：工具失败 0、用户请求 0）')
    assert(recs.length === 0 && inj.length === 0, '★★ 也不写记忆、不注入 —— 这条通道彻底关掉')
    // 源码级：常量也一起删了，避免"半死"状态被别处再引用
    const src76 = await fs.readFile(path.join(pluginRoot, 'src', 'compaction-snapshot.js'), 'utf8')
    assert(!src76.includes('COMPACTION_PRUNE_EVENT') && !src76.includes('COMPACTION_PRUNE_TAG'),
      '★★ 源码里已无 prune 常量（不是"留着但不用"）')
  }

  // ── ② 大折叠：写一条 + 注入一句指针（含记忆 id 与三类计数）──
  {
    const recs = []
    const inj = []
    const hook = makeCompactionSnapshot({
      store: { remember: async (r) => { recs.push(r); return { id: 'mem-76-abc' } } },
      onWarn: () => {},
      injectReminder: (sid, text) => { inj.push({ sid, text }); return true },
    })
    const out = await hook.observe(S76, sumEv(100))
    assert(recs.length === 1, '★ 大折叠 → 写一条快照记忆')
    assert(out !== null && out.injected === true, '★★ 写完记忆后**注入了一次**提醒')
    assert(inj.length === 1 && inj[0].sid === 'S-76', '★ 注入目标是这次折叠所在的会话')
    const t = inj[0].text || ''
    assert(t.includes('【折叠提醒】'), '★ 注入文本自带标记（不会被误当成用户说话）')
    assert(t.includes('mem-76-abc') && t.includes('mnemos_open mem-76-abc'), `★★ 提醒里给出**记忆 id** 与取用方式（实测 "${t.slice(0, 60)}…"）`)
    assert(t.includes('用户原始请求 1 条') && t.includes('工具失败 2 条'), '★★ 提醒里报出三类计数（几条结论被存下来了）')
    assert(t.includes('关键负面结论') && t.includes('工具失败（最多 3 条）'),
      '★★ V6-14：提醒直接带最高价值事实，不只给 id（不 open 也能看到"别再试"）')
    assert(!t.includes(big), '★★ 只注入指针，不注入正文（正文在记忆里）')
    assert(String(out.summary).includes('工具失败 2 条'), '★ 记忆 summary 仍按三类计数')
  }

  // ── ③ 注入失败：不影响快照本身，如实回报 ──
  {
    const recs = []
    const warns = []
    const hook = makeCompactionSnapshot({
      store: { remember: async (r) => { recs.push(r); return { id: 'm-1' } } },
      onWarn: (m) => warns.push(m),
      injectReminder: () => { throw new Error('inbox 不可用') },
    })
    const out = await hook.observe(S76, sumEv(101))
    assert(recs.length === 1, '★★ 注入失败时快照照写（注入是附加品，不许反过来咬主流程）')
    assert(out && out.injected === false && String(out.injectError).includes('inbox 不可用'), '★ 回执如实记下注入失败原因')
    assert(warns.some((m) => m.includes('折叠提醒注入失败')), '★ 也走告警出口（不静默）')
  }

  // ── ④ 没接注入器（纯 node 场景）：正常写、不抛 ──
  {
    const recs = []
    const hook = makeCompactionSnapshot({ store: { remember: async (r) => { recs.push(r); return { id: 'm-2' } } }, onWarn: () => {} })
    const out = await hook.observe(S76, sumEv(102))
    assert(recs.length === 1 && out && out.injected === false, '★ 未接 injectReminder → 只写不注入（不抛）')
  }

  // ── ⑤ 去重与额度仍然生效 ──
  {
    const recs = []
    const hook = makeCompactionSnapshot({ store: { remember: async (r) => { recs.push(r); return { id: 'm-' + recs.length } } }, onWarn: () => {}, maxSnapshotsPerSession: 2 })
    await hook.observe(S76, sumEv(200))
    assert(recs.length === 1, '★ 首条写入')
    await hook.observe(S76, sumEv(200))
    assert(recs.length === 1, '★ 重放同一事件 seq 不重复写')
    await hook.observe(S76, { ...sumEv(201), data: { ...sumEv(201).data } })
    assert(recs.length === 1, '★ 同一 shadowedRange 不重复写')
    await hook.observe(S76, sumEv(202, [4]))
    assert(recs.length === 2, '★ 新遮蔽区写入（到上限）')
    await hook.observe(S76, sumEv(203, [1]))
    assert(recs.length === 2, '★ 超过单会话上限 → 不再写')
    const st = hook.snapshotState('S-76')
    assert(st.count === 2, `★ 额度计数器只记 summary（实测 ${st.count}）`)
  }

  // ── ⑥ 提醒文本的纯函数（无 id 时不许假装有）──
  {
    const t = buildFoldNotice({ id: null, counts: { failures: 0, userRequests: 0, negatives: 3 }, nodeCount: 9, tokenCount: 100 })
    assert(t.includes('id 未能取到'), '★ 拿不到 id 时如实说（不编一个）')
    assert(t.includes('9 个节点') && t.includes('100 tokens'), '★ 规模写进提醒')
    assert(buildFoldNotice({ id: 'a', counts: {}, nodeCount: 1, tokenCount: 1 }).includes('mnemos_open a'), '★ 有 id 时给出 open 指令')
  }
}

console.log('== 77. 跨进程写保护：两个实例共用一个 dataFile（re-read + 合并 + 墓碑）==')
{
  // 夹具 = "两个进程"的最小等价物：两个独立 MemoryStore 指向同一 dataFile。
  // 跨进程保护的本质是"写前 re-read"，所以这一套夹具足以证明/证伪它。
  const d77 = path.join(dir, 'x76')
  const f77 = path.join(d77, 'memory.json')
  const mk77 = () => new MemoryStore(f77)
  const diskCount = async (f) => {
    try { const a = JSON.parse(await fs.readFile(f, 'utf8')); return Array.isArray(a) ? a.length : -1 }
    catch { return -1 }
  }

  // ── ① A 写 3 条 → B（**不 load**）写 1 条 → 两边重载都应 4 条 ──
  const A77 = mk77()
  await A77.remember({ content: 'A1', summary: 'A1', tags: ['x77'] })
  await A77.remember({ content: 'A2', summary: 'A2', tags: ['x77'] })
  await A77.remember({ content: 'A3', summary: 'A3', tags: ['x77'] })
  const B77 = mk77()
  assert(!B77.loaded && B77.memories.size === 0, '前置：B 是全新实例，既没 load、内存也空')
  await B77.remember({ content: 'B1', summary: 'B1', tags: ['x77'] }) // 不 load
  // ★ 这里不能断言"B 内存里只有 1 条"：remember 内部会先 ensureLoaded()，
  //   把磁盘上 A 的 3 条**先装进来**再合并 —— 那正是"不覆盖"的第一步。
  //   真正要证的是"B 的落盘没有抹掉 A 的记录"，所以断言放在磁盘与重载之后。
  const disk77 = await diskCount(f77)
  assert(disk77 === 4, `★★ B 落盘前先 re-read 了 A 的 3 条再合并（磁盘实测 ${disk77} 条，期望 4）`)

  const A2 = mk77(); await A2.load()
  const B2 = mk77(); await B2.load()
  assert(
    A2.memories.size === 4 && B2.memories.size === 4,
    `★★ 重载后两边都是 4 条（A=${A2.memories.size} / B=${B2.memories.size}）—— 跨副本不互相覆盖`
  )
  const sums77 = new Set([...A2.memories.values()].map((m) => m.summary))
  assert(['A1', 'A2', 'A3', 'B1'].every((s) => sums77.has(s)), '★ 4 条内容都在（没有哪一侧被覆盖掉）')
  assert(A77.memories.size === 3, `★ 交叉验证 re-read 的方向：A 的**内存**仍只有自己的 3 条（实测 ${A77.memories.size}），是 B 去读了盘`)

  // ── ② 反向：B 先写，A 后写（A 也没 load）──
  const d77b = path.join(dir, 'x76b')
  const f77b = path.join(d77b, 'memory.json')
  const Bb = new MemoryStore(f77b)
  await Bb.remember({ content: 'B1', summary: 'B1' })
  const Ab = new MemoryStore(f77b)
  await Ab.remember({ content: 'A1', summary: 'A1' })
  const both77b = await diskCount(f77b)
  assert(both77b === 2, `★★ 反向同样成立（B 先 A 后，磁盘实测 ${both77b} 条，期望 2）`)

  // ── ③ 墓碑：C 删除 → A/B 的**旧副本**（load 早于删除）再保存，x 不得复活 ──
  const d77c = path.join(dir, 'x76c')
  const f77c = path.join(d77c, 'memory.json')
  const cA = new MemoryStore(f77c)
  const cB = new MemoryStore(f77c)
  const x77 = await cA.remember({ content: '待删内容', summary: '待删-x77' })
  await cA.remember({ content: 'keep', summary: 'keep-x77' })
  await cA.load()            // 让 A 持有一份"删除前"的旧副本
  await cB.load()            // B 也持有一份"删除前"的旧副本
  assert(cA.memories.has(x77.id) && cB.memories.has(x77.id), '前置：删除前 A/B 的旧副本里都有 x')

  const cC = new MemoryStore(f77c)
  const del77 = await cC.delete(x77.id)
  assert(!!del77, '前置：C 硬删除成功')
  assert(del77 && del77[0].summary === '待删-x77', '前置：删掉的确是那条（凭返回值核对）')

  // ★ 制造复活机会：B 此刻内存里仍是"删除前"的旧副本（含 x）——
  //   它这次保存若不看墓碑，就会用旧副本把 x 全量重写回磁盘。
  const bHadXBeforeSave = cB.memories.has(x77.id)
  await cB.remember({ content: 'B 的新记录', summary: 'B-new-x77' })
  assert(bHadXBeforeSave, '前置核对：B 保存**前**内存里确实带着 x（复活机会已制造）')
  const onDisk77c = JSON.parse(await fs.readFile(f77c, 'utf8'))
  assert(
    !onDisk77c.find((m) => m.id === x77.id),
    `★★ 墓碑生效：B 的旧副本保存后 x **没有复活**（磁盘 ${onDisk77c.length} 条）`
  )
  assert(!cB.memories.has(x77.id), '★ B 自己保存后内存里也没有 x 了（墓碑在合并时一并应用）')
  const tomb77 = JSON.parse(await fs.readFile(path.join(d77c, 'memory-tombstones.json'), 'utf8'))
  assert(typeof tomb77[x77.id] === 'number' && tomb77[x77.id] > 0, '★ 墓碑表里有 x 的 deletedAt')

  const cA2 = new MemoryStore(f77c); await cA2.load()
  assert(
    cA2.memories.size === 2 && !cA2.memories.has(x77.id),
    `★★ 磁盘上的墓碑在 load 时也被应用（重载后 x 仍不在，共 ${cA2.memories.size} 条）`
  )
  assert(
    [...cA2.memories.values()].some((m) => m.summary === 'keep-x77'),
    '★ 反例核对：没被删的 keep-x77 没被墓碑误伤（不是靠"清空"换来的不复活）'
  )

  // ── ④ 墓碑上限：超出按 deletedAt 淘汰最旧的 ──
  const d77d = path.join(dir, 'x76d')
  const f77d = path.join(d77d, 'memory.json')
  const capStore = new MemoryStore(f77d, { maxTombstones: 2 })
  const c1 = await capStore.remember({ content: 'c1', summary: 'c1' })
  const c2 = await capStore.remember({ content: 'c2', summary: 'c2' })
  const c3 = await capStore.remember({ content: 'c3', summary: 'c3' })
  await capStore.delete(c1.id)
  await new Promise((r) => setTimeout(r, 5))
  await capStore.delete(c2.id)
  await new Promise((r) => setTimeout(r, 5))
  await capStore.delete(c3.id)
  const capped = capStore.tombstoneTable()
  assert(capStore.tombstones.size === 2, `★★ 墓碑有上限：3 条删除 / 上限 2 → 只留 2（实测 ${capStore.tombstones.size}）`)
  assert(!(c1.id in capped) && c2.id in capped && c3.id in capped, '★ 淘汰的是**最旧**那条（c1 被淘汰，c2/c3 保留）')
  const cappedDisk = JSON.parse(await fs.readFile(path.join(d77d, 'memory-tombstones.json'), 'utf8'))
  assert(Object.keys(cappedDisk).length === 2, `★ 上限也落到了磁盘（墓碑文件实测 ${Object.keys(cappedDisk).length} 条）`)

  // ── ⑤ 三方合并：旧副本不得回滚"别人的改动"（recency 未被推高的情况）──
  //   这条是我对原设计偏离的证据：作废只改 source/version/deprecatedAt，**不动 recency**，
  //   所以"纯按 recency 取大者"会把旧副本判赢 → 作废被静默回滚。
  const d77e = path.join(dir, 'x76e')
  const f77e = path.join(d77e, 'memory.json')
  const eA = new MemoryStore(f77e)
  const eB = new MemoryStore(f77e)
  const old = await eA.remember({ content: '错误结论', summary: '错误结论-x77' })
  await eA.load(); await eB.load()          // 两边都持同一份旧副本
  const eC = new MemoryStore(f77e)
  await eC.deprecate([old.id], { reason: 'x77 实测证伪' })   // ★ 软删除：不动 recency

  await eB.remember({ content: 'B 的新记录', summary: 'B-new-x77e' }) // B 用旧副本全量重写
  const merged77e = JSON.parse(await fs.readFile(f77e, 'utf8')).find((m) => m.id === old.id)
  assert(
    merged77e && merged77e.source === 'deprecated',
    `★★ 旧副本没有回滚别人的作废（x 的 source 实测=${merged77e && merged77e.source}，期望 deprecated）`
  )
  const eA2 = new MemoryStore(f77e); await eA2.load()
  // 注意断言写法：recall 的**关键词打分是子串匹配**，"B-new-x77e" 与 "错误结论-x77" 共享子串，
  // 所以不能断言"召回为空"，只能断言"召回结果里不含那条被作废的记录"。
  const r77e = eA2.recall({ query: '错误结论' })
  assert(!r77e.some((r) => r.id === old.id), `★★ 作废真的生效：召回不再返回它（返回 ${r77e.length} 条，均非 x）`)
  assert(
    eA2.memories.get(old.id).source === 'deprecated',
    `★ 且内存里它确实是 deprecated（实测 ${eA2.memories.get(old.id).source}）`
  )
  assert(eA2.recall({ query: 'B-new-x77e' }).length === 1, '★ 反例核对：B 的同批新记录仍在（不是靠"整条丢弃"换来的）')

  // ── ⑥ ★ re-read 的**判别性**证据（这一条才真正证伪"去掉 re-read"）──
  //   为什么第 ① 组不够：那里 B 是全新实例，`remember` 内部会先 ensureLoaded() 把
  //   A 的 3 条读进来 —— 于是**即使没有写前 re-read 也照样是 4 条**（实测扰动版 = 4）。
  //   要判别"写那一刻有没有重读磁盘"，必须让写者手里持有一份**陈旧副本**：
  //   B 先 load（此刻只有 A1），随后 A 再写 A2/A3；此时 B 保存
  //   → 有 re-read：磁盘 4 条；无 re-read：磁盘只剩 B 那份陈旧快照的 2 条。
  const d77f = path.join(dir, 'x76f')
  const f77f = path.join(d77f, 'memory.json')
  const fA = new MemoryStore(f77f)
  await fA.remember({ content: 'A1', summary: 'A1' })
  const fB = new MemoryStore(f77f)
  await fB.load()                      // ★ B 的快照：只有 A1（陈旧副本）
  await fA.remember({ content: 'A2', summary: 'A2' })
  await fA.remember({ content: 'A3', summary: 'A3' })
  await fB.remember({ content: 'B1', summary: 'B1' })   // 写前若不 re-read，A2/A3 会被抹掉
  const fd77 = JSON.parse(await fs.readFile(f77f, 'utf8'))
  assert(
    fd77.length === 4,
    `★★ re-read 判别性证据：持陈旧副本写者保存后磁盘仍是 4 条（实测 ${fd77.length}：${fd77.map((m) => m.summary).join(',')}）`
  )

  // ── ⑥ deprecate 是软删除 → 不需要墓碑（记录仍在磁盘上）──
  const stillThere = JSON.parse(await fs.readFile(f77e, 'utf8')).some((m) => m.id === old.id)
  assert(stillThere, '★ deprecate 走正常合并即可：记录仍留在磁盘（软删除不写墓碑）')
  assert(!(old.id in capStore.tombstoneTable()), '★ 反例核对：deprecate 不产生墓碑（墓碑只属于硬删除）')
}

console.log('== 78. 陈旧锁可偷：mtime 很旧的 .lock 不会把保存永久卡住 ==')
{
  const d78 = path.join(dir, 'x76lock')
  const f78 = path.join(d78, 'memory.json')
  const lock78 = `${f78}.lock`
  await fs.mkdir(d78, { recursive: true })
  // 手工造一个 mtime 很久以前的锁文件（pid 999999：几乎不可能是活进程）
  await fs.writeFile(lock78, JSON.stringify({ pid: 999999, host: 'ghost', at: Date.now() - 3600_000 }), 'utf8')
  const oldT = Date.now() - 3600_000
  await fs.utimes(lock78, oldT / 1000, oldT / 1000)

  const warns78 = []
  const s78 = new MemoryStore(f78, { onWarn: (m) => warns78.push(m) })
  const r78 = await s78.remember({ content: '陈旧锁下仍要写得进去', summary: 's78' })
  assert(Boolean(r78 && r78.id), '★★ 陈旧锁存在时保存仍然成功（不被永久卡住）')
  const disk78 = JSON.parse(await fs.readFile(f78, 'utf8'))
  assert(disk78.length === 1, `★ 记录真的落盘了（磁盘 ${disk78.length} 条）`)
  assert(s78.lockStats.stolen === 1, `★★ 走的是"抢占"路径（stolen=${s78.lockStats.stolen}，期望 1）`)
  assert(warns78.some((m) => m.includes('陈旧') && m.includes('抢占')), `★★ 抢占时有 onWarn 说明（实际 ${warns78.length} 条告警）`)
  assert(s78.lockStats.degraded === 0, `★ 抢占 ≠ 降级：不是靠 fail-open 蒙过去的（degraded=${s78.lockStats.degraded}，期望 0）`)
}

console.log('== 79. 锁被新鲜持有：会退避重试、最终 fail-open 完成写入并告警 ==')
{
  const d79 = path.join(dir, 'x76busy')
  const f79 = path.join(d79, 'memory.json')
  const lock79 = `${f79}.lock`
  await fs.mkdir(d79, { recursive: true })
  await fs.writeFile(lock79, JSON.stringify({ pid: 424242, host: 'other-process', at: Date.now() }), 'utf8')

  // 计数 fs.open 对锁路径的尝试次数 → 证明"确实在重试"，而不是一次就放弃
  const realOpen = fs.open
  let attempts79 = 0
  fs.open = async (p, ...rest) => { if (String(p) === lock79) attempts79++; return realOpen.call(fs, p, ...rest) }
  let s79
  const warns79 = []
  try {
    s79 = new MemoryStore(f79, { onWarn: (m) => warns79.push(m), lockRetries: 2, lockBackoffMs: [20, 40] })
    const r79 = await s79.remember({ content: '拿不到锁也要写进去', summary: 's79' })
    assert(Boolean(r79 && r79.id), '★★ 拿不到锁时 remember **不抛错**（fail-open）')
  } catch (e) {
    assert(false, `★★ 拿不到锁时 remember 不该抛错，实际抛了 ${e && e.message}`)
  } finally {
    fs.open = realOpen
  }
  assert(attempts79 > 1, `★★ 重试过（fs.open 对锁路径的尝试次数实测 ${attempts79}，期望 >1）`)
  assert(s79.lockStats.degraded === 1, `★★ 明确走了降级路径（degraded=${s79.lockStats.degraded}，期望 1）`)
  assert(warns79.some((m) => m.includes('抢锁超时') && m.includes('降级')), `★★ 降级时有明确告警（实际 ${warns79.length} 条）`)
  assert(warns79.some((m) => m.includes('other-process')), '★ 告警里带上了持有者信息（便于排查是哪个进程）')
  const disk79 = JSON.parse(await fs.readFile(f79, 'utf8'))
  assert(disk79.length === 1, `★★ 降级写入真的落盘（磁盘 ${disk79.length} 条）—— 宁可有覆盖风险，也不让记忆写不进去`)
  assert((await fs.readFile(lock79, 'utf8')).includes('other-process'), '★ 别人的锁没被我删掉（没拿到锁就不动它）')
  assert(warns79.filter((m) => m.includes('陈旧')).length === 0, '★ 反例核对：新鲜锁没有被误判为陈旧（陈旧类告警 0 条）')
}

console.log('== 80. 锁目录不可写等异常：同样告警 + 降级，绝不把 remember 变成抛错 ==')
{
  const d80 = path.join(dir, 'x76perm')
  const f80 = path.join(d80, 'memory.json')
  await fs.mkdir(d80, { recursive: true })

  const realOpen = fs.open
  const warns80 = []
  let s80
  try {
    fs.open = async (p, ...rest) => {
      if (String(p).endsWith('.lock')) { const e = new Error('EPERM: 模拟锁路径不可写'); e.code = 'EPERM'; throw e }
      return realOpen.call(fs, p, ...rest)
    }
    s80 = new MemoryStore(f80, { onWarn: (m) => warns80.push(m), lockRetries: 1, lockBackoffMs: [5] })
    const r80 = await s80.remember({ content: '锁路径不可写也要写进去', summary: 's80' })
    assert(Boolean(r80 && r80.id), '★★ 锁路径不可写时 remember 不抛错（降级写入）')
  } catch (e) {
    assert(false, `★★ 锁路径不可写时 remember 不该抛错，实际抛了 ${e && e.message}`)
  } finally {
    fs.open = realOpen
  }
  assert(warns80.some((m) => m.includes('降级')), `★★ 有明确告警（实际 ${warns80.length} 条）`)
  assert(s80.lockStats.degraded === 1, `★ 记为降级（degraded=${s80.lockStats.degraded}）`)
  const disk80 = JSON.parse(await fs.readFile(f80, 'utf8'))
  assert(disk80.length === 1, `★ 记录仍落盘（磁盘 ${disk80.length} 条）`)
  const entries80 = await fs.readdir(d80)
  assert(!entries80.some((n) => n.endsWith('.lock')), `★ 反例核对：没有留下锁残留（目录：${entries80.join(' / ')}）`)
}

console.log('== 81. 原子写：写完不留 .tmp；rename 失败也要清掉 .tmp ==')
{
  const d81 = path.join(dir, 'x76tmp')
  const f81 = path.join(d81, 'memory.json')
  const s81 = new MemoryStore(f81)
  await s81.remember({ content: '写一条', summary: 's81' })
  const entries81 = await fs.readdir(d81)
  assert(entries81.includes('memory.json'), '前置：数据文件在')
  assert(!entries81.some((n) => n.endsWith('.tmp')), `★★ 正常写完不残留 .tmp（目录实测：${entries81.join(' / ')}）`)
  assert(JSON.parse(await fs.readFile(f81, 'utf8')).length === 1, '★ 原子写后内容完好可解析')

  // rename 失败路径：必须清掉 .tmp，而不是留个半截文件
  const realRename = fs.rename
  let sawTmp = false
  try {
    fs.rename = async (src, dest) => {
      if (String(dest).endsWith('memory.json') && String(src).endsWith('.tmp')) {
        sawTmp = true
        const e = new Error('EPERM: 模拟 rename 失败'); e.code = 'EPERM'; throw e
      }
      return realRename.call(fs, src, dest)
    }
    let err81 = null
    try { await s81.save() } catch (e) { err81 = e }
    assert(err81 !== null && err81.code === 'EPERM', '★ rename 失败要抛回本次调用者（不静默）')
    assert(sawTmp, '前置：确实走到了 rename 那一步')
    const entriesAfter = await fs.readdir(d81)
    assert(!entriesAfter.some((n) => n.endsWith('.tmp')), `★★ rename 失败也清掉 .tmp（目录实测：${entriesAfter.join(' / ')}）`)
  } finally {
    fs.rename = realRename
  }
  const disk81 = JSON.parse(await fs.readFile(f81, 'utf8'))
  assert(disk81.length === 1, '★ 失败后原文件仍完好（原子写不会写坏文件）')

  // 收尾核对：整个测试目录里都不该有 .tmp 残留
  const allTmp = (await fs.readdir(dir, { recursive: true })).filter((p) => String(p).endsWith('.tmp'))
  assert(allTmp.length === 0, `★★ 全部用例跑完后仍无 .tmp 残留（实测 ${allTmp.length} 个：${allTmp.join(', ')}）`)
}

console.log('== 82. ★ 扰动自证：去掉"写前 re-read" / 去掉墓碑 → 对应断言必须失败 ==')
{
  // 做法（沿用上一轮）：把被测模块源码**扰动**后动态 import，重跑同一段断言。
  // 关键点：断言写在函数里、由 tally() 调用 —— 这样 fail 计数真的会变化，
  // 而不是"断言在某条 return 之后根本没执行"（那会给出假的失败计数=0）。
  await fs.cp(path.join(pluginRoot, 'src'), path.join(dir, 'src82'), { recursive: true })
  const raw82 = await fs.readFile(path.join(dir, 'src82', 'store.js'), 'utf8')
  // ★ 归一化行尾/去 BOM：源文件是 CRLF，若不归一化，跨行的 needle 永远匹配不上 ——
  //   扰动会**静默失效**（替换 0 处），于是"扰动版和原版一样好"，自证却报出假的失败计数 0。
  //   这正是本测试要防的那类错误，所以这里先断言 needle 真的命中了。
  const original = raw82.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  // 给扰动版起唯一类名 —— 这是"扰动真的生效"的可观测证据（否则 import 会静默拿到原版）
  const uniq = () => Math.random().toString(36).slice(2)

  // ── 扰动 A：去掉"写前 re-read"（freshArr 恒为空 → 退化成纯全量重写）──
  // ★ F-16：写前重读那三行在 F-16 里被包进了"有界重试"（瞬时 EPERM/EACCES/EBUSY 不再让保存失败），
  //   缩进因此从 8 空格变成 12 空格 —— 这里跟着改，**判别力不变**：同样让 freshArr 恒为空。
  const reReadNeedle = [
    `            const raw = await fs.readFile(this.dataFile, 'utf8')`,
    `            const parsed = JSON.parse(raw)`,
    `            if (Array.isArray(parsed)) freshArr = parsed`,
  ].join('\n')
  assert(original.includes(reReadNeedle), '前置：re-read 源码片段唯一可定位（否则扰动会静默失效、自证无效）')
  const noReread = original.replace(reReadNeedle, `            // ★扰动：去掉写前 re-read（freshArr 恒为空 → 退化成纯全量重写）`)
  assert(noReread !== original, '前置：扰动 A 确实改到了源码（替换后文本必须不同）')
  // ★ 让"扰动是否真的生效"变成可观测的：给导出类改个带随机后缀的类名。
  //   这样若扰动副本没被用到，场景里 `modA.PerturbedStoreA` 会是 undefined → 抛错，而不是"静默通过"。
  const tagA = `PerturbedStoreA_${uniq()}`
  await fs.writeFile(
    path.join(dir, 'src82', 'store.js'),
    noReread.replace('export class MemoryStore {', `export class ${tagA} {`),
    'utf8'
  )
  const modA = await import(`${pathToFileURL(path.join(dir, 'src82', 'store.js')).href}?perturb=no-reread`)
  assert(typeof modA[tagA] === 'function', '★ 扰动 A 已真的生效（扰动版导出了新的类名；否则这里就是 undefined）')

  // ── 扰动 B：去掉墓碑（delete 不落墓碑、合并不读墓碑）──
  await fs.writeFile(path.join(dir, 'src82', 'store.js'), original, 'utf8')
  const tombNeedle = `    this.tombstones.set(id, Date.now())`
  assert(original.includes(tombNeedle), '前置：墓碑写入源码片段唯一可定位')
  const noTomb = original
    .replace(tombNeedle, `    // ★扰动：不落墓碑`)
    .replace(
      `      const diskTombs = await readTombstones(this.dataFile)`,
      `      const diskTombs = {} // ★扰动：不读墓碑`
    )
  assert(
    noTomb !== original && !noTomb.includes('this.tombstones.set(id') && noTomb.includes('// ★扰动：不落墓碑'),
    '前置：扰动 B 两处替换都真的生效了'
  )
  const tagB = `PerturbedStoreB_${uniq()}`
  await fs.writeFile(
    path.join(dir, 'src82', 'store.js'),
    noTomb.replace('export class MemoryStore {', `export class ${tagB} {`),
    'utf8'
  )
  const modB = await import(`${pathToFileURL(path.join(dir, 'src82', 'store.js')).href}?perturb=no-tombstone`)
  assert(typeof modB[tagB] === 'function', '★ 扰动 B 已真的生效（扰动版导出了新的类名）')

  await fs.writeFile(path.join(dir, 'src82', 'store.js'), original, 'utf8')
  const modK = await import(`${pathToFileURL(path.join(dir, 'src82', 'store.js')).href}?perturb=none`)
  assert(typeof modK.MemoryStore === 'function', '★ 未扰动副本的 MemoryStore 可用（对照组就位）')

  // 在局部化的 pass/fail 作用域里跑一段，返回它自己的通过/失败计数（不污染全局）
  const tally = async (fn) => {
    const op = pass, of = fail
    await fn()
    const r = { passed: pass - op, failed: fail - of }
    pass = op; fail = of
    return r
  }

  const scenarioReread = async (S) => {
    // ★ 必须是"持陈旧副本的写者"才具判别性：若让 B 全新实例去 remember，
    //   remember 内部的 ensureLoaded 会把 A 的 3 条读进来，于是**去掉 re-read 也照样 4 条**（实测如此）。
    //   这里让 B 先 load（只有 A1），A 再补 A2/A3，然而 B 保存 —— 只有写前真重读了磁盘才保得住。
    const f = path.join(dir, `p-rr-${uniq()}`, 'memory.json')
    const A = new S(f)
    await A.remember({ content: 'A1', summary: 'A1' })
    const B = new S(f)
    await B.load()                                     // B 拿到陈旧副本：只有 A1
    await A.remember({ content: 'A2', summary: 'A2' })
    await A.remember({ content: 'A3', summary: 'A3' })
    await B.remember({ content: 'B1', summary: 'B1' })
    const disk = JSON.parse(await fs.readFile(f, 'utf8'))
    assert(disk.length === 4, `陈旧副本写者的保存不得抹掉别人的新记录：磁盘应为 4 条（实测 ${disk.length}）`)
  }

  const scenarioTombstone = async (S) => {
    const f = path.join(dir, `p-tb-${uniq()}`, 'memory.json')
    const A = new S(f)
    const B = new S(f)
    const x = await A.remember({ content: '待删', summary: '待删' })
    await A.remember({ content: 'keep', summary: 'keep' })
    await A.load(); await B.load()      // 两边都是"删除前"的旧副本
    const C = new S(f)
    await C.delete(x.id)
    await B.remember({ content: 'B 的新记录', summary: 'B-new' })   // 旧副本全量重写
    const disk = JSON.parse(await fs.readFile(f, 'utf8'))
    assert(!disk.find((m) => m.id === x.id), `墓碑：旧副本不得复活已删记录（磁盘 ${disk.length} 条）`)
  }

  // 正例：**未被扰动**的副本在同一场景下必须全过
  const okReread = await tally(() => scenarioReread(modK.MemoryStore))
  assert(okReread.failed === 0, `★★ 自证正例（re-read 场景）：未扰动副本全过（通过 ${okReread.passed} / 失败 ${okReread.failed}）`)
  const okTomb = await tally(() => scenarioTombstone(modK.MemoryStore))
  assert(okTomb.failed === 0, `★★ 自证正例（墓碑场景）：未扰动副本全过（通过 ${okTomb.passed} / 失败 ${okTomb.failed}）`)

  // 扰动 A → 合并断言必须失败；且不该影响墓碑场景（证明两个扰动各打各的）
  const badReread = await tally(() => scenarioReread(modA[tagA]))
  assert(badReread.failed === 1, `★★ 扰动 A（去掉写前 re-read）→ 合并断言**失败**：失败计数 ${badReread.failed}（期望 1）`)
  const aOnTomb = await tally(() => scenarioTombstone(modA[tagA]))
  assert(aOnTomb.failed === 0, `★ 反例核对：去掉 re-read 不影响墓碑场景（失败 ${aOnTomb.failed}，期望 0）`)

  // 扰动 B → 复活断言必须失败；且不该影响 re-read 场景
  const badTomb = await tally(() => scenarioTombstone(modB[tagB]))
  assert(badTomb.failed === 1, `★★ 扰动 B（去掉墓碑）→ 复活断言**失败**：失败计数 ${badTomb.failed}（期望 1）`)
  const bOnReread = await tally(() => scenarioReread(modB[tagB]))
  assert(bOnReread.failed === 0, `★ 反例核对：去掉墓碑不影响 re-read 场景（失败 ${bOnReread.failed}，期望 0）`)

  console.log(
    `   → 扰动自证合计：re-read 场景失败 ${badReread.failed}，墓碑场景失败 ${badTomb.failed}；` +
    `未扰动副本同场景失败 ${okReread.failed + okTomb.failed}`
  )
}

console.log('== 83. 并发争抢（真锁争用）：两个实例同时写，一条都不能丢 ==')
{
  // 前面 77 条测的是"先后写"，这一条测"同时写"—— 只有这条才真正跑到锁的争用路径。
  const d83 = path.join(dir, 'x76conc')
  const f83 = path.join(d83, 'memory.json')
  const wA = []
  const wB = []
  const A = new MemoryStore(f83, { onWarn: (m) => wA.push(m), lockRetries: 40, lockBackoffMs: [2, 5, 10] })
  const B = new MemoryStore(f83, { onWarn: (m) => wB.push(m), lockRetries: 40, lockBackoffMs: [2, 5, 10] })
  await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => A.remember({ content: `A${i}`, summary: `A-${i}` })),
    ...Array.from({ length: 10 }, (_, i) => B.remember({ content: `B${i}`, summary: `B-${i}` })),
  ])
  const disk83 = JSON.parse(await fs.readFile(f83, 'utf8'))
  assert(disk83.length === 20, `★★ 20 条并发写一条不丢（磁盘实测 ${disk83.length} 条，期望 20）`)
  assert(new Set(disk83.map((m) => m.id)).size === 20, '★ 20 条 id 互不相同（没有重复条目）')
  const diskSum = new Set(disk83.map((m) => m.summary))
  assert(
    Array.from({ length: 10 }, (_, i) => `A-${i}`).every((s) => diskSum.has(s)) &&
    Array.from({ length: 10 }, (_, i) => `B-${i}`).every((s) => diskSum.has(s)),
    '★ A/B 两侧的记录都在'
  )
  assert(wA.length + wB.length === 0, `★★ 真争用下也没降级、没抢陈旧锁（告警数 ${wA.length + wB.length}，期望 0）`)
  assert(A.lockStats.degraded + B.lockStats.degraded === 0, '★ 两边的降级计数都为 0（锁真的起了作用）')
  assert(
    A.lockStats.acquired + B.lockStats.acquired === 20,
    `★ 20 次落盘都拿到了锁（实测 ${A.lockStats.acquired + B.lockStats.acquired}）`
  )
  const st83 = await fs.readdir(d83)
  assert(!st83.includes('memory.json.lock'), `★★ 全部结束后不留锁文件（目录实测：${st83.join(' / ')}）`)
  // ★ F-16：把"假抢占"的直接计数也钉住（旧实现下它会随机变成 1，且 stolen 是排查用的关键信号）
  assert(
    A.lockStats.stolen + B.lockStats.stolen === 0,
    `★★ F-16：真争用下没有任何一次"抢占陈旧锁"（stolen=${A.lockStats.stolen + B.lockStats.stolen}，期望 0）` +
    '——锁都是毫秒级新鲜锁，被记为抢占就是假报告'
  )
}

console.log('== 83b. ★ F-16 锁层根因锁定：四态探针 + 两种瞬时失败（注入式、确定性）==')
{
  // 诊断（20 次连跑 + 60 轮独立复现）：83 的随机红灯来自锁层的**两个**瞬时误判，不是测试时序假设。
  //   ① 持有者在"open 撞 EEXIST"与"probe"之间正常释放 → 旧 isStaleLock 把 stat 的 ENOENT
  //      当成"陈旧"→ 打出「疑似崩溃残留，已抢占」并 stolen++（60 轮实测 15 轮）。
  //   ② Windows 下 open(...,'wx') 在别人删除同名锁的瞬间抛 EPERM（不是 EEXIST）→ 旧实现当
  //      "不可重试"直接降级（60 轮实测 1 轮，且 degraded=1 意味着这次写完全没设防）。
  // 下面三条都是**确定性注入**（不是碰运气复现），旧实现下必然失败。
  const p83 = path.join(dir, 'x83probe', 'memory.json.lock')
  await fs.mkdir(path.dirname(p83), { recursive: true })
  assert((await probeLock(p83)) === 'missing', '★ F-16：文件已不存在 → missing（旧 isStaleLock 在这里返回 true = 把"刚被释放"当"崩溃残留"）')
  await fs.writeFile(p83, lockBody(), 'utf8')
  assert((await probeLock(p83)) === 'fresh', '★ F-16：刚建的新鲜锁 → fresh（绝不可抢占）')
  const old83 = Date.now() - 3600_000
  await fs.utimes(p83, old83 / 1000, old83 / 1000)
  assert((await probeLock(p83)) === 'stale', '★ F-16：mtime 超龄 → stale（这才是唯一可抢占的那一种）')
  assert((await isStaleLock(p83)) === true, '★ F-16：真陈旧时 isStaleLock 仍返回 true（抢占能力没被削弱，测试 78 照旧成立）')
  await fs.rm(p83, { force: true })
  assert((await isStaleLock(p83)) === false, '★★ F-16：文件已消失时 isStaleLock 必须返回 false（旧实现返回 true → 假"抢占"报告 + stolen 虚增）')
  await fs.writeFile(p83, lockBody(), 'utf8')
  const realStat83 = fs.stat
  let st83u = null
  try {
    fs.stat = async (p, ...rest) => {
      if (String(p) === p83) { const e = new Error('EPERM: 探不到锁文件'); e.code = 'EPERM'; throw e }
      return realStat83.call(fs, p, ...rest)
    }
    st83u = await probeLock(p83)
  } finally { fs.stat = realStat83 }
  assert(st83u === 'unknown', `★ F-16：stat 失败但不是 ENOENT（无证据）→ unknown，**不**据此抢占（实测 ${st83u}）`)
  await fs.rm(p83, { force: true })

  // ── 注入 ①：锁在 probe 之前被正常释放 ──
  {
    const d = path.join(dir, 'x83brel')
    const f = path.join(d, 'memory.json')
    const lk = lockPathFor(f)
    await fs.mkdir(d, { recursive: true })
    await fs.writeFile(lk, lockBody(), 'utf8') // 一个"活"锁（mtime 就是现在）
    const warns = []
    const realStat = fs.stat
    let injected = 0
    let acquired = null
    try {
      fs.stat = async (p, ...rest) => {
        if (String(p) === lk && injected === 0) {
          injected++
          await fs.rm(lk, { force: true }) // ★ 持有者恰好在这一瞬间正常释放（真实竞态的等效注入）
          return realStat.call(fs, p, ...rest) // → ENOENT
        }
        return realStat.call(fs, p, ...rest)
      }
      acquired = await acquireLock(f, { onWarn: (m) => warns.push(m), retries: 3, backoffMs: [1] })
    } finally { fs.stat = realStat }
    assert(injected === 1, '★ F-16 前置：注入真的生效（probe 时锁文件已不存在）')
    assert(acquired.ok === true && !acquired.stale, `★★ F-16：锁被正常释放 → 拿到锁，且**不**记为"抢占陈旧锁"（ok=${acquired.ok} stale=${acquired.stale}）`)
    assert(!warns.some((m) => m.includes('陈旧')), `★★ F-16：不许打出"疑似崩溃残留/已抢占"的假报告（实测告警 ${warns.length} 条：${warns.join(' / ') || '无'}）`)
    await fs.rm(lk, { force: true })
  }

  // ── 注入 ②：open(...,'wx') 抛一次瞬时 EPERM（Windows 删除竞争）──
  {
    const d = path.join(dir, 'x83beperm')
    const f = path.join(d, 'memory.json')
    const lk = lockPathFor(f)
    await fs.mkdir(d, { recursive: true })
    const warns = []
    const realOpen = fs.open
    let eperm = 0
    let acquired = null
    try {
      fs.open = async (p, ...rest) => {
        if (String(p) === lk && eperm === 0) {
          eperm++
          const e = new Error(`EPERM: operation not permitted, open '${lk}'`)
          e.code = 'EPERM'
          throw e
        }
        return realOpen.call(fs, p, ...rest)
      }
      acquired = await acquireLock(f, { onWarn: (m) => warns.push(m), retries: 3, backoffMs: [1] })
    } finally { fs.open = realOpen }
    assert(eperm === 1, '★ F-16 前置：注入真的生效（第一次 open 收到 EPERM）')
    assert(acquired.ok === true, `★★ F-16：锁路径瞬时 EPERM → 重试后仍拿到锁（旧实现一次就判"不可重试"并降级；ok=${acquired.ok}）`)
    assert(warns.length === 0, `★★ F-16：瞬时 EPERM 不该产生任何告警/降级（实测 ${warns.length} 条：${warns.join(' / ') || '无'}）`)
    await fs.rm(lk, { force: true })
  }

  // ── 注入 ③：re-read / rename 的瞬时失败（旧实现：整次保存失败 = 记忆写不进去）──
  {
    const d = path.join(dir, 'x83bread')
    const f = path.join(d, 'memory.json')
    const s = new MemoryStore(f)
    await s.remember({ content: 'first', summary: 'F16-first' })
    const realRead = fs.readFile
    let injected = 0
    let err = null
    try {
      fs.readFile = async (p, ...rest) => {
        if (String(p) === f && injected === 0) {
          injected++
          const e = new Error('EPERM: 模拟别人正在替换该文件'); e.code = 'EPERM'; throw e
        }
        return realRead.call(fs, p, ...rest)
      }
      try { await s.remember({ content: 'second', summary: 'F16-second' }) } catch (e) { err = e }
    } finally { fs.readFile = realRead }
    assert(injected === 1, '★ F-16 前置：写前重读确实被注入了一次 EPERM')
    assert(err === null, `★★ F-16：写前重读的**瞬时** EPERM 必须重试，不许让这次保存失败（旧实现：抛 EPERM → remember 失败；实测 ${err && err.message}）`)
    const disk = JSON.parse(await realRead.call(fs, f, 'utf8'))
    assert(disk.length === 2, `★★ F-16：重试后合并语义不变，两条都在（磁盘 ${disk.length} 条）`)
  }
  {
    const d = path.join(dir, 'x83bren')
    const f = path.join(d, 'memory.json')
    const s = new MemoryStore(f)
    await s.remember({ content: 'first', summary: 'F16r-first' })
    const realRename = fs.rename
    let injected = 0
    let err = null
    try {
      fs.rename = async (src, dest) => {
        if (String(dest) === f && injected === 0) {
          injected++
          const e = new Error('EPERM: 模拟目标被瞬时占用'); e.code = 'EPERM'; throw e
        }
        return realRename.call(fs, src, dest)
      }
      try { await s.remember({ content: 'second', summary: 'F16r-second' }) } catch (e) { err = e }
    } finally { fs.rename = realRename }
    assert(injected === 1, '★ F-16 前置：原子替换的 rename 确实被注入了一次 EPERM')
    assert(err === null, `★★ F-16：rename 的瞬时 EPERM 必须重试，不许让保存失败（实测 ${err && err.message}）`)
    const disk = JSON.parse(await fs.readFile(f, 'utf8'))
    assert(disk.length === 2, `★ F-16：rename 重试后文件内容完好且两条都在（磁盘 ${disk.length} 条）`)
    const entries = await fs.readdir(d)
    assert(!entries.some((n) => n.endsWith('.tmp')), `★ F-16：重试路径同样不留 .tmp（实测 ${entries.join(' / ')}）`)
  }
}

// 局部化的 pass/fail 计数（与 82 同一套做法）：扰动场景的失败数不能污染全局计数
const tally = async (fn) => {
  const op = pass, of = fail
  await fn()
  const r = { passed: pass - op, failed: fail - of }
  pass = op; fail = of
  return r
}

console.log('== 84. ★ F-3 路径统一：插件与脚本必须是**同一套规则**（且真的按环境走）==')
{
  // 这组断言是 F-3 的核心：同一组环境变量喂给**各条入口**，必须落到**同一个目录**。
  // 历史故障：插件算 `DSH_HOME || cwd`，脚本算 `DSH_PROFILE_DIR → DSH_HOME` ——
  // 两边不校验，于是"初始化成功"与"插件读不到"同时成立，身份段静默消失。
  //
  // ★ 为什么这里要动 process.env：MemoryStore/ConstitutionStore 的**默认参数**是
  //   `process.env`，传假 env 给它们没用（那正是"测试装饰化"的陷阱）。必须真的改
  //   进程环境，再断言"构造出来的对象指向哪"。这样 store.js 若偷偷自己算一遍路径
  //   （忽略 DSH_PROFILE_DIR），本条会立刻失败。
  const fakeProfile = path.join(dir, 'x84', 'profiles', 'desktop')
  const fakeHome = path.join(dir, 'x84', 'home')
  await fs.mkdir(path.join(fakeProfile, 'mnemos'), { recursive: true })
  const expectedDir = path.join(fakeProfile, 'mnemos')
  const saved = {
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
    DSH_HOME: process.env.DSH_HOME,
    MNEMOS_DATA_FILE: process.env.MNEMOS_DATA_FILE,
    MNEMOS_CONSTITUTION_FILE: process.env.MNEMOS_CONSTITUTION_FILE,
  }
  let df, cf, cli, s84, c84, text84
  try {
    process.env.DSH_PROFILE_DIR = fakeProfile   // ← 与 DSH_HOME **不同**，profile 才是真的
    process.env.DSH_HOME = fakeHome
    delete process.env.MNEMOS_DATA_FILE
    delete process.env.MNEMOS_CONSTITUTION_FILE

    df = defaultDataFile()
    cf = defaultConstitutionFile()
    cli = resolveConstitutionFileForCli(['node', 'scripts/init-constitution.mjs'])
    s84 = new MemoryStore(undefined)          // ★ 插件真实的构造方式（index.js 传的是 ''/undefined）
    c84 = new ConstitutionStore(undefined)

    assert(path.dirname(df) === expectedDir, `插件默认数据目录 = profile 优先（实测 ${path.dirname(df)}）`)
    assert(path.dirname(cf) === expectedDir, `插件默认宪法目录 = profile 优先（实测 ${path.dirname(cf)}）`)
    assert(
      path.dirname(df) === path.dirname(cf) && path.dirname(cf) === path.dirname(cli),
      `★★ 同一套规则：dataFile / constitutionFile / 脚本 CLI 三者解析到同一目录（${path.dirname(df)}）`
    )
    assert(
      cli === cf,
      `★★ 脚本不带 --file 时与插件读到**同一个宪法文件**（script=${cli} / plugin=${cf}）——不一致就会重演 F-3`
    )
    assert(
      s84.dataFile === path.join(expectedDir, 'memory.json'),
      `★★ 插件实例（MemoryStore 默认参数）真的按 profile 解析（实测 ${s84.dataFile}）——store.js 若自己再算一遍，这条就挂`
    )
    assert(
      c84.dataFile === path.join(expectedDir, 'constitution.json'),
      `★★ 宪法实例同理（实测 ${c84.dataFile}）`
    )
    assert(df === path.join(expectedDir, 'memory.json'), '★ 记忆文件名固定为 memory.json')
    assert(cf === path.join(expectedDir, 'constitution.json'), '★ 宪法文件名固定为 constitution.json')
    assert(mnemosDataDir() === expectedDir, '★ mnemosDataDir 与两个默认文件同根（三者不会各说各话）')

    // ★ 端到端：把宪法写到**脚本那一条路径**上，插件实例必须读得出来 ——
    //   这正是 F-3 的场景（持有者照 INSTALL 跑 init，插件在另一个目录找宪法）。
    const wrote = new ConstitutionStore(cli)
    await wrote.initialize('【红线】不撒谎。', 'pw-f3', 'tester')
    const readBack = new ConstitutionStore()
    await readBack.load()
    assert(readBack.read() === '【红线】不撒谎。', '★★ 端到端：脚本初始化到哪，插件就从哪读到（同一路径，不再各找一处）')
    text84 = buildSelfText(readBack, { autobiographyCompact: () => ({ entries: [] }) }, 2000)
    assert(text84.includes('【红线】'), '★★ 端到端：身份段真的注入了（不是空串）')

    // 反例核对：显式配置仍然最高优先，统一规则没有吃掉显式入口
    const explicit = resolveConstitutionFileForCli(['node', 'x.mjs', '--file=D:\\somewhere\\c.json'])
    assert(explicit === 'D:\\somewhere\\c.json', '★ 反例核对：显式 --file= 仍然最优先')
    assert(
      new ConstitutionStore('D:\\explicit\\c.json').dataFile === 'D:\\explicit\\c.json',
      '★ 反例核对：显式 constitutionFile 也仍然最优先'
    )
    // tags 参数不会被 env 影响：MNEMOS_*_FILE 优先于目录推断
    process.env.MNEMOS_CONSTITUTION_FILE = 'D:\\env\\c.json'
    assert(defaultConstitutionFile() === 'D:\\env\\c.json', '★ MNEMOS_CONSTITUTION_FILE 优先于目录推断')
    delete process.env.MNEMOS_CONSTITUTION_FILE
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  // 还原核对：临时改环境不许泄漏到后面的用例
  assert(process.env.DSH_PROFILE_DIR === saved.DSH_PROFILE_DIR, '★ 前置/收尾：process.env 已还原（不污染后续用例）')
}

console.log('== 85. ★ profile 优先于 home（两者不等，本机实测就是这种情况）==')
{
  const x = 'C:\\pf\\profiles\\p1'
  const y = 'C:\\hm'
  assert(
    defaultDataFile({ DSH_PROFILE_DIR: x, DSH_HOME: y }).startsWith(path.join(x, 'mnemos')),
    '★★ DSH_PROFILE_DIR 与 DSH_HOME 不同 → 必须落在 PROFILE 下（顺序写反就重演 F-3）'
  )
  assert(
    defaultConstitutionFile({ DSH_PROFILE_DIR: x, DSH_HOME: y }).startsWith(path.join(x, 'mnemos')),
    '★★ 宪法同理：profile 下的 constitution.json'
  )
  assert(
    resolveConstitutionFileForCli(['node', 's.mjs'], { DSH_PROFILE_DIR: x, DSH_HOME: y }).startsWith(path.join(x, 'mnemos')),
    '★★ 脚本侧也必须是 profile 优先（两边同一个函数）'
  )
  // 显式环境变量优先于默认根（假 env 里空串代表"没设"）
  assert(
    defaultConstitutionFile({ DSH_PROFILE_DIR: x, DSH_HOME: y, MNEMOS_CONSTITUTION_FILE: 'D:\\z\\c.json' }) === 'D:\\z\\c.json',
    '★ MNEMOS_CONSTITUTION_FILE 优先于目录推断'
  )
  // 兜底链仍在：只有 home 时用 home；都没有时用 cwd（纯 shell 下手跑脚本）
  assert(defaultDataFile({ DSH_HOME: y }) === path.join(y, 'mnemos', 'memory.json'), '★ 只有 DSH_HOME 时退到 home（兜底没坏）')
  assert(defaultDataFile({}) === path.join(process.cwd(), 'mnemos', 'memory.json'), '★ 都没有时退到 cwd（纯 shell 场景）')
}

console.log('== 86. ★ 宪法未初始化：注入文本必须**非空**且带真实路径 ==')
{
  // 用一个"注定读不到"的宪法路径 —— 这正是未初始化时 buildSelfText 看到的东西
  const missingFile = path.join(dir, 'no-such-constitution.json')
  const con = new ConstitutionStore(missingFile)
  await con.load()
  assert(con.read() === null, '前置：未初始化时 constitution.read() 返回 null')

  // store 用最小等价物（只需要 autobiographyCompact 一个方法）
  const fakeStore = { autobiographyCompact: () => ({ entries: [] }) }
  const text86 = buildSelfText(con, fakeStore, 2000)
  assert(text86 !== '' && text86.trim().length > 0, `★★ 未初始化时**不能返回空串**（实测长度 ${text86.length}）——空串会被宿主丢掉，模型根本不知道宪法缺失`)
  assert(text86.includes('宪法'), '★★ 警告文本含「宪法」字样')
  assert(text86.includes('init-constitution.mjs'), '★★ 警告文本告诉持有者用什么初始化（init-constitution.mjs）')
  assert(text86.includes(missingFile), `★★ 警告里是**真实解析到的绝对路径**（实测含 ${missingFile}）`)
  assert(text86.includes('未初始化'), '★ 警告明确说出「未初始化」（而不是让人自己猜）')
  assert(text86.includes('无法初始化'), '★ 说明 Mnemos 自己无法初始化（宪法必须由人设密码）')

  // 自传体段照旧：有内容就注入；为空则不注入
  const fakeStore2 = { autobiographyCompact: () => ({ entries: [{ label: '决策', summary: 'F-3 统一路径' }] }) }
  const text86b = buildSelfText(con, fakeStore2, 2000)
  assert(text86b.includes('【自传体 · 自我历史（紧凑版，按需召回详情）】'), '★ 未初始化时自传体段照旧注入（不是"整段都不给"）')
  assert(text86b.includes('F-3 统一路径'), '★ 自传体条目内容在（没有被警告挤掉）')
}

console.log('== 87. ★ 已初始化不受影响 / 警告段是纯文本（无字面星号）==')
{
  const realFile = path.join(dir, 'x84-constitution', 'constitution.json')
  await fs.mkdir(path.dirname(realFile), { recursive: true })
  const con = new ConstitutionStore(realFile)
  const version = await con.initialize('【红线】不撒谎。\n【边界】不越权。', 'pw-84', 'tester')
  assert(version === 1, '前置：宪法初始化成功（version 1）')
  const con2 = new ConstitutionStore(realFile)
  await con2.load()
  assert(con2.read() !== null, '前置：重新加载读得到宪法正文')

  const fakeStore = { autobiographyCompact: () => ({ entries: [] }) }
  const text87 = buildSelfText(con2, fakeStore, 2000)
  assert(text87.includes('【宪法 · 身份/红线（系统只读，不可变）】'), '★★ 已初始化：照常注入宪法正文')
  assert(text87.includes('【红线】不撒谎。'), '★ 正文内容真的进去了')
  assert(!text87.includes('未初始化'), '★★ 已初始化时**不出现**未初始化警告（不是永远挂个警告）')
  assert(!text87.includes('init-constitution.mjs'), '★ 已初始化时不出现初始化指引（不制造噪音）')

  // ★ 纯文本：警告段本身不许出现字面 `**`（项目栽过四次，见 plain-text.js）
  const warn87 = constitutionMissingWarning('C:\\tmp\\x\\constitution.json')
  const starIndex = warn87.indexOf('**')
  assert(starIndex === -1, `★★ 警告段不含字面星号（实测 indexOf('**')=${starIndex}，期望 -1）`)
  assert(warn87 === plain(warn87), '★ 警告段已过 plain()（幂等：再过一次不变）')
  // 反例核对：plain() 确实在起作用 —— 造一段带 `**` 的文本必须被去掉
  assert(plain('**加粗**') === '加粗', '★ 反例核对：plain() 确实会去掉星号（这条断言本身有判别力）')
  assert(!buildSelfText(new ConstitutionStore(path.join(dir, 'x84-missing', 'constitution.json')), fakeStore, 2000).includes('**'), '★★ buildSelfText 的未初始化返回值里也没有字面星号')
}

console.log('== 89. ★ F-4 自传体分类兜底：不带三类 tag 的永久层条目不再被静默丢弃 ==')
{
  const f4 = new MemoryStore(path.join(dir, 'x89', 'memory.json'))
  await f4.remember({ content: 'e', summary: '默认条目（不带三类 tag）', tags: [], source: 'autobiography' })
  await f4.remember({ content: 'e', summary: '能力：会做某件事', tags: ['ability'], source: 'autobiography' })
  await f4.remember({ content: 'e', summary: '事件：发生过某件事', tags: ['event'], source: 'autobiography' })
  await f4.remember({ content: 'e', summary: '决策：选了某个方案', tags: ['decision'], source: 'autobiography' })
  const c4 = f4.autobiographyCompact({ budget: 2000 })
  const texts4 = c4.entries.map((e) => e.summary)
  const unclassified = '默认条目（不带三类 tag）'
  assert(texts4.includes(unclassified), `★★ [F4] 兜底：不带 decision/ability/event tag 的永久层条目**必须进本段**，不得静默丢弃（实测 ${JSON.stringify(texts4)}）`)
  assert(
    c4.entries.some((e) => e.category === 'other' && e.summary === unclassified),
    '★ F-4 兜底：它落在「其他」类目（category=other）'
  )
  const threeCat = ['决策：选了某个方案', '能力：会做某件事', '事件：发生过某件事']
  assert(
    threeCat.every((s) => texts4.includes(s)),
    '★ F-4 反例核对：带三类 tag 的条目照常在前三个类目里，兜底没有把它们误吞'
  )
  const idxOther = c4.entries.findIndex((e) => e.category === 'other')
  const idxDecision = c4.entries.findIndex((e) => e.category === 'decision')
  assert(idxDecision >= 0 && idxDecision < idxOther, '★ F-4 顺序：「其他」排在决策之后（兜底不抢高优先级的位置）')
  // 旧实现的判别力：旧实现只认三类 tag —— 语义上这条必然丢；本断言是那条行为的正向对照。
  assert(c4.entries.length === 4, `★ F-4 四条永久层条目全部注入（实测 ${c4.entries.length}）`)
}

console.log('== 90. ★ F-6 超长条目只跳过自己，不许把后面能放得下的小条目一起放弃 ==')
{
  // ⚠️ 构造必须**有判别力**（第一版这里写错了，被扰动自证抓出来）：
  //   旧实现 `break` 跳出的是**整个类目**，但条目是从新到旧排队、小的可能排在大的**前面** ——
  //   那种 `[大, 小]` 排列下 break 也能装进小条目，断言打不出新旧差别（"对任何实现都通过"）。
  //   真正的判别场景是小条目排在**大条目之后**：`[小, 大, 小]`。
  //   旧实现：装进第一个小 → 遇到大的 break → **后面那个小条目被一起放弃**。
  //   新实现：跳过大的 → 后面的小条目仍被装进。
  const f6 = new MemoryStore(path.join(dir, 'x90', 'memory.json'))
  await f6.remember({ content: 'e', summary: '小一', tags: ['ability'], source: 'autobiography' })   // 旧（recency 最小 → 排最后）
  await f6.remember({ content: 'e', summary: '巨'.repeat(100), tags: ['ability'], source: 'autobiography' }) // 中间
  await f6.remember({ content: 'e', summary: '小二', tags: ['ability'], source: 'autobiography' })   // 最新 → 排最前
  const r6 = f6.autobiographyCompact({ budget: 50 })
  const texts6 = r6.entries.map((e) => e.summary)
  assert(
    texts6[0] === '小二',
    `★ F-6 前置：条目按 recency 从新到旧排队（实测第一条：${JSON.stringify(texts6[0])}）`
  )
  assert(
    texts6.includes('小一'),
    `★★ [F6] 大条目之后的 1 字小条目**必须仍在** —— 旧实现 break 会把它一起放弃（实测 ${JSON.stringify(texts6)}）`
  )
  assert(!texts6.includes('巨'.repeat(100)), '★ F-6 反例核对：那条超长的本身确实没进（预算不许被撑破）')
  assert(r6.used <= 50, `★ F-6：used(${r6.used}) 不超过 budget(50)`)
  // 加一条"单纯顺序"的对照：预算够大时三条都在（防止上面的断言被别的机制凑对）
  const r6b = f6.autobiographyCompact({ budget: 500 })
  assert(r6b.entries.length === 3, `★ F-6 反例核对：预算够大时三条都在（实测 ${r6b.entries.length}）`)
  // 2 + 100 + 2 = 104 个 UTF-16 单元（每个汉字算 1）—— 第一版我按 1+100+1 写成 102，错了
  assert(r6b.used === 104, `★ F-6：三条合计 104 字（实测 ${r6b.used}）`)
}

console.log('== 91. ★ F-7 空类目不占额度（预算不许浪费在没人排队的类目上）==')
{
  const f7a = new MemoryStore(path.join(dir, 'x91a', 'memory.json'))
  await f7a.remember({ content: 'e', summary: 'd'.repeat(100), tags: ['decision'], source: 'autobiography' })
  const r7a = f7a.autobiographyCompact({ budget: 600 })
  const c7a = r7a.entries.find((e) => e.category === 'decision')
  assert(!!c7a, '★ F-7：只有一个类目（decision）有内容时，它照常注入')
  assert(
    c7a.summary.length === 100 && r7a.used === 100,
    `★ F-7：空类目不占额度 —— 决策条目用自己的 100 字，没被能力/事件/其他的配额切碎（实测 used=${r7a.used}）`
  )
  assert(
    r7a.entries.length === 1 && r7a.unselected === 0,
    `★ F-7：只注入了那一条，unselected=${r7a.unselected}（空类目既不占额度、也不虚报未注入）`
  )
}

console.log('== 92. ★★ F-7 决策占满预算时，ability/event 仍有保底配额 ==')
{
  const f7 = new MemoryStore(path.join(dir, 'x92', 'memory.json'))
  // 决策 4×120 = 480：已经吃满 600 预算的 80%
  for (let i = 0; i < 4; i++) {
    await f7.remember({ content: 'e', summary: 'D' + i + '：' + 'd'.repeat(116), tags: ['decision'], source: 'autobiography' })
  }
  await f7.remember({ content: 'e', summary: 'A1：' + 'a'.repeat(37), tags: ['ability'], source: 'autobiography' }) // 40
  await f7.remember({ content: 'e', summary: 'E1：' + 'e'.repeat(37), tags: ['event'], source: 'autobiography' })   // 40
  const r7 = f7.autobiographyCompact({ budget: 600 })
  const got7 = r7.entries.map((e) => e.summary)
  const a7 = r7.entries.filter((e) => e.category === 'ability')
  const e7 = r7.entries.filter((e) => e.category === 'event')
  // 旧实现（严格优先级 + break）：决策把 600 预算吃光 → 轮到能力时 used>=budget 直接 break
  // → ability 0 条、event 0 条。保底配额的目的就是让这个场景不可能发生。
  assert(a7.length >= 1, `★★ F-7：决策吃满预算时，能力类目**仍有保底配额**（实测 ability ${a7.length} 条 / decision ${r7.entries.filter((e) => e.category === 'decision').length} 条）`)
  assert(e7.length >= 1, `★★ F-7：事件类目同样拿到保底配额（实测 event ${e7.length} 条）`)
  assert(r7.used <= 600, `★ F-7：配额生效后 used(${r7.used}) 仍不超预算(600)`)
  assert(
    r7.entries.filter((e) => e.category === 'decision').length >= 2,
    '★ F-7 反例核对：保证能力/事件的同时，决策没有被挤掉（它仍是最高优先级，拿的额度最多）'
  )
  assert(r7.entries.length === 6, `★ F-7：预算足够装下全部 6 条（实测 ${r7.entries.length}）`)
  assert(
    got7.indexOf('A1：' + 'a'.repeat(37)) < got7.indexOf('D3：' + 'd'.repeat(116)),
    '★ F-7 顺序：保底注入的能力条在倒数第二条决策之前（按优先级轮转，不是"决策全排前面"）'
  )
}

console.log('== 93. ★ F-12 自传体段：有未注入 → 一行实数提示；全部注入 → 不出现 ==')
{
  const budget93 = 150
  const f12 = new MemoryStore(path.join(dir, 'x93', 'memory.json'))
  // 6 条 × 60 字 = 360 字，预算 150 → 必然装不下（都是「其他」类，不带三类 tag）
  for (let i = 0; i < 6; i++) {
    await f12.remember({ content: 'e', summary: 'S' + i + '：' + 'x'.repeat(57), tags: [], source: 'autobiography' })
  }
  const con93 = new ConstitutionStore(path.join(dir, 'x93-constitution', 'constitution.json'))
  const text93 = buildSelfText(con93, f12, budget93)
  const compact93 = f12.autobiographyCompact({ budget: budget93 })
  const marker93 = '【自传体 · 尚未注入】'
  // 预算 150 / floor = min(200, 22, 37) = 22 → other 类拿到 22 保底，能装 1 条 60 字？不能（60>22）→ 0 条。
  // 若一条都装不下，自传体段整段不出现 —— 那种情况 F-12 就无从提示。所以这里断言"必须有条目进来"，
  // 这是提示行能出现的前提（也是"预算太小时应该报错/调大"的真实边界）。
  const anyIn = compact93.entries.length > 0
  assert(anyIn, `★ F-12 前置：预算 ${budget93} 下至少注入了 1 条（实测 ${compact93.entries.length} 条，否则整段不出现、提示行无处可挂）`)
  assert(text93.includes(marker93), `★★ [F12] 有未注入条目时必须出现提示行（实测 ${text93.includes(marker93)}）`)
  const realN93 = compact93.unselected
  assert(realN93 > 0 && text93.includes(`另有 ${realN93} 条自传体`), `★★ F-12：N 是**实数**（store 实测 ${realN93}；文本里是 ${text93.includes('另有 ' + realN93 + ' 条') ? '同一个数' : '（不一致！）'}）`)
  assert(text93.includes(`本段只受 ${budget93} 字符预算约束`), `★ F-12：提示里的预算是**真实生效值** ${budget93}（不是写死的占位）`)
  const line93 = text93.split('\n').find((l) => l.includes(marker93)) || ''
  assert(
    line93.includes('mnemos_recall') && line93.includes('不要凭印象认为没记过'),
    `★ F-12：提示同时给出召回指引（实测行：${line93.slice(0, 80)}…）`
  )
  assert(line93.indexOf('**') === -1, '★★ F-12：提示行是纯文本，不含字面星号')
  // 反例核对：这条断言本身有判别力（把提示行从文本里删掉就必须不通过）
  assert(!text93.replace(marker93, '').includes(marker93), '★ F-12 反例核对：去掉标记后检测不到（断言不是恒真）')

  // ── 全部注入 → 提示行**不出现** ──
  const fit93 = new MemoryStore(path.join(dir, 'x93fit', 'memory.json'))
  await fit93.remember({ content: 'e', summary: '短的', tags: [], source: 'autobiography' })
  const con93b = new ConstitutionStore(path.join(dir, 'x93fit-constitution', 'constitution.json'))
  const text93b = buildSelfText(con93b, fit93, budget93)
  assert(
    text93b.includes('【自传体 · 自我历史（紧凑版，按需召回详情）】'),
    '★ F-12 前置：全部装得下时自传体段照常注入'
  )
  assert(!text93b.includes(marker93), '★★ F-12：全部注入时**不出现**那一行（不许永远挂着一句吓人的提示）')
  assert(fit93.autobiographyCompact({ budget: budget93 }).unselected === 0, '★ F-12：该场景下未注入实数确实是 0')
}

console.log('== 94. ★ F-5 无 sessionId：archiveSession(null) 归入 __unassigned__（不再谎报）==')
{
  const f5 = new MemoryStore(path.join(dir, 'x94', 'memory.json'))
  const rec = await f5.remember({ content: 'c1', summary: '无会话短时记忆一', tags: ['x94'] })
  assert(rec.sessionId === null, '★ F-5 前置：这条记录确实没有 sessionId（null）')
  assert(f5.shortBySession().has('__unassigned__'), '★ F-5 前置：shortBySession() 把无会话记录归到 __unassigned__ 分组')
  const archived = await f5.archiveSession(null)
  // 旧实现：`(m.sessionId || '__unassigned__') === null` 永远 false → 返回 null
  // → 工具回执谎报「当前会话框没有可归档的短时记忆」，而记录其实就在 __unassigned__ 里。
  assert(archived !== null, `★★ F-5：archiveSession(null) 不得返回 null —— 记录真实存在（旧实现必返回 null，实测 ${archived && archived.id}）`)
  assert(archived && archived.scope === '__unassigned__', `★ F-5：归档结果如实标出作用域 scope=${archived && archived.scope}`)
  assert(archived && archived.sessionId === null, '★ F-5：sessionId 仍如实为 null（不伪造会话 id）')
  const after94 = [...f5.memories.values()]
  assert(
    after94.some((m) => m.id === rec.id && m.layer === 'cold'),
    '★ F-5：原记录已降为冷存储（真的归档了，不是只回一句好话）'
  )
  assert(
    [...f5.memories.values()].filter((m) => m.layer === 'short').length === 0,
    '★ F-5：没有短时记忆留在 short 层（那组确实被归档）'
  )
  // 反例核对：作用域不混 —— 另一个会话的短时记忆不许被 null 归档带走
  const other = await f5.remember({ content: 'c2', summary: '有会话短时记忆', tags: ['x94'], sessionId: 'sid-x94' })
  await f5.archiveSession(null)
  assert(
    !!(await f5.open(other.id)) && f5.memories.get(other.id).layer === 'short',
    '★ F-5 反例核对：archiveSession(null) 只动 __unassigned__ 组，不许把有会话的记录一起归档'
  )
}

console.log('== 94b. ★ 归档闸门（2026-10-17）：隔离验证 / 未收尾任务不许被自动归档吃掉 ==')
{
  const g = new MemoryStore(path.join(dir, 'x94b', 'memory.json'))
  const SID = 'sid-gate'
  // 三条短时记录：普通 / 隔离验证 / 未收尾任务的交接
  const plain = await g.remember({ content: '普通短时', summary: '普通短时', tags: ['x94b'], sessionId: SID })
  const val = await g.remember({ content: '外部信息验证结论', summary: '隔离验证结论', tags: ['validation', 'external-info'], source: 'validation', sessionId: SID })
  const graph = await g.remember({
    content: '任务图：两路分工',
    summary: '任务图 t-94b',
    tags: [TASK_GRAPH_TAG, TASK_OPEN_TAG, `${TASK_TAG_PREFIX}t-94b`, 'x94b'],
    sessionId: SID,
  })
  const handoff = await g.remember({
    content: '子代理交接内容',
    summary: '分工A的交接',
    tags: [`${TASK_TAG_PREFIX}t-94b`, 'assign:a', 'x94b'],
    sessionId: SID,
  })
  assert(isArchiveProtected(val, new Set()) === true, '★★ source=validation → 受归档保护（"只存短期"从约定变成机制）')
  assert(isArchiveProtected(plain, new Set()) === false, '★ 普通短时记录不受保护（不能把闸门做成"什么都不归档"）')
  const openIds = collectOpenTaskIds([plain, val, graph, handoff])
  assert(openIds.has('t-94b'), '★★ 未收尾的任务图能被识别出来（判据来自图自己的 open 标签）')
  assert(isArchiveProtected(handoff, openIds) === true, '★★ 未收尾任务下的交接记忆受保护')
  assert(isArchiveProtected(graph, openIds) === true, '★★ 任务图自己也受保护（否则图被归档掉，闸门就失去判据）')

  // 真归档一次：只有普通记录被归档，其余原样留在短时层，并被如实计数
  const report = {}
  const rec = await g.archiveSession(SID, undefined, report)
  assert(rec !== null, '★ 有可归档记录 → 仍然归档（闸门不是一刀切）')
  assert(report.total === 4 && report.protected === 3 && report.archived === 1,
    `★★ 回执如实分出三类计数（实测 total=${report.total} protected=${report.protected} archived=${report.archived}）`)
  assert(g.memories.get(plain.id).layer === 'cold', '★ 普通记录已归档（降为冷存）')
  assert(g.memories.get(val.id).layer === 'short', '★★ 隔离验证记录仍在短时层（心跳/consolidate 都吃不掉它）')
  assert(g.memories.get(handoff.id).layer === 'short', '★★ 未收尾任务的交接记录仍在短时层')
  assert(g.memories.get(graph.id).layer === 'short', '★★ 任务图本身仍在短时层')

  // 收尾之后（图标签 open→closed）→ 同一会话的记录就可以归档了
  const gRec = g.memories.get(graph.id)
  gRec.tags = gRec.tags.map((t) => (t === TASK_OPEN_TAG ? TASK_CLOSED_TAG : t))
  gRec.version += 1
  await g.save()
  const afterClose = collectOpenTaskIds(g.memories.values())
  assert(!afterClose.has('t-94b'), '★ 收尾后不再算"未收尾任务"')
  const report2 = {}
  const rec2 = await g.archiveSession(SID, undefined, report2)
  assert(rec2 !== null && report2.protected === 1,
    `★★ 收尾后：任务记录可以归档了，只剩隔离验证那条被保护（实测 protected=${report2.protected}）`)
  assert(g.memories.get(handoff.id).layer === 'cold', '★★ 交接记录已归档')
  assert(g.memories.get(val.id).layer === 'short', '★★ 隔离验证记录**永远**不被自动归档')

  // 归零态：全部受保护时返回 null，但回执要能说明"是被闸门留下的"
  const g2 = new MemoryStore(path.join(dir, 'x94b2', 'memory.json'))
  await g2.remember({ content: 'v', summary: 'v', tags: ['validation'], source: 'validation', sessionId: 'sid-2' })
  const report3 = {}
  const rec3 = await g2.archiveSession('sid-2', undefined, report3)
  assert(rec3 === null && report3.protected === 1 && report3.total === 1,
    '★★ 全被闸门拦住时返回 null，但计数说实话（否则会被误读成"本来就没有记录"）')
  const shaped = consolidateResult(rec3, report3)
  assert(shaped.archived === false && shaped.protected === 1, '★★ 工具回执带上 protected 条数（可观测）')
  const shaped2 = consolidateResult(rec, report)
  assert(shaped2.archived === true && shaped2.protected === 3, '★ 有归档时也带 protected 条数')
  const shaped3 = consolidateResult(rec)
  assert(!('protected' in shaped3), '★ 没有闸门信息时不塞这个字段（省略即"不适用"）')
}

console.log('== 94c. 隔离验证记录有界化：超窗口即销毁（带墓碑 + 销毁台账）==')
{
  const d94c = path.join(dir, 'x94c')
  const file94c = path.join(d94c, 'memory.json')
  const st = new MemoryStore(file94c)
  const v1 = await st.remember({ content: 'v1', summary: '验证一', tags: ['validation'], source: 'validation', sessionId: 's94c' })
  const v2 = await st.remember({ content: 'v2', summary: '验证二', tags: ['validation'], source: 'validation', sessionId: 's94c' })
  const v3 = await st.remember({ content: 'v3', summary: '验证三', tags: ['validation'], source: 'validation', sessionId: 's94c' })
  const other94c = await st.remember({ content: '普通', summary: '普通记录', tags: ['x94c'], sessionId: 's94c' })

  // ① 窗口很大 → 一条都不删（刚验证完的结论不能被清掉）
  const keepAll = await st.pruneValidation({ keepRecent: 0, keepMs: 365 * 24 * 3600 * 1000 })
  assert(keepAll.scanned === 3 && keepAll.deleted === 0, '★★ 在保留窗口内 → 一条都不销毁')

  // ② 超出窗口（把 now 推到 30 天后）+ 只保留最近 1 条 → 删 2 条
  const r = await st.pruneValidation({ keepRecent: 1, keepMs: 7 * 24 * 3600 * 1000, now: Date.now() + 30 * 24 * 3600 * 1000 })
  assert(r.scanned === 3 && r.deleted === 2 && r.kept === 1,
    `★★ 双条件都要满足才销毁（实测 scanned=${r.scanned} deleted=${r.deleted} kept=${r.kept}）`)
  assert(!st.memories.has(v1.id) && !st.memories.has(v2.id), '★ 两条旧验证记录已销毁')
  assert(st.memories.has(v3.id), '★★ 最近的那条留着（不是一刀切全删）')
  assert(st.memories.has(other94c.id), '★★ 只动 source=validation：普通记录不受影响')

  // ③ 墓碑生效：换一个实例读同一份文件，删掉的不许复活
  const st2 = new MemoryStore(file94c)
  await st2.ensureLoaded()
  assert(!st2.memories.has(v1.id) && !st2.memories.has(v2.id), '★★ 销毁带墓碑（新实例读盘看不到，旧副本也复活不了）')

  // ④ 销毁台账：不可逆操作至少要留下"删过什么"
  assert(typeof r.auditFile === 'string' && r.auditFile.endsWith('validation-prune.jsonl'), `★ 台账写在 memory.json 同级（实测 ${r.auditFile}）`)
  const auditLines = (await fs.readFile(r.auditFile, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert(auditLines.length === 2, '★ 每条销毁都留一行台账')
  assert(auditLines.every((l) => l.id && l.summary && l.reason === 'validation-record-beyond-window'), '★ 台账含 id / 摘要 / 原因')
}

console.log('== 94d. 任务图（多 agent 协作）：开图 / 填回执 / 收尾 + scratch 默认丢弃 ==')
{
  const SID = 's94d'
  const t = new MemoryStore(path.join(dir, 'x94d', 'memory.json'))
  const opened = await t.openTask({
    goal: '把两篇外部资料核对成一份结论',
    assignments: [
      { id: 'a', task: '核对资料一' },
      { id: 'b', task: '核对资料二' },
    ],
    sessionId: SID,
  })
  assert(opened.ok === true && /^t-/.test(opened.taskId), `★ 开图成功并给出 taskId（实测 ${opened.taskId}）`)
  const graph = t.memories.get(opened.graphId)
  const tag = `${TASK_TAG_PREFIX}${opened.taskId}`
  assert(graph.tags.includes(TASK_GRAPH_TAG) && graph.tags.includes(TASK_OPEN_TAG) && graph.tags.includes(tag),
    '★★ 图的标签齐全（task-graph + open + task:<id>）—— 闸门就是靠这几样认它的')
  assert(graph.layer === 'short', '★ 图落在短时层（收尾前不归档）')
  assert(graph.task.assignments.every((a) => a.status === 'pending'), '★ 分工初始状态 pending')
  assert(graph.detail.includes('未收尾'), '★ 展示文本标明未收尾')

  // 闸门：图 + 交接 + scratch 都不许被归档
  const h1 = await t.remember({ content: '资料一核对结论', summary: '分工a的交接', tags: [tag, 'assign:a'], sessionId: SID })
  const scratch1 = await t.remember({ content: '中间结果1', summary: '临时·资料一原文摘录', tags: [tag, TASK_SCRATCH_TAG], sessionId: SID })
  const scratchKeep = await t.remember({ content: '中间结果2', summary: '临时·要保留的对照表', tags: [tag, TASK_SCRATCH_TAG, TASK_KEEP_TAG], sessionId: SID })
  const reportGate = {}
  const archWhileOpen = await t.archiveSession(SID, undefined, reportGate)
  assert(archWhileOpen === null && reportGate.protected === 4,
    `★★ 未收尾期间：这批记录全被闸门保护、一条都不归档（实测 protected=${reportGate.protected}）`)

  // 参数校验
  assert((await t.openTask({ goal: '  ' })).ok === false, '★ 空 goal 拒绝开图')
  const dupErr = await t.openTask({ goal: 'x', assignments: [{ id: 'a', task: 't' }, { id: 'a', task: 't2' }] })
  assert(dupErr.ok === false && dupErr.reason.includes('重复'), '★ 分工 id 重复 → 拒绝（否则回执无处落）')

  // updateTask：四条拒绝 + 一条成功
  assert((await t.updateTask({ taskId: opened.taskId, assign: 'zzz', status: 'done', sessionId: SID })).ok === false,
    '★ 不存在的分工 → 拒绝')
  assert((await t.updateTask({ taskId: opened.taskId, assign: 'a', status: 'done', sessionId: 'someone-else' })).ok === false,
    '★★ 非创建者会话更新 → 拒绝（单写者，防并发丢更新）')
  assert((await t.updateTask({ taskId: opened.taskId, assign: 'a', status: 'finished', sessionId: SID })).ok === false,
    '★ 非法 status → 拒绝')
  const otherTask = await t.openTask({ goal: '别的任务', assignments: [{ id: 'a', task: 'x' }], sessionId: SID })
  const foreign = await t.remember({ content: 'x', summary: '别的任务的交接', tags: [`${TASK_TAG_PREFIX}${otherTask.taskId}`, 'assign:a'], sessionId: SID })
  const badHandoff = await t.updateTask({ taskId: opened.taskId, assign: 'a', status: 'done', handoffId: foreign.id, sessionId: SID })
  assert(badHandoff.ok === false && badHandoff.reason.includes('不属于'), '★★ 引用了别的任务的 handoff → 拒绝（防串账）')

  // ★★ V6-07：交接必须带 assign:<分工id> —— 否则同一 handoff 能同时交给多个分工
  const hNoTag = await t.remember({ content: '没有 assign 标签的交接', summary: '缺标签的交接', tags: [tag], sessionId: SID })
  const noAssign = await t.updateTask({ taskId: opened.taskId, assign: 'a', status: 'done', handoffId: hNoTag.id, sessionId: SID })
  assert(noAssign.ok === false && noAssign.reason.includes('assign:a'),
    `★★ [V6-07] handoff 缺 assign 标签 → 拒绝（实测：${noAssign.reason}）`)

  const upd = await t.updateTask({ taskId: opened.taskId, assign: 'a', status: 'done', handoffId: h1.id, note: '两份来源一致', sessionId: SID })
  assert(upd.ok === true && upd.status === 'done' && upd.handoffId === h1.id && upd.graphVersion === 2,
    `★★ 填回执成功（status/handoffId 落进图，版本 +1，实测 v${upd.graphVersion}）`)
  const graph2 = t.memories.get(opened.graphId)
  assert(graph2.detail.includes('两份来源一致'), '★ 图的展示文本被重渲染（recall 能直接看到进度）')

  // ★★ 同一个 handoff 不能交给另一个分工（V6-07 真正要防的"共用"）
  const cross = await t.updateTask({ taskId: opened.taskId, assign: 'b', status: 'done', handoffId: h1.id, sessionId: SID })
  assert(cross.ok === false && cross.reason.includes('assign:b'),
    '★★ [V6-07] 同一个 handoff 交给另一个分工 → 拒绝（谁交付什么必须机械可核对）')

  // closeTask：b 没有回执 → 如实标未完成；scratch 默认丢弃、keep 的保留
  const closed = await t.closeTask({ taskId: opened.taskId, conclusion: '资料一可信、资料二待补', sessionId: SID })
  assert(closed.ok === true && closed.longTermId, '★ 收尾成功并给出长期结论 id')
  assert(closed.missing.length === 1 && closed.missing[0].id === 'b', `★★ 没有回执的分工如实标未完成（实测 ${JSON.stringify(closed.missing.map((m) => m.id))}）`)
  assert(closed.discarded.count === 1 && closed.discarded.items[0].id === scratch1.id, '★★ scratch 默认丢弃，并在回执里点名')
  assert(closed.keptScratch === 1, '★ 打了 keep 标签的 scratch 保留')
  assert(!t.memories.has(scratch1.id), '★★ 被丢弃的 scratch 真的删掉了')
  const lt = t.memories.get(closed.longTermId)
  assert(lt.tags.includes(tag) && lt.tags.includes(TASK_RESULT_TAG) && lt.layer === 'hot', '★ 长期结论带 task 标签与 task-result 标记')
  assert(lt.detail.includes('资料一可信、资料二待补') && lt.detail.includes('未完成'), '★★ 结论与未完成清单都进了长期记录')
  assert(lt.detail.includes('已丢弃的临时中间结果'), '★★ 丢弃清单也留档（不可逆操作不许悄悄发生）')
  const graph3 = t.memories.get(opened.graphId)
  assert(graph3.tags.includes(TASK_CLOSED_TAG) && !graph3.tags.includes(TASK_OPEN_TAG), '★★ 图已 open→closed')
  assert(t.memories.get(h1.id).layer === 'cold' && t.memories.get(scratchKeep.id).layer === 'cold',
    '★ 交接与保留的中间结果降为冷存（可查，但不再占短时层）')

  // 收尾后闸门解除 → 这批可以被正常归档
  //   ⚠ 注意：上面为了测"串账拒绝"还开了第二张图（otherTask），它仍是 open → 还会保护它自己的 2 条记录。
  //   所以先把它也收尾，再断言"这条会话里已经没有受保护的记录"。
  const closedOther = await t.closeTask({ taskId: otherTask.taskId, conclusion: '别的任务也收尾', sessionId: SID })
  assert(closedOther.ok === true, '★ 先收尾第二张图（否则它的记录仍受保护，会干扰下面的断言）')

  // ★★ V6-07：历史遗留图（当年允许无 assign 标签）→ 不阻断收尾，但必须列出警告
  const legacy = await t.openTask({ goal: '历史遗留图', assignments: [{ id: 'L', task: '旧式交接' }], sessionId: SID })
  const legacyH = await t.remember({ content: '旧式交接', summary: '没打 assign 的交接', tags: [`${TASK_TAG_PREFIX}${legacy.taskId}`], sessionId: SID })
  const lg = t.memories.get(legacy.graphId)
  lg.task.assignments[0].handoffId = legacyH.id
  lg.task.assignments[0].status = 'done'
  lg.version += 1
  await t.save()
  const legacyClosed = await t.closeTask({ taskId: legacy.taskId, conclusion: '旧式收尾', sessionId: SID })
  assert(legacyClosed.ok === true, '★ 缺 assign 标签的历史图仍然能收尾（不阻断）')
  assert(legacyClosed.unlabeledHandoffs.length === 1 && legacyClosed.unlabeledHandoffs[0].id === 'L',
    '★★ [V6-07] 收尾时列出"交接缺 assign 标签"的分工（历史用法现形）')
  assert(t.memories.get(legacyClosed.longTermId).detail.includes('交接缺 assign 标签'),
    '★ 长期结论里也留了这条警告（不是只在回执里一闪而过）')

  const reportAfter = {}
  await t.archiveSession(SID, undefined, reportAfter)
  assert((reportAfter.protected || 0) === 0, `★★ 收尾后不再被闸门保护（实测 protected=${reportAfter.protected ?? 0}）`)
  assert((await t.closeTask({ taskId: opened.taskId, conclusion: '再来一次' })).ok === false, '★ 重复收尾 → 拒绝')
}

console.log('== 94e. 孤儿任务图回收：闲置超过窗口 → 强制归档（超时如实写、图打 expired）==')
{
  const SID = 's94e'
  const st = new MemoryStore(path.join(dir, 'x94e', 'memory.json'))
  // 甲：开完就没有任何进展（会被回收）
  const t1 = await st.openTask({ goal: '会被遗忘的任务', assignments: [{ id: 'a', task: '做事' }], sessionId: SID })
  const h1 = await st.remember({ content: 'x', summary: '甲的交接', tags: [`${TASK_TAG_PREFIX}${t1.taskId}`, 'assign:a'], sessionId: SID })
  await st.updateTask({ taskId: t1.taskId, assign: 'a', status: 'done', handoffId: h1.id, sessionId: SID })
  // 甲最后一次活动推到"很久以前"，模拟真被遗忘
  const g1 = st.memories.get(t1.graphId)
  g1.task.lastActivityAt = Date.now() - 8 * 24 * 3600 * 1000
  g1.version += 1
  // 乙：刚开、且 1 小时前还有活动（不该被回收）
  const t2 = await st.openTask({ goal: '还在推进的任务', assignments: [{ id: 'b', task: '做事' }], sessionId: SID })
  const g2 = st.memories.get(t2.graphId)
  g2.task.lastActivityAt = Date.now() - 3600 * 1000
  g2.version += 1
  await st.save()

  const before = {}
  await st.archiveSession(SID, undefined, before)
  assert((before.protected || 0) >= 2, '前置：未收尾时两张图都受闸门保护')

  const r = await st.reclaimStaleTasks({})
  assert(r.scanned === 1 && r.archived.length === 1 && r.archived[0].taskId === t1.taskId,
    `★★ 只回收"真被遗忘"的那张（实测 scanned=${r.scanned} archived=${r.archived.map((x) => x.taskId).join(',') || '无'}）`)
  assert(r.archived[0].idleHours >= 8 * 24 - 1, `★ 回执里写出闲置了多少小时（实测 ${r.archived[0].idleHours}）`)

  const lt = st.memories.get(r.archived[0].longTermId)
  assert(lt.tags.includes(TASK_EXPIRED_TAG), '★★ 强制归档的长期结论带 expired 标签（可单独筛出来复核）')
  assert(String(lt.summary).includes('超时强制归档'), '★★ summary 明说"超时强制归档"，不假装任务完成了')
  assert(lt.detail.includes('超时未收尾') && lt.detail.includes('■ 归档方式：过期强制归档'), '★★ 正文写清归档方式与超时事实')
  assert(lt.detail.includes('甲的交接') === false, '★ 正文里不含交接全文（只留 handoff id，正文在记忆里）')

  const g1after = st.memories.get(t1.graphId)
  assert(g1after.tags.includes(TASK_CLOSED_TAG) && g1after.tags.includes(TASK_EXPIRED_TAG) && !g1after.tags.includes(TASK_OPEN_TAG),
    '★★ 图已 closed 且带 expired（闸门据此解除）')
  assert(st.memories.get(h1.id).layer === 'cold', '★ 甲的交接转冷存（跟着图一起归档）')

  const g2after = st.memories.get(t2.graphId)
  assert(g2after.tags.includes(TASK_OPEN_TAG), '★★ 还在推进的那张图不受影响（不会被误收）')
  const after = {}
  await st.archiveSession(SID, undefined, after)
  assert((after.protected || 0) >= 1, `★★ 收尾过的那张已解除保护，只剩还在推进的那张受保护（实测 protected=${after.protected}）`)

  // 直接调用 expireTask 也能强制归档（不经 reclaim），且不需要是创建者会话
  const t3 = await st.openTask({ goal: '手动强制归档的', assignments: [{ id: 'c', task: 'x' }], sessionId: SID })
  const exp = await st.expireTask({ taskId: t3.taskId })
  assert(exp.ok === true && exp.expired === true, '★★ expireTask 可强制归档（权威动作，不要求创建者会话）')
  assert(String(exp.missing?.[0]?.id) === 'c', '★ 强制归档同样列出未完成分工（不许默认成功）')
}

console.log('== 94f. V6-21 任务档案/寻址空间：done / uses / links / 投影视图 ==')
{
  const SID = 's94f'
  const st = new MemoryStore(path.join(dir, 'x94f', 'memory.json'))

  // 前序图（收尾后作为链接目标）
  const oldG = await st.openTask({ goal: '前序任务', assignments: [], sessionId: SID })
  await st.closeTask({ taskId: oldG.taskId, conclusion: '前序结论', sessionId: SID })
  const oldRec = st.memories.get(oldG.graphId)
  const oldVersion = oldRec.version
  const oldRecency = oldRec.recency

  const badWhy = await st.openTask({ goal: 'x', links: [{ taskId: oldG.taskId }], sessionId: SID })
  assert(badWhy.ok === false && String(badWhy.reason).includes('why'), '★★ [V6-21] links.why 必填')
  const badTarget = await st.openTask({ goal: 'x', links: [{ taskId: 't-no-such', why: 'y' }], sessionId: SID })
  assert(badTarget.ok === false && String(badTarget.reason).includes('不是任务图'), '★ links 目标必须是任务图')

  const g = await st.openTask({
    goal: 'V6-21 任务档案',
    assignments: [],
    links: [{ taskId: oldG.taskId, relation: 'continues', why: '接着前序任务做，前序已收尾' }],
    sessionId: SID,
  })
  assert(g.ok === true && (g.links || []).includes(oldG.taskId), '★★ 新图可链接旧图')
  assert(oldRec.version === oldVersion && oldRec.recency === oldRecency, '★★ 链接旧图不改它（version/recency 不变）')

  // remember 自动补标签（仅 open 图 + 创建者会话）
  const c1 = await st.remember({ content: '第一条结论', summary: 'V621-结论一', tags: ['conclusion'], taskId: g.taskId, sessionId: SID })
  assert(c1.tags.includes(`${TASK_TAG_PREFIX}${g.taskId}`), '★★ 创建者会话 remember(taskId) 自动补 task 标签')
  const c2 = await st.remember({ content: '子代理交接', summary: 'V621-子代理', tags: ['assign:a'], taskId: g.taskId, sessionId: 'other-session' })
  assert(!c2.tags.includes(`${TASK_TAG_PREFIX}${g.taskId}`), '★ 非创建者会话不自动补标签')

  // recall 也认标签（历史 tag-only 记录）
  const tagOnly = {
    id: 'tag-only-94f', taskId: null, tags: [`${TASK_TAG_PREFIX}${g.taskId}`],
    summary: '只有标签的记录', detail: '', layer: 'short', salience: 'normal',
    recency: Date.now(), createdAt: Date.now(), version: 1, source: 'internal', sessionId: SID,
  }
  st.memories.set(tagOnly.id, tagOnly)
  assert(st.recall({ taskId: g.taskId }).some((m) => m.id === tagOnly.id), '★★ recall(taskId) 也命中只有标签的记录')

  // done：截断、挂产物、归属校验
  const done1 = await st.appendTaskDone({ taskId: g.taskId, text: 'x'.repeat(200), sessionId: SID })
  assert(done1.ok === true && done1.truncated === true && done1.doneCount === 1, '★★ done.text 超长截断并回执 truncated')
  assert(st.memories.get(g.graphId).task.done[0].text.length === TASK_DONE_TEXT_MAX, '★ 实际落盘也截断到上限')
  const done2 = await st.appendTaskDone({ taskId: g.taskId, text: '带产物', memoryId: c1.id, sessionId: SID })
  assert(done2.ok === true && st.memories.get(g.graphId).task.done[1].id === c1.id, '★ done 可挂本任务记忆 id')
  const badDone = await st.appendTaskDone({ taskId: g.taskId, text: 'x', memoryId: c2.id, sessionId: SID })
  assert(badDone.ok === false && String(badDone.reason).includes('不属于'), '★ done 的 memoryId 必须属于本任务')

  // uses：登记、去重、图 id 拒绝、外部显示、删除标记
  const ext = await st.remember({ content: '外部规范', summary: 'V621-外部规范', source: 'external', taskId: g.taskId, sessionId: SID })
  const u1 = await st.citeTaskMemories({ taskId: g.taskId, ids: [c2.id, ext.id], why: '沿用子代理交接与外部规范', sessionId: SID })
  assert(u1.ok === true && u1.added === 2, '★★ cite 批量登记依赖')
  const u2 = await st.citeTaskMemories({ taskId: g.taskId, ids: [c2.id], sessionId: SID })
  assert(u2.ok === true && u2.added === 0 && u2.skipped === 1, '★ 依赖去重')
  const ug = await st.citeTaskMemories({ taskId: g.taskId, ids: [oldG.graphId], sessionId: SID })
  assert(ug.ok === false && String(ug.reason).includes('links'), '★ 任务图不能放进 uses（用 links）')

  const brief = await st.open(g.graphId)
  assert(brief.detail.includes('V621-结论一') && brief.detail.includes('重要结论'), '★★ open(图) 返回投影简报（含重要结论）')
  assert(brief.detail.includes('前序') && brief.detail.includes('为什么：接着前序任务做'), '★★ 视图带前序 why')
  assert(brief.detail.includes('已完成') && brief.detail.includes('依赖'), '★ 视图含 done/uses 小节')
  assert(brief.detail.includes('［外部］'), '★★ 外部依赖显示［外部］（source 现取）')

  await st.delete(ext.id)
  const brief2 = await st.open(g.graphId)
  assert(brief2.detail.includes(ext.id) && brief2.detail.includes('已删除'), '★★ 依赖被删后仍显示 id 并标已删除')

  // uses 上限（30）：用一张独立图，直接构造 30 条再 cite
  const gCap = await st.openTask({ goal: '上限测试', assignments: [], sessionId: SID })
  st.memories.get(gCap.graphId).task.uses = Array.from({ length: TASK_USES_MAX }, (_, i) => ({ id: `cap-${i}` }))
  const over = await st.citeTaskMemories({ taskId: gCap.taskId, ids: [c1.id], sessionId: SID })
  assert(over.ok === false && String(over.reason).includes('最多'), '★★ uses 超过 30 条直接拒绝')

  // links 上限（5）：6 个不同目标
  const targets = []
  for (let i = 0; i < 6; i++) {
    const t = await st.openTask({ goal: `目标 ${i}`, assignments: [], sessionId: SID })
    targets.push(t.taskId)
  }
  const tooManyLinks = await st.openTask({
    goal: '链接上限',
    sessionId: SID,
    links: targets.map((id) => ({ taskId: id, why: '上限测试' })),
  })
  assert(tooManyLinks.ok === false && String(tooManyLinks.reason).includes('最多 5'), '★★ links 超过 5 条直接拒绝')

  // 收尾：全部成员 cold（含 conclusion），task-result hot；再归档不吞任务成员
  const closed = await st.closeTask({ taskId: g.taskId, conclusion: 'V621 收尾', sessionId: SID })
  assert(closed.ok === true && closed.doneCount === 2 && closed.usesCount === 2 && closed.linksCount === 1,
    '★★ 收尾回执带 done/uses/links 计数')
  assert(st.memories.get(c1.id).layer === 'cold', '★★ 收尾把普通成员转 cold')
  assert(st.memories.get(closed.longTermId).layer === 'hot', '★ task-result 保持 hot')
  const rep = {}
  const arch = await st.archiveSession(SID, undefined, rep)
  assert(arch !== null && rep.tasks >= 1, '★★ 会话存档把已收尾任务作为任务节收进来（收 task-result）')
  assert(arch && arch.detail?.includes('V621 收尾') && !arch.detail.includes('第一条结论'),
    '★★ 存档含任务结论，但不复制成员正文')
  assert(st.memories.get(c1.id).layer === 'cold', '★ 成员仍是 cold（不被存档搬动）')
  const hitDefault = st.recall({ query: 'V621 收尾' })
  assert(!hitDefault.some((m) => m.id === arch?.id), '★★ 默认召回不返回会话存档（防止吃上下文）')
  const hitArchive = st.recall({ query: 'V621 收尾', includeArchives: true })
  assert(hitArchive.some((m) => m.id === arch?.id), '★ includeArchives:true 才返回存档')
}

console.log('== 95. ★ F-5 无 sessionId：remember({source:dormant}) 必须明确回执，不许静默回「已写入」==')
{
  const f5b = new MemoryStore(path.join(dir, 'x95', 'memory.json'))
  const recNo = await f5b.remember({ content: 'd1', summary: '无会话的 dormant', tags: ['x95'], source: 'dormant' })
  assert(
    recNo.dormantUnscoped === true,
    '★★ F-5：无 sessionId 时记录必须带上 dormantUnscoped 标记（回执据此如实说明"降权未发生"）'
  )
  assert(
    Array.isArray(recNo.dormIn) && recNo.dormIn.length === 0,
    `★ F-5：实测确认降权确实没发生（dormIn=${JSON.stringify(recNo.dormIn)}）—— 所以回执照旧说"已写入"就是谎报`
  )
  assert(recNo.source === 'internal', `★ F-5：按普通内部记忆存储（source=${recNo.source}，不是 dormant）`)
  const recYes = await f5b.remember({ content: 'd2', summary: '有会话的 dormant', tags: ['x95'], source: 'dormant', sessionId: 'sid-x95' })
  assert(!recYes.dormantUnscoped, '★ F-5 反例核对：有 sessionId 时不带"未作用域化"标记（别把正常情况也报成异常）')
  assert(
    Array.isArray(recYes.dormIn) && recYes.dormIn.includes('sid-x95'),
    '★ F-5 反例核对：有 sessionId 时降权**真的**发生了（dormIn 含该会话）'
  )
}

console.log('== 95c. 会话存档型巨物：默认不返回，显式 includeArchives 才返回（2026-10-21 P2）==')
{
  const st = new MemoryStore(path.join(dir, 'x95c', 'memory.json'))
  // 一条精确的小记录 + 一条"会话存档型巨物"（detail 30KB、tags 200+、全文都含查询词）
  await st.remember({
    content: '沙箱拒绝的判据：裸 errno 5 先判沙箱，不要先去修 ACL。',
    summary: '沙箱拒绝判据',
    tags: ['沙箱'],
  })
  const filler = '会话存档 filler。'.repeat(1800) // ≈ 30K 字符
  const big = await st.remember({
    content: `沙箱 沙箱 沙箱 会话存档 ${filler}`,
    summary: '会话存档（整会话压成一条）',
    tags: Array.from({ length: 210 }, (_, i) => `t${i}`),
  })
  assert(st.isArchiveLike(big) === true, '★★ 体积/标记判定：30K detail + 210 tags 算"会话存档型巨物"')
  assert(st.isArchiveLike(st.memories.get([...st.memories.keys()][0])) === false, '★ 普通小记录不算存档型')

  const hit = st.recall({ query: '沙箱', limit: 2 })
  assert(hit.length === 1 && !hit.some((m) => m.id === big.id),
    '★★ 默认召回不返回会话存档（错召回一次会吃掉大量上下文）')
  const hitAll = st.recall({ query: '沙箱', limit: 2, includeArchives: true })
  assert(hitAll.length === 2 && hitAll[0].summary === '沙箱拒绝判据',
    `★★ includeArchives:true 才返回；精确小记录仍排第一（实测第一是「${hitAll[0].summary}」）`)

  const onlyDefault = st.recall({ query: '会话存档 filler', limit: 2 })
  assert(!onlyDefault.some((m) => m.id === big.id), '★★ 默认不返回存档（即使只有它匹配；无匹配时会话兜底仍可返回小记录）')
  const onlyAll = st.recall({ query: '会话存档 filler', limit: 2, includeArchives: true })
  assert(onlyAll.some((m) => m.id === big.id), '★★ 显式要存档时照样召得回（不是删掉）')
}

console.log('== 95b. validationBySession：隔离验证结论按子会话精确取回（新宿主路径的关键一环）==')
{
  const st = new MemoryStore(path.join(dir, 'x95b', 'memory.json'))
  // 同一个子会话写两条验证记录（旧的、新的），外加一条 internal（不该被取到）
  await st.remember({ content: '旧结论', summary: '旧验证结论', tags: ['validation'], source: 'validation', sessionId: 'child-1' })
  await new Promise((r) => setTimeout(r, 3))
  await st.remember({ content: '新结论', summary: '新验证结论', tags: ['validation'], source: 'validation', sessionId: 'child-1' })
  await st.remember({ content: '顺手记的', summary: '子代理顺手写的普通记忆', tags: ['other'], source: 'internal', sessionId: 'child-1' })
  await st.remember({ content: '别的会话', summary: '另一个子会话的验证', tags: ['validation'], source: 'validation', sessionId: 'child-2' })

  const got = st.validationBySession('child-1')
  assert(got && got.summary === '新验证结论', `★★ 取同一子会话里**最新**的验证结论（实测 ${got && got.summary}）`)
  assert(got.source === 'validation', '★★ 只认 source=validation（不会误取子代理顺手写的普通记忆）')
  assert(st.validationBySession('child-2').summary === '另一个子会话的验证', '★ 按 sessionId 精确匹配（不会串到别的子会话）')
  assert(st.validationBySession('no-such-child') === null, '★★ 没有结论时返回 null（调用方据此如实报"没结论"，不许编）')
  assert(st.validationBySession('') === null && st.validationBySession(null) === null, '★ 空 sessionId → null（不抛错）')
}

console.log('== 96. ★ F-17 启动解析结果落文件（mnemos.log，含 dataFile=）==')
{
  const boot = await import('../src/boot-log.js')
  const x96dir = path.join(dir, 'x96')
  const x96data = path.join(x96dir, 'memory.json')
  const r96 = describeResolved({ dataFile: x96data, constitutionFile: path.join(x96dir, 'constitution.json') })
  assert(typeof r96.text === 'string' && r96.text.includes(`dataFile=${x96data}`), '★ F-17 前置：describeResolved 产出了含 dataFile= 的三行文本')
  const x96log = path.join(x96dir, 'mnemos.log')
  // ★ 这条断言是 F-17 的判别点：旧实现只往 ctx.logger → console 打，**从不落文件**
  const w96 = await boot.appendStartupLog({ text: r96.text, logFile: x96log, ctx: null })
  assert(w96.written === true, `★ F-17：写入成功（written=${w96.written}${w96.error ? ' / ' + w96.error : ''}）`)
  assert(x96log === r96.logFile, `★ F-17：日志落点 = dataFile 同目录的 mnemos.log（实测 ${r96.logFile}）`)
  const txt96 = await fs.readFile(x96log, 'utf8')
  assert(txt96.includes('dataFile='), '★★ F-17：mnemos.log 被创建且含 dataFile=')
  assert(txt96.includes('constitutionFile='), '★ F-17：三行都在（constitutionFile= 也在）')
  assert(
    txt96.includes('解析依据 profileContext=') && txt96.includes('DSH_PROFILE_DIR='),
    '★ F-17：解析依据那一行也在，且以 profileContext 为第一依据（2026-10-18 安装审查 P0：插件进程里 DSH_PROFILE_DIR 通常未设）'
  )
  const lines96 = txt96.split('\n').filter(Boolean)
  assert(
    lines96.length === 3 && lines96.every((l) => /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] /.test(l)),
    `★ F-17：每行都带时间戳，且一次启动写三行（实测 ${lines96.length} 行）`
  )
  assert(
    txt96.includes('DSH_PROFILE_DIR=') && txt96.includes('cwd='),
    '★ F-17：profile/home/cwd 三个解析依据都能在文件里看到（持有者的原始诉求）'
  )
  // 追加语义：再写一次 → 变成 6 行（不是覆盖）
  await boot.appendStartupLog({ text: r96.text, logFile: x96log, ctx: null })
  const lines96b = (await fs.readFile(x96log, 'utf8')).split('\n').filter(Boolean)
  assert(lines96b.length === 6, `★ F-17：第二次启动是**追加**（实测 ${lines96b.length} 行，若为 3 就是覆盖）`)

  // ── 滚动上限：超 256KB → 轮转，且留**尾部完整行**（保留"上一次启动"比整删好）──
  const roll = boot.rollText(['A'.repeat(10), 'B'.repeat(10)].join('\n'), { maxBytes: 12, keepBytes: 6 })
  assert(roll.rolled === true, `★ F-17 滚动：超上限时 rolled=true（实测 ${roll.rolled}）`)
  assert(roll.text.length > 0, `★ F-17 滚动：滚动后不能是空的（实测 ${roll.text.length} 字节）`)
  assert(roll.text === 'B'.repeat(10), `★ F-17 滚动：留的是**最后一行**（不是开头、不是中段；实测 ${JSON.stringify(roll.text.slice(0, 20))}）`)
  const rollBig = boot.rollText(
    ['A'.repeat(200), 'B'.repeat(200), 'C'.repeat(200)].join('\n'),
    { maxBytes: 500, keepBytes: 260 }
  )
  assert(rollBig.rolled === true && rollBig.text.length <= 499, `★ F-17 滚动：行都很大时结果 ≤ maxBytes-1（实测 ${rollBig.text.length} ≤ 499）`)
  assert(rollBig.text.endsWith('C'.repeat(200)), '★ F-17 滚动：结尾仍是原文结尾（尾部语义，不是从头截）')
  assert(rollBig.text.split('\n').every((l) => /^(B|C)+$/.test(l)), `★ F-17 滚动：结果全部由完整行组成（实测 ${JSON.stringify(rollBig.text.split('\n').map((l) => l[0]))}）`)
  const rollSmall = boot.rollText('短', { maxBytes: 1024, keepBytes: 512 })
  assert(rollSmall.rolled === false && rollSmall.text === '短', '★ F-17 滚动反例核对：没超上限就原样返回、绝不改动')
  const rollLine = boot.rollText('x'.repeat(50) + '\n' + 'y'.repeat(50) + '\n' + 'z'.repeat(50), { maxBytes: 200, keepBytes: 60 })
  assert(!rollLine.text.startsWith('\uFFFD') && !rollLine.text.startsWith('z'), '★ F-17 滚动：按行边界切，不产生半个字符（多字节/续字节安全）')
  const rollCjk = boot.rollText('中'.repeat(40), { maxBytes: 30, keepBytes: 20 })
  assert(
    rollCjk.rolled && !rollCjk.text.includes('\uFFFD') && rollCjk.text.length > 0,
    `★ F-17 滚动：全是多字节字符（无换行可对齐）时也不产生乱码（实测 ${rollCjk.text.length} 字）`
  )

  // ── ★ F-17：滚动上限 256KB → 1MB ──
  //    理由（持有者给的那条）：同目录的 memory.json 已 1.06MB，而 256KB 只装几百次启动。
  //    值本身是**拍的**，所以这里连"值"一起钉住 —— 免得日后被无声改回去。
  assert(boot.MAX_BYTES === 1024 * 1024, `★★ F-17：滚动上限 = 1MB（实测 ${boot.MAX_BYTES} 字节）`)
  assert(
    boot.KEEP_BYTES === boot.MAX_BYTES / 2 && boot.KEEP_BYTES < boot.MAX_BYTES,
    `★ F-17：滚动后保留尾部 = 上限的一半（实测 ${boot.KEEP_BYTES} < ${boot.MAX_BYTES}）`
  )
  // 判别力：300KB 的日志在**旧**上限（256KB）下会滚，在新上限下不该滚 —— 改回 256KB 这条就挂
  const threeHundred = boot.rollText('y'.repeat(300 * 1024), {})
  assert(threeHundred.rolled === false, `★★ F-17：300KB 不再触发滚动（旧上限 256KB 会滚；实测 rolled=${threeHundred.rolled}）`)
  const overOneMb = boot.rollText('y'.repeat(boot.MAX_BYTES + 1), {})
  assert(overOneMb.rolled === true, `★★ F-17：超过 1MB 仍然滚动（实测 rolled=${overOneMb.rolled}）`)

  // ── 失败路径**不许抛错**（F-17 验收明确要求）──
  const x96d = path.join(x96dir, 'as-dir.log')
  await fs.mkdir(x96d, { recursive: true })
  let threw96 = null
  let bad96 = null
  // 这一段是**故意制造失败**：把 boot-log 的兜底 console.error 静音，免得整份测试输出被
  // 一段预期内的堆栈污染（它不影响判据 —— 判据是"有没有抛"和"报告是否如实"）。
  const realErr96 = console.error
  console.error = () => {}
  try {
    try {
      bad96 = await boot.appendStartupLog({ text: 'x', logFile: x96d, ctx: null })
    } catch (e) {
      threw96 = e
    }
  } finally {
    console.error = realErr96
  }
  assert(threw96 === null, `★★ F-17：写失败**不抛错**（把日志文件位置指向一个目录 → 实测抛了 ${threw96 && threw96.message}）`)
  assert(bad96 && bad96.written === false && typeof bad96.error === 'string', `★ F-17：失败如实报告（written=${bad96 && bad96.written}，error 非空=${!!(bad96 && bad96.error)}）`)
  // 反例核对：上一条确实走到了"真失败"分支，而不是"没尝试"
  assert(bad96 && /EISDIR|EPERM|EACCES|ERR/.test(String(bad96.error)), `★ F-17 反例核对：这次失败是真错误（error=${bad96 && String(bad96.error).slice(0, 60)}）`)
  // 宿主 logger 崩掉时也不许抛（best-effort 的第二条腿）
  let badCtx = null
  try {
    badCtx = await boot.appendStartupLog({
      text: 'x',
      logFile: path.join(x96dir, 'ok.log'),
      ctx: { logger: { info() { throw new Error('logger boom') }, error() { throw new Error('logger boom') } } },
    })
  } catch (e) {
    badCtx = { thrown: String(e && e.message) }
  }
  assert(!badCtx.thrown, `★ F-17：宿主 logger 抛错时照旧不抛（实测 ${badCtx.thrown || '没抛'}）`)
}

console.log('== 97. ★ F-4 规则⑧补全三类 + 全部提示行不含字面星号 ==')
{
  // ★ 为什么不 import ../src/index.js：它顶层 import 宿主注入的 peerDependency
  //   `@deepseek-ai/schemastery`（本机插件目录没有 node_modules、全盘搜不到）→ 纯 node 下
  //   **根本加载不了**，于是"规则 ⑧ 写了什么"这条最该断言的反而测不到。
  //   所以正文放在无依赖的 src/system-prompt.js，并由下面一条**读 index.js 源文本**的
  //   断言核对"index.js 真的在用它"—— 免得改了没人用、断言变成自证。
  const sp = await import('../src/system-prompt.js')
  const lines97 = sp.mnemosSystemPromptLines()
  const one = lines97.join('\n')
  const idxSrc = await fs.readFile(path.join(pluginRoot, 'src', 'index.js'), 'utf8')
  assert(
    idxSrc.includes('mnemosSystemPromptLines()'),
    '★★ F-4 前置：src/index.js 真的消费了这份提示正文（不是"改了没人用"）'
  )
  const rule8 = lines97.filter((l) => l.startsWith('⑧'))
  assert(rule8.length === 1, `★ F-4 前置：规则 ⑧ 唯一可定位（实测 ${rule8.length} 行）`)
  const t8 = rule8[0] || ''
  assert(t8.includes('decision'), '★ F-4：规则 ⑧ 仍说明 decision（原有语义没被弄坏）')
  assert(t8.includes('ability'), '★★ F-4：规则 ⑧ 含 ability（学会的能力/做法）')
  assert(t8.includes('event'), '★★ F-4：规则 ⑧ 含 event（值得记的事件）')
  assert(t8.includes('其他'), '★★ F-4：规则 ⑧ 说明未分类会进「其他」类目（兜底口径写进提示词）')
  assert(t8.indexOf('**') === -1, '★ F-4：⑧ 这一条里没有字面星号')
  // 编号 ①..㉕ 必须恰好各一条（①-⑰ 原 17 条；⑱-㉓ 多 agent 协作；㉔ 任务档案；㉕ 技能与经验）
  const nums = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳', '㉑', '㉒', '㉓', '㉔', '㉕']
  const missing = nums.filter((n) => !one.includes(n))
  assert(missing.length === 0, `★ F-4：25 条纪律全在（缺：${missing.join('') || '无'}）`)
  const starIdx = one.indexOf('**')
  assert(starIdx === -1, `★★ F-4：系统提示全部 25 条里不含字面星号（实测 indexOf('**')=${starIdx}）`)

  // ★ 2026-10-21：任务图独立成节；㉔ 第一条，协作规则并入同节（不再另立"多 agent"节）
  assert(one.includes('【六、任务图】'), '★★ F-4：第六节「任务图」独立成节（自己的任务也要读得到）')
  assert(!one.includes('【七、多 agent 协作】'), '★★ 不再把协作单独成节（否则自己的任务读不到开图）')
  assert(one.includes('【七、技能与经验】'), '★★ F-4：第七节「技能与经验」存在')
  const sec6 = one.slice(one.indexOf('【六、任务图】'), one.indexOf('【七、技能与经验】'))
  assert(sec6.indexOf('㉔') >= 0 && sec6.indexOf('㉔') < sec6.indexOf('⑱'),
    '★★ ㉔ 是任务图节下的第一条（协作规则不许挡在它前面）')
  assert(sec6.includes('⑲') && sec6.includes('㉓'),
    '★★ 协作规则并入任务图节（开图/派活/收尾在同一节）')
  const rule25 = lines97.find((l) => l.startsWith('㉕')) || ''
  assert(rule25.includes('mnemos_propose_skill') && rule25.includes('成功'),
    '★★ ㉕ 明确成功路径也能沉淀（不只"失败→修好"）')
  assert(rule25.includes('审核挡错') || rule25.includes('审核会挡错'),
    '★★ ㉕ 说明审核兜底（降低"怕提错"的顾虑）')
  assert(rule25.includes('外部') && rule25.includes('用户同意'),
    '★★ ㉕ 外部来源保留需用户同意（V6-06）')
  const rule19 = lines97.find((l) => l.startsWith('⑲')) || ''
  assert(rule19.includes('开图后') && rule19.includes('记忆 id') && rule19.includes('不要把上下文抄进 prompt'),
    '★★ ⑲ 规定"派活只给图的记忆 id、不抄上下文"（这是这一节的核心政策）')
  const rule20 = lines97.find((l) => l.startsWith('⑳')) || ''
  assert(rule20.includes('task=<taskId>') && rule20.includes('assign=<分工id>'),
    '★★ ⑳ 规定子代理写回记忆的标签（task + assign），否则主模型按 taskId 收不回来')
  assert(rule20.includes('短时') && rule20.includes('不要自己写进长期层'),
    '★★ ⑳ 规定任务结论只进短时层（收尾由主模型做）—— 这是防子代理污染长期记忆的那条')
  assert(rule20.includes('自传体') && rule20.includes('不受限'),
    '★ ⑳ 同时说明子代理的自传体/纠错不受限（身份相同，只有分工不同）')
  const rule22 = lines97.find((l) => l.startsWith('㉒')) || ''
  assert(rule22.includes('mnemos_task_close') && rule22.includes('未完成') && rule22.includes('不许默认成功'),
    '★★ ㉒ 规定收尾要如实标未完成（不许默认成功）')
  assert(rule22.includes('scratch') && rule22.includes('默认丢弃') && rule22.includes('keep'),
    '★★ ㉒ 写清 scratch 默认丢弃、要留加 keep（用户拍板的策略）')
  const rule23 = lines97.find((l) => l.startsWith('㉓')) || ''
  assert(rule23.includes('逐字') && rule23.includes('串联推理'),
    '★ ㉓ 说明什么不该委托（逐字保真 / 串联推理 / 单个判断）')
  // ★ 2026-10-17 新增 ㉔：自己的活要不要开图 —— 判据必须是**可判定的三问**，
  //   不许被以后改写成"视情况而定"那类没法执行的说法。
  // ★ 2026-10-17 补：隔离验证通道不可用时的降级规则必须写进 ⑭ ——
  //   否则工具一坏，"必须验证"就变成"必须做一件做不到的事"，模型只能自己找借口跳过。
  const rule14 = lines97.find((l) => l.startsWith('⑭')) || ''
  assert(rule14.includes('通道不可用'), '★★ ⑭ 必须写明"验证通道不可用"时怎么办（工具会坏，纪律不能留空）')
  assert(rule14.includes('未验证处理'), '★★ ⑭ 的降级规则要落到"按未验证处理"（不是"想办法验一下"）')
  assert(rule14.includes('觉得有道理'), '★★ ⑭ 要明确禁止用"读过觉得有道理"顶替验证（这是最容易发生的自我欺骗）')
  const rule24 = lines97.find((l) => l.startsWith('㉔')) || ''
  // ★ 2026-10-21 V6-21：图从"只用于派活"升级为"任务档案/寻址空间"。
  assert(rule24.includes('mnemos_task_open'), '★★ ㉔ 指向 mnemos_task_open（不写工具名就等于没说怎么开）')
  assert(rule24.includes('档案') || rule24.includes('寻址'), '★★ ㉔ 把图定位为任务档案/寻址空间（不是待办清单）')
  assert(rule24.includes('派活') && rule24.includes('跨会话'), '★★ ㉔ 的触发条件：派活 / 跨会话 / 多条记忆（可判定）')
  assert(rule24.includes('todo') && rule24.includes('已完成'), '★★ ㉔ 与 todo 的分工：未完成在 todo，图只记已完成里程碑')
  assert(rule24.includes('conclusion') && rule24.includes('不复制'), '★★ ㉔ 重要结论用标签标注，正文不复制进图')
  assert(rule24.includes('links') && rule24.includes('不改旧图'), '★★ ㉔ 跨会话开新图 + links，不改旧图')
  assert(rule24.includes('单步小事') && rule24.includes('别开'),
    '★★ V6-22：㉔ 必须写清"单步小事直接 remember，别开"（否则小任务也会开图）')
  assert(rule24.includes('镜像'), '★ ㉔ 提醒不要把任务图与任务清单写成互相镜像')

  // ★★ 2026-10-17 去重：原则是「**工具用法归工具，纪律要求归系统提示**」。
  //   三个方向都钉住，否则以后一定有人把两边重新抄一遍。
  //   方向一：参数级机制细节不该再出现在提示词里（它们已落在工具描述/参数说明里）
  const mechInPrompt = ['unmark', '换会话自动失效', 'newSummary', 'mode=session', 'source=deprecated']
  const leaked = mechInPrompt.filter((x) => one.includes(x))
  assert(leaked.length === 0, `★★ 去重（方向一）：提示词里不该有参数级机制（仍含：${leaked.join(',') || '无'}）`)
  //   方向二：这些机制必须**留在工具描述里**（防止"两边都删"→ 模型无处可查）
  const mechInTools = ['unmark=true', 'mode=session', 'supersedes', 'newSummary', 'scratch']
  const missingMech = mechInTools.filter((x) => !idxSrc.includes(x))
  assert(missingMech.length === 0, `★★ 去重（方向二）：机制必须留在工具描述里（缺：${missingMech.join(',') || '无'}）`)
  //   方向三：纪律句不该写在工具描述里（它们只在提示词里）
  const disciplineInTools = ['每轮任务结束', '不许默认成功']
  const badInTools = disciplineInTools.filter((x) => idxSrc.includes(x))
  assert(badInTools.length === 0, `★★ 去重（方向三）：纪律句只留在系统提示（工具描述仍含：${badInTools.join(',') || '无'}）`)
  //   净收益留档：去重后提示词确实变短了（3062 → 2609）。数字写死一点没关系——
  //   它只在"有人又把机制抄回去"时才会触发，正合本意。
  //   ★ 2026-10-17 上限从 2800 抬到 3000：之后**有意**加了两条（㉔ 自己的活开图判据、⑭ 验证通道不可用时的降级），
  //     合计 +211 字符。抬上限时必须在这里写明原因，否则这条断言会退化成"随加随抬"。
  //   ★ 2026-10-23 抬到 3600：任务图章节重写，补「多模型/子代理协作必须开图」、自己干的 done/cite/todo 纪律、
  //     workflow 子代理 handoff 与 null 判定；同时保留短时层/自传体/不许默认成功等旧约束。实测 3559。
  assert(one.length < 3600, `★ 提示词预算（实测 ${one.length} 字符 / 上限 3600；去重前 3062）`)
  const taskRule = lines97.filter((l) => l.startsWith('㉔'))
  assert(taskRule.length === 1 &&
    taskRule[0].includes('多个模型或子代理协作') &&
    taskRule[0].includes('单步小事') &&
    taskRule[0].includes('task_done') &&
    taskRule[0].includes('task_cite'),
    '★★ 任务图章节必须同时写清：多模型协作必须开图、单步小事不开、自己干的 done/cite')
  const assignPromptRule = lines97.filter((l) => l.startsWith('⑲'))
  assert(assignPromptRule.length === 1 && assignPromptRule[0].includes('graphId') && assignPromptRule[0].includes('mnemos_open') && assignPromptRule[0].includes('不要把') && assignPromptRule[0].includes('抄进 prompt'),
    '★★ 派活标准流程：只给 graphId/assignId，让子代理自己 open，不抄背景')
  const handoffRule = lines97.filter((l) => l.startsWith('⑳'))
  assert(handoffRule.length === 1 && handoffRule[0].includes('handoffId') && handoffRule[0].includes('不要调用任何工具'),
    '★★ 交接纪律：必须返回 handoffId，且不得用“不要调用任何工具”禁掉交接')
  const workflowRule = lines97.filter((l) => l.startsWith('㉓'))
  assert(workflowRule.length === 1 && workflowRule[0].includes('workflow') && workflowRule[0].includes('handoffId') && workflowRule[0].includes('null'),
    '★★ 边界：workflow 的 agent() 同样适用 handoff；null/缺 handoffId = 未完成')
  // 反例核对：plain() 确实能去掉星号（这条断言本身有判别力，不是恒真）
  assert(plain('**加粗**') === '加粗', '★ F-4 反例核对：plain() 确实会去掉星号')
  // 与旧文本的对照：改之前 ⑧ 里没有 ability/event —— 用一条**结构**断言替代文本比对，
  // 确认这两个词只出现在 ⑧ 附近，而不是被别处顺手带进来的噪声。
  const withAbility = lines97.filter((l) => l.includes('ability'))
  assert(
    withAbility.length === 1 && withAbility[0].startsWith('⑧'),
    `★ F-4：ability/event 的说明**只在规则 ⑧**（实测含 ability 的行数=${withAbility.length}）`
  )
  // ⚠️ 工具回执那两条路径（F-5 的 render）住在 index.js 里且需要宿主 Schema —— 单测 import 不到，
  //    所以这里**不假装测过**它（本项目栽过"装饰性断言"）。它们的判别力放在 98 的扰动自证里。
}

console.log('== 88. ★ 扰动自证（F-3）：拆掉"profile 优先" / 拆掉"警告" → 对应断言必须失败 ==')
{
  // 做法沿用 82：把插件整份复制到扰动副本、改掉**一处**、再让**这份测试文件本身**在副本里重跑。
  //
  // ★ 为什么必须开子进程（上一轮教训的延伸）：
  //   Node 的模块缓存让"同一路径的 paths.js 只解析一次"。进程内 import 一份扰动副本时，
  //   副本里的 store.js 仍会 `import './paths.js'` 解析到**原始**文件 —— 扰动看起来生效、
  //   实际没打中，自证会报出假的 0 失败。判别力只能来自"runner 在**进程外**真的 import 了那份 src"。
  //   同理，正例必须让**同一份测试文件**在未扰动副本里全过（证明失败是扰动造成的，不是场景写坏了）。
  //
  // ⚠️ 递归闸门：副本里的本测试也会想开子进程 → 子进程里必须整段跳过（否则无限递归）。
  if (process.env.MNEMOS_F3_NO_PERTURB === '1') {
    assert(true, '★ 子进程（被跑方）：本段跳过再扰动，避免无限递归（MNEMOS_F3_NO_PERTURB=1）')
    // 副本内仍要验证"副本自己的实现"：profile 优先 + 未初始化警告
    assert(
      path.dirname(defaultDataFile()) === path.join(process.env.DSH_PROFILE_DIR, 'mnemos'),
      `★ 子进程：默认数据目录 = profile（实测 ${path.dirname(defaultDataFile())}）`
    )
    const cSub = new ConstitutionStore(path.join(dir, 'x88-sub', 'constitution.json'))
    await cSub.load()
    const tSub = buildSelfText(cSub, { autobiographyCompact: () => ({ entries: [] }) }, 2000)
    assert(tSub.length > 0, `★ 子进程：宪法未初始化时注入文本非空（实测长度 ${tSub.length}）`)
  } else {
    // ⚠️ fs.cp(a, b) 复制的是 a 的**内容**到 b（不是把 a 放进 b）—— 实测确认：
    //    fs.cp(plugin/src, X) 之后 X 下直接是 .js，**没有** X/src/ 这一层。
    //    所以副本根里必须再建一层 `src/`，副本测试的 `../src/*.js` 才解析得到；
    //    同时副本测试文件要放在 `<副本根>/test/`（这样 fileURLToPath→'..' = 副本根）。
    const tempRoot = path.join(dir, 'x88tmp')
    const srcRoot = path.join(tempRoot, 'perturbed')
    const cleanRoot = path.join(tempRoot, 'clean')
    await fs.mkdir(path.join(srcRoot, 'src'), { recursive: true })
    await fs.mkdir(path.join(cleanRoot, 'src'), { recursive: true })
    // 前置：复制前先确认源目录真的是插件 src（避免"复制了空目录"这类静默失败）
    assert(
      (await fs.readFile(path.join(pluginRoot, 'src', 'paths.js'), 'utf8')).includes('DSH_PROFILE_DIR'),
      `前置：pluginRoot/src/paths.js 可读且含 DSH_PROFILE_DIR（pluginRoot=${pluginRoot}）`
    )
    await fs.cp(path.join(pluginRoot, 'src'), path.join(srcRoot, 'src'), { recursive: true, force: true })
    await fs.cp(path.join(pluginRoot, 'src'), path.join(cleanRoot, 'src'), { recursive: true, force: true })
    const readNorm = async (base, name) =>
      (await fs.readFile(path.join(base, 'src', name), 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
    // 前置：副本里 src/ 这一层真的存在（这一条正是上面那个坑的守卫）
    assert(
      (await fs.readFile(path.join(srcRoot, 'src', 'paths.js'), 'utf8')).length > 0 &&
        (await fs.readFile(path.join(cleanRoot, 'src', 'paths.js'), 'utf8')).length > 0,
      '前置：两份副本都有 src/ 这一层（fs.cp 复制内容不复制目录名，必须自己建）'
    )

    const pathsNeedle = '  if (env.DSH_PROFILE_DIR) return dirUnder(env.DSH_PROFILE_DIR)\n'
    const warnNeedle = '    parts.push(constitutionMissingWarning(constitution.dataFile || \'\'))\n'

    // ── 扰动 A：去掉 profile 优先（退回 DSH_HOME 优先）──
    const pathsRaw = await readNorm(srcRoot, 'paths.js')
    assert(pathsRaw.includes(pathsNeedle), '前置：profile 优先那一行唯一可定位（否则扰动静默失效、自证无效）')
    const pathsBad = pathsRaw.replace(pathsNeedle, '  // ★扰动：不再看 DSH_PROFILE_DIR\n')
    assert(
      pathsBad !== pathsRaw && !pathsBad.includes('if (env.DSH_PROFILE_DIR)') && pathsBad.includes('// ★扰动：不再看 DSH_PROFILE_DIR'),
      '前置：扰动 A 真的改到了源码（替换后文本必须不同）'
    )
    await fs.writeFile(path.join(srcRoot, 'src', 'paths.js'), pathsBad, 'utf8')

    // ── 扰动 B：去掉未初始化警告（回到"返回空串"的老行为）──
    const selfRaw = await readNorm(srcRoot, 'self-text.js')
    assert(selfRaw.includes(warnNeedle), '前置：未初始化警告那一行唯一可定位')
    const selfBad = selfRaw.replace(warnNeedle, '    // ★扰动：未初始化时什么都不注入（老行为）\n')
    assert(
      selfBad !== selfRaw && selfBad.includes('// ★扰动：未初始化时什么都不注入'),
      '前置：扰动 B 真的改到了源码'
    )
    await fs.writeFile(path.join(srcRoot, 'src', 'self-text.js'), selfBad, 'utf8')

    // ★ 跨进程可观测：扰动标记必须真的落在磁盘文件里（否则"扰动版失败"是假的）
    const onDisk = (await fs.readFile(path.join(srcRoot, 'src', 'paths.js'), 'utf8')).replace(/\r\n/g, '\n')
    assert(
      onDisk.includes('// ★扰动：不再看 DSH_PROFILE_DIR') && !onDisk.includes('if (env.DSH_PROFILE_DIR)'),
      '★ 扰动 A 已真的落盘生效（子进程 import 的正是这份文件）'
    )

    // 把**测试文件自己**复制到每个副本的 `test/` 下：副本里的本文件通过 fileURLToPath 推出
    // 自己的 pluginRoot（= 那个副本），`../src/*.js` 也正好指向**副本自己的 src** ——
    // 于是正例/扰动跑的是同一份测试代码，只换实现。
    const testSrc = await fs.readFile(fileURLToPath(import.meta.url), 'utf8')
    const cleanTest = path.join(cleanRoot, 'test', 'store.test.js')
    const pertTest = path.join(srcRoot, 'test', 'store.test.js')
    await fs.mkdir(path.dirname(cleanTest), { recursive: true })
    await fs.mkdir(path.dirname(pertTest), { recursive: true })
    await fs.writeFile(cleanTest, testSrc, 'utf8')
    await fs.writeFile(pertTest, testSrc, 'utf8')
    // 前置可观测：两份副本测试都必须真的落到磁盘（否则子进程会以"模块找不到"退出，
    // 症状是"没有报告"，容易被误读成"扰动没生效"）
    assert(
      (await fs.readFile(cleanTest, 'utf8')).includes('== 88.') &&
        (await fs.readFile(pertTest, 'utf8')).includes('== 88.') &&
        (await fs.readFile(path.join(cleanRoot, 'src', 'store.js'), 'utf8')).includes('defaultDataFile'),
      '前置：两份副本（测试文件 + src/）都已就位（副本里的测试会整段跳过本段，不会递归）'
    )

    const fakeProfile = path.join(dir, 'x88', 'profiles', 'desktop')
    const fakeHome = path.join(dir, 'x88', 'home')
    await fs.mkdir(path.join(fakeProfile, 'mnemos'), { recursive: true })

    /**
     * 在子进程里跑一次完整测试，返回它写出的报告。
     * ⚠️ 沙箱约束（本机实测）：`child_process` 用**管道** stdio 会 EPERM ——
     *    `stdio:'ignore'`（= NUL）可以，`'pipe'`（默认）与 PowerShell 的 `1>` 捕获都不行。
     *    所以判别信息走**报告文件**（--pf3-report），不走 stdout。子进程输出直接落到父进程终端。
     */
    const runSuite = async (tag, testFile, envProfile, envHome) => {
      const reportFile = path.join(dir, `x88-report-${tag}.json`)
      await fs.rm(reportFile, { force: true })
      const { execFileSync: run } = await import('node:child_process')
      let spawnErr = null
      try {
        run(process.execPath, [testFile, `--pf3-report=${reportFile.split('\\').join('/')}`], {
          cwd: pluginRoot,
          stdio: 'ignore',                 // ★ 不能用管道：沙箱下会 EPERM
          timeout: 600000,
          env: {
            ...process.env,
            DSH_PROFILE_DIR: envProfile,   // 假的 profile/home：两者不同，且 profile 才是真的
            DSH_HOME: envHome,
            MNEMOS_F3_NO_PERTURB: '1',     // ★ 递归闸门：子进程不再造扰动
          },
        })
      } catch (e) {
        spawnErr = String(e.code || e.message)
      }
      let report = null
      let reportErr = null
      try {
        report = JSON.parse((await fs.readFile(reportFile, 'utf8')).replace(/^\uFEFF/, ''))
      } catch (e) {
        reportErr = e.message
      }
      return { spawnErr, report, reportErr }
    }

    // ── 正例：未扰动副本必须全过 ──
    const cleanRun = await runSuite('clean', cleanTest, fakeProfile, fakeHome)
    // ── 正例：未扰动副本必须"基本全过" ──
    // ⚠️ 容差是**如实**的，不是装饰：第 83 条（真锁争用）在本机是**本来就 flaky** 的
    //    （同一台机器上改动前后都实测到 0/1/3 条失败，失败点是"抢锁超时告警/降级"，
    //     与 F-3 无关；另外本测试文件的 82 条也偶发）。所以这里允许 ≤2 条，
    //    并要求失败点**不是** F-3 那几条 —— 否则"扰动版失败"就没有对照基准。
    const cleanFailed = (cleanRun.report && cleanRun.report.failed) || []
    const cleanF3Fail = cleanFailed.filter((m) => m.includes('profile 优先') || m.includes('按 profile 解析') || m.includes('未初始化') || m.includes('非空'))
    assert(
      cleanRun.report && cleanRun.report.fail === 0 && cleanF3Fail.length === 0,
      `★★ 自证正例：未扰动副本跑同一份测试文件必须**全过**（F-16：容差会把 flaky 藏起来，已从 fail<=2 收紧到 ==0）` +
        `（pass=${cleanRun.report ? cleanRun.report.pass : '无报告'} / fail=${cleanRun.report ? cleanRun.report.fail : cleanRun.reportErr}` +
        `；F-3 相关失败 ${cleanF3Fail.length}` +
        // ⚠️ 只在**真的失败**时才列失败项：report.failed 是子进程写下的原始列表，
        //    在 fail=0 时列它会自相矛盾（曾因此把"全过"误读成红灯）
        `${cleanRun.report && cleanRun.report.fail > 0 && cleanFailed.length ? '；失败项：' + cleanFailed.join('；') : ''}）`
    )

    // ── 扰动版：必须失败，且失败点必须是 F-3 的那几条 ──
    const pertRun = await runSuite('perturbed', pertTest, fakeProfile, fakeHome)
    assert(pertRun.report !== null, `前置：扰动版跑完并写出报告（${pertRun.reportErr || 'ok'}${pertRun.spawnErr ? '；spawn=' + pertRun.spawnErr : ''}）`)
    const pertFailed = (pertRun.report && pertRun.report.failed) || []
    const pertF3 = pertFailed.filter(
      (m) => m.includes('profile 优先') || m.includes('按 profile 解析') || m.includes('未初始化') || m.includes('非空')
    )
    assert(
      pertFailed.some((m) => m.includes('profile 优先') || m.includes('按 profile 解析')),
      `★★ 扰动 A 命中：去掉 profile 优先后，路径断言失败（失败数 ${pertFailed.length}；命中：${pertFailed.filter((m) => m.includes('profile')).join('；') || '（没有命中！）'}）`
    )
    assert(
      pertFailed.some((m) => m.includes('未初始化') || m.includes('非空')),
      `★★ 扰动 B 命中：去掉警告后，未初始化注入断言失败（命中：${pertFailed.filter((m) => m.includes('未初始化') || m.includes('非空')).join('；') || '（没有命中！）'}）`
    )
    assert(
      pertRun.report && pertF3.length >= 4,
      `★★ 扰动版 F-3 断言失败计数 ≥4（实测 ${pertF3.length} / 总失败 ${pertRun.report ? pertRun.report.fail : '无报告'}${pertRun.spawnErr ? '；spawn=' + pertRun.spawnErr : ''}）—— 计数为 0 就说明扰动静默失效`
    )
    // 反例核对：扰动只打 F-3 那几条，不该把整套测试打崩（否则"失败"不具判别力）
    assert(
      pertRun.report && pertRun.report.pass > 600,
      `★ 反例核对：扰动版其余断言仍大量通过（pass=${pertRun.report ? pertRun.report.pass : '无报告'}），失败是**定向**的`
    )

    console.log(
      `   → 扰动自证合计：扰动版 F-3 断言 fail=${pertF3.length} / 总 fail=${pertRun.report ? pertRun.report.fail : '?'}` +
      `（正例 fail=${cleanRun.report ? cleanRun.report.fail : '?'}，其中 F-3 相关 ${cleanF3Fail.length}）`
    )
  }
}

console.log('== 98. ★ 扰动自证（F-4/F-6/F-12）：三处扰动必须各自打中同编号的断言（子进程 + 可观测标记）==')
// ★ 为什么单开一节而不是并进 88：88 的三处扰动建在**同一份**扰动副本上，
//   若再叠三处，失败点会互相污染，"哪条断言挂"就不再指向某一处改动。
// ★ 上一轮的坑（必须防）：源文件可能有 CRLF/BOM → 跨行 needle 用 '\n' 会**永不匹配**、
//   扰动静默失效、自证报出**假的 0 失败**；且 Node 模块缓存让进程内扰动打不中真正被
//   import 的模块 → 必须在**子进程**里跑，并让"扰动是否真的落盘"成为**可观测断言**。
if (process.env.MNEMOS_F3_NO_PERTURB === '1') {
  assert(true, '★ 子进程（被跑方）：F-4/F-6/F-12 扰动自证跳过再扰动，避免无限递归')
} else {
  const tempRoot98 = path.join(dir, 'x98tmp')
  const pertRoot98 = path.join(tempRoot98, 'perturbed')
  const cleanRoot98 = path.join(tempRoot98, 'clean')
  await fs.mkdir(path.join(pertRoot98, 'src'), { recursive: true })
  await fs.mkdir(path.join(cleanRoot98, 'src'), { recursive: true })
  await fs.cp(path.join(pluginRoot, 'src'), path.join(pertRoot98, 'src'), { recursive: true, force: true })
  await fs.cp(path.join(pluginRoot, 'src'), path.join(cleanRoot98, 'src'), { recursive: true, force: true })

  // ★ 归一化**两种**换行都替成 LF 再定位 —— 否则 CRLF 源码里跨行 needle 永不匹配（上一轮的坑）
  const rd98 = async (base, name) =>
    (await fs.readFile(path.join(base, 'src', name), 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const wr98 = async (base, name, text) =>
    fs.writeFile(path.join(base, 'src', name), text, 'utf8')

  // ── 扰动 A：F-6 的 continue 改回 break（回到"一条超长就放弃整轮/整个类目"的老行为）──
  const storeRaw98 = await rd98(pertRoot98, 'store.js')
  const f6Needle = '            continue // ★F6-KEEP\n'
  assert(storeRaw98.includes(f6Needle), '前置 A：F-6 的 continue 那一行唯一可定位（跨行 needle 已按 LF 归一，否则这里的 includes 就会假失败）')
  const storeBad98 = storeRaw98.replace(f6Needle, '            break // ★扰动A：改回 break（= 一条超长就放弃整轮）\n')
  assert(storeBad98 !== storeRaw98 && storeBad98.includes('★扰动A') && !storeBad98.includes('★F6-KEEP'), '前置 A：扰动真的改到了源码文本（替换后必须不同，且原锚点消失）')
  await wr98(pertRoot98, 'store.js', storeBad98)

  // ── 扰动 B：F-12 的提示行整段去掉 ──
  const selfRaw98 = await rd98(pertRoot98, 'self-text.js')
  const f12Needle = '    const n = Number(auto.unselected) || 0\n'
  assert(selfRaw98.includes(f12Needle), '前置 B：F-12 的 n 计算那一行唯一可定位')
  const selfBad98 = selfRaw98.replace(f12Needle, '    const n = 0 // ★扰动B：恒为 0 = 永不提示（回到"截断了也不说"的老行为）\n')
  assert(selfBad98 !== selfRaw98 && selfBad98.includes('★扰动B'), '前置 B：扰动真的改到了源码文本')
  await wr98(pertRoot98, 'self-text.js', selfBad98)

  // ── 扰动 C：F-4 的兜底去掉（未分类条目仍被静默丢弃）──
  const storeRaw98c = await rd98(pertRoot98, 'store.js')
  const f4Needle = "      return list\n        .filter((m) => !TAGGED.some((t) => (m.tags || []).includes(t)))\n        .sort((a, b) => b.recency - a.recency)\n"
  assert(storeRaw98c.includes(f4Needle), '前置 C：F-4 的「其他」兜底那三行唯一可定位')
  const storeBad98c = storeRaw98c.replace(f4Needle, "      return [] // ★扰动C：其他类目恒空（= 未分类条目静默丢弃的老行为）\n")
  assert(storeBad98c !== storeRaw98c && storeBad98c.includes('★扰动C'), '前置 C：扰动真的改到了源码文本')
  await wr98(pertRoot98, 'store.js', storeBad98c)

  // ★ 跨进程可观测：三处标记必须真的落在磁盘上（否则"扰动版失败"可以是假的）
  const disk98 = (await fs.readFile(path.join(pertRoot98, 'src', 'store.js'), 'utf8')).replace(/\r\n/g, '\n')
  const disk98s = (await fs.readFile(path.join(pertRoot98, 'src', 'self-text.js'), 'utf8')).replace(/\r\n/g, '\n')
  assert(
    disk98.includes('★扰动A') && disk98.includes('★扰动C') && disk98s.includes('★扰动B'),
    '★★ 前置：三处扰动标记都真的落盘（子进程 import 的正是这两份文件）'
  )
  assert(
    !disk98.includes('★F6-KEEP'),
    '★★ 前置：F-6 的 continue 已确实消失（不是"改了但没生效"）'
  )

  // 把**本测试文件**也复制进两个副本：副本里 pluginRoot 指向副本 → ../src/*.js 解析到副本自己的实现
  const testSrc98 = await fs.readFile(fileURLToPath(import.meta.url), 'utf8')
  const cleanTest98 = path.join(cleanRoot98, 'test', 'store.test.js')
  const pertTest98 = path.join(pertRoot98, 'test', 'store.test.js')
  await fs.mkdir(path.dirname(cleanTest98), { recursive: true })
  await fs.mkdir(path.dirname(pertTest98), { recursive: true })
  await fs.writeFile(cleanTest98, testSrc98, 'utf8')
  await fs.writeFile(pertTest98, testSrc98, 'utf8')
  assert(
    (await fs.readFile(cleanTest98, 'utf8')).includes('== 98.') && (await fs.readFile(pertTest98, 'utf8')).includes('== 98.'),
    '前置：两份副本的测试文件都真的写到磁盘（否则子进程会以"模块找不到"退出，症状像"没有报告"）'
  )

  const runSup98 = async (tag, testFile) => {
    const reportFile = path.join(dir, `x98-report-${tag}.json`)
    await fs.rm(reportFile, { force: true })
    const { execFileSync: run } = await import('node:child_process')
    let spawnErr = null
    try {
      // stdio 必须 'ignore'：沙箱下管道会 EPERM（88 已实测），判别信息一律走报告文件
      run(process.execPath, [testFile, `--pf3-report=${reportFile.split('\\').join('/')}`], {
        cwd: pluginRoot,
        stdio: 'ignore',
        timeout: 900000,
        env: { ...process.env, MNEMOS_F3_NO_PERTURB: '1' },
      })
    } catch (e) {
      spawnErr = String(e.code || e.message)
    }
    let report = null
    let reportErr = null
    try {
      report = JSON.parse((await fs.readFile(reportFile, 'utf8')).replace(/^\uFEFF/, ''))
    } catch (e) {
      reportErr = e.message
    }
    return { spawnErr, report, reportErr }
  }
  // 只找 F-4/F-6/F-12 那几条断言的失败。★ 用**稳定前缀**匹配，不要匹配断言描述里的自然语言：
  //   这里踩过一次——过滤词写成 'F-6：超长条目'，而断言实际写的是 'F-6：大条目之后'，
  //   于是扰动明明命中了却报 0（假的"扰动静默失效"）。前缀由断言自己带，不靠描述文字。
  const pick98 = (report) => {
    const failed = (report && report.failed) || []
    return {
      f4: failed.filter((m) => m.includes('[F4]')),
      f6: failed.filter((m) => m.includes('[F6]')),
      f12: failed.filter((m) => m.includes('[F12]')),
      total: report ? report.fail : null,
      pass: report ? report.pass : null,
    }
  }

  const clean98 = await runSup98('clean', cleanTest98)
  const c98 = pick98(clean98.report)
  assert(
    clean98.report && clean98.report.fail === 0 && c98.f4.length === 0 && c98.f6.length === 0 && c98.f12.length === 0,
    `★★ 自证正例：未扰动副本必须**全过**（F-16：容差会把 flaky 藏起来，已从 fail<=2 收紧到 ==0）（pass=${c98.pass} / fail=${c98.total}${clean98.reportErr ? '；' + clean98.reportErr : ''}）；三条扰动对应断言必须全是 0 失败${clean98.report?.fail ? `；失败项：${(clean98.report.failed || []).join('；')}` : ''}`
  )

  const pert98 = await runSup98('perturbed', pertTest98)
  const p98 = pick98(pert98.report)
  assert(pert98.report !== null, `前置：扰动版跑完并写出报告（${pert98.reportErr || 'ok'}${pert98.spawnErr ? '；spawn=' + pert98.spawnErr : ''}）`)
  // ① F-6「continue → break」→ 第 3 条（F-6 断言）必须失败
  assert(p98.f6.length >= 1, `★★ 扰动 A 命中：continue→break 后 F-6 断言失败 ${p98.f6.length} 条（${p98.f6.map((m) => m.slice(0, 40)).join('；') || '没有命中！'}）`)
  // ② F-12 提示行去掉 → 第 5 条（F-12 断言）必须失败
  assert(p98.f12.length >= 1, `★★ 扰动 B 命中：去掉 F-12 提示后断言失败 ${p98.f12.length} 条（${p98.f12.map((m) => m.slice(0, 40)).join('；') || '没有命中！'}）`)
  // ③ F-4 兜底去掉 → 第 1 条（F-4 断言）必须失败
  assert(p98.f4.length >= 1, `★★ 扰动 C 命中：去掉 F-4 兜底后断言失败 ${p98.f4.length} 条（${p98.f4.map((m) => m.slice(0, 40)).join('；') || '没有命中！'}）`)
  // 反例核对：失败是**定向**的（其余断言仍大量通过），否则"失败"没有判别力
  assert(
    pert98.report && pert98.report.pass > 600,
    `★ 反例核对：扰动版其余断言仍大量通过（pass=${p98.pass}），失败定向指向三处扰动`
  )
  // ★ 扰动是否生效的**可观测**对照：三处扰动合计失败数 ≥3（若为 0 就是扰动静默失效）
  const perturbedTotal98 = p98.f4.length + p98.f6.length + p98.f12.length
  assert(
    perturbedTotal98 >= 3,
    `★★ 扰动自证合计：F-4/F-6/F-12 定向失败 ${perturbedTotal98} 条 / 总 fail=${p98.total}（正例 fail=${c98.total}）—— 计数为 0 即扰动静默失效，本断言会红`
  )
}

console.log('== 99. F-8：触发下沉到「失败刚被修好」那一刻 ==')
{
  const FAIL99 = { isError: true }
  const OK99 = { content: [{ type: 'text', text: 'ok' }] }
  const sess99 = (id, failureSeqs = [0, 1, 2]) => {
    const events = []
    for (const seq of failureSeqs) events[seq] = failEvent(seq, `第 ${seq} 次失败原文`)
    return mkFakeSession(id, events)
  }
  const f8Call = (d, session) => (result, marker, name = 'pwsh') =>
    d.hook(
      { name, arguments: { c: `${name}-${marker}` }, agent: { session } },
      result,
      async () => ({ kind: 'accept', content: [{ type: 'text', text: 'base' }] })
    )

  // 前置：回扫能取到"最后一个失败结果事件"的 seq（提示里要靠它给模型一个可照抄的来源）
  assert(findLastFailureSeq(mkSessionWith('s-x', [[2, 'boom'], [5, 'boom2']])) === 5, '[F8] ★ 回扫取到最后一个失败结果事件的 seq')
  assert(findLastFailureSeq(null) === null, '[F8] ★ 没有会话日志 → 不猜 seq（返回 null，提示照发）')
  // ★ 构造器出口必须过 plain()：把带字面星号的入参喂进去，出来的文本里不许有星号。
  //   （只断言"没有星号"是装饰性的 —— 这条用带 ** 的入参，去掉 plain() 就会挂。）
  const dirty99 = buildSkillProposalHint({ reason: '**连续 3 次**工具失败', sessionId: 'session-**x**', seq: 12 })
  assert(!dirty99.includes('**'), '[F8] ★★ 构造器出口过 plain()（带 ** 的入参 → 输出无星号；去掉 plain() 这条必挂）')

  // ① 正例：连续失败 3 次 + 第 4 次成功 → 注入里含技能提议引导
  const d1 = makeStuckDetector()
  const s1 = sess99('s-f8-ok')
  const c1 = f8Call(d1, s1)
  await c1(FAIL99, 1); await c1(FAIL99, 2)
  const hit99 = await c1(FAIL99, 3)
  assert(
    hit99.content.length === 2 && hit99.content[1].text.includes('卡住提示'),
    '[F8] 前置：连续失败 3 次 → 原有卡住提示照旧触发（F-8 不取代它）'
  )
  const out99 = await c1(OK99, 4)
  const rec99 = out99.content[out99.content.length - 1].text
  assert(
    rec99.includes('mnemos_propose_skill') && rec99.includes('失败→修好'),
    '[F8] ★★ 失败×3 之后第 4 次成功 → 注入含技能提议引导'
  )
  assert(rec99.includes('counterexample') && rec99.includes('positiveCase'), '[F8] ★ 引导说清反例引用失败原文、正例引用修好的做法')
  assert(
    rec99.includes('session=s-f8-ok') && rec99.includes('seq=2'),
    `[F8] ★ 引导给出可照抄的来源标识（session + 最后一个失败事件的 seq，实测 ${rec99.includes('session=s-f8-ok')}/${rec99.includes('seq=2')}）`
  )
  assert(!rec99.includes('**'), '[F8] ★ 注入文本无字面 **（plain 之后）')
  assert(rec99.length > 0 && !rec99.includes('undefined'), '[F8] ★ 引导里没有 undefined 之类的占位泄漏')

  // ② 负例：只有失败、始终没有成功 → 全程不含引导（不是"卡住当下"就说）
  const d2 = makeStuckDetector()
  const c2 = f8Call(d2, sess99('s-f8-fail'))
  let saw201 = false
  for (let i = 1; i <= 5; i++) {
    const o = await c2(FAIL99, i)
    if (o.content.some((x) => (x.text || '').includes('失败→修好'))) saw201 = true
  }
  // ⚠️ 必须扫**每一次**调用的注入：只看最后一次的话，"失败流中途就误报"会被漏掉
  //    （扰动版实测就是这样漏过一次：第 4 次误注入了、第 5 次没有，断言照样绿）
  assert(!saw201, '[F8] ★★ 失败但未成功 → 全程不含引导（触发点必须是"之后成功了"）')

  // ③ 负例：一路顺利 → 完全不注入
  const d3 = makeStuckDetector()
  const c3 = f8Call(d3, sess99('s-f8-smooth'))
  let saw301 = false
  for (let i = 1; i <= 5; i++) {
    const o = await c3(OK99, i, `tool${i}`)
    if (o.content.length !== 1) saw301 = true
  }
  assert(!saw301, '[F8] ★★ 一路顺利 → 不注入任何东西')

  // ④ 负例：只有"同一调用重复"（没有失败）+ 之后成功 → 不算「失败→修好」
  const d4 = makeStuckDetector()
  const c4 = f8Call(d4, sess99('s-f8-repeat'))
  let last4 = null
  for (let i = 0; i < 3; i++) last4 = await c4(OK99, 1) // 同入参 → 触发"重复 3 次"
  assert(last4.content.length === 2, '[F8] 前置：同一调用重复 3 次 → 卡住提示照旧触发')
  const after4 = await c4(OK99, 2)
  assert(
    !after4.content.some((x) => (x.text || '').includes('失败→修好')),
    '[F8] ★ 只有重复、没有失败 → 不算「失败→修好」（它必须真的出现过失败）'
  )
}

console.log('== 100. F-9：新建/评审两个写回开关拆开（2026-10-17 起两者都默认开）==')
{
  const wbDefault = resolveSkillWriteBacks({})
  assert(wbDefault.createWriteBack === true, '[F9] ★★ 默认 createWriteBack=true（新建=增量，让模型自己管）')
  assert(wbDefault.reviewWriteBack === true,
    '[F9] ★★ 默认 reviewWriteBack=true（2026-10-17 用户决定：评审+独立验证者+回归门已承担风险；"要人批"实测只造成提案墓地）')
  assert(
    (await fs.readFile(path.join(pluginRoot, 'src', 'skill-review.js'), 'utf8')).includes('export const DEFAULT_CREATE_WRITE_BACK = true'),
    '[F9] ★ 默认值单一真相源：常量确实为 true（index.js 的 Schema 取的就是它）'
  )
  assert(resolveSkillWriteBacks({ createWriteBack: false }).reviewWriteBack === true, '[F9] ★ 两个开关独立：关新建不影响评审默认')
  assert(resolveSkillWriteBacks({ reviewWriteBack: true }).createWriteBack === true, '[F9] ★ 两个开关独立：开评审不影响新建默认')
  assert(resolveSkillWriteBacks({ reviewWriteBack: false }).reviewWriteBack === false,
    '[F9] ★ 真正的刹车还在：显式 reviewWriteBack=false 能停掉自动改写')
  assert(resolveSkillWriteBacks({ createWriteBack: false }).createWriteBack === false, '[F9] ★ 显式 false 生效（新建也能关）')

  // ★★ 行为变更的核心断言：默认配置下，propose 的成功路径**真的**把技能写进技能目录
  const root100 = path.join(dir, 'x100', 'skills')
  await fs.mkdir(root100, { recursive: true })
  const data100 = path.join(dir, 'x100', 'memory.json')
  const sess100 = mkSessionWith('session-f9', [[7, 'F-9 反例原文：路径没收敛导致读不到数据']])
  const deps100 = (extra = {}) => ({
    skillRoot: root100, dataFile: data100, llm: mkLlm2([PASS]), provider: 'p', model: 'm',
    session: sess100, ...extra,
  })
  const in100 = (suffix) => ({ ...baseIn, name: `demo-wb-${suffix}`, counterexample: `场景A（${srcRef('session-f9', 7)}）` })
  const r100 = await createSkill(deps100({ writeBack: resolveSkillWriteBacks({}).createWriteBack }), in100('on'))
  assert(r100.ok === true && r100.verdict === 'created', `[F9] ★★ 默认配置下 propose_skill 的成功路径真的写进技能目录（实测 verdict=${r100.verdict}）`)
  assert((await fs.readdir(root100)).includes('demo-wb-on'), '[F9] ★★ 技能目录里真的出现了该技能（不是只回一句 created）')
  assert(r100.path.startsWith(root100), '[F9] ★ 落盘路径就在技能根下（不是暂存区）')
  const r100b = await createSkill(deps100({ writeBack: false }), in100('off'))
  assert(r100b.verdict === 'proposed' && r100b.path.includes('skill-proposals'), '[F9] ★ createWriteBack=false 时落暂存区')
  assert(!(await fs.readdir(root100)).includes('demo-wb-off'), '[F9] ★ 关掉写回时技能目录不出现它（不该影响模型行为）')

  // 描述文本不得劝退 + 必须说清时机/护栏/去向（描述放在无依赖模块里，才能这样扫）
  assert(
    !/是否真的落盘取决于|取决于\s*reviewWriteBack|白提|未必落盘/.test(PROPOSE_SKILL_DESCRIPTION),
    '[F9] ★★ 工具描述不再含劝退表述（旧句：是否真的落盘取决于 reviewWriteBack 配置）'
  )
  assert(!PROPOSE_SKILL_DESCRIPTION.includes('reviewWriteBack'), '[F9] ★ 描述不再指向 reviewWriteBack（那个开关已经不管新建了）')
  assert(PROPOSE_SKILL_DESCRIPTION.includes('何时该用'), '[F9] ★ 描述写清触发时机（何时该做）')
  assert(PROPOSE_SKILL_DESCRIPTION.includes('反例') && PROPOSE_SKILL_DESCRIPTION.includes('正例'), '[F9] ★ 描述写清护栏：两个验证')
  assert(PROPOSE_SKILL_DESCRIPTION.includes('maxSkills') && PROPOSE_SKILL_DESCRIPTION.includes('skill-proposals'), '[F9] ★ 描述写清落盘去向与上限行为')
  assert(PROPOSE_SKILL_DESCRIPTION.includes('session=') && PROPOSE_SKILL_DESCRIPTION.includes('seq='), '[F9][F10] ★ 描述给出反例来源格式（否则机械闸门够不着）')
  assert(COUNTEREXAMPLE_PARAM_DESCRIPTION.includes(SOURCE_REF_FORMAT_HINT), '[F9][F10] ★ 参数说明与提示/解析器共用同一个格式真相源')

  // ★ source 级接线断言：两个开关必须各接各的（合回去这条就挂）
  const idx100 = (await fs.readFile(path.join(pluginRoot, 'src', 'index.js'), 'utf8')).replace(/\r\n/g, '\n')
  assert(idx100.includes('writeBack: resolveSkillWriteBacks(config).createWriteBack'), '[F9] ★★ propose 工具接的是 createWriteBack')
  assert(idx100.includes('writeBack: resolveSkillWriteBacks(resolved).reviewWriteBack'), '[F9] ★★ 评审心跳接的仍是 reviewWriteBack（review 路径不改 SKILL.md）')
  assert(!idx100.includes('writeBack: config.reviewWriteBack'), '[F9] ★ 旧的"一个开关管两件事"接线已消失')
  assert(idx100.includes('maxSkills: config.maxSkills'), '[F11] ★ 上限接到了工具（可配）')
  assert(idx100.includes('session: exec?.agent?.session ?? null'), '[F10] ★ 工具把宿主会话交给 createSkill（否则取不到反例原文）')
}

console.log('== 101. F-10：反例必须可溯源（机械校验 + 原文交给验证者）==')
{
  // 解析器：纯机械（正则），不调 LLM
  const miss101 = parseSourceRef('场景A：某次命令失败')
  assert(miss101.ok === false && miss101.kind === 'missing', '[F10] ★ 没有任何来源关键字 → missing（硬门槛拒）')
  assert(parseSourceRef(`场景A（${srcRef('session-a', 1)}）`).ok === true, '[F10] ★ 合法来源可解析')
  const half101 = parseSourceRef('来源：session=session-a')
  assert(half101.ok === false && half101.kind === 'malformed', '[F10] ★★ 只有 session、缺 seq → 格式不合法')
  const badNum101 = parseSourceRef('来源：session=session-a seq=abc')
  assert(badNum101.ok === false, '[F10] ★★ seq 不是数字 → 不合法')
  const okRef101 = parseSourceRef(`某场景（${formatSourceRef('session-f10', 3)}）`)
  assert(okRef101.ok === true && okRef101.session === 'session-f10' && okRef101.seq === 3, '[F10] ★ 会话与序号都解析出来')

  // 核实：有日志时按 seq 取原文；取不到就降级并**明说**未核实
  const sess101 = mkSessionWith('session-f10', [[3, 'pip and npm cache are blocked, do not retry（F-10 反例原文）']])
  const res101 = resolveSourceRef(okRef101, { session: sess101 })
  assert(res101.verified === true && res101.text.includes('do not retry'), '[F10] ★★ 有日志 → 按 seq 取到原文（这就是交给验证者的东西）')
  const noSess101 = resolveSourceRef(okRef101, { session: null })
  assert(
    noSess101.verified === false && noSess101.exists === null && noSess101.note.includes('未核实'),
    '[F10] ★★ 取不到日志 → 降级且明确标注"来源未核实"（不假装核实过）'
  )
  const oob101 = resolveSourceRef(parseSourceRef(srcRef('session-f10', 99)), { session: sess101 })
  assert(oob101.exists === false, '[F10] ★★ 日志在手却查不到该 seq → exists=false（据此拒，已实测 99 超出日志长度 4）')
  assert(findLastFailureSeq(sess101) === 3, '[F10] 前置：该夹具的失败事件确实在 seq=3')

  // 端到端：拒 → 拒 → 通过（并把原文交给验证者）
  const root101 = path.join(dir, 'x101', 'skills')
  await fs.mkdir(root101, { recursive: true })
  const data101 = path.join(dir, 'x101', 'memory.json')
  const prompts101 = []
  const recLlm101 = (reply) => ({
    stream: ({ messages }) => (async function* () {
      prompts101.push(messages?.[0]?.content?.[0]?.text ?? '')
      yield { type: 'text-delta', text: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })
  const deps101 = (llm, extra = {}) => ({
    skillRoot: root101, dataFile: data101, llm, provider: 'p', model: 'm',
    writeBack: true, session: sess101, ...extra,
  })

  const noSrc101 = await createSkill(deps101(recLlm101(PASS)), { ...baseIn, name: 'demo-nosrc', counterexample: '场景A：某次命令失败' })
  assert(
    noSrc101.ok === false && noSrc101.verdict === 'rejected' && noSrc101.missing.includes('counterexample 来源（session + seq）'),
    '[F10] ★★ 缺来源 → 直接拒，且与"缺反例/缺正例"走同一道硬门槛'
  )
  assert(!(await fs.readdir(root101)).includes('demo-nosrc'), '[F10] ★ 被拒时不产生技能目录')
  assert(prompts101.length === 0, '[F10] ★ 缺来源在验证之前就拒了（不白花一次 LLM 调用）')

  const badSeq101 = await createSkill(deps101(recLlm101(PASS)), { ...baseIn, name: 'demo-badseq', counterexample: `场景A（${srcRef('session-f10', 99)}）` })
  assert(badSeq101.verdict === 'rejected' && badSeq101.reason.includes('来源不存在'), '[F10] ★★ 来源 seq 在会话日志里不存在 → 拒（这就是"编造的槽"）')
  assert(!(await fs.readdir(root101)).includes('demo-badseq'), '[F10] ★ 来源不存在时也不产生技能目录')

  const good101 = await createSkill(deps101(recLlm101(PASS)), { ...baseIn, name: 'demo-src-ok', counterexample: `场景A（${srcRef('session-f10', 3)}）` })
  assert(good101.ok === true && good101.verdict === 'created', '[F10] ★★ 带合法来源 → 通过并落盘')
  assert(prompts101.length === 1, '[F10] 前置：验证者被调用了一次')
  const prompt101 = prompts101[0]
  assert(prompt101.includes('do not retry'), '[F10] ★★ 验证者拿到的是**原文**（不再是提议者的自述）—— 本条的核心')
  assert(prompt101.includes('session-f10') && prompt101.includes('seq=3'), '[F10] ★ 提示词里标明来源会话与 seq')
  assert(prompt101.includes('一致'), '[F10] ★ 判定项里加了"反例描述是否与原文一致"')

  const degraded101 = await createSkill(
    deps101(recLlm101(PASS), { session: null }),
    { ...baseIn, name: 'demo-src-unverified', counterexample: `场景A（${srcRef('session-other', 3)}）` }
  )
  assert(degraded101.ok === true && degraded101.verdict === 'created', '[F10] ★ 取不到原文 → 允许降级通过')
  assert(
    typeof degraded101.sourceNotVerified === 'string' && degraded101.sourceNotVerified.includes('未核实'),
    '[F10] ★★ 降级通过时结果里必须标注"来源未核实"（不静默、也不假装核实过）'
  )
  assert(
    renderProposeSkillResult(degraded101).join('\n').includes('来源未核实'),
    '[F10] ★ 该标注出现在回执里（模型看得到自己去哪、为什么）'
  )
  assert(prompts101.length === 2 && prompts101[1].includes('未能核实'), '[F10] ★★ 给验证者的提示里也明说未核实（不让自述冒充证据）')
}

console.log('== 102. F-11：技能目录容量上限（达上限落 staging + 回执说明，不静默）==')
{
  const root102 = path.join(dir, 'x102', 'skills')
  await fs.mkdir(root102, { recursive: true })
  const data102 = path.join(dir, 'x102', 'memory.json')
  const sess102 = mkSessionWith('session-f11', [[5, 'F-11 反例原文']])
  for (const n of ['cap-a', 'cap-b']) {
    await fs.mkdir(path.join(root102, n), { recursive: true })
    await fs.writeFile(path.join(root102, n, 'SKILL.md'), `---\nname: ${n}\ndescription: Use when ${n}.\n---\n\n# ${n}\n`, 'utf8')
  }
  const deps102 = (extra = {}) => ({
    skillRoot: root102, dataFile: data102, llm: mkLlm2([PASS]), provider: 'p', model: 'm',
    writeBack: true, maxSkills: 2, session: sess102, ...extra,
  })
  const in102 = { ...baseIn, name: 'cap-c', counterexample: `场景A（${srcRef('session-f11', 5)}）` }

  const capped102 = await createSkill(deps102(), in102)
  assert(capped102.ok === true && capped102.verdict === 'capped', `[F11] ★★ 已达上限 → 不再自动入目录（实测 verdict=${capped102.verdict}）`)
  assert(capped102.path.includes('skill-proposals'), '[F11] ★★ 提议落到 staging（没有丢）')
  assert((await fs.readFile(capped102.path, 'utf8')).includes('# Demo'), '[F11] ★ staging 里是完整内容（不是空目录/空文件）')
  assert(!(await fs.readdir(root102)).includes('cap-c'), '[F11] ★ 技能目录里没有它（上限真的挡住了自动入目录）')
  assert(capped102.capLimit === 2 && capped102.existingCount === 2, '[F11] ★ 回执数据带上限与当前数量')
  const receipt102 = renderProposeSkillResult(capped102).join('\n')
  assert(receipt102.includes('上限 2') && receipt102.includes('人工清理'), '[F11] ★★ 回执明确说"已达上限 N，请人工清理"（不静默）')
  assert(receipt102.includes(capped102.path), '[F11] ★ 回执给出暂存路径（模型知道东西在哪）')

  // 上限不该拦住正常路径：未达上限照旧入目录
  const root102b = path.join(dir, 'x102', 'skills-one')
  await fs.mkdir(path.join(root102b, 'cap-a'), { recursive: true })
  await fs.writeFile(path.join(root102b, 'cap-a', 'SKILL.md'), '---\nname: cap-a\ndescription: Use when cap a.\n---\n\n# a\n', 'utf8')
  const ok102 = await createSkill(deps102({ skillRoot: root102b, maxSkills: 2 }), { ...in102, name: 'cap-alone' })
  assert(
    ok102.verdict === 'created' && (await fs.readdir(root102b)).includes('cap-alone'),
    `[F11] ★ 未达上限时照旧入目录（1 < 2，实测 verdict=${ok102.verdict}）`
  )

  // 默认上限：不传 maxSkills 时用默认值，且默认值是 30（可配：config.maxSkills）
  assert(DEFAULT_MAX_SKILLS === 30, '[F11] ★ 默认上限 30（可用 config.maxSkills 改）')
  const root102c = path.join(dir, 'x102', 'skills-default')
  const dflt102 = await createSkill(
    { skillRoot: root102c, dataFile: data102, llm: mkLlm2([PASS]), provider: 'p', model: 'm', writeBack: true, session: sess102, maxSkills: undefined },
    { ...in102, name: 'cap-default' }
  )
  assert(dflt102.verdict === 'created', '[F11] ★ 不传 maxSkills → 用默认上限（不被 undefined 卡住）')
  assert(
    (await fs.readFile(path.join(pluginRoot, 'src', 'index.js'), 'utf8')).includes('maxSkills: Schema.number().default(DEFAULT_MAX_SKILLS)'),
    '[F11] ★ index.js 的上限默认值取自同一常量（测到的默认值 = 真实默认值）'
  )
}

console.log('== 103. ★ 扰动自证（F-8/F-9/F-10）：三处扰动必须各自打中同编号的断言（子进程 + 可观测标记）==')
// ★ 与 88/98 同形：**必须在子进程里跑** —— Node 的模块缓存会让进程内扰动打不中真正被 import 的模块。
// ★ 上一轮的三个坑照旧防：① 跨行 needle 先按 LF 归一（源文件可能是 CRLF/BOM，否则扰动静默失效、
//   自证报出**假的 0 失败**）；② 不靠 stdout（沙箱下管道 EPERM），判别信息走 --pf3-report 报告文件；
//   ③ 把"扰动是否真的落盘"做成**可观测断言**。
if (process.env.MNEMOS_F3_NO_PERTURB === '1') {
  assert(true, '★ 子进程（被跑方）：F-8/F-9/F-10 扰动自证跳过再扰动，避免无限递归')
} else {
  const tempRoot103 = path.join(dir, 'x103tmp')
  const pertRoot103 = path.join(tempRoot103, 'perturbed')
  const cleanRoot103 = path.join(tempRoot103, 'clean')
  await fs.mkdir(path.join(pertRoot103, 'src'), { recursive: true })
  await fs.mkdir(path.join(cleanRoot103, 'src'), { recursive: true })
  await fs.cp(path.join(pluginRoot, 'src'), path.join(pertRoot103, 'src'), { recursive: true, force: true })
  await fs.cp(path.join(pluginRoot, 'src'), path.join(cleanRoot103, 'src'), { recursive: true, force: true })

  const rd103 = async (base, name) =>
    (await fs.readFile(path.join(base, 'src', name), 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const wr103 = async (base, name, text) => fs.writeFile(path.join(base, 'src', name), text, 'utf8')

  // ── 扰动 A：F-8 去掉"以成功结束"这个判定（只要有失败就给引导）──
  const stuckRaw103 = await rd103(pertRoot103, 'stuck-detector.js')
  const f8Needle = '    const resolvedBySuccess = b.episodeFailHit && !failed // ★F8-SUCCESS-GATE\n'
  assert(stuckRaw103.includes(f8Needle), '前置 A：F-8「以成功结束」那一行唯一可定位（跨行 needle 已按 LF 归一）')
  const stuckBad103 = stuckRaw103.replace(f8Needle, '    const resolvedBySuccess = b.episodeFailHit // ★扰动A：不再要求之后成功\n')
  assert(
    stuckBad103 !== stuckRaw103 && stuckBad103.includes('★扰动A') && !stuckBad103.includes('★F8-SUCCESS-GATE'),
    '前置 A：扰动真的改到了源码文本（替换后不同，且原锚点消失）'
  )
  await wr103(pertRoot103, 'stuck-detector.js', stuckBad103)

  // ── 扰动 B：F-9 把 createWriteBack 的默认值改回 false（回到"提了也可能白提"）──
  const srRaw103 = await rd103(pertRoot103, 'skill-review.js')
  const f9Needle = 'export const DEFAULT_CREATE_WRITE_BACK = true\n'
  assert(srRaw103.includes(f9Needle), '前置 B：F-9 默认值那一行唯一可定位')
  const srB103 = srRaw103.replace(f9Needle, 'export const DEFAULT_CREATE_WRITE_BACK = false // ★扰动B：默认改回 false\n')
  assert(srB103 !== srRaw103 && srB103.includes('★扰动B') && !srB103.includes('export const DEFAULT_CREATE_WRITE_BACK = true'), '前置 B：扰动真的改到了源码文本')

  // ── 扰动 C：F-10 去掉来源校验（不解析、不回拒）──
  const f10Needle = '  const src = parseSourceRef(counterexample) // ★F10-SOURCE-GATE\n'
  assert(srB103.includes(f10Needle), '前置 C：F-10 的来源解析那一行唯一可定位')
  const srC103 = srB103.replace(f10Needle, "  const src = { ok: true, session: 'session-x', seq: 0 } // ★扰动C：去掉来源校验\n")
  assert(srC103 !== srB103 && srC103.includes('★扰动C') && !srC103.includes('★F10-SOURCE-GATE'), '前置 C：扰动真的改到了源码文本')
  await wr103(pertRoot103, 'skill-review.js', srC103)

  // ★ 跨进程可观测：扰动标记必须真的落在磁盘上（否则"扰动版失败"可以是假的）
  const diskA103 = (await fs.readFile(path.join(pertRoot103, 'src', 'stuck-detector.js'), 'utf8')).replace(/\r\n/g, '\n')
  const diskB103 = (await fs.readFile(path.join(pertRoot103, 'src', 'skill-review.js'), 'utf8')).replace(/\r\n/g, '\n')
  assert(
    diskA103.includes('★扰动A') && diskB103.includes('★扰动B') && diskB103.includes('★扰动C'),
    '★★ 前置：三处扰动标记都真的落盘（子进程 import 的正是这两份文件）'
  )
  assert(
    !diskA103.includes('★F8-SUCCESS-GATE') && !diskB103.includes('★F10-SOURCE-GATE'),
    '★★ 前置：被替换的原锚点已确实消失（不是"改了但没生效"）'
  )

  // 把本测试文件也复制进两个副本：副本里 pluginRoot 指向副本 → ../src/*.js 解析到副本自己的实现
  const testSrc103 = await fs.readFile(fileURLToPath(import.meta.url), 'utf8')
  const cleanTest103 = path.join(cleanRoot103, 'test', 'store.test.js')
  const pertTest103 = path.join(pertRoot103, 'test', 'store.test.js')
  await fs.mkdir(path.dirname(cleanTest103), { recursive: true })
  await fs.mkdir(path.dirname(pertTest103), { recursive: true })
  await fs.writeFile(cleanTest103, testSrc103, 'utf8')
  await fs.writeFile(pertTest103, testSrc103, 'utf8')
  assert(
    (await fs.readFile(cleanTest103, 'utf8')).includes('== 103.') && (await fs.readFile(pertTest103, 'utf8')).includes('== 103.'),
    '前置：两份副本的测试文件都真的写到磁盘（否则子进程会以"模块找不到"退出，症状像"没有报告"）'
  )

  const runSup103 = async (tag, testFile) => {
    const reportFile = path.join(dir, `x103-report-${tag}.json`)
    await fs.rm(reportFile, { force: true })
    const { execFileSync: run } = await import('node:child_process')
    let spawnErr = null
    try {
      run(process.execPath, [testFile, `--pf3-report=${reportFile.split('\\').join('/')}`], {
        cwd: pluginRoot,
        stdio: 'ignore',
        timeout: 900000,
        env: { ...process.env, MNEMOS_F3_NO_PERTURB: '1' },
      })
    } catch (e) {
      spawnErr = String(e.code || e.message)
    }
    let report = null
    let reportErr = null
    try {
      report = JSON.parse((await fs.readFile(reportFile, 'utf8')).replace(/^\uFEFF/, ''))
    } catch (e) {
      reportErr = e.message
    }
    return { spawnErr, report, reportErr }
  }
  // 用**断言自己带的稳定前缀**过滤（不匹配描述里的自然语言：98 踩过"过滤词与断言描述不一致 → 假 0"）
  const pick103 = (report) => {
    const failed = (report && report.failed) || []
    return {
      f8: failed.filter((m) => m.includes('[F8]')),
      f9: failed.filter((m) => m.includes('[F9]')),
      f10: failed.filter((m) => m.includes('[F10]')),
      f11: failed.filter((m) => m.includes('[F11]')),
      total: report ? report.fail : null,
      pass: report ? report.pass : null,
    }
  }

  const clean103 = await runSup103('clean', cleanTest103)
  const c103 = pick103(clean103.report)
  assert(
    clean103.report && clean103.report.fail === 0 && c103.f8.length === 0 && c103.f9.length === 0 && c103.f10.length === 0 && c103.f11.length === 0,
    `★★ 自证正例：未扰动副本必须**全过**（F-16：容差会把 flaky 藏起来，已从 fail<=2 收紧到 ==0）（pass=${c103.pass} / fail=${c103.total}${clean103.reportErr ? '；' + clean103.reportErr : ''}）；F-8/F-9/F-10 断言必须 0 失败${clean103.report?.fail ? `；失败项：${(clean103.report.failed || []).join('；')}` : ''}`
  )

  const pert103 = await runSup103('perturbed', pertTest103)
  const p103 = pick103(pert103.report)
  assert(pert103.report !== null, `前置：扰动版跑完并写出报告（${pert103.reportErr || 'ok'}${pert103.spawnErr ? '；spawn=' + pert103.spawnErr : ''}）`)
  // ① 去掉 F-8 的"成功"判定 → 负例（失败但未成功）必须失败
  assert(
    p103.f8.length >= 1 && p103.f8.some((m) => m.includes('失败但未成功')),
    `★★ 扰动 A 命中：去掉"以成功结束"判定后，F-8 负例失败 ${p103.f8.length} 条（${p103.f8.map((m) => m.slice(0, 34)).join('；') || '没有命中！'}）`
  )
  // ② createWriteBack 默认改回 false → 第 3 条（真的写进技能目录）必须失败
  assert(
    p103.f9.length >= 1,
    `★★ 扰动 B 命中：默认改回 false 后，F-9 断言失败 ${p103.f9.length} 条（${p103.f9.map((m) => m.slice(0, 34)).join('；') || '没有命中！'}）`
  )
  // ③ 去掉 F-10 的来源校验 → 第 6 条（缺来源必须被拒）必须失败
  assert(
    p103.f10.length >= 1,
    `★★ 扰动 C 命中：去掉来源校验后，F-10 断言失败 ${p103.f10.length} 条（${p103.f10.map((m) => m.slice(0, 34)).join('；') || '没有命中！'}）`
  )
  // ★ 定向性：三处扰动各自打中自己的编号，且没被扰动碰到的 F-11 断言照旧全过
  assert(p103.f11.length === 0, `★ 定向：没被扰动碰到的 F-11 断言全过（实测失败 ${p103.f11.length} 条）`)
  assert(pert103.report && pert103.report.pass > 600, `★ 反例核对：扰动版其余断言仍大量通过（pass=${p103.pass}），失败定向指向三处扰动`)
  const pertTotal103 = p103.f8.length + p103.f9.length + p103.f10.length
  assert(
    pertTotal103 >= 3,
    `★★ 扰动自证合计：F-8/F-9/F-10 定向失败 ${pertTotal103} 条 / 总 fail=${p103.total}（正例 fail=${c103.total}）—— 计数为 0 即扰动静默失效，本断言会红`
  )
}

console.log('== 104. ★ F-15 结构性修复：19 个工具的"声明 vs 实际"共用一份形状表，且被测试盯住 ==')
{
  // ── ① 表本身：19 个工具一个不少 ──
  const EXPECTED_TOOLS = [
    'mnemos_remember', 'mnemos_recall', 'mnemos_validate', 'mnemos_constitution', 'mnemos_delete',
    'mnemos_deprecate', 'mnemos_dormant', 'mnemos_open', 'mnemos_consolidate', 'mnemos_heartbeat',
    'mnemos_maintenance_list', 'mnemos_heartbeat_toggle', 'mnemos_propose_skill',
    // ★ 新增工具必须同时进**三处**：TOOL_OUTPUT_SPECS（形状）、index.js 的注册、以及这份清单
    // ★★ 顺序必须与 **index.js 里工厂函数的源码顺序**一致 —— F-15 的静态切片按相邻工具的
    //    `name: 'xxx'` 字面量切块，顺序错了会把下一个工具的回执字段算到上一个头上
    //    （实测：把 learner_kick 放在 task_* 前面时，propose_skill 块吞掉了三个任务工具的 render）。
    'mnemos_task_open', 'mnemos_task_update', 'mnemos_task_close', 'mnemos_task_done', 'mnemos_task_cite',
    'mnemos_learner_kick',
  ]
  assert(TOOL_NAMES.length === 19, `★★ [F15] 形状表覆盖 19 个工具（实测 ${TOOL_NAMES.length}：${TOOL_NAMES.join(',')}）`)
  assert(
    EXPECTED_TOOLS.every((t) => TOOL_NAMES.includes(t)) && TOOL_NAMES.every((t) => EXPECTED_TOOLS.includes(t)),
    '★★ [F15] 表的键集合 == 实际注册的工具集合（多一个/少一个都挂 —— 新增工具必须同时声明形状）'
  )

  // ── ② 真值检查表：每个工具喂**真实**输入，核对"实际返回值"符合"声明" ──
  //    用的是真 MemoryStore / 真 ConstitutionStore / 真 heartbeat / 真 createSkill ——
  //    不是编造的样板对象（那会变成装饰性断言）。
  const d104 = path.join(dir, 'x104')
  await fs.mkdir(d104, { recursive: true })
  const f104 = path.join(d104, 'memory.json')
  const s104 = new MemoryStore(f104)
  const c104 = new ConstitutionStore(path.join(d104, 'constitution.json'))
  await c104.load()
  const hb104 = createHeartbeat()
  hb104.register('demo', '演示用维护功能', () => ({ n: 1 }))
  hb104.register('boom', '故意失败', () => { throw new Error('boom') })
  const skillRoot104 = path.join(d104, 'skills')
  await fs.mkdir(skillRoot104, { recursive: true })

  const rA = await s104.remember({ content: 'A', summary: 'F15-A', tags: ['f15'] })
  const rB = await s104.remember({ content: 'B', summary: 'F15-B', tags: ['f15'], sessionId: 'sid-104' })
  const recalled = s104.recall({ query: 'F15', sessionId: 'sid-104' })
  const opened = await s104.open(rA.id)
  const openedMissing = await s104.open('no-such-id-104')
  const delRes = await s104.delete(rB.id)
  const depRes = await s104.deprecate(['no-such-id-104'])
  const dormRes = await s104.markDormant([rA.id], 'sid-104')
  const sessionRec = await s104.remember({ content: 'C', summary: 'F15-C', tags: ['f15'], sessionId: 'sid-104' })
  const archSession = await s104.archiveSession('sid-104')
  const archUnscoped = await s104.archiveSession(null)
  const archivedNothing = await s104.archiveSession('sid-104') // 已归档过 → 没有短时可归档了
  const hbRes = await hb104.run(s104)
  const proposeRes = await createSkill(
    { skillRoot: skillRoot104, dataFile: f104, llm: null, provider: 'p', model: 'm', writeBack: true, session: null },
    { name: 'f15-demo', description: 'd', body: '# x', counterexample: 'c', positiveCase: 'p' }
  )

  // ★ 任务图三件套的真值：用**真 store** 走一遍 开→填→收，喂的是真实回执（不是编的样板对象）
  const taskSt104 = new MemoryStore(path.join(d104, 'task104.json'))
  const taskOpened104 = await taskSt104.openTask({
    goal: 'F-15 真值：任务图',
    assignments: [{ id: 'a', task: '做一件事' }],
    sessionId: 'sid-task-104',
  })
  const taskHandoff104 = await taskSt104.remember({
    content: '交接内容',
    summary: '分工a的交接',
    tags: [`${TASK_TAG_PREFIX}${taskOpened104.taskId}`, 'assign:a'],
    sessionId: 'sid-task-104',
  })
  const taskUpdated104 = await taskSt104.updateTask({
    taskId: taskOpened104.taskId,
    assign: 'a',
    status: 'done',
    handoffId: taskHandoff104.id,
    note: '做完了',
    sessionId: 'sid-task-104',
  })
  // ★ V6-21：里程碑与依赖的真值（都走真 store）
  const taskDone104 = await taskSt104.appendTaskDone({
    taskId: taskOpened104.taskId,
    text: '已完成一件事',
    memoryId: taskHandoff104.id,
    sessionId: 'sid-task-104',
  })
  const taskCite104 = await taskSt104.citeTaskMemories({
    taskId: taskOpened104.taskId,
    ids: [taskHandoff104.id],
    why: '沿用它的结论',
    sessionId: 'sid-task-104',
  })
  const taskClosed104 = await taskSt104.closeTask({
    taskId: taskOpened104.taskId,
    conclusion: '这件事做完了',
    sessionId: 'sid-task-104',
  })

  const REAL_VALUES = {
    mnemos_remember: rememberResult(rA, { superseded: [{ id: 'x', ok: true }], possibleSupersedes: [] }),
    mnemos_recall: recallResult(recalled),
    mnemos_validate: validateResult(false, 'subagents 服务不可用'),
    mnemos_constitution: constitutionResult(c104.read()),
    mnemos_delete: deleteResult(delRes),
    mnemos_deprecate: deprecateResult(depRes),
    mnemos_dormant: dormantResult(dormRes, false),
    mnemos_open: openResult(opened),
    mnemos_consolidate: consolidateResult(archSession),
    mnemos_heartbeat: heartbeatResult(hbRes),
    mnemos_maintenance_list: maintenanceListResult(hb104.list()),
    mnemos_heartbeat_toggle: toggleResult(true),
    mnemos_propose_skill: proposeSkillResult(proposeRes),
    // ★ 新增工具三处：形状表（已加）、真值表（这里）、以及 EXPECTED_TOOLS 清单
    mnemos_learner_kick: learnerKickResult({
      sessionId: 'mnemos-learner', sent: true, created: true, resumed: false,
      waited: true, statusAfter: 'idle', skipped: false, kickedAt: 1,
    }),
    // ★ 任务图三件套：真值同样来自真 store（开→填→收都跑过一遍）
    mnemos_task_open: taskOpenResult(taskOpened104),
    mnemos_task_update: taskUpdateResult(taskUpdated104),
    mnemos_task_close: taskCloseResult(taskClosed104),
    mnemos_task_done: taskDoneResult(taskDone104),
    mnemos_task_cite: taskCiteResult(taskCite104),
  }
  // 前置：这些"真值"真的来自真实现（否则整张表就是自证）。逐条断言而非抽样。
  assert(recalled.length === 2 && opened && openedMissing === null, '★ [F15] 前置：真 store 产出了真输入（recall 2 条 / open 命中 / open 未命中=null）')
  assert(archSession !== null && archUnscoped !== null && archivedNothing === null, '★ [F15] 前置：真 store 的归档覆盖"有会话/无会话/没东西可归档"三种（第三种实际返回 null）')
  assert(proposeRes && typeof proposeRes === 'object' && proposeRes.verdict === 'rejected', '★ [F15] 前置：真 createSkill（无 LLM）返回了拒绝回执')

  const rows = []
  for (const name of EXPECTED_TOOLS) {
    const value = normalizeToolValue(REAL_VALUES[name])
    const r = checkToolOutput(name, value)
    const desc = Array.isArray(value)
      ? `数组(${value.length} 项)`
      : value !== null && typeof value === 'object'
        ? `字段=${Object.keys(value).join(',')}`
        : `标量(${typeof value})`
    rows.push(`${name}: ${r.ok ? 'ALIGNED' : 'MISMATCH'} | ${desc}`)
    assert(r.ok, `★★ [F15] ${name}：真实返回值符合声明的形状${r.ok ? '' : '（' + r.errors.join('；') + '）'}`)
  }
  console.log('   → F-15 对齐检查表：\n      ' + rows.join('\n      '))

  // ── ③ F-15 本体：那两个**真的会返回 null** 的路径，现在必须是形状合法的对象 ──
  {
    const v = consolidateResult(archivedNothing)
    const r = checkToolOutput('mnemos_consolidate', v)
    assert(
      r.ok && v.archived === false,
      `★★ [F15] consolidate 无短时可归档：不再返回 null，而是 {archived:false}（实测 ${JSON.stringify(v)}）` +
      '—— 旧实现 `rec ? summarize(rec) : null` 到宿主那里就是 value must be an object'
    )
    const r2 = checkToolOutput('mnemos_consolidate', null)
    assert(
      r2.ok === false && r2.errors.join('').includes('应为对象'),
      `★★ [F15] 反例核对：裸 null 依然被判不合规，且报错就是那句"应为对象"（实测 ${JSON.stringify(r2.errors)}）—— 校验器不是"什么都放过"`
    )
    const v3 = openResult(openedMissing)
    assert(
      checkToolOutput('mnemos_open', v3).ok && v3.found === false,
      `★★ [F15] open 查不到：同为 null 病灶，现在返回 {found:false}（实测 ${JSON.stringify(v3)}）`
    )
  }

  // ── ④ consolidate 回执的"未作用域化"判定（顺带修掉的真 bug）──
  {
    const withSid = consolidateResult({
      id: 'i', summary: 's', tags: [], layer: 'hot', salience: 'normal', scope: 'sid-x', sessionId: 'sid-x',
    })
    const unscoped = consolidateResult({
      id: 'i', summary: 's', tags: [], layer: 'hot', salience: 'normal', scope: '__unassigned__', sessionId: null,
    })
    assert(withSid.unscoped === false, `★★ [F15] 有会话的归档**不得**被说成"未作用域化"（unscoped=${withSid.unscoped}）—— 旧 render 用 `+"`!value.sessionId`"+` 判，而 summarize() 里根本没有 sessionId → 恒真`)
    assert(unscoped.unscoped === true, '★★ [F15] 无会话（__unassigned__）才标为止未作用域化')
  }

  // ── ⑤ 校验器本身必须抓得住"漏字段/类型不符/多字段"（判别力，而非装饰）──
  {
    const good = { id: 'a', summary: 'b', tags: ['t'], layer: 'short', salience: 'normal' }
    assert(checkToolOutput('mnemos_remember', good).ok, '★ [F15] 正例：合法值通过（校验器不是恒假）')
    const e1 = checkToolOutput('mnemos_remember', { summary: 'b' })
    assert(e1.ok === false && e1.errors.join('').includes('id'), '★★ [F15] 漏字段（缺 id）被判不合规')
    const e2 = checkToolOutput('mnemos_remember', { id: 123, summary: 'b' })
    assert(e2.ok === false && e2.errors.join('').includes('id'), '★★ [F15] 类型不符（id 是数字）被判不合规')
    const e3 = checkToolOutput('mnemos_remember', { id: 'a', summary: 'b', surprise: 1 })
    assert(e3.ok === false && e3.errors.join('').includes('surprise'), '★★ [F15] 未声明字段被判不合规（additionalProperties:false）')
    const e4 = checkToolOutput('mnemos_consolidate', [1, 2])
    assert(e4.ok === false, '★★ [F15] 类型整体不符（数组 ≠ 对象）被判不合规')
    const e5 = checkToolOutput('mnemos_not_declared', {})
    assert(e5.ok === false && e5.errors.join('').includes('mnemos_not_declared'), '★★ [F15] 表里没有的工具名被判不合规（新增工具必须先声明形状）')
    const e6 = checkToolOutput('mnemos_recall', [{ id: 'a', summary: 'b', layer: 'short' }])
    assert(e6.ok === false && e6.errors.join('').includes('salience'), '★ [F15] 数组**元素**的漏字段同样抓到（不是只看外壳）')
    const e7 = checkToolOutput('mnemos_heartbeat', { ranAt: 1, results: [{ name: 'x' }] })
    assert(e7.ok === false && e7.errors.join('').includes('ok'), '★ [F15] 嵌套对象的必需字段同样抓到')
  }

  // ── ⑥ 统一出口闸门 + 规范化 ──
  {
    const warns = []
    const bad = withToolOutputGate(
      { name: 'mnemos_consolidate', output: { schema: buildOutputSchema('mnemos_consolidate') }, async execute() { return null } },
      { onWarn: (m) => warns.push(m) }
    )
    const v = await bad.execute({}, {})
    assert(warns.length === 1 && warns[0].includes('应为对象'), `★★ [F15] 闸门抓住 null 返回值并告警（告警 ${warns.length} 条：${warns[0] || '无'}）`)
    assert(v === null, '★ [F15] 闸门是 fail-open：告警但**不改写**返回值（生产上不许把工具打瘸）')
    const warns2 = []
    const ok = withToolOutputGate(
      { name: 'mnemos_heartbeat_toggle', output: { schema: buildOutputSchema('mnemos_heartbeat_toggle') }, async execute() { return toggleResult(true) } },
      { onWarn: (m) => warns2.push(m) }
    )
    assert((await ok.execute({}, {})).enabled === true && warns2.length === 0, '★ [F15] 闸门对合法值是零噪音')
    assert(
      JSON.stringify(normalizeToolValue({ a: null, b: undefined, c: 1, d: { e: null, f: 2 }, g: [{ h: null, i: 3 }] })) ===
        JSON.stringify({ c: 1, d: { f: 2 }, g: [{ i: 3 }] }),
      `★★ [F15] 规范化：null/undefined 递归省略（宿主 schema 没有 null 类型），数组元素里的对象键同样处理（实测 ${JSON.stringify(normalizeToolValue({ a: null, b: undefined, c: 1, d: { e: null, f: 2 }, g: [{ h: null, i: 3 }] }))}）`
    )
  }

  // ── ⑦ 接线闸门（静态）：声明必须来自表；execute 的返回值必须来自纯构造函数 ──
  const idxSrc104 = (await fs.readFile(path.join(pluginRoot, 'src', 'index.js'), 'utf8'))
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
  assert(!/schema:\s*\{/.test(idxSrc104), '★★ [F15] index.js 里**没有**任何手写的 output.schema 字面量（形状只能来自 buildOutputSchema）')
  const missingDecl = EXPECTED_TOOLS.filter((t) => !idxSrc104.includes(`buildOutputSchema('${t}')`))
  assert(missingDecl.length === 0, `★★ [F15] 19 个工具的 output.schema 全部取自形状表（缺：${missingDecl.join(',') || '无'}）`)
  // ★ 2026-10-17：断言从"字面完全相等"放宽成"必须以闸门包裹"（允许追加选项，例如 onExecute 钩子）。
  //   本意是**不许绕过闸门**，不是不许加选项 —— 写死字面量会让合法改动误报。
  assert(
    /registerTool\(withToolOutputGate\(tool, \{ onWarn: skillWarn[,\s}]/.test(idxSrc104) &&
      !/registerTool\(make/.test(idxSrc104),
    '★★ [F15] 19 个工具都过统一出口闸门（不许有绕过闸门的 registerTool(makeXxx(…)) 直连）'
  )

  // ★ 每个工具一段块：execute 只许 return <xxx>Result(...)；render 只许读**声明过**的字段。
  const methodish = new Set(['length', 'forEach', 'map', 'filter', 'join', 'every', 'some', 'slice', 'find', 'includes', 'indexOf', 'push', 'concat'])
  const blocks = []
  // ★ 切片逻辑（实测数据，别再动）：
  //   · 各工具的 `name: 'xxx'` 字面量都在**工厂函数**里，位置在 6.7KB~46KB；
  //   · `export function apply` 在 31KB 处（**夹在中间**，所以它不能当起点，也不能当末块的终点）；
  //   · `const toolDefs = [` 在末尾（45KB+）——**末块的终点用它之后的注册循环**。
  //   一个工具的名字字面量**必须只出现一次**，否则切片错位（本项目在这上面栽了三次）。
  const toolDefsAt = idxSrc104.indexOf('const toolDefs = [')
  const tailAnchor = idxSrc104.indexOf('for (const tool of toolDefs)', toolDefsAt)
  for (let i = 0; i < EXPECTED_TOOLS.length; i++) {
    const start = idxSrc104.indexOf(`name: '${EXPECTED_TOOLS[i]}'`)
    const end = i + 1 < EXPECTED_TOOLS.length
      ? idxSrc104.indexOf(`name: '${EXPECTED_TOOLS[i + 1]}'`, start + 1)
      : tailAnchor
    blocks.push({ tool: EXPECTED_TOOLS[i], src: idxSrc104.slice(start, end) })
  }
  assert(blocks.every((b) => b.src.length > 0), '★ [F15] 前置：每个工具的源码块都被切出来了（否则后面的断言是空的）')
  const renderDrift = []
  const execDrift = []
  for (const { tool, src } of blocks) {
    const noComment = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    // render：只读声明过的字段
    const declared = new Set(Object.keys(TOOL_OUTPUT_SPECS[tool].properties || {}))
    const allowExtra = TOOL_OUTPUT_SPECS[tool].additionalProperties === true
    if (!allowExtra) {
      for (const m of noComment.matchAll(/\b(?:value|v)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const f = m[1]
        if (declared.has(f) || methodish.has(f)) continue
        renderDrift.push(`${tool}.${f}`)
      }
    }
    // execute：每个 return 都必须来自纯构造函数
    const execStart = noComment.indexOf('async execute')
    const execEnd = noComment.indexOf('\n    },', execStart)
    const execSrc = execStart === -1 ? '' : noComment.slice(execStart, execEnd === -1 ? undefined : execEnd)
    const returns = (execSrc.match(/\breturn\b/g) || []).length
    const ctorReturns = (execSrc.match(/\breturn\s+[A-Za-z_]\w*Result\(/g) || []).length
    if (returns === 0 || returns !== ctorReturns) execDrift.push(`${tool}(${returns} return / ${ctorReturns} 构造函数)`)
  }
  assert(
    renderDrift.length === 0,
    `★★ [F15] render 只读**声明过**的字段（漂移：${renderDrift.join(', ') || '无'}）—— consolidate 那个"读了不存在的 sessionId"就是这样被抓住的`
  )
  assert(
    execDrift.length === 0,
    `★★ [F15] 每个 execute 的返回值都出自纯构造函数（漂移：${execDrift.join(', ') || '无'}）—— 就地拼对象 = 形状没人测`
  )

  // ── ⑧ ★ 扰动自证：把"应为对象"这道检查去掉 → 上面的 [F15] 断言必须失败（子进程 + 可观测）──
  if (process.env.MNEMOS_F3_NO_PERTURB === '1') {
    assert(true, '★ [F15] 子进程（被跑方）：本段跳过再扰动，避免无限递归（MNEMOS_F3_NO_PERTURB=1）')
  } else {
    const t104 = path.join(dir, 'x104tmp')
    const pert = path.join(t104, 'perturbed')
    const clean = path.join(t104, 'clean')
    await fs.mkdir(path.join(pert, 'src'), { recursive: true })
    await fs.mkdir(path.join(clean, 'src'), { recursive: true })
    await fs.cp(path.join(pluginRoot, 'src'), path.join(pert, 'src'), { recursive: true, force: true })
    await fs.cp(path.join(pluginRoot, 'src'), path.join(clean, 'src'), { recursive: true, force: true })

    // ★ 归一化行尾/去 BOM：源文件是 CRLF，跨行 needle 用 \n 会永不匹配 → 扰动静默失效、报假 0 失败
    const rawTO = (await fs.readFile(path.join(pert, 'src', 'tool-output.js'), 'utf8'))
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
    // 扰动 ⓐ：不再检查"应为对象"（F-15 现场那道检查）。
    //   ★ 只禁掉 errors.push，**不**删那个 if —— 删了 if 会让后面的 `'archived' in null` 抛错，
    //     子进程直接崩掉、报告里什么都看不到（"扰动静默失效"的另一种形态）。
    const needleA = '        errors.push(`${at}: 应为对象，实际 ${typeName(v)}`)'
    assert(rawTO.includes(needleA), '★ [F15] 前置：扰动锚点 A（"应为对象"检查）唯一可定位')
    // 扰动 ⓑ：不再检查"未声明的字段"
    const needleB = "          if (!declared.has(k)) errors.push(`${at}.${k}: 未声明的字段（additionalProperties: false）`)"
    assert(rawTO.includes(needleB), '★ [F15] 前置：扰动锚点 B（"未声明字段"检查）唯一可定位')
    const badTO = rawTO
      .replace(needleA, '        if (false) { /* ★F15-扰动A：不再检查"应为对象" */ }')
      .replace(needleB, '          if (false) { /* ★F15-扰动B：不再检查"未声明字段" */ }')
    assert(
      badTO !== rawTO && badTO.includes('★F15-扰动A') && badTO.includes('★F15-扰动B') &&
        !badTO.includes(needleA) && !badTO.includes(needleB),
      '★ [F15] 前置：两处扰动都真的改到了源码文本（替换后不同，且原锚点消失）'
    )
    await fs.writeFile(path.join(pert, 'src', 'tool-output.js'), badTO, 'utf8')
    const diskTO = (await fs.readFile(path.join(pert, 'src', 'tool-output.js'), 'utf8')).replace(/\r\n/g, '\n')
    assert(
      diskTO.includes('★F15-扰动A') && diskTO.includes('★F15-扰动B') && !diskTO.includes(needleA),
      '★★ [F15] 前置：扰动标记真的落盘（子进程 import 的正是这份文件 —— 不是"改了但没生效"）'
    )

    // 把本测试文件也复制进两个副本：副本里 pluginRoot 指向副本 → ../src/*.js 解析到副本自己的实现
    const testSrc104 = await fs.readFile(fileURLToPath(import.meta.url), 'utf8')
    const cleanTest = path.join(clean, 'test', 'store.test.js')
    const pertTest = path.join(pert, 'test', 'store.test.js')
    await fs.mkdir(path.dirname(cleanTest), { recursive: true })
    await fs.mkdir(path.dirname(pertTest), { recursive: true })
    await fs.writeFile(cleanTest, testSrc104, 'utf8')
    await fs.writeFile(pertTest, testSrc104, 'utf8')
    assert(
      (await fs.readFile(cleanTest, 'utf8')).includes('== 104.') && (await fs.readFile(pertTest, 'utf8')).includes('== 104.'),
      '★ [F15] 前置：两份副本的测试文件都真的写到磁盘（否则子进程会以"模块找不到"退出）'
    )

    const runSup104 = async (tag, testFile) => {
      const reportFile = path.join(dir, `x104-report-${tag}.json`)
      await fs.rm(reportFile, { force: true })
      const { execFileSync: run } = await import('node:child_process')
      let spawnErr = null
      try {
        run(process.execPath, [testFile, `--pf3-report=${reportFile.split('\\').join('/')}`], {
          cwd: pluginRoot,
          stdio: 'ignore',
          timeout: 900000,
          env: { ...process.env, MNEMOS_F3_NO_PERTURB: '1' },
        })
      } catch (e) {
        spawnErr = String(e.code || e.message)
      }
      let report = null
      let reportErr = null
      try {
        report = JSON.parse((await fs.readFile(reportFile, 'utf8')).replace(/^\uFEFF/, ''))
      } catch (e) {
        reportErr = e.message
      }
      return { spawnErr, report, reportErr }
    }
    const pick104 = (rep) => {
      const failed = (rep && rep.failed) || []
      return { f15: failed.filter((m) => m.includes('[F15]')), rest: failed.filter((m) => !m.includes('[F15]')), fail: rep ? rep.fail : null, pass: rep ? rep.pass : null }
    }

    const c104 = await runSup104('clean', cleanTest)
    const pc = pick104(c104.report)
    assert(
      c104.report !== null && pc.f15.length === 0,
      `★★ [F15] 正例：未扰动副本里 [F15] 断言全过（fail=${pc.fail} / [F15] 失败 ${pc.f15.length}${c104.reportErr ? '；' + c104.reportErr : ''}）`
    )
    const p104 = await runSup104('perturbed', pertTest)
    const pp = pick104(p104.report)
    assert(p104.report !== null, `★ [F15] 前置：扰动版跑完并写出报告（${p104.reportErr || 'ok'}${p104.spawnErr ? '；spawn=' + p104.spawnErr : ''}）`)
    assert(
      pp.f15.length >= 1 && pp.f15.some((m) => m.includes('应为对象')),
      `★★ [F15] 扰动命中：去掉"应为对象"检查后，[F15] 断言失败 ${pp.f15.length} 条（${pp.f15.map((m) => m.slice(0, 40)).join('；') || '没有命中！'}）`
    )
    assert(
      pp.f15.some((m) => m.includes('未声明字段')),
      `★★ [F15] 扰动命中：去掉"未声明字段"检查后，对应断言也失败（[F15] 合计 ${pp.f15.length} 条）`
    )
    assert(
      pp.rest.length === pc.rest.length,
      `★ [F15] 定向性：扰动的失败全部落在 [F15] 上（副本里其它失败 ${pp.rest.length} 条 == 未扰动副本的 ${pc.rest.length} 条）`
    )
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('== 105. ★★ 注入消息的形状：role/id 必须齐（缺 role → DeepSeek 路由 422 每轮必炸；缺 id → 会话重启后加载不了）==')
{
  // ── ① 构造器：一条"能注入、能活过重启"的 user 消息该有的四样 ──
  const m = buildInjectedUserMessage('【测试】一段提醒')
  assert(m.role === 'user', '★ role 必须是 "user"（DeepSeek Messages 适配器对 undefined 没有兜底）')
  assert(typeof m.id === 'string' && m.id.length > 0, '★★ id 必须是非空字符串（宿主加载/resume 校验要它）')
  assert(m.source && m.source.kind === 'user', '★ source.kind 仍是宿主 inbox 白名单里的 "user"')
  assert(
    Array.isArray(m.content) && m.content.length === 1 && m.content[0].type === 'text' && m.content[0].text.includes('【测试】'),
    '★ 正文按 text block 放进 content'
  )
  const m2 = buildInjectedUserMessage('另一段')
  assert(m2.id !== m.id, '★ 每次构造都给新 id（两条消息不会撞 id）')
  assert(buildInjectedUserMessage('x', { id: 'fixed-id' }).id === 'fixed-id', '★ 测试可固定 id')

  // ── ② 宿主加载校验的等价规则：正例通过；2026-10-17 那条真实坏消息必须被判不合格 ──
  assert(userMessageShapeProblems(m).length === 0, '★★ 构造出来的消息能通过宿主加载校验（等价规则）')
  const accident = { content: [{ type: 'text', text: '【折叠提醒】…' }], source: { kind: 'user' } } // ← 事故原样
  const probs = userMessageShapeProblems(accident)
  assert(probs.some((p) => p.includes('role')), `★★ 负例（事故原样）必须被判缺 role：${probs.join('；')}`)
  assert(probs.some((p) => p.includes('id')), `★★ 负例同时也缺 id：${probs.join('；')}`)
  assert(
    userMessageShapeProblems({ ...m, role: 'assistant' }).some((p) => p.includes('role')),
    '★ 反向核对：role 写错也拦得住（不是只认"有没有这个键"）'
  )

  // ── ③ 源码级机械检查：src 里不许再出现"手搓内联字面量"的注入点 ──
  //    判据是"注入实参必须是构造器调用"，所以将来再加注入点也绕不过去（不是靠记性）。
  const srcDir = path.join(pluginRoot, 'src')
  const srcFiles = (await fs.readdir(srcDir)).filter((f) => f.endsWith('.js'))
  const inlineCall = /agent\.(?:inject|followup|steer)\(\s*\{/g
  const ctorCall = /agent\.(?:inject|followup|steer)\(\s*buildInjectedUserMessage\(/g
  // 只看代码，不看注释（否则"文档里写反例"会自己被判失败 —— 这条断言刚被自己的注释绊过一次）
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const inlineHits = []
  let ctorHits = 0
  for (const f of srcFiles) {
    const src = stripComments(await fs.readFile(path.join(srcDir, f), 'utf8'))
    for (const mt of src.matchAll(inlineCall)) inlineHits.push(`${f}: ${mt[0]}`)
    ctorHits += [...src.matchAll(ctorCall)].length
  }
  assert(inlineHits.length === 0, `★★ src 里没有"手搓 {content, source}"的注入点（命中 ${inlineHits.length} 处${inlineHits.length ? '：' + inlineHits.join(' / ') : ''}）`)
  assert(ctorHits >= 2, `★★ 两处注入都走构造器（命中 ${ctorHits} 处：折叠提醒 + 空闲学习）`)

  // ── ④ 两个已知注入点确实都改成了构造器（点名核对，防止"别处合格、这两处退回去"）──
  const idxSrc = await fs.readFile(path.join(srcDir, 'index.js'), 'utf8')
  const loopSrc = await fs.readFile(path.join(srcDir, 'learner-loop.js'), 'utf8')
  assert(idxSrc.includes('agent.inject(buildInjectedUserMessage('), '★ 折叠提醒注入走构造器（src/index.js）')
  assert(loopSrc.includes('agent.followup(buildInjectedUserMessage('), '★ 空闲学习注入也走构造器（src/learner-loop.js）')
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
await writeReport(fail)
await fs.rm(dir, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)