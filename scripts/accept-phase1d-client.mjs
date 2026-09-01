#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import {
  buildAcceptanceEnvironment,
  descendantPidsFromProcessTable,
  FAKE_MODEL_SELECTION,
  prepareAcceptanceRuntime,
  productRequestHeaders,
  stopDsh,
  waitForReady,
} from './accept-phase1c-host.mjs'

const REQUIRED_SCREENS = ['import', 'processing', 'review', 'result', 'import']
const REQUIRED_ACTIONS = ['accept', 'edit_accept', 'reject']

function fail(code) {
  throw new Error(code)
}

export function assertPhase1dBrowserResult(value) {
  if (value?.clientEntry?.visible !== true
    || value.clientEntry.surface !== 'floating') fail('CLIENT_ENTRY_NOT_FOUND')
  const entry = value.clientEntry
  if (entry.collapsedOnLoad !== true
    || !Number.isFinite(entry.hostWidthBefore)
    || !Number.isFinite(entry.hostWidthAfter)
    || Math.abs(entry.hostWidthBefore - entry.hostWidthAfter) > 1
    || !Number.isFinite(entry.reviewWidth)
    || !Number.isFinite(entry.resultWidth)
    || entry.reviewWidth <= entry.resultWidth
    || entry.resultWidth <= 0) {
    fail(`CLIENT_FLOATING_LAYOUT_INVALID:${JSON.stringify(entry)}`)
  }
  if (value.clientModule?.status !== 200
    || value.clientModule.path !== '/plugins/@nobei/dsh-phase1/client.js') {
    fail('CLIENT_MODULE_REQUEST_FAILED')
  }
  if (value.pageOrigin !== value.baseUrl) fail('CLIENT_ORIGIN_MISMATCH')
  if (typeof value.importedRunId !== 'string' || value.restoredRunId !== value.importedRunId) {
    fail('CLIENT_RUN_NOT_RESTORED')
  }
  if (JSON.stringify(value.modelSelection) !== JSON.stringify(FAKE_MODEL_SELECTION)
    || typeof value.displayedModel !== 'string'
    || !value.displayedModel.includes(`${FAKE_MODEL_SELECTION.provider} / ${FAKE_MODEL_SELECTION.model}`)) {
    fail('CLIENT_MODEL_SELECTION_INVALID')
  }
  if (JSON.stringify(value.screens) !== JSON.stringify(REQUIRED_SCREENS)) {
    fail('CLIENT_SCREEN_FLOW_INCOMPLETE')
  }
  if (JSON.stringify(value.reviewActions) !== JSON.stringify(REQUIRED_ACTIONS)) {
    fail('CLIENT_REVIEW_FLOW_INCOMPLETE')
  }
  if (value.knowledgePointCount !== 2) fail('CLIENT_RESULT_COUNT_INVALID')
  if (value.filePreview?.filename !== 'sample.txt'
    || value.filePreview.mediaType !== 'text/plain'
    || value.filePreview.submitted !== false) {
    fail('CLIENT_FILE_PREVIEW_INVALID')
  }
  if (value.sidebarCollapsedForNarrow !== true || value.narrowContentWidth < 280) {
    fail('CLIENT_NARROW_HOST_LAYOUT_INVALID')
  }
  const productRequests = value.productRequests
  const imports = Array.isArray(productRequests)
    ? productRequests.filter((request) => request.method === 'POST' && request.path === '/nobei/v1/imports')
    : []
  const reviews = Array.isArray(productRequests)
    ? productRequests.filter((request) => request.method === 'POST'
      && /^\/nobei\/v1\/candidates\/[^/]+\/review$/.test(request.path))
    : []
  if (!Array.isArray(productRequests)
    || productRequests.some((request) => request.status < 200 || request.status >= 300)
    || imports.length !== 1 || imports[0].status !== 202
    || JSON.stringify(imports[0].modelSelection) !== JSON.stringify(FAKE_MODEL_SELECTION)
    || reviews.length !== 3 || reviews.some((request) => request.status !== 200)) {
    fail('CLIENT_PRODUCT_REQUEST_FAILED')
  }
  const ledgerRecords = value.fakeLedger?.records
  const baselineRecords = value.ledgerBeforeImport?.records
  const rawLedgerRecords = value.rawFakeLedger?.records
  const structuredRecords = Array.isArray(ledgerRecords)
    ? ledgerRecords.filter((record) => record.result === 'structured')
    : []
  if (!Array.isArray(baselineRecords)
    || !Array.isArray(rawLedgerRecords)
    || JSON.stringify(rawLedgerRecords.slice(0, baselineRecords.length)) !== JSON.stringify(baselineRecords)
    || JSON.stringify(rawLedgerRecords.slice(baselineRecords.length)) !== JSON.stringify(ledgerRecords)
    || value.ledgerBeforeImport?.nonce !== value.rawFakeLedger?.nonce
    || value.fakeLedger?.nonce !== value.rawFakeLedger?.nonce
    || !Array.isArray(ledgerRecords)
    || ledgerRecords.length !== 1
    || ledgerRecords[0]?.provider !== FAKE_MODEL_SELECTION.provider
    || ledgerRecords[0]?.model !== FAKE_MODEL_SELECTION.model
    || ledgerRecords[0]?.reasoningEffort !== undefined
    || structuredRecords.length !== 1
    || JSON.stringify(structuredRecords[0]?.toolNames) !== JSON.stringify(['structured_output'])) {
    fail('CLIENT_FAKE_LEDGER_INVALID')
  }
  if (typeof value.screenshots?.wideResult !== 'string' || value.screenshots.wideResult.length === 0
    || typeof value.screenshots?.narrowImport !== 'string' || value.screenshots.narrowImport.length === 0) {
    fail('CLIENT_SCREENSHOT_MISSING')
  }
  return value
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitForProductReady(baseUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const intervalMs = options.intervalMs ?? 100
  const timeoutMs = options.timeoutMs ?? 30_000
  const started = Date.now()
  do {
    const response = await fetchImpl(`${baseUrl}/nobei/v1/runs/job_00000000000000000000`, {
      headers: productRequestHeaders(baseUrl),
    })
    if (response.status !== 503) return response.status
    if (intervalMs > 0) await delay(intervalMs)
  } while (Date.now() - started < timeoutMs)
  throw new Error('PRODUCT_READY_TIMEOUT')
}

function pidExists(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function descendantPids(rootPid) {
  const { execFile } = await import('node:child_process')
  const table = await new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,command='], (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
  return descendantPidsFromProcessTable(table, rootPid)
}

export async function openNobeiView(page, runtimeRoot) {
  const notice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
  const noticeAppeared = await notice.waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true, () => false)
  if (noticeAppeared) {
    await notice.getByRole('button', { name: 'Continue', exact: true }).click()
    await notice.waitFor({ state: 'hidden', timeout: 30_000 })
  }

  const composer = page.locator([
    'textarea[placeholder="Describe what you want to build"]',
    'textarea[placeholder="Message the agent"]',
  ].join(', '))
  if (!await composer.isVisible().catch(() => false)) {
    const chooseWorkspace = page.getByRole('button', { name: 'Choose workspace', exact: true })
    await chooseWorkspace.click()
    const picker = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    try {
      await picker.waitFor({ state: 'visible', timeout: 3_000 })
    } catch (error) {
      const bodyText = (await page.locator('body').innerText()).slice(0, 8_000)
      throw new Error(`WORKSPACE_PICKER_NOT_VISIBLE\n${bodyText}`, { cause: error })
    }
    await picker.getByRole('button', { name: 'Edit path', exact: true }).click()
    const input = picker.getByRole('textbox', { name: 'Edit path', exact: true })
    await input.fill(runtimeRoot)
    await input.press('Enter')
    const open = picker.getByRole('button', { name: 'Open', exact: true })
    await open.waitFor({ state: 'visible', timeout: 30_000 })
    await open.click()
    await picker.waitFor({ state: 'hidden', timeout: 30_000 })
  }

  const launcher = page.getByTestId('betterlearn-launcher')
  const panel = page.getByTestId('betterlearn-floating-panel')
  const view = page.getByTestId('nobei-client-view')
  const host = page.locator('[data-conversation-scroll]').first()
  try {
    await launcher.waitFor({ state: 'visible', timeout: 30_000 })
    await host.waitFor({ state: 'visible', timeout: 30_000 })
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: window.location.href,
      bodyText: document.body.innerText.slice(0, 8_000),
      buttons: [...document.querySelectorAll('button')].map((node) => node.textContent?.trim()).filter(Boolean).slice(0, 50),
      testIds: [...document.querySelectorAll('[data-testid]')].map((node) => node.getAttribute('data-testid')).filter(Boolean).slice(0, 80),
    }))
    throw new Error(`BETTERLEARN_LAUNCHER_NOT_VISIBLE:${JSON.stringify(diagnostic)}`, { cause: error })
  }
  const collapsedOnLoad = await launcher.getAttribute('aria-expanded') === 'false'
  const hostWidthBefore = await host.evaluate(element => element.getBoundingClientRect().width)
  await launcher.click()
  await panel.waitFor({ state: 'visible', timeout: 30_000 })
  await view.waitFor({ state: 'visible', timeout: 30_000 })
  const hostWidthAfter = await host.evaluate(element => element.getBoundingClientRect().width)
  return { activationStarted: false, surface: 'floating', collapsedOnLoad, hostWidthBefore, hostWidthAfter }
}

