#!/usr/bin/env node
// Exercises the packaged lifecycle CLI against a fresh, real DSH rc.8 runtime.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { waitForReady, stopDsh, productRequestHeaders } from './accept-phase1c-host.mjs'
import { openNobeiView, waitForProductReady } from './accept-phase1d-client.mjs'

const root = resolve(import.meta.dirname, '..')
const runtime = process.argv[2]
if (!runtime) throw Error('usage: node scripts/accept-p4.mjs <installed DSH rc.8 runtime directory>')
const dsh = join(resolve(runtime), 'node_modules/.bin/dsh')
const actualVersion = JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
assert.equal(actualVersion, '0.1.0-rc.8')
const evidence = join(root, 'evidence/p4', new Date().toISOString().replaceAll(/[:.]/g, '-'))
await mkdir(evidence, { recursive: true })
const home = await mkdtemp('/tmp/betterlearn-p4-home-')
const env = { ...process.env, DSH_TELEMETRY_MODE: 'DISABLED', SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 1', NOBEI_PHASE1C_FAKE_LEDGER_TOKEN: randomBytes(24).toString('hex') }
const log = []
process.on('uncaughtException', async error => {
  await writeFile(join(evidence, 'final-result.json'), JSON.stringify({ status: 'NO_GO', phase: 'P4', error: error.stack }, null, 2))
  await writeFile(join(evidence, 'commands.json'), JSON.stringify(log, null, 2))
  console.error(error)
  process.exitCode = 1
})
function command(executable, args, cwd = root, expected = 0, commandEnv = env) {
  const result = spawnSync(executable, args, { cwd, env: commandEnv, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  log.push({ executable, args: args.map(arg => arg === env.NOBEI_PHASE1C_FAKE_LEDGER_TOKEN ? '<local token>' : arg), status: result.status, stdout: result.stdout, stderr: result.stderr })
  assert.equal(result.status, expected, `${executable} failed: ${result.stdout}\n${result.stderr}`)
  return result
}
command('pnpm', ['pack', '--pack-destination', join(root, 'dist')])
command('pnpm', ['build'], join(root, 'acceptance/fake-provider'))
command('pnpm', ['pack', '--pack-destination', join(root, 'dist')], join(root, 'acceptance/fake-provider'))
const product = join(evidence, 'betterlearn.tgz'), fake = join(evidence, 'fake-provider.tgz')
await copyFile(join(root, 'dist/nobei-dsh-phase1-0.0.0.tgz'), product)
await copyFile(join(root, 'dist/nobei-dsh-phase1c-fake-provider-0.0.0.tgz'), fake)
const unpacked = join(evidence, 'installer')
await mkdir(unpacked)
command('tar', ['-xzf', product, '-C', unpacked])
const cli = join(unpacked, 'package/bin/betterlearn.mjs')
const runCli = (args, expected = 0) => command(process.execPath, [cli, ...args, '--home', home], root, expected)
runCli(['install', '--dsh', dsh, '--dsh-version', actualVersion, '--python', join(root, '.venv-phase1b/bin/python'), '--package', product])
let config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))
const profile = join(config.dshHome, 'profiles/betterlearn')
command(dsh, ['plugin', '--profile', 'betterlearn', 'add', fake], runtime, 0, { ...env, DSH_HOME: config.dshHome })
await writeFile(join(evidence, 'runtime.json'), JSON.stringify({ runtime, home, dsh, dshVersion: actualVersion, profile, product, cli }, null, 2))

let child, browser, baseUrl, page
const checks = { installedFromTarball: true, dshVersion: actualVersion, realModelCalls: 0 }
const startupLogs = []
async function start() {
  child = spawn(process.execPath, [cli, 'start', '--home', home, '--port', '0'], { cwd: runtime, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const ready = await waitForReady(child)
  baseUrl = ready.baseUrl
  startupLogs.push(ready.output)
  await waitForProductReady(baseUrl)
}
async function stop() { if (child) { await stopDsh(child); child = undefined } }
async function request(path, body, missing = false) {
  const response = await fetch(`${baseUrl}/nobei/v1${path}`, { method: body ? 'POST' : 'GET', headers: productRequestHeaders(baseUrl), ...(body ? { body: JSON.stringify(body) } : {}) })
  if (missing) {
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { ok: false, error: { code: 'INVALID_IDENTIFIER' } })
    return
  }
  const result = await response.json(); assert.equal(result.ok, true, JSON.stringify(result)); return result.result
}
async function uiOpen() {
  if (!browser) browser = await chromium.launch({ headless: true })
  if (page) await page.close()
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.goto(baseUrl)
  await openNobeiView(page, runtime)
}
async function createPoint(title) {
  const fakeRecords = async () => (await (await fetch(`${baseUrl}/nobei-acceptance/fake-provider-ledger`, {
    headers: { authorization: `Bearer ${env.NOBEI_PHASE1C_FAKE_LEDGER_TOKEN}` },
  })).json()).records
  const before = (await fakeRecords()).length
  await page.getByRole('tab', { name: '粘贴文本', exact: true }).click()
  await page.getByTestId('nobei-paste-name').fill('lifecycle.md')
  await page.getByTestId('nobei-paste-text').fill(`😀本地生命周期验收\nP3事实：${title}\n`)
  await page.locator('button.nobei-client__primary:not([disabled])').waitFor()
  const imported = page.waitForResponse(response => response.url().endsWith('/nobei/v1/imports') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '开始提取', exact: true }).click()
  const id = (await (await imported).json()).result.runId
  await page.locator('[data-workspace-screen="review"]').waitFor({ timeout: 60000 })
  assert.equal(await page.locator('mark').textContent(), `P3事实：${title}`)
  await page.getByRole('button', { name: '接受', exact: true }).click()
  await page.locator('[data-workspace-screen="result"]').waitFor()
  const result = await request(`/runs/${id}/knowledge-points`)
  assert.equal(result.knowledgePoints.length, 1)
  const calls = (await fakeRecords()).slice(before)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].result, 'structured')
  await page.getByTestId('nobei-reset').click()
  return { id, result }
}
function snapshotDatabase(path) {
  const script = `import json,sqlite3,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\nnames=[r[0] for r in c.execute("select name from sqlite_schema where type='table' and name not like 'sqlite_%' order by name")]\nprint(json.dumps({name:c.execute('select * from '+name+' order by rowid').fetchall() for name in names},ensure_ascii=False))`
  const result = command(config.python, ['-c', script, path])
  return JSON.parse(result.stdout)
}
try {
  await start()
  await uiOpen()
  const first = await createPoint('备份前的知识。')
  checks.browserKnowledgePoint = first.id
  const backup = join(evidence, 'online-backup.sqlite')
  runCli(['backup', '--to', backup])
  const before = snapshotDatabase(backup)
  const blocked = runCli(['restore', '--from', backup], 1)
  assert.ok(blocked.stderr.includes('CORE_INSTANCE_CONFLICT'))
  assert.deepEqual(await request(`/runs/${first.id}/knowledge-points`), first.result)
  checks.liveBackupAndRestoreRefusal = true
  const second = await createPoint('备份后的新增知识。')
  await stop()
  await start()
  assert.deepEqual(await request(`/runs/${first.id}/knowledge-points`), first.result)
  assert.deepEqual(await request(`/runs/${second.id}/knowledge-points`), second.result)
  checks.restartPreservesPoints = true
  await stop()
  const restore = runCli(['restore', '--from', backup])
  const restoreResult = JSON.parse(restore.stdout.trim().split('\n').at(-1))
  assert.deepEqual(snapshotDatabase(join(home, 'data/phase1.db')), before)
  const previous = snapshotDatabase(restoreResult.previousBackup)
  assert.equal(previous.knowledge_points.length, 2)
  checks.restoreExactlyMatchesAllProductTables = true
  checks.preRestoreCopyContainsNewerPoint = true
  await start()
  assert.deepEqual(await request(`/runs/${first.id}/knowledge-points`), first.result)
  await request(`/runs/${second.id}`, undefined, true)
  await stop()

  // Different local package version, identical supported schema. No publishing.
  const upgradedRoot = join(evidence, 'upgrade-source')
  await mkdir(upgradedRoot)
  command('tar', ['-xzf', product, '-C', upgradedRoot])
  const manifestPath = join(upgradedRoot, 'package/package.json')
  const upgradeManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  upgradeManifest.version = '0.0.1-p4-acceptance'
  await writeFile(manifestPath, JSON.stringify(upgradeManifest, null, 2))
  const upgradePackage = join(evidence, 'betterlearn-upgrade.tgz')
  command('tar', ['-czf', upgradePackage, '-C', upgradedRoot, 'package'])
  runCli(['upgrade', '--package', upgradePackage])
  config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))
  assert.equal(JSON.parse(await readFile(join(profile, 'node_modules/@nobei/dsh-phase1/package.json'), 'utf8')).version, '0.0.1-p4-acceptance')
  await start()
  assert.deepEqual(await request(`/runs/${first.id}/knowledge-points`), first.result)
  await uiOpen()
  const pointAfterUpgrade = await createPoint('升级后仍能提取。')
  checks.upgradedVersion = '0.0.1-p4-acceptance'
  checks.upgradePreservesDataAndCanGenerate = true
  await page.screenshot({ path: join(evidence, 'rc8-after-upgrade.png') })
  await stop()
  const beforeUninstall = snapshotDatabase(join(home, 'data/phase1.db'))
  runCli(['uninstall'])
  const profileManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.equal(profileManifest.dependencies?.['@nobei/dsh-phase1'], undefined)
  assert.ok(!profileManifest.dsh.profile.bundles.includes('@nobei/dsh-phase1'))
  assert.deepEqual(snapshotDatabase(join(home, 'data/phase1.db')), beforeUninstall)
  assert.equal(beforeUninstall.knowledge_points.length, 2)
  checks.uninstallRemovesRegistrationPreservesAllData = true
  checks.finalKnowledgePointIds = [first.id, pointAfterUpgrade.id]
  await writeFile(join(evidence, 'final-result.json'), JSON.stringify({ status: 'GO', phase: 'P4', checks }, null, 2))
  console.log(`P4_GO ${evidence}`)
} catch (error) {
  await page?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {})
  await writeFile(join(evidence, 'final-result.json'), JSON.stringify({ status: 'NO_GO', checks, error: error.stack }, null, 2))
  throw error
} finally {
  await browser?.close()
  await stop().catch(() => child?.kill('SIGKILL'))
  await writeFile(join(evidence, 'commands.json'), JSON.stringify(log, null, 2))
  await writeFile(join(evidence, 'dsh-output.txt'), startupLogs.map(output => output()).join('\n'))
}
