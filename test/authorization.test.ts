import { describe, expect, test } from 'vitest'
import {
  computeAuthorizationRequestDigest,
  createAuthorizationRequest,
  verifyGrant,
  type AuthorizationGrant,
} from '../src/spike/authorization.js'

const base = {
  version: 1 as const,
  artifactSha256: 'a'.repeat(64),
  provider: 'deepseek-official' as const,
  model: 'deepseek-v4-flash' as const,
  maxCalls: 3 as const,
  promptSha256: 'b'.repeat(64),
  schemaSha256: 'c'.repeat(64),
  purpose: 'phase1a-public-seam-spike' as const,
}

describe('phase1a authorization digest', () => {
  test('is independent of object key order', () => {
    const ordered = computeAuthorizationRequestDigest(base)
    const reversed = computeAuthorizationRequestDigest(Object.fromEntries(
      Object.entries(base).reverse(),
    ))

    expect(reversed).toBe(ordered)
  })

  test.each([
    ['artifactSha256', 'd'.repeat(64)],
    ['provider', 'another-provider'],
    ['model', 'another-model'],
    ['maxCalls', 2],
    ['promptSha256', 'e'.repeat(64)],
    ['schemaSha256', 'f'.repeat(64)],
  ])('binds %s into the digest', (field, value) => {
    expect(computeAuthorizationRequestDigest({ ...base, [field]: value }))
      .not.toBe(computeAuthorizationRequestDigest(base))
  })

  test('creates and verifies an exact matching grant', () => {
    const request = createAuthorizationRequest(base)
    const grant: AuthorizationGrant = {
      version: 1,
      requestDigest: request.requestDigest,
      authorizedProvider: request.provider,
      authorizedModel: request.model,
      authorizedMaxCalls: request.maxCalls,
      authorizedAt: '2026-08-26T04:00:00.000Z',
      authorizationSource: 'explicit-user-confirmation-in-active-codex-task',
    }

    expect(verifyGrant(grant, request)).toEqual(grant)
  })

  test('rejects a grant whose authorized model was changed', () => {
    const request = createAuthorizationRequest(base)
    const tampered = {
      version: 1,
      requestDigest: request.requestDigest,
      authorizedProvider: request.provider,
      authorizedModel: 'deepseek-v3',
      authorizedMaxCalls: request.maxCalls,
      authorizedAt: '2026-08-26T04:00:00.000Z',
      authorizationSource: 'explicit-user-confirmation-in-active-codex-task',
    }

    expect(() => verifyGrant(tampered, request))
      .toThrow('AUTHORIZATION_DIGEST_MISMATCH')
  })

  test('rejects extra grant fields and stale request digests', () => {
    const request = createAuthorizationRequest(base)
    const grant = {
      version: 1,
      requestDigest: '0'.repeat(64),
      authorizedProvider: request.provider,
      authorizedModel: request.model,
      authorizedMaxCalls: request.maxCalls,
      authorizedAt: '2026-08-26T04:00:00.000Z',
      authorizationSource: 'explicit-user-confirmation-in-active-codex-task',
      providerOverride: 'forbidden',
    }

    expect(() => verifyGrant(grant, request))
      .toThrow('AUTHORIZATION_GRANT_INVALID')
  })
})
