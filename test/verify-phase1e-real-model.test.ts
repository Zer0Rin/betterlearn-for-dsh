import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  assertRemainingReady,
  diagnoseFlashLowStability,
  computePhase1eMetrics,
  diagnosePhase1eMetrics,
  verifyEvidenceRoot,
} from '../scripts/verify-phase1e-real-model.mjs'

const selection = { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' }
const lowSelection = {
  provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low',
}
const hashes = {
  artifactSha256: 'a'.repeat(64),
  promptSha256: 'b'.repeat(64),
  schemaSha256: 'c'.repeat(64),
  fixtureSha256: 'd'.repeat(64),
}

function rawRows({ retryOrdinal }: { retryOrdinal?: number } = {}) {
  const runs = Array.from({ length: 20 }, (_, index) => {
    const ordinal = index + 1
    const retried = ordinal === retryOrdinal
    return {
      ordinal,
      runId: `run-${ordinal}`,
      firstAttemptSucceeded: !retried,
      finalSucceeded: true,
      providerCalls: retried ? 2 : 1,
      candidateCount: 2,
      schemaValidEvidenceCount: 3,
      exactEvidenceCount: ordinal === 20 ? 2 : 3,
      rejectionCounts: ordinal === 20 ? { EVIDENCE_AMBIGUOUS: 1 } : {},
      ...(ordinal === 20 ? {
        uniqueQuoteEvidenceCount: 2,
        repeatedQuoteEvidenceCount: 1,
        absentQuoteEvidenceCount: 0,
        disambiguationAttempted: 1,
        disambiguationSucceeded: 0,
        disambiguationRejected: 1,
        disambiguationObservationStatus: 'observed',
      } : {
        uniqueQuoteEvidenceCount: 3,
        repeatedQuoteEvidenceCount: 0,
        absentQuoteEvidenceCount: 0,
        disambiguationAttempted: 0,
        disambiguationSucceeded: 0,
        disambiguationRejected: 0,
        disambiguationObservationStatus: 'not_observed',
      }),
      modelSelection: { ...selection },
      ...hashes,
    }
  })
  const providerCalls = runs.flatMap(run => Array.from({ length: run.providerCalls }, (_, attempt) => ({
    sequence: 0,
    runId: run.runId,
    attemptNumber: attempt + 1,
    modelSelection: { ...selection },
  }))).map((row, index) => ({ ...row, sequence: index + 1 }))
  return { runs, providerCalls, frozen: { modelSelection: selection, ...hashes } }
}

function setUniqueAndAbsent(
  run: ReturnType<typeof rawRows>['runs'][number],
  exactEvidenceCount: number,
) {
  const absentQuoteEvidenceCount = run.schemaValidEvidenceCount - exactEvidenceCount
  Object.assign(run, {
    exactEvidenceCount,
    rejectionCounts: absentQuoteEvidenceCount === 0
      ? {}
      : { EVIDENCE_NOT_FOUND: absentQuoteEvidenceCount },
    uniqueQuoteEvidenceCount: exactEvidenceCount,
    repeatedQuoteEvidenceCount: 0,
    absentQuoteEvidenceCount,
    disambiguationAttempted: 0,
    disambiguationSucceeded: 0,
    disambiguationRejected: 0,
    disambiguationObservationStatus: 'not_observed',
  })
}

function diagnosticRows({
  firstAttemptSuccesses = 3,
  completedRuns = 3,
  budgetState = 'COMPLETE',
}: {
  firstAttemptSuccesses?: number
  completedRuns?: number
  budgetState?: 'COMPLETE' | 'NO_GO'
} = {}) {
  const runs = Array.from({ length: completedRuns }, (_, index) => {
    const firstAttemptSucceeded = index < firstAttemptSuccesses
    return {
      ordinal: index + 1,
      runId: `diagnostic-run-${index + 1}`,
      firstAttemptSucceeded,
      finalSucceeded: true,
      providerCalls: firstAttemptSucceeded ? 1 : 2,
      candidateCount: 1,
      schemaValidEvidenceCount: 1,
      exactEvidenceCount: 1,
      rejectionCounts: {},
      reviewEvidenceMethods: ['exact'],
      uniqueQuoteEvidenceCount: 1,
      repeatedQuoteEvidenceCount: 0,
      absentQuoteEvidenceCount: 0,
      disambiguationAttempted: 0,
      disambiguationSucceeded: 0,
      disambiguationRejected: 0,
      disambiguationObservationStatus: 'not_observed',
      modelSelection: { ...lowSelection },
      ...hashes,
    }
  })
  const providerCalls = runs.flatMap(run => Array.from(
    { length: run.providerCalls },
    (_, attempt) => ({
      sequence: 0,
      runId: run.runId,
      attemptNumber: attempt + 1,
      modelSelection: { ...lowSelection },
    }),
  )).map((row, index) => ({ ...row, sequence: index + 1 }))
  const request = {
    version: 2,
    purpose: 'phase1e-flash-low-stability',
    batchPolicy: 'flash-low-stability',
    requestDigest: 'e'.repeat(64),
    modelSelection: { ...lowSelection },
    maxRuns: 3,
    maxCalls: 4,
    ...hashes,
  }
  const budget = {
    version: 2,
    batchPolicy: 'flash-low-stability',
    requestDigest: request.requestDigest,
    authorizedRuns: 3,
    authorizedMaxCalls: 4,
    actualRuns: runs.length,
    actualCalls: providerCalls.length,
    completedRunIds: runs.map(run => run.runId),
    retryUsed: runs.some(run => !run.firstAttemptSucceeded),
    state: budgetState,
  }
  return {
    runs,
    providerCalls,
    request,
    budget,
    frozen: { modelSelection: lowSelection, ...hashes },
  }
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

describe('Phase 1E-A3 Flash Low diagnostic', () => {
  test('recomputes an A3 evidence root and ignores a forged final result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nobei-phase1e-a3-verify-'))
    const value = diagnosticRows()
    await Promise.all([
      writeJson(join(root, 'raw-runs.json'), value.runs),
      writeJson(join(root, 'observer-records.json'), value.providerCalls),
      writeJson(join(root, 'budget-manifest.json'), value.budget),
      writeJson(join(root, 'authorization-request.json'), value.request),
      writeJson(join(root, 'manifest.json'), {
        phase: 'phase1e-real-model',
        batchPolicy: 'flash-low-stability',
        artifacts: { product: { sha256: hashes.artifactSha256 } },
      }),
    ])
    await expect(verifyEvidenceRoot(root)).resolves.toMatchObject({
      status: 'A3_DIAGNOSTIC_PASS',
      batchPolicy: 'flash-low-stability',
      completedRuns: 3,
      firstAttemptSuccesses: 3,
      actualProviderCalls: 3,
    })
    await writeJson(join(root, 'final-result.json'), { status: 'A3_DIAGNOSTIC_UNSTABLE' })
    await expect(verifyEvidenceRoot(root)).resolves.toMatchObject({ status: 'A3_DIAGNOSTIC_PASS' })
    expect(JSON.parse(await readFile(join(root, 'final-result.json'), 'utf8')).status)
      .toBe('A3_DIAGNOSTIC_PASS')

    value.providerCalls[0].modelSelection.reasoningEffort = 'high'
    await writeJson(join(root, 'observer-records.json'), value.providerCalls)
    await expect(verifyEvidenceRoot(root)).rejects.toThrow('PHASE1E_PROVIDER_LEDGER_MISMATCH')
  })

  test('classifies only three first-attempt successes as A3 PASS', () => {
    expect(diagnoseFlashLowStability(diagnosticRows())).toMatchObject({
      status: 'A3_DIAGNOSTIC_PASS',
      metrics: {
        completedRuns: 3,
        firstAttemptSuccesses: 3,
        actualProviderCalls: 3,
        retryUsed: false,
      },
    })
  })

  test('classifies one recovered first-attempt failure as UNSTABLE, never PASS', () => {
    expect(diagnoseFlashLowStability(diagnosticRows({ firstAttemptSuccesses: 2 })))
      .toMatchObject({
        status: 'A3_DIAGNOSTIC_UNSTABLE',
        metrics: {
          completedRuns: 3,
          firstAttemptSuccesses: 2,
          actualProviderCalls: 4,
          retryUsed: true,
        },
      })
  })

  test.each([
    ['hide retry', (value: ReturnType<typeof diagnosticRows>) => { value.budget.retryUsed = false }],
    ['forge first-pass count', (value: ReturnType<typeof diagnosticRows>) => {
      value.runs[2].firstAttemptSucceeded = true
    }],
    ['drop provider call', (value: ReturnType<typeof diagnosticRows>) => { value.providerCalls.pop() }],
    ['change effort', (value: ReturnType<typeof diagnosticRows>) => {
      value.providerCalls[0].modelSelection.reasoningEffort = 'high'
    }],
    ['mix policy', (value: ReturnType<typeof diagnosticRows>) => {
      value.request.batchPolicy = 'gate5-full'
    }],
  ])('rejects diagnostic mutation: %s', (_label, mutate) => {
    const value = diagnosticRows({ firstAttemptSuccesses: 2 })
    mutate(value)
    expect(() => diagnoseFlashLowStability(value)).toThrow()
  })

  test('derives NO_GO from a reconciled terminal budget rather than a declared string', () => {
    const value = {
      ...diagnosticRows({ firstAttemptSuccesses: 1, completedRuns: 1, budgetState: 'NO_GO' }),
      declaredOutcome: 'A3_DIAGNOSTIC_PASS',
    }
    expect(diagnoseFlashLowStability(value).status).toBe('A3_DIAGNOSTIC_NO_GO')
  })
})

