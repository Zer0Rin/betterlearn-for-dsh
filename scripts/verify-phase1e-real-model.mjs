#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function fail(code) {
  throw new Error(code)
}

function validSelection(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.provider === 'string' && value.provider.length > 0
    && typeof value.model === 'string' && value.model.length > 0
    && (value.reasoningEffort === undefined
      || (typeof value.reasoningEffort === 'string' && value.reasoningEffort.length > 0))
}

function sameSelection(left, right) {
  return validSelection(left) && validSelection(right)
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

function sameHashes(row, frozen) {
  return ['artifactSha256', 'promptSha256', 'schemaSha256', 'fixtureSha256']
    .every(key => typeof frozen?.[key] === 'string' && row?.[key] === frozen[key])
}

const OBSERVATION_COUNT_FIELDS = [
  'uniqueQuoteEvidenceCount',
  'repeatedQuoteEvidenceCount',
  'absentQuoteEvidenceCount',
  'disambiguationAttempted',
  'disambiguationSucceeded',
  'disambiguationRejected',
]

function validateEvidenceObservation(run) {
  if (OBSERVATION_COUNT_FIELDS.some(key => !Number.isSafeInteger(run[key]) || run[key] < 0)
    || run.schemaValidEvidenceCount
      !== run.uniqueQuoteEvidenceCount + run.repeatedQuoteEvidenceCount + run.absentQuoteEvidenceCount
    || run.disambiguationAttempted !== run.repeatedQuoteEvidenceCount
    || run.disambiguationAttempted
      !== run.disambiguationSucceeded + run.disambiguationRejected
    || run.exactEvidenceCount
      !== run.uniqueQuoteEvidenceCount + run.disambiguationSucceeded
    || (run.rejectionCounts.EVIDENCE_NOT_FOUND ?? 0) !== run.absentQuoteEvidenceCount
    || (run.rejectionCounts.EVIDENCE_AMBIGUOUS ?? 0) !== run.disambiguationRejected
    || run.disambiguationObservationStatus
      !== (run.disambiguationAttempted > 0 ? 'observed' : 'not_observed')) {
    fail('PHASE1E_DISAMBIGUATION_METRICS_INVALID')
  }
}

export function computePhase1eMetrics(value, options = {}) {
  if (!Array.isArray(value?.runs) || !Array.isArray(value?.providerCalls)
    || value.frozen === null || typeof value.frozen !== 'object') {
    fail('PHASE1E_RAW_ROWS_INVALID')
  }
  const runs = [...value.runs].sort((left, right) => left.ordinal - right.ordinal)
  if (runs.length !== 20
    || runs.some((run, index) => run?.ordinal !== index + 1 || typeof run.runId !== 'string')
    || new Set(runs.map(run => run.runId)).size !== 20) {
    fail('PHASE1E_RUN_SET_INVALID')
  }
  if (runs.some(run => !sameSelection(run.modelSelection, value.frozen.modelSelection)
    || !sameHashes(run, value.frozen))) fail('PHASE1E_FROZEN_INPUT_DRIFT')

  const firstPassSuccesses = runs.filter(run => run.firstAttemptSucceeded === true).length
  if (runs.some(run => typeof run.firstAttemptSucceeded !== 'boolean') || firstPassSuccesses < 19) {
    fail('PHASE1E_FIRST_PASS_INVALID')
  }
  const finalSuccesses = runs.filter(run => run.finalSucceeded === true).length
  if (finalSuccesses !== 20) fail('PHASE1E_FINAL_SUCCESS_INVALID')
  if (runs.some(run => !Number.isSafeInteger(run.candidateCount) || run.candidateCount < 1)) {
    fail('PHASE1E_CANDIDATE_COUNT_INVALID')
  }
  if (runs.some(run => Array.isArray(run.reviewEvidenceMethods)
    && run.reviewEvidenceMethods.some(method => method !== 'exact'))) {
    fail('PHASE1E_REVIEW_EVIDENCE_INVALID')
  }

  const calls = value.providerCalls
  if (calls.length < 20 || calls.length > 21
    || calls.some((call, index) => call?.sequence !== index + 1)) {
    fail('PHASE1E_PROVIDER_CALL_BUDGET_INVALID')
  }
  const callsByRun = new Map()
  for (const call of calls) {
    if (!sameSelection(call.modelSelection, value.frozen.modelSelection)) {
      fail('PHASE1E_PROVIDER_LEDGER_MISMATCH')
    }
    callsByRun.set(call.runId, (callsByRun.get(call.runId) ?? 0) + 1)
  }
  for (const run of runs) {
    const expectedCalls = run.firstAttemptSucceeded ? 1 : 2
    if (run.providerCalls !== expectedCalls || callsByRun.get(run.runId) !== expectedCalls) {
      fail('PHASE1E_PROVIDER_LEDGER_MISMATCH')
    }
  }

  let schemaValidEvidenceCount = 0
  let exactEvidenceCount = 0
  const rejectionCounts = {}
  const evidenceObservation = Object.fromEntries(
    OBSERVATION_COUNT_FIELDS.map(key => [key, 0]),
  )
  for (const run of runs) {
    if (!Number.isSafeInteger(run.schemaValidEvidenceCount) || run.schemaValidEvidenceCount < 1
      || !Number.isSafeInteger(run.exactEvidenceCount) || run.exactEvidenceCount < 0
      || run.exactEvidenceCount > run.schemaValidEvidenceCount
      || run.rejectionCounts === null || typeof run.rejectionCounts !== 'object'
      || Array.isArray(run.rejectionCounts)) {
      fail('PHASE1E_EVIDENCE_COUNTS_INVALID')
    }
    validateEvidenceObservation(run)
    for (const key of OBSERVATION_COUNT_FIELDS) evidenceObservation[key] += run[key]
    schemaValidEvidenceCount += run.schemaValidEvidenceCount
    exactEvidenceCount += run.exactEvidenceCount
    for (const [reason, count] of Object.entries(run.rejectionCounts)) {
      if (!Number.isSafeInteger(count) || count < 0) fail('PHASE1E_EVIDENCE_COUNTS_INVALID')
      rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + count
    }
  }
  const exactEvidenceYield = exactEvidenceCount / schemaValidEvidenceCount
  const minimumExactEvidenceYield = options.minimumExactEvidenceYield ?? 0.90
  if (exactEvidenceYield < minimumExactEvidenceYield) fail('PHASE1E_EXACT_EVIDENCE_YIELD_INVALID')
  return {
    runs: runs.length,
    firstPassSuccesses,
    finalSuccesses,
    providerCalls: calls.length,
    candidatesPerRun: runs.map(run => run.candidateCount),
    schemaValidEvidenceCount,
    exactEvidenceCount,
    exactEvidenceYield,
    rejectionCounts,
    ...evidenceObservation,
    disambiguationObservationStatus: evidenceObservation.disambiguationAttempted > 0
      ? 'observed'
      : 'not_observed',
  }
}

const FLASH_LOW_SELECTION = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'low',
}

