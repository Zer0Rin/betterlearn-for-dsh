import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { loadCandidateContract } from '../../../src/product/contract.js'
import {
  p3Fixture,
  FakeProviderAdapter,
  fakeProviderRequestDigest,
  installFakeProvider,
  inject,
  name,
} from '../src/index.js'

const request = (signal?: AbortSignal, fixture = 'one'): GenerateOptions => ({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: `fixture:${fixture}` }],
  tools: [{
    name: 'structured_output',
    description: 'Return candidates.',
    parameters: { type: 'object' },
  }],
  maxTokens: 2_048,
  signal,
} as unknown as GenerateOptions)

const activationRequest = (): GenerateOptions => ({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'Phase 1D WebUI activation. No product data.' }],
  tools: [],
  maxTokens: 128,
} as unknown as GenerateOptions)

describe('FakeProviderAdapter', () => {
  test('progress fixture streams separated activity and still makes exactly one fake call', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new FakeProviderAdapter()
      const chunks: any[] = []
      const draining = (async () => { for await (const chunk of adapter.stream(request(undefined, 'progress'))) chunks.push(chunk) })()
      await vi.advanceTimersByTimeAsync(3999)
      expect(chunks).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(chunks.some(chunk => chunk.type === 'reasoning-delta')).toBe(true)
      expect(adapter.records).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(4000); await draining
      expect(chunks.at(-1).reason.kind).toBe('tool-calls')
      expect(chunks.find(chunk => chunk.type === 'tool-call-delta').index).toBe(1)
      expect(adapter.records).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  test('replays reasoning-only exhaustion without emitting a structured answer', async () => {
    const adapter = new FakeProviderAdapter()
    const chunks = []
    for await (const chunk of adapter.stream(request(undefined, 'output-limit'))) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'block-end', block: { type: 'reasoning', text: 'Fixture reasoning.' } }))
    expect(chunks.some(chunk => chunk.type === 'tool-call-delta')).toBe(false)
    expect(adapter.records).toHaveLength(1)
  })
  test('is packaged as an acceptance-only DSH plugin', () => {
    expect(name).toBe('nobei-phase1c-fake-provider')
    expect(inject).toEqual(['llm', 'webServer'])
  })
  test('has a per-instance nonce and emits a deterministic legal tool call without fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden in fake'))
    try {
      const first = new FakeProviderAdapter()
      const second = new FakeProviderAdapter()
      expect(first.nonce).toMatch(/^[a-f0-9]{32,}$/)
      expect(second.nonce).not.toBe(first.nonce)
      expect(first.providerInfo('deepseek-official').id).toBe('deepseek-official')

      const chunks = []
      for await (const chunk of first.stream(request())) chunks.push(chunk)
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
      expect(chunks).toContainEqual(expect.objectContaining({
        type: 'block-end',
        block: expect.objectContaining({ type: 'tool-call', name: 'structured_output' }),
      }))
      const toolCall = chunks.find((chunk) => chunk.type === 'block-end')
      const fixture = JSON.parse(toolCall!.block.arguments)
      expect(fixture).toEqual({
        schemaVersion: 1,
        candidates: [{
          type: 'concept',
          title: '光合作用',
          statement: '光合作用是绿色植物利用光能的过程。',
          evidence: [{ quote: '光合作用是绿色植物利用光能的过程。', prefix: '', suffix: '' }],
        }],
      })
      expect(fixture.candidates).toHaveLength(1)
      expect(first.records).toEqual([expect.objectContaining({
        sequence: 1,
        providerRequestDigest: fakeProviderRequestDigest(request()),
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        toolNames: ['structured_output'],
        result: 'structured',
        adapterNonce: first.nonce,
      })])
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test('honors an already-aborted signal and records aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const adapter = new FakeProviderAdapter()
    const chunks = []
    for await (const chunk of adapter.stream(request(controller.signal))) chunks.push(chunk)
    expect(chunks).toEqual([expect.objectContaining({
      type: 'finish',
      reason: expect.objectContaining({ kind: 'aborted' }),
    })])
    expect(adapter.records[0]?.result).toBe('aborted')
  })

  test('activates the blank DSH conversation without a structured product call', async () => {
    const adapter = new FakeProviderAdapter()
    const chunks = []
    for await (const chunk of adapter.stream(activationRequest())) chunks.push(chunk)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Nobei WebUI ready.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Nobei WebUI ready.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(adapter.records).toEqual([expect.objectContaining({
      toolNames: [],
      result: 'text',
    })])
  })

  test('selects fixtures deterministically from the request text', async () => {
    const adapter = new FakeProviderAdapter({
      fixtures: {
        one: { schemaVersion: 1, candidates: [{ title: 'One' }] },
      },
    })
    const chunks = []
    for await (const chunk of adapter.stream(request())) chunks.push(chunk)
    const end = chunks.find((chunk) => chunk.type === 'block-end')
    expect(end).toEqual(expect.objectContaining({
      block: expect.objectContaining({ arguments: JSON.stringify({ schemaVersion: 1, candidates: [{ title: 'One' }] }) }),
    }))
  })

  test('exposes valid spike-only model reasoning metadata and records explicit effort ownership', async () => {
    const adapter = new FakeProviderAdapter()
    for (const [provider, model, hasDefault] of [
      ['fake-a', 'model-a', true], ['fake-b', 'model-b', true], ['fake-c', 'model-c', false],
    ] as const) {
      const resolved = await adapter.resolveModel(provider, model)
      const efforts = resolved.reasoning?.efforts ?? []
      expect(efforts).not.toHaveLength(0)
      expect(new Set(efforts.map((effort) => effort.id)).size).toBe(efforts.length)
      expect(efforts.every((effort) => effort.id.length > 0 && effort.name.length > 0)).toBe(true)
      expect(Object.hasOwn(resolved.reasoning ?? {}, 'defaultEffort')).toBe(hasDefault)
      if (resolved.reasoning?.defaultEffort) {
        expect(efforts.map((effort) => effort.id)).toContain(resolved.reasoning.defaultEffort)
      }
    }
    await expect(adapter.resolveModel('fake-a', 'model-b')).rejects.toThrow('FAKE_PROVIDER_ROUTE_INVALID')

    const explicit = { ...request(), provider: 'fake-b', model: 'model-b', reasoningEffort: 'high' } as GenerateOptions
    const omitted = { ...request(), provider: 'fake-c', model: 'model-c' } as GenerateOptions
    for await (const _chunk of adapter.stream(explicit)) { /* drain */ }
    for await (const _chunk of adapter.stream(omitted)) { /* drain */ }
    expect(adapter.records[0]).toMatchObject({ provider: 'fake-b', model: 'model-b', reasoningEffort: 'high' })
    expect(Object.hasOwn(adapter.records[0]!, 'reasoningEffort')).toBe(true)
    expect(adapter.records[1]).toMatchObject({ provider: 'fake-c', model: 'model-c' })
    expect(Object.hasOwn(adapter.records[1]!, 'reasoningEffort')).toBe(false)
  })

  test('preserves exact-model resolution for the existing Phase 1C/1D route', async () => {
    const adapter = new FakeProviderAdapter()
    await expect(adapter.resolveModel('deepseek-official', 'deepseek-v4-flash')).resolves.toEqual({
      provider: 'deepseek-official',
      id: 'deepseek-v4-flash',
      name: 'deepseek-v4-flash',
    })
    await expect(adapter.resolveModel('deepseek-official', 'model-a'))
      .rejects.toThrow('FAKE_PROVIDER_ROUTE_INVALID')
  })

  test('returns three schema-valid candidates whose quotes occur exactly once', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new FakeProviderAdapter()
      const chunks: Awaited<ReturnType<AsyncIterator<unknown>['next']>>['value'][] = []
      const collecting = (async () => {
        for await (const chunk of adapter.stream(request(undefined, 'three'))) chunks.push(chunk)
      })()
      await vi.advanceTimersByTimeAsync(1_000)
      await collecting
      const end = chunks.find((chunk: any) => chunk.type === 'block-end') as any
      const value = JSON.parse(end.block.arguments)
      const quotes = [
        '光合作用是绿色植物利用光能合成有机物并释放氧气的过程。',
        '叶绿体中的叶绿素负责吸收光能。',
        '光合作用为生态系统提供有机物和氧气。',
      ]
      const body = `fixture:three\n${quotes.join('\n')}`
      expect(value.candidates).toHaveLength(3)
      expect(value.candidates.map((item: any) => item.evidence[0].quote)).toEqual(quotes)
      for (const item of value.candidates) {
        expect(item.evidence[0]).toMatchObject({ prefix: '', suffix: '' })
        expect(body.split(item.evidence[0].quote)).toHaveLength(2)
      }
      const root = fileURLToPath(new URL('../../../', import.meta.url))
      expect(loadCandidateContract(root).validate(value)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  test('holds fixture:three for 1,000 ms and records abort during the window', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new FakeProviderAdapter()
      const iterator = adapter.stream(request(undefined, 'three'))[Symbol.asyncIterator]()
      const first = iterator.next()
      await vi.advanceTimersByTimeAsync(999)
      let settled = false
      void first.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(first).resolves.toMatchObject({ value: { type: 'block-start' }, done: false })

      const controller = new AbortController()
      const abortedAdapter = new FakeProviderAdapter()
      const abortedIterator = abortedAdapter.stream(request(controller.signal, 'three'))[Symbol.asyncIterator]()
      const abortedFirst = abortedIterator.next()
      controller.abort()
      await vi.runAllTimersAsync()
      await expect(abortedFirst).resolves.toMatchObject({
        value: { type: 'finish', reason: { kind: 'aborted' } }, done: false,
      })
      expect(abortedAdapter.records.at(-1)?.result).toBe('aborted')
    } finally {
      vi.useRealTimers()
    }
  })

  test('registers only its logical provider and an exact token-protected ledger route', () => {
    let route: { kind: string; path: string; handler: Function } | undefined
    const unregisterAdapter = vi.fn()
    const unregisterRoute = vi.fn()
    const ctx = {
      llm: {
        registerAdapter: vi.fn(() => unregisterAdapter),
      },
      webServer: {
        register: vi.fn((candidate) => {
          route = candidate
          return unregisterRoute
        }),
      },
    }
    const installed = installFakeProvider(ctx as never)
    expect(installed.ledgerToken).toMatch(/^[a-f0-9]{32,}$/)
    expect(ctx.llm.registerAdapter).toHaveBeenCalledWith(['deepseek-official', 'fake-a', 'fake-b', 'fake-c'], installed.adapter)
    expect(route).toEqual(expect.objectContaining({
      kind: 'exact',
      path: '/nobei-acceptance/fake-provider-ledger',
    }))
    installed.dispose()
    expect(unregisterRoute).toHaveBeenCalledOnce()
    expect(unregisterAdapter).toHaveBeenCalledOnce()
  })

  test('rejects a short acceptance ledger token before registration', () => {
    const ctx = {
      llm: { registerAdapter: vi.fn() },
      webServer: { register: vi.fn() },
    }
    expect(() => installFakeProvider(ctx as never, { ledgerToken: 'short' }))
      .toThrow('FAKE_LEDGER_TOKEN_INVALID')
    expect(ctx.llm.registerAdapter).not.toHaveBeenCalled()
  })
})


