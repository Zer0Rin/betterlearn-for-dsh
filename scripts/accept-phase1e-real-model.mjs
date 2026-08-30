#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { chromium } from '@playwright/test'
import { policyFor } from '../lib/acceptance/real-model-authorization.js'
import {
  acceptanceRegistryConfig,
  buildAcceptanceEnvironment,
  productRequestHeaders,
} from './accept-phase1c-host.mjs'
import { waitForProductReady } from './accept-phase1d-client.mjs'
import { CRITICAL_PROFILE_PACKAGES, createWorkspacePolicy } from './dsh-topology.mjs'
import { observeEvidenceOutput } from './phase1e-evidence-observation.mjs'
import {
  diffProfileSnapshots,
  observerLedger,
  openWorkspaceDirectoryPicker,
  openObserverView,
  requireManifest,
  snapshotProfiles,
  stopProbeDsh,
  waitForProbeReady,
} from './probe-phase1e-profile-reuse.mjs'

const RC7 = '0.1.0-rc.7'
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const COREPACK = '/usr/local/bin/corepack'
const PROFILE_PNPM = '/usr/local/bin/pnpm'
const PYTHON = '/opt/homebrew/bin/python3.12'
const MARKER_FILE = '.nobei-phase1e-acceptance-marker'
const execFileAsync = promisify(execFile)

export const PHASE1E_FIXTURE_NAME = 'phase1e-gate5-repeated.md'
export const PHASE1E_PROMPT_VERSION = 'l1-v2'

export function buildAuthorizationFields({ batchPolicy, ...frozen }) {
  const policy = policyFor(batchPolicy)
  if ('requiredSelection' in policy
    && !sameSelection(frozen.modelSelection, policy.requiredSelection)) {
    fail('REAL_MODEL_DIAGNOSTIC_SELECTION_MISMATCH')
  }
  return {
    version: 2,
    purpose: policy.purpose,
    batchPolicy,
    ...frozen,
    maxRuns: policy.maxRuns,
    maxCalls: policy.maxCalls,
  }
}

export function nextDiagnosticAction({
  ordinal,
  firstAttemptSucceeded,
  retrySucceeded,
  retryUsed,
}) {
  if (firstAttemptSucceeded) return ordinal === 3 ? 'COMPLETE' : 'NEXT_RUN'
  if (retryUsed && retrySucceeded === undefined) return 'NO_GO'
  if (retrySucceeded === true) return ordinal === 3 ? 'COMPLETE_UNSTABLE' : 'NEXT_RUN'
  return retrySucceeded === false ? 'NO_GO' : 'RETRY'
}

export async function retryTransientPasteEntry(action, { attempts = 3, delayMs = 100 } = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action()
    } catch (error) {
      lastError = error
      if (attempt < attempts && delayMs > 0) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, delayMs))
      }
    }
  }
  throw lastError
}

export async function waitForReviewableRun(readRun, {
  timeoutMs = 150_000,
  intervalMs = 100,
} = {}) {
  const started = Date.now()
  do {
    const run = await readRun()
    if (!run || typeof run.status !== 'string') fail('FIRST_RUN_READ_FAILED')
    if (run.status === 'review_pending') return run
    if (run.status === 'failed_retryable' || run.status === 'failed_terminal') {
      fail(`FIRST_RUN_GENERATION_FAILED:${run.error?.code ?? 'UNKNOWN'}`)
    }
    if (run.status === 'completed') fail('FIRST_RUN_COMPLETED_WITHOUT_REVIEW')
    if (intervalMs > 0) await new Promise(resolvePromise => setTimeout(resolvePromise, intervalMs))
  } while (Date.now() - started < timeoutMs)
  fail('FIRST_RUN_REVIEW_TIMEOUT')
}
const ADAPTER_PACKAGES = [
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-llm-pi-ai',
]

function fail(code) {
  throw new Error(code)
}

export function buildEvidenceObservationFields(canonicalText, coreAttempt) {
  const observed = observeEvidenceOutput(canonicalText, coreAttempt.rawOutput)
  if (observed.schemaValidEvidenceCount !== coreAttempt.schemaValidEvidenceCount
    || observed.uniqueQuoteEvidenceCount + observed.disambiguationSucceeded
      !== coreAttempt.exactEvidenceCount
    || observed.absentQuoteEvidenceCount !== (coreAttempt.rejectionCounts.EVIDENCE_NOT_FOUND ?? 0)
    || observed.disambiguationRejected
      !== (coreAttempt.rejectionCounts.EVIDENCE_AMBIGUOUS ?? 0)) {
    fail('PHASE1E_OBSERVATION_CORE_MISMATCH')
  }
  return observed
}

export function buildObservedRawRun(canonicalText, coreAttempt, baseRun) {
  if (baseRun === null || typeof baseRun !== 'object' || Array.isArray(baseRun)
    || Object.hasOwn(baseRun, 'rawOutput')) {
    fail('PHASE1E_RAW_RUN_TEXT_LEAK')
  }
  const rawRun = {
    ...baseRun,
    ...buildEvidenceObservationFields(canonicalText, coreAttempt),
  }
  if (Object.hasOwn(rawRun, 'rawOutput') || JSON.stringify(rawRun).includes(canonicalText)) {
    fail('PHASE1E_RAW_RUN_TEXT_LEAK')
  }
  return rawRun
}

function acceptanceProfileRoot(dshHome, profileName, marker) {
  if (!/^nobei-phase1e-accept-[a-z0-9-]+$/.test(profileName)) fail('PROFILE_MARKER_OWNERSHIP_INVALID')
  const profilesRoot = resolve(dshHome, 'profiles')
  const profileRoot = resolve(profilesRoot, profileName)
  const relation = relative(profilesRoot, profileRoot)
  if (relation.startsWith('..') || isAbsolute(relation)
    || resolve(marker) !== join(profileRoot, MARKER_FILE)) {
    fail('PROFILE_MARKER_OWNERSHIP_INVALID')
  }
  return profileRoot
}

async function removeAcceptanceProfile(dshHome, profileName, marker) {
  const profileRoot = acceptanceProfileRoot(dshHome, profileName, marker)
  await stat(marker)
  await rm(profileRoot, { recursive: true, force: false })
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function sha256File(path) {
  return sha256(await readFile(path))
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  await rename(temporary, path)
}

async function run(argv, options = {}) {
  const [file, ...args] = argv
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 32 * 1024 * 1024,
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    throw new Error(`COMMAND_FAILED:${argv.join(' ')}\n${error?.stdout ?? ''}\n${error?.stderr ?? ''}`, { cause: error })
  }
}

function validSelection(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value).toSorted()
  const expected = value.reasoningEffort === undefined
    ? ['model', 'provider']
    : ['model', 'provider', 'reasoningEffort']
  return JSON.stringify(keys) === JSON.stringify(expected)
    && typeof value.provider === 'string' && value.provider.length > 0
    && typeof value.model === 'string' && value.model.length > 0
    && (value.reasoningEffort === undefined
      || (typeof value.reasoningEffort === 'string' && value.reasoningEffort.length > 0))
}

