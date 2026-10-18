/**
 * dsh-mnemos 任务型技能提供者。
 *
 * 为什么自己做 provider 而不用 profile patch 的 customSkillDirs：
 *   本环境实测 customSkillDirs 不生效（连工作区内的路径都扫不到，说明该行 config 未被应用）。
 *   而 skill-filesystem 的根目录又受 ctx.fs（沙箱文件服务）约束。
 *   自注册 provider 用 node:fs 直接读，根目录完全由 Mnemos 掌控，且不依赖 DSH 配置机制。
 *   形状对齐 @deepseek-ai/dsh-skill-office 的 provider（同一条 ctx.skills 通道，不算新造机制）。
 *
 * 技能根与 memory.json 同级：<memory.json 所在目录>/skills/<name>/SKILL.md
 *   —— 不写死路径、不需要配置，插件看到的 home 变了它也自动跟着走。
 *
 * 纪律型技能不走这里：它们必须常驻，直接写在系统提示里。
 *
 * 技能文件格式（由 Mnemos 自己生成，刻意保持简单、可人工审阅）：
 *   ---
 *   name: <技能名>
 *   description: <什么时候该用它>   ← 写触发条件，不是功能说明
 *   ---
 *   <正文，规则点建议编号>
 */
import { promises as fs, watch as fsWatch, mkdirSync } from 'node:fs'
import path from 'node:path'

/** 与 dsh-skill-filesystem 的 CUSTOM_RANK 同档。 */
export const MNEMOS_SKILL_RANK = 300
/** provider 名（不可为 "runtime"，那是保留值）。 */
export const MNEMOS_SKILL_PROVIDER = 'dsh-mnemos'
/** 技能名允许的字符（与 dsh-skill 的 SKILL_NAME 同风格）。 */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * 解析技能文件：YAML frontmatter + 正文。
 * 只支持单行 `key: value`（值可用引号包裹）——我们的技能由 Mnemos 生成，格式可控。
 * 刻意不支持多行/嵌套：宁可显式报错，也不要静默解析成错的东西。
 */
export function parseSkillFile(raw, file = '<skill>') {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
  if (!m) throw new Error(`${file} 缺少 YAML frontmatter`)
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf(':')
    if (i < 0) continue
    const key = t.slice(0, i).trim()
    let val = t.slice(i + 1).trim()
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1)
    }
    meta[key] = val
  }
  const { name, description } = meta
  if (!name) throw new Error(`${file} 缺少 name`)
  if (!NAME_RE.test(name)) throw new Error(`${file} 的 name 非法：${name}`)
  if (!description) throw new Error(`${file} 缺少 description`)
  return { name, description, content: raw.slice(m[0].length).trim() }
}

// ★ 技能根的计算不在这里 —— 唯一实现在 src/paths.js 的 skillsRootFor（= 与 memory.json 同级）。
//   想拿技能根请 `import { skillsRootFor } from './paths.js'`，别在本模块下再加一层包装副本。

/**
 * 扫描技能根。单个技能文件出错只跳过并告警，不影响其它技能。
 * @returns 候选列表（供 ctx.skills 目录使用）
 */
export async function listSkills(root, onWarn = () => {}) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return [] // 没有技能目录 = 还没有技能，正常
    throw e
  }
  const out = []
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue
    const dir = path.join(root, e.name)
    const file = path.join(dir, 'SKILL.md')
    try {
      const parsed = parseSkillFile(await fs.readFile(file, 'utf8'), file)
      out.push({
        name: parsed.name,
        description: parsed.description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: MNEMOS_SKILL_PROVIDER,
        source: 'mnemos',
        rank: MNEMOS_SKILL_RANK,
        resourceBase: { kind: 'directory', path: dir },
        locator: file,
      })
    } catch (err) {
      if (err.code === 'ENOENT') continue // 目录存在但没有 SKILL.md：跳过
      onWarn(`跳过 ${file}：${err.message}`)
    }
  }
  return out
}

/**
 * 构造 provider（形状与 dsh-skill-office 一致）。
 *
 * ★ 必须监听技能根目录并调用 control.invalidate()：
 *   dsh-skill 对技能目录**有缓存**，skill-filesystem 靠 watcher 触发失效。
 *   没有 watcher，新增/修改的技能要等重启才可见 —— 而学习闭环每次改技能都需要它立刻生效。
 *
 * @param root 技能根
 * @param opts.onWarn
 * @param opts.control ctx.skills.registerProvider 传入的 control（提供 invalidate / signal）
 */
export function createSkillProvider(root, opts = {}) {
  const { onWarn = () => {}, control } = opts
  const provider = {
    name: MNEMOS_SKILL_PROVIDER,
    list: () => listSkills(root, onWarn),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate
      const raw = await fs.readFile(locator, { encoding: 'utf8', signal: options?.signal })
      return { ...summary, content: parseSkillFile(raw, locator).content }
    },
    dispose: () => {},
  }

  if (control && typeof control.invalidate === 'function') {
    let timer = null
    let watcher = null
    const stop = () => {
      if (timer) { clearTimeout(timer); timer = null }
      if (watcher) { try { watcher.close() } catch { /* 已关闭 */ } watcher = null }
    }
    try {
      // 目录不存在时 fs.watch 会抛错；先建好（这也是"技能该放哪"的可发现提示）
      mkdirSync(root, { recursive: true })
      watcher = fsWatch(root, { recursive: true }, () => {
        if (timer) clearTimeout(timer)
        // 轻微去抖：写一个技能文件会触发多次事件
        timer = setTimeout(() => {
          timer = null
          try { control.invalidate() } catch (e) { onWarn(`技能目录失效失败：${e.message}`) }
        }, 150)
      })
      watcher.on('error', (e) => onWarn(`技能目录监听出错：${e.message}`))
      if (control.signal) control.signal.addEventListener('abort', stop, { once: true })
    } catch (e) {
      onWarn(`技能目录监听启动失败（新技能可能需要重启才可见）：${e.message}`)
    }
    provider.dispose = stop
  }

  return provider
}
