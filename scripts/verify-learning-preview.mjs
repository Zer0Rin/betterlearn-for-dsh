import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const previewUrl = process.argv[2] ?? 'http://127.0.0.1:4173/'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const browserErrors = []
page.on('console', message => {
  if (message.type() === 'error') browserErrors.push(message.text())
})
page.on('pageerror', error => browserErrors.push(error.message))

try {
  await page.goto(previewUrl, { waitUntil: 'networkidle' })
  const panel = page.locator('.betterlearn-floating-panel')
  assert.equal(await panel.getAttribute('data-mode'), 'learning')
  assert.deepEqual(await panel.boundingBox(), { x: 344, y: 16, width: 1080, height: 868 })
  await page.locator('[data-option-id="detached"]').click()
  await page.getByTestId('learning-submit-check').click()
  await page.getByTestId('learning-remediation').waitFor()
  await page.locator('[data-option-id="transfer"]').click()
  await page.getByTestId('learning-submit-retest').click()
  await page.getByTestId('learning-passed').waitFor()

  await page.getByRole('button', { name: '收起课程路径' }).click()
  assert.equal(await page.getByTestId('learning-path').count(), 0)
  await page.getByRole('button', { name: '收起证据与掌握状态' }).click()
  assert.equal(await page.getByTestId('learning-evidence').count(), 0)

  await page.getByRole('button', { name: '返回普通工作台' }).click()
  assert.equal(await panel.getAttribute('data-mode'), 'workbench')
  await page.waitForFunction(() => document.querySelector('.betterlearn-floating-panel')
    ?.getBoundingClientRect().width === 460)
  assert.deepEqual(await panel.boundingBox(), { x: 964, y: 16, width: 460, height: 720 })
  await page.getByTestId('nobei-start-learning').click()
  assert.equal(await panel.getAttribute('data-mode'), 'learning')
  await page.waitForFunction(() => document.querySelector('.betterlearn-floating-panel')
    ?.getBoundingClientRect().width === 1080)

  await page.setViewportSize({ width: 680, height: 900 })
  await page.waitForFunction(() => document.querySelector('.betterlearn-floating-panel')
    ?.getBoundingClientRect().width === 680)
  assert.deepEqual(await panel.boundingBox(), { x: 0, y: 0, width: 680, height: 900 })
  assert.equal(await page.locator('.betterlearn-learning__body').evaluate(node => getComputedStyle(node).display), 'block')
  assert.deepEqual(browserErrors, [])
  console.log('learning preview verified: desktop flow, remediation, sidebars, size restore, narrow layout')
} finally {
  await browser.close()
}
