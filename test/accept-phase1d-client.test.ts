import { describe, expect, test } from 'vitest'
import { assertPhase1dBrowserResult, waitForProductReady } from '../scripts/accept-phase1d-client.mjs'

function passingResult() {
  return {
    clientEntry: {
      surface: 'floating', visible: true, collapsedOnLoad: true,
      hostWidthBefore: 900, hostWidthAfter: 900, reviewWidth: 1080, resultWidth: 600,
    },
    clientModule: {
      url: 'http://127.0.0.1:43123/plugins/@nobei/dsh-phase1/client.js',
      status: 200,
      path: '/plugins/@nobei/dsh-phase1/client.js',
    },
    pageOrigin: 'http://127.0.0.1:43123',
    baseUrl: 'http://127.0.0.1:43123',
    importedRunId: 'run_123',
    restoredRunId: 'run_123',
    modelSelection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    displayedModel: '本次模型：deepseek-official / deepseek-v4-flash',
    screens: ['import', 'processing', 'review', 'result', 'import'],
    reviewActions: ['accept', 'edit_accept', 'reject'],
    knowledgePointCount: 2,
    filePreview: {
      filename: 'sample.txt',
      mediaType: 'text/plain',
      submitted: false,
    },
    sidebarCollapsedForNarrow: true,
    narrowContentWidth: 318,
    history: {
      collapsedByDefault: true,
      retainedRunCount: 2,
      hostLayoutUnchanged: true,
      contentWidthBefore: 1080,
      contentWidthAfter: 1080,
      panelWidthBefore: 1080,
      panelWidthAfter: 1380,
      globalWithoutSessionStorage: true,
      navigationProviderCalls: 0,
    },
    productRequests: [
      { method: 'POST', path: '/nobei/v1/imports', status: 202,
        modelSelection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
      { method: 'POST', path: '/nobei/v1/imports', status: 202,
        modelSelection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
      { method: 'GET', path: '/nobei/v1/runs/run_123', status: 200 },
      { method: 'POST', path: '/nobei/v1/candidates/c1/review', status: 200 },
      { method: 'POST', path: '/nobei/v1/candidates/c2/review', status: 200 },
      { method: 'POST', path: '/nobei/v1/candidates/c3/review', status: 200 },
    ],
    ledgerBeforeImport: {
      nonce: 'fake-nonce',
      records: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', toolNames: [], result: 'text' }],
    },
    rawFakeLedger: {
      nonce: 'fake-nonce',
      records: [
        { provider: 'deepseek-official', model: 'deepseek-v4-flash', toolNames: [], result: 'text' },
        { provider: 'deepseek-official', model: 'deepseek-v4-flash', toolNames: ['structured_output'], result: 'structured' },
        { provider: 'deepseek-official', model: 'deepseek-v4-flash', toolNames: ['structured_output'], result: 'structured' },
      ],
    },
    fakeLedger: {
      nonce: 'fake-nonce',
      records: [
        { provider: 'deepseek-official', model: 'deepseek-v4-flash', toolNames: ['structured_output'], result: 'structured' },
        { provider: 'deepseek-official', model: 'deepseek-v4-flash', toolNames: ['structured_output'], result: 'structured' },
      ],
    },
    screenshots: {
      wideResult: '/tmp/wide-result.png',
      narrowImport: '/tmp/narrow-import.png',
    },
  }
}

describe('Phase 1D browser acceptance result', () => {
  test('waits for the product supervisor after the web server is listening', async () => {
    const statuses = [503, 503, 404]
    const requests: string[] = []
    const status = await waitForProductReady('http://127.0.0.1:43123', {
      intervalMs: 0,
      timeoutMs: 1_000,
      fetchImpl: async (url: string) => {
        requests.push(url)
        return { status: statuses.shift() ?? 404 }
      },
    })
    expect(status).toBe(404)
    expect(requests).toHaveLength(3)
  })

  test('accepts a complete CLI to WebUI flow', () => {
    expect(assertPhase1dBrowserResult(passingResult())).toMatchObject({
      importedRunId: 'run_123',
      knowledgePointCount: 2,
    })
  })

  test.each([
    ['missing client entry', (value: ReturnType<typeof passingResult>) => { value.clientEntry.visible = false }, 'CLIENT_ENTRY_NOT_FOUND'],
    ['unknown client surface', (value: ReturnType<typeof passingResult>) => { value.clientEntry.surface = 'electron' }, 'CLIENT_ENTRY_NOT_FOUND'],
    ['expanded on load', (value: ReturnType<typeof passingResult>) => { value.clientEntry.collapsedOnLoad = false }, 'CLIENT_FLOATING_LAYOUT_INVALID'],
    ['squeezed host', (value: ReturnType<typeof passingResult>) => { value.clientEntry.hostWidthAfter = 700 }, 'CLIENT_FLOATING_LAYOUT_INVALID'],
    ['review not expanded', (value: ReturnType<typeof passingResult>) => { value.clientEntry.reviewWidth = 500 }, 'CLIENT_FLOATING_LAYOUT_INVALID'],
    ['cross-origin page', (value: ReturnType<typeof passingResult>) => { value.pageOrigin = 'http://127.0.0.1:9' }, 'CLIENT_ORIGIN_MISMATCH'],
    ['different restored run', (value: ReturnType<typeof passingResult>) => { value.restoredRunId = 'run_other' }, 'CLIENT_RUN_NOT_RESTORED'],
    ['wrong model selection', (value: ReturnType<typeof passingResult>) => { value.modelSelection.model = 'other' }, 'CLIENT_MODEL_SELECTION_INVALID'],
    ['incomplete screens', (value: ReturnType<typeof passingResult>) => { value.screens = ['import', 'review', 'result'] }, 'CLIENT_SCREEN_FLOW_INCOMPLETE'],
    ['incomplete reviews', (value: ReturnType<typeof passingResult>) => { value.reviewActions = ['accept', 'reject'] }, 'CLIENT_REVIEW_FLOW_INCOMPLETE'],
    ['wrong formal result count', (value: ReturnType<typeof passingResult>) => { value.knowledgePointCount = 3 }, 'CLIENT_RESULT_COUNT_INVALID'],
    ['file was submitted', (value: ReturnType<typeof passingResult>) => { value.filePreview.submitted = true }, 'CLIENT_FILE_PREVIEW_INVALID'],
    ['expanded narrow sidebar', (value: ReturnType<typeof passingResult>) => { value.sidebarCollapsedForNarrow = false }, 'CLIENT_NARROW_HOST_LAYOUT_INVALID'],
    ['cramped narrow content', (value: ReturnType<typeof passingResult>) => { value.narrowContentWidth = 110 }, 'CLIENT_NARROW_HOST_LAYOUT_INVALID'],
    ['history expanded by default', (value: ReturnType<typeof passingResult>) => { value.history.collapsedByDefault = false }, 'CLIENT_HISTORY_INVALID'],
    ['old run missing', (value: ReturnType<typeof passingResult>) => { value.history.retainedRunCount = 1 }, 'CLIENT_HISTORY_INVALID'],
    ['history squeezes content', (value: ReturnType<typeof passingResult>) => { value.history.contentWidthAfter = 780 }, 'CLIENT_HISTORY_INVALID'],
    ['history navigation calls model', (value: ReturnType<typeof passingResult>) => { value.history.navigationProviderCalls = 1 }, 'CLIENT_HISTORY_INVALID'],
    ['failed client module', (value: ReturnType<typeof passingResult>) => { value.clientModule.status = 404 }, 'CLIENT_MODULE_REQUEST_FAILED'],
    ['wrong import status', (value: ReturnType<typeof passingResult>) => { value.productRequests[0].status = 200 }, 'CLIENT_PRODUCT_REQUEST_FAILED'],
    ['missing review request', (value: ReturnType<typeof passingResult>) => { value.productRequests.splice(5, 1) }, 'CLIENT_PRODUCT_REQUEST_FAILED'],
    ['wrong review method', (value: ReturnType<typeof passingResult>) => { value.productRequests[3].method = 'GET' }, 'CLIENT_PRODUCT_REQUEST_FAILED'],
    ['failed product request', (value: ReturnType<typeof passingResult>) => { value.productRequests[3].status = 409 }, 'CLIENT_PRODUCT_REQUEST_FAILED'],
    ['wrong fake ledger count', (value: ReturnType<typeof passingResult>) => { value.fakeLedger.records.push({ provider: 'deepseek-official', model: 'deepseek-v4-flash', toolNames: ['structured_output'], result: 'structured' }) }, 'CLIENT_FAKE_LEDGER_INVALID'],
    ['unbound fake ledger baseline', (value: ReturnType<typeof passingResult>) => { value.rawFakeLedger.records.splice(0, 1) }, 'CLIENT_FAKE_LEDGER_INVALID'],
    ['missing screenshot path', (value: ReturnType<typeof passingResult>) => { value.screenshots.wideResult = '' }, 'CLIENT_SCREENSHOT_MISSING'],
  ])('rejects %s', (_label, mutate, code) => {
    const value = passingResult()
    mutate(value)
    expect(() => assertPhase1dBrowserResult(value)).toThrow(code)
  })
})
