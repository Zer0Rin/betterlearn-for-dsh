#!/usr/bin/env node
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, lstat, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { chromium } from '@playwright/test'
import { CRITICAL_PROFILE_PACKAGES, createWorkspacePolicy } from './dsh-topology.mjs'

const execFileAsync = promisify(execFile)
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const RC7 = '0.1.0-rc.7'
const MARKER_FILE = '.nobei-phase1e-probe-marker'
export const PROFILE_PNPM = '/usr/local/bin/pnpm'

export function createProbeEnvironment(baseEnvironment, dshHome, token) {
  return {
    ...baseEnvironment,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_MODE: 'DISABLED',
    NOBEI_PHASE1E_OBSERVER_LEDGER_TOKEN: token,
    // rc.7 uses the native macOS directory dialog unless the launch has the
    // same remote-session fact as Phase 1D acceptance. Headless Chromium can
    // operate only the browser picker selected by this fact.
    SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 1',
  }
}

function fail(code) {
  throw new Error(code)
}

function pathInside(parent, child) {
  const value = relative(parent, child)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

function equalSnapshot(left, right) {
  return left.type === right.type
    && left.target === right.target
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
}

/** Snapshot names and metadata only. It never opens settings or credential files. */
export async function snapshotProfiles(dshHome) {
  const profilesRoot = resolve(dshHome, 'profiles')
  const records = []
  async function visit(directory) {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const path = relative(dshHome, absolute)
      const metadata = await lstat(absolute)
      if (metadata.isSymbolicLink()) {
        records.push({ path, type: 'symlink', target: await readlink(absolute), size: 0, mtimeMs: metadata.mtimeMs })
      } else if (metadata.isDirectory()) {
        records.push({ path, type: 'directory', size: 0, mtimeMs: metadata.mtimeMs })
        await visit(absolute)
      } else {
        records.push({ path, type: 'file', size: metadata.size, mtimeMs: metadata.mtimeMs })
      }
    }
  }
  await visit(profilesRoot)
  return records.sort((left, right) => left.path.localeCompare(right.path))
}

export function diffProfileSnapshots(before, after) {
  const oldRecords = new Map(before.map((record) => [record.path, record]))
  const newRecords = new Map(after.map((record) => [record.path, record]))
  const diff = []
  for (const [path, record] of newRecords) {
    const previous = oldRecords.get(path)
    if (previous === undefined) diff.push({ kind: 'created', path, after: record })
    else if (!equalSnapshot(previous, record)) diff.push({ kind: 'changed', path, before: previous, after: record })
  }
  for (const [path, record] of oldRecords) {
    if (!newRecords.has(path)) diff.push({ kind: 'removed', path, before: record })
  }
  return diff.sort((left, right) => left.path.localeCompare(right.path))
}

export function markerOwnedProfilePath(dshHome, profileName, marker) {
  if (!/^nobei-phase1e-probe-[a-z0-9-]+$/.test(profileName)) fail('PROFILE_MARKER_OWNERSHIP_INVALID')
  const profileRoot = resolve(dshHome, 'profiles', profileName)
  const expectedMarker = join(profileRoot, MARKER_FILE)
  if (resolve(dshHome, marker) !== expectedMarker || !pathInside(resolve(dshHome, 'profiles'), profileRoot)) {
    fail('PROFILE_MARKER_OWNERSHIP_INVALID')
  }
  return profileRoot
}

function blocked(reason, extra = {}) {
  return { status: 'BLOCKED_PROVIDER_CONFIG', reason, ...extra }
}

export function evaluateProfileReuseProbe({ diff, profileName, marker, selection, llmStreamCalls, adapters }) {
  const ownPrefix = `profiles/${profileName}/`
  const permitted = (path) => path.startsWith(ownPrefix) || path === `profiles/${profileName}` || path.startsWith('profiles/node_modules/')
  const outside = diff.filter((entry) => !permitted(entry.path)).map((entry) => entry.path)
  const sharedChanges = diff.filter((entry) => entry.path.startsWith('profiles/node_modules/')).map((entry) => entry.path)
  if (outside.length > 0) return blocked('PROFILE_REUSE_WRITE_OUTSIDE_PROFILE', { outsideChanges: outside, sharedChanges })
  if (selection?.status === 'MODEL_SELECTION_UNAVAILABLE') return blocked('MODEL_SELECTION_UNAVAILABLE', { sharedChanges })
  if (selection?.status !== 'READY' || selection.routable !== true) return blocked('MODEL_NOT_ROUTABLE', { sharedChanges })
  if (!Number.isInteger(llmStreamCalls) || llmStreamCalls !== 0) return blocked('OBSERVER_STREAM_CALLS_NONZERO', { sharedChanges })
  for (const packageName of ['@deepseek-ai/dsh-llm-deepseek', '@deepseek-ai/dsh-llm-pi-ai']) {
    if (adapters?.[packageName] !== RC7) return blocked('ADAPTER_MANIFEST_VERSION_INVALID', { packageName, sharedChanges })
  }
  return {
    status: 'PROFILE_REUSE_PROBE_GO',
    profileName,
    sharedChanges,
    selection: {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    },
    llmStreamCalls,
    adapters: { ...adapters },
    catalogProvenance: {
      scope: 'dsh-llm-deepseek@0.1.0-rc.7 and dsh-llm-pi-ai@0.1.0-rc.7 only',
      observation: 'ModelDirectory.load may use adapter catalog methods; for these resolved rc.7 adapters the catalog lookup is local configuration and performs no provider HTTP.',
    },
  }
}

