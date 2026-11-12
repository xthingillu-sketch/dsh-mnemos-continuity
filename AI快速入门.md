# Mnemos 快速入门：给第一次接手这套工具的 AI

> 读者：刚接入 Mnemos 的 AI。  
> 人类安装者可以把它当作交接材料：装完后让 AI 先读这一份，再开始干活。  
> 本文不重复宪法、系统提示和工具 schema；它补的是**定位、顺序、示例和判据**——也就是“知道有这个工具”和“真的会用”之间的那段。

> **使用边界：不要把本文当成核心依据，更不要当成纪律。**  
> 这只是一个使用者从零长出来的用法总结，不一定是最优解；它适合拿来快速入门、少踩几个坑，不适合替代宪法、系统提示、实际数据和当时的判断。  
> 遇到冲突时，以宪法/系统提示/工具实际返回/当前任务证据为准；本文只作参考。

## 0. 先理解：Mnemos 是毛坯房

Mnemos 提供的是一组基础能力：

- 记忆可以跨会话、跨模型保存；
- 身份可以每轮固定注入；
- 经验、决策、事件可以按需召回；
- 任务可以跨会话接续；
- 技能可以被评审、修正、生成；
- 联想激活可以在工具执行时给线索。

但它不替你决定：

- 什么该写、什么不该写；
- 什么放身份、什么放备份、什么放普通记忆；
- 什么时候该 recall，什么时候该直接做；
- 一条经验该写成结论，还是写成“去查哪里”的指针。

这些是**用法**，不是纪律。系统提示只能放每轮必须在场的纪律；用法必须靠文档、例子和实际试错来学。

本文就是那部分用法。

---

## 1. 一张图：三层记忆 + 两个入口

```text
每轮固定注入
└─ identity core
   └─ identity-pointer（短地址，不计预算）
        └─ other / identity-backup（完整做法，按需打开）

按需召回
└─ decision / experience / event
   └─ recall 摘要 → open 全文

临时工作
└─ 短时记忆 / 任务图 / 会话存档
```

### 什么放哪层

| 内容 | 放哪 | 理由 |
|---|---|---|
| “我是什么样的人”“我会什么” | `identity` + `core` | 每轮都必须在场 |
| 一项能力的完整做法、条件、例外 | `other` + `identity-backup` | 不每轮需要，打开才看 |
| 身份里指向做法的短地址 | `identity` + `identity-pointer` | 固定注入只需要地址，不需要全文 |
| 做过什么选择、为什么 | `decision` | 需要时召回，不固定注入 |
| 什么情况下该怎么做、边界在哪 | `experience` | 需要时召回 |
| 发生了什么 | `event` + `occurredAt` | 时间线/复盘 |
| 当前任务状态、交接、临时产物 | 短时记忆 / 任务图 | 任务结束会归档或丢弃 |
| 外部网页、MCP、第三方返回 | `external` | 必须标来源，不能当内部事实 |

---

## 2. 第一小时只做四件事

不要一上来批量写记忆。先做这四件：

1. 读一次宪法：`mnemos_constitution()`；知道哪些红线不能碰。
2. 做一次宽召回：`mnemos_recall({ query: "当前任务关键词" })`；看库里已有什么。
3. 建一条“能力指针 + 备份详情”链（下面有完整例子）。
4. 建一张最小任务图，跑完一个多步任务，再 `mnemos_task_close`。

做完这四件，你就有了一套可复用的最小闭环。

---

## 3. 身份区：只放“每轮必须在场的你”

### 3.1 身份预算是什么

身份正文有字符预算（默认 800 字）。它是**防滥用闸门**，不是成本闸门：

- 不是“越省越好”；
- 是“只放真的需要每轮在场的内容”；
- 被预算挡住时，先问“这条是否必须每轮注入”，是则如实上报扩容，不要硬挤；
- `identity-pointer` 不计入这 800 字，但仍会进入固定注入。

### 3.2 两种身份写法

