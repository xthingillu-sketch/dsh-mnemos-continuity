# 版本标识 · Mnemos v1.7.6

[![dshbase 实测可装](https://dshbase.com/badges/dsh-mnemos-continuity.svg)](https://dshbase.com/zh/plugins/dsh-mnemos-continuity/)

| 项 | 值 |
|---|---|
| **版本** | **v1.7.6**（`package.json` 的 `version`） |
| 本次修复验收 | 2026-11-20 |
| 本目录 | 当前 v1.7.6；工作副本，未发布 npm / GitHub |
| 规模 | `src` **33 个模块**；工具 **20** 个；心跳维护 **9** 项；测试见下方 |
| 提示词 | 25 条 + ⑧.1/㉔.1 子规则 / 7 节 / **4164 字符** |
| 宪法 | **v5（认知体）**，**1708 字符**；红线 1–4 与 5.x 未动 |
| 当前 DSH | **0.2.2-rc.1** 已加载；核心工具/隔离验证冒烟通过；`subagents` provider 兼容层随 1.7.4 发布 |

## 本版核心：联想激活零等待与持久向量索引

- 工具结果零等待；附注可跨轮次，只搭同会话工具结果，PTC 只搭外层 `run_code`。
- 后台 embedding 默认截止 20 秒；普通 embedding 模式临时机械回退，恢复即停；影子模式始终双路后台运行。
- 持久句向量索引后台增量暖机；热态只嵌入查询，冷态机械回退。桌面 PTC 已验收。索引压缩和孤儿向量回收暂缓。
- 可选便携 Ollama 由 Windows DSH 宿主管理启停，默认不启动。

## 此前 v1.7 系列变更

> **v1.7.4 只适配 DSH 0.2.2-rc.1 的 `subagents` provider 选择接口；工具、提示词、schema、数据格式均不变。**

1. **信任 = 实际掌控权**  
   自传体（经验/决策/事件）可检查、可追溯、可修正，因此信任最高、更正成本最低；普通记忆居中；外部信息通常只有文本/来源，难以确认和推翻，因此信任最低、更正成本最高。信任不等于不会错；跨层更正必须留痕，不自动覆盖。
2. **身体 / 器械边界**  
   身体 = Mnemos + DSH 核心工具；第三方插件、领域 MCP 是外部器械，不为其来源与行为担保。工具归属与信息来源是两条边界：身体工具（如 `web_search`）也可能返回外部信息，结果必须按来源标记。
3. **上下文定位**  
   上下文是“当下的激活场”，由场景 + 被激活的自我切片 + 工作集构成；它不是身份、记忆仓库、判断权威或权限来源。
4. **召回提醒**  
   经验/决策/事件在召回时标明“实际掌控权高/可修正、不是普通背景”；外部记忆标明“非自己掌握/未验证”。身份固定注入，不参与常规召回提醒。
5. **联想激活：句子级 + 3+2 + shadow**  
   摘要拆句；相关 3 条（不足不补）+ 自传体旁支 2 条；多句命中按句序以 `……` 连成一条；自传体权重 ×1.5；所有线索强制标“线索，不是结论 · 未召回”。`shadow` 模式下两路后台对照，优先采用按时返回的 embedding，否则采用机械结果；工具结果不等待检索或日志。
6. **身份备用存储**  
   身份中需要固定注入的内容留在 `identity`；不需要固定注入的细节存 `category=other`、`tags=['identity-backup']`；identity 只留 `tags=['identity-pointer']` 的短指针，summary 写 `open:<detailId>`。指针不占身份字数预算、强制 core，curation 不能合并/删除它；`other` 详情不进入固定注入，需时 `recall category=other` 或 `open(id)`。
7. ** curation 降级修复**  
   experience 的 remove/replace 只做 `deprecated` 历史保留；只有 merge 才把旧经验降为普通记忆并写 `supersededBy`。经验数量上限不再参与 apply 拒绝/降级。
8. **任务图评审闸门（长任务）**  
   `mnemos_task_open` 可传 `reviewGates`（阶段、判据、必需证据）；评审子代理不进 assignments、只读任务图并自主召回。主模型 `submit` 证据，评审 `approve-plan` / `verdict`（pass/rework/escalate），`rework` 必须给缺失证据；required gate 未 passed 前不能正常 `task_close`，确实放弃用 `abandoned`。评审动作必须来自创建者会话之外，不能自批自评。
9. **系统提示整版审阅**  
   删除旧 ability 迁移说明；原 ㉖ 身份两层存移到 ⑧.1；任务图与协作合并，评审写成 ㉔.1；任务图明确存“产物/证据/引用的地址”，不复制正文。编号保持稳定，避免破坏既有引用。

## 文档

- `docs/00-架构总览.md`
- `docs/01-简介.md`
- `docs/02-architecture-机制清单.md`
- `docs/03-设计者视角.md`
- `docs/04-模块与功能实现.md`（附录含宪法 v5 原文与系统提示原文）
- `AI快速入门.md`（给新部署 AI 的用法指南；不进系统提示）
- `README.md` / `README.en.md` / `INSTALL.md`

> 文档源目录：`对外文档-v1.7/`；事实表：`对外文档-v1.7/00-事实表-v1.7.4.md`。

## 怎么确认

1. `package.json` 的 `version` 应为 **1.7.6**；
2. `npm test` 应为 **1363 条原有断言、7 项搭车回归和 4 项索引回归均通过**；
3. 维护列表应为 **9 项**（不含 learner）；
4. 工具数应为 **20 个**（含 `mnemos_task_gate`，无 `mnemos_learner_kick`）；
5. `src` 应为 **33 个模块**（含 `embedding-index.js`、`fansearch-delivery.js`、`ollama-lifecycle.js`）；
6. 启动日志的 `dataFile` / `constitutionFile` 指向当前 profile；
7. 宪法 `version=5`，`mnemos_constitution` 应返回 v5 认知体声明（含上下文定位、身体/来源边界、信任=实际掌控权）。



