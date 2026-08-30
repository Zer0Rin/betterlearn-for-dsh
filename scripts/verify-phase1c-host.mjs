import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROUTES = ['imports', 'run', 'events', 'retry', 'candidates', 'review', 'knowledge-points']
const NON_READY = ['STARTING', 'RESTARTING', 'DEGRADED', 'DISPOSING', 'DISPOSED']
const EVENT_KINDS = new Set(['protocol', 'transport', 'tool', 'generation', 'benchmark', 'provider', 'process', 'filesystem', 'network', 'http'])

async function regularText(root, name) {
  const path = resolve(root, name)
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('EVIDENCE_FILE_INVALID')
  return readFile(path, 'utf8')
}

function one(events, predicate) {
  const matches = events.filter(predicate)
  return matches.length === 1 ? matches[0] : undefined
}

function testsPass(value) {
  if (value?.success !== true || !Array.isArray(value.testResults)) return false
  const assertions = value.testResults.flatMap((suite) => Array.isArray(suite?.assertionResults) ? suite.assertionResults : [])
  const passedNames = assertions.filter((test) => test?.status === 'passed').map((test) => test.fullName)
  return passedNames.some((name) => /Phase 1B.*observation-backed/i.test(name))
    && passedNames.some((name) => /review transition.*transition_run/i.test(name))
    && passedNames.includes('GenerationCoordinator closes a stuck generation exactly at the 120000 ms boundary')
    && passedNames.some((name) => /CoreSupervisor dispose closes admission then terminates and waits exactly once/i.test(name))
}

function routeCoverage(events, scenario, states, expectedStatus) {
  return ROUTES.every((route) => states.every((state) => {
    const rows = events.filter((event) => event.kind === 'http' && event.scenario === scenario && event.route === route && event.state === state)
    return rows.length === 1
      && rows[0].status === expectedStatus(route)
      && (state === 'READY' || rows[0].errorCode === 'CORE_UNAVAILABLE')
  }))
}

function providerSelection(events) {
  const selection = one(events, (event) => event.kind === 'provider' && event.source === 'selection')
  const boundary = events.filter((event) => event.kind === 'provider' && event.source === 'boundary').sort((a, b) => a.sequence - b.sequence)
  const fake = events.filter((event) => event.kind === 'provider' && event.source === 'fake').sort((a, b) => a.sequence - b.sequence)
  let matched = Boolean(
    selection
    && selection.realAdapterRegistrationCount === 0
    && Array.isArray(selection.ambientRoutingVariables)
    && selection.ambientRoutingVariables.length === 0
    && typeof selection.fakeNonce === 'string'
    && selection.fakeNonce.length >= 32
    && /^[a-f0-9]{64}$/.test(selection.fakePackageSha256 ?? '')
    && boundary.length > 0
    && boundary.length === fake.length,
  )
  if (matched) {
    matched = boundary.every((row, index) => {
      const other = fake[index]
      return row.sequence === index + 1
        && other.sequence === index + 1
        && row.nonce === selection.fakeNonce
        && other.nonce === selection.fakeNonce
        && row.requestDigest === other.requestDigest
        && row.result === other.result
        && /^[a-f0-9]{64}$/.test(row.requestDigest ?? '')
    })
  }
  return {
    blocking: true,
    passed: matched,
    realAdapterRegistrationCount: selection?.realAdapterRegistrationCount,
    ambientProviderRoutingVariablesPresent: selection?.ambientRoutingVariables ?? [],
    matchedCalls: matched ? boundary.length : 0,
  }
}

function networkDiagnostic(events) {
  const rows = events.filter((event) => event.kind === 'network')
  const observed = ['local', 'dns', 'direct-ip'].every((canary) => rows.some((row) => row.canary === canary))
  return {
    blocking: false,
    status: observed ? 'observed' : 'not_observed',
    limitation: 'Explicit loopback proxy forwarding is outside this diagnostic claim.',
  }
}