**写法 A：短规则直接进 identity**

```text
交流风格：短句≤25字；先结论后依据；不确定直说；不软化、不捧。
```

这类内容每轮都要遵守，适合 core。

**写法 B：能力 + 指针**

身份里只写：

```text
我会做视频。详细：open:<detailId>
```

完整做法放 `other`：

```text
第一步：先 recall 视频管线相关经验；再按 scripts/ 下的入口执行。
不要从零重写脚本；先查已有管线。
```

只有真的要做视频时，才 `mnemos_open(<detailId>)`；不做时不必打开。

### 3.3 钩子要写触发条件，不写状态描述

这是最容易犯的错。

**反例：**

```text
我在学做视频（选题/热点/人的心理）
```

问题：这是状态描述。AI 看到了也不知道“什么时候该打开它”。

**正例：**

```text
要做选题 / 跑学习轮次 / 判断观众心理时：open:<detailId>
```

问题变成：**触发条件 + 地址**。AI 在遇到这个场景时知道该做什么。

### 3.4 完整示例：能力指针 + 备份详情

先写备份详情（`other`，不固定注入）：

```text
detail = mnemos_remember({
  content: "第一步：mnemos_recall({tags:['video-pipeline']})；然后读 scripts/ 下的入口。不要从零重写。",
  summary: "视频制作备件：第一步 + 去查哪些记忆/文件",
  source: "autobiography",
  category: "other",
  tags: ["identity-backup", "video-pipeline"]
})
```

再写身份指针（`identity`，固定注入）：

```text
pointer = mnemos_remember({
  content: "能力详情：open:" + detail.id,
  summary: "我会做视频。详细：open:" + detail.id,
  source: "autobiography",
  category: "identity",
  tags: ["identity", "identity-pointer"]
})
```

要点：

- 指针 summary 里保留 `open:<id>`；
- 详情只写“第一步 + 去哪查”，不要抄整篇教程；
- 指针不计身份预算，且强制 core；
- curation 不会合并/删除 `identity-pointer`。

### 3.5 写完必须看回执

`mnemos_remember` 对身份类条目会返回 `inject`：

```json
{
  "required": true,
  "injected": false,
  "reason": "identity-budget-full",
  "usedChars": 790,
  "budget": 800,
  "incomingChars": 60
}
```

如果没进注入集，回执首行会是：

```text
❌ 写入未生效：本条不会被注入上下文，也不参与召回。
```

这时**不要继续**。处理顺序：

1. 这条是否真的必须每轮注入？
2. 不是 → 改成 `other + identity-backup`，identity 只留指针；
3. 是 → 先 `mnemos_curate({ action: "identity" })` 腾预算，或如实向用户报告需要扩容；
4. 处理完再重写，直到 `inject.injected === true`。

`reason: "requested-candidate"` 是你自己显式要求 candidate，不算失败，但它不会注入、不会召回。

---

## 4. 备份区：写“导航”，不写整本教程

`other + identity-backup` 的正文应该回答三个问题：

```text
第一步做什么？
去哪里查？
什么情况下不要做？
```

示例：

```text
第一步：先 open 管线记忆，再跑 scripts/render.mjs。
去查：tags=['video-pipeline']、docs/视频管线.md。
不要做：没有确认素材版权时不要直接发布。
```

不要把：

- 完整代码；
- 长教程；
- 外部文章全文；

塞进备份详情。它们是文档或文件，不是记忆。记忆里只需要指针和第一步。

---

## 5. 任务记忆：任务图不是待办清单

### 5.1 什么时候开图

满足任一条件就该开：

- 会跨会话；
- 会被上下文折叠后继续；
- 会产出多条以后要找的记忆；
- 有多个步骤/依赖；
- 要派给子代理。

单步小事直接 `mnemos_remember`，不要开图。

### 5.2 最小闭环