export function computeFlashLowDiagnostic(value) {
  if (!Array.isArray(value?.runs) || !Array.isArray(value?.providerCalls)
    || value.request === null || typeof value.request !== 'object'
    || value.budget === null || typeof value.budget !== 'object'
    || value.frozen === null || typeof value.frozen !== 'object') {
    fail('PHASE1E_RAW_ROWS_INVALID')
  }
  if (value.request.batchPolicy !== 'flash-low-stability'
    || value.request.purpose !== 'phase1e-flash-low-stability'
    || value.request.maxRuns !== 3 || value.request.maxCalls !== 4
    || value.budget.batchPolicy !== 'flash-low-stability'
    || value.budget.authorizedRuns !== 3 || value.budget.authorizedMaxCalls !== 4) {
    fail('PHASE1E_BATCH_POLICY_MISMATCH')
  }
  if (!sameSelection(value.request.modelSelection, FLASH_LOW_SELECTION)
    || !sameSelection(value.frozen.modelSelection, FLASH_LOW_SELECTION)) {
    fail('PHASE1E_FROZEN_INPUT_DRIFT')
  }
  if (value.budget.requestDigest !== value.request.requestDigest
    || !['COMPLETE', 'NO_GO'].includes(value.budget.state)) {
    fail('PHASE1E_DIAGNOSTIC_STATE_INVALID')
  }

  const runs = [...value.runs].sort((left, right) => left.ordinal - right.ordinal)
  if (runs.length > 3
    || runs.some((run, index) => run?.ordinal !== index + 1 || typeof run.runId !== 'string')
    || new Set(runs.map(run => run.runId)).size !== runs.length
    || value.budget.actualRuns !== runs.length
    || !Array.isArray(value.budget.completedRunIds)
    || value.budget.completedRunIds.length !== runs.length
    || runs.some((run, index) => value.budget.completedRunIds[index] !== run.runId)) {
    fail('PHASE1E_RUN_SET_INVALID')
  }
  if (runs.some(run => !sameSelection(run.modelSelection, FLASH_LOW_SELECTION)
    || !sameHashes(run, value.frozen))) fail('PHASE1E_FROZEN_INPUT_DRIFT')

  const calls = value.providerCalls
  if (calls.length > 4
    || calls.length !== value.budget.actualCalls
    || calls.some((call, index) => call?.sequence !== index + 1)) {
    fail('PHASE1E_PROVIDER_CALL_BUDGET_INVALID')
  }
  const callsByRun = new Map()
  for (const call of calls) {
    if (!sameSelection(call.modelSelection, FLASH_LOW_SELECTION)) {
      fail('PHASE1E_PROVIDER_LEDGER_MISMATCH')
    }
    callsByRun.set(call.runId, (callsByRun.get(call.runId) ?? 0) + 1)
  }

  let schemaValidEvidenceCount = 0
  let exactEvidenceCount = 0
  const observation = Object.fromEntries(OBSERVATION_COUNT_FIELDS.map(key => [key, 0]))
  for (const run of runs) {
    if (typeof run.firstAttemptSucceeded !== 'boolean'
      || run.finalSucceeded !== true
      || !Number.isSafeInteger(run.candidateCount) || run.candidateCount < 1
      || !Array.isArray(run.reviewEvidenceMethods)
      || run.reviewEvidenceMethods.some(method => method !== 'exact')
      || !Number.isSafeInteger(run.schemaValidEvidenceCount) || run.schemaValidEvidenceCount < 1
      || !Number.isSafeInteger(run.exactEvidenceCount) || run.exactEvidenceCount < 0
      || run.exactEvidenceCount > run.schemaValidEvidenceCount
      || run.rejectionCounts === null || typeof run.rejectionCounts !== 'object'
      || Array.isArray(run.rejectionCounts)) {
      fail('PHASE1E_DIAGNOSTIC_RUN_INVALID')
    }
    const expectedCalls = run.firstAttemptSucceeded ? 1 : 2
    if (run.providerCalls !== expectedCalls || callsByRun.get(run.runId) !== expectedCalls) {
      fail('PHASE1E_PROVIDER_LEDGER_MISMATCH')
    }
    validateEvidenceObservation(run)
    schemaValidEvidenceCount += run.schemaValidEvidenceCount
    exactEvidenceCount += run.exactEvidenceCount
    for (const key of OBSERVATION_COUNT_FIELDS) observation[key] += run[key]
  }

  const firstAttemptSuccesses = runs.filter(run => run.firstAttemptSucceeded).length
  const recoveredRunPresent = runs.some(run => !run.firstAttemptSucceeded)
  if (value.budget.state === 'COMPLETE') {
    if (runs.length !== 3) fail('PHASE1E_RUN_SET_INVALID')
    if (value.budget.retryUsed !== recoveredRunPresent) fail('PHASE1E_RETRY_ACCOUNTING_INVALID')
  } else if (value.budget.retryUsed === false && recoveredRunPresent) {
    fail('PHASE1E_RETRY_ACCOUNTING_INVALID')
  }

  return {
    completedRuns: runs.length,
    firstAttemptSuccesses,
    finalSuccesses: runs.length,
    actualProviderCalls: calls.length,
    retryUsed: value.budget.retryUsed,
    schemaValidEvidenceCount,
    exactEvidenceCount,
    exactEvidenceYield: schemaValidEvidenceCount === 0 ? null : exactEvidenceCount / schemaValidEvidenceCount,
    ...observation,
    disambiguationObservationStatus: observation.disambiguationAttempted > 0
      ? 'observed'
      : 'not_observed',
  }
}

