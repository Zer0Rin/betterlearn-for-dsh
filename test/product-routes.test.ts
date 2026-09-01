import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CoreRpcError } from '../src/product/core-rpc-client.js'
import {
  DSH_CONVERSATION_MEDIA_TYPE,
  DshConversationSourceError,
} from '../src/product/dsh-conversation-source.js'
import { GenerationBusyError } from '../src/product/generation-coordinator.js'
import { ModelSelectionResolutionError } from '../src/product/model-selection-resolver.js'
import { registerProductRoutes, type ProductOperations } from '../src/product/routes.js'
import type { CoreState } from '../src/product/types.js'

const runId = `job_${'a'.repeat(20)}`
const candidateId = `cand_${'b'.repeat(20)}`
const knowledgePointId = `kp_${'c'.repeat(20)}`
const idempotencyKey = `idem_${'c'.repeat(20)}`
const courseId = `course_${'d'.repeat(20)}`
const assessmentId = `asm_${'e'.repeat(20)}`
const optionId = `opt_${'f'.repeat(20)}`
const modelSelection = { provider: 'provider-fixture', model: 'model-fixture', reasoningEffort: 'medium' }
const dshSessionIds = ['session_a', 'session_b']
const dshDigest = 'd'.repeat(64)
const dshPreview = {
  sessionIds: dshSessionIds,
  filename: 'DSH对话合集-主题-等2个.md',
  mediaType: DSH_CONVERSATION_MEDIA_TYPE,
  text: '# DSH 对话合集\n\n## 对话：主题',
  contentDigest: dshDigest,
  conversationCount: 2,
  messageCount: 4,
  byteSize: 42,
  characterCount: 31,
  extractionPlan: {
    strategy: 'L1' as const,
    blocks: [],
    containers: [],
    boundaries: [],
    maxCalls: 1,
  },
}
const servers = new Set<ReturnType<typeof createServer>>()

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers.clear()
  vi.restoreAllMocks()
})

function operations(override: Partial<ProductOperations> = {}): ProductOperations {
  return {
    previewDocument: vi.fn(async params => ({ ...params, text: 'preview', byteSize: 7, characterCount: 7, pages: [], extractionPlan: { strategy: 'L1', blocks: [], containers: [], boundaries: [], maxCalls: 1 } })) as any,
    previewDshConversations: vi.fn(async () => dshPreview),
    watchRun: vi.fn(() => vi.fn()),
    getProgress: vi.fn(() => null),
    launchImport: vi.fn(async () => ({ runId, attemptId: `att_${'d'.repeat(20)}`, revision: 2 })),
    importDshConversations: vi.fn(async () => ({ runId, attemptId: `att_${'d'.repeat(20)}`, revision: 2 })),
    listRuns: vi.fn(async () => ({ runs: [] })),
    getRun: vi.fn(async () => ({ runId, documentId: `doc_${'e'.repeat(20)}`, status: 'generating', stage: 'extract', revision: 2, retryCount: 0, lastEventSeq: 2 })),
    listEvents: vi.fn(async () => ({ events: [], nextAfter: 0 })),
    launchRetry: vi.fn(async () => ({ runId, attemptId: `att_${'f'.repeat(20)}`, revision: 7 })),
    listCandidates: vi.fn(async () => ({ candidates: [] })),
    reviewCandidate: vi.fn(async () => ({ candidateId, status: 'accepted' })),
    listKnowledgePoints: vi.fn(async () => ({ knowledgePoints: [] })),
    updateKnowledgePoint: vi.fn(async () => ({ knowledgePoint: { knowledgePointId } })),
    deleteRun: vi.fn(async id => ({ runId: id, deleted: true as const })),
    syncLearningCourse: vi.fn(async params => ({ courseId, ...params } as any)),
    getLearningCourse: vi.fn(async id => ({ courseId: id } as any)),
    submitLearningAttempt: vi.fn(async params => ({ attempt: { ...params, correct: true } } as any)),
    ...override,
  }
}

