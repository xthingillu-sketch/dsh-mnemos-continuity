/**
 * 自动 curation 触发判据（纯逻辑，便于测试）。
 *
 * 只回答“现在该不该整理”，不启动模型、不写记忆。
 * 身份：core 预算已满，且 candidate >= 5；或 core 已满、1–4 条候选但最老 > 30 天。
 * 经验：按时间，距上次整理/首条经验 >= 7 天；不再按条数触发。
 */

import { autobiographyCategoryOf, DEFAULT_IDENTITY_BUDGET } from './store.js'

const DAY = 24 * 3600 * 1000

function activeAuto(store) {
  return [...(store?.memories?.values?.() || [])].filter((m) => {
    if (!m || m.source === 'deprecated') return false
    if (m.source !== 'autobiography') return false
    if (m.identityStatus === 'candidate' || m.identityStatus === 'archived') return false
    return true
  })
}

function latestRevision(store, action) {
  let best = null
  for (const m of store?.memories?.values?.() || []) {
    if (!(m.tags || []).includes(`${action}-revision`)) continue
    if (!best || (m.createdAt || 0) > (best.createdAt || 0)) best = m
  }
  return best
}

export function evaluateCurationDue(store, {
  now = Date.now(),
  identityCandidateTrigger = 5,
  identityFallbackDays = 30,
  experienceIntervalDays = 7,
  identityBudget = DEFAULT_IDENTITY_BUDGET,
} = {}) {
  const auto = activeAuto(store)
  const identity = auto.filter((m) => autobiographyCategoryOf(m) === 'identity')
  const core = identity.filter((m) => m.identityStatus !== 'candidate')
  const coreChars = core.reduce((n, m) => n + String(m.summary || '').length, 0)
  const candidates = [...(store?.memories?.values?.() || [])].filter((m) =>
    m && m.source === 'autobiography' && autobiographyCategoryOf(m) === 'identity' &&
    m.identityStatus === 'candidate'
  )
  const oldestCandidate = candidates.reduce((min, m) => Math.min(min, m.createdAt || now), now)
  const candidateAgeDays = candidates.length ? Math.floor((now - oldestCandidate) / DAY) : 0
  const coreFull = coreChars >= Number(identityBudget || DEFAULT_IDENTITY_BUDGET)

  const identityReasons = []
  if (coreFull && candidates.length >= Number(identityCandidateTrigger || 5)) {
    identityReasons.push(`core ${coreChars}/${identityBudget} 已满，候选 ${candidates.length} ≥ ${identityCandidateTrigger}`)
  }
  if (coreFull && candidates.length > 0 && candidateAgeDays > Number(identityFallbackDays || 30)) {
    identityReasons.push(`core 已满，候选 ${candidates.length} 条但最老 ${candidateAgeDays} 天 > ${identityFallbackDays}`)
  }
  if (identityReasons.length) {
    return {
      due: true,
      action: 'identity',
      reason: identityReasons.join('；'),
      metrics: { coreChars, identityBudget, candidates: candidates.length, oldestCandidateAgeDays: candidateAgeDays },
    }
  }

  const experiences = auto.filter((m) => autobiographyCategoryOf(m) === 'experience')
  const lastRevision = latestRevision(store, 'experience')
  const oldestExperience = experiences.reduce((min, m) => Math.min(min, m.createdAt || now), now)
  const baseline = lastRevision?.createdAt || (experiences.length ? oldestExperience : 0)
  const baselineAgeDays = baseline ? Math.floor((now - baseline) / DAY) : null
  if (baseline && baselineAgeDays >= Number(experienceIntervalDays || 7)) {
    return {
      due: true,
      action: 'experience',
      reason: `距上次经验整理/首条经验 ${baselineAgeDays} 天 ≥ ${experienceIntervalDays}`,
      metrics: { experiences: experiences.length, lastRevisionAgeDays: baselineAgeDays },
    }
  }

  return {
    due: false,
    action: null,
    reason: '无到期条件',
    metrics: {
      coreChars, identityBudget, candidates: candidates.length, oldestCandidateAgeDays: candidateAgeDays,
      experiences: experiences.length, lastRevisionAgeDays: baselineAgeDays,
    },
  }
}
