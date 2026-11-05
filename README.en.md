# Mnemos (v1.7.1)

> **v1.7.1 focus:** it is not about storing more memory; it is about **which memories the system actually controls**. Self-narrative (experience/decision/event) is most trusted because it is inspectable and correctable; ordinary memory sits in the middle; external information is least trusted because it cannot be confirmed or overturned easily. Constitution v5 adds the trust/control, body-vs-instrument, and context-positioning statements; red lines are unchanged. Idle learning was removed in favor of host automation.

**A DeepSeek Harness (DSH) plugin — not a bigger memory store, but memory that stays usable after you switch sessions, directories, or models.**

> **The goal**: after you have done a kind of task once, the next time it should be done right **without looking anything up**.
> It is not about how much memory you keep. It is about: after switching to another model, does it know **which records to pull, how to use them, and how to leave a new judgement behind**?
> Memory lives in files you can read and diff; the reasoning model is a replaceable part.

Mnemos is installed **into** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a local AI-assistant runtime. It is **not** a standalone app, and it does **not** work in a browser-only or mobile AI chat.

## What you get

- **Continue a task in a new session** — new session, new working directory: say "continue with X" and it picks the relevant conclusions back up (no ids to memorize).
- **Task graph as a foundational mechanism** — one memory record carries task address space, working memory (own/delegated), a dossier/trace entry, and event/decision source anchors. It stores **pointers, not copied text**: completed milestones, dependency ids and conclusion ids. One writer; close writes a closure event and does not merge members.
- **Skills are compiled experience** — a reusable practice can come from a fixed failure, a recurring problem in memory (≥3 events across ≥2 sessions), or an external rewrite. External skills stay in `skill-proposals/` until you approve them.
- **External information is auditable** — fetched content is treated as untrusted, verified in a restricted one-shot session, and stored with its provenance permanently attached.
- **Context compaction is a short-term fallback, not long-term memory** — the plugin writes only a fact card (no 4K raw text) plus a notice carrying the top negative conclusions/tool failures; the fact card expires after 7 days.
- **Identity and rules live in records, not in weights** — a constitution (read-only from the model's side, editable by the owner with a password, always audited), injected every turn.

## What it is not

Other DSH memory plugins fall into four types: fact-citation, file/project memory, full memory-stack/shared, and protocol-enforced memory. Mnemos is a **different layer**: it makes **judgement** traceable — why a rule changed, what a task depended on, whether external information was trusted, and what a decision superseded. Memory is the substrate, not the product.

This also means we do **not** offer per-fact citations back to raw log events; that is a known gap, not a claim. Citation and judgement provenance are complementary.

## Install

```bash
dsh plugin --profile <your-profile> add dsh-mnemos-continuity
```

Then **fully restart DSH** (not a page refresh). Data lives in the profile's own `mnemos/` directory, so reinstalling never touches your memory.

npm: <https://www.npmjs.com/package/dsh-mnemos-continuity> · project name is **Mnemos**;
the `continuity` in the package name is the point: **judgement survives the model change**.

> DSH itself is required, and it ships its own Node runtime — you do **not** need Node.js installed.

## Cost, boundaries, honesty

- Memory is **local plain-text files** (JSON): back them up yourself; do not put secrets in memory.
- Background maintenance is on by default and **some steps call an AI model** (cost); it can be disabled entirely.
- Recall is **keyword + tag** matching for task activation — deterministic and auditable, **no semantic search**. Something you wrote may not be recalled; that is a known trade-off. v1.7 also has experimental associative hints after tool calls; they may be irrelevant and are not a guarantee.
- **Not measured yet**: task recall quality, associative-hint quality, scale latency, unit cost, long-term learning effects, multi-machine use. DSH 0.2.1-rc.5 was tested; 0.2.2-alpha.2 plugin-API migration is not yet implemented.
- Some reliability rests on discipline (the agent's own habits), not on mechanisms. We say so instead of claiming otherwise.

## Risks and responsibility

Mnemos is a general-purpose architecture. Its capabilities are not tied to any purpose, **but the design contains deliberate choices** (isolate external content first, keep the reasoning trace, audit dangerous actions) — those are positions, not neutrality.

Four capabilities are worth stating plainly — useful when used well, amplified when abused:
writable identity · long-lived cross-session memory · dispatching other models · unattended background runs.
**The holder is the guardian and bears final responsibility for the agent's behaviour.** This project provides no warranty and accepts no liability for abuse.
Full statement (Chinese): [`README.md`](README.md) → 风险与责任.

## Documentation

**Full documentation is in Chinese** (the DSH community is largely Chinese-speaking):

| If you want to | Read |
|---|---|
| What it is, what it costs, should you use it | [`README.md`](README.md) (Chinese) |
| Install / configure / tools / data location / troubleshooting | [`INSTALL.md`](INSTALL.md) |
| Architecture, data flow, one task end-to-end | `docs/架构总览.md` |
| Every mechanism and its guarantees/limits | `docs/architecture-机制清单.md` |
| **Module-by-module implementation** (appendix: the constitution and the system prompt, verbatim) | [`docs/模块与功能实现.md`](docs/模块与功能实现.md) |
| Why it is shaped this way | `docs/设计者视角.md` |

> The release ships Markdown docs only; docx/pdf are not bundled.

## License

MIT © 2026 七月流火