function sameSelection(left, right) {
  return validSelection(left) && validSelection(right)
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

export function buildPhase1eAcceptancePlan({
  dshPath,
  profileName,
  productTarball,
  observerTarball,
  dshHome,
}) {
  if (![dshPath, productTarball, observerTarball, dshHome].every(isAbsolute)
    || !/^nobei-phase1e-accept-[a-z0-9-]+$/.test(profileName)) {
    fail('PHASE1E_ACCEPTANCE_PLAN_INVALID')
  }
  return {
    version: 1,
    rc7: RC7,
    dshPath,
    dshHome,
    profileName,
    packages: {
      product: productTarball,
      observer: observerTarball,
      adapters: Object.fromEntries(ADAPTER_PACKAGES.map(name => [name, RC7])),
    },
    credentialPolicy: 'use-dsh-service-without-reading-or-copying-files',
    prepare: {
      actualRuns: 0,
      actualCalls: 0,
      zeroLlmStreamCalls: true,
      actions: [
        'install-frozen-product',
        'install-independent-observer',
        'load-model-directory',
        'resolve-model-selection',
        'write-authorization-request',
      ],
    },
  }
}

function blocked(reason, details = {}) {
  return { status: 'BLOCKED_PROVIDER_CONFIG', reason, ...details }
}

export function evaluatePrepareObservation({ modelDirectory, adapters, observerRecords }) {
  if (modelDirectory?.status === 'MODEL_SELECTION_UNAVAILABLE') {
    return blocked('MODEL_SELECTION_UNAVAILABLE')
  }
  if (modelDirectory?.status !== 'READY' || !validSelection(modelDirectory.current)) {
    return blocked('MODEL_DIRECTORY_CONTRACT_INVALID')
  }
  if (modelDirectory.routable !== true) return blocked('MODEL_NOT_ROUTABLE')
  for (const packageName of ADAPTER_PACKAGES) {
    if (adapters?.[packageName] !== RC7) {
      return blocked('ADAPTER_MANIFEST_VERSION_INVALID', { packageName })
    }
  }
  if (!Array.isArray(observerRecords) || observerRecords.length !== 0) {
    return blocked('OBSERVER_STREAM_CALLS_NONZERO')
  }
  return {
    status: 'READY',
    selection: { ...modelDirectory.current },
    adapters: { ...adapters },
    zeroLlmStreamCalls: true,
  }
}

export function assertFirstRunResult(value) {
  if (value?.importStatus !== 202) fail('FIRST_RUN_IMPORT_FAILED')
  const selection = value.browserModelSelection
  if (!validSelection(selection)
    || typeof value.displayedModel !== 'string'
    || !value.displayedModel.includes(`${selection.provider} / ${selection.model}`)
    || (selection.reasoningEffort !== undefined && !value.displayedModel.includes(selection.reasoningEffort))) {
    fail('FIRST_RUN_MODEL_LABEL_MISMATCH')
  }
  if (value.coreAttempt?.status !== 'review_pending') fail('FIRST_RUN_NOT_REVIEWABLE')
  if (!Array.isArray(value.observerRecords) || value.observerRecords.length !== 1) {
    fail('FIRST_RUN_CALL_COUNT_INVALID')
  }
  const observer = value.observerRecords[0]
  if (!sameSelection(selection, value.coreAttempt.modelSelection)
    || !sameSelection(selection, {
      provider: observer.provider,
      model: observer.model,
      ...(observer.reasoningEffort === undefined ? {} : { reasoningEffort: observer.reasoningEffort }),
    })
    ) {
    fail('FIRST_RUN_MODEL_SELECTION_MISMATCH')
  }
  if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
    fail('FIRST_RUN_CANDIDATES_INVALID')
  }
  const evidence = value.candidates.flatMap(candidate => Array.isArray(candidate.evidence) ? candidate.evidence : [])
  if (evidence.length === 0
    || evidence.some(item => item?.alignMethod !== 'exact'
      || !Number.isSafeInteger(item.startOffset)
      || !Number.isSafeInteger(item.endOffset)
      || item.endOffset <= item.startOffset)
    || value.exactEvidenceYield !== 1) {
    fail('FIRST_RUN_EVIDENCE_INVALID')
  }
  if (!isAbsolute(value.screenshotPath ?? '')) fail('FIRST_RUN_SCREENSHOT_MISSING')
  const { rawOutput: _rawOutput, ...publicCoreAttempt } = value.coreAttempt
  return { ...value, coreAttempt: publicCoreAttempt }
}

export function buildRecoveredFirstRunCheckpoint(value) {
  const {
    request, budget, coreAttempt, candidates, displayedModel, screenshotPath, sessionObservation,
    fixtureText,
  } = value ?? {}
  const sha256Pattern = /^[0-9a-f]{64}$/
  if (budget?.state !== 'FIRST_RUN_AUTHORIZED'
    || budget.actualRuns !== 0 || budget.actualCalls !== 1
    || budget.requestDigest !== request?.requestDigest
    || !Array.isArray(budget.completedRunIds) || budget.completedRunIds.length !== 0) {
    fail('FIRST_RUN_RECOVERY_BUDGET_INVALID')
  }
  if (sessionObservation?.source !== 'dsh-session-log-recovery'
    || !sha256Pattern.test(String(sessionObservation.sourceSha256 ?? ''))
    || sessionObservation.streamCalls !== 1
    || sessionObservation.structuredOutputCalls !== 1
    || sessionObservation.completedTurns !== 1
    || !sameSelection(request?.modelSelection, {
      provider: sessionObservation?.provider,
      model: sessionObservation?.model,
      ...(sessionObservation?.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: sessionObservation.reasoningEffort }),
    })) {
    fail('FIRST_RUN_RECOVERY_OBSERVATION_INVALID')
  }
  if (coreAttempt?.attemptNumber !== 1 || coreAttempt.attemptStatus !== 'succeeded'
    || coreAttempt.status !== 'review_pending') {
    fail('FIRST_RUN_RECOVERY_CORE_INVALID')
  }
  const observerRecord = {
    sequence: 1,
    provider: sessionObservation.provider,
    model: sessionObservation.model,
    ...(sessionObservation.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: sessionObservation.reasoningEffort }),
    source: sessionObservation.source,
    sourceSha256: sessionObservation.sourceSha256,
  }
  const denominator = coreAttempt.schemaValidEvidenceCount
  const exactEvidenceYield = denominator === 0 ? 0 : coreAttempt.exactEvidenceCount / denominator
  const result = assertFirstRunResult({
    importStatus: 202,
    displayedModel,
    browserModelSelection: request.modelSelection,
    coreAttempt,
    observerRecords: [observerRecord],
    candidates,
    exactEvidenceYield,
    screenshotPath,
  })
  return {
    result,
    rawRun: buildObservedRawRun(fixtureText, coreAttempt, {
      ordinal: 1,
      runId: coreAttempt.runId,
      firstAttemptSucceeded: true,
      finalSucceeded: true,
      providerCalls: 1,
      candidateCount: candidates.length,
      schemaValidEvidenceCount: coreAttempt.schemaValidEvidenceCount,
      exactEvidenceCount: coreAttempt.exactEvidenceCount,
      rejectionCounts: coreAttempt.rejectionCounts,
      reviewEvidenceMethods: candidates.flatMap(candidate => candidate.evidence.map(() => 'exact')),
      modelSelection: coreAttempt.modelSelection,
      artifactSha256: request.artifactSha256,
      promptSha256: request.promptSha256,
      schemaSha256: request.schemaSha256,
      fixtureSha256: request.fixtureSha256,
    }),
    providerCall: {
      sequence: 1,
      runId: coreAttempt.runId,
      attemptNumber: 1,
      modelSelection: coreAttempt.modelSelection,
      source: sessionObservation.source,
      sourceSha256: sessionObservation.sourceSha256,
    },
  }
}

export function parseDshSessionObservation(rows, sourceSha256) {
  const contexts = rows.filter(row => row?.type === 'request/context')
  const headers = rows.filter(row => row?.type === 'request/header')
  const messages = rows.filter(row => row?.type === 'assistant/message')
  const structuredCalls = rows.filter(row => row?.type === 'tool/call'
    && row.data?.name === 'structured_output')
  const completedTurns = rows.filter(row => row?.type === 'turn/end'
    && row.data?.reason?.kind === 'completed')
  const config = headers[0]?.data?.header?.config
  const context = contexts[0]?.data
  const usage = messages[0]?.data?.usage
  const numericUsage = Object.fromEntries(['inputTokens', 'outputTokens', 'reasoningTokens']
    .filter(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0)
    .map(key => [key, usage[key]]))
  if (!/^[0-9a-f]{64}$/.test(String(sourceSha256 ?? ''))
    || typeof config?.provider !== 'string' || typeof config?.model !== 'string'
    || context?.provider !== config.provider || context?.model !== config.model
    || config.maxTokens !== 8_192) {
    fail('FIRST_RUN_RECOVERY_OBSERVATION_INVALID')
  }
  return {
    source: 'dsh-session-log-recovery',
    sourceSha256,
    provider: config.provider,
    model: config.model,
    ...(typeof config.reasoningEffort === 'string'
      ? { reasoningEffort: config.reasoningEffort }
      : {}),
    streamCalls: headers.length,
    structuredOutputCalls: structuredCalls.length,
    completedTurns: completedTurns.length,
    usage: numericUsage,
  }
}

