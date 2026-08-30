#!/usr/bin/env node
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createWorkspacePolicy, CRITICAL_PROFILE_PACKAGES } from './dsh-topology.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const RC7 = '0.1.0-rc.7'
const COREPACK = '/usr/local/bin/corepack'
const PLUGIN_NAME = '@nobei/phase1e-model-propagation-runtime'
const FAKE_LEDGER_PATH = '/nobei-acceptance/fake-provider-ledger'

function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolvePromise(output) : reject(new Error(`COMMAND_FAILED:${args.join(' ')}\n${output}`)))
  })
}

const RUNTIME_PLUGIN = String.raw`
import { writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

export const name = 'nobei-phase1e-model-propagation-runtime'
export const inject = ['agents', 'workflowEngine']
const script = 'const value = await agent(args.prompt)\nreturn value'
const runs = [
  { id: 'run-a', provider: 'fake-a', model: 'model-a', reasoningEffort: 'low', expectedEffort: 'low', install: true },
  { id: 'run-b', provider: 'fake-b', model: 'model-b', reasoningEffort: 'high', expectedEffort: 'high', install: true },
  { id: 'run-c', provider: 'fake-c', model: 'model-c', expectedEffort: undefined, install: true },
  { id: 'run-d-negative-control', provider: 'fake-b', model: 'model-b', expectedEffort: 'low', install: false },
]
function own(value, key) { return Object.hasOwn(value, key) }
function snapshot(spec, effort = spec.reasoningEffort) {
  return { provider: spec.provider, model: spec.model, ...(effort === undefined ? {} : { reasoningEffort: String(effort) }) }
}
function selection(spec) {
  return { current: { provider: spec.provider, model: spec.model, ...(spec.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(spec.reasoningEffort) }) }, assembled: undefined }
}
function hard(condition, code) { if (!condition) throw new Error(code) }
function assertCompleted(result) {
  hard(result.stopReason === 'completed' && result.agentsStarted === 1, 'MODEL_SELECTION_PROPAGATION_MISMATCH')
}
function assertConcurrentListenerMatrix(a, b) {
  const aOwned = a.events.filter((row) => row.ownedByParent)
  const bOwned = b.events.filter((row) => row.ownedByParent)
  hard(aOwned.length === 1 && bOwned.length === 1, 'SPAWN_CHILD_NOT_OWNED')
  const targetChildIds = new Set([...aOwned, ...bOwned].map((row) => row.childId))
  hard(targetChildIds.size === 2, 'MODEL_SELECTION_PROPAGATION_MISMATCH')
  const aTargets = a.events.filter((row) => targetChildIds.has(row.childId))
  const bTargets = b.events.filter((row) => targetChildIds.has(row.childId))
  const aTargetIds = new Set(aTargets.map((row) => row.childId))
  const bTargetIds = new Set(bTargets.map((row) => row.childId))
  hard(aTargets.length === 2 && bTargets.length === 2, 'MODEL_SELECTION_PROPAGATION_MISMATCH')
  hard(aTargetIds.size === 2 && bTargetIds.size === 2, 'MODEL_SELECTION_PROPAGATION_MISMATCH')
  hard([...targetChildIds].every((id) => aTargetIds.has(id) && bTargetIds.has(id)), 'MODEL_SELECTION_PROPAGATION_MISMATCH')
  const aUnowned = aTargets.filter((row) => !row.ownedByParent)
  const bUnowned = bTargets.filter((row) => !row.ownedByParent)
  hard(aUnowned.length === 1 && bUnowned.length === 1, 'MODEL_SELECTION_PROPAGATION_MISMATCH')
  const aInstalled = aTargets.filter((row) => row.selectionInstalled)
  const bInstalled = bTargets.filter((row) => row.selectionInstalled)
  hard(aInstalled.length === 1 && bInstalled.length === 1, 'MODEL_SELECTION_PROPAGATION_MISMATCH')
  hard(aInstalled[0].ownedByParent && bInstalled[0].ownedByParent, 'MODEL_SELECTION_PROPAGATION_MISMATCH')
  hard(aOwned[0].childId !== bOwned[0].childId, 'MODEL_SELECTION_PROPAGATION_MISMATCH')
  hard(aOwned[0].childId === bUnowned[0].childId && bOwned[0].childId === aUnowned[0].childId, 'MODEL_SELECTION_PROPAGATION_MISMATCH')
}
async function createRun(ctx, spec, checkpoint) {
  const requested = snapshot(spec)
  const expectedStream = snapshot(spec, spec.expectedEffort)
  const parent = await ctx.agents.create({
    sessionId: SessionId('nobei-phase1e-' + spec.id),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: spec.provider, model: spec.model, maxTokens: 2048 },
    setup(agentCtx) { if (spec.install) installModelSelection(agentCtx, selection(spec)) },
  })
  const events = []
  const stop = ctx.on('agent/created', ({ agent: child }) => {
    const ownedByParent = ctx.agents.isOwnedBy(child.id, parent.agent)
    const selectionInstalled = ownedByParent && spec.install
    if (selectionInstalled) installModelSelection(child.ctx, selection(spec))
    events.push({ childId: child.id, ownedByParent, selectionInstalled })
    checkpoint('agent-created-observed', { runId: spec.id, childId: child.id, ownedByParent, selectionInstalled })
  })
  checkpoint('parent-created', { runId: spec.id, parentId: parent.agent.id })
  return { spec, parent, requested, expectedStream, events, stop, workflow: undefined }
}
function startRun(ctx, state, checkpoint) {
  checkpoint('workflow-start-call', { runId: state.spec.id })
  state.workflow = ctx.workflowEngine.start({
    script,
    meta: { name: 'nobei-phase1e-' + state.spec.id, description: 'Fake-only rc.7 model selection propagation.' },
    args: { prompt: 'Phase 1E model selection propagation ' + state.spec.id },
    parent: state.parent.agent,
    subagentProvider: 'spawn', maxTotalAgents: 1,
  })
  return state.workflow
}
function claim(state) {
  const owned = state.events.filter((row) => row.ownedByParent)
  hard(owned.length === 1, 'SPAWN_CHILD_NOT_OWNED')
  return {
    runId: state.spec.id,
    parentId: state.parent.agent.id,
    childId: owned[0].childId,
    ownedByParent: owned[0].ownedByParent,
    selectionInstalled: owned[0].selectionInstalled,
    requested: state.requested,
    expectedStream: state.expectedStream,
    listenerEvents: state.events,
  }
}
async function disposeRun(state) {
  await Promise.allSettled([state.workflow?.dispose(), state.parent.dispose()])
  state.stop()
}
export async function apply(ctx) {
  const diagnostics = []
  const checkpoint = (stage, detail = {}) => {
    diagnostics.push({ sequence: diagnostics.length + 1, stage, ...detail })
    writeFileSync(process.env.NOBEI_PHASE1E_DIAGNOSTIC, JSON.stringify(diagnostics) + '\\n')
  }
  checkpoint('apply-entered')
  const claims = []
  try {
    let a
    let b
    try {
      a = await createRun(ctx, runs[0], checkpoint)
      b = await createRun(ctx, runs[1], checkpoint)
      const aWorkflow = startRun(ctx, a, checkpoint)
      const bWorkflow = startRun(ctx, b, checkpoint)
      const results = await Promise.all([aWorkflow.result, bWorkflow.result])
      results.forEach(assertCompleted)
      assertConcurrentListenerMatrix(a, b)
      claims.push(claim(a), claim(b))
    } finally {
      if (b) await disposeRun(b)
      if (a) await disposeRun(a)
    }
    for (const spec of runs.slice(2)) {
      let state
      try {
        state = await createRun(ctx, spec, checkpoint)
        const workflow = startRun(ctx, state, checkpoint)
        assertCompleted(await workflow.result)
        claims.push(claim(state))
      } finally {
        if (state) await disposeRun(state)
      }
    }
    checkpoint('listener-claims-complete', { count: claims.length })
    await writeFile(process.env.NOBEI_PHASE1E_OUTPUT, JSON.stringify({ rc7: '${RC7}', realProviderCalls: 0, claims }) + '\n')
  } catch (error) {
    await writeFile(process.env.NOBEI_PHASE1E_OUTPUT, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n')
    throw error
  }
}
`

