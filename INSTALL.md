# 安装与配置 Mnemos

> 这份文件只写**你要做的事**：装、配、验证、排错、数据放哪。
> 它是什么、值不值得用 → `docs/简介`；有什么机制 → `docs/architecture-机制清单`；为什么这样设计 → `docs/设计者视角`。

## 三十秒摘要（省你十分钟）

Mnemos 是**装在你机器上的一套「让判断跨会话、跨模型继续可用」的东西** —— 记忆、技能、规则都是普通文件。
重点不是存了多少，而是**换模型/换会话之后还能被高效用上**。安装有个特点：**代码目录与数据目录是分开的**。

**先确认前提**：本插件跑在 **DeepSeek Harness（DSH）** 里。终端敲 `dsh --version` 出版本号 = 你有了；
没有的话，先去获取 DSH（本文件只讲插件）。

由此三条，后面的每一步都在为它们服务：

1. **这个包不含任何运行数据，也不含宪法** —— 覆盖安装不会碰到你的记忆；
2. **只有宪法初始化必须你本人做**（要设密码）；注册插件就是一条命令（见第 2 节），AI 可以代劳，**宪法不该代劳**；
3. **装完要确认的不是"它跑起来了"，而是"它找对了数据在哪"** —— 看一眼日志就知道。

> **保守起步（推荐第一次就这么做）**：装完先关掉后台维护 —— `heartbeatEnabled: false`（见第 10 节），
> 只留"写记忆 / 召回 / 任务续接"，确认对你真有用再一项项开回来。
> 空闲学习（learner）本来就是默认关的。这样第一晚不会有任何自动的 AI 调用，也就不会有惊喜账单。
>
> **关掉之后还剩什么**（这张表就是"保守起步"的全部代价，先看清再决定）：
>
> | 仍然可用 | 暂时失效（都在心跳里） |
> |---|---|
> | 写记忆 / 检索 / 取详情 · 标记作废 · 暂时无关 · 真删除 · 隔离验证 · 任务图三件套 | 闲置降权 · 按龄归档 · 超量归档 · 验证记录超窗销毁 · 孤儿任务图回收 · "该用未用"判定 · 技能评审 |
>
> 也就是说：**记忆会一直往里长，但不会自动整理**。想整理时手动说一句"把这次会话归档"（`mnemos_consolidate`）即可；
> 其余功能随时可以把 `heartbeatEnabled` 改回 `true` 再开。

---

## 0. 前置

- **DSH 已安装**并能正常启动（终端 `dsh --version`）；
- 安装不需要 Node.js：`dsh` 自带运行时。
- 如果走"本地目录安装"（方式 B），那个目录要放在**稳定位置**、之后别随便搬 —— 它在 profile 里是链接引用。

## 1. 确认装到哪个 profile

```bash
dsh --help                 # 看用法
ls ~/.dsh/profiles         # 看有哪些 profile（桌面版一般是 desktop）
```

记住目标 profile（下文用 `<profile>` 代指）。

## 2. 安装

本包是标准 **bundle**：`package.json` 里带了 `dsh.bundle.patch` 声明，
所以**装上去它自己会登记到组合树里**，你不用手工改 profile 补丁。

### 方式 A（推荐）：从 npm 装

> npm 页面：<https://www.npmjs.com/package/dsh-mnemos-continuity>（版本号以那里为准）
> 项目名仍叫 **Mnemos**；`continuity` 指的是"换会话、换模型之后判断还能接着用"。

```bash
dsh plugin --profile <profile> add dsh-mnemos-continuity   # 从 npm 安装（已发布）
dsh plugin --profile <profile> add github:<user>/<repo>    # 从 GitHub 直装
```

### 方式 B：从本地目录装（想用仓库里的代码、或离线时）

```bash
# 路径可以带引号；Windows 用正斜杠更稳
dsh plugin --profile <profile> add "link:<解压后**含 package.json 的那一层**的绝对路径>"
```