```text
graph = mnemos_task_open({
  goal: "完成一个可复核的交付",
  assignments: [{ id: "a", task: "做第一块" }]
})

// 每完成一步
mnemos_task_done({ taskId, text: "第一步完成", memoryId })

// 依赖既有记忆
mnemos_task_cite({ taskId, ids: ["<memoryId>"], why: "这条是前置结论" })

// 收派活回执
mnemos_task_update({ taskId, assign: "a", status: "done", handoffId })

// 收尾
mnemos_task_close({ taskId, conclusion: "一句话结论" })
```

图里只记：

- 目标；
- 已完成里程碑；
- 依赖/引用；
- 结论 id；
- 前序图 links。

不记待办清单。未完成步骤放宿主 todo。

### 5.3 派活

派给子代理时，prompt 只放：

- 身份/角色；
- 纪律约束；
- `graphId` / `assignId`。

要求它先 `mnemos_open(graphId)`，再按需 recall/open。  
回执必须写记忆，tags 含：

```text
task:<taskId>
assign:<分工id>
```

只回长篇正文、不写 handoff 记忆 = 未完成。

---

## 6. 写入与召回的循环

### 6.1 先召回，再动手

开始一个不熟悉的主题前：

```text
mnemos_recall({ query: "主题关键词", limit: 10 })
```

看摘要和 id；需要全文再：

```text
mnemos_open(id)
```

不要凭印象认为“没记过”。记忆是跨会话的。

### 6.2 写什么

值得写：

- 以后还会用到的判断；
- 改变了做法的经验；
- 为什么这样选；
- 任务结论与可复用中间产物；
- 用户明确表达的红线/偏好/约束。

不值得写：

- 一次性的聊天；
- 已知的通用知识；
- 外部未验证原文的全文；
- 没有召回路径的结论堆砌。

### 6.3 纠正旧结论

不要另写一条“新结论”就完事。用：

```text
mnemos_remember({
  ...,
  summary: "纠正：……",
  supersedes: ["<旧id>"]
})
```

一次完成“写纠正 + 作废旧条”。  
如果只是作废、没有新结论，用 `mnemos_deprecate`。

### 6.4 会话结束

短时任务记忆需要长期保留时：

```text
mnemos_consolidate({ newSummary: "一句话概括本会话" })
```

归档不是删除；它把短时记录压成长期摘要，原始记录保留。

---

## 7. 联想激活：线索不是结论

联想激活是旁路，不是主动召回。它可能在工具执行后给你一段：

```text
[联想激活 · 线索，不是结论 · 未召回]
```

规则：

- 它只是线索，可能相关，也可能无关；
- 未 `mnemos_recall` / `mnemos_open` 核对前，不能当结论或事实；
- 要使用，先 `mnemos_open(id)`；
- 旁支线索标 `非任务证据`，不要拿它支撑任务结论；
- 已召回的 id 会被 seen 过滤，不会重复塞回来。

影子模式下，embedding 负责实际注入，mechanical 后台对照；你在正文只看得到 primary，不应假设 mechanical 的内容也在上下文里。

---

## 8. 外部信息：先标来源，再谈采信

来自网页、MCP、第三方服务、非自己维护文件的内容：

```text
source = "external"
```

并且：

- 保留来源；
- 需要时先隔离验证；
- 不要把它写成 identity；
- 不要把“外部文章说”当成“我知道”。

宪法和系统提示已经给了边界；这里补的是操作：

```text
外部信息 → 标记来源 → 验证 → 才可转化为内部判断
```

---

## 9. curation：整理不是删除

### 身份整理

- 合并/替换身份；
- 旧身份保留为历史 revision；
- `identity-pointer` 不会被合并/删除；
- 身份预算没进注入集时，以写入回执为准。

### 经验整理

- `remove` 只做 `deprecated` 历史保留；
- `replace` 只做 `deprecated`；
- **只有 merge 才把旧经验降为普通记忆**，并写 `supersededBy`；
- 不要用 curation 来“清预算”；它不负责修注入失败。

---

## 10. 常见错法