async function resolveSelection(baseUrl, token, selection) {
  const response = await fetch(`${baseUrl}/nobei-acceptance/phase1e-resolve-model`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(selection),
  })
  const body = await response.json().catch(() => ({}))
  if (response.status !== 200 || !validSelection(body?.selection)) {
    return { status: 'MODEL_SELECTION_UNAVAILABLE' }
  }
  return { status: 'READY', current: body.selection, routable: true }
}

async function prepare(batchPolicy = 'gate5-full') {
  const evidenceRoot = join(ROOT, 'evidence', 'real-model', stamp())
  const artifactsRoot = join(evidenceRoot, 'artifacts')
  await mkdir(artifactsRoot, { recursive: true })

  await run([COREPACK, 'pnpm@11.23.0', 'build'], { cwd: ROOT, env: process.env })
  await run([COREPACK, 'pnpm@11.23.0', '--dir', 'acceptance/real-model-observer', 'build'], {
    cwd: ROOT, env: process.env,
  })
  await run([COREPACK, 'pnpm@11.23.0', 'pack', '--pack-destination', join(ROOT, 'dist')], {
    cwd: ROOT, env: process.env,
  })
  await run([COREPACK, 'pnpm@11.23.0', '--dir', 'acceptance/real-model-observer', 'pack',
    '--pack-destination', join(ROOT, 'acceptance/real-model-observer/dist')], {
    cwd: ROOT, env: process.env,
  })

  const productTarball = join(artifactsRoot, 'nobei-dsh-phase1-0.0.0.tgz')
  const observerTarball = join(artifactsRoot, 'nobei-dsh-phase1e-real-model-observer-0.0.0.tgz')
  await Promise.all([
    copyFile(join(ROOT, 'dist', 'nobei-dsh-phase1-0.0.0.tgz'), productTarball),
    copyFile(join(ROOT, 'acceptance/real-model-observer/dist', 'nobei-dsh-phase1e-real-model-observer-0.0.0.tgz'), observerTarball),
  ])

  const nonce = randomBytes(10).toString('hex')
  const profileName = `nobei-phase1e-accept-${nonce}`
  const dshHome = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const [runtimeRoot, privateHome, dataRoot, venvRoot] = await Promise.all([
    mkdtemp('/tmp/nobei-phase1e-runtime-'),
    mkdtemp('/tmp/nobei-phase1e-home-'),
    mkdtemp('/tmp/nobei-phase1e-data-'),
    mkdtemp('/tmp/nobei-phase1e-venv-'),
  ])
  const profileRoot = acceptanceProfileRoot(
    dshHome,
    profileName,
    join(dshHome, 'profiles', profileName, MARKER_FILE),
  )
  const marker = join(profileRoot, MARKER_FILE)
  const observerToken = randomBytes(32).toString('hex')
  const ownershipToken = randomBytes(32).toString('hex')

  await run([PYTHON, '-m', 'venv', venvRoot], { cwd: ROOT, env: process.env })
  const python = join(venvRoot, 'bin', 'python')
  await run([python, '-m', 'pip', 'install', '-r', join(ROOT, 'python/requirements-phase1.lock')], {
    cwd: ROOT, env: process.env,
  })
  const config = {
    home: privateHome,
    dshHome,
    python,
    dataRoot,
    ownershipToken,
    ledgerToken: randomBytes(32).toString('hex'),
  }
  const env = {
    ...buildAcceptanceEnvironment(process.env, config),
    NOBEI_PHASE1E_OBSERVER_LEDGER_TOKEN: observerToken,
    SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 1',
  }
  const registry = acceptanceRegistryConfig(process.env)
  if (registry !== undefined) await writeFile(join(privateHome, '.npmrc'), registry, { mode: 0o600 })
  await run([
    python, '-c',
    'import sys; from nobei_core.ownership import initialize_owned_root; initialize_owned_root(sys.argv[1], sys.argv[2])',
    dataRoot, ownershipToken,
  ], { cwd: ROOT, env: { ...env, PYTHONPATH: join(ROOT, 'python') } })

  await writeFile(join(runtimeRoot, 'package.json'), `${JSON.stringify({ name: `nobei-phase1e-runtime-${nonce}`, private: true }, null, 2)}\n`)
  const pinset = JSON.parse(await readFile(join(ROOT, 'config/dsh-rc7-pins.json'), 'utf8'))
  const policy = createWorkspacePolicy(pinset)
  await writeFile(join(runtimeRoot, 'pnpm-workspace.yaml'), policy)
  await run([COREPACK, 'pnpm@11.23.0', 'add', '--save-exact', '--config.auto-install-peers=true', `@deepseek-ai/dsh@${RC7}`], {
    cwd: runtimeRoot, env,
  })
  const dshPath = join(runtimeRoot, 'node_modules/.bin/dsh')
  const plan = buildPhase1eAcceptancePlan({ dshPath, profileName, productTarball, observerTarball, dshHome })
  const before = await snapshotProfiles(dshHome)

  let child
  let dshOutput = () => ''
  try {
    await run([dshPath, 'plugin', '--profile', profileName, 'add', `@deepseek-ai/dsh-web-app@${RC7}`], {
      cwd: runtimeRoot, env,
    })
    await writeFile(marker, `${nonce}\n`, { mode: 0o600 })
    await writeFile(join(profileRoot, 'pnpm-workspace.yaml'), policy)
    await run([PROFILE_PNPM, 'add', '--save-exact', '--config.auto-install-peers=true',
      ...CRITICAL_PROFILE_PACKAGES.map(name => `${name}@${RC7}`)], { cwd: profileRoot, env })
    await run([dshPath, 'plugin', '--profile', profileName, 'add', productTarball, '--prefer-offline'], {
      cwd: runtimeRoot, env,
    })
    await run([dshPath, 'plugin', '--profile', profileName, 'add', observerTarball, '--prefer-offline'], {
      cwd: runtimeRoot, env,
    })

    const profilePackage = JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8'))
    for (const packageName of ['@nobei/dsh-phase1', '@nobei/dsh-phase1e-real-model-observer']) {
      const specifier = profilePackage.dependencies?.[packageName]
      if (typeof specifier !== 'string' || specifier.startsWith('link:')) fail('BUNDLE_INSTALL_NOT_EXTERNAL')
    }
    const adapterManifests = Object.fromEntries(await Promise.all(ADAPTER_PACKAGES.map(async packageName => {
      const manifest = await requireManifest(profileRoot, packageName)
      return [packageName, manifest]
    })))
    const adapters = Object.fromEntries(Object.entries(adapterManifests).map(([name, value]) => [name, value.version]))

    child = spawn(dshPath, ['--profile', profileName, '--port', '0'], {
      cwd: runtimeRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const ready = await waitForProbeReady(child)
    dshOutput = ready.output
    const beforeRecords = await observerLedger(ready.baseUrl, observerToken)
    const directorySelection = await openObserverView(ready.baseUrl, runtimeRoot)
    const modelDirectory = directorySelection.status === 'READY'
      ? await resolveSelection(ready.baseUrl, observerToken, {
          provider: directorySelection.provider,
          model: directorySelection.model,
          ...(directorySelection.reasoningEffort === undefined
            ? {} : { reasoningEffort: directorySelection.reasoningEffort }),
        })
      : directorySelection
    const afterRecords = await observerLedger(ready.baseUrl, observerToken)
    const observation = evaluatePrepareObservation({
      modelDirectory,
      adapters,
      observerRecords: [...beforeRecords, ...afterRecords],
    })
    await stopProbeDsh(child)
    child = undefined
    if (observation.status !== 'READY') {
      await writeFile(join(evidenceRoot, 'final-result.json'), `${JSON.stringify(observation, null, 2)}\n`)
      await removeAcceptanceProfile(dshHome, profileName, marker)
      process.stdout.write(`status=BLOCKED_PROVIDER_CONFIG\nreason=${observation.reason}\nevidenceRoot=${evidenceRoot}\n`)
      return observation
    }

    const schemaPath = join(ROOT, 'contracts/l1-candidate.schema.json')
    const fixturePath = join(ROOT, 'acceptance/fixtures', PHASE1E_FIXTURE_NAME)
    const schema = JSON.parse(await readFile(schemaPath, 'utf8'))
    const {
      createRealModelAuthorizationRequest,
      createRealModelBudget,
      advanceRealModelBudget,
    } = await import('../lib/acceptance/real-model-authorization.js')
    const { promptIdentity } = await import('../lib/product/generation-adapter.js')
    const promptVersion = PHASE1E_PROMPT_VERSION
    const request = createRealModelAuthorizationRequest(buildAuthorizationFields({
      batchPolicy,
      artifactSha256: await sha256File(productTarball),
      promptVersion,
      promptSha256: sha256(Buffer.from(promptIdentity(promptVersion), 'utf8')),
      schemaVersion: schema.properties.schemaVersion.const,
      schemaSha256: await sha256File(schemaPath),
      fixtureSha256: await sha256File(fixturePath),
      modelSelection: observation.selection,
    }))
    const requestPath = join(evidenceRoot, 'authorization-request.json')
    const grantPath = join(evidenceRoot, 'authorization-grant.json')
    const budgetPath = join(evidenceRoot, 'budget-manifest.json')
    const budget = advanceRealModelBudget(
      createRealModelBudget(request),
      { type: 'await-authorization' },
    )
    const after = await snapshotProfiles(dshHome)
    const manifest = {
      version: 1,
      phase: 'phase1e-real-model',
      batchPolicy: request.batchPolicy,
      createdAt: new Date().toISOString(),
      plan,
      paths: { runtimeRoot, privateHome, dataRoot, venvRoot, profileRoot, dshPath },
      configPath: join(runtimeRoot, 'acceptance-private-config.json'),
      artifacts: {
        product: { path: productTarball, sha256: request.artifactSha256 },
        observer: { path: observerTarball, sha256: await sha256File(observerTarball) },
      },
      adapterManifests,
      observation,
      profileChanges: diffProfileSnapshots(before, after),
      authorization: {
        requestPath,
        grantPath,
        budgetPath,
        continuationPath: join(evidenceRoot, 'continuation-grant.json'),
      },
      zeroLlmStreamCalls: true,
      actualRuns: 0,
      actualCalls: 0,
    }
    const initialWrites = [
      writeFile(manifest.configPath, `${JSON.stringify({ ...config, observerToken }, null, 2)}\n`, { mode: 0o600 }),
      writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`),
      writeFile(budgetPath, `${JSON.stringify(budget, null, 2)}\n`),
      writeFile(join(evidenceRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
      writeFile(join(evidenceRoot, 'dsh-prepare-output.txt'), dshOutput()),
    ]
    if (request.batchPolicy === 'flash-low-stability') {
      initialWrites.push(
        writeFile(join(evidenceRoot, 'raw-runs.json'), '[]\n'),
        writeFile(join(evidenceRoot, 'observer-records.json'), '[]\n'),
      )
    }
    await Promise.all(initialWrites)
    process.stdout.write([
      `batchPolicy=${request.batchPolicy}`,
      `provider=${request.modelSelection.provider}`,
      `model=${request.modelSelection.model}`,
      `reasoningEffort=${request.modelSelection.reasoningEffort ?? 'provider-default'}`,
      `maxRuns=${request.maxRuns}`,
      `maxCalls=${request.maxCalls}`,
      `authorizationRequest=${requestPath}`,
      `evidenceRoot=${evidenceRoot}`,
      'PHASE1E_BLOCKED_USER_AUTHORIZATION',
      '',
    ].join('\n'))
    return manifest
  } catch (error) {
    if (child !== undefined) await stopProbeDsh(child).catch(() => undefined)
    await writeFile(join(evidenceRoot, 'prepare-error.txt'), `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    try { await removeAcceptanceProfile(dshHome, profileName, marker) } catch {}
    throw error
  }
}

async function readCoreAttempt(python, databasePath, runId) {
  const program = [
    'import json, sqlite3, sys',
    'con=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro&immutable=1", uri=True)',
    'con.row_factory=sqlite3.Row',
    'row=con.execute("SELECT a.id,a.attempt_number,a.request_digest,a.model_metadata_json,a.raw_output_json,a.status,a.error_code,r.status AS run_status,r.raw_candidate_count,r.schema_valid_evidence_count,r.exact_evidence_count,r.rejection_counts_json FROM p1_generation_attempts a JOIN p1_run_control r ON r.job_id=a.job_id WHERE a.job_id=? ORDER BY a.attempt_number DESC LIMIT 1",(sys.argv[2],)).fetchone()',
    'print(json.dumps(dict(row) if row else None,separators=(",",":")))',
  ].join(';')
  const { stdout } = await run([python, '-c', program, databasePath, runId], { cwd: ROOT, env: process.env })
  const row = JSON.parse(stdout)
  if (row === null) fail('FIRST_RUN_CORE_ATTEMPT_MISSING')
  const rawOutput = JSON.parse(row.raw_output_json)
  if (rawOutput === null || typeof rawOutput !== 'object' || Array.isArray(rawOutput)) {
    fail('PHASE1E_CORE_RAW_OUTPUT_INVALID')
  }
  return {
    attemptId: row.id,
    attemptNumber: row.attempt_number,
    runId,
    requestDigest: row.request_digest,
    modelSelection: JSON.parse(row.model_metadata_json),
    status: row.run_status,
    attemptStatus: row.status,
    errorCode: row.error_code,
    rawCandidateCount: row.raw_candidate_count,
    schemaValidEvidenceCount: row.schema_valid_evidence_count,
    exactEvidenceCount: row.exact_evidence_count,
    rejectionCounts: JSON.parse(row.rejection_counts_json),
    rawOutput,
  }
}

async function readCoreCandidates(python, databasePath, runId) {
  const program = [
    'import json, sqlite3, sys',
    'con=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro&immutable=1", uri=True)',
    'con.row_factory=sqlite3.Row',
    'rows=con.execute("SELECT c.id,c.ordinal,c.type,c.title,c.statement,c.review_status,c.revision,e.seq,e.quote,e.text_start,e.text_end,e.context_before,e.context_after FROM p1_candidates c JOIN p1_candidate_evidence e ON e.candidate_id=c.id WHERE c.job_id=? ORDER BY c.ordinal,e.seq",(sys.argv[2],)).fetchall()',
    'print(json.dumps([dict(row) for row in rows],separators=(",",":")))',
  ].join(';')
  const { stdout } = await run([python, '-c', program, databasePath, runId], { cwd: ROOT, env: process.env })
  const grouped = new Map()
  for (const row of JSON.parse(stdout)) {
    if (!grouped.has(row.id)) grouped.set(row.id, {
      candidateId: row.id,
      type: row.type,
      title: row.title,
      statement: row.statement,
      reviewStatus: row.review_status,
      revision: row.revision,
      evidence: [],
    })
    grouped.get(row.id).evidence.push({
      seq: row.seq,
      quote: row.quote,
      startOffset: row.text_start,
      endOffset: row.text_end,
      alignMethod: 'exact',
      contextBefore: row.context_before,
      contextAfter: row.context_after,
    })
  }
  return [...grouped.values()]
}

async function recoverFirstRun(evidenceRoot, runId, sessionLogPath, screenshotPath) {
  if (![evidenceRoot, sessionLogPath, screenshotPath].every(isAbsolute)
    || !/^job_[0-9a-f]{20}$/.test(runId)) fail('FIRST_RUN_RECOVERY_ARGUMENTS_INVALID')
  await Promise.all([stat(sessionLogPath), stat(screenshotPath)])
  const manifest = JSON.parse(await readFile(join(evidenceRoot, 'manifest.json'), 'utf8'))
  const config = JSON.parse(await readFile(manifest.configPath, 'utf8'))
  const [request, budget, compressed, fixtureText] = await Promise.all([
    readFile(manifest.authorization.requestPath, 'utf8').then(JSON.parse),
    readFile(manifest.authorization.budgetPath, 'utf8').then(JSON.parse),
    readFile(sessionLogPath),
    readFile(join(ROOT, 'acceptance/fixtures', PHASE1E_FIXTURE_NAME), 'utf8'),
  ])
  const { stdout } = await run(['zstdcat', sessionLogPath], { cwd: ROOT, env: process.env })
  const rows = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const sessionObservation = parseDshSessionObservation(rows, sha256(compressed))
  const [coreAttempt, candidates] = await Promise.all([
    readCoreAttempt(config.python, join(manifest.paths.dataRoot, 'phase1.db'), runId),
    readCoreCandidates(config.python, join(manifest.paths.dataRoot, 'phase1.db'), runId),
  ])
  const checkpoint = buildRecoveredFirstRunCheckpoint({
    request,
    budget,
    coreAttempt,
    candidates,
    displayedModel: `本次模型：${request.modelSelection.provider} / ${request.modelSelection.model}${request.modelSelection.reasoningEffort === undefined ? '' : ` · ${request.modelSelection.reasoningEffort}`}`,
    screenshotPath,
    sessionObservation,
    fixtureText,
  })
  const authorization = await import('../lib/acceptance/real-model-authorization.js')
  let nextBudget = authorization.advanceRealModelBudget(budget, { type: 'complete-run', runId })
  nextBudget = authorization.advanceRealModelBudget(nextBudget, { type: 'first-run-review' })
  await Promise.all([
    writeJsonAtomic(join(evidenceRoot, 'first-run.json'), checkpoint.result),
    writeJsonAtomic(join(evidenceRoot, 'raw-runs.json'), [checkpoint.rawRun]),
    writeJsonAtomic(join(evidenceRoot, 'observer-records.json'), [checkpoint.providerCall]),
    writeJsonAtomic(join(evidenceRoot, 'first-run-session-observation.json'), sessionObservation),
    writeJsonAtomic(manifest.authorization.budgetPath, nextBudget),
  ])
  process.stdout.write([
    'FIRST_RUN_REVIEW_RECOVERED',
    `runId=${runId}`,
    `candidateCount=${candidates.length}`,
    `provider=${request.modelSelection.provider}`,
    `model=${request.modelSelection.model}`,
    `reasoningEffort=${request.modelSelection.reasoningEffort ?? 'provider-default'}`,
    `sourceSha256=${sessionObservation.sourceSha256}`,
    '',
  ].join('\n'))
  return checkpoint
}

async function firstRun(evidenceRoot) {
  if (!isAbsolute(evidenceRoot)) fail('PHASE1E_EVIDENCE_ROOT_INVALID')
  const manifestPath = join(evidenceRoot, 'manifest.json')
  await rm(join(evidenceRoot, 'first-run-error.txt'), { force: true })
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.phase !== 'phase1e-real-model') fail('PHASE1E_MANIFEST_INVALID')
  const config = JSON.parse(await readFile(manifest.configPath, 'utf8'))
  const [requestValue, grantValue, budgetValue] = await Promise.all([
    readFile(manifest.authorization.requestPath, 'utf8').then(JSON.parse),
    readFile(manifest.authorization.grantPath, 'utf8').then(JSON.parse),
    readFile(manifest.authorization.budgetPath, 'utf8').then(JSON.parse),
  ])
  const authorization = await import('../lib/acceptance/real-model-authorization.js')
  const request = authorization.verifyRealModelAuthorizationRequest(requestValue)
  authorization.verifyRealModelGrant(grantValue, request)
  if (await sha256File(manifest.artifacts.product.path) !== request.artifactSha256
    || budgetValue.requestDigest !== request.requestDigest
    || budgetValue.state !== 'AWAITING_AUTHORIZATION'
    || budgetValue.actualRuns !== 0 || budgetValue.actualCalls !== 0) {
    fail('PHASE1E_FROZEN_INPUT_MISMATCH')
  }
  let budget = authorization.advanceRealModelBudget(budgetValue, { type: 'authorize-first-run' })
  const env = {
    ...buildAcceptanceEnvironment(process.env, config),
    NOBEI_PHASE1E_OBSERVER_LEDGER_TOKEN: config.observerToken,
    SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 1',
  }
  const child = spawn(manifest.paths.dshPath, ['--profile', manifest.plan.profileName, '--port', '0'], {
    cwd: manifest.paths.runtimeRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let browser
  let output = () => ''
  try {
    const ready = await waitForProbeReady(child)
    output = ready.output
    await waitForProductReady(ready.baseUrl)
    if ((await observerLedger(ready.baseUrl, config.observerToken)).length !== 0) {
      fail('FIRST_RUN_CALL_COUNT_INVALID')
    }
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.goto(ready.baseUrl, { waitUntil: 'domcontentloaded' })
    const notice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
    if (await notice.isVisible().catch(() => false)) {
      await notice.getByRole('button', { name: 'Continue', exact: true }).click()
    }
    const view = page.getByTestId('nobei-client-view')
    if (!await view.isVisible().catch(() => false)) {
      await openWorkspaceDirectoryPicker(page, manifest.paths.runtimeRoot)
    }
    await view.waitFor({ state: 'visible', timeout: 30_000 })
    await page.locator('[data-testid="nobei-model-selection"][data-model-status="ready"]')
      .waitFor({ state: 'visible', timeout: 30_000 })
    const displayedModel = await page.getByTestId('nobei-model-selection').innerText()
    if (!displayedModel.includes(`${request.modelSelection.provider} / ${request.modelSelection.model}`)
      || (request.modelSelection.reasoningEffort !== undefined
        && !displayedModel.includes(request.modelSelection.reasoningEffort))) {
      fail('FIRST_RUN_MODEL_LABEL_MISMATCH')
    }

    const fixtureText = await readFile(
      join(ROOT, 'acceptance/fixtures', PHASE1E_FIXTURE_NAME),
      'utf8',
    )
    await retryTransientPasteEntry(async () => {
      await page.getByRole('tab', { name: '粘贴文本', exact: true }).click()
      await page.getByTestId('nobei-paste-name').fill(PHASE1E_FIXTURE_NAME)
      await page.getByTestId('nobei-paste-text').fill(fixtureText)
      await page.waitForTimeout(100)
      if (await page.getByTestId('nobei-paste-name').inputValue() !== PHASE1E_FIXTURE_NAME
        || await page.getByTestId('nobei-paste-text').inputValue() !== fixtureText) {
        fail('FIRST_RUN_PASTE_VIEW_REMOUNTED')
      }
    })
    await page.locator('button.nobei-client__primary:not([disabled])').waitFor({ state: 'visible', timeout: 30_000 })

    const importResponsePromise = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/nobei/v1/imports'
        && response.request().method() === 'POST', { timeout: 30_000 })
    budget = authorization.advanceRealModelBudget(budget, { type: 'reserve-call', runId: 'pending-first-run' })
    await writeJsonAtomic(manifest.authorization.budgetPath, budget)
    await page.getByRole('button', { name: '开始提取', exact: true }).click()
    const importResponse = await importResponsePromise
    const importBody = await importResponse.json()
    if (importResponse.status() !== 202 || importBody?.ok !== true) fail('FIRST_RUN_IMPORT_FAILED')
    const runId = importBody.result.runId
    await waitForReviewableRun(async () => {
      const response = await fetch(`${ready.baseUrl}/nobei/v1/runs/${encodeURIComponent(runId)}`, {
        headers: productRequestHeaders(ready.baseUrl),
      })
      const body = await response.json().catch(() => undefined)
      if (response.status !== 200 || body?.ok !== true) fail('FIRST_RUN_READ_FAILED')
      return body.result
    })
    await page.locator('[data-workspace-screen="review"]')
      .waitFor({ state: 'visible', timeout: 30_000 })
    const [runResponse, candidatesResponse] = await Promise.all([
      fetch(`${ready.baseUrl}/nobei/v1/runs/${encodeURIComponent(runId)}`, {
        headers: productRequestHeaders(ready.baseUrl),
      }),
      fetch(`${ready.baseUrl}/nobei/v1/runs/${encodeURIComponent(runId)}/candidates`, {
        headers: productRequestHeaders(ready.baseUrl),
      }),
    ])
    const runBody = await runResponse.json()
    const candidatesBody = await candidatesResponse.json()
    if (runResponse.status !== 200 || candidatesResponse.status !== 200
      || runBody?.ok !== true || candidatesBody?.ok !== true) fail('FIRST_RUN_READ_FAILED')
    const observerRecords = await observerLedger(ready.baseUrl, config.observerToken)
    const screenshotRoot = join(evidenceRoot, 'screenshots')
    await mkdir(screenshotRoot, { recursive: true })
    const screenshotPath = join(screenshotRoot, 'first-run-review.png')
    await page.screenshot({ path: screenshotPath, fullPage: true })
    await browser.close()
    browser = undefined
    await stopProbeDsh(child)

    const coreAttempt = await readCoreAttempt(
      manifest.paths.python ?? config.python,
      join(manifest.paths.dataRoot, 'phase1.db'),
      runId,
    )
    const candidates = candidatesBody.result.candidates.map(candidate => ({
      ...candidate,
      evidence: candidate.evidence.map(item => ({
        ...item,
        startOffset: item.textStart,
        endOffset: item.textEnd,
        alignMethod: 'exact',
      })),
    }))
    const denominator = coreAttempt.schemaValidEvidenceCount
    const exactEvidenceYield = denominator === 0 ? 0 : coreAttempt.exactEvidenceCount / denominator
    const result = assertFirstRunResult({
      importStatus: importResponse.status(),
      displayedModel,
      browserModelSelection: runBody.result.modelSelection,
      coreAttempt,
      observerRecords,
      candidates,
      exactEvidenceYield,
      screenshotPath,
    })
    const rawRun = buildObservedRawRun(fixtureText, coreAttempt, {
      ordinal: 1,
      runId,
      firstAttemptSucceeded: coreAttempt.attemptNumber === 1 && coreAttempt.attemptStatus === 'succeeded',
      finalSucceeded: coreAttempt.attemptStatus === 'succeeded' && coreAttempt.status === 'review_pending',
      providerCalls: observerRecords.length,
      candidateCount: candidates.length,
      schemaValidEvidenceCount: coreAttempt.schemaValidEvidenceCount,
      exactEvidenceCount: coreAttempt.exactEvidenceCount,
      rejectionCounts: coreAttempt.rejectionCounts,
      reviewEvidenceMethods: candidates.flatMap(candidate => candidate.evidence.map(() => 'exact')),
      modelSelection: coreAttempt.modelSelection,
      artifactSha256: request.artifactSha256,
      promptSha256: request.promptSha256,
      schemaSha256: request.schemaSha256,
      fixtureSha256: request.fixtureSha256,
    })
    const providerCalls = observerRecords.map((record, index) => ({
      sequence: index + 1,
      runId,
      attemptNumber: index + 1,
      modelSelection: {
        provider: record.provider,
        model: record.model,
        ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort }),
      },
    }))
    budget = authorization.advanceRealModelBudget(budget, { type: 'complete-run', runId })
    budget = authorization.advanceRealModelBudget(budget, { type: 'first-run-review' })
    await Promise.all([
      writeJsonAtomic(manifest.authorization.budgetPath, budget),
      writeJsonAtomic(join(evidenceRoot, 'first-run.json'), result),
      writeJsonAtomic(join(evidenceRoot, 'raw-runs.json'), [rawRun]),
      writeJsonAtomic(join(evidenceRoot, 'observer-records.json'), providerCalls),
      writeFile(join(evidenceRoot, 'dsh-first-run-output.txt'), output()),
    ])
    process.stdout.write([
      'FIRST_RUN_REVIEW',
      `runId=${runId}`,
      `candidateCount=${candidates.length}`,
      `exactEvidenceYield=${exactEvidenceYield}`,
      `provider=${request.modelSelection.provider}`,
      `model=${request.modelSelection.model}`,
      `reasoningEffort=${request.modelSelection.reasoningEffort ?? 'provider-default'}`,
      `screenshot=${screenshotPath}`,
      `remainingMaxCalls=${21 - budget.actualCalls}`,
      '',
    ].join('\n'))
    return result
  } catch (error) {
    await browser?.close().catch(() => undefined)
    await stopProbeDsh(child).catch(() => child.kill('SIGKILL'))
    await Promise.all([
      writeFile(join(evidenceRoot, 'first-run-error.txt'), `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`),
      writeFile(join(evidenceRoot, 'dsh-first-run-output.txt'), output()),
    ])
    throw error
  }
}

async function productJson(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...productRequestHeaders(baseUrl), ...(init.headers ?? {}) },
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

async function waitForRunTerminal(baseUrl, runId, timeoutMs = 150_000) {
  const started = Date.now()
  do {
    const result = await productJson(baseUrl, `/nobei/v1/runs/${encodeURIComponent(runId)}`)
    const status = result.body?.result?.status
    if (['review_pending', 'completed', 'failed_retryable', 'failed_terminal'].includes(status)) return result
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
  } while (Date.now() - started < timeoutMs)
  fail('PHASE1E_RUN_TIMEOUT')
}

async function executeObservedRun({
  ordinal,
  evidenceRoot,
  manifest,
  config,
  request,
  budget,
  fixture,
  callOffset,
  existingProviderCalls,
  authorization,
}) {
  const env = {
    ...buildAcceptanceEnvironment(process.env, config),
    NOBEI_PHASE1E_OBSERVER_LEDGER_TOKEN: config.observerToken,
    SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 1',
  }
  let child
  let ready
  let runId
  let firstAttemptSucceeded = true
  try {
    child = spawn(manifest.paths.dshPath, ['--profile', manifest.plan.profileName, '--port', '0'], {
      cwd: manifest.paths.runtimeRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    ready = await waitForProbeReady(child)
    await waitForProductReady(ready.baseUrl)
    if ((await observerLedger(ready.baseUrl, config.observerToken)).length !== 0) {
      fail('PHASE1E_PROVIDER_LEDGER_MISMATCH')
    }
    budget = authorization.advanceRealModelBudget(budget, {
      type: 'reserve-call', runId: `ordinal-${ordinal}-attempt-1`,
    })
    await writeJsonAtomic(manifest.authorization.budgetPath, budget)
    const imported = await productJson(ready.baseUrl, '/nobei/v1/imports', {
      method: 'POST',
      body: JSON.stringify({
        filename: PHASE1E_FIXTURE_NAME, mediaType: 'text/markdown', text: fixture,
        modelSelection: request.modelSelection,
      }),
    })
    if (imported.status !== 202 || imported.body?.ok !== true) fail('PHASE1E_IMPORT_FAILED')
    runId = imported.body.result.runId
    let state = await waitForRunTerminal(ready.baseUrl, runId)
    if (state.body?.result?.status === 'failed_retryable') {
      firstAttemptSucceeded = false
      if (budget.retryUsed) fail('PHASE1E_SECOND_FIRST_ATTEMPT_FAILURE')
      budget = authorization.advanceRealModelBudget(budget, {
        type: 'reserve-call', runId: `ordinal-${ordinal}-attempt-2`, retry: true,
      })
      await writeJsonAtomic(manifest.authorization.budgetPath, budget)
      const retried = await productJson(ready.baseUrl, `/nobei/v1/runs/${encodeURIComponent(runId)}/retry`, {
        method: 'POST', body: JSON.stringify({ expectedRevision: state.body.result.revision }),
      })
      if (retried.status !== 202 || retried.body?.ok !== true) fail('PHASE1E_RETRY_FAILED')
      state = await waitForRunTerminal(ready.baseUrl, runId)
    }
    if (state.body?.result?.status !== 'review_pending') fail('PHASE1E_FINAL_SUCCESS_INVALID')
    const candidatesResponse = await productJson(
      ready.baseUrl, `/nobei/v1/runs/${encodeURIComponent(runId)}/candidates`,
    )
    if (candidatesResponse.status !== 200 || candidatesResponse.body?.ok !== true
      || candidatesResponse.body.result.candidates.length < 1) fail('PHASE1E_CANDIDATE_COUNT_INVALID')
    const observed = await observerLedger(ready.baseUrl, config.observerToken)
    const expectedCalls = firstAttemptSucceeded ? 1 : 2
    if (observed.length !== expectedCalls) fail('PHASE1E_PROVIDER_LEDGER_MISMATCH')
    await stopProbeDsh(child)
    child = undefined
    const coreAttempt = await readCoreAttempt(config.python, join(manifest.paths.dataRoot, 'phase1.db'), runId)
    if (coreAttempt.status !== 'review_pending' || coreAttempt.attemptStatus !== 'succeeded') {
      fail('PHASE1E_FINAL_SUCCESS_INVALID')
    }
    const candidates = candidatesResponse.body.result.candidates
    const rawRun = buildObservedRawRun(fixture, coreAttempt, {
      ordinal,
      runId,
      firstAttemptSucceeded,
      finalSucceeded: true,
      providerCalls: observed.length,
      candidateCount: candidates.length,
      schemaValidEvidenceCount: coreAttempt.schemaValidEvidenceCount,
      exactEvidenceCount: coreAttempt.exactEvidenceCount,
      rejectionCounts: coreAttempt.rejectionCounts,
      reviewEvidenceMethods: candidates.flatMap(candidate => candidate.evidence.map(() => 'exact')),
      modelSelection: coreAttempt.modelSelection,
      artifactSha256: request.artifactSha256,
      promptSha256: request.promptSha256,
      schemaSha256: request.schemaSha256,
      fixtureSha256: request.fixtureSha256,
    })
    const newCalls = observed.map((record, index) => ({
      sequence: callOffset + index + 1,
      runId,
      attemptNumber: index + 1,
      modelSelection: {
        provider: record.provider,
        model: record.model,
        ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort }),
      },
    }))
    return {
      rawRun,
      providerCalls: newCalls,
      budget: authorization.advanceRealModelBudget(budget, { type: 'complete-run', runId }),
    }
  } catch (error) {
    if (ready !== undefined) {
      const observed = await observerLedger(ready.baseUrl, config.observerToken).catch(() => [])
      if (observed.length > 0) {
        const failedRunId = runId ?? `ordinal-${ordinal}-unresolved`
        const failedCalls = observed.map((record, index) => ({
          sequence: callOffset + index + 1,
          runId: failedRunId,
          attemptNumber: index + 1,
          modelSelection: {
            provider: record.provider,
            model: record.model,
            ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort }),
          },
        }))
        await writeJsonAtomic(
          join(evidenceRoot, 'observer-records.json'),
          [...existingProviderCalls, ...failedCalls],
        )
      }
    }
    if (child !== undefined) await stopProbeDsh(child).catch(() => child.kill('SIGKILL'))
    budget = authorization.advanceRealModelBudget(budget, { type: 'no-go' })
    await writeJsonAtomic(manifest.authorization.budgetPath, budget)
    await writeFile(
      join(evidenceRoot, 'remaining-error.txt'),
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    )
    throw error
  }
}

