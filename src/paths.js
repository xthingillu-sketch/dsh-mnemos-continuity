/**
 * Mnemos 路径解析 —— 唯一实现（single source of truth）。
 *
 * ★★ 纪律：**路径规则只许在这个文件里算，别处不许再算一遍。** ★★
 *   本文件是「数据目录/记忆文件/宪法文件/技能根」的唯一实现。
 *   需要路径的地方一律 import 这里的函数（store.js / constitution.js /
 *   skill-provider.js / scripts/*.mjs 都已改成这样）；**不允许**再出现
 *   `path.join(env.DSH_HOME, 'mnemos', …)` 这类第二份解析。
 *
 * 为什么要有这个文件：此前「插件读哪里」与「脚本写哪里」是**两套各自实现的规则**，
 * 一旦不一致，就会出现最糟的一类故障 ——
 * **宪法被初始化到插件读不到的位置，于是身份段静默消失，而且不报错**（F-3 已核实）。
 * 本项目已有「同一份东西两处副本各自演化」的教训，所以合并到一处。
 * 光合并还不够：启动时必须把解析结果**说出来**（见 index.js 的 logResolvedPaths）
 * ——「静默」本身就是这个故障的一半。
 *
 * ★ 解析顺序（插件与脚本**同一套**）：
 *   1. 显式给出（插件=config.dataFile/constitutionFile；脚本=`--file=`）
 *   2. 环境变量 `MNEMOS_DATA_FILE` / `MNEMOS_CONSTITUTION_FILE`
 *   3. `$DSH_PROFILE_DIR/mnemos/…`   ← DSH 运行时更精确的那个（profile 级别）
 *   4. `$DSH_HOME/mnemos/…`          ← 兜底
 *   5. `process.cwd()/mnemos/…`      ← 纯 shell 下手动跑脚本时（仅对"默认"路径生效）
 *
 * ⚠️ 注意 3 与 4 **不相等**：实测 `DSH_HOME=C:\Users\<你的用户名>\.dsh`，
 *    而 `DSH_PROFILE_DIR=C:\Users\<你的用户名>\.dsh\profiles\<profile>` ——
 *    真实数据（memory.json / constitution.json）在**后者**下，
 *    `$DSH_HOME\mnemos` **不存在**。所以顺序里 profile 必须在前。
 *    （旧代码用的 `DSH_HOME || cwd` 会让插件去找 `$DSH_HOME\mnemos\constitution.json`
 *      这个空位置 → 宪法整段静默消失。）
 */
import path from 'node:path'
import { pickLogFile } from './boot-log.js'

/** 相对某个根拼出数据目录。 */
function dirUnder(root) {
  return path.join(root, 'mnemos')
}

/**
 * 以**宿主给的 profile 目录**为根拼数据目录（插件进程里的**首选**）。
 *
 * ★ 2026-10-18（外部安装审查的 P0）：插件进程里**看不到** `DSH_PROFILE_DIR`/`DSH_HOME` ——
 *   那两个是 `dsh-shell-env` 注入给 **shell 工具**的，不会写进插件进程的 `process.env`。
 *   桌面版能"碰巧对"只是因为它把 `cwd` 设成了 profile 目录；换三种启动方式就露馅：
 *     - 从普通终端 `dsh --profile X` → 数据落进**当前目录**；
 *     - 从另一个 DSH 会话的终端启动 → 继承**上一个 profile** 的 `DSH_PROFILE_DIR`，写进别人的数据目录；
 *     - 设了 `DSH_HOME` → 所有 profile 共用一份。
 *   宿主的 `profileContext.dir` 永远是当前 profile 的真值（`dsh-shell-env` 自己就是 `ctx.get('profileContext').dir`），
 *   所以这是插件里唯一可靠的来源。
 */
export function dirUnderProfile(profileDir) {
  if (!profileDir || typeof profileDir !== 'string') return null
  return dirUnder(profileDir)
}