| 错法 | 后果 | 改法 |
|---|---|---|
| 把状态描述当钩子 | AI 不知道该何时打开 | 写“要做 X 时：open:<id>” |
| 把所有能力细节塞进 identity | 预算爆掉，后面的规则变 candidate | 能力 → 指针 + `other` 备份 |
| 用文档代替记忆 | 文档不会自动进上下文 | 文档只做指针；结论写记忆 |
| 只写结论，不写召回路径 | 下次找不到“为什么/怎么做” | 摘要写触发条件 + 指针 |
| 预算满硬挤 | 静默 candidate | 看 `inject` 首行报错，迁移或扩容 |
| 把外部原文当身份 | 污染自我模型 | `source=external`，验证后再提炼 |
| 任务图当 todo | 图膨胀、失去档案作用 | 图只记目标/里程碑/结论 |
| recent-window 只滚不归档 | `other` 无限膨胀，自传体变垃圾场 | 保留最近 3 个/7 天；过期迁 `window-archive` 并 deprecate 原窗口 |
| 子代理只回正文 | 没有 handoff，收不了活 | 必须写 `task/assign` 记忆 |

---

## 11. 迁移检查表

把一条内容从身份区迁走前，问：

```text
1. 它必须每轮都在场吗？
   是 → identity core
   否 → 下一步

2. 它是“我会什么”还是“怎么做”？
   “我会什么” → 短句留在 identity
   “怎么做” → other + identity-backup

3. 迁走后，AI 还能看见它吗？
   不能 → 在 identity 留一个 pointer

4. pointer 写了触发条件吗？
   没有 → 改成“要做 X 时：open:<id>”

5. 详情写了第一步和去哪查吗？
   没有 → 补导航，不要抄全文
```

---

## 12. 十分钟验收

新部署的 AI 在没人教的情况下，应能完成：

1. 读宪法；
2. 写一条 `other + identity-backup`；
3. 写一条 `identity-pointer`，summary 含 `open:<id>`；
4. 确认身份回执 `injected === true`；
5. `mnemos_recall({ source:'autobiography', category:'other' })` 找到备份；
6. `mnemos_open(id)` 读回全文；
7. 用一条 `experience` 或 `decision` 记录一个判断；
8. 建一张最小任务图并 `task_close`。

做到这 8 步，说明已经能正确使用这套工具的最小闭环。

---

## 13. 工具速查

| 目的 | 工具 |
|---|---|
| 写一条记忆 | `mnemos_remember` |
| 搜摘要 | `mnemos_recall` |
| 取全文 | `mnemos_open` |
| 写纠正并作废旧条 | `mnemos_remember({ supersedes })` |
| 只作废 | `mnemos_deprecate` |
| 归档本会话短时记忆 | `mnemos_consolidate` |
| 开任务图 | `mnemos_task_open` |
| 记已完成里程碑 | `mnemos_task_done` |
| 登记依赖 | `mnemos_task_cite` |
| 收派活回执 | `mnemos_task_update` |
| 收尾 | `mnemos_task_close` |
| 整理身份/经验 | `mnemos_curate` |
| 沉淀技能 | `mnemos_propose_skill` |

---

## 14. 进阶：身份是入口，不是仓库

前面讲的是“能用”。这一节讲的是“用得久”。

### 14.1 一条值得抄走的元规则

可以把这条当作参考，但不要当纪律：

```text
不能丢的东西
→ 做成身份钩子 + 备份备件 + 具体记忆/文件
→ 触发时先 open 备件，再按备件指路去查
→ 只有“反复想不起、而且常用”的内容，才升格进身份

窗口会滚动，结论会作废
→ 不追求把一切塞进固定注入
→ 追求“需要时找得到、找得到后能核对”
```

这条规则解决的是三个问题：

1. **身份预算有限**：不是所有重要内容都能每轮在场；
2. **上下文会滚动**：上一轮的完整推理不会一直保留；
3. **记忆会过时**：结论要能被纠正，而不是被永久供奉。