> RAR 解压出来通常多一层（`mnemos/`）—— **必须指到里面有 `package.json` 的那一层**，指到父目录会装错。
>
> `dsh plugin` 后面接的是 **pnpm 参数**（`add` / `remove` / `why` …），它会在 profile 目录里执行。
> 装完可以确认它真的进了组合树：

```bash
dsh --profile <profile> --dump-config | grep dsh-mnemos-continuity
# 期望看到：  - id: dsh-mnemos   /   name: dsh-mnemos-continuity
```

> **所有安装方式都可能看到一条 peer 依赖告警**（`Issues with peer dependencies found`）——
> 因为 DSH 的 profile 模板设了 `autoInstallPeers: false`，而 `@deepseek-ai/schemastery` 由宿主提供。
> **这条告警无害**：插件能正常加载（实测），不用处理。

<details>
<summary>如果 <code>dsh plugin</code> 不可用（手工兜底，不推荐）</summary>

1. 编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- id: dsh-mnemos
  config: {}          # 配置项见第 10 节，都可省略
```

2. 确保该 profile 的 `package.json` 的 `dependencies` 里有本包（`file:` / `link:` 指向解压目录，或版本号）。
3. 完全重启。
</details>

## 3. 更新到新版本（已经装过，要升级）

好消息：**数据不在这个包里** —— 更新只换代码，不碰你的记忆。

```bash
# 方式 A（包名/GitHub 装的）
dsh plugin --profile <profile> add dsh-mnemos-continuity@latest
dsh plugin --profile <profile> add github:<user>/<repo>     # 从 GitHub 装的就重装一次

# 方式 B（本地目录装的）：解压新包覆盖同一目录即可（链接路径不变），或解压到新目录后重新 add
```

然后：

1. **先备份**（稳妥做法）：完全退出 DSH，复制三样（`memory.json`、`constitution.json`、`skills/`，位置见第 11 节）；
2. **完全重启**（同第 4 节）；
3. 按第 6 节验证，重点看两处：
   - `package.json` 里的 `version` 是不是你要的那一版；
   - `mnemos.log` 里的 `dataFile=` 还是原来那份 —— 若变了，说明路径解析变了（**数据没丢**，把配置指回去即可）。

> ⚠ 不要把数据目录放进代码目录 —— 那样覆盖安装时容易被一起替换掉。

**回滚**：`dsh plugin --profile <profile> add dsh-mnemos-continuity@<旧版本号>`；本地安装则把旧包换回来 + 重启。
发行方也保留了历次版本存档（`mnemos-历史版本\v<版本>\`）。

**卸载**：

```bash
dsh plugin --profile <profile> remove dsh-mnemos-continuity
```

> 卸载**不会删你的数据**（记忆、宪法、技能都在 profile 的数据目录里，见第 11 节）—— 要清干净得自己删那个目录。

> 本版**没有数据格式变更**；将来若有，会在 `VERSION.md` 的版本流水里写明。

## 4. 完全重启（必须）

**完全退出 DSH 再启动** —— 不是刷新页面，也不是"重新加载窗口"。

## 5. ★ 初始化宪法（只有你本人能做）

**在包根目录下运行**（`scripts/` 就在那儿）：

```bash
# 有 Node（装了 Node.js ≥22）：
node "<插件目录>/scripts/init-constitution.mjs" --file="<启动日志里 constitutionFile= 打印的那个路径>"

# 没装 Node：用 DSH 自带的运行时跑同一个脚本（Windows）
$env:ELECTRON_RUN_AS_NODE = 1
& "<DSH 安装目录>\DeepSeek Harness.exe" --expose-internals `
  "<插件目录>\scripts\init-constitution.mjs" --file="<启动日志里 constitutionFile= 打印的那个路径>"
```

- 那个路径从 `mnemos.log` 里抄（见第 6 节）——**别自己猜**，猜错了等于没初始化；
- 它需要你**亲手设一个密码**，密码不落盘 —— 这是"宪法不被偷偷改"的保证，所以 AI 不能也不该替你做；
- 只想看默认内容、不写盘：加 `--print`。

