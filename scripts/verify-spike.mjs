#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CRITICAL_PROFILE_PACKAGES } from './dsh-topology.mjs'
import { writeJsonAtomic } from './evidence.mjs'

const RC7 = '0.1.0-rc.7'
const SHA256 = /^[a-f0-9]{64}$/
const BROWSER_OPENERS = new Set(['open', 'safari', 'google chrome', 'chromium', 'firefox', 'xdg-open'])

function fail(code) {
  throw new Error(code)
}

async function readJson(path, code) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    fail(code)
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalize(value) {
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.keys(value).filter((key) => key !== 'requestDigest').toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
}

function verifyRequest(request, manifest) {
  const keys = [
    'artifactSha256', 'maxCalls', 'model', 'promptSha256', 'provider', 'purpose',
    'requestDigest', 'schemaSha256', 'version',
  ]
  if (
    request === null
    || typeof request !== 'object'
    || Object.keys(request).toSorted().join('\0') !== keys.toSorted().join('\0')
    || request.version !== 1
    || request.provider !== 'deepseek-official'
    || request.model !== 'deepseek-v4-flash'
    || request.maxCalls !== 3
    || request.purpose !== 'phase1a-public-seam-spike'
    || !SHA256.test(request.artifactSha256)
    || !SHA256.test(request.promptSha256)
    || !SHA256.test(request.schemaSha256)
    || request.requestDigest !== sha256(Buffer.from(canonicalize(request), 'utf8'))
    || manifest.artifactSha256 !== request.artifactSha256
    || manifest.promptSha256 !== request.promptSha256
    || manifest.schemaSha256 !== request.schemaSha256
  ) fail('AUTHORIZATION_REQUEST_INVALID')
}

function verifyGrant(grant, request) {
  const keys = [
    'authorizationSource', 'authorizedAt', 'authorizedMaxCalls', 'authorizedModel',
    'authorizedProvider', 'requestDigest', 'version',
  ]
  if (
    grant === null
    || typeof grant !== 'object'
    || Object.keys(grant).toSorted().join('\0') !== keys.toSorted().join('\0')
    || grant.version !== 1
    || grant.requestDigest !== request.requestDigest
    || grant.authorizedProvider !== request.provider
    || grant.authorizedModel !== request.model
    || grant.authorizedMaxCalls !== request.maxCalls
    || grant.authorizationSource !== 'explicit-user-confirmation-in-active-codex-task'
    || typeof grant.authorizedAt !== 'string'
    || !Number.isFinite(Date.parse(grant.authorizedAt))
  ) fail('AUTHORIZATION_GRANT_INVALID')
}

function verifyTopology(value) {
  if (
    value?.topology?.expectedVersion !== RC7
    || value?.topology?.criticalCount !== CRITICAL_PROFILE_PACKAGES.length
    || !Array.isArray(value?.topology?.duplicateCriticalContexts)
    || value.topology.duplicateCriticalContexts.length !== 0
  ) fail('CRITICAL_TOPOLOGY_INVALID')
  for (const name of CRITICAL_PROFILE_PACKAGES) {
    if (value?.versions?.[name] !== RC7) fail('CRITICAL_VERSION_DRIFT')
  }
  if (Object.keys(value.versions).length !== CRITICAL_PROFILE_PACKAGES.length) fail('CRITICAL_VERSION_SET_INVALID')
}

function verifySubprocess(value) {
  const result = value?.payload?.result
  const environment = result?.environmentIsolation
  if (
    value?.http?.status !== 200
    || !SHA256.test(value?.http?.bodySha256 ?? '')
    || result?.status !== 'PASS'
    || result?.executableResolved !== true
    || result?.handshake !== true
    || result?.echoRoundTrip !== true
    || environment?.providerCredentialPresent !== false
    || environment?.dshHomePresent !== false
    || environment?.dshToolsModePresent !== false
    || environment?.dshTelemetryModePresent !== false
  ) fail('SUBPROCESS_EVIDENCE_INVALID')
  if (
    result?.stderr?.readable !== true
    || result?.stderr?.lossy !== false
    || result?.stderr?.containsReadyMarker !== true
    || result?.stderr?.spillPathPresent !== false
  ) fail('SUBPROCESS_STDERR_INVALID')
  if (
    result?.normalExit?.exitCode !== 0
    || result?.normalExit?.treeExited !== true
    || result?.abnormalExit?.exitCode !== 17
    || result?.abnormalExit?.classified !== 'CORE_CRASHED'
    || result?.abnormalExit?.treeExited !== true
    || result?.dispose?.waited !== true
    || result?.dispose?.rootGone !== true
    || result?.dispose?.childGone !== true
  ) fail('SUBPROCESS_LIFECYCLE_INVALID')
}