async function writeRuntimePlugin(root) {
  const packageRoot = join(root, 'plugin')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: PLUGIN_NAME, version: '0.0.0', private: true, type: 'module', main: 'index.mjs',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: {
      '@deepseek-ai/cordis': '4.0.1', '@deepseek-ai/dsh-agent': RC7, '@deepseek-ai/dsh-llm': RC7,
      '@deepseek-ai/dsh-session': RC7, '@deepseek-ai/dsh-workflow': RC7,
    },
  }, null, 2)}\n`)
  await writeFile(join(packageRoot, 'index.mjs'), RUNTIME_PLUGIN)
  await writeFile(join(packageRoot, 'cordis.patch.yml'), '- id: llm-deepseek\n  disabled: true\n- id: llm-pi-ai\n  disabled: true\n- id: subagent-spawn-in-process\n  config:\n    providerName: spawn\n  disabled: false\n- id: workflow-worker-thread\n  config:\n    provider: spawn\n    maxConcurrentAgents: 1\n    maxTotalAgents: 1\n    maxItemsPerCall: 1\n    syncTimeoutMs: 1000\n    disposeGraceMs: 1000\n  disabled: false\n- insert:\n    - id: nobei-phase1e-model-propagation-runtime\n      name: "@nobei/phase1e-model-propagation-runtime"\n      config: {}\n')
  await run('/usr/local/bin/npm', ['pack', '--pack-destination', root], { cwd: packageRoot, env: process.env })
  return join(root, 'nobei-phase1e-model-propagation-runtime-0.0.0.tgz')
}

async function assertPackedMain(tarball, env) {
  const paths = await run('/usr/bin/tar', ['-tzf', tarball], { cwd: ROOT, env })
  if (!paths.split('\n').includes('package/lib/index.js')) throw new Error('FAKE_PROVIDER_PACKED_MAIN_MISSING')
}

async function buildFakeProviderFromSource(root, env) {
  const packageRoot = join(root, 'fake-provider-package')
  const sourceRoot = join(ROOT, 'acceptance', 'fake-provider')
  await mkdir(packageRoot, { recursive: true })
  await Promise.all([
    copyFile(join(sourceRoot, 'package.json'), join(packageRoot, 'package.json')),
    copyFile(join(sourceRoot, 'cordis.patch.yml'), join(packageRoot, 'cordis.patch.yml')),
  ])
  await run(join(ROOT, 'node_modules', '.bin', 'tsc'), [
    '-p', join(sourceRoot, 'tsconfig.build.json'),
    '--outDir', join(packageRoot, 'lib'),
    '--declarationDir', join(packageRoot, 'lib', 'types'),
  ], { cwd: ROOT, env })
  const packed = await run('/usr/local/bin/npm', ['pack', '--pack-destination', root], { cwd: packageRoot, env })
  const name = packed.trim().split('\n').map((line) => line.trim()).findLast((line) => line.endsWith('.tgz'))
  if (name === undefined) throw new Error('FAKE_PROVIDER_PACK_FAILED')
  const tarball = join(root, name)
  await assertPackedMain(tarball, env)
  return tarball
}

function own(value, key) { return Object.hasOwn(value, key) }
function snapshot(value) {
  return {
    provider: String(value.provider),
    model: String(value.model),
    ...(own(value, 'reasoningEffort') ? { reasoningEffort: String(value.reasoningEffort) } : {}),
  }
}
function sameSnapshot(left, right) {
  return left.provider === right.provider && left.model === right.model
    && own(left, 'reasoningEffort') === own(right, 'reasoningEffort')
    && left.reasoningEffort === right.reasoningEffort
}
function hard(condition, code) { if (!condition) throw new Error(code) }
function closeLedgerBackedRows(runtime, ledger) {
  hard(Array.isArray(runtime.claims) && Array.isArray(ledger.records), 'MODEL_SELECTION_PROPAGATION_MISMATCH')
  hard(runtime.claims.length === 4 && ledger.records.length === 4, 'MODEL_SELECTION_PROPAGATION_MISMATCH')
  const availableRecordIndexes = new Set(ledger.records.keys())
  const rows = runtime.claims.map(({ runId, parentId, childId, ownedByParent, selectionInstalled, requested, expectedStream }) => {
    const matches = [...availableRecordIndexes].filter((index) => {
      const record = ledger.records[index]
      return record.result === 'text' && sameSnapshot(snapshot(record), expectedStream)
    })
    hard(matches.length === 1, 'MODEL_SELECTION_PROPAGATION_MISMATCH')
    const observed = snapshot(ledger.records[matches[0]])
    availableRecordIndexes.delete(matches[0])
    return { runId, parentId, childId, ownedByParent, selectionInstalled, requested, expectedStream, observed }
  })
  hard(availableRecordIndexes.size === 0, 'MODEL_SELECTION_PROPAGATION_MISMATCH')
  return rows
}
function assertLedgerBackedRows(rows) {
  hard(rows.length === 4, 'MODEL_SELECTION_PROPAGATION_MISMATCH')
  const byRun = new Map(rows.map((row) => [row.runId, row]))
  const a = byRun.get('run-a')
  const b = byRun.get('run-b')
  const c = byRun.get('run-c')
  const d = byRun.get('run-d-negative-control')
  hard(a?.ownedByParent && a.selectionInstalled && sameSnapshot(a.requested, a.expectedStream) && sameSnapshot(a.expectedStream, a.observed) && a.observed.reasoningEffort === 'low', 'MODEL_SELECTION_PROPAGATION_MISMATCH')
  hard(b?.ownedByParent && b.selectionInstalled && sameSnapshot(b.requested, b.expectedStream) && sameSnapshot(b.expectedStream, b.observed) && b.observed.reasoningEffort === 'high', 'MODEL_SELECTION_PROPAGATION_MISMATCH')
  hard(c?.ownedByParent && c.selectionInstalled && sameSnapshot(c.requested, c.expectedStream) && sameSnapshot(c.expectedStream, c.observed) && !own(c.observed, 'reasoningEffort'), 'MODEL_SELECTION_PROPAGATION_MISMATCH')
  hard(d?.ownedByParent && !d.selectionInstalled && sameSnapshot(d.expectedStream, d.observed) && d.observed.reasoningEffort === 'low', 'MODEL_SELECTION_PROPAGATION_MISMATCH')
  hard(b.observed.provider === d.observed.provider && b.observed.model === d.observed.model && b.observed.reasoningEffort !== d.observed.reasoningEffort, 'MODEL_SELECTION_PROPAGATION_MISMATCH')
}

async function readRuntimeResult(outputPath) {
  let contents
  try { contents = await readFile(outputPath, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  try { return JSON.parse(contents) } catch (error) {
    throw new Error(`PHASE1E_RESULT_INVALID:${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}
