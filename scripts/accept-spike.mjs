#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CRITICAL_PROFILE_PACKAGES,
  assertProfileTopology,
  createWorkspacePolicy,
} from './dsh-topology.mjs'
import { EvidenceRecorder, summarizeHttpResponse, writeJsonAtomic } from './evidence.mjs'

const RC7 = '0.1.0-rc.7'
const PNPM = '11.23.0'
const TARBALL = 'nobei-dsh-phase1-0.0.0.tgz'
const PACKAGE_NAME = '@nobei/dsh-phase1'
const FORBIDDEN_BROWSER_PROCESS_PATTERNS = Object.freeze([
  'open', 'safari', 'google chrome', 'chromium', 'firefox', 'xdg-open',
])
const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

export const INITIAL_MODEL_CALLS = Object.freeze({
  spike: { authorizedMax: 3, actual: 0 },
  gate5: { authorizedMax: 0, actual: 0 },
  totalActual: 0,
  futureCombinedCeilingNotAuthorized: 24,
})

export function buildAcceptancePlan({
  mode,
  packageRoot,
  evidenceRoot,
  runtimeRoot,
  dshHome,
  userHome,
  preservedTarball,
  credentialPresent,
}) {
  if (!['prepare', 'execute'].includes(mode)) throw new TypeError('ACCEPTANCE_MODE_INVALID')
  const dshBinary = join(runtimeRoot, 'node_modules', '.bin', 'dsh')
  return {
    mode,
    paths: { packageRoot, evidenceRoot, runtimeRoot, dshHome, userHome },
    profileDependencies: CRITICAL_PROFILE_PACKAGES.map((name) => `${name}@${RC7}`),
    bundleInstallSource: preservedTarball,
    bootArgv: [dshBinary, '--profile', 'nobei', '--port', '0'],
    headlessContract: {
      dshVersion: RC7,
      unsupportedArguments: [],
      forbiddenProcessPatterns: [...FORBIDDEN_BROWSER_PROCESS_PATTERNS],
    },
    endpoints: mode === 'prepare'
      ? ['/nobei-spike/v1/health', '/nobei-spike/v1/subprocess']
      : ['/nobei-spike/v1/health', '/nobei-spike/v1/provider'],
    envNames: [
      'PATH', 'HOME', 'DSH_HOME',
      ...(mode === 'execute' && credentialPresent ? ['DEEPSEEK_API_KEY'] : []),
      'NOBEI_SPIKE_TOKEN', 'DSH_TOOLS_MODE', 'DSH_TELEMETRY_MODE', 'LANG', 'LC_ALL',
    ],
    steps: [
      { kind: 'build' },
      { kind: 'test' },
      { kind: 'pack' },
      { kind: 'preserve-artifact' },
      { kind: 'create-disposable-runtime' },
      { kind: 'install-exact-topology' },
      { kind: 'install-bundle-from-tarball' },
      { kind: 'boot-headless' },
      { kind: mode === 'prepare' ? 'subprocess-only' : 'provider-only' },
    ],
    expectedDecision: mode === 'prepare' ? 'SPIKE_BLOCKED_USER_AUTHORIZATION' : undefined,
    initialModelCalls: structuredClone(INITIAL_MODEL_CALLS),
  }
}

