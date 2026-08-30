import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { GenerationBusyError } from '../src/product/generation-coordinator.js'
import { ModelSelectionResolutionError } from '../src/product/model-selection-resolver.js'
import { registerProductRoutes, type ProductOperations } from '../src/product/routes.js'
import type { CoreState } from '../src/product/types.js'

const runId = `job_${'a'.repeat(20)}`
const candidateId = `cand_${'b'.repeat(20)}`
const idempotencyKey = `idem_${'c'.repeat(20)}`
const modelSelection = { provider: 'provider-fixture', model: 'model-fixture', reasoningEffort: 'medium' }
const servers = new Set<ReturnType<typeof createServer>>()

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers.clear()
  vi.restoreAllMocks()
})

function operations(override: Partial<ProductOperations> = {}): ProductOperations {
  return {
    launchImport: vi.fn(async () => ({ runId, attemptId: `att_${'d'.repeat(20)}`, revision: 2 })),
    getRun: vi.fn(async () => ({ runId, documentId: `doc_${'e'.repeat(20)}`, status: 'generating', stage: 'extract', revision: 2, retryCount: 0, lastEventSeq: 2 })),
    listEvents: vi.fn(async () => ({ events: [], nextAfter: 0 })),
    launchRetry: vi.fn(async () => ({ runId, attemptId: `att_${'f'.repeat(20)}`, revision: 7 })),
    listCandidates: vi.fn(async () => ({ candidates: [] })),
    reviewCandidate: vi.fn(async () => ({ candidateId, status: 'accepted' })),
    listKnowledgePoints: vi.fn(async () => ({ knowledgePoints: [] })),
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
  registerProductRoutes({ webServer } as never, supervisor, ops)
  const server = createServer((req, res) => void Promise.resolve(handler(req, res)))
  servers.add(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  webServer.port = (server.address() as AddressInfo).port
  return { port: webServer.port, supervisor }
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
  if (input.method === 'POST' && headers['content-type'] === undefined) headers['content-type'] = 'application/json'
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
  { key: 'getRun', method: 'GET', path: `/nobei/v1/runs/${runId}`, status: 200 },
  { key: 'listEvents', method: 'GET', path: `/nobei/v1/runs/${runId}/events?after=0`, status: 200 },
  { key: 'launchRetry', method: 'POST', path: `/nobei/v1/runs/${runId}/retry`, body: JSON.stringify({ expectedRevision: 6 }), status: 202 },
  { key: 'listCandidates', method: 'GET', path: `/nobei/v1/runs/${runId}/candidates`, status: 200 },
  { key: 'reviewCandidate', method: 'POST', path: `/nobei/v1/candidates/${candidateId}/review`, body: JSON.stringify({ action: 'accept', expectedRevision: 2, idempotencyKey }), status: 200 },
  { key: 'listKnowledgePoints', method: 'GET', path: `/nobei/v1/runs/${runId}/knowledge-points`, status: 200 },
] as const

const states: CoreState[] = ['STARTING', 'READY', 'RESTARTING', 'DEGRADED', 'DISPOSING', 'DISPOSED']

describe('product route table', () => {
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
  ])('returns a closed error for %s', async (_name, input, status, code) => {
    const ops = operations()
    const { port } = await listen('READY', ops)
    const response = await send(port, input)
    expect(response.status).toBe(status)
    expect(response.body).toEqual({ ok: false, error: { code } })
    expect(JSON.stringify(response.body)).not.toContain('canary')
    expect(Object.values(ops).every((operation) => vi.mocked(operation).mock.calls.length === 0)).toBe(true)
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