⚠ **初始化成功后必须再完全重启一次 DSH**：宪法只在插件启动时装载，不会热加载。
不重启的话，会话里仍会看到"宪法 · 未初始化"的警告 —— 那不是失败，是还没生效。

**自动化场景（CI / 容器）**：把初始化好的 `constitution.json` 放到目标位置即可（插件只读它）。

## 6. 验证装好了

1. **看日志**：`…/mnemos/mnemos.log` 每次启动追加三行，第三行是解析依据：

   ```
   mnemos: dataFile=C:\...\profiles\<profile>\mnemos\memory.json
   mnemos: constitutionFile=C:\...\profiles\<profile>\mnemos\constitution.json
   mnemos: 解析依据 profileContext=<profile 目录> / DSH_PROFILE_DIR=(未设) / DSH_HOME=(未设) / cwd=...

> **看第一段 `profileContext=` 才是准的**（插件的默认数据目录以它为准）。
> `DSH_PROFILE_DIR` / `DSH_HOME` 在插件进程里通常是"(未设)"——它们只被注入给 shell 工具，不是插件环境变量。
   ```

   路径不对就改第 10 节的 `dataFile` / `constitutionFile`。**宪法没初始化时会给出可见警告**，不会静默变空。

2. **写一条、再查一条**：让它写一条记忆，然后**新开一个对话**检索 —— 能召回就说明链路是通的。

3. **看工具挂上没有**：让它列出 `mnemos_*` 工具（清单见第 7 节）。

## 6b. 续接任务：换个会话接着干（**这招用户最常不知道**）

记忆**不跟会话走、也不跟工作区走**：同一份数据在 profile 目录里。所以——**关掉当前对话、过几天在另一个目录开个新会话，
让它先检索，就能接着上次的活干**；不需要"同一个对话窗口"才能保持连续。

### 默认做法：直接说一句"继续之前的 X"

平时写下的结论都在记忆里，新会话里说一句"继续之前的 X"，它会把相关结论找回来接着做。
**不需要记任何编号。**

### 要精确时：让它在原对话里给你一份"续接方案"

如果任务多步、中间状态多、怕接错 —— 回到**原来的对话**，直接说：

```
给我一个续接方案：把当前任务的状态整理成一条记忆，带任务号，并告诉我下次怎么用它接上。
```

它会把状态记下来（做到哪、下一步、踩过的坑）并给你一个任务号。之后在**任何**新会话里按它给的做即可，例如：

```
用 mnemos_recall 带 taskId=<它给的任务号> 取回那份续接状态
```

为什么这时候才需要任务号：**检索是关键词 + 标签匹配**，不是语义检索 —— 换个说法可能就召不回；
任务号是**最可靠的锚**。所以它不是必须记的编号，而是"要精确时才需要的那把钥匙"。

> 边界：**没写下来的就等于没发生**；任务号只保证"取得回"，不保证"是最新的" —— 状态变了就再要一份；
> 不同 profile 之间默认不共享（除非把数据路径指到同一份）。

## 7. 它装好之后提供了什么（工具）

| 工具 | 作用 |
|---|---|
| `mnemos_remember` | 写记忆（自动盖会话标记；可一次完成"写纠正 + 作废旧条"） |
| `mnemos_recall` / `mnemos_open` | 检索摘要 / 取某条详情 |
| `mnemos_consolidate` | 把本会话的短时记忆归档为长期 |
| `mnemos_validate` | 在隔离会话里验证外部信息 |
| `mnemos_constitution` | 读宪法（只读） |
| `mnemos_delete` | **真删除**（不可恢复） |
| `mnemos_deprecate` / `mnemos_dormant` | 标记作废 / 标"本轮暂时无关"（可撤销） |
| `mnemos_propose_skill` | 提议新建技能（failure-fixed 要反例+正例；memory-recurring 要 ≥3 个跨会话事件、正反例至少一种；external-rewrite 要来源记录，且默认只暂存、保留需你确认） |
| `mnemos_task_open` / `mnemos_task_update` / `mnemos_task_close` / `mnemos_task_done` / `mnemos_task_cite` | 任务图（任务档案/寻址空间）：开图 / 填回执 / 收尾 / 记已完成里程碑 / 登记依赖 —— 派活、跨会话、或会产出多条记忆时用；未完成步骤用宿主 todo，图不复制结论正文 |
| `mnemos_heartbeat` / `mnemos_maintenance_list` / `mnemos_heartbeat_toggle` | 手动跑一次维护 / 看维护清单 / 关心跳 |
| `mnemos_learner_kick` | 立刻踢一轮空闲学习（诊断用，也可主动触发） |

