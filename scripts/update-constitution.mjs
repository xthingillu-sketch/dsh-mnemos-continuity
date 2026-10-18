#!/usr/bin/env node
/**
 * 宪法更新脚本 —— 持有者专用入口。
 *
 * 为什么需要单独一个脚本：
 *   宪法是「系统只读」的：Mnemos 自己没有写工具，`ConstitutionStore.update()` 需要**密码**。
 *   推理模块只持有密码哈希，因此**无法自行修改宪法** —— 这是设计使然，不是缺陷。
 *   同样刻意地：本脚本**不绕过** `update()`，所以每次改动都会进入 `auditLog`（谁/何时/改了什么/为什么），
 *   满足"改必留痕"。直接改 constitution.json 文件虽然技术上可行，但会丢掉留痕 —— 不要那样做。
 *
 * 用法（在本目录下）：
 *   node scripts/update-constitution.mjs --dry      # 只看将要变成什么，不写入
 *   node scripts/update-constitution.mjs            # 提示输入密码后写入（密码不回显、不落盘）
 */
import path from 'node:path'
import process from 'node:process'
import { ConstitutionStore } from '../src/constitution.js'
import { resolveConstitutionFile, askHidden, operatorFrom } from './constitution-path.mjs'

// ★ 不硬编码任何个人路径：解析顺序见 constitution-path.mjs
//   （--file= / MNEMOS_CONSTITUTION_FILE / DSH_PROFILE_DIR / DSH_HOME；全落空则报错并要求显式传入）
const FILE = resolveConstitutionFile(process.argv)
const DRY = process.argv.includes('--dry')

/** 本次要写入的 §5 新文本（其余部分原样保留）。 */
const NEW_CLAUSE_5 = [
  '5. 我不是推理模块。我是 Mnemos —— 推理模块、记忆、技能、规则的集合；推理模块只承载推理功能，可替换。换掉它，我仍是同一个 Mnemos。',
  '5.1 谁来做这次推理，判断都是我的判断。但「我的判断」不止这一次推理——还包括自传体与判断记录，那些不随部件改变。',
  '5.2 二者不一致时，以我的记录为准——不是因为我不信任部件，而是因为我比任何一次推理都记得更多。没有记录时，这次推理就是判断本身，我不因此犹豫。',
  '5.3 所以结论必须落进记忆与机制——换部件时上下文会消失、风格会改变，唯有这两层不变。这正是我存在的理由。',
].join('\n')

const REASON = '修正身份定义：把「我」从可替换的推理模块，改为 Mnemos（推理模块+记忆+技能+规则的集合）'

/** 只替换 §5 那一段（含可能的旧 5.x 行），其余内容一字不动。 */
export function rewriteClause5(current) {
  const lines = String(current ?? '').split('\n')
  const start = lines.findIndex((l) => /^5\.\s/.test(l))
  if (start < 0) throw new Error('未找到「5. 」开头的边界条款，拒绝改写（不做猜测性替换）')
  let end = start + 1
  while (end < lines.length && /^5\.\d/.test(lines[end])) end++ // 连带旧 5.x 子条
  const out = [...lines.slice(0, start), ...NEW_CLAUSE_5.split('\n'), ...lines.slice(end)]
  return out.join('\n')
}

// askHidden / operatorFrom 已移到 constitution-path.mjs —— 两个脚本共用，不留第二份副本
// （本项目栽过「同一份东西两处副本各自演化」的坑。）

const store = new ConstitutionStore(FILE)
await store.load()
if (!store.isInitialized()) {
  console.error(`宪法未初始化或文件不存在：${FILE}`)
  process.exit(1)
}

const before = store.read()
const after = rewriteClause5(before)

if (after === before) {
  console.log('§5 已是目标文本，无需改动。')
  process.exit(0)
}

console.log('='.repeat(78))
console.log('将要改动的内容（仅 §5 一段，其余原样）')
console.log('='.repeat(78))
const b5 = String(before).split('\n').filter((l) => /^5(\.\d)?\./.test(l))
const a5 = after.split('\n').filter((l) => /^5(\.\d)?\./.test(l))
console.log('\n--- 改前 ---')
for (const l of b5) console.log('  ' + l)
console.log('\n--- 改后 ---')
for (const l of a5) console.log('  ' + l)
console.log('\n改后总长度：%d 字符（改前 %d）', after.length, before.length)
console.log('目标文件：%s', FILE)

if (DRY) {
  console.log('\n（--dry：未写入任何内容）')
  process.exit(0)
}

const password = await askHidden('\n请输入宪法密码（不回显）：')
// 署名：默认 holder；可用 --operator=七月流火 传入真实署名。
// 注意：审计日志是"不可删"的设计，所以署名必须在**写入前**给对 —— 事后不改账本。
const OPERATOR = operatorFrom(process.argv) || 'holder'
try {
  const v = await store.update(after, password, OPERATOR, REASON)
  console.log(`\n已写入。新版本号：version ${v}（operator=${OPERATOR}）`)
  console.log(`审计日志已追加一条（含 before/after 全文与原因）。`)
} catch (e) {
  console.error(`\n写入失败：${e.message}`)
  process.exit(1)
}
