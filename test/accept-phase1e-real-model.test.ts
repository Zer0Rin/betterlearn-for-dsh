import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import {
  assertFirstRunResult,
  buildEvidenceObservationFields,
  buildAuthorizationFields,
  buildObservedRawRun,
  buildRecoveredFirstRunCheckpoint,
  buildPhase1eAcceptancePlan,
  evaluatePrepareObservation,
  PHASE1E_FIXTURE_NAME,
  PHASE1E_PROMPT_VERSION,
  nextDiagnosticAction,
  parseAcceptanceCommand,
  parseDshSessionObservation,
  retryTransientPasteEntry,
  waitForReviewableRun,
} from '../scripts/accept-phase1e-real-model.mjs'

const selection = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
}

const observationText = '唯一事实。\n甲：重复事实。甲尾\n乙：重复事实。乙尾'
const observationOutput = { candidates: [{ evidence: [
  { quote: '唯一事实', prefix: '', suffix: '' },
  { quote: '重复事实', prefix: '甲：', suffix: '。甲尾' },
  { quote: '不存在', prefix: '', suffix: '' },
] }] }

function matchingObservationAttempt() {
  return {
    rawOutput: structuredClone(observationOutput),
    schemaValidEvidenceCount: 3,
    exactEvidenceCount: 2,
    rejectionCounts: { EVIDENCE_NOT_FOUND: 1 },
  }
}

function passingFirstRun() {
  return {
    importStatus: 202,
    displayedModel: '本次模型：deepseek-official / deepseek-v4-flash · high',
    browserModelSelection: { ...selection },
    coreAttempt: {
      runId: 'run-1',
      requestDigest: 'a'.repeat(64),
      modelSelection: { ...selection },
      status: 'review_pending',
    },
    observerRecords: [{
      sequence: 1,
      requestDigest: 'a'.repeat(64),
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
    }],
    candidates: [{
      candidateId: 'candidate-1',
      evidence: [{ quote: '光合作用把光能转化为化学能。', startOffset: 0, endOffset: 15, alignMethod: 'exact' }],
    }],
    exactEvidenceYield: 1,
    screenshotPath: '/tmp/phase1e-first-run.png',
  }
}