## 8. 后台维护在做什么（心跳）

`decay`（衰减降权）· `archive_due`（按龄归档）· `archive_when_full`（超量归档）·
`prune_validation`（隔离验证记录超窗销毁，留台账）· `reclaim_tasks`（孤儿任务图超期强制归档）·
`missed_usage`（该用未用判定，**会调 AI**）· `review_skills`（技能评审，**会调 AI**）

**一个定时器跑整张注册表**：`heartbeatIntervalMs` 管的是全部维护任务。
运行时开关默认在每轮对话开始时被置回开启；要**持久关闭**，在配置里写 `heartbeatEnabled: false`。

## 9. 空闲学习（可选，默认关）

> **这一节可以整段跳过**：它默认是关的，跳过不影响上面任何一步。只有你打算开它时，才需要读下去 ——
> 下面这些是把它开起来才会遇到的坑（preset、provider 路由、工作目录），不是使用这个插件的前提知识。

到点了，它把"一脚"送进一个**专用会话**，让模型自己安排这一轮：读你留的任务，没任务就自由学点，也可以什么都不做。
**不占用、不污染你正在用的对话。**

### 两个前提，缺一不可

| 前提 | 配置 |
|---|---|
| ① 打开开关 | `learnerEnabled: true`（默认 false） |
| ② 配好外部 API | `learnerProvider` + `learnerModel`（**必须**，缺一即不工作；为什么不能用 DeepSeek 自家路由见下） |

```yaml
- id: dsh-mnemos
  config:
    learnerEnabled: true
    learnerIntervalMs: 3600000         # 1 小时
    learnerProvider: <provider-id>     # 必须：带 key 的第三方路由（见下）
    learnerModel: <model-id>
    learnerAgentPreset: standard       # 不设它就没有联网/读文件工具（也可自建精简 preset，见下）
```

> **默认用什么模型**：没有默认 —— **必须自己填** `learnerProvider` + `learnerModel`（带 key 的第三方路由），留空即不工作。
> 想让它跑在别的模型上，就显式填 `learnerProvider` + `learnerModel`（必须是带 key 的 provider）。
> 注意：如果你把模型配错（比如配了一个拿不到凭据的 provider），回执与 `learner.log` 会记下失败原因，不会静默。

### 我们实际用的接法（可以直接照抄）

关键点是：**联网与学习是两套独立的接线，各走各的路由。**

| 用途 | 走哪条路由 | 为什么 |
|---|---|---|
| **联网**（`web_search` / `web_fetch`） | **DeepSeek 官方**（`web-search-deepseek`，凭据用 `DEEPSEEK_API_KEY`，key 存凭据服务、不写进配置） | 官方端点能真正拿到搜索结果；换第三方 Anthropic 端点会因缺计费头而**拿不到结果**（实测） |
| **空闲学习的模型** | **必须第三方 api-key 路由**（如阿里云 token-plan 的 `qwen3.8-flash`） | 空闲学习是**插件自己建**的 agent：后台几乎不存在活父会话，也就借不到宿主的派活通道；而自建 agent 走 DeepSeek 自家路由会稳定 `TRANSPORT`，第三方 api-key 一次就通。另外宿主派活的子会话会挂在父会话下面、人不好看见 —— 后台任务应当独立可观测 |