export function diagnoseFlashLowStability(value) {
  const metrics = computeFlashLowDiagnostic(value)
  if (value.budget.state === 'NO_GO') {
    return { status: 'A3_DIAGNOSTIC_NO_GO', metrics }
  }
  if (metrics.completedRuns === 3
    && metrics.firstAttemptSuccesses === 3
    && metrics.actualProviderCalls === 3
    && metrics.retryUsed === false) {
    return { status: 'A3_DIAGNOSTIC_PASS', metrics }
  }
  if (metrics.completedRuns === 3
    && metrics.firstAttemptSuccesses === 2
    && metrics.actualProviderCalls === 4
    && metrics.retryUsed === true) {
    return { status: 'A3_DIAGNOSTIC_UNSTABLE', metrics }
  }
  fail('PHASE1E_DIAGNOSTIC_RESULT_INVALID')
}

export function diagnosePhase1eMetrics(value) {
  try {
    return { status: 'PHASE1E_REAL_MODEL_GO', metrics: computePhase1eMetrics(value) }
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'PHASE1E_EXACT_EVIDENCE_YIELD_INVALID') throw error
    return {
      status: 'PHASE1E_REAL_MODEL_NO_GO',
      reason: error.message,
      metrics: computePhase1eMetrics(value, { minimumExactEvidenceYield: 0 }),
    }
  }
}