async function remainingRuns(evidenceRoot) {
  if (!isAbsolute(evidenceRoot)) fail('PHASE1E_EVIDENCE_ROOT_INVALID')
  const manifest = JSON.parse(await readFile(join(evidenceRoot, 'manifest.json'), 'utf8'))
  const config = JSON.parse(await readFile(manifest.configPath, 'utf8'))
  const authorization = await import('../lib/acceptance/real-model-authorization.js')
  const verifier = await import('./verify-phase1e-real-model.mjs')
  const [requestValue, grantValue, continuation, budgetValue, initialRuns, initialCalls] = await Promise.all([
    readFile(manifest.authorization.requestPath, 'utf8').then(JSON.parse),
    readFile(manifest.authorization.grantPath, 'utf8').then(JSON.parse),
    readFile(manifest.authorization.continuationPath, 'utf8').then(JSON.parse),
    readFile(manifest.authorization.budgetPath, 'utf8').then(JSON.parse),
    readFile(join(evidenceRoot, 'raw-runs.json'), 'utf8').then(JSON.parse),
    readFile(join(evidenceRoot, 'observer-records.json'), 'utf8').then(JSON.parse),
  ])
  const request = authorization.verifyRealModelAuthorizationRequest(requestValue)
  authorization.verifyRealModelGrant(grantValue, request)
  const schemaPath = join(ROOT, 'contracts/l1-candidate.schema.json')
  const fixturePath = join(ROOT, 'acceptance/fixtures', PHASE1E_FIXTURE_NAME)
  const { promptIdentity } = await import('../lib/product/generation-adapter.js')
  const currentHashes = {
    artifactSha256: await sha256File(manifest.artifacts.product.path),
    promptSha256: sha256(Buffer.from(promptIdentity(request.promptVersion), 'utf8')),
    schemaSha256: await sha256File(schemaPath),
    fixtureSha256: await sha256File(fixturePath),
  }
  let budget = budgetValue
  if (budget.state === 'FIRST_RUN_REVIEW') {
    verifier.assertRemainingReady({ budget, continuation, request, currentHashes })
    budget = authorization.advanceRealModelBudget(budget, { type: 'authorize-remaining' })
    await writeJsonAtomic(manifest.authorization.budgetPath, budget)
  } else if (budget.state !== 'REMAINING_RUNS_AUTHORIZED') {
    fail('PHASE1E_REMAINING_STATE_INVALID')
  }
  if (!['artifactSha256', 'promptSha256', 'schemaSha256', 'fixtureSha256']
    .every(key => currentHashes[key] === request[key])) fail('PHASE1E_FROZEN_INPUT_DRIFT')

  const rawRuns = [...initialRuns]
  const providerCalls = [...initialCalls]
  for (const row of rawRuns) {
    if (!budget.completedRunIds.includes(row.runId)) {
      budget = authorization.advanceRealModelBudget(budget, { type: 'complete-run', runId: row.runId })
    }
  }
  if (budget.actualCalls !== providerCalls.length) fail('PHASE1E_UNCERTAIN_CALL_RESERVATION')
  await writeJsonAtomic(manifest.authorization.budgetPath, budget)

  const fixture = await readFile(fixturePath, 'utf8')
  for (let ordinal = 2; ordinal <= 20; ordinal += 1) {
    if (rawRuns.some(row => row.ordinal === ordinal)) continue
    const result = await executeObservedRun({
      ordinal,
      evidenceRoot,
      manifest,
      config,
      request,
      budget,
      fixture,
      callOffset: providerCalls.length,
      existingProviderCalls: providerCalls,
      authorization,
    })
    rawRuns.push(result.rawRun)
    providerCalls.push(...result.providerCalls)
    budget = result.budget
    await Promise.all([
      writeJsonAtomic(join(evidenceRoot, 'raw-runs.json'), rawRuns),
      writeJsonAtomic(join(evidenceRoot, 'observer-records.json'), providerCalls),
      writeJsonAtomic(manifest.authorization.budgetPath, budget),
    ])
  }
  budget = authorization.advanceRealModelBudget(budget, { type: 'complete' })
  await writeJsonAtomic(manifest.authorization.budgetPath, budget)
  const finalResult = await verifier.verifyEvidenceRoot(evidenceRoot)
  process.stdout.write(`${finalResult.status}\n`)
  return finalResult
}