describe('Phase 1E Gate 5 independent metrics', () => {
  test.each([
    [undefined, 20, 20],
    [7, 19, 21],
  ])('recomputes a valid 20-run batch (retry=%s)', (retryOrdinal, firstPassSuccesses, calls) => {
    expect(computePhase1eMetrics(rawRows({ retryOrdinal }))).toMatchObject({
      runs: 20,
      firstPassSuccesses,
      finalSuccesses: 20,
      providerCalls: calls,
      candidatesPerRun: Array(20).fill(2),
      schemaValidEvidenceCount: 60,
      exactEvidenceCount: 59,
      exactEvidenceYield: 59 / 60,
      rejectionCounts: { EVIDENCE_AMBIGUOUS: 1 },
      uniqueQuoteEvidenceCount: 59,
      repeatedQuoteEvidenceCount: 1,
      absentQuoteEvidenceCount: 0,
      disambiguationAttempted: 1,
      disambiguationSucceeded: 0,
      disambiguationRejected: 1,
      disambiguationObservationStatus: 'observed',
    })
  })

  test('keeps not_observed non-blocking', () => {
    const value = rawRows()
    Object.assign(value.runs[19], {
      exactEvidenceCount: 3,
      rejectionCounts: {},
      uniqueQuoteEvidenceCount: 3,
      repeatedQuoteEvidenceCount: 0,
      disambiguationAttempted: 0,
      disambiguationSucceeded: 0,
      disambiguationRejected: 0,
      disambiguationObservationStatus: 'not_observed',
    })
    expect(diagnosePhase1eMetrics(value)).toMatchObject({
      status: 'PHASE1E_REAL_MODEL_GO',
      metrics: {
        disambiguationAttempted: 0,
        disambiguationObservationStatus: 'not_observed',
      },
    })
  })

  test.each([
    ['missing run', (value: ReturnType<typeof rawRows>) => { value.runs.pop() }, 'PHASE1E_RUN_SET_INVALID'],
    ['duplicate run', (value: ReturnType<typeof rawRows>) => { value.runs[19] = { ...value.runs[0], ordinal: 20 } }, 'PHASE1E_RUN_SET_INVALID'],
    ['second first failure', (value: ReturnType<typeof rawRows>) => { value.runs[0].firstAttemptSucceeded = false; value.runs[1].firstAttemptSucceeded = false }, 'PHASE1E_FIRST_PASS_INVALID'],
    ['failed final run', (value: ReturnType<typeof rawRows>) => { value.runs[0].finalSucceeded = false }, 'PHASE1E_FINAL_SUCCESS_INVALID'],
    ['call 22', (value: ReturnType<typeof rawRows>) => { value.providerCalls.push({ ...value.providerCalls[0], sequence: 21 + 1, attemptNumber: 3 }) }, 'PHASE1E_PROVIDER_CALL_BUDGET_INVALID'],
    ['zero candidates', (value: ReturnType<typeof rawRows>) => { value.runs[0].candidateCount = 0 }, 'PHASE1E_CANDIDATE_COUNT_INVALID'],
    ['low exact yield', (value: ReturnType<typeof rawRows>) => {
      for (const run of value.runs.slice(0, 4)) setUniqueAndAbsent(run, 0)
    }, 'PHASE1E_EXACT_EVIDENCE_YIELD_INVALID'],
    ['selection drift', (value: ReturnType<typeof rawRows>) => { value.runs[0].modelSelection.model = 'other' }, 'PHASE1E_FROZEN_INPUT_DRIFT'],
    ['hash drift', (value: ReturnType<typeof rawRows>) => { value.runs[0].schemaSha256 = 'e'.repeat(64) }, 'PHASE1E_FROZEN_INPUT_DRIFT'],
    ['provider selection drift', (value: ReturnType<typeof rawRows>) => { value.providerCalls[0].modelSelection.model = 'other' }, 'PHASE1E_PROVIDER_LEDGER_MISMATCH'],
  ])('rejects %s', (_label, mutate, code) => {
    const value = rawRows({ retryOrdinal: 7 })
    mutate(value)
    expect(() => computePhase1eMetrics(value)).toThrow(code)
  })

  test.each([
    ['partition', (run: ReturnType<typeof rawRows>['runs'][number]) => {
      run.uniqueQuoteEvidenceCount += 1
    }],
    ['attempted', (run: ReturnType<typeof rawRows>['runs'][number]) => {
      run.disambiguationAttempted = 0
    }],
    ['succeeded', (run: ReturnType<typeof rawRows>['runs'][number]) => {
      run.disambiguationSucceeded = 1
    }],
    ['rejected', (run: ReturnType<typeof rawRows>['runs'][number]) => {
      run.disambiguationRejected = 0
    }],
    ['absent', (run: ReturnType<typeof rawRows>['runs'][number]) => {
      run.absentQuoteEvidenceCount = 1
    }],
    ['positive reported not_observed', (run: ReturnType<typeof rawRows>['runs'][number]) => {
      run.disambiguationObservationStatus = 'not_observed'
    }],
  ])('rejects invalid observation identity: %s', (_label, mutate) => {
    const value = rawRows()
    mutate(value.runs[19])
    expect(() => computePhase1eMetrics(value))
      .toThrow('PHASE1E_DISAMBIGUATION_METRICS_INVALID')
  })

  test('rejects observed when no repeated quote was attempted', () => {
    const value = rawRows()
    value.runs[0].disambiguationObservationStatus = 'observed'
    expect(() => computePhase1eMetrics(value))
      .toThrow('PHASE1E_DISAMBIGUATION_METRICS_INVALID')
  })

  test('does not accept a literal PASS in place of raw rows', () => {
    expect(() => computePhase1eMetrics({ runs: 'PASS', providerCalls: [], frozen: {} }))
      .toThrow('PHASE1E_RAW_ROWS_INVALID')
  })

  test('returns measured metrics with a NO-GO decision when only exact yield misses the gate', () => {
    const value = rawRows()
    for (const run of value.runs.slice(0, 6)) setUniqueAndAbsent(run, 1)
    expect(diagnosePhase1eMetrics(value)).toMatchObject({
      status: 'PHASE1E_REAL_MODEL_NO_GO',
      reason: 'PHASE1E_EXACT_EVIDENCE_YIELD_INVALID',
      metrics: {
        runs: 20,
        firstPassSuccesses: 20,
        finalSuccesses: 20,
        providerCalls: 20,
      },
    })
    expect(diagnosePhase1eMetrics(value).metrics.exactEvidenceYield).toBeLessThan(0.90)
  })
})

