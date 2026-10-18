/**
 * dsh-mnemos 宪法存储（纯逻辑，无 DSH 依赖，可独立测试）。
 * 宪法 = 身份/边界/红线。系统只读（无写工具）；用户可改，改必留痕（审计日志）。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { defaultConstitutionFile } from './paths.js'

// ★ 默认路径不在这里算 —— 唯一实现在 src/paths.js（profile 优先于 home）。
//   这里曾有一份 `DSH_HOME || cwd` 的本地副本：它会让插件去 `$DSH_HOME\mnemos\` 读宪法，
//   而持有者按 INSTALL 初始化到的是 `$DSH_PROFILE_DIR\mnemos\` → 身份段静默消失（F-3）。

function hashPassword(password) {
  // 注意：MVP 用 sha256，本地文件场景够用；正式可换 bcrypt/scrypt + 盐
  return createHash('sha256').update(String(password)).digest('hex')
}

export class ConstitutionStore {
  constructor(dataFile) {
    this.dataFile = dataFile || defaultConstitutionFile()
    this.content = null // 当前宪法正文
    this.version = 0
    this.passwordHash = null
    this.auditLog = [] // 完整留痕，不可删
  }

  async load() {
    try {
      const raw = await fs.readFile(this.dataFile, 'utf8')
      const d = JSON.parse(raw)
      this.content = d.content ?? null
      this.version = d.version ?? 0
      this.passwordHash = d.passwordHash ?? null
      this.auditLog = Array.isArray(d.auditLog) ? d.auditLog : []
    } catch (e) {
      if (e.code === 'ENOENT') return // 无文件 = 未初始化
      throw e
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.dataFile), { recursive: true })
    await fs.writeFile(
      this.dataFile,
      JSON.stringify(
        {
          content: this.content,
          version: this.version,
          passwordHash: this.passwordHash,
          auditLog: this.auditLog,
        },
        null,
        2
      ),
      'utf8'
    )
  }

  isInitialized() {
    return this.content !== null && this.passwordHash !== null
  }

  verifyPassword(password) {
    if (!this.passwordHash) return false
    return hashPassword(password) === this.passwordHash
  }

  read() {
    return this.content
  }

  async initialize(content, password, operator) {
    if (this.isInitialized()) throw new Error('constitution: 已初始化，不能重复初始化')
    this.content = content
    this.passwordHash = hashPassword(password)
    this.version = 1
    this.auditLog = [
      {
        id: randomUUID(),
        at: Date.now(),
        operator: operator || 'unknown',
        action: 'initialize',
        reason: '首次初始化宪法',
        version: 1,
      },
    ]
    await this.save()
    return this.version
  }

  async update(newContent, password, operator, reason) {
    if (!this.verifyPassword(password)) throw new Error('constitution: 密码错误')
    const before = this.content
    this.content = newContent
    this.version += 1
    // 留痕：记录 谁/何时/改了什么(before+after)/为什么，不可删
    this.auditLog.push({
      id: randomUUID(),
      at: Date.now(),
      operator: operator || 'unknown',
      action: 'update',
      reason: reason || '',
      version: this.version,
      before,
      after: newContent,
    })
    await this.save()
    return this.version
  }
}
