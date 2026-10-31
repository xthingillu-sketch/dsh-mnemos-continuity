# 版本标识 · Mnemos v1.7.0

| 项 | 值 |
|---|---|
| **版本** | **v1.7.0**（`package.json` 的 `version`） |
| 日期 | 2026-10-31 |
| 本目录 | 当前发行副本；npm / GitHub tag 均为 v1.7.0 |
| 规模 | `src` **28 个模块**；工具 **20** 个；心跳维护 **9** 项；测试 **1419 / 0** |
| 提示词 | 25 条 / 7 节 / **3797 字符** |
| 固定注入 | **12 条 / 约 1167 字**（4 身份 / 3 决策 / 5 经验） |
| 宪法 | **v3（认知体）**，1166 字符；红线 1–4 与 5.x 未动 |
| 当前 DSH | 0.2.1-rc.5 已实测；0.2.2-alpha.2 的插件 API 迁移项未适配 |

## 本版关键变化

1. **召回三层**：固定注入（自传体）+ 任务激活（主动 recall/open）+ 联想激活（实验性，工具后附注候选）。
2. **任务图定位上升**：底层机制——任务寻址、部分工作记忆、档案/追查入口、事件/决策来源锚点、归档闸门。
3. **档案修复**：`archiveSession` 每 scope 单份、cold、archivedIn；不再递归收编 archive；`isArchiveLike` 增加 `[uuid vN]` / `[任务 ...]` 前缀判据。
4. **双语**：内容 tag 同一字符串内中英共存；summary 关键词可附英文 `中文（english）`，不整句翻译。
5. **身份/经验 curation**：identity 4 条、experience 22→5；自动触发按身份候选/经验每周；revision 历史保留。
6. **learner / heartbeat 单飞**：定时器与手动入口不再并发；经验/心跳失败有冷却。
7. **宪法 v3**：新增认知体声明；换模型/工具/权限不换身份；权限差异是身体配置，不是身份差异。

## 文档

- `docs/00-架构总览.md` / `.docx`
- `docs/01-简介.md` / `.docx`
- `docs/02-architecture-机制清单.md` / `.docx`
- `docs/03-设计者视角.md` / `.docx`
- `docs/04-模块与功能实现.md`（纯 Markdown，附录含宪法 v3 原文与系统提示原文）
- `README.md` / `INSTALL.md`

> 文档源目录：`对外文档-v1.7/`；事实表：`对外文档-v1.7/00-事实表-v1.7.0.md`。

## 怎么确认

1. `package.json` 的 `version` 应为 **1.7.0**；
2. `node test/store.test.js` 应为 **1419 通过 / 0 失败**；
3. 维护列表应为 **9 项**（含 `curation_due`）；
4. 启动日志的 `dataFile` / `constitutionFile` 指向当前 profile；
5. 宪法 `version=3`，`mnemos_constitution` 应返回 v3 认知体声明。