所以一句话：**官方 key 只用在"搜索"上，不用在 learner 的 LLM 上** —— 两者互不影响，也不用为了联网去动学习模型。

```yaml
- id: dsh-mnemos
  config:
    learnerEnabled: true
    learnerIntervalMs: 21600000          # 6 小时；每轮 token 取决于模型自己选的任务（未测量），频率低一点更划算
    learnerProvider: aliyun              # ★ 第三方 api-key 路由（必须）
    learnerModel: qwen3.8-flash
    # 留空 = 不工作：后台没有主会话可借，也不会退回 DeepSeek 自家路由
    learnerAgentPreset: standard         # 出厂 preset（带联网/读文件）；要收窄再自建，见下
```

> **为什么必须是第三方路由**：空闲学习是**插件自己建**的 agent —— 后台运行时几乎不存在"活着的父会话"，
> 所以借不到宿主的派活通道；而自建 agent 走 DeepSeek 自家路由会稳定 `TRANSPORT`（实测 5 次重试全败），
> 走第三方 api-key 路由一次就通。另一条理由：宿主派活的子会话挂在**父会话的智能体**下面，人不好看见。

### 工具集由 preset 决定

**不设 `learnerAgentPreset` 时，默认就是 `standard`** —— 它带联网与读文件工具，能正常学习。
只有当你**想收窄**工具集（比如不想要 shell / 子代理 / 待办这些），才需要自建一个精简 preset。

照抄这一行就够用：

```yaml
learnerAgentPreset: standard
```

想更克制（只留 **联网 + 读文件 + Mnemos 自己的工具**），自己声明一个再引用它 ——
把它和 `dsh-mnemos-continuity` 写进**同一份** `cordis.patch.yml`：

```yaml
- insert:
    - id: preset-mnemos-learner
      name: "@deepseek-ai/dsh-agent-preset"
      config:
        id: mnemos-learner
        plugins:
          - id: persona                  # ★ 必须：没它连 {{model}} 都没有值，整轮直接报错
            name: "@deepseek-ai/dsh-persona"
            config:
              prefix: 'You are a coding agent powered by the {{model}} model.'
              # ★ 不要写 {{cwd}}：宿主的提示变量只有 provider / model / self_narrative，
              #   {{cwd}} 会让子会话**第一轮就整轮失败**（unknown prompt variable）。
              suffix: 'Work inside the configured learner workspace; do not wander outside it.'
          - id: tool-fs                  # 读文件（同包也带 write/edit，拆不开）
            name: "@deepseek-ai/dsh-tool-fs"
          - id: tool-fs-search           # glob / grep
            name: "@deepseek-ai/dsh-tool-fs-search"
          - id: tool-web                 # web_search / web_fetch
            name: "@deepseek-ai/dsh-tool-web"
            config:
              fetch: true
          - id: tool-todo                # 宿主任务清单（系统提示 ㉔ 的"未完成步骤"）
            name: "@deepseek-ai/dsh-tool-todo"
            config:
              allowParallelInProgress: true
```

> `tool-todo` 是 v1.6 补上的：系统提示 ㉔ 要求未完成步骤写宿主 todo；没有它，learner 只能开图、却无法按规则记录未完成步骤。
>
> 另外，空闲任务的提醒会明确**禁止申请提权/审批**：用户不在旁边，提权请求会把这一轮卡住；需要提权的操作应跳过并回报。

然后 `learnerAgentPreset: mnemos-learner`。**两个坑**：

1. preset 里 `persona` 必须带上 —— 没它 `{{model}}` 就没有值、整轮报错。
   **但 persona 里别写 `{{cwd}}`**：宿主只注册了 `provider` / `model` / `self_narrative` 三个提示变量，
   写 `{{cwd}}` 会让子会话第一轮就失败（这条是实测踩出来的）；
2. **换 preset 后要先删掉旧的 learner 会话** —— 宿主只在"会话第一轮之前"选 preset，已跑过的会话不会补挂。

### 想立刻看它跑一轮