describe('Phase 1E real-model acceptance planning', () => {
  test('parses only named diagnostic CLI forms', () => {
    expect(parseAcceptanceCommand(['prepare', '--batch-policy', 'flash-low-stability']))
      .toEqual({ mode: 'prepare', batchPolicy: 'flash-low-stability' })
    expect(parseAcceptanceCommand(['diagnostic', '--evidence-root', '/tmp/evidence']))
      .toEqual({ mode: 'diagnostic', evidenceRoot: '/tmp/evidence' })
    expect(() => parseAcceptanceCommand(['prepare', '--batch-policy', 'custom']))
      .toThrow('PHASE1E_BATCH_POLICY_INVALID')
  })

  test.each([
    [{ ordinal: 1, firstAttemptSucceeded: true, retrySucceeded: undefined, retryUsed: false }, 'NEXT_RUN'],
    [{ ordinal: 3, firstAttemptSucceeded: true, retrySucceeded: undefined, retryUsed: false }, 'COMPLETE'],
    [{ ordinal: 1, firstAttemptSucceeded: false, retrySucceeded: undefined, retryUsed: false }, 'RETRY'],
    [{ ordinal: 1, firstAttemptSucceeded: false, retrySucceeded: true, retryUsed: true }, 'NEXT_RUN'],
    [{ ordinal: 2, firstAttemptSucceeded: false, retrySucceeded: undefined, retryUsed: true }, 'NO_GO'],
    [{ ordinal: 1, firstAttemptSucceeded: false, retrySucceeded: false, retryUsed: true }, 'NO_GO'],
  ])('maps diagnostic progression %#', (input, expected) => {
    expect(nextDiagnosticAction(input)).toBe(expected)
  })

  test('prepares the closed Low diagnostic as 3 runs and 4 calls', () => {
    expect(buildAuthorizationFields({
      batchPolicy: 'flash-low-stability',
      artifactSha256: 'a'.repeat(64),
      promptVersion: 'l1-v2',
      promptSha256: 'b'.repeat(64),
      schemaVersion: 1,
      schemaSha256: 'c'.repeat(64),
      fixtureSha256: 'd'.repeat(64),
      modelSelection: {
        provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low',
      },
    })).toMatchObject({
      version: 2,
      purpose: 'phase1e-flash-low-stability',
      batchPolicy: 'flash-low-stability',
      maxRuns: 3,
      maxCalls: 4,
    })
  })

  test.each(['off', 'high', 'max', undefined])(
    'rejects diagnostic effort %s before execution',
    (reasoningEffort) => {
      expect(() => buildAuthorizationFields({
        batchPolicy: 'flash-low-stability',
        artifactSha256: 'a'.repeat(64),
        promptVersion: 'l1-v2',
        promptSha256: 'b'.repeat(64),
        schemaVersion: 1,
        schemaSha256: 'c'.repeat(64),
        fixtureSha256: 'd'.repeat(64),
        modelSelection: {
          provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort,
        },
      })).toThrow('REAL_MODEL_DIAGNOSTIC_SELECTION_MISMATCH')
    },
  )

  test('derives observation counters and excludes raw provider output from persisted rows', () => {
    const coreAttempt = matchingObservationAttempt()
    expect(buildEvidenceObservationFields(observationText, coreAttempt)).toEqual({
      schemaValidEvidenceCount: 3,
      uniqueQuoteEvidenceCount: 1,
      repeatedQuoteEvidenceCount: 1,
      absentQuoteEvidenceCount: 1,
      disambiguationAttempted: 1,
      disambiguationSucceeded: 1,
      disambiguationRejected: 0,
      disambiguationObservationStatus: 'observed',
    })
    const row = buildObservedRawRun(observationText, coreAttempt, { ordinal: 1, runId: 'run-1' })
    expect(row).toMatchObject({ ordinal: 1, runId: 'run-1', disambiguationAttempted: 1 })
    expect(row).not.toHaveProperty('rawOutput')
    expect(JSON.stringify(row)).not.toContain(observationText)
    expect(JSON.stringify(row)).not.toContain('重复事实')
  })

  test.each([
    ['schema total', (attempt: ReturnType<typeof matchingObservationAttempt>) => {
      attempt.schemaValidEvidenceCount = 2
    }],
    ['exact total', (attempt: ReturnType<typeof matchingObservationAttempt>) => {
      attempt.exactEvidenceCount = 1
    }],
    ['not-found total', (attempt: ReturnType<typeof matchingObservationAttempt>) => {
      attempt.rejectionCounts.EVIDENCE_NOT_FOUND = 0
    }],
    ['ambiguous total', (attempt: ReturnType<typeof matchingObservationAttempt>) => {
      attempt.rejectionCounts.EVIDENCE_AMBIGUOUS = 1
    }],
  ])('rejects Core/observer mismatch: %s', (_label, mutate) => {
    const attempt = matchingObservationAttempt()
    mutate(attempt)
    expect(() => buildEvidenceObservationFields(observationText, attempt))
      .toThrow('PHASE1E_OBSERVATION_CORE_MISMATCH')
  })

  test('rejects a raw output property in a persisted row base', () => {
    expect(() => buildObservedRawRun(observationText, matchingObservationAttempt(), {
      ordinal: 1,
      rawOutput: observationOutput,
    })).toThrow('PHASE1E_RAW_RUN_TEXT_LEAK')
  })

  test('freezes the A2 prompt and repeated fixture identities', () => {
    expect(PHASE1E_FIXTURE_NAME).toBe('phase1e-gate5-repeated.md')
    expect(PHASE1E_PROMPT_VERSION).toBe('l1-v2')
  })

  test('retries the complete paste-entry action after a transient view remount', async () => {
    let attempts = 0
    await expect(retryTransientPasteEntry(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('element was detached from the DOM')
      return 'filled'
    }, { attempts: 3, delayMs: 0 })).resolves.toBe('filled')
    expect(attempts).toBe(2)
  })

  test('stops paste-entry retries at the declared bound', async () => {
    let attempts = 0
    await expect(retryTransientPasteEntry(async () => {
      attempts += 1
      throw new Error('still remounting')
    }, { attempts: 2, delayMs: 0 })).rejects.toThrow('still remounting')
    expect(attempts).toBe(2)
  })

  test('stops run polling immediately on a retryable generation failure', async () => {
    let reads = 0
    await expect(waitForReviewableRun(async () => {
      reads += 1
      return { status: 'failed_retryable', error: { code: 'GENERATION_NO_OUTPUT' } }
    }, { timeoutMs: 1_000, intervalMs: 0 })).rejects.toThrow(
      'FIRST_RUN_GENERATION_FAILED:GENERATION_NO_OUTPUT',
    )
    expect(reads).toBe(1)
  })

  test('returns the first reviewable run snapshot', async () => {
    const values = [{ status: 'generating' }, { status: 'review_pending', runId: 'run-1' }]
    await expect(waitForReviewableRun(async () => values.shift(), {
      timeoutMs: 1_000, intervalMs: 0,
    })).resolves.toEqual({ status: 'review_pending', runId: 'run-1' })
  })

  test('builds a zero-call exact rc.7 plan with product and observer tarballs only', () => {
    const plan = buildPhase1eAcceptancePlan({
      dshPath: '/opt/runtime/node_modules/.bin/dsh',
      profileName: 'nobei-phase1e-accept-abc123',
      productTarball: '/tmp/product.tgz',
      observerTarball: '/tmp/observer.tgz',
      dshHome: '/Users/test/.dsh',
    })
    expect(plan).toMatchObject({
      rc7: '0.1.0-rc.7',
      profileName: 'nobei-phase1e-accept-abc123',
      dshPath: '/opt/runtime/node_modules/.bin/dsh',
      dshHome: '/Users/test/.dsh',
      packages: {
        product: '/tmp/product.tgz',
        observer: '/tmp/observer.tgz',
      },
      prepare: { actualRuns: 0, actualCalls: 0, zeroLlmStreamCalls: true },
    })
    expect(JSON.stringify(plan)).not.toContain('fake-provider')
    expect(JSON.stringify(plan)).not.toContain('registerAdapter')
    expect(JSON.stringify(plan)).not.toMatch(/open\s|osascript|Safari/)
    expect(plan.prepare.actions).toEqual([
      'install-frozen-product',
      'install-independent-observer',
      'load-model-directory',
      'resolve-model-selection',
      'write-authorization-request',
    ])
  })

  test.each([
    ['MODEL_SELECTION_UNAVAILABLE', { status: 'MODEL_SELECTION_UNAVAILABLE' }],
    ['MODEL_NOT_ROUTABLE', { status: 'READY', current: selection, routable: false }],
    ['MODEL_DIRECTORY_CONTRACT_INVALID', { status: 'READY', routable: true }],
  ])('blocks a non-routable prepare observation: %s', (reason, modelDirectory) => {
    expect(evaluatePrepareObservation({
      modelDirectory,
      adapters: {
        '@deepseek-ai/dsh-llm-deepseek': '0.1.0-rc.7',
        '@deepseek-ai/dsh-llm-pi-ai': '0.1.0-rc.7',
      },
      observerRecords: [],
    })).toMatchObject({ status: 'BLOCKED_PROVIDER_CONFIG', reason })
  })

  test('requires actual rc.7 adapter manifests and an empty observer ledger', () => {
    const normal = {
      modelDirectory: { status: 'READY', current: selection, routable: true },
      adapters: {
        '@deepseek-ai/dsh-llm-deepseek': '0.1.0-rc.7',
        '@deepseek-ai/dsh-llm-pi-ai': '0.1.0-rc.7',
      },
      observerRecords: [],
    }
    expect(evaluatePrepareObservation(normal)).toMatchObject({ status: 'READY', selection })
    expect(evaluatePrepareObservation({ ...normal, adapters: {
      ...normal.adapters, '@deepseek-ai/dsh-llm-pi-ai': '0.1.0-rc.8',
    } })).toMatchObject({ status: 'BLOCKED_PROVIDER_CONFIG', reason: 'ADAPTER_MANIFEST_VERSION_INVALID' })
    expect(evaluatePrepareObservation({ ...normal, observerRecords: [{ sequence: 1 }] }))
      .toMatchObject({ status: 'BLOCKED_PROVIDER_CONFIG', reason: 'OBSERVER_STREAM_CALLS_NONZERO' })
  })

  test('keeps the fixed Gate 5 fixture short and free of trigger strings', async () => {
    const fixture = await readFile('acceptance/fixtures/phase1e-gate5.md', 'utf8')
    expect(Buffer.byteLength(fixture)).toBeGreaterThan(100)
    expect(Buffer.byteLength(fixture)).toBeLessThanOrEqual(65_536)
    expect(fixture).not.toContain('fixture:')
  })

  test('the repeated Gate 5 fixture has real duplicate statements and unique facts', async () => {
    const fixture = await readFile('acceptance/fixtures/phase1e-gate5-repeated.md', 'utf8')
    const repeated = [
      '气孔是叶片与外界交换气体和水蒸气的重要通道。',
      '保卫细胞吸水膨胀时，气孔通常张开。',
    ]
    const unique = [
      '蒸腾作用产生的拉力有助于水和无机盐沿木质部向上运输。',
      '干旱条件下脱落酸信号会促进气孔关闭。',
      '夜间二氧化碳需求下降时，多数植物的气孔开度减小。',
      '气孔关闭能够降低失水速度，但也会限制二氧化碳进入叶片。',
    ]
    expect(Array.from(fixture).length).toBeGreaterThanOrEqual(600)
    expect(Array.from(fixture).length).toBeLessThanOrEqual(1_000)
    expect(Buffer.byteLength(fixture)).toBeLessThanOrEqual(65_536)
    for (const value of repeated) expect(fixture.split(value)).toHaveLength(3)
    for (const value of unique) expect(fixture.split(value)).toHaveLength(2)
    const exactWindows = [
      `## 光照充足时的叶片\n\n${repeated[0]}白天光照充足时`,
      `## 干旱时的叶片\n\n${repeated[0]}当土壤含水量降低时`,
      `从空气中获得二氧化碳。${repeated[1]}气孔张开后`,
      `叶片水势随之上升。${repeated[1]}此时气体交换增强`,
    ]
    for (const value of exactWindows) expect(fixture.split(value)).toHaveLength(2)
    expect(fixture).not.toContain('fixture:')
  })

  test('compiles the authorization contract into the Host runtime', async () => {
    const tsconfig = JSON.parse(await readFile('tsconfig.host.json', 'utf8'))
    expect(tsconfig.include).toContain('src/acceptance/**/*.ts')
  })
})

