#!/usr/bin/env node
/**
 * Mnemos 宪法初始化 —— **持有者专用入口**。
 *
 * 为什么需要它：
 *   宪法是「系统只读」的：Mnemos 自己没有写工具，`ConstitutionStore.initialize()` 需要**密码**。
 *   推理模块只持有密码哈希，因此**无法自行初始化宪法** —— 这是设计使然，不是缺陷。
 *   以前这一步只能靠"在对话里让推理模块去做"，但**它没有密码，做不到**；这个脚本补上那个入口。
 *
 * 用法：
 *   node scripts/init-constitution.mjs --file=<constitution.json 路径>
 *   随后交互输入：署名（operator）+ 密码（隐藏、需二次确认）
 *
 * 自动化（CI/容器）可用环境变量代替交互：
 *   MNEMOS_CONSTITUTION_PASSWORD   密码（注意：可能进 shell 历史，交互式更安全）
 *   MNEMOS_OPERATOR                署名
 *
 * 行为：
 *   · 已初始化则**拒绝重复初始化**（宪法不允许被悄悄覆盖；要改内容请用 update-constitution.mjs）
 *   · 默认写入**内置的 Mnemos 默认宪法**（身份/红线/边界/原则）；`--content=<文件>` 可换成自己的
 *   · 写入后打印版本号与文件路径；**绝不打印密码**
 */
import { promises as fs } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { ConstitutionStore } from '../src/constitution.js'
import { resolveConstitutionFile, askHidden, operatorFrom } from './constitution-path.mjs'

// 默认宪法来自独立模块（只导出数据、无副作用）—— 单一真相源，不要再抄一份。
import { DEFAULT_CONSTITUTION } from './default-constitution.mjs'

const argv = process.argv

async function main() {
  // --print：只打印默认宪法，不写盘、不需要密码。给人看不改动任何东西。
  if (argv.includes('--print')) {
    process.stdout.write(DEFAULT_CONSTITUTION + '\n')
    return
  }
  const file = resolveConstitutionFile(argv)
  const contentArg = argv.find((a) => a.startsWith('--content='))
  const content = contentArg
    ? await fs.readFile(contentArg.slice('--content='.length), 'utf8')
    : DEFAULT_CONSTITUTION

  const store = new ConstitutionStore(file)
  await store.load()
  if (store.isInitialized()) {
    console.error(`宪法已初始化（version ${store.version}）：${file}`)
    console.error('宪法不允许被悄悄覆盖。若要修改内容，请用 update-constitution.mjs。')
    process.exit(1)
  }

  let operator = operatorFrom(argv)
  if (!operator) operator = (await askHidden('署名（operator，会记入审计日志）：')).trim()
  if (!operator) {
    console.error('署名为空，已取消（审计日志需要知道是谁改的）。')
    process.exit(1)
  }

  let password = process.env.MNEMOS_CONSTITUTION_PASSWORD || ''
  if (password) {
    console.log('（使用环境变量 MNEMOS_CONSTITUTION_PASSWORD；注意它可能留在 shell 历史里）')
  } else {
    password = await askHidden('设置宪法密码（不回显）：')
    if (!password) {
      console.error('密码为空，已取消。')
      process.exit(1)
    }
    const again = await askHidden('再输一次确认：')
    if (again !== password) {
      console.error('两次输入不一致，已取消。')
      process.exit(1)
    }
  }

  const version = await store.initialize(content, password, operator)
  console.log('')
  console.log(`已初始化。version ${version}`)
  console.log(`文件：${file}`)
  console.log('审计日志已写入第一条（action=initialize，含 operator 与时间）。')
  console.log('')
  console.log('提醒：宪法**只能**经持有者修改；改动会追加 before/after 全文到审计日志（不可删）。')
}

// ★ import guard：本文件是**可执行脚本**，被 import 时不应产生副作用
//   （否则别人既拿不到常量、也复用它不了 —— 之前就是这个问题）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) await main()