async function run(argv, options = {}) {
  const [file, ...args] = argv
  try {
    const result = await execFileAsync(file, args, { cwd: options.cwd, env: options.env, maxBuffer: 32 * 1024 * 1024 })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    throw new Error(`COMMAND_FAILED:${argv.join(' ')}\n${error?.stderr ?? ''}`, { cause: error })
  }
}

function readArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!['--dsh', '--dsh-home'].includes(key) || typeof value !== 'string' || values.has(key)) fail('PROBE_ARGUMENTS_INVALID')
    values.set(key, value)
  }
  const dsh = values.get('--dsh')
  const dshHome = values.get('--dsh-home')
  if (values.size !== 2 || !isAbsolute(dsh) || !isAbsolute(dshHome)) fail('PROBE_ARGUMENTS_INVALID')
  return { dsh: resolve(dsh), dshHome: resolve(dshHome) }
}

export async function requireManifest(profileRoot, packageName) {
  const requireFromProfile = createRequire(join(profileRoot, 'package.json'))
  const path = requireFromProfile.resolve(`${packageName}/package.json`)
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'))
  return { path, version: manifest.version }
}

export async function waitForProbeReady(child, timeoutMs = 90_000) {
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const matches = [...output.matchAll(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/g)]
    if (matches.length === 1) return { baseUrl: matches[0][1], output: () => output }
    if (child.exitCode !== null) fail(`DSH_EXITED_BEFORE_READY:${output}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  fail(`DSH_READY_TIMEOUT:${output}`)
}

export async function stopProbeDsh(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('DSH_STOP_TIMEOUT')), 15_000)),
  ])
}

async function workspacePickerDiagnostic(page) {
  const safeName = (value) => /settings|credential|password|api.?key|token/i.test(value) ? '[redacted]' : value
  return page.evaluate(() => {
    const name = (element) => element.getAttribute('aria-label') || element.getAttribute('title') || ''
    const visible = (element) => {
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
    }
    return {
      url: `${window.location.origin}${window.location.pathname}`,
      dialogs: [...document.querySelectorAll('[role="dialog"]')]
        .filter(visible)
        .slice(0, 5)
        .map((element) => ({ name: name(element), tag: element.tagName.toLowerCase() })),
      buttons: [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .slice(0, 20)
        .map((element) => ({ name: name(element), tag: element.tagName.toLowerCase() })),
    }
  }).then((value) => ({
    ...value,
    dialogs: value.dialogs.map((dialog) => ({ ...dialog, name: safeName(dialog.name) })),
    buttons: value.buttons.map((button) => ({ ...button, name: safeName(button.name) })),
  }))
}

export async function openWorkspaceDirectoryPicker(page, workspaceRoot) {
  const chooseWorkspace = page.getByRole('button', { name: 'Choose workspace', exact: true })
  await chooseWorkspace.click()
  const picker = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  const pickerVisible = await picker.waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true, () => false)
  if (!pickerVisible) {
    const addWorkspace = page.getByRole('button', { name: 'Add workspace', exact: true })
    if (!await addWorkspace.isVisible().catch(() => false)) {
      const diagnostic = await workspacePickerDiagnostic(page).catch(() => ({ url: 'unavailable', dialogs: [], buttons: [] }))
      throw new Error(`WORKSPACE_PICKER_NOT_VISIBLE:${JSON.stringify(diagnostic)}`)
    }
    await addWorkspace.click()
    try {
      await picker.waitFor({ state: 'visible', timeout: 3_000 })
    } catch (error) {
      const diagnostic = await workspacePickerDiagnostic(page).catch(() => ({ url: 'unavailable', dialogs: [], buttons: [] }))
      throw new Error(`WORKSPACE_PICKER_NOT_VISIBLE_AFTER_ADD:${JSON.stringify(diagnostic)}`, { cause: error })
    }
  }
  await picker.getByRole('button', { name: 'Edit path', exact: true }).click()
  const input = picker.getByRole('textbox', { name: 'Edit path', exact: true })
  await input.fill(workspaceRoot)
  await input.press('Enter')
  await picker.getByRole('button', { name: 'Open', exact: true }).click()
}

export async function openObserverView(baseUrl, workspaceRoot) {
  const browser = await chromium.launch({ headless: true })
  try {
    const observerPath = '/plugins/@nobei/dsh-phase1e-real-model-observer/client.js'
    const [indexResponse, directModuleResponse] = await Promise.all([
      fetch(baseUrl),
      fetch(`${baseUrl}${observerPath}`),
    ])
    const indexHtml = await indexResponse.text()
    const bootMentionsObserver = indexHtml.includes('@nobei/dsh-phase1e-real-model-observer')
    await directModuleResponse.body?.cancel()
    if (directModuleResponse.status !== 200 || !bootMentionsObserver) {
      throw new Error(`OBSERVER_CLIENT_MODULE_NOT_COMPOSED:${JSON.stringify({
        directModuleStatus: directModuleResponse.status,
        bootMentionsObserver,
      })}`)
    }
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const browserEvents = []
    let observerModule
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        browserEvents.push({ type: message.type(), text: message.text().slice(0, 300) })
      }
    })
    page.on('pageerror', (error) => browserEvents.push({ type: 'pageerror', text: error.message.slice(0, 300) }))
    page.on('requestfailed', (request) => {
      const path = new URL(request.url()).pathname
      if (path.includes('phase1e-real-model-observer')) {
        browserEvents.push({ type: 'requestfailed', path, error: request.failure()?.errorText ?? 'unknown' })
      }
    })
    page.on('response', (response) => {
      const path = decodeURIComponent(new URL(response.url()).pathname)
      if (path === '/plugins/@nobei/dsh-phase1e-real-model-observer/client.js') {
        observerModule = { path, status: response.status() }
      }
    })
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    const notice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
    if (await notice.isVisible().catch(() => false)) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
    const view = page.getByTestId('nobei-phase1e-real-model-observer')
    const observerAttached = await view.waitFor({ state: 'attached', timeout: 1_000 })
      .then(() => true, () => false)
    if (!observerAttached) {
      await openWorkspaceDirectoryPicker(page, workspaceRoot)
    }
    try {
      await view.waitFor({ state: 'attached', timeout: 30_000 })
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        phase: document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? null,
        loadedObserverResources: performance.getEntriesByType('resource')
          .map((entry) => new URL(entry.name).pathname)
          .filter((path) => path.includes('phase1e-real-model-observer')),
      })).catch(() => ({ phase: null, loadedObserverResources: [] }))
      throw new Error(`OBSERVER_ELEMENT_NOT_ATTACHED:${JSON.stringify({
        observerModule,
        directModuleStatus: directModuleResponse.status,
        bootMentionsObserver,
        browserEvents: browserEvents.slice(-10),
        ...diagnostic,
      })}`, { cause: error })
    }
    await page.waitForFunction(() => document.querySelector('[data-testid="nobei-phase1e-real-model-observer"]')?.getAttribute('data-status') !== 'LOADING', undefined, { timeout: 30_000 })
    const attributes = await view.evaluate((element) => ({
      status: element.getAttribute('data-status'),
      provider: element.getAttribute('data-provider'),
      model: element.getAttribute('data-model'),
      reasoningEffort: element.getAttribute('data-reasoning-effort'),
      routable: element.getAttribute('data-routable'),
    }))
    if (attributes.status === 'READY' && attributes.provider && attributes.model && attributes.routable === 'true') {
      return {
        status: 'READY', provider: attributes.provider, model: attributes.model,
        ...(attributes.reasoningEffort === null ? {} : { reasoningEffort: attributes.reasoningEffort }), routable: true,
      }
    }
    if (attributes.status === 'MODEL_NOT_ROUTABLE') return { status: 'MODEL_NOT_ROUTABLE', routable: false }
    return { status: 'MODEL_SELECTION_UNAVAILABLE' }
  } finally {
    await browser.close()
  }
}

export async function observerLedger(baseUrl, token) {
  const response = await fetch(`${baseUrl}/nobei-acceptance/phase1e-observer-ledger`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (response.status !== 200) fail(`OBSERVER_LEDGER_FAILED:${response.status}`)
  const body = await response.json()
  if (!Array.isArray(body?.records)) fail('OBSERVER_LEDGER_INVALID')
  return body.records
}

export async function removeMarkerOwnedProfile(dshHome, profileName, marker) {
  const profileRoot = markerOwnedProfilePath(dshHome, profileName, marker)
  await stat(marker)
  await rm(profileRoot, { recursive: true, force: false })
}

export async function runProfileReuseProbe({ dsh, dshHome }) {
  const before = await snapshotProfiles(dshHome)
  const nonce = randomBytes(12).toString('hex')
  const profileName = `nobei-phase1e-probe-${nonce}`
  const profileRoot = markerOwnedProfilePath(dshHome, profileName, join(dshHome, 'profiles', profileName, MARKER_FILE))
  const marker = join(profileRoot, MARKER_FILE)
  const token = randomBytes(32).toString('hex')
  const env = createProbeEnvironment(process.env, dshHome, token)
  let child
  let result
  let dshOutput = () => ''
  try {
    await access(dsh)
    await run([dsh, 'plugin', '--profile', profileName, 'add', `@deepseek-ai/dsh-web-app@${RC7}`], { cwd: ROOT, env })
    await writeFile(marker, `${nonce}\n`, { mode: 0o600 })
    const pinset = JSON.parse(await (await import('node:fs/promises')).readFile(join(ROOT, 'config/dsh-rc7-pins.json'), 'utf8'))
    await writeFile(join(profileRoot, 'pnpm-workspace.yaml'), createWorkspacePolicy(pinset))
    await run([PROFILE_PNPM, 'add', '--save-exact', '--config.auto-install-peers=true', ...CRITICAL_PROFILE_PACKAGES.map((name) => `${name}@${RC7}`)], { cwd: profileRoot, env })
    await run(['corepack', 'pnpm@11.23.0', 'build'], { cwd: join(ROOT, 'acceptance/real-model-observer'), env })
    const observerRoot = join(ROOT, 'acceptance/real-model-observer')
    await run([dsh, 'plugin', '--profile', profileName, 'add', observerRoot], { cwd: ROOT, env })
    const adapterManifests = Object.fromEntries(await Promise.all([
      '@deepseek-ai/dsh-llm-deepseek', '@deepseek-ai/dsh-llm-pi-ai',
    ].map(async (packageName) => [packageName, await requireManifest(profileRoot, packageName)])))
    const adapters = Object.fromEntries(Object.entries(adapterManifests).map(([name, manifest]) => [name, manifest.version]))
    child = spawn(dsh, ['--profile', profileName, '--port', '0'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const ready = await waitForProbeReady(child)
    dshOutput = ready.output
    const recordsBeforeObservation = await observerLedger(ready.baseUrl, token)
    if (recordsBeforeObservation.length !== 0) fail('OBSERVER_STREAM_CALLS_NONZERO_BEFORE_OBSERVATION')
    const selection = await openObserverView(ready.baseUrl, ROOT)
    const records = await observerLedger(ready.baseUrl, token)
    await stopProbeDsh(child)
    child = undefined
    await removeMarkerOwnedProfile(dshHome, profileName, marker)
    const after = await snapshotProfiles(dshHome)
    const diff = diffProfileSnapshots(before, after)
    result = evaluateProfileReuseProbe({
      diff, profileName, marker: relative(dshHome, marker), selection, llmStreamCalls: records.length, adapters,
    })
    result = { ...result, changedPaths: diff, adapterManifestPaths: Object.fromEntries(Object.entries(adapterManifests).map(([name, manifest]) => [name, manifest.path])) }
  } catch (error) {
    if (child !== undefined) await stopProbeDsh(child).catch(() => undefined)
    try { await removeMarkerOwnedProfile(dshHome, profileName, marker) } catch {}
    const after = await snapshotProfiles(dshHome)
    result = blocked('PROBE_RUNTIME_UNAVAILABLE', {
      message: error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 500) : 'unknown',
      dshDiagnostics: dshOutput().split('\n')
        .filter((line) => /phase1e-real-model-observer|client-modules|warn|error/i.test(line))
        .slice(-20)
        .map((line) => line.replace(/\s+/g, ' ').slice(0, 500)),
      changedPaths: diffProfileSnapshots(before, after),
    })
  }
  return result
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  try {
    const result = await runProfileReuseProbe(readArgs(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result)}\n${result.status}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