async function waitForResult(outputPath, diagnosticPath, child, output) {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const result = await readRuntimeResult(outputPath)
    if (result !== undefined) return result
    if (child.exitCode !== null) throw new Error(`PHASE1E_RUNTIME_EXITED\n${output()}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  let diagnostic = 'PHASE1E_RUNTIME_DIAGNOSTIC_UNAVAILABLE'
  try { diagnostic = await readFile(diagnosticPath, 'utf8') } catch { /* plugin did not enter */ }
  throw new Error(`PHASE1E_RUNTIME_TIMEOUT\nPHASE1E_RUNTIME_DIAGNOSTIC\n${diagnostic}\n${output()}`)
}
async function waitForReady(child, output) {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const matches = [...output().matchAll(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/g)]
    if (matches.length === 1) return matches[0][1]
    if (matches.length > 1 || child.exitCode !== null) throw new Error(`DSH_READINESS_LINE_INVALID\n${output()}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`DSH_READY_TIMEOUT\n${output()}`)
}
async function readFakeLedger(baseUrl, ledgerToken) {
  const response = await fetch(`${baseUrl}${FAKE_LEDGER_PATH}`, { headers: { authorization: `Bearer ${ledgerToken}` } })
  if (response.status !== 200) throw new Error(`FAKE_LEDGER_FAILED:${response.status}`)
  return response.json()
}
async function inspectSpawnDriverProvenance(profileRoot) {
  const profileRequire = createRequire(join(profileRoot, 'package.json'))
  const spawnProviderManifestPath = profileRequire.resolve('@deepseek-ai/dsh-subagent-spawn-in-process/package.json')
  const spawnProviderManifest = JSON.parse(await readFile(spawnProviderManifestPath, 'utf8'))
  if (spawnProviderManifest.version !== RC7) throw new Error(`SPAWN_PROVIDER_VERSION_MISMATCH:${spawnProviderManifest.version}`)
  const providerRequire = createRequire(spawnProviderManifestPath)
  const driverManifestPath = providerRequire.resolve('@deepseek-ai/dsh-subagent-in-process-driver/package.json')
  const driverManifest = JSON.parse(await readFile(driverManifestPath, 'utf8'))
  if (driverManifest.version !== RC7) throw new Error(`IN_PROCESS_DRIVER_VERSION_MISMATCH:${driverManifest.version}`)
  return { spawnProvider: spawnProviderManifest.version, inProcessDriver: driverManifest.version, driverManifestPath }
}