async function listen(state: CoreState, ops: ProductOperations) {
  let handler: any
  const supervisor = { state }
  const webServer = {
    port: 0,
    register(route: any) {
      expect(route).toEqual(expect.objectContaining({ kind: 'prefix', path: '/nobei/v1' }))
      handler = route.handler
      return vi.fn()
    },
  }
  const dispose = registerProductRoutes({ webServer } as never, supervisor, ops)
  const server = createServer((req, res) => void Promise.resolve(handler(req, res)))
  servers.add(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  webServer.port = (server.address() as AddressInfo).port
  return { port: webServer.port, supervisor, dispose }
}

async function send(port: number, input: {
  method: string
  path: string
  body?: string
  headers?: Record<string, string>
}) {
  const headers: Record<string, string> = {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    'sec-fetch-site': 'same-origin',
    ...input.headers,
  }
  if ((input.method === 'POST' || input.method === 'PATCH') && headers['content-type'] === undefined) headers['content-type'] = 'application/json'
  return new Promise<{ status: number; body: any; headers: Record<string, unknown> }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, ...input, headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.once('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(raw), headers: response.headers })
      })
    })
    request.once('error', reject)
    request.end(input.body)
  })
}

const routes = [
  { key: 'launchImport', method: 'POST', path: '/nobei/v1/imports', body: JSON.stringify({ filename: 'lesson.md', mediaType: 'text/markdown', text: '# Lesson', modelSelection }), status: 202 },
  { key: 'getProgress', method: 'GET', path: `/nobei/v1/runs/${runId}/progress`, status: 200 },
  { key: 'getRun', method: 'GET', path: `/nobei/v1/runs/${runId}`, status: 200 },
  { key: 'listEvents', method: 'GET', path: `/nobei/v1/runs/${runId}/events?after=0`, status: 200 },
  { key: 'launchRetry', method: 'POST', path: `/nobei/v1/runs/${runId}/retry`, body: JSON.stringify({ expectedRevision: 6 }), status: 202 },
  { key: 'listCandidates', method: 'GET', path: `/nobei/v1/runs/${runId}/candidates`, status: 200 },
  { key: 'reviewCandidate', method: 'POST', path: `/nobei/v1/candidates/${candidateId}/review`, body: JSON.stringify({ action: 'accept', expectedRevision: 2, idempotencyKey }), status: 200 },
  { key: 'listKnowledgePoints', method: 'GET', path: `/nobei/v1/runs/${runId}/knowledge-points`, status: 200 },
  { key: 'updateKnowledgePoint', method: 'PATCH', path: `/nobei/v1/knowledge-points/${knowledgePointId}`, body: JSON.stringify({ title: '新标题', statement: '新陈述' }), status: 200 },
  { key: 'deleteRun', method: 'DELETE', path: `/nobei/v1/runs/${runId}`, status: 200 },
] as const

const states: CoreState[] = ['STARTING', 'READY', 'RESTARTING', 'DEGRADED', 'DISPOSING', 'DISPOSED']

