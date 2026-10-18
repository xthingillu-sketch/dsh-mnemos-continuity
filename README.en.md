# Mnemos

**A DeepSeek Harness (DSH) plugin — not a bigger memory store, but memory that stays usable after you switch sessions, directories, or models.**

> It is not about how much memory you keep. It is about: after switching to another model, does it know **which records to pull, how to use them, and how to leave a new judgement behind**?
> Memory lives in files you can read and diff; the reasoning model is a replaceable part.

Mnemos is installed **into** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a local AI-assistant runtime. It is **not** a standalone app, and it does **not** work in a browser-only or mobile AI chat.

## What you get

- **Continue a task in a new session** — new session, new working directory: say "continue with X" and it picks the relevant conclusions back up (no ids to memorize).
- **Multi-agent handoff by memory, not by pasting transcripts** — the main agent writes a task graph; sub-agents read it by id and hand results back. One writer, nothing overwritten.
- **External information is auditable** — fetched content is treated as untrusted, verified in a restricted one-shot session, and stored with its provenance permanently attached.
- **Context compaction does not silently eat conclusions** — when the host folds old context, the important facts are snapshotted into memory first, with a pointer injected back.
- **Identity and rules live in records, not in weights** — a constitution (read-only from the model's side, editable by the owner with a password, always audited), injected every turn.

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
- Recall is **keyword + tag** matching — deterministic and auditable, **no semantic search**. Something you wrote may not be recalled; that is a known trade-off.
- **Not measured yet**: recall quality, scale latency, unit cost, long-term learning effects, multi-machine use.
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
| Architecture, data flow, one task end-to-end | `docs/架构总览.docx` |
| Every mechanism and its guarantees/limits | `docs/architecture-机制清单.docx` |
| **Module-by-module implementation** (appendix: the constitution and the system prompt, verbatim) | [`docs/模块与功能实现.md`](docs/模块与功能实现.md) |
| Why it is shaped this way | `docs/设计者视角.docx` |

## License

MIT © 2026 七月流火