async function main() {
  const temporary = await mkdtemp('/tmp/nobei-phase1e-runtime-')
  let dsh
  let dshOutput = ''
  let succeeded = false
  try {
    const runtimeRoot = join(temporary, 'runtime')
    const dshHome = join(temporary, 'dsh-home')
    const userHome = join(temporary, 'user-home')
    const profileRoot = join(dshHome, 'profiles', 'nobei')
    const pinset = JSON.parse(await readFile(join(ROOT, 'config/dsh-rc7-pins.json'), 'utf8'))
    const policy = createWorkspacePolicy(pinset)
    await run('/bin/mkdir', ['-p', runtimeRoot, dshHome, userHome], { cwd: temporary, env: process.env })
    await Promise.all([
      writeFile(join(runtimeRoot, 'package.json'), JSON.stringify({ name: 'nobei-phase1e-runtime', private: true })),
      writeFile(join(runtimeRoot, 'pnpm-workspace.yaml'), policy),
      writeFile(join(dshHome, 'pnpm-workspace.yaml'), policy),
    ])
    const ledgerToken = randomBytes(32).toString('hex')
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: userHome, DSH_HOME: dshHome,
      LANG: 'C', LC_ALL: 'C', DSH_TELEMETRY_MODE: 'DISABLED', DSH_TOOLS_MODE: 'native',
      NOBEI_PHASE1C_FAKE_LEDGER_TOKEN: ledgerToken,
    }
    for (const key of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key]
    await run(COREPACK, ['pnpm@11.23.0', 'add', '--save-exact', '--config.auto-install-peers=true', `@deepseek-ai/dsh@${RC7}`], { cwd: runtimeRoot, env })
    const dshBinary = join(runtimeRoot, 'node_modules', '.bin', 'dsh')
    await run(dshBinary, ['plugin', '--profile', 'nobei', 'add', `@deepseek-ai/dsh-web-app@${RC7}`], { cwd: runtimeRoot, env })
    await writeFile(join(profileRoot, 'pnpm-workspace.yaml'), policy)
    await run('/usr/local/bin/pnpm', ['add', '--save-exact', '--config.auto-install-peers=true', ...CRITICAL_PROFILE_PACKAGES.map((name) => `${name}@${RC7}`)], { cwd: profileRoot, env })
    const fakeTarball = await buildFakeProviderFromSource(temporary, env)
    await run(dshBinary, ['plugin', '--profile', 'nobei', 'add', fakeTarball, '--prefer-offline'], { cwd: runtimeRoot, env })
    const provenance = await inspectSpawnDriverProvenance(profileRoot)
    const tarball = await writeRuntimePlugin(temporary)
    env.NOBEI_PHASE1E_OUTPUT = join(temporary, 'result.json')
    env.NOBEI_PHASE1E_DIAGNOSTIC = join(temporary, 'diagnostic.json')
    await run(dshBinary, ['plugin', '--profile', 'nobei', 'add', tarball, '--prefer-offline'], { cwd: runtimeRoot, env })
    dsh = spawn(dshBinary, ['--profile', 'nobei', '--port', '0'], { cwd: runtimeRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    dsh.stdout.setEncoding('utf8'); dsh.stderr.setEncoding('utf8')
    dsh.stdout.on('data', (chunk) => { dshOutput += chunk })
    dsh.stderr.on('data', (chunk) => { dshOutput += chunk })
    const [runtime, baseUrl] = await Promise.all([
      waitForResult(env.NOBEI_PHASE1E_OUTPUT, env.NOBEI_PHASE1E_DIAGNOSTIC, dsh, () => dshOutput),
      waitForReady(dsh, () => dshOutput),
    ])
    if (runtime.error) throw new Error(runtime.error)
    if (runtime.realProviderCalls !== 0) throw new Error('REAL_PROVIDER_CALL_FORBIDDEN')
    const ledger = await readFakeLedger(baseUrl, ledgerToken)
    const rows = closeLedgerBackedRows(runtime, ledger)
    assertLedgerBackedRows(rows)
    process.stdout.write(`${JSON.stringify({ provenance, baseUrl, realProviderCalls: 0, rows })}\nMODEL_SELECTION_PROPAGATION_SPIKE_GO\n`)
    succeeded = true
  } finally {
    if (dsh && dsh.exitCode === null) dsh.kill('SIGTERM')
    if (succeeded) await rm(temporary, { recursive: true, force: true })
    else process.stderr.write(`PHASE1E_DIAGNOSTIC_ROOT:${temporary}\n`)
  }
}

main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