async function verifyCommands(root) {
  let lines
  try {
    lines = (await readFile(join(root, 'commands.ndjson'), 'utf8')).split('\n').filter(Boolean)
  } catch {
    fail('COMMANDS_MISSING')
  }
  if (!lines.length) fail('COMMANDS_EMPTY')
  const commands = lines.map((line) => JSON.parse(line))
  const indices = commands.map((command) => command.index)
  if (new Set(indices).size !== indices.length || indices.some((index, position) => index !== position + 1)) {
    fail('DUPLICATE_OR_NONCONTIGUOUS_COMMANDS')
  }
  if (new Set(commands.map((command) => command.stdoutFile)).size !== commands.length) fail('DUPLICATE_COMMAND_OUTPUT')
  const boots = commands.filter((command) => command.argv?.includes('--profile') && command.argv?.includes('--port'))
  if (boots.length < 1 || boots.some((command) => {
    const argv = command.argv
    return argv.length !== 5
      || argv[1] !== '--profile'
      || argv[2] !== 'nobei'
      || argv[3] !== '--port'
      || argv[4] !== '0'
  })) fail('HEADLESS_BOOT_COMMAND_INVALID')
  for (const command of commands) {
    if (command.argv.some((argument) => BROWSER_OPENERS.has(String(argument).toLowerCase()))) {
      fail('BROWSER_OPEN_COMMAND_FORBIDDEN')
    }
    const isBoot = boots.includes(command)
    const clean = command.exitCode === 0 && command.signal === null
    const accountedBootStop = isBoot && command.exitCode === null && command.signal === 'SIGTERM'
    if (!clean && !accountedBootStop) fail('UNACCOUNTED_DSH_TERMINATION')
    for (const output of [command.stdoutFile, command.stderrFile]) {
      if (typeof output !== 'string' || output.includes('..')) fail('COMMAND_OUTPUT_PATH_INVALID')
      await readFile(join(root, output)).catch(() => fail('COMMAND_OUTPUT_MISSING'))
    }
  }
  return commands
}

const providerKeys = [
  'agentsStarted', 'candidateCount', 'evidenceCount', 'index', 'model', 'provider',
  'schemaValid', 'semanticValid', 'structuredPresent', 'structuredSha256', 'toolCount',
  'toolNames', 'workflowStopReason',
]

function verifyProviderSummary(summary, index) {
  if (
    summary === null
    || typeof summary !== 'object'
    || Object.keys(summary).toSorted().join('\0') !== providerKeys.toSorted().join('\0')
    || summary.index !== index
    || summary.provider !== 'deepseek-official'
    || summary.model !== 'deepseek-v4-flash'
    || summary.toolCount !== 1
    || !Array.isArray(summary.toolNames)
    || summary.toolNames.length !== 1
    || summary.toolNames[0] !== 'structured_output'
    || summary.workflowStopReason !== 'completed'
    || summary.agentsStarted !== 1
    || summary.structuredPresent !== true
    || summary.schemaValid !== true
    || summary.semanticValid !== true
    || !SHA256.test(summary.structuredSha256 ?? '')
    || !Number.isInteger(summary.candidateCount)
    || summary.candidateCount < 1
    || !Number.isInteger(summary.evidenceCount)
    || summary.evidenceCount < 1
  ) fail('PROVIDER_SUMMARY_INVALID')
}

async function textFiles(root) {
  const results = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (!entry.name.endsWith('.tgz') && entry.name !== 'secret-scan.txt') results.push(path)
    }
  }
  await visit(root)
  return results
}

async function secretScan(root) {
  const patterns = [
    /authorization:/i,
    /api[_-]?key/i,
    /bearer\s+/i,
    /sk-[a-z0-9_-]{12,}/i,
    /deepseek_api_key/i,
    /nobei_spike_token/i,
  ]
  const findings = []
  for (const path of await textFiles(root)) {
    const bytes = await readFile(path)
    if (bytes.includes(0)) continue
    const text = bytes.toString('utf8')
    if (patterns.some((pattern) => pattern.test(text))) findings.push(relative(root, path))
  }
  await writeFile(join(root, 'secret-scan.txt'), findings.length ? `${findings.join('\n')}\n` : '', 'utf8')
  if (findings.length) fail('SECRET_PATTERN_FOUND')
}