function derive(events, testResults, secretScan) {
  const v3 = one(events, (event) => event.kind === 'protocol' && event.scenario === 'v3')
  const old = one(events, (event) => event.kind === 'protocol' && event.scenario === 'old-v2')
  const protocol = Boolean(
    v3?.protocolVersion === 3 && v3?.coreVersion === 'phase1e' && v3?.ready === true
    && JSON.stringify(v3.capabilities) === JSON.stringify(['l1-text-extraction', 'atomic-generation-commands', 'model-selection-snapshot'])
    && old?.protocolVersion === 2 && old?.ready === false && old?.errorCode === 'PROTOCOL_MISMATCH',
  )
  const nonReadyRoutes = routeCoverage(events, 'non-ready-route', NON_READY, () => 503)
  const readyRoutes = routeCoverage(events, 'ready-route', ['READY'], (route) => route === 'imports' || route === 'retry' ? 202 : 200)
  const composites = ['import-composite', 'retry-composite'].every((scenario) => {
    const row = one(events, (event) => event.kind === 'generation' && event.scenario === scenario)
    return row && JSON.stringify(row.states) === JSON.stringify(['generating', 'validating', 'review_pending']) && row.providerCalls === 1
  })
  const uncertain = one(events, (event) => event.kind === 'generation' && event.scenario === 'uncertain-finalize')
  const uncertainPassed = Boolean(uncertain?.finalizeCalls === 1 && uncertain?.replayCalls === 0 && uncertain?.coreRestarted === true && uncertain?.recovered === true)
  const benchmarks = ['evidence-max-shape', 'submit-generation-max-shape'].every((name) => {
    const row = one(events, (event) => event.kind === 'benchmark' && event.name === name)
    return row && Array.isArray(row.samplesMs) && row.samplesMs.length > 0
      && row.samplesMs.every((sample) => typeof sample === 'number' && sample >= 0 && sample <= row.limitMs)
      && row.limitMs === (name === 'evidence-max-shape' ? 500 : 2000)
  })
  const provider = providerSelection(events)
  const transports = ['workflow-worker-thread', 'subagent-spawn-in-process', 'core-stdio'].every((component) => (
    one(events, (event) => event.kind === 'transport' && event.component === component)?.status === 'ok'
  ))
  const tool = one(events, (event) => event.kind === 'tool' && event.scenario === 'code-mode-negative')
  const toolDenied = Boolean(tool?.name === 'run_code' && tool?.decision === 'denied' && tool?.runtimeCalls === 0 && tool?.bodyCalls === 0)
  const continuity = one(events, (event) => event.kind === 'process' && event.scenario === 'host-restart-continuity')
  const hostExit = one(events, (event) => event.kind === 'process' && event.scenario === 'host-exit')
  const filesystem = one(events, (event) => event.kind === 'filesystem')
  const teardown = Boolean(
    hostExit?.hostExited === true
    && hostExit?.corePidGone === true && hostExit?.descendantPidsGone === true,
  )
  const isolation = Boolean(
    secretScan.length === 0 && filesystem?.formalDatabaseAccesses === 0
    && filesystem?.secretFindings === 0 && filesystem?.ownedDatabase === true,
  )
  const gates = [
    testsPass(testResults),
    protocol,
    nonReadyRoutes,
    composites,
    testsPass(testResults) && teardown,
    uncertainPassed,
    benchmarks,
    provider.passed,
    readyRoutes && transports && toolDenied && continuity?.runRecovered === true && continuity?.providerCallsAdded === 0,
    isolation && teardown,
  ]
  return {
    status: gates.every(Boolean) ? 'PHASE1C_HOST_GO' : 'PHASE1C_HOST_NO_GO',
    gates: gates.map((passed, index) => ({ gate: index + 1, passed })),
    providerSelection: provider,
    incidentalEgressBlock: networkDiagnostic(events),
  }
}

export async function validatePhase1cEvidence(evidenceRoot, { formalDataDirectory } = {}) {
  try {
    if (typeof evidenceRoot !== 'string' || !isAbsolute(evidenceRoot)) throw new Error('EVIDENCE_ROOT_INVALID')
    const canonicalRoot = await realpath(evidenceRoot)
    if (formalDataDirectory) {
      const canonicalFormal = await realpath(formalDataDirectory)
      const relation = relative(canonicalFormal, canonicalRoot)
      if (relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))) throw new Error('FORMAL_DATA_PATH_FORBIDDEN')
    }
    const [eventText, testText, secretScan] = await Promise.all([
      regularText(canonicalRoot, 'acceptance-events.ndjson'),
      regularText(canonicalRoot, 'test-results.json'),
      regularText(canonicalRoot, 'secret-scan.txt'),
    ])
    const events = eventText.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    if (events.length === 0 || events.some((event) => !event || typeof event !== 'object' || !EVENT_KINDS.has(event.kind))) {
      throw new Error('EVENT_STREAM_INVALID')
    }
    return derive(events, JSON.parse(testText), secretScan)
  } catch {
    return {
      status: 'PHASE1C_HOST_NO_GO',
      gates: Array.from({ length: 10 }, (_, index) => ({ gate: index + 1, passed: false })),
      providerSelection: { blocking: true, passed: false, matchedCalls: 0 },
      incidentalEgressBlock: { blocking: false, status: 'not_observed', limitation: 'Explicit loopback proxy forwarding is outside this diagnostic claim.' },
    }
  }
}

async function main(argv) {
  const root = argv.length === 2 && argv[0] === '--evidence-root' ? argv[1] : undefined
  const result = await validatePhase1cEvidence(root)
  process.stdout.write(`${result.status}\n`)
  if (result.status !== 'PHASE1C_HOST_GO') process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2))
}
