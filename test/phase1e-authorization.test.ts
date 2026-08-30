import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  advanceRealModelBudget,
  createRealModelBudget,
  createRealModelAuthorizationRequest,
  verifyRealModelAuthorizationRequest,
  verifyRealModelGrant,
  writeRealModelContinuationGrant,
  writeRealModelAuthorizationGrant,
  type RealModelAuthorizationGrant,
  type RealModelBudgetManifest,
} from '../src/acceptance/real-model-authorization.js'

const shared = {
  version: 2 as const,
  artifactSha256: 'a'.repeat(64),
  promptVersion: 'l1-v2',
  promptSha256: 'b'.repeat(64),
  schemaVersion: 1,
  schemaSha256: 'c'.repeat(64),
  fixtureSha256: 'd'.repeat(64),
}

const fields = {
  ...shared,
  purpose: 'phase1e-real-model-gate5' as const,
  batchPolicy: 'gate5-full' as const,
  modelSelection: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
  },
  maxRuns: 20 as const,
  maxCalls: 21 as const,
}

const lowFields = {
  ...shared,
  purpose: 'phase1e-flash-low-stability' as const,
  batchPolicy: 'flash-low-stability' as const,
  modelSelection: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'low',
  },
  maxRuns: 3 as const,
  maxCalls: 4 as const,
}

function grantFor(
  request = createRealModelAuthorizationRequest(fields),
): RealModelAuthorizationGrant {
  return {
    version: 2,
    batchPolicy: request.batchPolicy,
    requestDigest: request.requestDigest,
    modelSelection: { ...request.modelSelection },
    authorizedRuns: 20,
    authorizedMaxCalls: 21,
    authorizedAt: '2026-08-30T00:00:00.000Z',
    authorizationSource: 'explicit-user-confirmation-in-active-codex-task',
  }
}

function manifest(state: RealModelBudgetManifest['state'] = 'PREPARED'): RealModelBudgetManifest {
  return {
    version: 2,
    batchPolicy: 'gate5-full',
    requestDigest: 'e'.repeat(64),
    authorizedRuns: 20,
    authorizedMaxCalls: 21,
    actualRuns: 0,
    actualCalls: 0,
    completedRunIds: [],
    retryUsed: false,
    state,
  }
}

