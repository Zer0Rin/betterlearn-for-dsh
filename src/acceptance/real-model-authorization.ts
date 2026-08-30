import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { ModelSelectionSnapshot } from '../product/types.js'

const SHA256 = /^[0-9a-f]{64}$/
const AUTHORIZATION_SOURCE = 'explicit-user-confirmation-in-active-codex-task' as const

export const REAL_MODEL_BATCH_POLICIES = {
  'gate5-full': {
    purpose: 'phase1e-real-model-gate5',
    maxRuns: 20,
    maxCalls: 21,
    requiresContinuation: true,
  },
  'flash-low-stability': {
    purpose: 'phase1e-flash-low-stability',
    maxRuns: 3,
    maxCalls: 4,
    requiresContinuation: false,
    requiredSelection: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'low',
    },
  },
} as const

export type RealModelBatchPolicyId = keyof typeof REAL_MODEL_BATCH_POLICIES

export function policyFor(id: unknown): (typeof REAL_MODEL_BATCH_POLICIES)[RealModelBatchPolicyId] {
  if (typeof id !== 'string' || !Object.hasOwn(REAL_MODEL_BATCH_POLICIES, id)) {
    throw new Error('REAL_MODEL_BATCH_POLICY_INVALID')
  }
  return REAL_MODEL_BATCH_POLICIES[id as RealModelBatchPolicyId]
}

export interface RealModelAuthorizationRequest {
  version: 2
  purpose: 'phase1e-real-model-gate5' | 'phase1e-flash-low-stability'
  batchPolicy: RealModelBatchPolicyId
  artifactSha256: string
  promptVersion: string
  promptSha256: string
  schemaVersion: number
  schemaSha256: string
  fixtureSha256: string
  modelSelection: ModelSelectionSnapshot
  maxRuns: 3 | 20
  maxCalls: 4 | 21
  requestDigest: string
}

export interface RealModelAuthorizationGrant {
  version: 2
  batchPolicy: RealModelBatchPolicyId
  requestDigest: string
  modelSelection: ModelSelectionSnapshot
  authorizedRuns: 3 | 20
  authorizedMaxCalls: 4 | 21
  authorizedAt: string
  authorizationSource: typeof AUTHORIZATION_SOURCE
}

export interface RealModelContinuationGrant {
  version: 1
  requestDigest: string
  authorizedAt: string
  authorizationSource: 'explicit-user-continuation-confirmation-in-active-codex-task'
}

export type RealModelBudgetState =
  | 'PREPARED'
  | 'AWAITING_AUTHORIZATION'
  | 'FIRST_RUN_AUTHORIZED'
  | 'FIRST_RUN_REVIEW'
  | 'REMAINING_RUNS_AUTHORIZED'
  | 'BATCH_AUTHORIZED'
  | 'COMPLETE'
  | 'NO_GO'
  | 'BLOCKED_PROVIDER_CONFIG'

export interface RealModelBudgetManifest {
  version: 2
  batchPolicy: RealModelBatchPolicyId
  requestDigest: string
  authorizedRuns: 3 | 20
  authorizedMaxCalls: 4 | 21
  actualRuns: number
  actualCalls: number
  completedRunIds: string[]
  retryUsed: boolean
  state: RealModelBudgetState
}

export type RealModelBudgetEvent =
  | { type: 'await-authorization' }
  | { type: 'authorize-first-run' }
  | { type: 'reserve-call', runId: string, retry?: boolean }
  | { type: 'complete-run', runId: string }
  | { type: 'first-run-review' }
  | { type: 'authorize-remaining' }
  | { type: 'authorize-batch' }
  | { type: 'complete' }
  | { type: 'no-go' }
  | { type: 'blocked-provider-config' }