describe('Phase 1E first-run checkpoint', () => {
  test('reduces a persisted DSH session to non-sensitive call metadata', () => {
    expect(parseDshSessionObservation([
      { type: 'request/context', data: { provider: selection.provider, model: selection.model } },
      { type: 'request/header', data: { header: { config: {
        provider: selection.provider, model: selection.model,
        reasoningEffort: selection.reasoningEffort, maxTokens: 8_192,
      } } } },
      { type: 'assistant/message', data: { usage: { inputTokens: 12, outputTokens: 34, reasoningTokens: 5 } } },
      { type: 'tool/call', data: { name: 'structured_output', arguments: { secret: 'must-not-leak' } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ], '6'.repeat(64))).toEqual({
      source: 'dsh-session-log-recovery', sourceSha256: '6'.repeat(64),
      provider: selection.provider, model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      streamCalls: 1, structuredOutputCalls: 1, completedTurns: 1,
      usage: { inputTokens: 12, outputTokens: 34, reasoningTokens: 5 },
    })
  })

  test('accepts one attributed call ending in a reviewable exact-evidence result', () => {
    expect(assertFirstRunResult(passingFirstRun())).toMatchObject({
      importStatus: 202,
      exactEvidenceYield: 1,
    })
  })

  test.each([
    ['wrong model label', (value: ReturnType<typeof passingFirstRun>) => { value.displayedModel = 'other' }, 'FIRST_RUN_MODEL_LABEL_MISMATCH'],
    ['wrong import status', (value: ReturnType<typeof passingFirstRun>) => { value.importStatus = 200 }, 'FIRST_RUN_IMPORT_FAILED'],
    ['zero calls', (value: ReturnType<typeof passingFirstRun>) => { value.observerRecords = [] }, 'FIRST_RUN_CALL_COUNT_INVALID'],
    ['two calls', (value: ReturnType<typeof passingFirstRun>) => { value.observerRecords.push({ ...value.observerRecords[0], sequence: 2 }) }, 'FIRST_RUN_CALL_COUNT_INVALID'],
    ['non-reviewable state', (value: ReturnType<typeof passingFirstRun>) => { value.coreAttempt.status = 'completed' }, 'FIRST_RUN_NOT_REVIEWABLE'],
    ['zero candidates', (value: ReturnType<typeof passingFirstRun>) => { value.candidates = [] }, 'FIRST_RUN_CANDIDATES_INVALID'],
    ['non-exact evidence', (value: ReturnType<typeof passingFirstRun>) => { value.candidates[0].evidence[0].alignMethod = 'normalized' }, 'FIRST_RUN_EVIDENCE_INVALID'],
    ['browser/core drift', (value: ReturnType<typeof passingFirstRun>) => { value.coreAttempt.modelSelection.model = 'other' }, 'FIRST_RUN_MODEL_SELECTION_MISMATCH'],
    ['ledger/core drift', (value: ReturnType<typeof passingFirstRun>) => { value.observerRecords[0].reasoningEffort = 'low' }, 'FIRST_RUN_MODEL_SELECTION_MISMATCH'],
  ])('rejects %s', (_label, mutate, code) => {
    const value = passingFirstRun()
    mutate(value)
    expect(() => assertFirstRunResult(value)).toThrow(code)
  })

  test('reconciles one completed call from a hashed DSH session log after UI recovery', () => {
    const value = passingFirstRun()
    const recovered = buildRecoveredFirstRunCheckpoint({
      request: {
        requestDigest: 'f'.repeat(64), modelSelection: selection,
        artifactSha256: '1'.repeat(64), promptSha256: '2'.repeat(64),
        schemaSha256: '3'.repeat(64), fixtureSha256: '4'.repeat(64),
      },
      budget: {
        version: 1, requestDigest: 'f'.repeat(64), authorizedRuns: 20, authorizedMaxCalls: 21,
        actualRuns: 0, actualCalls: 1, completedRunIds: [], retryUsed: false,
        state: 'FIRST_RUN_AUTHORIZED',
      },
      coreAttempt: {
        ...value.coreAttempt, attemptNumber: 1, attemptStatus: 'succeeded',
        rawCandidateCount: 1, schemaValidEvidenceCount: 1, exactEvidenceCount: 1,
        rejectionCounts: {},
        rawOutput: { candidates: [{ evidence: [{
          quote: '光合作用把光能转化为化学能。', prefix: '', suffix: '',
        }] }] },
      },
      candidates: value.candidates,
      displayedModel: value.displayedModel,
      screenshotPath: value.screenshotPath,
      sessionObservation: {
        source: 'dsh-session-log-recovery', sourceSha256: '5'.repeat(64),
        provider: selection.provider, model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        streamCalls: 1, structuredOutputCalls: 1, completedTurns: 1,
      },
      fixtureText: '光合作用把光能转化为化学能。',
    })
    expect(recovered.rawRun).toMatchObject({
      ordinal: 1, runId: 'run-1', firstAttemptSucceeded: true,
      finalSucceeded: true, providerCalls: 1, candidateCount: 1,
      uniqueQuoteEvidenceCount: 1, repeatedQuoteEvidenceCount: 0,
      disambiguationAttempted: 0, disambiguationObservationStatus: 'not_observed',
    })
    expect(recovered.providerCall).toMatchObject({
      sequence: 1, runId: 'run-1', attemptNumber: 1,
      source: 'dsh-session-log-recovery', sourceSha256: '5'.repeat(64),
      modelSelection: selection,
    })
    expect(recovered.result.coreAttempt).not.toHaveProperty('rawOutput')
  })

  test('rejects a recovery log that observed more than one model stream', () => {
    const value = passingFirstRun()
    expect(() => buildRecoveredFirstRunCheckpoint({
      request: {
        requestDigest: 'f'.repeat(64), modelSelection: selection,
        artifactSha256: '1'.repeat(64), promptSha256: '2'.repeat(64),
        schemaSha256: '3'.repeat(64), fixtureSha256: '4'.repeat(64),
      },
      budget: {
        version: 1, requestDigest: 'f'.repeat(64), authorizedRuns: 20, authorizedMaxCalls: 21,
        actualRuns: 0, actualCalls: 1, completedRunIds: [], retryUsed: false,
        state: 'FIRST_RUN_AUTHORIZED',
      },
      coreAttempt: {
        ...value.coreAttempt, attemptNumber: 1, attemptStatus: 'succeeded',
        rawCandidateCount: 1, schemaValidEvidenceCount: 1, exactEvidenceCount: 1,
        rejectionCounts: {},
      },
      candidates: value.candidates,
      displayedModel: value.displayedModel,
      screenshotPath: value.screenshotPath,
      sessionObservation: {
        source: 'dsh-session-log-recovery', sourceSha256: '5'.repeat(64),
        provider: selection.provider, model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        streamCalls: 2, structuredOutputCalls: 1, completedTurns: 1,
      },
    })).toThrow('FIRST_RUN_RECOVERY_OBSERVATION_INVALID')
  })
})