export async function runFlashLowDiagnostic(evidenceRoot) {
  if (!isAbsolute(evidenceRoot)) fail('PHASE1E_EVIDENCE_ROOT_INVALID')
  const manifest = JSON.parse(await readFile(join(evidenceRoot, 'manifest.json'), 'utf8'))
  if (manifest.phase !== 'phase1e-real-model'
    || manifest.batchPolicy !== 'flash-low-stability') fail('PHASE1E_BATCH_POLICY_MISMATCH')
  const config = JSON.parse(await readFile(manifest.configPath, 'utf8'))
  const authorization = await import('../lib/acceptance/real-model-authorization.js')
  const verifier = await import('./verify-phase1e-real-model.mjs')
  const [requestValue, grantValue, budgetValue, initialRuns, initialCalls] = await Promise.all([
    readFile(manifest.authorization.requestPath, 'utf8').then(JSON.parse),
    readFile(manifest.authorization.grantPath, 'utf8').then(JSON.parse),
    readFile(manifest.authorization.budgetPath, 'utf8').then(JSON.parse),
    readFile(join(evidenceRoot, 'raw-runs.json'), 'utf8').then(JSON.parse),
    readFile(join(evidenceRoot, 'observer-records.json'), 'utf8').then(JSON.parse),
  ])
  const request = authorization.verifyRealModelAuthorizationRequest(requestValue)
  authorization.verifyRealModelGrant(grantValue, request)
  if (request.batchPolicy !== 'flash-low-stability') fail('PHASE1E_BATCH_POLICY_MISMATCH')

  const schemaPath = join(ROOT, 'contracts/l1-candidate.schema.json')
  const fixturePath = join(ROOT, 'acceptance/fixtures', PHASE1E_FIXTURE_NAME)
  const { promptIdentity } = await import('../lib/product/generation-adapter.js')
  const currentHashes = {
    artifactSha256: await sha256File(manifest.artifacts.product.path),
    promptSha256: sha256(Buffer.from(promptIdentity(request.promptVersion), 'utf8')),
    schemaSha256: await sha256File(schemaPath),
    fixtureSha256: await sha256File(fixturePath),
  }
  if (!['artifactSha256', 'promptSha256', 'schemaSha256', 'fixtureSha256']
    .every(key => currentHashes[key] === request[key])) fail('PHASE1E_FROZEN_INPUT_DRIFT')

  const rawRuns = [...initialRuns]
  const providerCalls = [...initialCalls]
  let budget = budgetValue
  if (budget.requestDigest !== request.requestDigest
    || budget.batchPolicy !== request.batchPolicy
    || budget.actualRuns !== rawRuns.length
    || budget.actualCalls !== providerCalls.length
    || !rawRuns.every((row, index) => budget.completedRunIds[index] === row.runId)) {
    fail('PHASE1E_DIAGNOSTIC_RESUME_INVALID')
  }
  if (budget.state === 'NO_GO' || budget.state === 'COMPLETE') {
    const terminal = await verifier.verifyEvidenceRoot(evidenceRoot)
    process.stdout.write(`${terminal.status}\n`)
    return terminal
  }
  if (budget.state === 'AWAITING_AUTHORIZATION') {
    budget = authorization.advanceRealModelBudget(budget, { type: 'authorize-batch' })
    await writeJsonAtomic(manifest.authorization.budgetPath, budget)
  } else if (budget.state !== 'BATCH_AUTHORIZED') {
    fail('PHASE1E_DIAGNOSTIC_STATE_INVALID')
  }

  const fixture = await readFile(fixturePath, 'utf8')
  for (let ordinal = rawRuns.length + 1; ordinal <= request.maxRuns; ordinal += 1) {
    try {
      const result = await executeObservedRun({
        ordinal,
        evidenceRoot,
        manifest,
        config,
        request,
        budget,
        fixture,
        callOffset: providerCalls.length,
        existingProviderCalls: providerCalls,
        authorization,
      })
      rawRuns.push(result.rawRun)
      providerCalls.push(...result.providerCalls)
      budget = result.budget
      await Promise.all([
        writeJsonAtomic(join(evidenceRoot, 'raw-runs.json'), rawRuns),
        writeJsonAtomic(join(evidenceRoot, 'observer-records.json'), providerCalls),
        writeJsonAtomic(manifest.authorization.budgetPath, budget),
      ])
    } catch (error) {
      const terminal = await verifier.verifyEvidenceRoot(evidenceRoot).catch(() => undefined)
      if (terminal !== undefined) {
        process.stdout.write(`${terminal.status}\n`)
        return terminal
      }
      throw error
    }
  }
  budget = authorization.advanceRealModelBudget(budget, { type: 'complete' })
  await writeJsonAtomic(manifest.authorization.budgetPath, budget)
  const finalResult = await verifier.verifyEvidenceRoot(evidenceRoot)
  process.stdout.write(`${finalResult.status}\n`)
  return finalResult
}