async function floatingPanelWidth(page, screen) {
  const panel = page.locator(`[data-testid="betterlearn-floating-panel"][data-screen="${screen}"]`)
  await panel.waitFor({ state: 'visible', timeout: 10_000 })
  await panel.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map(animation => animation.finished))
  })
  return panel
    .evaluate(element => element.getBoundingClientRect().width)
}

async function waitForScreen(page, expected, timeout = 30_000) {
  const screen = page.locator(`[data-workspace-screen="${expected}"]`)
  try {
    await screen.waitFor({ state: 'visible', timeout })
  } catch (error) {
    const observed = await page.locator('[data-workspace-screen]').getAttribute('data-workspace-screen').catch(() => null)
    const bodyText = (await page.locator('body').innerText()).slice(0, 8_000)
    throw new Error(`CLIENT_SCREEN_NOT_OBSERVED:${expected}:observed=${observed}\n${bodyText}`, { cause: error })
  }
  return expected
}

async function ledger(baseUrl, token) {
  const response = await fetch(`${baseUrl}/nobei-acceptance/fake-provider-ledger`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (response.status !== 200) throw new Error(`FAKE_LEDGER_FAILED:${response.status}`)
  return response.json()
}

async function waitForLedgerRecords(baseUrl, token, minimum, timeoutMs = 30_000) {
  const started = Date.now()
  do {
    const value = await ledger(baseUrl, token)
    if (Array.isArray(value.records) && value.records.length >= minimum) return value
    await delay(50)
  } while (Date.now() - started < timeoutMs)
  throw new Error(`FAKE_LEDGER_RECORD_TIMEOUT:${minimum}`)
}

async function execute(evidenceRoot) {
  const manifest = JSON.parse(await readFile(join(evidenceRoot, 'manifest.json'), 'utf8'))
  if (manifest.phase !== 'phase1d-client') throw new Error('PHASE1D_MANIFEST_INVALID')
  const config = JSON.parse(await readFile(manifest.configPath, 'utf8'))
  const env = {
    ...buildAcceptanceEnvironment(process.env, config),
    // rc.7 chooses the native macOS directory dialog on Darwin. A headless
    // browser cannot drive that OS window, so acceptance selects rc.7's own
    // browser picker through the same remote-launch fact used by SSH sessions.
    SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 1',
  }
  const child = spawn(manifest.paths.dsh, ['--profile', 'nobei', '--port', '0'], {
    cwd: manifest.paths.runtimeRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let captureOutput = () => output
  let observedDescendants = []
  let browser
  try {
    const ready = await waitForReady(child)
    captureOutput = ready.output
    const baseUrl = ready.baseUrl
    const baseOrigin = new URL(baseUrl).origin
    await waitForProductReady(baseUrl)
    const browserEvents = []
    const productRequests = []
    let restoredRunId
    let clientModule
    browser = await chromium.launch({ headless: true })
    const observePage = (observedPage) => {
      observedPage.on('console', (message) => browserEvents.push({ type: message.type(), text: message.text() }))
      observedPage.on('pageerror', (error) => browserEvents.push({ type: 'pageerror', text: error.message }))
      observedPage.on('requestfailed', (request) => browserEvents.push({
        type: 'requestfailed',
        method: request.method(),
        path: new URL(request.url()).pathname,
        error: request.failure()?.errorText ?? 'unknown',
      }))
      observedPage.on('response', async (response) => {
      const url = new URL(response.url())
      let decodedPath = url.pathname
      try { decodedPath = decodeURIComponent(url.pathname) } catch {}
      if (decodedPath === '/plugins/@nobei/dsh-phase1/client.js') {
        clientModule = { url: response.url(), status: response.status(), path: decodedPath }
      }
      if (url.pathname.startsWith('/nobei/v1/')) {
        let modelSelection
        if (url.pathname === '/nobei/v1/imports' && response.request().method() === 'POST') {
          try { modelSelection = response.request().postDataJSON()?.modelSelection } catch {}
        }
        productRequests.push({
          method: response.request().method(), path: url.pathname, status: response.status(),
          ...(modelSelection === undefined ? {} : { modelSelection }),
        })
        const match = /^\/nobei\/v1\/runs\/([^/]+)$/.exec(url.pathname)
        if (match && response.request().method() === 'GET' && response.status() === 200) restoredRunId = match[1]
      }
      })
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    observePage(page)

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    const initialEntry = await openNobeiView(page, manifest.paths.runtimeRoot)
    const screens = [await waitForScreen(page, 'import')]
    const pageOrigin = await page.evaluate(() => window.location.origin)
    await page.getByTestId('nobei-active-model').waitFor({ state: 'visible', timeout: 30_000 })
    const displayedModel = await page.getByTestId('nobei-active-model').textContent()
    const ledgerBeforeImport = initialEntry.activationStarted
      ? await waitForLedgerRecords(baseUrl, config.ledgerToken, 1)
      : await ledger(baseUrl, config.ledgerToken)

    await page.getByRole('tab', { name: '粘贴文本', exact: true }).click()
    await page.getByTestId('nobei-paste-name').fill('photosynthesis.md')
    await page.getByTestId('nobei-paste-text').fill([
      'fixture:three',
      '',
      '光合作用是绿色植物利用光能合成有机物并释放氧气的过程。',
      '叶绿体中的叶绿素负责吸收光能。',
      '光合作用为生态系统提供有机物和氧气。',
    ].join('\n'))
    await page.evaluate(() => {
      const observed = []
      const record = () => {
        const value = document.querySelector('[data-workspace-screen]')?.getAttribute('data-workspace-screen')
        if (value && observed.at(-1) !== value) observed.push(value)
      }
      record()
      new MutationObserver(record).observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ['data-workspace-screen'],
      })
      window.__nobeiObservedScreens = observed
    })
    const importButton = page.getByRole('button', { name: '开始提取', exact: true })
    await page.locator('button.nobei-client__primary:not([disabled])').waitFor({ state: 'visible', timeout: 30_000 })
    await importButton.click()
    await page.waitForFunction(() => window.__nobeiObservedScreens?.includes('processing') === true, undefined, {
      timeout: 30_000,
    })
    const observedImportScreens = await page.evaluate(() => window.__nobeiObservedScreens ?? [])
    if (!observedImportScreens.includes('processing')) throw new Error('CLIENT_PROCESSING_TRANSITION_MISSING')
    screens.push('processing')
    await page.waitForFunction(() => Object.keys(window.sessionStorage)
      .filter(key => key.startsWith('nobei:phase1d:session:'))
      .some((key) => {
        try { return typeof JSON.parse(window.sessionStorage.getItem(key) ?? 'null')?.runId === 'string' } catch { return false }
      }), undefined, { timeout: 30_000 })
    const savedRuns = await page.evaluate(() => Object.keys(window.sessionStorage)
      .filter(key => key.startsWith('nobei:phase1d:session:'))
      .map((key) => {
        try { return JSON.parse(window.sessionStorage.getItem(key) ?? 'null')?.runId } catch { return undefined }
      })
      .filter((runId) => typeof runId === 'string'))
    if (savedRuns.length !== 1) throw new Error(`CLIENT_RUN_STATE_INVALID:${JSON.stringify(savedRuns)}`)
    const importedRunId = savedRuns[0]
    const runResponse = await fetch(`${baseUrl}/nobei/v1/runs/${encodeURIComponent(importedRunId)}`, {
      headers: productRequestHeaders(baseUrl),
    })
    const runBody = await runResponse.json()
    if (runResponse.status !== 200 || runBody?.ok !== true) {
      throw new Error(`CLIENT_RUN_READ_FAILED:${runResponse.status}:${JSON.stringify(runBody)}`)
    }
    const modelSelection = runBody.result.modelSelection

    await page.reload({ waitUntil: 'domcontentloaded' })
    await openNobeiView(page, manifest.paths.runtimeRoot)
    try {
      screens.push(await waitForScreen(page, 'review', 60_000))
    } catch (error) {
      const failureLedger = await ledger(baseUrl, config.ledgerToken).catch(() => undefined)
      throw new Error(`CLIENT_REVIEW_NOT_REACHED:${JSON.stringify({ failureLedger, browserEvents: browserEvents.slice(-20) })}`, { cause: error })
    }
    const reviewWidth = await floatingPanelWidth(page, 'review')
    if (restoredRunId !== importedRunId) throw new Error('CLIENT_RUN_NOT_RESTORED')

    const reviewActions = []
    const waitForReview = () => page.waitForResponse((response) => {
      const url = new URL(response.url())
      return /^\/nobei\/v1\/candidates\/[^/]+\/review$/.test(url.pathname)
        && response.request().method() === 'POST'
    }, { timeout: 30_000 })
    let reviewResponse = waitForReview()
    await page.getByRole('button', { name: '接受', exact: true }).click()
    if ((await reviewResponse).status() !== 200) throw new Error('CLIENT_ACCEPT_FAILED')
    reviewActions.push('accept')

    await page.getByRole('button', { name: '修改后接受', exact: true }).click()
    await page.getByTestId('nobei-candidate-title').fill('叶绿素吸收光能')
    await page.getByTestId('nobei-candidate-statement').fill('叶绿体中的叶绿素负责吸收光能，并为光合作用提供能量。')
    reviewResponse = waitForReview()
    await page.getByRole('button', { name: '保存并接受', exact: true }).click()
    if ((await reviewResponse).status() !== 200) throw new Error('CLIENT_EDIT_ACCEPT_FAILED')
    reviewActions.push('edit_accept')

    reviewResponse = waitForReview()
    await page.getByRole('button', { name: '拒绝', exact: true }).click()
    if ((await reviewResponse).status() !== 200) throw new Error('CLIENT_REJECT_FAILED')
    reviewActions.push('reject')
    screens.push(await waitForScreen(page, 'result'))
    const resultWidth = await floatingPanelWidth(page, 'result')

    const knowledgePointCount = await page.locator('.nobei-client__knowledge-list article').count()
    const screenshotRoot = join(evidenceRoot, 'screenshots')
    await mkdir(screenshotRoot, { recursive: true })
    const screenshots = {
      wideResult: join(screenshotRoot, 'wide-result.png'),
      narrowImport: join(screenshotRoot, 'narrow-import.png'),
    }
    await page.screenshot({ path: screenshots.wideResult, fullPage: true })

    const importsBeforePreview = productRequests.filter((request) => request.method === 'POST'
      && request.path === '/nobei/v1/imports').length
    const narrowPage = await context.newPage()
    observePage(narrowPage)
    await narrowPage.setViewportSize({ width: 390, height: 844 })
    await narrowPage.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await openNobeiView(narrowPage, manifest.paths.runtimeRoot)
    screens.push(await waitForScreen(narrowPage, 'import'))
    await narrowPage.getByRole('button', { name: 'Open sidebar', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    await narrowPage.locator('[data-testid="nobei-model-selection"][data-model-status="ready"]')
      .waitFor({ state: 'visible', timeout: 30_000 })
    await narrowPage.getByRole('tab', { name: '选择文件', exact: true }).click()
    await narrowPage.getByTestId('nobei-file-input').setInputFiles({
      name: 'sample.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('一段只用于预览、不会提交的文本。', 'utf8'),
    })
    await narrowPage.getByTestId('nobei-file-name').waitFor({ state: 'visible', timeout: 10_000 })
    await narrowPage.waitForFunction(() => {
      const root = document.querySelector('.nobei-client')
      return root !== null && root.getBoundingClientRect().width >= 280
    }, undefined, { timeout: 10_000 })
    const narrowContentWidth = await narrowPage.locator('.nobei-client').evaluate(element => element.getBoundingClientRect().width)
    await narrowPage.screenshot({ path: screenshots.narrowImport, fullPage: true })
    const importsAfterPreview = productRequests.filter((request) => request.method === 'POST'
      && request.path === '/nobei/v1/imports').length
    const filePreview = {
      filename: await narrowPage.getByTestId('nobei-file-name').textContent(),
      mediaType: 'text/plain',
      submitted: importsAfterPreview !== importsBeforePreview,
    }
    const rawFakeLedger = await ledger(baseUrl, config.ledgerToken)
    if (rawFakeLedger.nonce !== ledgerBeforeImport.nonce
      || rawFakeLedger.records.length < ledgerBeforeImport.records.length) {
      throw new Error('CLIENT_FAKE_LEDGER_BASELINE_INVALID')
    }
    const fakeLedger = {
      nonce: rawFakeLedger.nonce,
      records: rawFakeLedger.records.slice(ledgerBeforeImport.records.length),
    }
    const result = {
      clientEntry: { ...initialEntry, visible: true, reviewWidth, resultWidth },
      clientModule,
      pageOrigin,
      baseUrl: baseOrigin,
      importedRunId,
      restoredRunId,
      modelSelection,
      displayedModel,
      screens,
      reviewActions,
      knowledgePointCount,
      filePreview,
      sidebarCollapsedForNarrow: true,
      narrowContentWidth,
      productRequests,
      ledgerBeforeImport,
      rawFakeLedger,
      fakeLedger,
      screenshots,
    }
    assertPhase1dBrowserResult(result)
    await Promise.all([
      writeFile(join(evidenceRoot, 'browser-flow.json'), `${JSON.stringify(result, null, 2)}\n`),
      writeFile(join(evidenceRoot, 'browser-events.json'), `${JSON.stringify(browserEvents, null, 2)}\n`),
      writeFile(join(evidenceRoot, 'product-requests.json'), `${JSON.stringify(productRequests, null, 2)}\n`),
      writeFile(join(evidenceRoot, 'final-result.json'), `${JSON.stringify({ status: 'GO', phase: 'phase1d-client', result }, null, 2)}\n`),
    ])
    observedDescendants = await descendantPids(child.pid)
    process.stdout.write(`runId=${importedRunId}\nPHASE1D_CLIENT_GO\n`)
  } finally {
    output = captureOutput()
    await browser?.close().catch(() => undefined)
    await stopDsh(child).catch(() => child.kill('SIGKILL'))
    for (let attempt = 0; attempt < 100 && observedDescendants.some(pidExists); attempt += 1) await delay(20)
    await Promise.all([
      writeFile(join(evidenceRoot, 'teardown.json'), `${JSON.stringify({
        hostExited: child.exitCode !== null,
        observedDescendantPids: observedDescendants,
        descendantPidsGone: observedDescendants.every((pid) => !pidExists(pid)),
      }, null, 2)}\n`),
      writeFile(join(evidenceRoot, 'dsh-output.txt'), output),
    ])
  }
}

async function prepare() {
  const { evidenceRoot } = await prepareAcceptanceRuntime({
    phase: 'phase1d-client',
    evidenceKind: 'client',
  })
  process.stdout.write(`evidenceRoot=${evidenceRoot}\nPHASE1D_CLIENT_PREPARED\n`)
}

async function main(argv) {
  const [mode, flag, value] = argv.filter((argument) => argument !== '--')
  if (mode === 'prepare' && flag === undefined) return prepare()
  if (mode === 'execute' && flag === '--evidence-root' && value?.startsWith('/')) return execute(value)
  throw new Error('usage: accept-phase1d-client.mjs prepare | execute --evidence-root <absolute>')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