export function validateExecutePreconditions({
  manifest,
  request,
  grant,
  credentialPresent,
  artifactSha256,
  promptSha256,
  schemaSha256,
}) {
  if (!credentialPresent) throw new Error('PROVIDER_CREDENTIAL_MISSING')
  if (manifest?.subprocess?.status !== 'PASS') throw new Error('SUBPROCESS_EVIDENCE_INVALID')
  if (
    manifest?.modelCalls?.spike?.actual !== 0
    || manifest?.modelCalls?.totalActual !== 0
    || manifest?.modelCalls?.gate5?.actual !== 0
  ) throw new Error('MODEL_CALL_BUDGET_NOT_FRESH')
  if (artifactSha256 !== request?.artifactSha256 || manifest?.artifactSha256 !== artifactSha256) {
    throw new Error('ARTIFACT_DIGEST_MISMATCH')
  }
  if (promptSha256 !== request?.promptSha256 || manifest?.promptSha256 !== promptSha256) {
    throw new Error('PROMPT_DIGEST_MISMATCH')
  }
  if (schemaSha256 !== request?.schemaSha256 || manifest?.schemaSha256 !== schemaSha256) {
    throw new Error('SCHEMA_DIGEST_MISMATCH')
  }
  const requestKeys = [
    'artifactSha256', 'maxCalls', 'model', 'promptSha256', 'provider', 'purpose',
    'requestDigest', 'schemaSha256', 'version',
  ]
  if (
    request === null
    || typeof request !== 'object'
    || Object.keys(request).toSorted().join('\0') !== requestKeys.toSorted().join('\0')
    || request.version !== 1
    || request.provider !== 'deepseek-official'
    || request.model !== 'deepseek-v4-flash'
    || request.maxCalls !== 3
    || request.purpose !== 'phase1a-public-seam-spike'
    || request.requestDigest !== computeAuthorizationRequestDigest(request)
  ) throw new Error('AUTHORIZATION_REQUEST_INVALID')
  const grantKeys = [
    'authorizationSource', 'authorizedAt', 'authorizedMaxCalls', 'authorizedModel',
    'authorizedProvider', 'requestDigest', 'version',
  ]
  if (
    grant === null
    || typeof grant !== 'object'
    || Object.keys(grant).toSorted().join('\0') !== grantKeys.toSorted().join('\0')
    || grant.version !== 1
    || grant.requestDigest !== request.requestDigest
    || grant?.authorizedProvider !== 'deepseek-official'
    || grant?.authorizedModel !== 'deepseek-v4-flash'
    || grant?.authorizedMaxCalls !== 3
    || grant?.authorizationSource !== 'explicit-user-confirmation-in-active-codex-task'
    || typeof grant.authorizedAt !== 'string'
    || !Number.isFinite(Date.parse(grant.authorizedAt))
  ) throw new Error('AUTHORIZATION_DIGEST_MISMATCH')
  return true
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function sha256File(path) {
  return sha256(await readFile(path))
}

function canonicalize(value) {
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.keys(value).filter((key) => key !== 'requestDigest').toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
}

export function computeAuthorizationRequestDigest(fields) {
  return sha256(Buffer.from(canonicalize(fields), 'utf8'))
}

function authorizationRequest(fields) {
  return { ...fields, requestDigest: computeAuthorizationRequestDigest(fields) }
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function corepackArgv(...args) {
  return ['corepack', `pnpm@${PNPM}`, ...args]
}

function dshEnvironment({ toolsDir, userHome, dshHome, token, credential }) {
  return {
    PATH: `${toolsDir}:${process.env.PATH ?? dirname(process.execPath)}`,
    HOME: userHome,
    DSH_HOME: dshHome,
    ...(credential ? { DEEPSEEK_API_KEY: credential } : {}),
    NOBEI_SPIKE_TOKEN: token,
    DSH_TOOLS_MODE: 'native',
    DSH_TELEMETRY_MODE: 'DISABLED',
    LANG: 'C',
    LC_ALL: 'C',
  }
}

async function required(recorder, command) {
  const result = await recorder.run(command)
  if (result.exitCode !== 0) throw new Error(`${command.slug.toUpperCase().replaceAll('-', '_')}_FAILED`)
  return result
}

async function prepareRuntime({ evidenceRoot, recorder, pinset, credential }) {
  const [runtimeRoot, dshHome, userHome] = await Promise.all([
    mkdtemp('/tmp/nobei-phase1a-runtime-'),
    mkdtemp('/tmp/nobei-phase1a-dsh-home-'),
    mkdtemp('/tmp/nobei-phase1a-user-home-'),
  ])
  const toolsDir = join(runtimeRoot, '.acceptance-bin')
  await mkdir(toolsDir, { recursive: true })
  const wrapper = join(toolsDir, 'pnpm')
  await writeFile(wrapper, `#!/bin/sh\nexec /usr/local/bin/corepack pnpm@${PNPM} --allow-build=@deepseek-ai/dsh-subprocess-local --allow-build=@google/genai --allow-build=koffi --allow-build=node-pty --allow-build=protobufjs "$@"\n`, { mode: 0o755 })
  await writeFile(join(runtimeRoot, 'package.json'), `${JSON.stringify({ name: 'nobei-phase1a-runtime', private: true }, null, 2)}\n`)
  const policy = createWorkspacePolicy(pinset)
  await Promise.all([
    writeFile(join(runtimeRoot, 'pnpm-workspace.yaml'), policy),
    writeFile(join(dshHome, 'pnpm-workspace.yaml'), policy),
  ])
  const token = randomBytes(32).toString('base64url')
  const env = dshEnvironment({ toolsDir, userHome, dshHome, token, credential })
  recorder.redactions.push(runtimeRoot, dshHome, userHome, token, ...(credential ? [credential] : []))
  recorder.redactions.sort((left, right) => right.length - left.length)

  await required(recorder, {
    slug: 'install-dsh',
    argv: corepackArgv('add', '--save-exact', '--config.auto-install-peers=true', `@deepseek-ai/dsh@${RC7}`),
    cwd: runtimeRoot,
    cwdLabel: 'disposable-runtime',
    env,
  })
  const dshBinary = join(runtimeRoot, 'node_modules', '.bin', 'dsh')
  const version = await required(recorder, {
    slug: 'dsh-version', argv: [dshBinary, '--version'], cwd: runtimeRoot, cwdLabel: 'disposable-runtime', env,
  })
  if (!version.stdout.includes(RC7)) throw new Error('DSH_VERSION_MISMATCH')
  await required(recorder, {
    slug: 'install-web-app',
    argv: [dshBinary, 'plugin', '--profile', 'nobei', 'add', `@deepseek-ai/dsh-web-app@${RC7}`],
    cwd: runtimeRoot,
    cwdLabel: 'disposable-runtime',
    env,
  })
  const profileRoot = join(dshHome, 'profiles', 'nobei')
  await writeFile(join(profileRoot, 'pnpm-workspace.yaml'), policy)
  await required(recorder, {
    slug: 'install-critical-seams',
    argv: corepackArgv('add', '--save-exact', '--config.auto-install-peers=true', ...CRITICAL_PROFILE_PACKAGES.map((name) => `${name}@${RC7}`)),
    cwd: profileRoot,
    cwdLabel: 'disposable-profile',
    env,
  })
  const topology = assertProfileTopology(await readFile(join(profileRoot, 'pnpm-lock.yaml'), 'utf8'), RC7)
  const versions = {}
  for (const name of CRITICAL_PROFILE_PACKAGES) {
    const manifest = JSON.parse(await readFile(join(profileRoot, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
    if (manifest.version !== RC7) throw new Error(`INSTALLED_VERSION_MISMATCH:${name}`)
    versions[name] = manifest.version
  }
  await writeJsonAtomic(join(evidenceRoot, 'spike-00-public-seams', 'topology.json'), { topology, versions })
  return { runtimeRoot, dshHome, userHome, profileRoot, dshBinary, env, token, version: version.stdout.trim() }
}

async function installBundle({ runtime, recorder, preservedTarball }) {
  await required(recorder, {
    slug: 'install-bundle-tarball',
    argv: [runtime.dshBinary, 'plugin', '--profile', 'nobei', 'add', preservedTarball, '--prefer-offline'],
    cwd: runtime.runtimeRoot,
    cwdLabel: 'disposable-runtime',
    env: runtime.env,
  })
  const manifest = JSON.parse(await readFile(join(runtime.profileRoot, 'package.json'), 'utf8'))
  const dependency = manifest.dependencies?.[PACKAGE_NAME]
  if (typeof dependency !== 'string' || dependency.startsWith('link:')) throw new Error('BUNDLE_INSTALL_NOT_EXTERNAL')
}

async function postJson(baseUrl, path, token, value) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'x-nobei-spike-token': token,
    },
    body: JSON.stringify(value),
  })
  const body = await response.text()
  return { response, body, parsed: JSON.parse(body) }
}

export function summarizeProviderFailure(probe) {
  const actualCalls = probe?.payload?.error?.actualCalls
  const failureStage = probe?.payload?.error?.failureStage
  const allowedStages = new Set(['WORKFLOW_RUNTIME', 'OUTCOME_VALIDATION', 'PARENT_DISPOSE'])
  if (
    probe?.http?.status !== 500
    || !Number.isInteger(probe?.http?.byteLength)
    || probe.http.byteLength < 1
    || !/^[a-f0-9]{64}$/.test(probe?.http?.bodySha256 ?? '')
    || probe?.payload?.ok !== false
    || probe?.payload?.error?.code !== 'PROBE_FAILED'
    || !Number.isInteger(actualCalls)
    || actualCalls < 0
    || actualCalls > 3
    || !allowedStages.has(failureStage)
    || Object.keys(probe.payload.error).toSorted().join('\0') !== ['actualCalls', 'code', 'failureStage'].join('\0')
  ) {
    const payload = probe?.payload
    const error = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? payload.error
      : undefined
    const errorCode = error !== null
      && typeof error === 'object'
      && !Array.isArray(error)
      && typeof error.code === 'string'
      && /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code
      : null
    throw Object.assign(new Error('PROVIDER_FAILURE_PAYLOAD_INVALID'), {
      diagnostic: {
        http: probe?.http,
        envelope: {
          topLevelKeys: payload !== null && typeof payload === 'object' && !Array.isArray(payload)
            ? Object.keys(payload).toSorted()
            : [],
          ok: payload?.ok,
          errorKeys: error !== null && typeof error === 'object' && !Array.isArray(error)
            ? Object.keys(error).toSorted()
            : [],
          errorCode,
        },
      },
    })
  }
  return {
    http: probe.http,
    error: { code: 'PROBE_FAILED', actualCalls, failureStage },
  }
}

class SpikeEndpointError extends Error {
  constructor(failure) {
    super('SPIKE_ENDPOINT_FAILED')
    this.failure = failure
  }
}

async function bootAndProbe({ runtime, recorder, mode, providerBody }) {
  let probeResult
  const boot = await recorder.run({
    slug: `boot-${mode}`,
    argv: [runtime.dshBinary, '--profile', 'nobei', '--port', '0'],
    cwd: runtime.runtimeRoot,
    cwdLabel: 'disposable-runtime',
    env: runtime.env,
    timeoutMs: 180_000,
    interact: async ({ waitForOutput }) => {
      const output = await waitForOutput(({ stdout, stderr }) => /dsh web: http:\/\/127\.0\.0\.1:\d+/.test(`${stdout}\n${stderr}`), 90_000)
      const matches = [...`${output.stdout}\n${output.stderr}`.matchAll(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/g)]
      if (matches.length !== 1) throw new Error('DSH_READINESS_LINE_INVALID')
      const baseUrl = matches[0][1]
      const health = await fetch(`${baseUrl}/nobei-spike/v1/health`, {
        headers: { 'x-nobei-spike-token': runtime.token },
      })
      const healthBody = await health.text()
      if (!health.ok || JSON.parse(healthBody)?.service !== 'nobei-phase1a-spike') throw new Error('SPIKE_HEALTH_FAILED')
      const endpoint = mode === 'prepare' ? '/nobei-spike/v1/subprocess' : '/nobei-spike/v1/provider'
      const result = await postJson(baseUrl, endpoint, runtime.token, mode === 'prepare' ? {} : providerBody)
      probeResult = {
        http: summarizeHttpResponse({ status: result.response.status, body: result.body }),
        payload: result.parsed,
      }
      if (!result.response.ok) {
        throw new SpikeEndpointError(summarizeProviderFailure(probeResult))
      }
    },
  })
  if (boot.exitCode !== 0 && boot.signal !== 'SIGTERM') throw new Error('DSH_BOOT_SHUTDOWN_FAILED')
  if (!probeResult) throw new Error('SPIKE_RESULT_MISSING')
  return probeResult
}

function sanitizeSubprocessEvidence(probe) {
  const copy = structuredClone(probe)
  const environment = copy?.payload?.result?.environmentIsolation
  if (environment && Object.hasOwn(environment, 'deepseekApiKeyPresent')) {
    environment.providerCredentialPresent = environment.deepseekApiKeyPresent
    delete environment.deepseekApiKeyPresent
  }
  return copy
}

async function runPrepare() {
  const evidenceRoot = join(packageRoot, 'evidence', utcStamp())
  await mkdir(join(evidenceRoot, 'artifacts'), { recursive: true })
  const recorder = new EvidenceRecorder({ root: evidenceRoot })
  const packagingEnv = {
    PATH: process.env.PATH ?? dirname(process.execPath),
    HOME: process.env.HOME ?? '/tmp',
    LANG: 'C',
    LC_ALL: 'C',
  }
  await required(recorder, {
    slug: 'build-once', argv: corepackArgv('build'), cwd: packageRoot, cwdLabel: 'package-root', env: packagingEnv,
  })
  await required(recorder, {
    slug: 'test-once', argv: corepackArgv('vitest', 'run'), cwd: packageRoot, cwdLabel: 'package-root', env: packagingEnv,
  })
  await required(recorder, {
    slug: 'pack-once',
    argv: corepackArgv('pack', '--pack-destination', join(packageRoot, 'dist')),
    cwd: packageRoot,
    cwdLabel: 'package-root',
    env: packagingEnv,
  })
  const packedTarball = join(packageRoot, 'dist', TARBALL)
  const preservedTarball = join(evidenceRoot, 'artifacts', TARBALL)
  await copyFile(packedTarball, preservedTarball)
  const artifactSha256 = await sha256File(preservedTarball)
  const pinset = JSON.parse(await readFile(join(packageRoot, 'config', 'dsh-rc7-pins.json'), 'utf8'))
  let runtime
  try {
    runtime = await prepareRuntime({ evidenceRoot, recorder, pinset })
    await installBundle({ runtime, recorder, preservedTarball })
    const probe = await bootAndProbe({ runtime, recorder, mode: 'prepare' })
    if (probe.payload?.ok !== true || probe.payload?.result?.status !== 'PASS') throw new Error('SUBPROCESS_PROBE_FAILED')
    await writeJsonAtomic(
      join(evidenceRoot, 'spike-00-public-seams', 'subprocess-result.json'),
      sanitizeSubprocessEvidence(probe),
    )

    const promptPath = join(packageRoot, 'spike', 'fixtures', 'prompt.txt')
    const schemaPath = join(packageRoot, 'spike', 'fixtures', 'l1-candidate-spike.schema.json')
    const promptSha256 = await sha256File(promptPath)
    const schemaSha256 = await sha256File(schemaPath)
    const request = authorizationRequest({
      version: 1,
      artifactSha256,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      maxCalls: 3,
      promptSha256,
      schemaSha256,
      purpose: 'phase1a-public-seam-spike',
    })
    const requestPath = join(evidenceRoot, 'authorization-request.json')
    await writeJsonAtomic(requestPath, request)
    const manifest = {
      version: 1,
      phase: 'phase1a-public-seam-spike',
      createdAt: new Date().toISOString(),
      dshVersion: runtime.version,
      artifact: `artifacts/${TARBALL}`,
      artifactSha256,
      promptSha256,
      schemaSha256,
      subprocess: { status: 'PASS' },
      decision: 'SPIKE_BLOCKED_USER_AUTHORIZATION',
      modelCalls: structuredClone(INITIAL_MODEL_CALLS),
    }
    await writeJsonAtomic(join(evidenceRoot, 'manifest.json'), manifest)
    process.stdout.write(`evidenceRoot=${evidenceRoot}\n`)
    process.stdout.write(`authorizationRequest=${requestPath}\n`)
    process.stdout.write(`provider=${request.provider}\nmodel=${request.model}\nmaxCalls=${request.maxCalls}\n`)
    process.stdout.write(`requestDigest=${request.requestDigest}\n`)
    process.stdout.write('SPIKE_BLOCKED_USER_AUTHORIZATION\n')
  } finally {
    if (runtime) await Promise.all([
      rm(runtime.runtimeRoot, { recursive: true, force: true }),
      rm(runtime.dshHome, { recursive: true, force: true }),
      rm(runtime.userHome, { recursive: true, force: true }),
    ])
  }
}

function parseExecuteArgs(argv) {
  if (argv.length !== 4) throw new Error('EXECUTE_ARGUMENTS_INVALID')
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!['--evidence-root', '--grant'].includes(flag) || !isAbsolute(value) || values.has(flag)) {
      throw new Error('EXECUTE_ARGUMENTS_INVALID')
    }
    values.set(flag, value)
  }
  return { evidenceRoot: values.get('--evidence-root'), grantPath: values.get('--grant') }
}

