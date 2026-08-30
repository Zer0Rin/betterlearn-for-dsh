import { createHash } from 'node:crypto'
import {
  AUTHORIZATION_SOURCE,
  SHA256_PATTERN,
  SPIKE_MAX_CALLS,
  SPIKE_MODEL,
  SPIKE_PROVIDER,
  SPIKE_PURPOSE,
  STRUCTURED_OUTPUT_TOOL,
} from './constants.js'

export type SpikeDecision =
  | 'SPIKE_BLOCKED_USER_AUTHORIZATION'
  | 'SPIKE_BLOCKED_PROVIDER_CONFIG'
  | 'SPIKE_NO_GO'
  | 'SPIKE_GO'

export interface AuthorizationRequestFields {
  version: 1
  artifactSha256: string
  provider: typeof SPIKE_PROVIDER
  model: typeof SPIKE_MODEL
  maxCalls: typeof SPIKE_MAX_CALLS
  promptSha256: string
  schemaSha256: string
  purpose: typeof SPIKE_PURPOSE
}

export interface AuthorizationRequest extends AuthorizationRequestFields {
  requestDigest: string
}

export interface AuthorizationGrant {
  version: 1
  requestDigest: string
  authorizedProvider: typeof SPIKE_PROVIDER
  authorizedModel: typeof SPIKE_MODEL
  authorizedMaxCalls: typeof SPIKE_MAX_CALLS
  authorizedAt: string
  authorizationSource: typeof AUTHORIZATION_SOURCE
}

export interface SpikeCallResult {
  status: 'PASS' | 'FAIL'
  provider: string
  model: string
  toolsUsed: string[]
  workflowCompleted: boolean
  structuredValid: boolean
}

export interface SpikeResultInput {
  subprocess: 'PASS' | 'FAIL'
  request: AuthorizationRequest
  grant: AuthorizationGrant | Record<string, unknown> | null
  providerPreflight?: 'PASS' | 'MISSING_CREDENTIAL' | 'MISSING_PROVIDER' | 'MISSING_MODEL'
  calls: SpikeCallResult[]
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('AUTHORIZATION_VALUE_INVALID')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .filter((key) => key !== 'requestDigest')
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    return `{${entries.join(',')}}`
  }
  throw new Error('AUTHORIZATION_VALUE_INVALID')
}

export function computeAuthorizationRequestDigest(fields: object): string {
  return createHash('sha256').update(canonicalize(fields), 'utf8').digest('hex')
}

function assertRequestFields(fields: AuthorizationRequestFields): void {
  if (
    fields.version !== 1
    || fields.provider !== SPIKE_PROVIDER
    || fields.model !== SPIKE_MODEL
    || fields.maxCalls !== SPIKE_MAX_CALLS
    || fields.purpose !== SPIKE_PURPOSE
    || !SHA256_PATTERN.test(fields.artifactSha256)
    || !SHA256_PATTERN.test(fields.promptSha256)
    || !SHA256_PATTERN.test(fields.schemaSha256)
  ) {
    throw new Error('AUTHORIZATION_REQUEST_INVALID')
  }
}

export function createAuthorizationRequest(fields: AuthorizationRequestFields): AuthorizationRequest {
  assertRequestFields(fields)
  return {
    ...fields,
    requestDigest: computeAuthorizationRequestDigest(fields),
  }
}

const grantKeys = [
  'authorizationSource',
  'authorizedAt',
  'authorizedMaxCalls',
  'authorizedModel',
  'authorizedProvider',
  'requestDigest',
  'version',
]

const requestKeys = [
  'artifactSha256',
  'maxCalls',
  'model',
  'promptSha256',
  'provider',
  'purpose',
  'requestDigest',
  'schemaSha256',
  'version',
]

export function verifyAuthorizationRequest(input: unknown): AuthorizationRequest {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('AUTHORIZATION_REQUEST_INVALID')
  }
  const request = input as Record<string, unknown>
  if (Object.keys(request).sort().join('\0') !== requestKeys.join('\0')) {
    throw new Error('AUTHORIZATION_REQUEST_INVALID')
  }
  assertRequestFields(request as unknown as AuthorizationRequestFields)
  if (
    typeof request.requestDigest !== 'string'
    || !SHA256_PATTERN.test(request.requestDigest)
    || request.requestDigest !== computeAuthorizationRequestDigest(request)
  ) {
    throw new Error('AUTHORIZATION_DIGEST_MISMATCH')
  }
  return request as unknown as AuthorizationRequest
}

export function verifyGrant(input: unknown, request: AuthorizationRequest): AuthorizationGrant {
  verifyAuthorizationRequest(request)
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('AUTHORIZATION_GRANT_INVALID')
  }
  const grant = input as Record<string, unknown>
  if (Object.keys(grant).sort().join('\0') !== grantKeys.join('\0')) {
    throw new Error('AUTHORIZATION_GRANT_INVALID')
  }
  if (
    grant.version !== 1
    || typeof grant.requestDigest !== 'string'
    || !SHA256_PATTERN.test(grant.requestDigest)
    || typeof grant.authorizedProvider !== 'string'
    || typeof grant.authorizedModel !== 'string'
    || !Number.isInteger(grant.authorizedMaxCalls)
    || grant.authorizationSource !== AUTHORIZATION_SOURCE
    || typeof grant.authorizedAt !== 'string'
    || !Number.isFinite(Date.parse(grant.authorizedAt))
  ) {
    throw new Error('AUTHORIZATION_GRANT_INVALID')
  }

  const recomputedRequestDigest = computeAuthorizationRequestDigest(request)
  if (
    request.requestDigest !== recomputedRequestDigest
    || grant.requestDigest !== request.requestDigest
    || grant.authorizedProvider !== request.provider
    || grant.authorizedModel !== request.model
    || grant.authorizedMaxCalls !== request.maxCalls
  ) {
    throw new Error('AUTHORIZATION_DIGEST_MISMATCH')
  }
  return grant as unknown as AuthorizationGrant
}

export function classifySpikeResult(input: SpikeResultInput): SpikeDecision {
  if (input.subprocess !== 'PASS') return 'SPIKE_NO_GO'
  if (input.calls.length > SPIKE_MAX_CALLS) return 'SPIKE_NO_GO'

  if (input.providerPreflight && input.providerPreflight !== 'PASS') {
    return input.calls.length === 0
      ? 'SPIKE_BLOCKED_PROVIDER_CONFIG'
      : 'SPIKE_NO_GO'
  }

  if (input.grant === null) {
    return input.calls.length === 0
      ? 'SPIKE_BLOCKED_USER_AUTHORIZATION'
      : 'SPIKE_NO_GO'
  }

  try {
    verifyGrant(input.grant, input.request)
  } catch {
    return 'SPIKE_NO_GO'
  }

  if (input.providerPreflight !== 'PASS' || input.calls.length !== SPIKE_MAX_CALLS) {
    return 'SPIKE_NO_GO'
  }

  const allCallsPass = input.calls.every((call) => (
    call.status === 'PASS'
    && call.provider === SPIKE_PROVIDER
    && call.model === SPIKE_MODEL
    && call.toolsUsed.length === 1
    && call.toolsUsed[0] === STRUCTURED_OUTPUT_TOOL
    && call.workflowCompleted
    && call.structuredValid
  ))
  return allCallsPass ? 'SPIKE_GO' : 'SPIKE_NO_GO'
}
