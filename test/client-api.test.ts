import { afterEach, describe, expect, test, vi } from 'vitest'
import { createClientApi, ProductApiError } from '../src/client/client-api.js'

function success(result: unknown, status = 200): Response {
  return {
    ok: true,
    status,
    json: async () => ({ ok: true, result }),
  } as Response
}

function failure(status: number, code: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ ok: false, error: { code } }),
  } as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('phase1d Client API', () => {
  test('previews a PDF through a same-origin read-only product operation', async () => {
    const fetchMock = vi.fn(async () => success({ text: 'canonical', extractionPlan: { strategy: 'L1', maxCalls: 1 } }))
    vi.stubGlobal('fetch', fetchMock)
    const input = { filename: 'text.pdf', mediaType: 'application/pdf' as const, contentBase64: 'cGRm' }
    const result = await createClientApi().previewDocument!(input)
    expect(result.text).toBe('canonical')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith('/nobei/v1/documents/preview', {
      method: 'POST', body: JSON.stringify(input), headers: { 'content-type': 'application/json' }, signal: undefined,
    })
  })
  test('listens to SSE hints and silently closes on disconnect', () => {
    const stream = { addEventListener: vi.fn(), close: vi.fn(), onerror: null as null | (() => void) }
    const EventSource = vi.fn(function () { return stream })
    vi.stubGlobal('EventSource', EventSource)
    const changed = vi.fn()
    const stop = createClientApi().watchRun!('job_1', changed)
    expect(EventSource).toHaveBeenCalledWith('/nobei/v1/runs/job_1/stream')
    expect(stream.addEventListener).toHaveBeenCalledWith('run.changed', changed)
    stream.onerror!()
    expect(stream.close).toHaveBeenCalledOnce()
    expect(changed).not.toHaveBeenCalled()
    stop()
  })

  test('delivers progress separately from run changes and provides polling fallback', async () => {
    const listeners: Record<string, (e: any) => void> = {}
    vi.stubGlobal('EventSource', function () { return { addEventListener: (name: string, cb: any) => { listeners[name] = cb }, close: vi.fn() } })
    const api = createClientApi(), changed = vi.fn(), progress = vi.fn()
    const stop = api.watchRun!('job_1', changed, progress)
    expect(listeners['run.progress']).toBeTypeOf('function')
    listeners['run.progress']!({ data: JSON.stringify({ completedBatches: 2 }) })
    expect(progress).toHaveBeenCalledWith({ completedBatches: 2 })
    expect(changed).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', vi.fn(async () => success(null)))
    expect(await api.getProgress!('job_1')).toBeNull()
    stop()
  })

  test('SSE is optional when EventSource is unavailable', () => {
    vi.stubGlobal('EventSource', undefined)
    expect(() => createClientApi().watchRun!('job_1', vi.fn())()).not.toThrow()
  })

  test('maps all operations to exact same-origin requests', async () => {
    const fetchMock = vi.fn(async () => success({}))
    vi.stubGlobal('fetch', fetchMock)
    const api = createClientApi()
    const controller = new AbortController()
    const runId = 'job_0123456789abcdefabcd'
    const candidateId = 'cand_0123456789abcdefabcd'
    const knowledgePointId = 'kp_0123456789abcdefabcd'
    const idempotencyKey = `idem_${'a'.repeat(20)}`

    await (api as unknown as { listRuns(signal?: AbortSignal): Promise<unknown> })
      .listRuns(controller.signal)
    expect(fetchMock).toHaveBeenLastCalledWith('/nobei/v1/runs', {
      method: 'GET', headers: {}, signal: controller.signal,
    })

    await api.importText({ filename: '教材.md', mediaType: 'text/markdown', text: '正文' }, controller.signal)
    expect(fetchMock).toHaveBeenLastCalledWith('/nobei/v1/imports', {
      method: 'POST',
      body: JSON.stringify({ filename: '教材.md', mediaType: 'text/markdown', text: '正文' }),
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
    })

    await api.getRun(runId, controller.signal)
    expect(fetchMock).toHaveBeenLastCalledWith(`/nobei/v1/runs/${runId}`, {
      method: 'GET', headers: {}, signal: controller.signal,
    })

    await api.listEvents(runId, 0, controller.signal)
    expect(fetchMock).toHaveBeenLastCalledWith(`/nobei/v1/runs/${runId}/events?after=0`, {
      method: 'GET', headers: {}, signal: controller.signal,
    })

    await api.retryRun(runId, 3, controller.signal)
    expect(fetchMock).toHaveBeenLastCalledWith(`/nobei/v1/runs/${runId}/retry`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: 3 }),
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
    })

    await api.listCandidates(runId, controller.signal)
    expect(fetchMock).toHaveBeenLastCalledWith(`/nobei/v1/runs/${runId}/candidates`, {
      method: 'GET', headers: {}, signal: controller.signal,
    })

    await api.reviewCandidate(candidateId, {
      action: 'edited_and_accept', expectedRevision: 1, idempotencyKey,
      title: '定稿标题', statement: '定稿陈述',
    }, controller.signal)
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/nobei/v1/candidates/${candidateId}/review`,
      {
        method: 'POST',
        body: JSON.stringify({
          action: 'edited_and_accept', expectedRevision: 1, idempotencyKey,
          title: '定稿标题', statement: '定稿陈述',
        }),
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
      },
    )

    await api.listKnowledgePoints(runId, controller.signal)
    expect(fetchMock).toHaveBeenLastCalledWith(`/nobei/v1/runs/${runId}/knowledge-points`, {
      method: 'GET', headers: {}, signal: controller.signal,
    })

    await api.updateKnowledgePoint(knowledgePointId, {
      title: '新标题', statement: '新陈述',
    }, controller.signal)
    expect(fetchMock).toHaveBeenLastCalledWith(`/nobei/v1/knowledge-points/${knowledgePointId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: '新标题', statement: '新陈述' }),
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
    })
  })

  test('encodes resource IDs instead of interpolating raw path data', async () => {
    const fetchMock = vi.fn(async () => success({}))
    vi.stubGlobal('fetch', fetchMock)
    await createClientApi().getRun('job/value')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/nobei/v1/runs/job%2Fvalue')
  })

  test('returns successful 200 and 202 result envelopes', async () => {
    const launch = { runId: 'job_1', attemptId: 'attempt_1', revision: 2 }
    vi.stubGlobal('fetch', vi.fn(async () => success(launch, 202)))
    await expect(createClientApi().importText({
      filename: 'a.txt', mediaType: 'text/plain', text: 'a',
    })).resolves.toEqual(launch)
  })

  test('throws stable product errors from non-success envelopes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => failure(503, 'CORE_UNAVAILABLE')))
    await expect(createClientApi().getRun('job_1')).rejects.toMatchObject<ProductApiError>({
      status: 503,
      code: 'CORE_UNAVAILABLE',
    })
  })

  test('maps malformed JSON and envelopes to INVALID_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') },
    } as Response)))
    await expect(createClientApi().getRun('job_1')).rejects.toMatchObject({
      status: 200,
      code: 'INVALID_RESPONSE',
    })

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ ok: true }),
    } as Response)))
    await expect(createClientApi().getRun('job_1')).rejects.toMatchObject({
      status: 200,
      code: 'INVALID_RESPONSE',
    })

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ ok: false, error: { code: 'RUN_STATE_CONFLICT' } }),
    } as Response)))
    await expect(createClientApi().getRun('job_1')).rejects.toMatchObject({
      status: 200,
      code: 'RUN_STATE_CONFLICT',
    })
  })

  test('preserves AbortError from fetch', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn(async () => { throw abort }))
    await expect(createClientApi().getRun('job_1')).rejects.toBe(abort)
  })
})
