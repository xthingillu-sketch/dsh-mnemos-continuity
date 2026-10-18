/**
 * dsh-mnemos 确定性凭据过滤（secret patterns）
 *
 * 它做什么：在**写入边界**用一组固定正则扫一遍文本，命中就按环节策略处理（拒写 / 打码）。
 * 它防的不是攻击，是**我们自己手滑** —— 把 key 顺手粘进 content 或用户消息里。
 *
 * 它**不**做什么（必须说清，否则会产生虚假的安全感）：
 *   · 不是语义判断 —— 只看**形状**，不懂「这句话在说密钥」
 *   · 不是秘密扫描器 —— 抓不到散文里的密码、跨行拆开的 key、自研格式 token、个人隐私（PII）
 *   · **有误报、也一定有漏报** —— 它是降低概率，不是保证
 *   （`dsh-mnemon` 的 SECURITY.md 对同类机制有同样的话："These boundaries are not a secret scanner."）
 *
 * 为什么对我们格外重要：本项目的记忆是**跨会话共享 + 会被反复召回**的明文文件 ——
 * 一个 key 进了记忆，会在每一次相关会话里被注入上下文，比一次性泄露更糟。
 *
 * ★ 安全属性（刻意的）：**本模块从不返回命中内容**。
 *   `findSecrets` 只回 `{name, index, length}`，错误信息与审计里也不含原文 ——
 *   否则"过滤"本身就成了另一个泄露渠道。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 模式清单：**只放高置信度的几类**。宁可少抓，也别误抓 —— 误报会挡住正当内容（实测见过）。 */
export const SECRET_PATTERNS = [
  // 长度下限刻意取偏严：实测中放宽时，占位符（如 9 字符全大写）也会命中，产生误报。
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'github-token', re: /\bgh[opsu]_[A-Za-z0-9]{30,}\b/g },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
]

/**
 * 找出文本里的疑似凭据。
 * ★ 只返回位置与模式名，**绝不返回匹配到的内容**。
 * @returns {{name: string, index: number, length: number}[]}
 */
export function findSecrets(text, patterns = SECRET_PATTERNS) {
  const s = String(text ?? '')
  if (!s) return []
  const out = []
  for (const { name, re } of patterns) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(s)) !== null) {
      out.push({ name, index: m.index, length: m[0].length })
      if (m.index === re.lastIndex) re.lastIndex++ // 防御零宽匹配死循环
    }
  }
  return out.sort((a, b) => a.index - b.index)
}

/** 是否含疑似凭据。 */
export function hasSecret(text, patterns = SECRET_PATTERNS) {
  return findSecrets(text, patterns).length > 0
}

/**
 * 把疑似凭据替换为占位标记，保留其余文本。
 * 用于**信号捕获**通道：那是用户原话，拒写会丢反馈；而密钥本身几乎不承载反馈含义。
 */
export function redactSecrets(text, patterns = SECRET_PATTERNS) {
  let s = String(text ?? '')
  for (const { name, re } of patterns) {
    re.lastIndex = 0
    s = s.replace(re, `[已屏蔽:${name}]`)
  }
  return s
}

/** 人类可读的命中摘要（**只含模式名与处数，不含内容**）。 */
export function describeHits(hits) {
  const byName = new Map()
  for (const h of hits) byName.set(h.name, (byName.get(h.name) || 0) + 1)
  return [...byName.entries()].map(([n, c]) => `${n}×${c}`).join('、')
}

/** 命中审计文件：与 memory.json 同级。**只记模式名/处数/环节/时间，绝不记命中内容。** */
export function secretBlocksFileFor(dataFile) {
  return path.join(path.dirname(dataFile), 'secret-blocks.jsonl')
}

/**
 * 记一条命中审计。失败不影响主流程（审计是旁路）。
 * @param action 'rejected'（拒写）| 'redacted'（打码）
 */
export async function auditSecretBlock(file, { where, hits, action }) {
  if (!file || !hits || !hits.length) return
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(
      file,
      JSON.stringify({
        t: Date.now(),
        where,
        action,
        patterns: [...new Set(hits.map((h) => h.name))],
        count: hits.length,
      }) + '\n',
      'utf8'
    )
  } catch {
    /* 旁路：审计失败不阻断 */
  }
}