/** 记忆/技能等运行数据的目录（按解析顺序找第一个可用的根）。 */
export function mnemosDataDir(env = process.env) {
  if (env.DSH_PROFILE_DIR) return dirUnder(env.DSH_PROFILE_DIR)
  if (env.DSH_HOME) return dirUnder(env.DSH_HOME)
  return dirUnder(process.cwd())
}

/** 默认记忆文件。config.dataFile 显式给了就不会走到这里。 */
export function defaultDataFile(env = process.env) {
  if (env.MNEMOS_DATA_FILE) return env.MNEMOS_DATA_FILE
  return path.join(mnemosDataDir(env), 'memory.json')
}

/** 默认宪法文件。config.constitutionFile 显式给了就不会走到这里。 */
export function defaultConstitutionFile(env = process.env) {
  if (env.MNEMOS_CONSTITUTION_FILE) return env.MNEMOS_CONSTITUTION_FILE
  return path.join(mnemosDataDir(env), 'constitution.json')
}

/** 技能根：与数据文件同级（skill-provider 也用它，别再各算一份）。 */
export function skillsRootFor(dataFile) {
  return path.join(path.dirname(dataFile), 'skills')
}


/**
 * 脚本侧：解析宪法文件位置（`--file=` → 环境变量 → 默认）。
 * 全落空时**报错并要求显式传入** —— 不猜（猜错就是 F-3 那个静默失效）。
 */
export function resolveConstitutionFileForCli(argv = process.argv, env = process.env) {
  const fromArg = argv.find((a) => a.startsWith('--file='))
  if (fromArg) return fromArg.slice('--file='.length)
  if (env.MNEMOS_CONSTITUTION_FILE) return env.MNEMOS_CONSTITUTION_FILE
  if (env.DSH_PROFILE_DIR || env.DSH_HOME) return defaultConstitutionFile(env)
  throw new Error(
    '无法确定宪法文件位置。请显式指定其一：\n' +
      '  --file=<路径>                        （推荐）\n' +
      '  环境变量 MNEMOS_CONSTITUTION_FILE\n' +
      '  或设置 DSH_PROFILE_DIR / DSH_HOME\n' +
      '例：node scripts/init-constitution.mjs --file="C:/path/to/mnemos/constitution.json"'
  )
}

/**
 * 启动时打印用：把本轮实际解析到的位置**显式说出来**（静默是 F-3 的病根）。
 *
 * @param {{dataFile:string, constitutionFile:string}} o
 * @param {object} [env]
 * @param {string|null} [logFile] 显式日志文件；省略 → 与 dataFile 同目录的 mnemos.log
 * @returns {string} 待打印文本；`o.logFile` 是它该落到哪个文件（F-17 追加用）
 */
export function describeResolved({ dataFile, constitutionFile, logFile = undefined, profileDir = null }, env = process.env) {
  // ★ 2026-10-18：加 `profileContext` 一行 —— 插件进程里真正可靠的是它；
  //   DSH_PROFILE_DIR/DSH_HOME 在插件进程里通常是"(未设)"，留着只为诊断"是不是被别的会话污染了"。
  const basis =
    (profileDir ? `profileContext=${profileDir}` : 'profileContext=(不可用)') +
    ` / DSH_PROFILE_DIR=${env.DSH_PROFILE_DIR ?? '(未设)'} / DSH_HOME=${env.DSH_HOME ?? '(未设)'} / cwd=${process.cwd()}`
  return {
    text:
      `mnemos: dataFile=${dataFile}\n` +
      `mnemos: constitutionFile=${constitutionFile}\n` +
      `mnemos: 解析依据 ${basis}`,
    // ★ 日志落点与"解析结果"是同一份事实：都由 paths.js（唯一实现）算，
    //   免得 index.js 再拼一遍路径（那就是又一份副本）。
    logFile: logFile === undefined ? pickLogFile(dataFile) : logFile,
  }
}