describe('Phase 1E real-model authorization request', () => {
  test('accepts only the two closed policy tuples', () => {
    expect(createRealModelAuthorizationRequest(fields).batchPolicy).toBe('gate5-full')
    expect(createRealModelAuthorizationRequest(lowFields).batchPolicy).toBe('flash-low-stability')
    expect(() => createRealModelAuthorizationRequest({ ...lowFields, maxCalls: 5 as 4 }))
      .toThrow('REAL_MODEL_BATCH_POLICY_MISMATCH')
    expect(() => createRealModelAuthorizationRequest({ ...lowFields, maxRuns: 20 as 3 }))
      .toThrow('REAL_MODEL_BATCH_POLICY_MISMATCH')
    expect(() => createRealModelAuthorizationRequest({
      ...lowFields,
      modelSelection: { ...lowFields.modelSelection, reasoningEffort: 'high' },
    })).toThrow('REAL_MODEL_DIAGNOSTIC_SELECTION_MISMATCH')
  })

  test('binds batchPolicy into the authorization digest', () => {
    const low = createRealModelAuthorizationRequest(lowFields)
    expect(low.requestDigest).not.toBe(createRealModelAuthorizationRequest(fields).requestDigest)
  })

  test('is canonical across object key order and preserves array order', () => {
    const request = createRealModelAuthorizationRequest(fields)
    const reversed = createRealModelAuthorizationRequest(Object.fromEntries(
      Object.entries(fields).reverse(),
    ) as typeof fields)

    expect(reversed.requestDigest).toBe(request.requestDigest)
  })

  test.each([
    ['artifactSha256', 'f'.repeat(64)],
    ['promptVersion', 'changed'],
    ['promptSha256', '1'.repeat(64)],
    ['schemaVersion', 2],
    ['schemaSha256', '2'.repeat(64)],
    ['fixtureSha256', '3'.repeat(64)],
    ['modelSelection', { provider: 'other', model: 'other', reasoningEffort: 'low' }],
  ])('binds %s into the digest', (key, value) => {
    const baseline = createRealModelAuthorizationRequest(fields)
    const changed = createRealModelAuthorizationRequest({ ...fields, [key]: value })
    expect(changed.requestDigest).not.toBe(baseline.requestDigest)
  })

  test.each([
    ['version', 1],
    ['purpose', 'another-purpose'],
  ])('rejects a changed fixed field %s', (key, value) => {
    const request = createRealModelAuthorizationRequest(fields)
    expect(() => verifyRealModelAuthorizationRequest({ ...request, [key]: value }))
      .toThrow('REAL_MODEL_AUTHORIZATION_REQUEST_INVALID')
  })

  test('rejects a stale Phase 1A request and caller-provided larger budgets', () => {
    expect(() => verifyRealModelAuthorizationRequest({
      version: 1,
      purpose: 'phase1a-public-seam-spike',
      requestDigest: '0'.repeat(64),
    })).toThrow('REAL_MODEL_AUTHORIZATION_REQUEST_INVALID')
    expect(() => createRealModelAuthorizationRequest({ ...fields, maxCalls: 22 as 21 }))
      .toThrow('REAL_MODEL_BATCH_POLICY_MISMATCH')
    expect(() => createRealModelAuthorizationRequest({ ...fields, maxRuns: 19 as 20 }))
      .toThrow('REAL_MODEL_BATCH_POLICY_MISMATCH')
  })

  test('rejects endpoints, credentials, unknown fields, and a stale digest', () => {
    const request = createRealModelAuthorizationRequest(fields)
    for (const extra of ['apiKey', 'endpoint', 'baseUrl', 'token']) {
      expect(() => verifyRealModelAuthorizationRequest({ ...request, [extra]: 'forbidden' }))
        .toThrow('REAL_MODEL_AUTHORIZATION_REQUEST_INVALID')
    }
    expect(() => verifyRealModelAuthorizationRequest({ ...request, requestDigest: '0'.repeat(64) }))
      .toThrow('REAL_MODEL_AUTHORIZATION_DIGEST_MISMATCH')
  })

  test('accepts only an exact digest-bound explicit grant', () => {
    const request = createRealModelAuthorizationRequest(fields)
    expect(verifyRealModelGrant(grantFor(request), request)).toEqual(grantFor(request))

    expect(() => verifyRealModelGrant({
      ...grantFor(request),
      modelSelection: { ...request.modelSelection, reasoningEffort: 'low' },
    }, request)).toThrow('REAL_MODEL_AUTHORIZATION_GRANT_MISMATCH')
    expect(() => verifyRealModelGrant({ ...grantFor(request), authorizedMaxCalls: 22 as 21 }, request))
      .toThrow('REAL_MODEL_AUTHORIZATION_GRANT_INVALID')
    expect(() => verifyRealModelGrant({ ...grantFor(request), authorizedRuns: 19 as 20 }, request))
      .toThrow('REAL_MODEL_AUTHORIZATION_GRANT_INVALID')
    expect(() => verifyRealModelGrant({ ...grantFor(request), authorizationSource: 'old-grant' as never }, request))
      .toThrow('REAL_MODEL_AUTHORIZATION_GRANT_INVALID')
  })

  test('writes one explicit grant and refuses to overwrite it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nobei-phase1e-grant-'))
    const outputPath = join(directory, 'grant.json')
    const request = createRealModelAuthorizationRequest(fields)
    await expect(writeRealModelAuthorizationGrant({
      outputPath,
      request,
      explicitAuthorizationDigest: undefined,
    })).rejects.toThrow('EXPLICIT_USER_AUTHORIZATION_REQUIRED')

    const grant = await writeRealModelAuthorizationGrant({
      outputPath,
      request,
      explicitAuthorizationDigest: request.requestDigest,
      authorizedAt: '2026-08-30T00:00:00.000Z',
    })
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(grant)
    await expect(writeRealModelAuthorizationGrant({
      outputPath,
      request,
      explicitAuthorizationDigest: request.requestDigest,
    })).rejects.toMatchObject({ code: 'EEXIST' })
  })

  test('writes continuation only from a separate explicit confirmation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nobei-phase1e-continuation-'))
    const outputPath = join(directory, 'continuation.json')
    const request = createRealModelAuthorizationRequest(fields)
    await expect(writeRealModelContinuationGrant({
      outputPath,
      request,
      explicitContinuationDigest: undefined,
    })).rejects.toThrow('EXPLICIT_USER_CONTINUATION_REQUIRED')
    await expect(writeRealModelContinuationGrant({
      outputPath,
      request,
      explicitContinuationDigest: request.requestDigest,
      authorizedAt: '2026-08-30T00:00:00.000Z',
    })).resolves.toMatchObject({
      requestDigest: request.requestDigest,
      authorizationSource: 'explicit-user-continuation-confirmation-in-active-codex-task',
    })
  })
})

