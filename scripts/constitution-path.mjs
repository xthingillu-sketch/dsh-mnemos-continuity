/**
 * 宪法文件的路径解析（init / update 两个脚本共用 —— 不写两份，避免漂移）。
 *
 * ★★ 这里**不再自己实现解析规则**：规则唯一实现在 `../src/paths.js`
 *    （`resolveConstitutionFileForCli` 等）。本文件只做两件事：
 *    ① 把 paths.js 的解析函数**原样转发**出去，让脚本的 import 名称不变；
 *    ② 放两个与路径无关的小工具（askHidden / operatorFrom）。
 *
 * 为什么当初会出 F-3：插件与脚本**各有一套规则**，脚本按
 * `--file=` → `MNEMOS_CONSTITUTION_FILE` → `$DSH_PROFILE_DIR` → `$DSH_HOME`
 * 写进 profile 目录，而插件按 `$DSH_HOME || cwd` 去读 home 目录 ——
 * 「初始化成功」与「读不到」同时成立，且不报错。现在两边同一个函数，物理上无法再分叉。
 *
 * 解析顺序（唯一实现，见 src/paths.js）：
 *   `--file=<路径>` → 环境变量 `MNEMOS_CONSTITUTION_FILE`
 *   → `$DSH_PROFILE_DIR/mnemos/constitution.json` → `$DSH_HOME/mnemos/constitution.json`
 *   全部落空就**报错并要求显式传入** —— 不猜，也不留一个"看起来能跑"的假默认。
 * ★ 刻意**不硬编码任何个人路径**：本仓库要能直接给别人用。
 */
import { resolveConstitutionFileForCli } from '../src/paths.js'

/** 转发 paths.js 的唯一实现（保留原名，脚本侧 import 不必改）。 */
export function resolveConstitutionFile(argv = process.argv, env = process.env) {
  return resolveConstitutionFileForCli(argv, env)
}

/** 隐藏输入（密码不回显、不落盘、不进 shell 历史）。 */
export async function askHidden(prompt) {
  if (!process.stdin.isTTY) throw new Error('需要交互式终端来输入密码（不要在管道里运行；自动化请用 MNEMOS_CONSTITUTION_PASSWORD）')
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8')
    let buf = ''
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(wasRaw); stdin.pause(); stdin.removeListener('data', onData)
        process.stdout.write('\n'); resolve(buf)
      } else if (ch === '\u0003') {
        process.stdout.write('\n已取消\n'); process.exit(1)
      } else if (ch === '\u007f') {
        buf = buf.slice(0, -1)
      } else {
        buf += ch
      }
    }
    stdin.on('data', onData)
  })
}

/** 取自参数与环境变量的通用选项。 */
export function operatorFrom(argv = process.argv, env = process.env) {
  const a = argv.find((x) => x.startsWith('--operator='))
  if (a) return a.slice('--operator='.length)
  return env.MNEMOS_OPERATOR || ''
}