describe('product route table', () => {
  test('serves strict learning course and attempt routes', async () => {
    const ops = operations()
    const { port, dispose } = await listen('READY', ops)
    const sync = {
      clientBookId: 'book-nist', title: 'NIST 云计算',
      knowledgePointIds: [knowledgePointId],
    }

    const created = await send(port, {
      method: 'POST', path: '/nobei/v1/learning-courses', body: JSON.stringify(sync),
    })
    expect(created.status).toBe(200)
    expect(ops.syncLearningCourse).toHaveBeenCalledWith(sync)

    const loaded = await send(port, {
      method: 'GET', path: `/nobei/v1/learning-courses/${courseId}`,
    })
    expect(loaded.status).toBe(200)
    expect(ops.getLearningCourse).toHaveBeenCalledWith(courseId)

    const attempt = { optionId, idempotencyKey }
    const submitted = await send(port, {
      method: 'POST', path: `/nobei/v1/learning-assessments/${assessmentId}/attempts`,
      body: JSON.stringify(attempt),
    })
    expect(submitted.status).toBe(200)
    expect(ops.submitLearningAttempt).toHaveBeenCalledWith({ assessmentId, ...attempt })

    for (const invalid of [
      { method: 'POST', path: '/nobei/v1/learning-courses', body: JSON.stringify({ ...sync, extra: true }) },
      { method: 'GET', path: '/nobei/v1/learning-courses/course_bad' },
      { method: 'POST', path: `/nobei/v1/learning-assessments/${assessmentId}/attempts`, body: JSON.stringify({ ...attempt, optionId: '../bad' }) },
    ]) {
      expect((await send(port, invalid)).status).toBe(400)
    }
    dispose()
  })
  test('serves the global run collection before the parameterized run route', async () => {
    const listRuns = vi.fn(async () => ({ runs: [] }))
    const ops = operations() as ProductOperations & { listRuns(): Promise<{ runs: unknown[] }> }
    ops.listRuns = listRuns
    const { port, dispose } = await listen('READY', ops)

    const response = await send(port, { method: 'GET', path: '/nobei/v1/runs' })

    expect(response).toMatchObject({ status: 200, body: { ok: true, result: { runs: [] } } })
    expect(listRuns).toHaveBeenCalledOnce()
    expect(ops.getRun).not.toHaveBeenCalled()
    dispose()
  })

  test('sends the current progress on reconnect and pushes updates without reading Core', async () => {
    const p = { phase: 'extracting', completedBatches: 2, totalBatches: 4, startedAt: 1, lastResponseAt: 2 }
    let notify!: (p?: any) => void
    const ops = operations({ getProgress: vi.fn(() => p as any), watchRun: vi.fn((_id, cb) => { notify = cb; return vi.fn() }) })
    const { port, dispose } = await listen('READY', ops)
    const response = await fetch(`http://127.0.0.1:${port}/nobei/v1/runs/${runId}/stream`, { headers: { origin: `http://127.0.0.1:${port}` } })
    const reader = response.body!.getReader()
    try {
      const first = new TextDecoder().decode((await reader.read()).value)
      expect(first).toContain('event: run.changed')
      expect(first).toContain(`event: run.progress\ndata: ${JSON.stringify(p)}`)
      notify({ ...p, lastResponseAt: 3 })
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"lastResponseAt":3')
      expect(ops.getRun).not.toHaveBeenCalled()
      expect((await send(port, { method: 'GET', path: `/nobei/v1/runs/${runId}/progress` })).body.result).toEqual(p)
    } finally { await reader.cancel(); dispose() }
  })

  test.each(['disconnect', 'dispose'])('streams hints without reading Core and cleans up on %s', async ending => {
    let notify!: () => void
    const unsubscribe = vi.fn()
    const ops = operations({ watchRun: vi.fn((_id, listener) => { notify = listener; return unsubscribe }) })
    const { port, dispose } = await listen('READY', ops)
    const response = await fetch(`http://127.0.0.1:${port}/nobei/v1/runs/${runId}/stream`, {
      headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    // Initial hint covers completion before the subscription was established.
    expect(decoder.decode((await reader.read()).value)).toBe('event: run.changed\ndata: {}\n\n')
    notify()
    expect(decoder.decode((await reader.read()).value)).toBe('event: run.changed\ndata: {}\n\n')
    expect(ops.getRun).not.toHaveBeenCalled()
    expect(ops.listEvents).not.toHaveBeenCalled()
    if (ending === 'dispose') {
      dispose()
      expect((await reader.read()).done).toBe(true)
    } else {
      await reader.cancel()
    }
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce())
    dispose()
  })

  test.each(routes.flatMap((route) => states.map((state) => [route, state] as const)))(
    '$state route matrix',
    async (route, state) => {
      const ops = operations()
      const { port } = await listen(state, ops)
      const response = await send(port, route)
      if (state === 'READY') {
        expect(response.status).toBe(route.status)
        expect(ops[route.key]).toHaveBeenCalledOnce()
      } else {
        expect(response.status).toBe(503)
        expect(response.body).toEqual({ ok: false, error: { code: 'CORE_UNAVAILABLE' } })
        expect(Object.values(ops).every((operation) => vi.mocked(operation).mock.calls.length === 0)).toBe(true)
      }
    },
  )

  test.each([
    ['unknown path', { method: 'GET', path: '/nobei/v1/unknown' }, 404, 'ROUTE_NOT_FOUND'],
    ['wrong method', { method: 'PUT', path: `/nobei/v1/runs/${runId}` }, 405, 'METHOD_NOT_ALLOWED'],
    ['GET body', { method: 'GET', path: `/nobei/v1/runs/${runId}`, body: '{}', headers: { 'content-length': '2' } }, 400, 'GET_BODY_FORBIDDEN'],
    ['bad content type', { method: 'POST', path: '/nobei/v1/imports', body: '{}', headers: { 'content-type': 'text/plain' } }, 415, 'JSON_REQUIRED'],
    ['bad opaque id', { method: 'GET', path: '/nobei/v1/runs/not-an-id' }, 400, 'REQUEST_INPUT_INVALID'],
    ['provider override', { method: 'POST', path: '/nobei/v1/imports', body: JSON.stringify({ filename: 'a.txt', mediaType: 'text/plain', text: 'a', provider: 'real' }) }, 400, 'REQUEST_INPUT_INVALID'],
    ['missing model selection', { method: 'POST', path: '/nobei/v1/imports', body: JSON.stringify({ filename: 'a.txt', mediaType: 'text/plain', text: 'a' }) }, 400, 'REQUEST_INPUT_INVALID'],
    ['model endpoint override', { method: 'POST', path: '/nobei/v1/imports', body: JSON.stringify({ filename: 'a.txt', mediaType: 'text/plain', text: 'a', modelSelection: { ...modelSelection, endpoint: 'https://invalid' } }) }, 400, 'REQUEST_INPUT_INVALID'],
    ['model token override', { method: 'POST', path: '/nobei/v1/imports', body: JSON.stringify({ filename: 'a.txt', mediaType: 'text/plain', text: 'a', modelSelection: { ...modelSelection, token: 'invalid' } }) }, 400, 'REQUEST_INPUT_INVALID'],
    ['model maxTokens override', { method: 'POST', path: '/nobei/v1/imports', body: JSON.stringify({ filename: 'a.txt', mediaType: 'text/plain', text: 'a', modelSelection: { ...modelSelection, maxTokens: 1 } }) }, 400, 'REQUEST_INPUT_INVALID'],
    ['model temperature override', { method: 'POST', path: '/nobei/v1/imports', body: JSON.stringify({ filename: 'a.txt', mediaType: 'text/plain', text: 'a', modelSelection: { ...modelSelection, temperature: 1 } }) }, 400, 'REQUEST_INPUT_INVALID'],
    ['null reasoning effort', { method: 'POST', path: '/nobei/v1/imports', body: JSON.stringify({ filename: 'a.txt', mediaType: 'text/plain', text: 'a', modelSelection: { provider: 'p', model: 'm', reasoningEffort: null } }) }, 400, 'REQUEST_INPUT_INVALID'],
    ['empty model provider', { method: 'POST', path: '/nobei/v1/imports', body: JSON.stringify({ filename: 'a.txt', mediaType: 'text/plain', text: 'a', modelSelection: { provider: '', model: 'm' } }) }, 400, 'REQUEST_INPUT_INVALID'],
    ['surrogate model', { method: 'POST', path: '/nobei/v1/imports', body: JSON.stringify({ filename: 'a.txt', mediaType: 'text/plain', text: 'a', modelSelection: { provider: 'p', model: '\uD800' } }) }, 400, 'REQUEST_INPUT_INVALID'],
    ['bad revision', { method: 'POST', path: `/nobei/v1/runs/${runId}/retry`, body: JSON.stringify({ expectedRevision: 0 }) }, 400, 'REQUEST_INPUT_INVALID'],
    ['bad idempotency', { method: 'POST', path: `/nobei/v1/candidates/${candidateId}/review`, body: JSON.stringify({ action: 'accept', expectedRevision: 2, idempotencyKey: 'bad' }) }, 400, 'REQUEST_INPUT_INVALID'],
    ['bad knowledge point id', { method: 'PATCH', path: '/nobei/v1/knowledge-points/not-an-id', body: JSON.stringify({ title: '标题', statement: '陈述' }) }, 400, 'REQUEST_INPUT_INVALID'],
    ['missing knowledge point field', { method: 'PATCH', path: `/nobei/v1/knowledge-points/${knowledgePointId}`, body: JSON.stringify({ title: '标题' }) }, 400, 'REQUEST_INPUT_INVALID'],
    ['extra knowledge point field', { method: 'PATCH', path: `/nobei/v1/knowledge-points/${knowledgePointId}`, body: JSON.stringify({ title: '标题', statement: '陈述', extra: true }) }, 400, 'REQUEST_INPUT_INVALID'],
    ['overlong knowledge point title', { method: 'PATCH', path: `/nobei/v1/knowledge-points/${knowledgePointId}`, body: JSON.stringify({ title: 'x'.repeat(121), statement: '陈述' }) }, 400, 'REQUEST_INPUT_INVALID'],
    ['bad delete id', { method: 'DELETE', path: '/nobei/v1/runs/not-an-id' }, 400, 'REQUEST_INPUT_INVALID'],
    ['DELETE body', { method: 'DELETE', path: `/nobei/v1/runs/${runId}`, body: '{}', headers: { 'content-length': '2' } }, 400, 'DELETE_BODY_FORBIDDEN'],
  ])('returns a closed error for %s', async (_name, input, status, code) => {
    const ops = operations()
    const { port } = await listen('READY', ops)
    const response = await send(port, input)
    expect(response.status).toBe(status)
    expect(response.body).toEqual({ ok: false, error: { code } })
    expect(JSON.stringify(response.body)).not.toContain('canary')
    expect(Object.values(ops).every((operation) => vi.mocked(operation).mock.calls.length === 0)).toBe(true)
  })

  test('forwards an exact knowledge-point update', async () => {
    const ops = operations()
    const { port } = await listen('READY', ops)
    const response = await send(port, routes.find(route => route.key === 'updateKnowledgePoint')!)
    expect(response.status).toBe(200)
    expect(ops.updateKnowledgePoint).toHaveBeenCalledWith({
      knowledgePointId, title: '新标题', statement: '新陈述',
    })
  })

  test('requires same-origin authorization for deletion', async () => {
    const ops = operations()
    const { port } = await listen('READY', ops)
    const response = await send(port, {
      method: 'DELETE', path: `/nobei/v1/runs/${runId}`,
      headers: { origin: 'http://example.com', 'sec-fetch-site': 'cross-site' },
    })
    expect(response).toMatchObject({ status: 403, body: { error: { code: 'CROSS_ORIGIN' } } })
    expect(ops.deleteRun).not.toHaveBeenCalled()
  })

  test('maps generation capacity to 429 without leaking detail', async () => {
    const ops = operations({ launchImport: vi.fn(async () => { throw new GenerationBusyError() }) })
    const { port } = await listen('READY', ops)
    const response = await send(port, routes[0])
    expect(response.status).toBe(429)
    expect(response.body).toEqual({ ok: false, error: { code: 'GENERATION_BUSY' } })
  })

  test('does not propagate an HTTP disconnect into the shared Core RPC client', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let observedSignal: AbortSignal | undefined
    const getRun = vi.fn(async (_runId: string, signal?: AbortSignal) => {
      observedSignal = signal
      await gate
      return { runId, documentId: `doc_${'e'.repeat(20)}`, status: 'generating' as const,
        stage: 'extract' as const, revision: 2, retryCount: 0, lastEventSeq: 2 }
    })
    const { port } = await listen('READY', operations({ getRun }))
    const client = httpRequest({
      host: '127.0.0.1', port, method: 'GET', path: `/nobei/v1/runs/${runId}`,
      headers: {
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        'sec-fetch-site': 'same-origin',
      },
    })
    client.on('error', () => undefined)
    client.end()
    await vi.waitFor(() => expect(getRun).toHaveBeenCalledOnce())
    client.destroy()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(observedSignal).toBeUndefined()
    release()
  })

  test('passes one exact model selection and maps resolver rejection to 422', async () => {
    const accepted = operations()
    const { port } = await listen('READY', accepted)
    const response = await send(port, routes[0])
    expect(response.status).toBe(202)
    expect(accepted.launchImport).toHaveBeenCalledWith({
      filename: 'lesson.md', mediaType: 'text/markdown', text: '# Lesson', modelSelection,
    })

    const withoutEffort = operations()
    const plain = await listen('READY', withoutEffort)
    const plainResponse = await send(plain.port, {
      method: 'POST',
      path: '/nobei/v1/imports',
      body: JSON.stringify({
        filename: 'plain.txt', mediaType: 'text/plain', text: 'plain',
        modelSelection: { provider: 'provider-fixture', model: 'model-fixture' },
      }),
    })
    expect(plainResponse.status).toBe(202)
    expect(withoutEffort.launchImport).toHaveBeenCalledWith(expect.objectContaining({
      modelSelection: { provider: 'provider-fixture', model: 'model-fixture' },
    }))

    const rejected = operations({
      launchImport: vi.fn(async () => { throw new ModelSelectionResolutionError() }),
    })
    const second = await listen('READY', rejected)
    const failed = await send(second.port, routes[0])
    expect(failed.status).toBe(422)
    expect(failed.body).toEqual({ ok: false, error: { code: 'MODEL_SELECTION_INVALID' } })
  })
})