test('P3 fixtures plan pairs, emit exact Unicode evidence and preserve failure marker', () => {
  const blocks = [{ id: 'b1', text: '甲' }, { id: 'b2', text: '乙' }, { id: 'b3', text: '丙' }]
  const planning = `Nobei semantic planning (P3).\nBLOCKS_JSON:\n${JSON.stringify(blocks)}`
  expect(p3Fixture([{ content: planning }])).toEqual({ groups: [{ blockIds: ['b1', 'b2'] }, { blockIds: ['b3'] }] })
  blocks[0].text = 'fixture:p3-invalid-plan'
  expect(p3Fixture([{ content: `Nobei semantic planning (P3).\nBLOCKS_JSON:\n${JSON.stringify(blocks)}` }])).toEqual({ groups: [{ blockIds: ['missing-block'] }] })
  const source = '😀'.repeat(41) + '\nP3事实：知识😀\n尾段'
  const value = p3Fixture([{ content: `Nobei candidate extraction (l1-v2).\nSOURCE:\n${source}` }]) as any
  expect(value.candidates[0]).toMatchObject({ title: '知识😀', statement: '知识😀', evidence: [{ quote: 'P3事实：知识😀', prefix: '😀'.repeat(39) + '\n', suffix: '\n尾段' }] })
})
