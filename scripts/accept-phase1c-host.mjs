#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { CLIENT_SEAM_PACKAGES, CRITICAL_PROFILE_PACKAGES, createWorkspacePolicy } from './dsh-topology.mjs'

const execFileAsync = promisify(execFile)
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const RC7 = '0.1.0-rc.7'
const PNPM = '/usr/local/bin/corepack'
const PROFILE_PNPM = '/usr/local/bin/pnpm'
const PYTHON = '/opt/homebrew/bin/python3.12'
const ROUTING_ENV = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
  'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY', 'npm_config_proxy',
  'npm_config_https_proxy', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY',
]
export const FAKE_MODEL_SELECTION = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
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
    throw new Error(`COMMAND_FAILED: ${argv.join(' ')}\n${error?.stdout ?? ''}\n${error?.stderr ?? ''}`, { cause: error })
  }
}

export function buildAcceptanceEnvironment(source, config) {
  const env = {
    PATH: source.PATH ?? dirname(process.execPath),
    ...(typeof source.COREPACK_HOME === 'string' && source.COREPACK_HOME !== ''
      ? { COREPACK_HOME: source.COREPACK_HOME }
      : {}),
    ...(typeof source.PNPM_CONFIG_REGISTRY === 'string' && source.PNPM_CONFIG_REGISTRY !== ''
      ? { PNPM_CONFIG_REGISTRY: source.PNPM_CONFIG_REGISTRY }
      : {}),
    HOME: config.home,
    DSH_HOME: config.dshHome,
    LANG: 'C',
    LC_ALL: 'C',
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_TOOLS_MODE: 'native',
    NOBEI_PHASE1C_PYTHON_EXECUTABLE: config.python,
    NOBEI_PHASE1C_DATA_ROOT: config.dataRoot,
    NOBEI_PHASE1C_OWNERSHIP_TOKEN: config.ownershipToken,
    NOBEI_PHASE1C_FAKE_LEDGER_TOKEN: config.ledgerToken,
  }
  for (const key of ROUTING_ENV) delete env[key]
  return env
}

export function acceptanceRegistryConfig(source) {
  return typeof source.PNPM_CONFIG_REGISTRY === 'string' && source.PNPM_CONFIG_REGISTRY !== ''
    ? `registry=${source.PNPM_CONFIG_REGISTRY}\n`
    : undefined
}

export function parseDshReadyUrl(output) {
  const matches = [...output.matchAll(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/g)]
  if (matches.length !== 1) throw new Error('DSH_READINESS_LINE_INVALID')
  return matches[0][1]
}

export function productRequestHeaders(baseUrl) {
  return {
    origin: baseUrl,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  }
}

export function descendantPidsFromProcessTable(table, rootPid) {
  const rows = table.split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+/.exec(line)
    return match ? { pid: Number(match[1]), ppid: Number(match[2]) } : undefined
  }).filter(Boolean)
  const found = []
  const parents = [rootPid]
  for (let index = 0; index < parents.length; index += 1) {
    for (const row of rows) {
      if (row.ppid === parents[index] && !found.includes(row.pid)) {
        found.push(row.pid)
        parents.push(row.pid)
      }
    }
  }
  return found.sort((left, right) => left - right)
}

export function assertAcceptanceProfileLayers(productPackage, acceptancePackage) {
  const product = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@nobei/dsh-phase1']
  const acceptance = [...product, '@nobei/dsh-phase1c-fake-provider']
  if (product.some((name) => typeof productPackage?.dependencies?.[name] !== 'string')
    || productPackage?.dependencies?.['@nobei/dsh-phase1c-fake-provider'] !== undefined) {
    throw new Error('PRODUCT_PROFILE_LAYER_INVALID')
  }
  if (acceptance.some((name) => typeof acceptancePackage?.dependencies?.[name] !== 'string')) {
    throw new Error('ACCEPTANCE_PROFILE_LAYER_INVALID')
  }
  return { product, acceptance }
}

async function descendantPids(rootPid) {
  const { stdout } = await run(['/bin/ps', '-axo', 'pid=,ppid=,command='])
  return descendantPidsFromProcessTable(stdout, rootPid)
}