describe('Phase 1E remaining-run resume gate', () => {
  const request = { requestDigest: 'e'.repeat(64), modelSelection: selection, ...hashes }
  const budget = {
    version: 1, requestDigest: request.requestDigest,
    authorizedRuns: 20, authorizedMaxCalls: 21,
    actualRuns: 1, actualCalls: 1, completedRunIds: ['run-1'], retryUsed: false,
    state: 'FIRST_RUN_REVIEW',
  }
  const continuation = {
    version: 1,
    requestDigest: request.requestDigest,
    authorizationSource: 'explicit-user-continuation-confirmation-in-active-codex-task',
    authorizedAt: '2026-08-30T00:00:00.000Z',
  }

  test('accepts the exact first-run checkpoint and a separate continuation confirmation', () => {
    expect(assertRemainingReady({ budget, continuation, request, currentHashes: hashes }))
      .toMatchObject({ nextOrdinal: 2, completedRunIds: ['run-1'] })
  })

  test.each([
    ['wrong state', { budget: { ...budget, state: 'FIRST_RUN_AUTHORIZED' } }, 'PHASE1E_REMAINING_STATE_INVALID'],
    ['missing confirmation', { continuation: undefined }, 'PHASE1E_CONTINUATION_REQUIRED'],
    ['wrong count', { budget: { ...budget, actualCalls: 2 } }, 'PHASE1E_FIRST_RUN_COUNTS_INVALID'],
    ['hash drift', { currentHashes: { ...hashes, fixtureSha256: 'f'.repeat(64) } }, 'PHASE1E_FROZEN_INPUT_DRIFT'],
  ])('rejects %s', (_label, patch, code) => {
    expect(() => assertRemainingReady({ budget, continuation, request, currentHashes: hashes, ...patch }))
      .toThrow(code)
  })
})
