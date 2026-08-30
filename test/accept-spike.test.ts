import { describe, expect, test } from 'vitest'
import {
  buildAcceptancePlan,
  computeAuthorizationRequestDigest,
  summarizeProviderFailure,
  validateExecutePreconditions,
} from '../scripts/accept-spike.mjs'

const requestFields = {
  version: 1,
  artifactSha256: 'a'.repeat(64),
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  maxCalls: 3,
  promptSha256: 'b'.repeat(64),
  schemaSha256: 'c'.repeat(64),
  purpose: 'phase1a-public-seam-spike',
}
const request = { ...requestFields, requestDigest: computeAuthorizationRequestDigest(requestFields) }

const manifest = {
  artifactSha256: request.artifactSha256,
  promptSha256: request.promptSha256,
  schemaSha256: request.schemaSha256,
  subprocess: { status: 'PASS' },
  decision: 'SPIKE_BLOCKED_USER_AUTHORIZATION',
  modelCalls: {
    spike: { authorizedMax: 3, actual: 0 },
    gate5: { authorizedMax: 0, actual: 0 },
    totalActual: 0,
    futureCombinedCeilingNotAuthorized: 24,
  },
}

const grant = {
  version: 1,
  requestDigest: request.requestDigest,
  authorizedProvider: request.provider,
  authorizedModel: request.model,
  authorizedMaxCalls: request.maxCalls,
  authorizedAt: '2026-08-26T04:00:00.000Z',
  authorizationSource: 'explicit-user-confirmation-in-active-codex-task',
}

describe('two-stage acceptance command plan', () => {
  test('prepare installs exact rc7 topology from the preserved tarball and runs only subprocess', () => {
    const plan = buildAcceptancePlan({
      mode: 'prepare',
      packageRoot: '/checkout/dsh-phase1',
      evidenceRoot: '/evidence/run',
      runtimeRoot: '/tmp/runtime',
      dshHome: '/tmp/dsh-home',
      userHome: '/tmp/user-home',
      preservedTarball: '/evidence/run/artifacts/nobei-dsh-phase1-0.0.0.tgz',
      credentialPresent: false,
    })
    expect(plan.steps.filter((step) => step.kind === 'pack')).toHaveLength(1)
    expect(plan.profileDependencies.every((dependency) => dependency.endsWith('@0.1.0-rc.7'))).toBe(true)
    expect(plan.bundleInstallSource).toBe('/evidence/run/artifacts/nobei-dsh-phase1-0.0.0.tgz')
    expect(plan.bootArgv).toEqual(['/tmp/runtime/node_modules/.bin/dsh', '--profile', 'nobei', '--port', '0'])
    expect(plan.headlessContract).toEqual({
      dshVersion: '0.1.0-rc.7',
      unsupportedArguments: [],
      forbiddenProcessPatterns: ['open', 'safari', 'google chrome', 'chromium', 'firefox', 'xdg-open'],
    })
    expect(plan.endpoints).toEqual(['/nobei-spike/v1/health', '/nobei-spike/v1/subprocess'])
    expect(plan.envNames).not.toContain('DEEPSEEK_API_KEY')
    expect(plan.expectedDecision).toBe('SPIKE_BLOCKED_USER_AUTHORIZATION')
    expect(plan.initialModelCalls).toEqual({
      spike: { authorizedMax: 3, actual: 0 },
      gate5: { authorizedMax: 0, actual: 0 },
      totalActual: 0,
      futureCombinedCeilingNotAuthorized: 24,
    })
  })

  test('execute adds the credential only to the DSH process and runs provider once', () => {
    const plan = buildAcceptancePlan({
      mode: 'execute',
      packageRoot: '/checkout/dsh-phase1',
      evidenceRoot: '/evidence/run',
      runtimeRoot: '/tmp/runtime',
      dshHome: '/tmp/dsh-home',
      userHome: '/tmp/user-home',
      preservedTarball: '/evidence/run/artifacts/nobei-dsh-phase1-0.0.0.tgz',
      credentialPresent: true,
    })
    expect(plan.endpoints).toEqual(['/nobei-spike/v1/health', '/nobei-spike/v1/provider'])
    expect(plan.envNames).toContain('DEEPSEEK_API_KEY')
  })

  test('accepts only a sanitized bounded provider failure payload', () => {
    expect(summarizeProviderFailure({
      http: { status: 500, byteLength: 64, bodySha256: 'd'.repeat(64) },
      payload: { ok: false, error: { code: 'PROBE_FAILED', actualCalls: 1, failureStage: 'OUTCOME_VALIDATION' } },
    })).toEqual({
      http: { status: 500, byteLength: 64, bodySha256: 'd'.repeat(64) },
      error: { code: 'PROBE_FAILED', actualCalls: 1, failureStage: 'OUTCOME_VALIDATION' },
    })
    expect(() => summarizeProviderFailure({
      http: { status: 500, byteLength: 64, bodySha256: 'd'.repeat(64) },
      payload: { ok: false, error: { code: 'PROBE_FAILED', actualCalls: 4, failureStage: 'OUTCOME_VALIDATION' } },
    })).toThrow('PROVIDER_FAILURE_PAYLOAD_INVALID')
  })

  test('keeps a response-shape diagnostic when a provider failure payload is invalid', () => {
    const error = (() => {
      try {
        summarizeProviderFailure({
          http: { status: 500, byteLength: 37, bodySha256: 'e'.repeat(64) },
          payload: { ok: false, error: { code: 'PROBE_FAILED' } },
        })
      } catch (reason) {
        return reason
      }
    })()
    expect(error).toMatchObject({
      message: 'PROVIDER_FAILURE_PAYLOAD_INVALID',
      diagnostic: {
        http: { status: 500, byteLength: 37, bodySha256: 'e'.repeat(64) },
        envelope: {
          topLevelKeys: ['error', 'ok'],
          ok: false,
          errorKeys: ['code'],
          errorCode: 'PROBE_FAILED',
        },
      },
    })
  })

  test.each([
    ['credential absent', { credentialPresent: false }, 'PROVIDER_CREDENTIAL_MISSING'],
    ['artifact mismatch', { artifactSha256: 'e'.repeat(64) }, 'ARTIFACT_DIGEST_MISMATCH'],
    ['prompt mismatch', { promptSha256: 'e'.repeat(64) }, 'PROMPT_DIGEST_MISMATCH'],
    ['Schema mismatch', { schemaSha256: 'e'.repeat(64) }, 'SCHEMA_DIGEST_MISMATCH'],
    ['subprocess not PASS', { manifest: { ...manifest, subprocess: { status: 'FAIL' } } }, 'SUBPROCESS_EVIDENCE_INVALID'],
    ['prior model call', { manifest: { ...manifest, modelCalls: { ...manifest.modelCalls, spike: { authorizedMax: 3, actual: 1 }, totalActual: 1 } } }, 'MODEL_CALL_BUDGET_NOT_FRESH'],
  ])('refuses %s before boot', (_name, override, code) => {
    expect(() => validateExecutePreconditions({
      manifest: override.manifest ?? manifest,
      request,
      grant,
      credentialPresent: override.credentialPresent ?? true,
      artifactSha256: override.artifactSha256 ?? request.artifactSha256,
      promptSha256: override.promptSha256 ?? request.promptSha256,
      schemaSha256: override.schemaSha256 ?? request.schemaSha256,
    })).toThrow(code)
  })
})