describe('P3 document preview', () => {
  test.each([
    { filename: 'long.txt', mediaType: 'text/plain', text: '😀'.repeat(20000) },
    { filename: 'lesson.pdf', mediaType: 'application/pdf', contentBase64: 'JVBERi0=' },
    { filename: 'lesson.pdf', mediaType: 'application/pdf', text: '已解析正文😀' },
    { filename: 'DSH对话合集-主题.md', mediaType: DSH_CONVERSATION_MEDIA_TYPE, text: '# DSH 对话合集' },
  ])('forwards readonly preview and plan without generation: $filename', async body => {
    const ops = operations()
    const { port } = await listen('READY', ops)
    const response = await send(port, { method: 'POST', path: '/nobei/v1/documents/preview', body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    expect(ops.previewDocument).toHaveBeenCalledWith(body)
    expect(ops.launchImport).not.toHaveBeenCalled()
    expect(response.body.result.extractionPlan.maxCalls).toBe(1)
  })
  test.each(['PDF_MALFORMED', 'PDF_ENCRYPTED', 'PDF_NO_TEXT'])('preserves %s for client explanation', async code => {
    const ops = operations({ previewDocument: vi.fn(async () => { throw new CoreRpcError(code) }) })
    const { port } = await listen('READY', ops)
    const response = await send(port, { method: 'POST', path: '/nobei/v1/documents/preview', body: JSON.stringify({ filename: 'lesson.pdf', mediaType: 'application/pdf', contentBase64: 'JVBERi0=' }) })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe(code)
  })
  test('rejects text above512KiB before Core', async () => {
    const ops = operations()
    const { port } = await listen('READY', ops)
    const response = await send(port, { method: 'POST', path: '/nobei/v1/documents/preview', body: JSON.stringify({ filename: 'large.txt', mediaType: 'text/plain', text: 'x'.repeat(512 * 1024 + 1) }) })
    expect(response.status).toBe(400)
    expect(ops.previewDocument).not.toHaveBeenCalled()
  })
})

describe('DSH conversation routes', () => {
  test('previews an exact conversation selection without caching', async () => {
    const ops = operations()
    const { port } = await listen('READY', ops)

    const response = await send(port, {
      method: 'POST',
      path: '/nobei/v1/dsh-conversations/preview',
      body: JSON.stringify({ sessionIds: dshSessionIds }),
    })

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(ops.previewDshConversations).toHaveBeenCalledWith(dshSessionIds)
    expect(response.body).toEqual({ ok: true, result: dshPreview })
    expect(ops.launchImport).not.toHaveBeenCalled()
  })

  test('imports the previewed selection with its exact digest and model selection', async () => {
    const ops = operations()
    const { port } = await listen('READY', ops)
    const body = { sessionIds: dshSessionIds, expectedDigest: dshDigest, modelSelection }

    const response = await send(port, {
      method: 'POST',
      path: '/nobei/v1/dsh-conversations/imports',
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(202)
    expect(ops.importDshConversations).toHaveBeenCalledWith(body)
  })

  test.each([
    ['empty ids', '/nobei/v1/dsh-conversations/preview', { sessionIds: [] }],
    ['too many ids', '/nobei/v1/dsh-conversations/preview', { sessionIds: Array.from({ length: 51 }, (_, index) => `s_${index}`) }],
    ['duplicate ids', '/nobei/v1/dsh-conversations/preview', { sessionIds: ['same', 'same'] }],
    ['non-string id', '/nobei/v1/dsh-conversations/preview', { sessionIds: ['valid', 1] }],
    ['surrogate id', '/nobei/v1/dsh-conversations/preview', { sessionIds: ['\uD800'] }],
    ['open preview body', '/nobei/v1/dsh-conversations/preview', { sessionIds: ['valid'], extra: true }],
    ['uppercase digest', '/nobei/v1/dsh-conversations/imports', { sessionIds: ['valid'], expectedDigest: 'A'.repeat(64), modelSelection }],
    ['short digest', '/nobei/v1/dsh-conversations/imports', { sessionIds: ['valid'], expectedDigest: 'a'.repeat(63), modelSelection }],
    ['open import body', '/nobei/v1/dsh-conversations/imports', { sessionIds: ['valid'], expectedDigest: dshDigest, modelSelection, text: 'forbidden' }],
    ['model override', '/nobei/v1/dsh-conversations/imports', { sessionIds: ['valid'], expectedDigest: dshDigest, modelSelection: { ...modelSelection, endpoint: 'https://invalid' } }],
  ])('rejects %s before operations', async (_name, path, body) => {
    const ops = operations()
    const { port } = await listen('READY', ops)

    const response = await send(port, { method: 'POST', path, body: JSON.stringify(body) })

    expect(response).toMatchObject({ status: 400, body: { error: { code: 'REQUEST_INPUT_INVALID' } } })
    expect(ops.previewDshConversations).not.toHaveBeenCalled()
    expect(ops.importDshConversations).not.toHaveBeenCalled()
  })

  test.each([
    ['DSH_CONVERSATION_NOT_FOUND', 404],
    ['DSH_CONVERSATION_NOT_ORDINARY', 400],
    ['DSH_CONVERSATION_EMPTY', 400],
    ['DSH_CONVERSATION_TOO_LARGE', 400],
    ['DSH_CONVERSATION_READ_FAILED', 503],
  ] as const)('maps %s to a closed public error', async (code, status) => {
    const ops = operations({
      previewDshConversations: vi.fn(async () => { throw new DshConversationSourceError(code) }),
    })
    const { port } = await listen('READY', ops)

    const response = await send(port, {
      method: 'POST', path: '/nobei/v1/dsh-conversations/preview',
      body: JSON.stringify({ sessionIds: ['valid'] }),
    })

    expect(response).toEqual(expect.objectContaining({
      status,
      body: { ok: false, error: { code } },
    }))
  })

  test('returns a conflict when a conversation changed after preview', async () => {
    const ops = operations({
      importDshConversations: vi.fn(async () => {
        throw new DshConversationSourceError('DSH_CONVERSATION_CHANGED' as never)
      }),
    })
    const { port } = await listen('READY', ops)

    const response = await send(port, {
      method: 'POST', path: '/nobei/v1/dsh-conversations/imports',
      body: JSON.stringify({ sessionIds: ['valid'], expectedDigest: dshDigest, modelSelection }),
    })

    expect(response).toMatchObject({
      status: 409,
      body: { error: { code: 'DSH_CONVERSATION_CHANGED' } },
    })
    expect(ops.launchImport).not.toHaveBeenCalled()
  })

  test('requires Core readiness and the exact POST methods', async () => {
    const ops = operations()
    const starting = await listen('STARTING', ops)
    const unavailable = await send(starting.port, {
      method: 'POST', path: '/nobei/v1/dsh-conversations/preview',
      body: JSON.stringify({ sessionIds: ['valid'] }),
    })
    expect(unavailable).toMatchObject({ status: 503, body: { error: { code: 'CORE_UNAVAILABLE' } } })
    expect(ops.previewDshConversations).not.toHaveBeenCalled()

    const ready = await listen('READY', operations())
    const wrongMethod = await send(ready.port, {
      method: 'GET', path: '/nobei/v1/dsh-conversations/imports',
    })
    expect(wrongMethod).toMatchObject({ status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } })
    expect(wrongMethod.headers.allow).toBe('POST')
  })
})
