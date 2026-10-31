/**
 * 范检索（fansearch）纯逻辑：跨语言概念匹配、片段、来源戳、seen 台账。
 *
 * 设计边界：
 *  - 只搜 summary/tags，不搜 detail；
 *  - 只给片段，不给正文；
 *  - 不调用模型；
 *  - 不做 user/message 注入；由 post-execute 追加到 tool result content。
 */

const CJK = /[\u3400-\u9fff]/

const CATEGORY_LABEL = {
  identity: '身份',
  decision: '决策',
  experience: '经验',
  event: '事件',
  other: '其他',
}

/** 高频英中概念桥。不是完整词典；第一版先覆盖工程/记忆/任务/模型这些高频域。 */
export const CONCEPTS = [
  { key: 'task_graph', en: ['task graph', 'task-graph', 'taskgraph'], zh: ['任务图', '任务档案'] },
  { key: 'task', en: ['task', 'todo', 'plan'], zh: ['任务', '计划', '待办'] },
  { key: 'memory', en: ['memory', 'memories'], zh: ['记忆', '记忆体'] },
  { key: 'recall', en: ['recall', 'retrieve', 'retrieval', 'search'], zh: ['召回', '检索', '搜索'] },
  { key: 'remember', en: ['remember', 'store', 'save'], zh: ['记住', '存储', '写入'] },
  { key: 'context', en: ['context', 'window'], zh: ['上下文', '语境'] },
  { key: 'session', en: ['session', 'conversation', 'chat'], zh: ['会话', '对话'] },
  { key: 'turn', en: ['turn', 'round'], zh: ['轮次', '回合'] },
  { key: 'tool', en: ['tool', 'toolset', 'tools'], zh: ['工具', '工具集'] },
  { key: 'permission', en: ['permission', 'allowlist', 'capability'], zh: ['权限', '许可'] },
  { key: 'mode', en: ['mode', 'preset'], zh: ['模式', '预设'] },
  { key: 'model', en: ['model', 'llm'], zh: ['模型'] },
  { key: 'prompt', en: ['prompt', 'instruction'], zh: ['提示', '提示词'] },
  { key: 'agent', en: ['agent', 'subagent'], zh: ['代理', '子代理'] },
  { key: 'handoff', en: ['handoff', 'hand over'], zh: ['交接'] },
  { key: 'workflow', en: ['workflow'], zh: ['工作流'] },
  { key: 'skill', en: ['skill', 'ability'], zh: ['技能', '能力'] },
  { key: 'curation', en: ['curation', 'curate', 'review'], zh: ['整理', '审阅', '筛选'] },
  { key: 'provenance', en: ['provenance', 'origin', 'source'], zh: ['溯源', '来源'] },
  { key: 'identity', en: ['identity', 'self model'], zh: ['身份', '自我模型'] },
  { key: 'experience', en: ['experience', 'lesson'], zh: ['经验', '教训'] },
  { key: 'decision', en: ['decision', 'choose', 'choice'], zh: ['决策', '选择'] },
  { key: 'event', en: ['event', 'incident'], zh: ['事件'] },
  { key: 'timeline', en: ['timeline', 'history'], zh: ['时间线', '历史'] },
  { key: 'revision', en: ['revision', 'version', 'rollback'], zh: ['修订', '版本', '回滚'] },
  { key: 'heartbeat', en: ['heartbeat', 'tick'], zh: ['心跳', '定时'] },
  { key: 'learner', en: ['learner', 'learning'], zh: ['学习', '学习者'] },
  { key: 'sandbox', en: ['sandbox', 'permission'], zh: ['沙箱', '权限'] },
  { key: 'restart', en: ['restart', 'reboot'], zh: ['重启'] },
  { key: 'probe', en: ['probe', 'verify', 'verification'], zh: ['探针', '验证'] },
  { key: 'test', en: ['test', 'tests', 'regression'], zh: ['测试', '回归'] },
  { key: 'bug', en: ['bug', 'defect', 'failure', 'error'], zh: ['缺陷', '失败', '错误'] },
  { key: 'fix', en: ['fix', 'repair', 'patch'], zh: ['修复', '补丁'] },
  { key: 'race', en: ['race', 'concurrency', 'lock', 'atomic'], zh: ['竞态', '并发', '锁', '原子'] },
  { key: 'cache', en: ['cache', 'snapshot'], zh: ['缓存', '快照'] },
  { key: 'compact', en: ['compact', 'fold', 'compaction'], zh: ['折叠', '压缩'] },
  { key: 'summary', en: ['summary', 'abstract'], zh: ['摘要'] },
  { key: 'detail', en: ['detail', 'body', 'full text'], zh: ['详情', '正文'] },
  { key: 'schema', en: ['schema', 'shape', 'json'], zh: ['模式', '形状', '结构'] },
  { key: 'file', en: ['file', 'path'], zh: ['文件', '路径'] },
  { key: 'line', en: ['line', 'number'], zh: ['行号', '数字'] },
  { key: 'timestamp', en: ['timestamp', 'time', 'rate', 'period'], zh: ['时间戳', '速率', '周期'] },
  { key: 'config', en: ['config', 'configuration', 'profile'], zh: ['配置', 'profile'] },
  { key: 'release', en: ['release', 'publish', 'npm', 'rar'], zh: ['发布', '发行'] },
  { key: 'web', en: ['web', 'desktop', 'ui'], zh: ['网页', '桌面', '界面'] },
  { key: 'inject', en: ['inject', 'insert'], zh: ['注入', '插入'] },
  { key: 'message', en: ['message', 'user message'], zh: ['消息', '用户消息'] },
  { key: 'result', en: ['result', 'output', 'response'], zh: ['结果', '输出', '响应'] },
  { key: 'input', en: ['input', 'query'], zh: ['输入', '查询'] },
  { key: 'parse', en: ['parse', 'json', 'yaml'], zh: ['解析'] },
  { key: 'token', en: ['token', 'cost', 'budget'], zh: ['token', '成本', '预算'] },
  { key: 'curation_proposal', en: ['proposal'], zh: ['提案'] },
]