type RequestFields = Omit<RealModelAuthorizationRequest, 'requestDigest'>

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).toSorted().join('\0') === [...expected].toSorted().join('\0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isSelection(value: unknown): value is ModelSelectionSnapshot {
  if (!isRecord(value)) return false
  const keys = value.reasoningEffort === undefined
    ? ['provider', 'model']
    : ['provider', 'model', 'reasoningEffort']
  return exactKeys(value, keys)
    && isNonEmptyString(value.provider)
    && isNonEmptyString(value.model)
    && (value.reasoningEffort === undefined || isNonEmptyString(value.reasoningEffort))
}

function sameSelection(left: ModelSelectionSnapshot, right: ModelSelectionSnapshot): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).toSorted()
    .map(key => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(',')}}`
}

function digestRequest(fields: RequestFields): string {
  return createHash('sha256').update(canonicalize(fields), 'utf8').digest('hex')
}

function validateRequestFields(value: unknown): asserts value is RequestFields {
  if (!isRecord(value)
    || !exactKeys(value, [
      'version', 'purpose', 'batchPolicy', 'artifactSha256', 'promptVersion', 'promptSha256',
      'schemaVersion', 'schemaSha256', 'fixtureSha256', 'modelSelection', 'maxRuns', 'maxCalls',
    ])
    || value.version !== 2
    || !['phase1e-real-model-gate5', 'phase1e-flash-low-stability'].includes(String(value.purpose))
    || !Object.hasOwn(REAL_MODEL_BATCH_POLICIES, String(value.batchPolicy))
    || !SHA256.test(String(value.artifactSha256 ?? ''))
    || !isNonEmptyString(value.promptVersion)
    || !SHA256.test(String(value.promptSha256 ?? ''))
    || !Number.isSafeInteger(value.schemaVersion) || Number(value.schemaVersion) < 1
    || !SHA256.test(String(value.schemaSha256 ?? ''))
    || !SHA256.test(String(value.fixtureSha256 ?? ''))
    || !isSelection(value.modelSelection)) {
    throw new Error('REAL_MODEL_AUTHORIZATION_REQUEST_INVALID')
  }
  const policy = policyFor(value.batchPolicy)
  if (value.purpose !== policy.purpose
    || value.maxRuns !== policy.maxRuns
    || value.maxCalls !== policy.maxCalls) {
    throw new Error('REAL_MODEL_BATCH_POLICY_MISMATCH')
  }
  if ('requiredSelection' in policy && !sameSelection(value.modelSelection, policy.requiredSelection)) {
    throw new Error('REAL_MODEL_DIAGNOSTIC_SELECTION_MISMATCH')
  }
}

export function createRealModelAuthorizationRequest(value: RequestFields): RealModelAuthorizationRequest {
  validateRequestFields(value)
  const fields: RequestFields = structuredClone(value)
  return { ...fields, requestDigest: digestRequest(fields) }
}

export function verifyRealModelAuthorizationRequest(value: unknown): RealModelAuthorizationRequest {
  if (!isRecord(value) || !exactKeys(value, [
    'version', 'purpose', 'batchPolicy', 'artifactSha256', 'promptVersion', 'promptSha256',
    'schemaVersion', 'schemaSha256', 'fixtureSha256', 'modelSelection', 'maxRuns', 'maxCalls',
    'requestDigest',
  ])) throw new Error('REAL_MODEL_AUTHORIZATION_REQUEST_INVALID')
  const { requestDigest, ...fields } = value
  validateRequestFields(fields)
  if (!SHA256.test(String(requestDigest ?? '')) || requestDigest !== digestRequest(fields)) {
    throw new Error('REAL_MODEL_AUTHORIZATION_DIGEST_MISMATCH')
  }
  return structuredClone(value) as unknown as RealModelAuthorizationRequest
}

export function verifyRealModelGrant(
  value: unknown,
  requestValue: unknown,
): RealModelAuthorizationGrant {
  const request = verifyRealModelAuthorizationRequest(requestValue)
  if (!isRecord(value) || !exactKeys(value, [
    'version', 'batchPolicy', 'requestDigest', 'modelSelection', 'authorizedRuns', 'authorizedMaxCalls',
    'authorizedAt', 'authorizationSource',
  ])
    || value.version !== 2
    || value.batchPolicy !== request.batchPolicy
    || !SHA256.test(String(value.requestDigest ?? ''))
    || !isSelection(value.modelSelection)
    || value.authorizedRuns !== request.maxRuns
    || value.authorizedMaxCalls !== request.maxCalls
    || !isNonEmptyString(value.authorizedAt)
    || Number.isNaN(Date.parse(value.authorizedAt))
    || value.authorizationSource !== AUTHORIZATION_SOURCE) {
    throw new Error('REAL_MODEL_AUTHORIZATION_GRANT_INVALID')
  }
  if (value.requestDigest !== request.requestDigest
    || !sameSelection(value.modelSelection, request.modelSelection)) {
    throw new Error('REAL_MODEL_AUTHORIZATION_GRANT_MISMATCH')
  }
  return structuredClone(value) as unknown as RealModelAuthorizationGrant
}

export async function writeRealModelAuthorizationGrant(options: {
  outputPath: string
  request: unknown
  explicitAuthorizationDigest: string | undefined
  authorizedAt?: string
}): Promise<RealModelAuthorizationGrant> {
  const request = verifyRealModelAuthorizationRequest(options.request)
  if (options.explicitAuthorizationDigest !== request.requestDigest) {
    throw new Error('EXPLICIT_USER_AUTHORIZATION_REQUIRED')
  }
  const grant = verifyRealModelGrant({
    version: 2,
    batchPolicy: request.batchPolicy,
    requestDigest: request.requestDigest,
    modelSelection: request.modelSelection,
    authorizedRuns: request.maxRuns,
    authorizedMaxCalls: request.maxCalls,
    authorizedAt: options.authorizedAt ?? new Date().toISOString(),
    authorizationSource: AUTHORIZATION_SOURCE,
  }, request)
  await writeFile(options.outputPath, `${JSON.stringify(grant, null, 2)}\n`, { flag: 'wx' })
  return grant
}

export async function writeRealModelContinuationGrant(options: {
  outputPath: string
  request: unknown
  explicitContinuationDigest: string | undefined
  authorizedAt?: string
}): Promise<RealModelContinuationGrant> {
  const request = verifyRealModelAuthorizationRequest(options.request)
  if (options.explicitContinuationDigest !== request.requestDigest) {
    throw new Error('EXPLICIT_USER_CONTINUATION_REQUIRED')
  }
  const grant: RealModelContinuationGrant = {
    version: 1,
    requestDigest: request.requestDigest,
    authorizedAt: options.authorizedAt ?? new Date().toISOString(),
    authorizationSource: 'explicit-user-continuation-confirmation-in-active-codex-task',
  }
  await writeFile(options.outputPath, `${JSON.stringify(grant, null, 2)}\n`, { flag: 'wx' })
  return grant
}

function validateBudget(value: RealModelBudgetManifest): void {
  let policy
  try {
    policy = policyFor(value.batchPolicy)
  } catch {
    throw new Error('REAL_MODEL_BUDGET_MANIFEST_INVALID')
  }
  if (value.version !== 2
    || !SHA256.test(value.requestDigest)
    || value.authorizedRuns !== policy.maxRuns
    || value.authorizedMaxCalls !== policy.maxCalls
    || !Number.isSafeInteger(value.actualRuns) || value.actualRuns < 0 || value.actualRuns > policy.maxRuns
    || !Number.isSafeInteger(value.actualCalls) || value.actualCalls < 0 || value.actualCalls > policy.maxCalls
    || !Array.isArray(value.completedRunIds)
    || value.completedRunIds.length !== value.actualRuns
    || new Set(value.completedRunIds).size !== value.completedRunIds.length
    || value.completedRunIds.some(id => !isNonEmptyString(id))
    || typeof value.retryUsed !== 'boolean') {
    throw new Error('REAL_MODEL_BUDGET_MANIFEST_INVALID')
  }
}

export function createRealModelBudget(requestValue: unknown): RealModelBudgetManifest {
  const request = verifyRealModelAuthorizationRequest(requestValue)
  return {
    version: 2,
    batchPolicy: request.batchPolicy,
    requestDigest: request.requestDigest,
    authorizedRuns: request.maxRuns,
    authorizedMaxCalls: request.maxCalls,
    actualRuns: 0,
    actualCalls: 0,
    completedRunIds: [],
    retryUsed: false,
    state: 'PREPARED',
  }
}

function active(state: RealModelBudgetState): boolean {
  return !['COMPLETE', 'NO_GO', 'BLOCKED_PROVIDER_CONFIG'].includes(state)
}

export function advanceRealModelBudget(
  current: RealModelBudgetManifest,
  event: RealModelBudgetEvent,
): RealModelBudgetManifest {
  validateBudget(current)
  const next = structuredClone(current)
  if (event.type === 'reserve-call') {
    if (!['FIRST_RUN_AUTHORIZED', 'REMAINING_RUNS_AUTHORIZED', 'BATCH_AUTHORIZED'].includes(next.state)) {
      throw new Error('REAL_MODEL_BUDGET_TRANSITION_INVALID')
    }
    if (!isNonEmptyString(event.runId)) throw new Error('REAL_MODEL_RUN_ID_INVALID')
    if (next.actualCalls >= next.authorizedMaxCalls) throw new Error('REAL_MODEL_CALL_BUDGET_EXHAUSTED')
    if (event.retry && next.retryUsed) throw new Error('REAL_MODEL_RETRY_BUDGET_EXHAUSTED')
    next.actualCalls += 1
    if (event.retry) next.retryUsed = true
    return next
  }
  if (event.type === 'complete-run') {
    if (!['FIRST_RUN_AUTHORIZED', 'REMAINING_RUNS_AUTHORIZED', 'BATCH_AUTHORIZED'].includes(next.state)) {
      throw new Error('REAL_MODEL_BUDGET_TRANSITION_INVALID')
    }
    if (next.completedRunIds.includes(event.runId)) throw new Error('REAL_MODEL_RUN_DUPLICATE')
    if (next.actualRuns >= next.authorizedRuns) throw new Error('REAL_MODEL_RUN_BUDGET_EXHAUSTED')
    next.completedRunIds.push(event.runId)
    next.actualRuns += 1
    return next
  }
  const transitions: Record<Exclude<RealModelBudgetEvent['type'], 'reserve-call' | 'complete-run'>, RealModelBudgetState> = {
    'await-authorization': 'AWAITING_AUTHORIZATION',
    'authorize-first-run': 'FIRST_RUN_AUTHORIZED',
    'first-run-review': 'FIRST_RUN_REVIEW',
    'authorize-remaining': 'REMAINING_RUNS_AUTHORIZED',
    'authorize-batch': 'BATCH_AUTHORIZED',
    complete: 'COMPLETE',
    'no-go': 'NO_GO',
    'blocked-provider-config': 'BLOCKED_PROVIDER_CONFIG',
  }
  const allowed: Partial<Record<RealModelBudgetState, RealModelBudgetEvent['type'][]>> = {
    PREPARED: ['await-authorization'],
    AWAITING_AUTHORIZATION: next.batchPolicy === 'flash-low-stability'
      ? ['authorize-batch']
      : ['authorize-first-run'],
    FIRST_RUN_AUTHORIZED: ['first-run-review'],
    FIRST_RUN_REVIEW: ['authorize-remaining'],
  }
  const terminal = ['complete', 'no-go', 'blocked-provider-config'].includes(event.type)
  if ((!terminal && !allowed[next.state]?.includes(event.type)) || (terminal && !active(next.state))) {
    throw new Error('REAL_MODEL_BUDGET_TRANSITION_INVALID')
  }
  next.state = transitions[event.type]
  return next
}
