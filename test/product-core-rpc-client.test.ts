import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  CORE_READ_RPC_TIMEOUT_MS,
  CORE_WRITE_RPC_TIMEOUT_MS,
  GENERATION_FINALIZE_RPC_TIMEOUT_MS,
} from '../src/product/constants.js'
import { CoreRpcError, FixedCoreRpcClient } from '../src/product/core-rpc-client.js'

function pair() {
  const input = new PassThrough()
  const output = new PassThrough()
  const requests: Array<Record<string, unknown>> = []
  let outgoing = ''
  output.setEncoding('utf8')
  output.on('data', (chunk: string) => {
    outgoing += chunk
    while (outgoing.includes('\n')) {
      const newline = outgoing.indexOf('\n')
      const line = outgoing.slice(0, newline)
      outgoing = outgoing.slice(newline + 1)
      if (line) requests.push(JSON.parse(line) as Record<string, unknown>)
    }
  })
  const onPoisoned = vi.fn()
  const client = new FixedCoreRpcClient(input, output, { onPoisoned })
  return { client, input, output, requests, onPoisoned }
}

function result(id: number, value: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, result: value })}\n`
}

afterEach(() => {
  vi.useRealTimers()
})

describe('FixedCoreRpcClient', () => {
  test('writes the closed global run-history request', async () => {
    const { client, input, requests } = pair()
    const pending = (client as unknown as {
      listRuns(signal?: AbortSignal): Promise<Record<string, unknown>>
    }).listRuns()

    expect(requests).toEqual([{
      jsonrpc: '2.0', id: 1, method: 'runs.list', params: {},
    }])
    input.write(result(1, { runs: [] }))
    await expect(pending).resolves.toEqual({ runs: [] })
  })

  test('assembles fragmented UTF-8 and dispatches multiple response frames', async () => {
    const { client, input, requests } = pair()
    const first = client.getRun({ runId: 'job_0123456789abcdefabcd' })
    const second = client.listEvents({ runId: 'job_0123456789abcdefabcd', after: 0 })
    expect(requests.map((request) => request.method)).toEqual(['runs.get', 'runs.list_events'])

    const payload = Buffer.from(
      result(1, { marker: '甲😀' }) + result(2, { events: [], nextAfter: 0 }),
      'utf8',
    )
    const split = payload.indexOf(Buffer.from('😀')) + 2
    input.write(payload.subarray(0, split))
    input.write(payload.subarray(split))

    await expect(first).resolves.toEqual({ marker: '甲😀' })
    await expect(second).resolves.toEqual({ events: [], nextAfter: 0 })
  })

  test.each([
    ['malformed JSON', '{broken}\n', 'CORE_RPC_MALFORMED_JSON'],
    ['unknown id', result(99, {}), 'CORE_RPC_UNKNOWN_ID'],
    ['oversized frame', `${'x'.repeat(32 * 1024 * 1024 + 1)}\n`, 'CORE_RPC_MESSAGE_TOO_LARGE'],
  ])('poisons pending requests on %s', async (_name, frame, code) => {
    const { client, input, onPoisoned } = pair()
    const pending = client.getRun({ runId: 'job_0123456789abcdefabcd' })
    input.write(frame)
    await expect(pending).rejects.toThrow(code)
    expect(onPoisoned).toHaveBeenCalledTimes(1)
  })

  test('rejects duplicate response ids and EOF', async () => {
    const duplicatePair = pair()
    const first = duplicatePair.client.getRun({ runId: 'job_0123456789abcdefabcd' })
    duplicatePair.input.write(result(1, {}))
    await first
    const second = duplicatePair.client.getRun({ runId: 'job_0123456789abcdefabcd' })
    duplicatePair.input.write(result(1, {}))
    await expect(second).rejects.toThrow('CORE_RPC_DUPLICATE_ID')

    const eofPair = pair()
    const pending = eofPair.client.getRun({ runId: 'job_0123456789abcdefabcd' })
    eofPair.input.end()
    await expect(pending).rejects.toThrow('CORE_RPC_EOF')
  })

  test('preserves only the stable public Core error code', async () => {
    const { client, input } = pair()
    const pending = client.getRun({ runId: 'job_0123456789abcdefabcd' })
    input.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1,
      error: { code: -32000, message: 'INVALID_IDENTIFIER', data: { code: 'INVALID_IDENTIFIER' } },
    })}\n`)
    const error = await pending.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CoreRpcError)
    expect(error).toMatchObject({ code: 'INVALID_IDENTIFIER' })
    expect(String(error)).not.toContain('job_0123456789abcdefabcd')
  })

  test('close rejects every pending call without poisoning the supervisor', async () => {
    const { client, onPoisoned } = pair()
    const first = client.getRun({ runId: 'job_0123456789abcdefabcd' })
    const second = client.importAndPrepare({
      filename: 'chapter.md', mediaType: 'text/markdown', text: 'content',
      modelSelection: { provider: 'test', model: 'model', reasoningEffort: 'medium' },
    })
    client.close()
    await expect(first).rejects.toThrow('CORE_RPC_CLOSED')
    await expect(second).rejects.toThrow('CORE_RPC_CLOSED')
    await expect(client.getRun({ runId: 'job_0123456789abcdefabcd' }))
      .rejects.toThrow('CORE_RPC_CLOSED')
    expect(onPoisoned).not.toHaveBeenCalled()
  })

  test('read, write, and finalize deadlines poison exactly once', async () => {
    vi.useFakeTimers()
    expect(CORE_READ_RPC_TIMEOUT_MS).toBe(3_000)
    expect(CORE_WRITE_RPC_TIMEOUT_MS).toBe(10_000)
    expect(GENERATION_FINALIZE_RPC_TIMEOUT_MS).toBe(10_000)

    const cases = [
      {
        create: (client: FixedCoreRpcClient) => client.getRun({ runId: 'job_0123456789abcdefabcd' }),
        timeout: CORE_READ_RPC_TIMEOUT_MS,
      },
      {
        create: (client: FixedCoreRpcClient) => client.importAndPrepare({
          filename: 'chapter.md', mediaType: 'text/markdown', text: 'content',
          modelSelection: { provider: 'test', model: 'model' },
        }),
        timeout: CORE_WRITE_RPC_TIMEOUT_MS,
      },
      {
        create: (client: FixedCoreRpcClient) => client.failGeneration({
          runId: 'job_0123456789abcdefabcd', attemptId: 'att_0123456789abcdefabcd',
          expectedRevision: 2, code: 'GENERATION_TIMEOUT',
        }),
        timeout: GENERATION_FINALIZE_RPC_TIMEOUT_MS,
      },
    ]
    for (const item of cases) {
      const { client, onPoisoned } = pair()
      const pending = item.create(client)
      const observed = pending.catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(item.timeout - 1)
      expect(onPoisoned).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(await observed).toMatchObject({ code: 'CORE_RPC_TIMEOUT' })
      expect(onPoisoned).toHaveBeenCalledTimes(1)
    }
  })

  test('writes exact protocol-v3 generation request shapes', async () => {
    const { client, input, requests } = pair()
    const imported = client.importAndPrepare({
      filename: 'chapter.md',
      mediaType: 'text/markdown',
      text: 'content',
      modelSelection: { provider: 'provider-fixture', model: 'model-fixture', reasoningEffort: 'high' },
    })
    const submitted = client.submitGeneration({
      runId: 'job_0123456789abcdefabcd',
      attemptId: 'att_0123456789abcdefabcd',
      expectedRevision: 2,
      output: { schemaVersion: 1, candidates: [] },
    })
    const failed = client.failGeneration({
      runId: 'job_0123456789abcdefabcd',
      attemptId: 'att_0123456789abcdefabcd',
      expectedRevision: 2,
      code: 'GENERATION_PROVIDER_ERROR',
    })

    expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
      {
        method: 'documents.import_and_prepare_generation',
        params: {
          filename: 'chapter.md',
          mediaType: 'text/markdown',
          text: 'content',
          modelSelection: {
            provider: 'provider-fixture', model: 'model-fixture', reasoningEffort: 'high',
          },
        },
      },
      {
        method: 'runs.submit_generation',
        params: {
          runId: 'job_0123456789abcdefabcd',
          attemptId: 'att_0123456789abcdefabcd',
          expectedRevision: 2,
          output: { schemaVersion: 1, candidates: [] },
        },
      },
      {
        method: 'runs.fail_generation',
        params: {
          runId: 'job_0123456789abcdefabcd',
          attemptId: 'att_0123456789abcdefabcd',
          expectedRevision: 2,
          code: 'GENERATION_PROVIDER_ERROR',
        },
      },
    ])
    input.write(result(1, { ok: true }))
    input.write(result(2, { ok: true }))
    input.write(result(3, { ok: true }))
    await expect(Promise.all([imported, submitted, failed])).resolves.toEqual([
      { ok: true }, { ok: true }, { ok: true },
    ])
  })

  test('has no public generic request escape hatch', () => {
    const { client } = pair()
    expect((client as unknown as { request?: unknown }).request).toBeUndefined()
    if (false) {
      // @ts-expect-error generic methods are intentionally not public
      void client.request('arbitrary.method', {})
    }
    client.close()
  })
})


test('preview forwards fixed RPC without import or generation', async () => {
  const { client, input, requests } = pair()
  const params = { filename: 'lesson.pdf', mediaType: 'application/pdf' as const, contentBase64: 'JVBERi0=' }
  const preview = client.previewDocument(params)
  expect(requests[0]).toMatchObject({ method: 'documents.preview', params })
  input.write(result(1, { text: '正文😀', extractionPlan: { strategy: 'L1', maxCalls: 1 } }))
  expect(await preview).toMatchObject({ text: '正文😀' })
  client.close()
})
