import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { validatePhase1cEvidence } from '../scripts/verify-phase1c-host.mjs'

const routes = ['imports', 'run', 'events', 'retry', 'candidates', 'review', 'knowledge-points']
const nonReady = ['STARTING', 'RESTARTING', 'DEGRADED', 'DISPOSING', 'DISPOSED']
const digest = (value: string) => value.repeat(64).slice(0, 64)

function completeEvents() {
  const events: any[] = [
    { kind: 'protocol', scenario: 'v3', protocolVersion: 3, coreVersion: 'phase1e', capabilities: ['l1-text-extraction', 'atomic-generation-commands', 'model-selection-snapshot'], ready: true },
    { kind: 'protocol', scenario: 'old-v2', protocolVersion: 2, ready: false, errorCode: 'PROTOCOL_MISMATCH' },
    { kind: 'transport', component: 'workflow-worker-thread', status: 'ok' },
    { kind: 'transport', component: 'subagent-spawn-in-process', status: 'ok' },
    { kind: 'transport', component: 'core-stdio', status: 'ok' },
    { kind: 'tool', scenario: 'code-mode-negative', name: 'run_code', decision: 'denied', runtimeCalls: 0, bodyCalls: 0 },
    { kind: 'generation', scenario: 'import-composite', states: ['generating', 'validating', 'review_pending'], providerCalls: 1 },
    { kind: 'generation', scenario: 'retry-composite', states: ['generating', 'validating', 'review_pending'], providerCalls: 1 },
    { kind: 'generation', scenario: 'uncertain-finalize', finalizeCalls: 1, replayCalls: 0, coreRestarted: true, recovered: true },
    { kind: 'benchmark', name: 'evidence-max-shape', samplesMs: [4.2, 4.5], limitMs: 500 },
    { kind: 'benchmark', name: 'submit-generation-max-shape', samplesMs: [1200, 1300], limitMs: 2000 },
    { kind: 'provider', source: 'selection', realAdapterRegistrationCount: 0, ambientRoutingVariables: [], fakeNonce: 'n'.repeat(32), fakePackageSha256: digest('a') },
    { kind: 'provider', source: 'boundary', sequence: 1, nonce: 'n'.repeat(32), requestDigest: digest('b'), result: 'structured' },
    { kind: 'provider', source: 'fake', sequence: 1, nonce: 'n'.repeat(32), requestDigest: digest('b'), result: 'structured' },
    { kind: 'process', scenario: 'host-restart-continuity', runRecovered: true, providerCallsAdded: 0 },
    { kind: 'process', scenario: 'host-exit', hostExited: true, corePidGone: true, descendantPidsGone: true },
    { kind: 'filesystem', formalDatabaseAccesses: 0, secretFindings: 0, ownedDatabase: true },
    { kind: 'network', canary: 'local', phase: 'connect', outcome: 'allowed' },
    { kind: 'network', canary: 'dns', phase: 'resolver', outcome: 'blocked' },
    { kind: 'network', canary: 'direct-ip', phase: 'connect', outcome: 'blocked' },
  ]
  for (const route of routes) {
    events.push({ kind: 'http', scenario: 'ready-route', route, state: 'READY', status: route === 'imports' || route === 'retry' ? 202 : 200 })
    for (const state of nonReady) {
      events.push({ kind: 'http', scenario: 'non-ready-route', route, state, status: 503, errorCode: 'CORE_UNAVAILABLE' })
    }
  }
  return events
}