async function runExecute(argv) {
  const { evidenceRoot, grantPath } = parseExecuteArgs(argv)
  const [manifest, request, grant] = await Promise.all([
    readFile(join(evidenceRoot, 'manifest.json'), 'utf8').then(JSON.parse),
    readFile(join(evidenceRoot, 'authorization-request.json'), 'utf8').then(JSON.parse),
    readFile(grantPath, 'utf8').then(JSON.parse),
  ])
  const artifactPath = join(evidenceRoot, manifest.artifact)
  const credentialPresent = typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.trim().length > 0
  if (!credentialPresent) {
    process.stdout.write('SPIKE_BLOCKED_PROVIDER_CONFIG\n')
    return
  }
  validateExecutePreconditions({
    manifest,
    request,
    grant,
    credentialPresent,
    artifactSha256: await sha256File(artifactPath),
    promptSha256: await sha256File(join(packageRoot, 'spike', 'fixtures', 'prompt.txt')),
    schemaSha256: await sha256File(join(packageRoot, 'spike', 'fixtures', 'l1-candidate-spike.schema.json')),
  })
  const pinset = JSON.parse(await readFile(join(packageRoot, 'config', 'dsh-rc7-pins.json'), 'utf8'))
  const recorder = new EvidenceRecorder({ root: evidenceRoot })
  let runtime
  try {
    runtime = await prepareRuntime({ evidenceRoot, recorder, pinset, credential: process.env.DEEPSEEK_API_KEY })
    await installBundle({ runtime, recorder, preservedTarball: artifactPath })
    const probe = await bootAndProbe({
      runtime,
      recorder,
      mode: 'execute',
      providerBody: { authorizationRequest: request, authorizationGrant: grant },
    })
    const summaries = probe.payload?.result
    if (!Array.isArray(summaries) || summaries.length !== 3) throw new Error('PROVIDER_SUMMARIES_INVALID')
    for (const [index, summary] of summaries.entries()) {
      await writeJsonAtomic(join(evidenceRoot, 'spike-00-public-seams', `provider-call-${String(index + 1).padStart(2, '0')}.json`), summary)
    }
    manifest.modelCalls.spike.actual = 3
    manifest.modelCalls.totalActual = 3
    manifest.provider = { status: 'PASS', summaries: 3 }
    manifest.decision = 'PENDING_VERIFICATION'
    await writeJsonAtomic(join(evidenceRoot, 'manifest.json'), manifest)
    process.stdout.write('PROVIDER_PROBE_COMPLETE\n')
  } catch (error) {
    const failure = error instanceof SpikeEndpointError ? error.failure : undefined
    const diagnostic = error?.diagnostic
    const actualCalls = failure?.error?.actualCalls
    manifest.modelCalls.spike.actual = Number.isInteger(actualCalls) ? actualCalls : null
    manifest.modelCalls.totalActual = Number.isInteger(actualCalls) ? actualCalls : null
    manifest.provider = failure
      ? { status: 'FAIL', failureCode: failure.error.code }
      : { status: 'UNKNOWN_AFTER_FAILURE' }
    manifest.decision = 'SPIKE_NO_GO'
    if (failure) {
      await writeJsonAtomic(join(evidenceRoot, 'spike-00-public-seams', 'provider-failure.json'), failure)
    }
    if (diagnostic) {
      await writeJsonAtomic(
        join(evidenceRoot, 'spike-00-public-seams', 'provider-unclassified-failure.json'),
        diagnostic,
      )
    }
    await writeJsonAtomic(join(evidenceRoot, 'manifest.json'), manifest)
    throw error
  } finally {
    if (runtime) await Promise.all([
      rm(runtime.runtimeRoot, { recursive: true, force: true }),
      rm(runtime.dshHome, { recursive: true, force: true }),
      rm(runtime.userHome, { recursive: true, force: true }),
    ])
  }
}

async function main() {
  const [mode, ...argv] = process.argv.slice(2)
  if (mode === 'prepare') return await runPrepare()
  if (mode === 'execute') return await runExecute(argv)
  throw new Error('usage: accept-spike.mjs prepare | execute --evidence-root <absolute> --grant <absolute>')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
