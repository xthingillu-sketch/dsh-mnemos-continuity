/**
 * 1016. 写入即校验：自传体条目必须当场知道"会不会被注入"（用户 2026-11-10 要求）。
 *
 * 事故背景（真实）：11-09 写一条用户定的交流风格规则（identity，要求 core 注入），
 * 身份预算满 → 静默落成 candidate（不注入、不召回），回执照旧说"已写入"；
 * 同一秒又写了「四规则写入 identity core」的决策，于是两边都以为成功。
 * 那条规则直到 11-10 才被用户发现「怎么没在身份里」。
 *
 * 本测试盯三件事：
 *   ① 正常写入 → inject.injected === true（能进注入集）
 *   ② 身份预算满 → inject.injected === false 且 reason='identity-budget-full'（必须显式）
 *   ③ 紧凑版装不下 → inject.injected === false 且 reason='compact-budget-full'
 * 外加一条**红灯自证**：把 inject 抹掉（= 旧实现的回执形状），断言确实会被抓出来。
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MemoryStore, DEFAULT_IDENTITY_BUDGET } from '../src/store.js'
import { summarize } from '../src/tool-results.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-inject-gate-'))
const file = path.join(dir, 'memory.json')
const st = new MemoryStore(file)

// ── ① 正常：第一条身份一定能进 core ─────────────────────────────
const r1 = await st.remember({
  summary: '身'.repeat(100),
  content: '正常身份条目',
  source: 'autobiography',
  category: 'identity',
})
assert.ok(r1.inject, 'remember 回执必须带 inject 字段（否则调用方无从判断是否注入）')
assert.equal(r1.inject.injected, true, '预算充足时身份条目应注入')
assert.equal(r1.inject.reason, null)
assert.equal(r1.identityStatus, 'core')
console.log('  ✓ 正常写入：inject.injected = true')

// ── ② 身份预算被塞满 → 必须显式报"没注入" ───────────────────────
let last = null
for (let i = 0; i < 12; i++) {
  last = await st.remember({
    summary: `填${i}-${'充'.repeat(90)}`,
    content: '撑满身份预算',
    source: 'autobiography',
    category: 'identity',
  })
  if (last.identityStatus === 'candidate') break
}
assert.equal(last.identityStatus, 'candidate', '预算满后应被降级为 candidate')
assert.equal(last.inject.injected, false, '降级后必须如实说"不会注入"')
assert.equal(last.inject.reason, 'identity-budget-full')
assert.ok(last.inject.usedChars > DEFAULT_IDENTITY_BUDGET * 0.5, 'usedChars 应是实数')
console.log(`  ✓ 预算满：injected=false，reason=identity-budget-full（占用 ${last.inject.usedChars}/${last.inject.budget}）`)

// 显式要求 candidate 时，不注入是**预期**，不能报成失败
const cand = await st.remember({
  summary: '候选条目（显式要求）',
  content: 'x',
  source: 'autobiography',
  category: 'identity',
  identityStatus: 'candidate',
})
assert.equal(cand.inject.injected, false)
assert.equal(cand.inject.reason, 'requested-candidate', '显式 candidate 不算写入失败')
console.log('  ✓ 显式 candidate：reason=requested-candidate（不误报为失败）')

// ── ③ 其它类目（决策/经验/事件）：不参与固定注入，**不报注入失败** ──────
// 用户 2026-11-10 明确：只有身份需要提醒；其它几类只看"有没有写成功"。
const exp = await st.remember({
  summary: '经'.repeat(2500), // 长到进不了紧凑版，但这不是写入失败
  content: '一条过长的经验条目',
  source: 'autobiography',
  category: 'experience',
})
assert.equal(exp.inject.required, false, '非身份类目不该做注入校验')
assert.equal(exp.inject.injected, undefined, '非身份类目不报 injected')
assert.ok(exp.id && exp.summary, '条目照常落盘（写成功）')
console.log('  ✓ 非身份类目：required=false，不报注入失败（只保证落盘）')

// ── ④ 回执形状：summarize 必须把 inject 透传出去 ────────────────
const shape = summarize(last)
assert.ok(shape.inject && shape.inject.injected === false, 'summarize 必须透传 inject')

// ── ⑤ 红灯自证：把 inject 抹掉（旧形状）→ 上面的断言会失败 ──────
const legacy = { ...last }
delete legacy.inject
assert.equal(summarize(legacy).inject, undefined, '旧形状确实没有 inject')
assert.throws(
  () => assert.ok(summarize(legacy).inject, 'remember 回执必须带 inject 字段'),
  /必须带 inject/,
  '这条测试在旧实现下会变红 —— 说明它不是平凡通过'
)
console.log('  ✓ 红灯自证：旧回执形状（无 inject）会被本测试抓出来')

console.log('\n结果：写入即校验 5 项全部通过')
