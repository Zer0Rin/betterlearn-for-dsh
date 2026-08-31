#!/usr/bin/env node
// Product acceptance: actual DSH + browser, exclusively the installed fake provider.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir, mkdtemp, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from '@playwright/test'
import { buildAcceptanceEnvironment, productRequestHeaders, waitForReady, stopDsh } from './accept-phase1c-host.mjs'
import { openNobeiView, waitForProductReady } from './accept-phase1d-client.mjs'

const root = resolve(import.meta.dirname, '..')
const sourceManifest = process.argv[2]
if (!sourceManifest) throw Error('usage: node scripts/accept-p3.mjs <prepared manifest.json>')
const manifest = JSON.parse(await readFile(sourceManifest, 'utf8'))
const config = JSON.parse(await readFile(manifest.configPath, 'utf8'))
const evidence = join(root, 'evidence', 'p3', new Date().toISOString().replaceAll(/[:.]/g, '-'))
await mkdir(evidence, { recursive: true })
config.dataRoot = await mkdtemp(join(tmpdir(), 'betterlearn-p3-data-'))
await writeFile(join(config.dataRoot, '.nobei-phase1-owned.json'), JSON.stringify({ kind: 'phase1-isolated', version: 1, ownershipToken: config.ownershipToken }))
await writeFile(join(evidence, 'runtime.json'), JSON.stringify({ ...manifest.paths, dataRoot: config.dataRoot, configPath: manifest.configPath }, null, 2))
const env = { ...buildAcceptanceEnvironment(process.env, config), SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 1' }
function command(cmd, args, cwd = root) {
  const result = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' })
  if (result.status !== 0) throw Error(`${cmd} failed: ${result.stdout}\n${result.stderr}`)
}
command(config.python, ['-m', 'pip', 'install', '-r', join(root, 'python/requirements-phase1.txt')])
command('pnpm', ['pack', '--pack-destination', join(root, 'dist')])
command('pnpm', ['build'], join(root, 'acceptance/fake-provider'))
command('pnpm', ['pack', '--pack-destination', join(root, 'dist')], join(root, 'acceptance/fake-provider'))
const stamp = Date.now()
for (const name of ['nobei-dsh-phase1-0.0.0.tgz', 'nobei-dsh-phase1c-fake-provider-0.0.0.tgz']) {
  const target = join(manifest.paths.runtimeRoot, `${stamp}-${name}`)
  await copyFile(join(root, 'dist', name), target)
  command(manifest.paths.dsh, ['plugin', '--profile', 'nobei', 'add', target, '--prefer-offline'], manifest.paths.runtimeRoot)
}

const child = spawn(manifest.paths.dsh, ['--profile', 'nobei', '--port', '0'], { cwd: manifest.paths.runtimeRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
let browser, page, output = () => ''
const browserEvents = []
const cases = []
try {
  const ready = await waitForReady(child); output = ready.output
  const baseUrl = ready.baseUrl
  await waitForProductReady(baseUrl)
  const request = async (path, body) => {
    const response = await fetch(`${baseUrl}/nobei/v1${path}`, { method: body ? 'POST' : 'GET', headers: productRequestHeaders(baseUrl), ...(body ? { body: JSON.stringify(body) } : {}) })
    const result = await response.json()
    assert.equal(result.ok, true, JSON.stringify(result)); return result.result
  }
  const ledger = async () => (await (await fetch(`${baseUrl}/nobei-acceptance/fake-provider-ledger`, { headers: { authorization: `Bearer ${config.ledgerToken}` } })).json()).records
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => browserEvents.push({type: message.type(), text: message.text()}))
  page.on('response', response => { if(response.url().includes('/nobei/v1/')) browserEvents.push({status:response.status(), url:response.url()}) })
  await page.goto(baseUrl)
  await openNobeiView(page, manifest.paths.runtimeRoot)
  const makeText = count => Array.from({ length: count }, (_, index) => `# 段落 ${index + 1}\n\n${'abcd '.repeat(690)}\n\n${index === 0 || index === count - 2 ? 'P3事实：重复出现的共同知识。' : `P3事实：第${index + 1}段的独有知识。`}\n\n`).join('') + 'P3事实：全文尾段也必须提取。\n'
  for (const item of [
    { name: 'p3-text.pdf', strategy: 'L1', file: join(root, 'acceptance/fixtures/p3-text.pdf'), titles: ['中文第一页的能量守恒。', '中文第二页的质量与速度。'] },
    { name: 'p3-l2.md', strategy: 'L2', text: makeText(5) },
    { name: 'p3-l3.md', strategy: 'L3', text: `😀Unicode 原文\n\n${makeText(23)}` },
  ]) {
    const before = (await ledger()).length
    let preview
    if (item.file) {
      preview = await request('/documents/preview', { filename: item.name, mediaType: 'application/pdf', contentBase64: (await readFile(item.file)).toString('base64') })
      assert.equal(preview.pages.length, 2)
      await page.getByTestId('nobei-file-input').setInputFiles(item.file)
      await page.getByTestId('nobei-file-preview').waitFor()
    } else {
      preview = await request('/documents/preview', { filename: item.name, mediaType: 'text/markdown', text: item.text })
      await page.getByRole('tab', { name: '粘贴文本', exact: true }).click()
      await page.getByTestId('nobei-paste-name').fill(item.name)
      await page.getByTestId('nobei-paste-text').fill(item.text)
    }
    assert.equal(preview.extractionPlan.strategy, item.strategy)
    await page.locator('button.nobei-client__primary:not([disabled])').waitFor()
    assert.ok((await page.getByTestId('nobei-extraction-plan').textContent()).includes(`最多 ${preview.extractionPlan.maxCalls} 次`))
    assert.equal((await ledger()).length, before, 'preview must never call model')
    const response = page.waitForResponse(res => res.url().endsWith('/nobei/v1/imports') && res.request().method() === 'POST')
    await page.getByRole('button', { name: '开始提取', exact: true }).click()
    const launch = (await (await response).json()).result
    await page.locator('[data-workspace-screen="review"]').waitFor({ timeout: 30000 })
    let run = await request(`/runs/${launch.runId}`)
    const candidates = (await request(`/runs/${launch.runId}/candidates`)).candidates
    const chars = Array.from(run.document.text)
    const expectedTitles = item.titles ?? [...new Set([...item.text.matchAll(/^P3事实：(.+)$/gm)].map(match => match[1]))]
    assert.deepEqual(candidates.map(c => c.title).sort(), expectedTitles.sort(), 'all fixture facts including tail must survive')
    for (const candidate of candidates) for (const evidence of candidate.evidence) assert.equal(chars.slice(evidence.textStart, evidence.textEnd).join(''), evidence.quote)
    const calls = (await ledger()).length - before
    const plan = preview.extractionPlan
    const expectedCalls = item.strategy === 'L1' ? 1 : plan.containers.reduce((n, c) => n + 1 + Math.ceil(c.blockIds.length / 2), 0) + plan.boundaries.length
    assert.equal(calls, expectedCalls, 'actual planning, grouping and boundary calls must execute')
    assert.ok(calls <= plan.maxCalls)
    if (item.text) {
      const multiple = candidates.find(c => c.title === '重复出现的共同知识。')
      assert.equal(multiple.evidence.length, 2)
      await page.getByRole('navigation', { name: '候选目录' }).getByRole('button').filter({ hasText: multiple.title }).click()
      await page.getByRole('button', { name: '证据 2', exact: true }).click()
      assert.equal(await page.locator('mark').textContent(), multiple.evidence[1].quote)
      assert.equal(await page.locator('mark').getAttribute('data-evidence-seq'), '1')
      if (item.strategy === 'L3') assert.ok(candidates.find(c => c.title === '全文尾段也必须提取。').evidence[0].textStart > 65536)
    }
    await page.screenshot({ path: join(evidence, `${item.strategy}-review.png`) })
    for (let index = 0; index < candidates.length; index++) {
      const saved = page.waitForResponse(res => /\/candidates\/[^/]+\/review$/.test(res.url()) && res.request().method() === 'POST')
      await page.getByRole('button', { name: '接受', exact: true }).click()
      assert.equal((await saved).status(), 200)
    }
    await page.locator('[data-workspace-screen="result"]').waitFor()
    const points = (await request(`/runs/${launch.runId}/knowledge-points`)).knowledgePoints
    assert.equal(points.length, candidates.length)
    for (const point of points) for (const span of point.evidence) assert.equal(chars.slice(span.textStart, span.textEnd).join(''), span.quote)
    await page.reload()
    await openNobeiView(page, manifest.paths.runtimeRoot)
    await page.locator('[data-workspace-screen="result"]').waitFor()
    assert.equal((await ledger()).length - before, calls, 'refresh/review must not generate')
    cases.push({ name: item.name, strategy: item.strategy, runId: launch.runId, sourceCharacters: chars.length, maxCalls: plan.maxCalls, actualCalls: calls, candidates: candidates.length, evidence: candidates.reduce((n, c) => n + c.evidence.length, 0), knowledgePoints: points.length, exactEvidence: true, refreshRestored: true })
    await page.getByTestId('nobei-reset').click()
  }
  // A malformed semantic plan fails atomically and retries only after an explicit click.
  const invalidText = `fixture:p3-invalid-plan\n${'invalid plan source '.repeat(500)}`
  await page.getByRole('tab', { name: '粘贴文本', exact: true }).click()
  await page.getByTestId('nobei-paste-text').fill(invalidText)
  await page.locator('button.nobei-client__primary:not([disabled])').waitFor()
  const launched = page.waitForResponse(res => res.url().endsWith('/nobei/v1/imports') && res.request().method() === 'POST')
  await page.getByRole('button', { name: '开始提取', exact: true }).click()
  const failedId = (await (await launched).json()).result.runId
  await page.getByRole('button', { name: '重新提取', exact: true }).waitFor({ timeout: 60000 })
  assert.equal((await request(`/runs/${failedId}/candidates`)).candidates.length, 0)
  await page.getByRole('button', { name: '重新提取', exact: true }).click()
  await page.getByRole('button', { name: '返回导入', exact: true }).waitFor({ timeout: 60000 })
  assert.equal((await request(`/runs/${failedId}`)).status, 'failed_terminal')
  assert.equal((await request(`/runs/${failedId}/candidates`)).candidates.length, 0)
  assert.deepEqual(pageErrors, [])
  await writeFile(join(evidence, 'final-result.json'), JSON.stringify({ status: 'GO', phase: 'P3', realModelCalls: 0, cases, invalidPlanAtomicFailureAndExplicitRetry: true, pageErrors }, null, 2))
  console.log(`P3_GO ${evidence}`)
} catch (error) {
  await page?.screenshot({path:join(evidence,'failure.png')}).catch(()=>{})
  await writeFile(join(evidence,'browser-debug.json'),JSON.stringify({events:browserEvents,body:await page?.locator('body').innerText().catch(()=>''),session:await page?.evaluate(()=>({...sessionStorage})).catch(()=>({}))},null,2))
  await writeFile(join(evidence, 'final-result.json'), JSON.stringify({ status: 'NO_GO', cases, error: error.stack }, null, 2))
  throw error
} finally {
  await browser?.close()
  await stopDsh(child).catch(() => child.kill('SIGKILL'))
  await writeFile(join(evidence, 'dsh-output.txt'), output())
}