async function fixture(events = completeEvents()) {
  const root = await mkdtemp(join(tmpdir(), 'nobei-phase1c-verifier-'))
  const tests = {
    success: true,
    testResults: [{
      name: '/owned/test/generation-coordinator.test.ts',
      status: 'passed',
      assertionResults: [
        'Phase 1B evidence verifier observation-backed gates',
        'review transition path uses transition_run',
        'GenerationCoordinator closes a stuck generation exactly at the 120000 ms boundary',
        'CoreSupervisor dispose closes admission then terminates and waits exactly once',
      ].map((fullName) => ({ fullName, status: 'passed', failureMessages: [] })),
    }],
  }
  await Promise.all([
    writeFile(join(root, 'acceptance-events.ndjson'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`),
    writeFile(join(root, 'test-results.json'), `${JSON.stringify(tests)}\n`),
    writeFile(join(root, 'secret-scan.txt'), ''),
    writeFile(join(root, 'final-result.json'), '{"routes":7,"status":"summary-is-not-authority"}\n'),
  ])
  return root
}

describe('Phase 1C host evidence verifier', () => {
  test('accepts a complete raw event stream and independently derives ten gates', async () => {
    const result = await validatePhase1cEvidence(await fixture())
    expect(result.status).toBe('PHASE1C_HOST_GO')
    expect(result.gates).toHaveLength(10)
    expect(result.providerSelection).toEqual(expect.objectContaining({ blocking: true, matchedCalls: 1 }))
    expect(result.incidentalEgressBlock).toEqual(expect.objectContaining({ blocking: false, status: 'observed' }))
  })

  test.each([
    ['old protocol', (events: any[]) => events.filter((event) => !(event.kind === 'protocol' && event.scenario === 'old-v2'))],
    ['one route matrix row', (events: any[]) => events.filter((event) => !(event.kind === 'http' && event.route === 'events' && event.state === 'RESTARTING'))],
    ['awaiting state', (events: any[]) => events.map((event) => event.scenario === 'import-composite' ? { ...event, states: ['awaiting_generation', ...event.states] } : event)],
    ['double finalize', (events: any[]) => events.map((event) => event.scenario === 'uncertain-finalize' ? { ...event, finalizeCalls: 2 } : event)],
    ['write replay', (events: any[]) => events.map((event) => event.scenario === 'uncertain-finalize' ? { ...event, replayCalls: 1 } : event)],
    ['slow submit', (events: any[]) => events.map((event) => event.name === 'submit-generation-max-shape' ? { ...event, samplesMs: [2001] } : event)],
    ['run_code denial', (events: any[]) => events.filter((event) => event.kind !== 'tool')],
    ['transport preflight', (events: any[]) => events.filter((event) => event.component !== 'subagent-spawn-in-process')],
    ['real adapter registration', (events: any[]) => events.map((event) => event.source === 'selection' ? { ...event, realAdapterRegistrationCount: 1 } : event)],
    ['ambient routing variable', (events: any[]) => events.map((event) => event.source === 'selection' ? { ...event, ambientRoutingVariables: ['HTTPS_PROXY'] } : event)],
    ['fake nonce', (events: any[]) => events.map((event) => event.source === 'fake' ? { ...event, nonce: 'x'.repeat(32) } : event)],
    ['ledger digest', (events: any[]) => events.map((event) => event.source === 'fake' ? { ...event, requestDigest: digest('x') } : event)],
    ['host exit', (events: any[]) => events.map((event) => event.scenario === 'host-exit' ? { ...event, hostExited: false } : event)],
    ['PID gone', (events: any[]) => events.map((event) => event.scenario === 'host-exit' ? { ...event, corePidGone: false } : event)],
    ['secret finding', (events: any[]) => events.map((event) => event.kind === 'filesystem' ? { ...event, secretFindings: 1 } : event)],
    ['formal path access', (events: any[]) => events.map((event) => event.kind === 'filesystem' ? { ...event, formalDatabaseAccesses: 1 } : event)],
  ])('rejects mutation: %s', async (_name, mutate) => {
    const result = await validatePhase1cEvidence(await fixture(mutate(completeEvents())))
    expect(result.status).toBe('PHASE1C_HOST_NO_GO')
  })

  test('network diagnostics are explicitly non-blocking and missing canaries become a warning', async () => {
    const events = completeEvents().filter((event) => event.kind !== 'network')
    const result = await validatePhase1cEvidence(await fixture(events))
    expect(result.status).toBe('PHASE1C_HOST_GO')
    expect(result.incidentalEgressBlock).toEqual(expect.objectContaining({
      blocking: false, status: 'not_observed', limitation: expect.stringContaining('loopback proxy'),
    }))
  })
})