用 `mnemos_learner_kick`（`force: true` 可忽略间隔）。它会把**每一步的真实结果**回报：到点判定 / 新建还是恢复会话 / 是否选中 preset / 入队是否成功 / 入队后状态。

### 任务文件（你写，它读）

首次开启会自动生成（也可用 `learnerTasksFile` 指定）：`<memory.json 同目录>\learner-tasks.md`。

- 写**开放学习类**的事（"把 X 弄明白"），不用写成工单；
- **每次到点，文件内容原样送给模型**；文件开头的说明是 HTML 注释，不会当成任务送出去；
- **这个文件归你管**：想让某件事别再做了，你自己把那段删掉。
  ⚠ 说准一点：它手上确实有写工具，改不动是因为**这个文件在它的工作区之外、越界写会被拒** ——
  是沙箱挡住的，不是"机制保证它改不了"。

### 两条实测边界（值得先知道）

- **自指工具已加闸门**：弱模型会把 `mnemos_learner_kick` 当成"今天的任务"，连踢三轮零产出。现在这个工具在**执行处**拒绝 learner 会话自己调用它。
- **它发来的提权请求可以直接拒绝**：看到 `mnemos-learner` 请求提权，拒绝即可。

### 它靠什么、不靠什么

- **结论落记忆，不落会话** —— 专用会话被删也能重建，成果不丢；
- 同一时刻只用一个会话，残留会被清掉后重建，不会越堆越多；
- 它**不打断**正在忙的 agent（忙就跳过这一轮）；
- **每一轮都用一个（可能是全新的）会话**：不 resume 旧会话 —— resume 出来的会话补不上工具集
  （实测踩过：`read`/`glob` 全变 `unknown tool`）。回执与日志里可能看到"会话重建"。
  换会话不影响结论 —— 能留下来的只有写进记忆的东西。

## 10. 配置项（完整清单）

写在 `~/.dsh/profiles/<name>/cordis.patch.yml`：

```yaml
- id: dsh-mnemos
  config:
    # —— 存储 ——
    dataFile: ""                   # 记忆文件路径；留空 = 自动解析（见第 11 节）
    constitutionFile: ""           # 宪法路径；默认与 dataFile 同目录
    autobiographyBudget: 2000      # 自传体注入的字符预算
    # —— 心跳与归档 ——
    heartbeatIntervalMs: 1800000   # 心跳周期（毫秒），默认 30 分钟；0 = 禁用
    heartbeatEnabled: true         # 心跳初值；false = 持久关闭
    archiveMinAgeMs: 86400000      # 归档时间阈值（默认 24 小时）
    archiveMaxShort: 50            # 短时记忆数量阈值
    # —— 空闲学习（默认关） ——
    learnerEnabled: false          # ★ 默认关；开它必须同时配 provider + model
    learnerIntervalMs: 3600000     # 间隔（毫秒）；0 = 关掉
    learnerSessionId: "mnemos-learner"   # 专用会话 id（代码自建）
    learnerAgentPreset: "standard"       # ★ 决定有没有联网/读文件工具
    learnerTasksFile: ""           # 任务文件；留空 = memory.json 同目录
    learnerWorkspace: ""           # 会话工作目录；留空 = DSH 默认工作区
    learnerProvider: ""            # 留空 = 不工作（必须配第三方 api-key 路由）
    learnerModel: ""               # 留空 = 不工作
    learnerMaxTokens: 0            # 0 = 继承全局 agent 配置
    # —— 隔离验证（mnemos_validate）——
    # 子会话必须有自己的 provider/model；留空 = 复用 learnerProvider/learnerModel（推荐），再不行才用父会话的。
    # ★ 不要指望它跟父会话走 DeepSeek 自家路由：实测那条路对"插件自建 agent"一律 TRANSPORT 失败。
    validateProvider: ""           # 留空 = 复用 learnerProvider
    validateModel: ""              # 留空 = 复用 learnerModel
    # —— 技能 ——
    createWriteBack: true          # 新建技能是否直接入目录
    externalSkillWriteBack: false  # 外部来源技能是否允许自动入目录（默认只暂存，等你确认）
    reviewWriteBack: true          # 修改已有技能是否真的改写（false = 只出建议）
    maxSkills: 30                  # 技能目录容量上限
    reviewEnabled: true            # 是否启用技能评审
    reviewProvider: "deepseek-account"   # 必须与当前可用 provider 一致
    reviewModel: "deepseek-flash"
    reviewMaxPerCycle: 3           # 每周期最多评审几个
```

