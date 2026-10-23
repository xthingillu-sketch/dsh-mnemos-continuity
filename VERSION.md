# 版本标识 · Mnemos v1.6.0

| 项 | 值 |
|---|---|
| **版本** | **v1.6.0**（`package.json` 的 `version`）—— 见下方「版本流水」 |
| 本目录 | **当前发行副本**（可发布内容；解压后即成为 `<你的路径>\mnemos\`） |
| 打包日期 | 2026-10-21（**代码/文档已就位；npm 与 rar 尚未发布**） |
| 构成 | `src` **26 个模块** + `scripts` 4 个 + `test` 1 个 + `docs` **npm 5 件 / 发行 rar 9 件**（4 套 docx，rar 另有 4 份 pdf，外加 1 份纯 md）+ 2 个示例技能；工具 **19** 个；心跳 **8** 项 |
| 文档 | `简介-introduction`（是什么·该不该用）· `架构总览`（部件与数据流）· `architecture-机制清单`（每个机制保证什么、边界在哪）· `设计者视角`（为什么这样设计，按设计目标重写） |
| 对应压缩包 | 本版**尚未重打**；同级 `mnemos.rar` 仍是旧包。发布前重打并更新摘要 |
| 同版本存档 | 发布后再补 `mnemos-历史版本\v1.6.0\` |


## 版本流水

| 版本 | 内容 | 性质 |
|---|---|---|
| **v1.6.0**（本版） | **认知架构收口（未发布）**：① 任务图升级为「任务档案/寻址空间」（done/uses/links + 读时投影 + 上限代码强制；新增 task_done/task_cite，工具 19）；② 技能体补入口与三档来源（失败→修好 / 记忆反复 / 外部改写；外部默认只暂存、保留需用户确认）；③ 评审状态记录 lastApplied、外部写入可见（refresh）、learner 不再误回滚换代、评审/验证解析失败三态；④ pending 台账（外来不记账、status、去重、过期清理）；⑤ 折叠快照改短期兜底（事实卡 + 提醒带 top3 + 7 天 TTL）；⑥ 系统提示 25 条 / 7 节（约 3.5k 字符；任务图独立成节、多模型协作必须开图；单步小事别开；workflow 交接纪律）。测试 **1330 / 0** | ✅ 代码：`store` / `index` / `skill-review` / `compaction-snapshot` / `system-prompt` 等；文档：README / INSTALL / 四份对外文档 |
| **v1.5.10** | **改 npm 包名（项目名不变）**：`dsh-mnemos` 这个名字在 npm 上**已被另一个独立项目占用**（别人写的、思路不同、不是同一套代码，且发布时间更早）。按用户决定：**项目名仍叫 Mnemos**，npm 包名改为 **`dsh-mnemos-continuity`**（`continuity` 指"换会话、换模型之后判断还能接着用"）。同步改动：`cordis.patch.yml` 的 bundle `name`（**entry id 仍保留 `dsh-mnemos`**，故 profile 里的配置覆盖不用动）、INSTALL 五处命令、README 新增一段"名字说明"（含与同名项目的消歧）。本机 `desktop` profile 的 deps / bundles / junction 已改名并**重启实测通过**（工具正常、`profileContext` 正确）。历史存档不动（也不发布）。测试仍 **1225** | ✅ 包：`package.json` / `cordis.patch.yml`；文档：README / INSTALL |
| v1.5.9 | **npm 包瘦身**：`files` 里的 `docs` 改为 `docs/*.docx` + `docs/*.md` —— **npm 包不再带 PDF**（本机 rar 仍保留完整 4 套 docx+pdf，因为那是给下载的发行包）。包体 **2.24 MB → 370.6 KB**、文件数 47 → **43**（docs 仍 5 件：4 份 docx + 1 份模块文档 md）。用户决定："有一份就够了，没必要提供两份占空间"。除此之外与 v1.5.8 完全相同（含 P0 数据目录修复）。测试仍 **1225** | ✅ 包：`package.json`（files） |
| v1.5.8 | **修数据落点（P0）+ 安装审查的其余条目**：① **P0 默认数据目录解析错** —— 插件原先按 `DSH_PROFILE_DIR → DSH_HOME → cwd` 猜，而那三个在插件进程里都不可靠（`DSH_PROFILE_DIR`/`DSH_HOME` 只注入给 shell 工具不注入插件；桌面版只是碰巧靠 cwd 对）。后果：换启动方式会把记忆写进**别的 profile** 或当前目录（外部安装审查实测写进了另一个 profile）。现改为 **`config.dataFile` > `ctx.get('profileContext').dir` > 环境变量/cwd（兜底）**，启动日志第一依据改成 `profileContext=`；**已用"污染环境变量"的对照实验验证**（临时 profile + 假 DSH_PROFILE_DIR/DSH_HOME/cwd → 仍写进自己的 profile）。② **npm 包会缺全部 docs** → `files` 补 `docs`/`examples`/`VERSION.md`（发行副本 pack 47 文件 / 2.3 MB）；③ **宪法初始化要 node 而文档说不需要** → INSTALL 补 `ELECTRON_RUN_AS_NODE=1` + DSH 自带 exe 的无 Node 路径；④ P2：补 `scripts.test`、peer 告警口径改正（所有安装方式都可能出现、无害）、`link:` 路径写明"指到含 package.json 的那一层"、清掉三处"留空跟随主会话"的过时注释、加 `engines.dsh` 声明（**未能证实宿主真的检查它**）。测试仍 **1225** | ✅ 代码：`index.js` / `paths.js`；包：`package.json`；文档：INSTALL / 测试断言 |
| v1.5.7 | **打包形态 + 文档 + 清理**，不改运行行为：① **改造成标准可安装 bundle** —— 去掉 `private`、加 `dsh.bundle.patch`、`peerDependencies` 只留 `schemastery`、`files` 补 `INSTALL.md`；`dsh plugin --profile <p> add` 实测可装（`--dump-config` 里能看到 `dsh-mnemos` 行）；② **删掉 learner 回退留下的死代码 156 行**（`makeHostLauncher` / `findLiveParentAgent` / `lastSeenAgent` / `captureSeenAgent` / `launchHostChild`）；③ **新增对外文档 `docs/模块与功能实现.md`（纯 md，不生成 docx）** —— 26 个模块逐一说"有哪些功能、怎么实现"，**附录逐字给出宪法原文与系统提示原文**；README 文档地图从六份改为七份并加指路；④ **口径对齐**：开场与 INSTALL 首段改成"不是更大的记忆库，而是换模型/换会话后还能高效用上"（不把存记忆当卖点）；⑤ **作者信息定案**：`LICENSE` 与 `package.json` 写入「七月流火 <2151926500@qq.com>」（此前发行副本是 `<YOUR NAME>` 占位符）；⑥ 内部材料（`V1.5-修复与更新记录.md`）加入同步清理清单，确保不进发行包。测试仍 **1225** | ✅ 代码：`src/index.js`；包：`package.json`、`LICENSE`；文档：README / INSTALL / 简介 / 新增模块文档 |
| v1.5.6 | **行为回退**：空闲学习**回到"必须配第三方 api"的老形式**，不再走宿主派活。理由（用户定的）：① 后台运行时**几乎不存在活着的父会话**，宿主派活必然频繁走不通；② 宿主派活的子会话**挂在父会话的智能体下面**，人不好看见 —— 后台任务应当独立、可观测。实现上：learner 移除 `launchChild` 接线、恢复"未配 learnerProvider+learnerModel 即不工作"的守卫；**保留**两处真 bug 的修法：learner **默认不 resume**（resume 出来的会话补不上工具集）、每脚 `create` 才会选 preset；**隔离验证仍走宿主派活**（它是一次性子会话、有活父会话可用，也不长期挂在某个会话下面）。文档同步：INSTALL（前提表/示例/为什么必须第三方/会话生命周期）、简介 §三、机制清单「空闲学习」行、README 代价段。测试 1231 → **1225**（删掉两个宿主派活用例） | ✅ 代码：`index.js` / `learner-loop.js`；文档：INSTALL / 简介 / 机制清单 / README |
| v1.5.5 | **修掉一处长期浪费**：技能评审的 `no-change` 判定不记"这批证据已判过"的水位 —— 同一批反馈（同一段对话被反复切片成不同信号序号）在 24 小时里被重评 30+ 轮，判词几乎逐字相同（连模型自己都在判词里建议"同输入别再转"）。现在给每批评审证据记**批次指纹**（按反馈**文本内容**去重排序 + revision），同指纹判过 no-change 即跳过，心跳回执里新增 `cached` 计数让"省了几次"可见。另：**会话存档型巨物不再抢召回前排**（归档产物按 `archiveOf`/体积识别，关键词分打 1/4 + 同等条件下让位；降权不是过滤，只有它匹配时仍召得回）—— 历史 7 条同款一并生效。测试 1221 → **1231** | ✅ 代码：`skill-review.js`；文档：机制清单（含「分层与归档」补一句召回降权） |
| v1.5.4 | **修 + 打磨**：① 空闲学习改走**宿主派活**并在 DeepSeek 默认路由上实测跑通（真跑两轮，产出真实），因此 **learn 的 provider/model 默认留空 = 跟随主会话**；② 修 learner 自查出的两个缺陷 —— `D-1` 重建失败也提交换代（每次失败烧一个 id、`recycled` 失真、状态停在从未建成的 id 上）、`D-2` 回收原因写死"宿主重启过"（真实判据只是取不到会话）；③ 走宿主派活时**不再计算回收**（去噪）；④ 派活透传 `request.cwd`（宿主子会话默认继承父 cwd，导致 learner 产出写进主会话目录）；⑤ 新增**载入期冒烟闸** `smoke-apply.mjs`（抓"apply() 抛错导致插件整块不加载"，已接进打包脚本）；⑥ INSTALL 修正 preset 示例：**persona 里不能写 `{{cwd}}`**（宿主只注册 provider/model/self_narrative）。测试 1219 → **1221** | ✅ 代码：`index.js` / `learner-loop.js` / `tool-output.js`；文档：INSTALL / 简介 |
| v1.5.3 | **机制更新：默认只用一个模型**。隔离验证与空闲学习都改成**走宿主的派活通道**（`subagents.startActivation`，宿主代建子会话）—— 实测自建 agent 走 DeepSeek 自家路由必 `TRANSPORT`，而宿主代建在同一路由上能跑，于是两者**默认都跟随主会话模型**（开箱可用，不再要求配第三方 api-key）。想换模型：`validateProvider`/`validateModel`、`learnerProvider`/`learnerModel` 各自指定（留空 = 跟随主会话）。空闲学习也因此变成"每踢一轮一个新子会话"，不再需要 5 轮/350KB 的重建（旧路径保留为回退）。测试 1213 → **1219** | ✅ 代码有变动：`index.js` / `learner-loop.js`；文档：INSTALL |
| v1.5.2 | **修复**：DSH 0.2.x 更新把 `subagents` 的"一次调用拿结果"改成了异步激活（`start` 消失），`mnemos_validate` 直接报 `subagents.start is not a function`。重写为「起一个独立小会话 → 它把结论写进记忆 → 父会话按 sessionId 取回」（新增 `store.validationBySession`），并解决沿途四个坑：不给 preset/不传 agentOptions 都会因 `{{model}}` 无值整轮报错；照抄父会话路由会让 DeepSeek 自家路由对"插件自建 agent"必 TRANSPORT —— 改为 `validateProvider` > `learnerProvider` > 父会话 三级回退。另：纪律 ⑭ 补「验证通道不可用 → 不得用"觉得有道理"顶替，按未验证处理」。测试 1205 → **1213** | ✅ 代码有变动：`index.js` / `store.js` / `system-prompt.js`；配置新增 `validateProvider` / `validateModel` |
| v1.5.1 | **修复 + 新增**：① 修掉 learner 的根因缺陷 —— 宿主重启后旧会话走 `resume` 恢复，而宿主的 `agentPresets.select()` 只允许在会话第一轮之前调用，恢复出来的会话**挂不上 preset**，工具集退化（够用的读/查/联网工具都没挂上，只剩最基本的几个）（没有 read/glob/grep、没有联网），表现像"网络异常"。现在：**不活着就直接换新一代会话**、新 id 直接 `create`（保证能选 preset），回执里写 `reason=restarted`；② README 新增「**风险与责任**」一节（四类能力 + 责任划分 + 反对滥用）。测试 1196 → **1205** | ✅ 代码有变动：`learner-loop.js`；文档：README / INSTALL |
| v1.5.0 | **机制版本**，一次性改了五块：① **删掉"台账版"空闲学习**（模块 / 配置 / 测试 / 两份台账数据全部移除）；② **空闲学习重做**：专用会话 + 定期换新重建（避免上下文撑爆而整轮被拒）+ 自指守卫（learner 不许自己踢自己）；③ **技能评审修活**：内置技能的反馈曾把评审水位永久钉死（空转数日），改为入口处"只判自家技能"；**修改写回默认开启**（仍保留评审 + 独立验证 + 回归门 + 旧版回滚）；④ **折叠快照收缩**：移除 100% 噪音的修剪通道，只在折叠时存，并在折叠后**注入一条指针提醒**（含记忆 id）；⑤ **多 agent 协作（新增）**：任务图三件套 + **归档闸门**（未收尾任务的记录不许被归档；隔离验证记录同理且超窗销毁）+ 系统提示新增第六节 + 孤儿任务图回收。另有：注入消息构造收敛到单一入口（修掉一次会话崩溃）、系统提示与工具描述按"用法归工具、纪律归提示"去重。测试 **1000 → 1196** | ✅ **代码有变动**：新增 `host-message.js`；删除 `docs-study.js`；改动 `store` / `index` / `system-prompt` / `skill-review` / `compaction-snapshot` / `learner-loop` / `tool-output` / `tool-results`；工具 14 → **17** 个 |
| v1.4.1 | **修复**：空闲学习的专用会话在 GUI 里打不开 —— 原实现只做 "get → create"、刻意不 resume，重启后那个会话不是"活着的 agent"。改为 **get → resume → create** 三级兜底；同时给会话传工作目录、新增 `learner.log` 诊断。测试 **996 → 1000** | ✅ 代码有变动 |
| v1.4.0 | **机制更新**：新增**空闲学习** —— 到点把一脚送进一个专用会话，由它自己决定学什么，也可以什么都不学；心跳只负责"何时踢"。新增 `learner*` 配置组。测试 972 → 996 | ✅ 代码有变动：新增 `learner-loop.js` |
| v1.3.0 | **机制更新**：心跳新增 `docs_study`（文档学习提醒，纯本地、不联网）。**该机制已在 v1.5.0 移除**。测试 945 → 972 | ✅ 代码有变动（后被移除） |
| v1.2.0 | **仅文档更新**：文档按职责重写 —— 只留一个 README（介绍）+ `INSTALL.md`（装与配）；两份文档改名；删除全部旧版迁移内容 | ⚠️ 代码未变 |
| v1.1.0 | 仅文档更新：新增《设计者视角》（"为什么"的唯一源头），介绍文档按它重写 | 代码未变 |
| v1.0.0 | 首个正式发行版（相对 v0 的修复：数据不丢、结论不丢、故障不静默、技能生成可控闭环） | 机制版本，已冻结存档 |
| v0（事后编号） | 未定版 | 存档 |

> **版本号判据**：看**发行物内容**，不看工作区 —— 改机制 / 行为 / 契约才升；只改描述通常不升；
> 但发行物**构成**变了（新增 / 改名 / 删除文档）也要递进。

## 怎么确认这是我说的那一版

1. `package.json` 的 `version` 应为 **1.6.0**；
2. 本目录下跑 `npm test`（等价 `node test/store.test.js`）应为 **1330 通过 / 0 失败**；
3. 启动日志（`<profile>\mnemos\mnemos.log`）的「解析依据」第一段应是 **`profileContext=<该 profile 目录>`** ——
   若第一依据还是 `DSH_PROFILE_DIR`/`cwd`，说明跑的是 v1.5.8 之前的代码；
4. 文档件数分两种形态：
   - **npm 包 / `repo-stage/docs`：5 件**（4 套 docx + 1 份纯 md `模块与功能实现.md`，**不带 PDF**）；
   - **发行 rar / `Selfdata/docs`：9 件**（4 套 docx + 4 份 pdf + 1 份纯 md）。
   四套是：`简介-introduction`（是什么 · 该不该用）、`架构总览`（部件与数据流）、
   `architecture-机制清单`（每个机制保证什么、边界在哪）、`设计者视角`（为什么这样设计，v1.6 按设计目标重写）。

## 发行方目录里各份 mnemos 是什么关系（避免拿错）

| 位置 | 是什么 | 该不该拿来装 |
|---|---|---|
| 本目录（`mnemos\`） | **当前发行副本**（v1.6.0，代码与文档已就位；**尚未发布**） | ✅ 要装就用这个目录；npm/rar 等发布后再分发 |
| `mnemos.rar`（同级） | 本目录的压缩包（旧版） | ⚠️ **本版尚未重打**；发布前重打并更新摘要 |
| `mnemos-历史版本\` | 已定版的压缩包存档（含 v1.5.10 及更早） | ⚠️ 只在回退 / 对比时用；v1.6.0 发布后补存档 |
| `mnemos.backup-before-sync\` | 最近一次同步**之前**的快照（回滚点） | ❌ 不是发行物 |
| 备份区（`发行备份\`） | 历次同步的时点快照 + 验收日志 + `源文件-*`（可复现源） | ❌ 不是发行物 |

> 一句话：**装用 `mnemos\`；存档看 `mnemos-历史版本\`；回滚点看备份区。**

## 文档的引用方向（读的顺序）

```
docs/设计者视角                  为什么这样设计（唯一源头）
docs/模块与功能实现.md           每个模块有哪些功能、怎么实现（附录=宪法原文+系统提示原文；纯 md）
      ↓ 被引用
docs/简介-introduction           是什么 · 能做什么 · 代价 · 该不该用
      ↓
README.md（门面）                 四件最不像别人的事 + 代价 + 文档地图
      ↓
docs/架构总览                     由哪些部件组成、一轮怎么跑通
      ↓
INSTALL.md                       怎么装、怎么配、数据在哪、怎么备份
      ↓
docs/architecture-机制清单        每个机制保证什么、边界在哪
```

**只允许下层引用上层，上层不复述下层。**