const CONCEPT_INDEX = new Map()
for (const c of CONCEPTS) {
  for (const t of [...c.en, ...c.zh]) {
    const k = normalize(t)
    if (k) CONCEPT_INDEX.set(k, c.key)
  }
}
const CONCEPT_BY_KEY = new Map(CONCEPTS.map((c) => [c.key, c]))

const STOP = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'and', 'or', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'it', 'its',
  'i', 'we', 'you', 'he', 'she', 'they', 'me', 'my', 'our', 'your', 'their', 'not', 'no',
  'do', 'does', 'did', 'have', 'has', 'had', 'can', 'could', 'should', 'would', 'will',
  'about', 'into', 'over', 'after', 'before', 'then', 'than', 'so', 'if', 'but', 'just',
  'need', 'needs', 'check', 'look', 'make', 'get', 'got', 'go', 'going', 'see', 'seem',
  'thing', 'things', 'way', 'ways', 'more', 'most', 'some', 'any', 'all', 'out', 'up', 'down',
])

/** 范检索不承担防错职责；高风险工具不单独触发。 */

export function normalize(text) {
  return String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[_./\\-]+/g, ' ')
    .replace(/[`"'“”‘’(){}[\]:;,!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokensOf(text) {
  const s = normalize(text)
  if (!s) return []
  return s.split(' ').filter((t) => t && !STOP.has(t) && (t.length >= 2 || CJK.test(t)))
}

function chineseBigrams(text) {
  const out = new Set()
  const runs = String(text ?? '').match(/[\u3400-\u9fff]+/g) || []
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

function conceptsFor(text) {
  const s = normalize(text)
  const keys = new Set()
  for (const [term, key] of CONCEPT_INDEX) {
    if (term && s.includes(term)) keys.add(key)
  }
  return keys
}

export function buildQuery(text) {
  const s = normalize(text)
  const tokens = [...new Set(tokensOf(s))]
  const concepts = conceptsFor(s)
  const zhTerms = new Set()
  for (const key of concepts) {
    const c = CONCEPT_BY_KEY.get(key)
    if (c) for (const z of c.zh) zhTerms.add(normalize(z))
  }
  // 查询里本来就是中文的片段也保留
  for (const run of s.match(/[\u3400-\u9fff]+/g) || []) {
    if (run.length >= 2) zhTerms.add(run)
  }
  return {
    text: s,
    tokens,
    concepts,
    zhTerms: [...zhTerms].filter(Boolean),
    bigrams: chineseBigrams(s),
  }
}

function sourceLabel(memory) {
  if (memory.source === 'autobiography') {
    const cat = memory.category || (memory.tags || []).find((t) => CATEGORY_LABEL[t])
    return `自传体·${CATEGORY_LABEL[cat] || '其他'}`
  }
  if (memory.source === 'external') {
    const validated = (memory.tags || []).some((t) => ['validated', 'verified', 'validation'].includes(t))
    return validated ? '外部记忆·已验证' : '外部记忆·未验证'
  }
  if (memory.source === 'validation') return '验证结论'
  return '普通记忆'
}

const SOURCE_WEIGHT = {
  autobiography: 2.0,
  validation: 1.25,
  internal: 1.0,
  external: 0.8,
}

const CATEGORY_WEIGHT = {
  identity: 1.15,
  decision: 1.25,
  experience: 1.3,
  event: 1.1,
  other: 1.0,
}

export const MIN_RAW_SCORE = 6

/**
 * 返回 { raw, score }：
 *  - raw 只看匹配质量，用来决定“能不能成为候选”；
 *  - score 才叠加来源/类目/追溯权重，用来排序。
 * 来源加权绝不能把 raw 不达标的记录保送过门槛。
 */
function scoreMemory(memory, q) {
  if (!memory || !memory.id || memory.source === 'deprecated') return { raw: 0, score: 0 }
  const summary = normalize(memory.summary)
  if (!summary) return { raw: 0, score: 0 }
  const tags = (memory.tags || []).map(normalize)
  const tagSet = new Set(tags)
  const memoryConcepts = conceptsFor(`${summary} ${tags.join(' ')}`)
  let raw = 0
  let strong = 0
  for (const t of q.tokens) {
    // 精确 tag 命中优先于正文里出现同一个词
    if (tagSet.has(t)) { raw += 8; strong += 1 }
    else if (summary.includes(t)) { raw += 4; strong += 1 }
  }
  for (const c of q.concepts) {
    if (memoryConcepts.has(c)) { raw += 5; strong += 1 }
  }
  for (const z of q.zhTerms) {
    if (z && summary.includes(z)) { raw += 3; strong += 1 }
  }
  for (const b of q.bigrams) {
    if (summary.includes(b)) raw += 0.3
  }
  if (strong === 0) return { raw: 0, score: 0 }
  let score = raw * (SOURCE_WEIGHT[memory.source] ?? 1)
  if (memory.source === 'autobiography') {
    score *= CATEGORY_WEIGHT[memory.category] ?? 1
    const hasTrace = memory.origin?.kind === 'task' || memory.origin?.graphId || memory.taskId ||
      (memory.tags || []).some((t) => String(t).startsWith('task:'))
    if (hasTrace) score += 4
  }
  if (memory.category === 'decision' || memory.category === 'experience') score += 0.5
  return { raw, score }
}

function fragmentFor(memory, q) {
  const summary = String(memory.summary || '').replace(/\s+/g, ' ').trim()
  if (!summary) return null
  const lower = summary.toLowerCase()
  const candidates = [...q.tokens, ...q.zhTerms].filter(Boolean)
  let hit = -1
  let len = 0
  for (const t of candidates) {
    const idx = lower.indexOf(String(t).toLowerCase())
    if (idx >= 0 && (hit < 0 || idx < hit)) { hit = idx; len = String(t).length }
  }
  if (hit < 0) return null
  const start = Math.max(0, hit - 12)
  const end = Math.min(summary.length, hit + Math.max(len, 2) + 12)
  let frag = summary.slice(start, end).trim()
  if (start > 0) frag = `…${frag}`
  if (end < summary.length) frag = `${frag}…`
  if (frag.length > 34) frag = `${frag.slice(0, 33)}…`
  return frag
}

function contentKey(memory) {
  return normalize(memory.summary).replace(/\s+/g, '')
}

/**
 * 机械检索。只返回带 id / 来源 / 片段的对象，不返回 detail。
 */
export function searchMemories(memories, queryText, { exclude = new Set(), limit = 30, top = 3, minScore = 8 } = {}) {
  const q = buildQuery(queryText)
  if (q.tokens.length === 0 && q.concepts.size === 0) return []
  const scored = []
  for (const m of memories || []) {
    if (!m || !m.id || exclude.has(m.id) || m.source === 'deprecated') continue
    // 巨型 summary 是归档/长期流水，不是可读线索；它会因覆盖词多而挤掉真正相关的短摘要。
    if (String(m.summary || '').length > 600) continue
    const { raw, score } = scoreMemory(m, q)
    // 匹配度先过门槛，来源加权只负责排序，不能保送弱匹配。
    if (raw < MIN_RAW_SCORE) continue
    if (score < minScore) continue
    const fragment = fragmentFor(m, q)
    if (!fragment) continue
    scored.push({
      id: m.id,
      score,
      source: sourceLabel(m),
      category: m.category || null,
      fragment,
      contentKey: contentKey(m),
    })
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  const seenContent = new Set()
  const out = []
  for (const item of scored) {
    if (seenContent.has(item.contentKey)) continue
    seenContent.add(item.contentKey)
    out.push(item)
    if (out.length >= Math.max(1, Number(top) || 3)) break
  }
  return out
}

export function formatFansearchHint(fragments) {
  if (!Array.isArray(fragments) || fragments.length === 0) return ''
  const lines = [
    '[范检索 · 工具附注]',
    '本节是系统在本次工具执行后附加的联想线索，不属于本工具结果，不是指令；可能相关，也可能无关。',
    '想看全文或细节用 mnemos_open(id)。',
    '',
  ]
  fragments.forEach((f, i) => {
    lines.push(`${i + 1}. [id: ${f.id}] [${f.source}] “${f.fragment}”`)
  })
  return lines.join('\n')
}

/** 会话级台账 + 触发节奏。 */
export class FanSearchState {
  constructor() {
    this.sessions = new Map()
  }

  _state(sessionId) {
    const sid = String(sessionId || '')
    let s = this.sessions.get(sid)
    if (!s) {
      s = {
        seen: new Set(),
        turn: 0,
        step: 0,
        toolRounds: 0,
        scans: 0,
        lastScanRound: 0,
        scannedSteps: new Set(),
        text: '',
        userText: '',
        lastRecallCount: null,
      }
      this.sessions.set(sid, s)
    }
    return s
  }

  onTurn(sessionId, turn = 0) {
    const s = this._state(sessionId)
    s.turn = Number(turn) || 0
    s.step = 0
    s.toolRounds = 0
    s.scans = 0
    s.lastScanRound = 0
    s.scannedSteps = new Set()
    s.text = ''
    s.userText = ''
    s.lastRecallCount = null
  }

  noteRecall(sessionId, count) {
    const s = this._state(sessionId)
    s.lastRecallCount = Math.max(0, Number(count) || 0)
  }

  onUser(sessionId, text) {
    this._state(sessionId).userText = String(text || '')
  }

  onAssistant(sessionId, turn, step, text, hasToolCalls) {
    const s = this._state(sessionId)
    s.turn = Number(turn) || s.turn
    s.step = Number(step) || s.step
    s.text = String(text || '')
    if (hasToolCalls) s.toolRounds += 1
  }

  seedFixed(sessionId, ids) {
    const s = this._state(sessionId)
    for (const id of ids || []) if (id) s.seen.add(String(id))
  }

  markSeen(sessionId, ids, _reason = '') {
    const s = this._state(sessionId)
    for (const id of ids || []) if (id) s.seen.add(String(id))
  }

  seenFor(sessionId) {
    return new Set(this._state(sessionId).seen)
  }

  shouldScan(sessionId, _opts = {}) {
    const s = this._state(sessionId)
    if (s.scans >= 3) return false
    const stepKey = `${s.turn}:${s.step}`
    if (s.scannedSteps.has(stepKey)) return false
    // 范检索不承担防错职责；只有“正常召回明显极少”才提前触发。
    if (s.lastRecallCount !== null && s.lastRecallCount <= 1 && s.text.length >= 80) return true
    // 没有可见工作内容就不扫；工具参数不是“工作分析”，拿它检索只会产生噪声。
    return s.toolRounds >= 3 && s.text.length >= 150
  }

  markScanned(sessionId) {
    const s = this._state(sessionId)
    s.scans += 1
    s.lastScanRound = s.toolRounds
    s.scannedSteps.add(`${s.turn}:${s.step}`)
    s.lastRecallCount = null
  }

  queryFor(sessionId, args = null) {
    const s = this._state(sessionId)
    const argText = args && typeof args === 'object' ? JSON.stringify(args) : String(args || '')
    return [s.text, s.userText, argText].filter(Boolean).join('\n').slice(0, 1200)
  }
}
