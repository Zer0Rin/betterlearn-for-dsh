import { describe, expect, test } from 'vitest'
import { classifySpikeResult, createAuthorizationRequest } from '../src/spike/authorization.js'

const request = createAuthorizationRequest({
  version: 1,
  artifactSha256: 'a'.repeat(64),
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  maxCalls: 3,
  promptSha256: 'b'.repeat(64),
  schemaSha256: 'c'.repeat(64),
  purpose: 'phase1a-public-seam-spike',
})

const matchingGrant = {
  version: 1 as const,
  requestDigest: request.requestDigest,
  authorizedProvider: request.provider,
  authorizedModel: request.model,
  authorizedMaxCalls: request.maxCalls,
  authorizedAt: '2026-08-26T04:00:00.000Z',
  authorizationSource: 'explicit-user-confirmation-in-active-codex-task' as const,
}

const pass = {
  status: 'PASS' as const,
  provider: 'deepseek-official' as const,
  model: 'deepseek-v4-flash' as const,
  toolsUsed: ['structured_output'],
  workflowCompleted: true,
  structuredValid: true,
}

describe('phase1a decision contract', () => {
  test('hard-stops for missing user authorization after subprocess passes', () => {
    expect(classifySpikeResult({
      subprocess: 'PASS',
      request,
      grant: null,
      calls: [],
    })).toBe('SPIKE_BLOCKED_USER_AUTHORIZATION')
  })

  test('classifies missing provider configuration separately with zero calls', () => {
    expect(classifySpikeResult({
      subprocess: 'PASS',
      request,
      grant: null,
      providerPreflight: 'MISSING_CREDENTIAL',
      calls: [],
    })).toBe('SPIKE_BLOCKED_PROVIDER_CONFIG')
  })

  test('requires exactly three fully passing calls for GO', () => {
    expect(classifySpikeResult({
      subprocess: 'PASS',
      request,
      grant: matchingGrant,
      providerPreflight: 'PASS',
      calls: [pass, pass, pass],
    })).toBe('SPIKE_GO')
  })

  test('fails closed on a fourth call', () => {
    expect(classifySpikeResult({
      subprocess: 'PASS',
      request,
      grant: matchingGrant,
      providerPreflight: 'PASS',
      calls: [pass, pass, pass, pass],
    })).toBe('SPIKE_NO_GO')
  })

  test.each([
    { subprocess: 'FAIL' as const, calls: [] },
    { subprocess: 'PASS' as const, calls: [{ ...pass, toolsUsed: [] }] },
    { subprocess: 'PASS' as const, calls: [{ ...pass, toolsUsed: ['bash'] }] },
    { subprocess: 'PASS' as const, calls: [{ ...pass, toolsUsed: ['structured_output', 'bash'] }] },
    { subprocess: 'PASS' as const, calls: [{ ...pass, structuredValid: false }] },
  ])('fails closed for seam or call invariant failures', (override) => {
    expect(classifySpikeResult({
      subprocess: override.subprocess,
      request,
      grant: matchingGrant,
      providerPreflight: 'PASS',
      calls: override.calls,
    })).toBe('SPIKE_NO_GO')
  })
})