export async function verifyEvidenceRoot(evidenceRoot) {
  const root = resolve(evidenceRoot)
  const [manifest, request, topology, subprocess] = await Promise.all([
    readJson(join(root, 'manifest.json'), 'MANIFEST_MISSING'),
    readJson(join(root, 'authorization-request.json'), 'AUTHORIZATION_REQUEST_MISSING'),
    readJson(join(root, 'spike-00-public-seams', 'topology.json'), 'TOPOLOGY_MISSING'),
    readJson(join(root, 'spike-00-public-seams', 'subprocess-result.json'), 'SUBPROCESS_EVIDENCE_MISSING'),
  ])
  if (typeof manifest.artifact !== 'string' || manifest.artifact.includes('..')) fail('ARTIFACT_PATH_INVALID')
  let artifact
  try {
    artifact = await readFile(join(root, manifest.artifact))
  } catch {
    fail('ARTIFACT_MISSING')
  }
  if (sha256(artifact) !== manifest.artifactSha256) fail('ARTIFACT_DIGEST_MISMATCH')
  verifyRequest(request, manifest)
  verifyTopology(topology)
  verifySubprocess(subprocess)
  await verifyCommands(root)

  const calls = manifest?.modelCalls
  if (
    calls?.spike?.authorizedMax !== 3
    || calls?.gate5?.authorizedMax !== 0
    || calls?.gate5?.actual !== 0
    || calls?.futureCombinedCeilingNotAuthorized !== 24
  ) fail('MODEL_CALL_MANIFEST_INVALID')

  let decision
  let actualCalls
  if (manifest.decision === 'SPIKE_NO_GO') {
    if (
      !Number.isInteger(calls.spike.actual)
      || calls.spike.actual < 0
      || calls.spike.actual > 3
      || calls.totalActual !== calls.spike.actual
      || manifest?.provider?.status !== 'FAIL'
      || manifest.provider.failureCode !== 'PROBE_FAILED'
    ) fail('NO_GO_MANIFEST_INVALID')
    const grant = await readJson(join(root, 'authorization-grant.json'), 'AUTHORIZATION_GRANT_MISSING')
    verifyGrant(grant, request)
    const failure = await readJson(
      join(root, 'spike-00-public-seams', 'provider-failure.json'),
      'PROVIDER_FAILURE_MISSING',
    )
    const allowedFailureStages = new Set(['WORKFLOW_RUNTIME', 'OUTCOME_VALIDATION', 'PARENT_DISPOSE'])
    if (
      failure?.http?.status !== 500
      || !Number.isInteger(failure?.http?.byteLength)
      || failure.http.byteLength < 1
      || !SHA256.test(failure?.http?.bodySha256 ?? '')
      || failure?.error?.code !== 'PROBE_FAILED'
      || failure.error.actualCalls !== calls.spike.actual
      || !allowedFailureStages.has(failure.error.failureStage)
      || Object.keys(failure.error).toSorted().join('\0') !== ['actualCalls', 'code', 'failureStage'].join('\0')
    ) fail('PROVIDER_FAILURE_INVALID')
    decision = 'SPIKE_NO_GO'
    actualCalls = calls.spike.actual
  } else if (calls.spike.actual === 0 && calls.totalActual === 0) {
    if (manifest.decision !== 'SPIKE_BLOCKED_USER_AUTHORIZATION') fail('PREPARED_DECISION_INVALID')
    try {
      await readFile(join(root, 'authorization-grant.json'))
      fail('UNEXPECTED_AUTHORIZATION_GRANT')
    } catch (error) {
      if (error?.message === 'UNEXPECTED_AUTHORIZATION_GRANT') throw error
      if (error?.code !== 'ENOENT') throw error
    }
    decision = 'SPIKE_BLOCKED_USER_AUTHORIZATION'
    actualCalls = 0
  } else if (calls.spike.actual === 3 && calls.totalActual === 3) {
    if (manifest?.provider?.status !== 'PASS' || manifest.provider.summaries !== 3) fail('PROVIDER_MANIFEST_INVALID')
    const grant = await readJson(join(root, 'authorization-grant.json'), 'AUTHORIZATION_GRANT_MISSING')
    verifyGrant(grant, request)
    for (let index = 1; index <= 3; index += 1) {
      const summary = await readJson(
        join(root, 'spike-00-public-seams', `provider-call-${String(index).padStart(2, '0')}.json`),
        'PROVIDER_SUMMARY_MISSING',
      )
      verifyProviderSummary(summary, index)
    }
    decision = 'SPIKE_GO'
    actualCalls = 3
  } else {
    fail('MODEL_CALL_COUNT_INVALID')
  }

  await secretScan(root)
  const result = {
    version: 1,
    decision,
    verifiedAt: new Date().toISOString(),
    artifactSha256: manifest.artifactSha256,
    provider: request.provider,
    model: request.model,
    authorizedMaxCalls: request.maxCalls,
    actualCalls,
  }
  await writeJsonAtomic(join(root, 'final-result.json'), result)
  return result
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--evidence-root' || !isAbsolute(argv[1])) {
    throw new Error('usage: verify-spike.mjs --evidence-root <absolute>')
  }
  return argv[1]
}

async function main() {
  const result = await verifyEvidenceRoot(parseArgs(process.argv.slice(2)))
  process.stdout.write(`${result.decision}\n`)
  process.stdout.write(`provider=${result.provider}\nmodel=${result.model}\nauthorizedMaxCalls=${result.authorizedMaxCalls}\nactualCalls=${result.actualCalls}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