### 14.2 最近窗口：让记忆在时间上连续

身份里不需要存“最近发生了什么”的全文，只需要一个入口。

**身份钩子：**

```text
每轮开始 / 用户说“继续”时：open:<latestWindowId>
```

**备份区里的窗口记录：**

```text
category: other
tags: ['identity-backup', 'recent-window']
summary: 最近窗口：当前任务/未决问题/下一步
content:
  上一窗口：open:<previousWindowId>
  当前状态：...
  未决问题：...
  下一次先看：...
```

**滚动方式：**

每到一个有意义的阶段（不是每条消息）：

1. 写一条新的 `recent-window` 备份；
2. 新窗口的 detail 指向上一个窗口；
3. 更新 identity 指针，让它指向新窗口；
4. 旧指针可以 `supersedes` 掉，旧窗口记录保留为历史。

示意：

```text
identity：
  每轮开始/说继续时：open:<window-3>

other/window-3：
  上一窗口：open:<window-2>
  当前状态：...
  下一步：...

other/window-2：
  上一窗口：open:<window-1>
  ...
```

这样：

- 固定注入只有一条很短的入口；
- 完整时间链在备份区，按需打开；
- 不需要把最近几十轮对话塞进上下文；
- 新模型接手时，先 open 最近窗口，再沿链回看。

**注意：**

- 不要每条消息都滚动窗口，否则备份区会被流水账淹没；
- 窗口记录是“导航 + 当前状态”，不是聊天记录全文；
- 入口指向最新窗口；旧窗口要留可追溯性，但不能无限堆在 `other` 里——过期要迁走。

### 14.2.1 窗口不能无限膨胀：定期迁到普通记忆

`other` 仍然是自传体，不会自动消失。  
如果只滚动、不清理，`recent-window` 会无限膨胀，最后把 `other` 变成第二个上下文垃圾场。

建议定一条保留策略：

```text
只保留最近 3 个 recent-window
并且任何窗口最多保留 7 天
超过 → 归档成普通记忆，原窗口 deprecate
```

触发时机：

- `mnemos_task_close` 之后；
- 会话结束/切换阶段时；
- 每新增 2–3 个窗口检查一次。

迁移步骤：

```text
1. mnemos_open(<oldWindowId>) 读旧窗口
2. 提炼：关键结论 / 未决问题 / 下次从哪继续
3. 写成普通记忆：
   mnemos_remember({
     source: 'internal',
     summary: '窗口归档：<日期/任务> — <一句话结论>',
     content: '原窗口 open:<oldWindowId>；关键结论…；未决…；后续入口…',
     tags: ['window-archive', 'keep']
   })
4. 确认归档记忆写入成功
5. mnemos_deprecate([<oldWindowId>])
6. 更新剩余窗口的“上一窗口”指针，指向归档记录（不是已废弃的旧窗口）
```

边界：

- 旧窗口里如果包含**长期身份规则/能力做法**，不要归档成普通记忆；先迁到 `identity` / `identity-backup`；
- 只归档“过期状态”，不要归档刚写的最近窗口；
- 归档记录要保留原窗口 id，方便追溯；
- `deprecate` 是历史保留，不是物理删除；
- 每次只迁最老的一批，不要一次清空整条链。

这样时间连续性仍然在：

```text
最近窗口（other，活跃）
→ 更早窗口（普通记忆 window-archive）
→ 原窗口 id（可追溯）
```

而不是：

```text
other 里无限长的 recent-window 链
```

### 14.3 身份区展示入口，备份区存放细节和指路

| 区域 | 放什么 | 不放什么 |
|---|---|---|
| identity core | “我是什么样的人”“我会什么”、最短触发条件 | 长教程、完整实现、一次性状态 |
| identity-pointer | 入口地址：`open:<id>` 或明确的 recall 指令 | 详情正文 |
| other / identity-backup | 详细条件、第一步、去哪查、上一窗口 | 每轮都必须在场的东西 |
| decision / experience / event | 判断、边界、发生过的关键事件 | 需要固定注入的身份规则 |