function pidExists(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function jsonRequest(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...productRequestHeaders(baseUrl), ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { status: response.status, body }
}

export async function waitForReady(child, timeoutMs = 90_000) {
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const matches = [...output.matchAll(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/g)]
    if (matches.length === 1) return { baseUrl: matches[0][1], output: () => output }
    if (child.exitCode !== null) throw new Error(`DSH_EXITED_BEFORE_READY\n${output}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`DSH_READY_TIMEOUT\n${output}`)
}

export async function stopDsh(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('DSH_STOP_TIMEOUT')), 15_000)),
  ])
}

async function installedPackageVersion(profileRoot, packageName) {
  const packagePath = join(profileRoot, 'node_modules', ...packageName.split('/'), 'package.json')
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  return packageJson.version
}

export function resolveAcceptanceFormalDataDirectory(source = process.env) {
  const configured = source.NOBEI_FORMAL_DATA_DIRECTORY
  if (configured !== undefined) {
    if (typeof configured !== 'string' || !isAbsolute(configured)) {
      throw new Error('FORMAL_DATA_DIRECTORY_INVALID')
    }
    return configured
  }
  return join(ROOT, 'acceptance', 'formal-data-sentinel')
}

async function formalDataDirectory() {
  return resolveAcceptanceFormalDataDirectory()
}

export async function prepareAcceptanceRuntime({
  phase = 'phase1c-host',
  evidenceKind = 'host',
} = {}) {
  const evidenceRoot = join(ROOT, 'evidence', evidenceKind, stamp())
  const artifacts = join(evidenceRoot, 'artifacts')
  await mkdir(artifacts, { recursive: true })
  await run([PNPM, 'pnpm@11.23.0', 'build'], { cwd: ROOT, env: process.env })
  await run([PNPM, 'pnpm@11.23.0', '--filter', '@nobei/dsh-phase1c-fake-provider', 'build'], { cwd: ROOT, env: process.env })
  await run([PNPM, 'pnpm@11.23.0', 'pack', '--pack-destination', join(ROOT, 'dist')], { cwd: ROOT, env: process.env })
  await run([PNPM, 'pnpm@11.23.0', '--filter', '@nobei/dsh-phase1c-fake-provider', 'pack', '--pack-destination', join(ROOT, 'acceptance/fake-provider/dist')], { cwd: ROOT, env: process.env })

  const productTarball = join(artifacts, 'nobei-dsh-phase1-0.0.0.tgz')
  const fakeTarball = join(artifacts, 'nobei-dsh-phase1c-fake-provider-0.0.0.tgz')
  await copyFile(join(ROOT, 'dist', 'nobei-dsh-phase1-0.0.0.tgz'), productTarball)
  await copyFile(join(ROOT, 'acceptance/fake-provider/dist', 'nobei-dsh-phase1c-fake-provider-0.0.0.tgz'), fakeTarball)

  const temporaryPrefix = phase === 'phase1d-client' ? 'nobei-phase1d' : 'nobei-phase1c'
  const [runtimeRoot, dshHome, home, dataRoot, venvRoot] = await Promise.all([
    mkdtemp(`/tmp/${temporaryPrefix}-runtime-`), mkdtemp(`/tmp/${temporaryPrefix}-dsh-`),
    mkdtemp(`/tmp/${temporaryPrefix}-home-`), mkdtemp(`/tmp/${temporaryPrefix}-data-`),
    mkdtemp(`/tmp/${temporaryPrefix}-venv-`),
  ])
  await run([PYTHON, '-m', 'venv', venvRoot])
  const python = join(venvRoot, 'bin', 'python')
  await run([python, '-m', 'pip', 'install', '-r', join(ROOT, 'python/requirements-phase1.lock')])
  const config = {
    home, dshHome, python, dataRoot,
    ownershipToken: randomBytes(32).toString('hex'),
    ledgerToken: randomBytes(32).toString('hex'),
  }
  const env = buildAcceptanceEnvironment(process.env, config)
  const registryConfig = acceptanceRegistryConfig(process.env)
  if (registryConfig !== undefined) {
    await writeFile(join(home, '.npmrc'), registryConfig, { mode: 0o600 })
  }
  const configPath = join(runtimeRoot, 'acceptance-private-config.json')
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 })
  await run([
    python, '-c',
    'import sys; from nobei_core.ownership import initialize_owned_root; initialize_owned_root(sys.argv[1], sys.argv[2])',
    dataRoot, config.ownershipToken,
  ], { cwd: ROOT, env: { ...env, PYTHONPATH: join(ROOT, 'python') } })
  await writeFile(join(runtimeRoot, 'package.json'), `${JSON.stringify({ name: `${temporaryPrefix}-runtime`, private: true }, null, 2)}\n`)
  const pinset = JSON.parse(await readFile(join(ROOT, 'config/dsh-rc7-pins.json'), 'utf8'))
  const policy = createWorkspacePolicy(pinset)
  await writeFile(join(runtimeRoot, 'pnpm-workspace.yaml'), policy)
  const installProductTarball = join(runtimeRoot, 'product.tgz')
  const installFakeTarball = join(runtimeRoot, 'fake.tgz')
  await Promise.all([
    copyFile(productTarball, installProductTarball),
    copyFile(fakeTarball, installFakeTarball),
  ])
  await run([PNPM, 'pnpm@11.23.0', 'add', '--save-exact', '--config.auto-install-peers=true', `@deepseek-ai/dsh@${RC7}`], { cwd: runtimeRoot, env })
  const dsh = join(runtimeRoot, 'node_modules/.bin/dsh')
  await run([dsh, 'plugin', '--profile', 'nobei', 'add', `@deepseek-ai/dsh-web-app@${RC7}`], { cwd: runtimeRoot, env })
  const profileRoot = join(dshHome, 'profiles/nobei')
  await writeFile(join(profileRoot, 'pnpm-workspace.yaml'), policy)
  await run([PROFILE_PNPM, 'add', '--save-exact', '--config.auto-install-peers=true', ...CRITICAL_PROFILE_PACKAGES.map((name) => `${name}@${RC7}`)], { cwd: profileRoot, env })
  await run([dsh, 'plugin', '--profile', 'nobei', 'add', installProductTarball, '--prefer-offline'], { cwd: runtimeRoot, env })
  const productProfilePackage = JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8'))
  await writeFile(join(evidenceRoot, 'product-profile-package.json'), `${JSON.stringify(productProfilePackage, null, 2)}\n`)
  await run([dsh, 'plugin', '--profile', 'nobei', 'add', installFakeTarball, '--prefer-offline'], { cwd: runtimeRoot, env })
  const profilePackage = JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8'))
  await writeFile(join(evidenceRoot, 'acceptance-profile-package.json'), `${JSON.stringify(profilePackage, null, 2)}\n`)
  const profileLayers = assertAcceptanceProfileLayers(productProfilePackage, profilePackage)
  for (const packageName of ['@nobei/dsh-phase1', '@nobei/dsh-phase1c-fake-provider']) {
    if (typeof profilePackage.dependencies?.[packageName] !== 'string' || profilePackage.dependencies[packageName].startsWith('link:')) {
      throw new Error('BUNDLE_INSTALL_NOT_EXTERNAL')
    }
  }
  const clientSeamVersions = Object.fromEntries(await Promise.all(
    CLIENT_SEAM_PACKAGES.map(async (name) => [name, await installedPackageVersion(profileRoot, name)]),
  ))
  for (const [name, version] of Object.entries(clientSeamVersions)) {
    if (version !== RC7) throw new Error(`CLIENT_SEAM_VERSION_MISMATCH:${name}@${version}`)
  }
  const formalData = await formalDataDirectory()
  const operationalPaths = [runtimeRoot, dshHome, home, dataRoot, venvRoot, evidenceRoot]
  if (operationalPaths.some((path) => path === formalData || path.startsWith(`${formalData}/`))) {
    throw new Error('FORMAL_DATA_PATH_FORBIDDEN')
  }
  const manifest = {
    version: 1, phase, createdAt: new Date().toISOString(),
    rc7: RC7, paths: { runtimeRoot, dshHome, home, dataRoot, venvRoot, profileRoot, dsh },
    formalDataDirectory: formalData,
    operationalPaths,
    clientSeamVersions,
    profileLayers,
    configPath, artifacts: {
      product: { path: productTarball, sha256: await sha256File(productTarball) },
      fake: { path: fakeTarball, sha256: await sha256File(fakeTarball) },
    },
    environmentKeys: Object.keys(env).sort(),
  }
  await writeFile(join(evidenceRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { evidenceRoot, manifest }
}

async function prepare() {
  const { evidenceRoot } = await prepareAcceptanceRuntime()
  process.stdout.write(`evidenceRoot=${evidenceRoot}\nPHASE1C_HOST_PREPARED\n`)
}

async function execute(evidenceRoot) {
  const manifest = JSON.parse(await readFile(join(evidenceRoot, 'manifest.json'), 'utf8'))
  const config = JSON.parse(await readFile(manifest.configPath, 'utf8'))
  for (const artifact of Object.values(manifest.artifacts)) {
    if (await sha256File(artifact.path) !== artifact.sha256) throw new Error('ARTIFACT_DIGEST_MISMATCH')
  }
  const env = buildAcceptanceEnvironment(process.env, config)
  const child = spawn(manifest.paths.dsh, ['--profile', 'nobei', '--port', '0'], {
    cwd: manifest.paths.runtimeRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let captureOutput = () => output
  let observedDescendants = []
  try {
    const ready = await waitForReady(child)
    captureOutput = ready.output
    const baseUrl = ready.baseUrl
    const ledgerBefore = await jsonRequest(baseUrl, '/nobei-acceptance/fake-provider-ledger', {
      method: 'GET', headers: { authorization: `Bearer ${config.ledgerToken}` },
    })
    const importInit = {
      method: 'POST', body: JSON.stringify({
        filename: 'photosynthesis.md', mediaType: 'text/markdown',
        text: 'fixture:one\n\n光合作用是绿色植物利用光能的过程。',
        modelSelection: FAKE_MODEL_SELECTION,
      }),
    }
    let imported
    for (let attempt = 0; attempt < 300; attempt += 1) {
      imported = await jsonRequest(baseUrl, '/nobei/v1/imports', importInit)
      if (imported.status !== 503) break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
    if (imported.status !== 202 || imported.body?.ok !== true) throw new Error(`IMPORT_FAILED:${JSON.stringify(imported)}`)
    const runId = imported.body.result.runId
    let runState
    for (let attempt = 0; attempt < 100; attempt += 1) {
      runState = await jsonRequest(baseUrl, `/nobei/v1/runs/${runId}`, { method: 'GET' })
      if (['review_pending', 'completed', 'failed_retryable', 'failed_terminal'].includes(runState.body?.result?.status)) break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
    const candidates = await jsonRequest(baseUrl, `/nobei/v1/runs/${runId}/candidates`, { method: 'GET' })
    const diagnosticLedger = await jsonRequest(baseUrl, '/nobei-acceptance/fake-provider-ledger', {
      method: 'GET', headers: { authorization: `Bearer ${config.ledgerToken}` },
    })
    if (candidates.status !== 200 || candidates.body?.result?.candidates?.length !== 1) {
      throw new Error(`CANDIDATES_FAILED:${JSON.stringify({ runState, candidates, diagnosticLedger })}`)
    }
    const candidate = candidates.body.result.candidates[0]
    const reviewed = await jsonRequest(baseUrl, `/nobei/v1/candidates/${candidate.candidateId}/review`, {
      method: 'POST', body: JSON.stringify({
        action: 'accept', expectedRevision: candidate.revision,
        idempotencyKey: `idem_${randomBytes(10).toString('hex')}`,
      }),
    })
    const knowledge = await jsonRequest(baseUrl, `/nobei/v1/runs/${runId}/knowledge-points`, { method: 'GET' })
    const ledgerAfter = await jsonRequest(baseUrl, '/nobei-acceptance/fake-provider-ledger', {
      method: 'GET', headers: { authorization: `Bearer ${config.ledgerToken}` },
    })
    const result = { baseUrl, ledgerBefore, imported, runState, candidates, reviewed, knowledge, ledgerAfter }
    output = captureOutput()
    const importedSelection = imported.body?.result?.modelSelection
    const persistedSelection = runState.body?.result?.attempts?.[0]?.modelSelection
      ?? runState.body?.result?.modelSelection
    const fakeRecord = ledgerAfter.body?.records?.[0]
    if (reviewed.status !== 200
      || knowledge.body?.result?.knowledgePoints?.length !== 1
      || ledgerAfter.body?.records?.length !== 1
      || JSON.stringify(importedSelection) !== JSON.stringify(FAKE_MODEL_SELECTION)
      || JSON.stringify(persistedSelection) !== JSON.stringify(FAKE_MODEL_SELECTION)
      || fakeRecord?.provider !== FAKE_MODEL_SELECTION.provider
      || fakeRecord?.model !== FAKE_MODEL_SELECTION.model
      || fakeRecord?.reasoningEffort !== undefined
      || JSON.stringify(fakeRecord?.toolNames) !== JSON.stringify(['structured_output'])) {
      throw new Error(`PHASE1C_FLOW_INCOMPLETE:${JSON.stringify(result)}`)
    }
    await writeFile(join(evidenceRoot, 'actual-flow.json'), `${JSON.stringify(result, null, 2)}\n`)
    observedDescendants = await descendantPids(child.pid)
    process.stdout.write(`runId=${runId}\nPHASE1C_BASIC_FLOW_GO\n`)
  } finally {
    output = captureOutput()
    await stopDsh(child).catch(() => child.kill('SIGKILL'))
    for (let attempt = 0; attempt < 100 && observedDescendants.some(pidExists); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    }
    await writeFile(join(evidenceRoot, 'teardown.json'), `${JSON.stringify({
      hostExited: child.exitCode !== null,
      observedDescendantPids: observedDescendants,
      descendantPidsGone: observedDescendants.every((pid) => !pidExists(pid)),
    }, null, 2)}\n`)
    await writeFile(join(evidenceRoot, 'dsh-output.txt'), output)
  }
}

async function main(argv) {
  const [mode, flag, value] = argv
  if (mode === 'prepare' && flag === undefined) return prepare()
  if (mode === 'execute' && flag === '--evidence-root' && value?.startsWith('/')) return execute(value)
  throw new Error('usage: accept-phase1c-host.mjs prepare | execute --evidence-root <absolute>')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