export function parseAcceptanceCommand(argv) {
  const args = argv.filter(argument => argument !== '--')
  const [mode, flag, value] = args
  if (mode === 'prepare' && args.length === 1) {
    return { mode: 'prepare', batchPolicy: 'gate5-full' }
  }
  if (mode === 'prepare' && args.length === 3 && flag === '--batch-policy') {
    try {
      policyFor(value)
    } catch {
      fail('PHASE1E_BATCH_POLICY_INVALID')
    }
    return { mode: 'prepare', batchPolicy: value }
  }
  if (mode === 'first-run' && flag === '--evidence-root' && isAbsolute(value ?? '')) {
    return { mode: 'first-run', evidenceRoot: value }
  }
  if (mode === 'remaining' && flag === '--evidence-root' && isAbsolute(value ?? '')) {
    return { mode: 'remaining', evidenceRoot: value }
  }
  if (mode === 'diagnostic' && flag === '--evidence-root' && isAbsolute(value ?? '')) {
    return { mode: 'diagnostic', evidenceRoot: value }
  }
  if (mode === 'recover-first-run' && args.length === 9) {
    const values = new Map()
    for (let index = 1; index < args.length; index += 2) values.set(args[index], args[index + 1])
    return {
      mode: 'recover-first-run',
      evidenceRoot: values.get('--evidence-root'),
      runId: values.get('--run-id'),
      sessionLogPath: values.get('--session-log'),
      screenshotPath: values.get('--screenshot'),
    }
  }
  fail('usage: accept-phase1e-real-model.mjs prepare [--batch-policy gate5-full|flash-low-stability] | first-run --evidence-root <absolute> | recover-first-run --evidence-root <absolute> --run-id <id> --session-log <absolute> --screenshot <absolute> | remaining --evidence-root <absolute> | diagnostic --evidence-root <absolute>')
}

async function main(argv) {
  const command = parseAcceptanceCommand(argv)
  if (command.mode === 'prepare') return prepare(command.batchPolicy)
  if (command.mode === 'first-run') return firstRun(command.evidenceRoot)
  if (command.mode === 'remaining') return remainingRuns(command.evidenceRoot)
  if (command.mode === 'diagnostic') return runFlashLowDiagnostic(command.evidenceRoot)
  return recoverFirstRun(
    command.evidenceRoot,
    command.runId,
    command.sessionLogPath,
    command.screenshotPath,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