describe('Phase 1E persistent real-model budget', () => {
  test('authorizes the diagnostic once and rejects a fifth provider call', () => {
    const request = createRealModelAuthorizationRequest(lowFields)
    let budget = advanceRealModelBudget(createRealModelBudget(request), { type: 'await-authorization' })
    budget = advanceRealModelBudget(budget, { type: 'authorize-batch' })
    for (let index = 1; index <= 4; index += 1) {
      budget = advanceRealModelBudget(budget, {
        type: 'reserve-call', runId: `run-${index}`, retry: index === 4,
      })
    }
    expect(() => advanceRealModelBudget(budget, { type: 'reserve-call', runId: 'run-5' }))
      .toThrow('REAL_MODEL_CALL_BUDGET_EXHAUSTED')
    expect(budget).toMatchObject({
      batchPolicy: 'flash-low-stability', actualCalls: 4, retryUsed: true,
    })
  })

  test('allows only the documented state progression', () => {
    let value = advanceRealModelBudget(manifest(), { type: 'await-authorization' })
    expect(value.state).toBe('AWAITING_AUTHORIZATION')
    value = advanceRealModelBudget(value, { type: 'authorize-first-run' })
    expect(value.state).toBe('FIRST_RUN_AUTHORIZED')
    value = advanceRealModelBudget(value, { type: 'reserve-call', runId: 'run-1' })
    expect(value).toMatchObject({ actualCalls: 1, actualRuns: 0 })
    value = advanceRealModelBudget(value, { type: 'complete-run', runId: 'run-1' })
    expect(value).toMatchObject({ actualCalls: 1, actualRuns: 1, completedRunIds: ['run-1'] })
    value = advanceRealModelBudget(value, { type: 'first-run-review' })
    expect(value.state).toBe('FIRST_RUN_REVIEW')
    value = advanceRealModelBudget(value, { type: 'authorize-remaining' })
    expect(value.state).toBe('REMAINING_RUNS_AUTHORIZED')
    value = advanceRealModelBudget(value, { type: 'complete' })
    expect(value.state).toBe('COMPLETE')
  })

  test('rejects calls after 21, runs after 20, duplicate runs, and budget reset attempts', () => {
    const active = {
      ...manifest('REMAINING_RUNS_AUTHORIZED'),
      actualCalls: 21,
      actualRuns: 20,
      completedRunIds: Array.from({ length: 20 }, (_, index) => `run-${index + 1}`),
    }
    expect(() => advanceRealModelBudget(active, { type: 'reserve-call', runId: 'run-21' }))
      .toThrow('REAL_MODEL_CALL_BUDGET_EXHAUSTED')
    expect(() => advanceRealModelBudget(active, { type: 'complete-run', runId: 'run-21' }))
      .toThrow('REAL_MODEL_RUN_BUDGET_EXHAUSTED')
    expect(() => advanceRealModelBudget(active, { type: 'complete-run', runId: 'run-1' }))
      .toThrow('REAL_MODEL_RUN_DUPLICATE')
    expect(() => advanceRealModelBudget(active, { type: 'await-authorization' }))
      .toThrow('REAL_MODEL_BUDGET_TRANSITION_INVALID')
  })

  test('permits one retry reservation but rejects a second retry', () => {
    let value = advanceRealModelBudget(manifest('REMAINING_RUNS_AUTHORIZED'), {
      type: 'reserve-call', runId: 'run-2', retry: true,
    })
    expect(value).toMatchObject({ actualCalls: 1, retryUsed: true })
    expect(() => advanceRealModelBudget(value, {
      type: 'reserve-call', runId: 'run-3', retry: true,
    })).toThrow('REAL_MODEL_RETRY_BUDGET_EXHAUSTED')
  })

  test.each(['COMPLETE', 'NO_GO', 'BLOCKED_PROVIDER_CONFIG'] as const)(
    'allows an active state to stop at %s',
    (state) => {
      expect(advanceRealModelBudget(manifest('FIRST_RUN_AUTHORIZED'), {
        type: state === 'COMPLETE' ? 'complete' : state === 'NO_GO' ? 'no-go' : 'blocked-provider-config',
      }).state).toBe(state)
    },
  )
})