export function assertRemainingReady({ budget, continuation, request, currentHashes }) {
  if (budget?.state !== 'FIRST_RUN_REVIEW') fail('PHASE1E_REMAINING_STATE_INVALID')
  if (budget.actualRuns !== 1 || budget.actualCalls !== 1
    || !Array.isArray(budget.completedRunIds) || budget.completedRunIds.length !== 1) {
    fail('PHASE1E_FIRST_RUN_COUNTS_INVALID')
  }
  if (continuation?.version !== 1
    || continuation.requestDigest !== request?.requestDigest
    || continuation.authorizationSource !== 'explicit-user-continuation-confirmation-in-active-codex-task'
    || typeof continuation.authorizedAt !== 'string'
    || Number.isNaN(Date.parse(continuation.authorizedAt))) {
    fail('PHASE1E_CONTINUATION_REQUIRED')
  }
  if (budget.requestDigest !== request.requestDigest || !sameHashes(currentHashes, request)) {
    fail('PHASE1E_FROZEN_INPUT_DRIFT')
  }
  return {
    nextOrdinal: 2,
    completedRunIds: [...budget.completedRunIds],
  }
}

export async function verifyEvidenceRoot(evidenceRoot) {
  if (!isAbsolute(evidenceRoot)) fail('PHASE1E_EVIDENCE_ROOT_INVALID')
  const [runs, providerCalls, manifest, request, budget] = await Promise.all([
    readFile(join(evidenceRoot, 'raw-runs.json'), 'utf8').then(JSON.parse),
    readFile(join(evidenceRoot, 'observer-records.json'), 'utf8').then(JSON.parse),
    readFile(join(evidenceRoot, 'manifest.json'), 'utf8').then(JSON.parse),
    readFile(join(evidenceRoot, 'authorization-request.json'), 'utf8').then(JSON.parse),
    readFile(join(evidenceRoot, 'budget-manifest.json'), 'utf8').then(JSON.parse),
  ])
  const frozen = {
    modelSelection: request.modelSelection,
    artifactSha256: request.artifactSha256,
    promptSha256: request.promptSha256,
    schemaSha256: request.schemaSha256,
    fixtureSha256: request.fixtureSha256,
  }
  const batchPolicy = request.batchPolicy ?? 'gate5-full'
  const decision = batchPolicy === 'flash-low-stability'
    ? diagnoseFlashLowStability({ runs, providerCalls, budget, request, frozen })
    : diagnosePhase1eMetrics({ runs, providerCalls, frozen })
  const diagnosticFields = batchPolicy === 'flash-low-stability' ? {
    batchPolicy,
    requestedRuns: request.maxRuns,
    maxProviderCalls: request.maxCalls,
    completedRuns: decision.metrics.completedRuns,
    firstAttemptSuccesses: decision.metrics.firstAttemptSuccesses,
    retryUsed: decision.metrics.retryUsed,
    actualProviderCalls: decision.metrics.actualProviderCalls,
    diagnosticOutcome: decision.status,
  } : {}
  const finalResult = {
    status: decision.status,
    phase: 'phase1e-real-model',
    ...diagnosticFields,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    metrics: decision.metrics,
    scope: batchPolicy === 'flash-low-stability'
      ? 'A3 diagnoses Flash Low stability only; it does not certify Phase 1E.'
      : 'Gate 5 validates the frozen TXT/Markdown fixture, selected DSH route, exact evidence alignment, and bounded 20-run reliability only.',
    artifactSha256: manifest.artifacts.product.sha256,
  }
  await Promise.all([
    writeFile(join(evidenceRoot, 'metrics.json'), `${JSON.stringify(decision.metrics, null, 2)}\n`),
    writeFile(join(evidenceRoot, 'final-result.json'), `${JSON.stringify(finalResult, null, 2)}\n`),
  ])
  return finalResult
}

async function main(argv) {
  const args = argv.filter(argument => argument !== '--')
  if (args[0] === '--evidence-root' && isAbsolute(args[1] ?? '') && args.length === 2) {
    const result = await verifyEvidenceRoot(args[1])
    process.stdout.write(`${result.status}\n`)
    return
  }
  fail('usage: verify-phase1e-real-model.mjs --evidence-root <absolute>')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