**一个耦合点**：`reviewProvider` / `reviewModel` 必须与当前可用的 provider 一致，否则技能评审会**静默失败**（技能不会变差，但也不会变好）。

## 11. 数据在哪 · 备份 · 换位置

**默认解析顺序**（`dataFile` 留空时）：

1. 配置里显式写的 `dataFile` / `constitutionFile`
2. 环境变量 `MNEMOS_CONSTITUTION_FILE`（宪法专用）
3. **宿主给的 profile 目录**下的 `mnemos/`（默认就是这里；插件用宿主 `profileContext` 取，不靠环境变量）
   再往下的兜底才是 `$DSH_PROFILE_DIR/mnemos` → `$DSH_HOME/mnemos` → `当前目录/mnemos`（只对脚本/无宿主场景有意义）
4. `$DSH_HOME/mnemos/`
5. 当前工作目录下的 `mnemos/`

不确定就看 `mnemos.log` —— 每次启动都打印实际解析到的两个路径。

**要备份三样**：`memory.json`（记忆）· `constitution.json`（宪法）· `skills/`（技能）。
都是普通文件，复制目录即可；建议**完全退出 DSH 后**备份，避免拷到写了一半的文件。

**换位置**：把 `dataFile` 与 `constitutionFile` 显式写上，指向新路径，然后完全重启。
**不要把同一份数据挂给两个正在运行的实例**（同机多进程有写保护，跨机器/网络盘未验证）。

**多 profile**：每个 profile 默认各一份数据（数据目录 = 该 profile 目录下的 `mnemos/`）。想让两个 profile 共用，就把两者的 `dataFile` 指到同一路径 —— 但那等于共用记忆与技能。

## 12. 出问题时

| 现象 | 原因 / 处理 |
|---|---|
| 重启后工具没出现 | 没**完全重启**；或 profile 装错了（回第 1 节） |
| 装了但行为像旧版 | 还是缓存：完全退出再启动，别用"重新加载窗口" |
| 出现"宪法 · 未初始化"警告 | 三种原因：① 第 5 节没做；② `constitutionFile` 指错路径；③ **第 5 节做了但没再完全重启一次**（宪法只在启动时装载） |
| 记忆"空了" | 看日志里的 `dataFile=` —— 大概率是路径指到别处，数据本身没丢 |
| 检索明显不准 | 召回是**关键词 + 标签**匹配（不是语义检索）：换关键词试，并检查标签是否覆盖关键类别 |
| 技能一直不变好 | `reviewProvider` / `reviewModel` 不可用 → 评审静默失败（技能不会变差，但也不会变好）。v1.6 起**没有"冻结"这回事**了，别去 `skill-review-state.json` 里找 |
| 子代理说"文件不存在"但明明有 | `glob` 用**绝对 Windows 路径**会静默返回 `No files found`。改用 `pwsh Get-ChildItem -File -Filter *.js` 或相对工作区根的路径。**静默假阴性比报错更危险** |
| 任务的临时结果在收尾时没了 | 那是设计：临时的默认丢弃，要留请显式标记。交付物别同时标成临时 |

## 13. 这个包**不含**什么（刻意如此）

不含任何运行数据（记忆、技能）、不含宪法、不含你的密钥。
**所以覆盖安装不会碰到你的记忆**：数据在 profile 目录下，与代码目录分开。

> **使用限制与责任**：这套能力在善意使用下是效率工具，恶意使用会放大后果 —— 四类风险与责任划分
> 见 README 的「**风险与责任**」一节（很短，建议开空闲学习或联网前读一遍）。