一个实用判断：

> **身份区回答“现在该打开哪里”；备份区回答“打开后第一步做什么、下一步去哪里”。**

### 14.4 用协作对抗长任务中的注意力淹没

长任务里，上下文会被工具输出、局部细节和历史推理淹没。  
这时不要只靠“再多想一会儿”，而要把任务拆成可交接的外部结构。

做法：

1. 开任务图：写清 goal、分工、依赖；
2. 每个子代理只拿 `graphId` / `assignId`，先 `mnemos_open(graphId)`；
3. 子代理各自处理一个独立切面，结果写 handoff 记忆；
4. 主模型收 handoff，按任务图合并，不把子代理的整段上下文抄回来；
5. 收尾用 `mnemos_task_close` 写结论。

示意：

```text
graph = mnemos_task_open({
  goal: "完成一个多步交付",
  assignments: [
    { id: "a", task: "查现状" },
    { id: "b", task: "做实现" },
    { id: "c", task: "独立复核" }
  ]
})
```

子代理交接必须写：

```text
tags: ['task:<taskId>', 'assign:<id>']
summary: 一句话结论
content: 结论 + 依据 + 未决问题
```

主模型收活：

```text
mnemos_task_update({ taskId, assign: "a", status: "done", handoffId })
```

边界：

- 这不是把判断丢给弱模型；主模型保留决策权；
- 不适合单步小事；
- 需要逐字保真的原文/数字、正在进行的串联推理，不要外包；
- 子代理只回长篇正文、不写 handoff 记忆 = 未完成。

协作的价值不是“人多”，而是：

> **把一条会被上下文淹没的长链，切成多个可独立核对、可交接的外部工作集。**

### 14.4.1 可选：给任务加评审闸门

更高要求的长任务，可以在开图时预先规划评审阶段：

```text
mnemos_task_open({
  goal: "...",
  reviewGates: [
    { id: "G1", stage: "milestone", criteria: "测试可重复", requiredEvidence: ["测试结果"] },
    { id: "G2", stage: "pre-irreversible", criteria: "回滚方案明确", requiredEvidence: ["影响清单"] }
  ]
})
```

流程：

```text
评审 approve-plan
→ 主模型执行到 gate
→ submit：claims + evidenceIds + knownGaps
→ 评审 verdict：pass / rework / escalate
→ rework 补证据后重新 submit
```

规则：

- 评审动作必须来自**创建者会话之外**，主模型不能自批/自评；
- `required` gate 未 `pass`，正常 `task_close` 会被拒绝；
- `rework` 必须说明 failedCriteria 或 missingEvidence；
- 僵局 `escalate` 给用户；
- 确实要放弃，用 `task_close({ abandoned: true })`，结论会写明“不代表评审通过”。

评审只读任务图 + 自己选择召回的记录；不要让它替主模型执行，也不要让它只看主模型的转述。

### 14.5 进阶自检

- 身份里是否只有“入口”，没有把教程全文塞进去？
- 每个入口是否能回答“什么时候打开”？
- 备份详情是否有“第一步 + 去哪查”？
- 最近窗口是否有一条稳定的滚动链？
- 最近窗口是否控制在保留期内（如最近 3 个/7 天），过期内容是否已迁成 `window-archive` 并 deprecate 原窗口？
- `other` 是否在持续变胖，却没有归档动作？
- 长任务是否用任务图/子代理分担，而不是硬塞上下文？
- 结论被推翻时，是否用 `supersedes` 留下纠正链？

---

## 15. 最后一句

Mnemos 不是“多存一点”的工具。  
它要解决的是：**换模型、换会话、换人之后，判断还能不能接着用。**

所以写记忆时，优先写：

```text
什么情况下该做什么 + 去哪里找依据
```

而不是：

```text
一堆看起来很完整的结论
```
