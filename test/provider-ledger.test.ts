import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, test } from 'vitest'
import {
  ProviderLedger,
  compareProviderLedgers,
  providerRequestDigest,
  type ProviderAttemptContext,
  type FakeLedgerRecord,
} from '../src/product/provider-ledger.js'

const structuredOutputTool = {
  name: 'structured_output',
  description: 'Return candidates.',
  parameters: { type: 'object', required: ['candidates'] },
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'provider-fixture',
    model: 'model-fixture',
    reasoningEffort: 'high' as never,
    messages: [{ role: 'user', content: 'canary-document-secret-7341' }],
    system: 'canary-system-secret-9082',
    tools: [structuredOutputTool],
    maxTokens: 2_048,
    ...overrides,
  } as GenerateOptions
}

function attempt(coreRequestDigest = 'a'.repeat(64)): ProviderAttemptContext {
  return {
    coreRequestDigest,
    modelSelection: {
      provider: 'provider-fixture', model: 'model-fixture', reasoningEffort: 'high',
    },
    promptVersion: 'phase1e-v1',
    schemaSha256: 'f'.repeat(64),
  }
}

async function consume(
  ledger: ProviderLedger,
  options: GenerateOptions,
  reached: { count: number },
  result: 'structured' | 'aborted' | 'error' = 'structured',
): Promise<void> {
  const next = (): AsyncIterable<StreamChunk> => ({
    async *[Symbol.asyncIterator]() {
      reached.count += 1
      if (result === 'structured') {
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield {
          type: 'finish',
          reason: { kind: result, failure: { code: result.toUpperCase(), message: result } },
        }
      }
    },
  })
  for await (const _chunk of ledger.wrap(options, next)) {
    // consume the complete boundary stream
  }
}

describe('ProviderLedger', () => {
  test('rejects attributed mismatches before next()', async () => {
    const cases: GenerateOptions[] = [
      request({ provider: 'other' }),
      request({ model: 'other' }),
      request({ reasoningEffort: 'low' as never }),
      request({ reasoningEffort: undefined }),
      request({ purpose: 'session-title' }),
      request({ tools: [] }),
      request({ tools: [{ ...structuredOutputTool, name: 'run_code' }] }),
      request({ tools: [structuredOutputTool, { ...structuredOutputTool, name: 'run_code' }] }),
    ]
    for (const options of cases) {
      const ledger = new ProviderLedger()
      const reached = { count: 0 }
      await expect(ledger.runInAttempt(attempt(), () => consume(ledger, options, reached)))
        .rejects.toThrow('PROVIDER_BOUNDARY_REJECTED')
      expect(reached.count).toBe(0)
      expect(ledger.records).toEqual([])
    }
  })

  test('leaves non-Nobei DSH streams untouched and outside the product ledger', async () => {
    const ledger = new ProviderLedger()
    const reached = { count: 0 }
    await consume(ledger, request({ provider: 'ordinary-chat', model: 'chat-model' }), reached)
    expect(reached.count).toBe(1)
    expect(ledger.records).toEqual([])
  })

  test.each(['structured', 'aborted', 'error'] as const)(
    'records one non-sensitive row for a %s result',
    async (result) => {
      const ledger = new ProviderLedger()
      const options = request()
      await ledger.runInAttempt(attempt('b'.repeat(64)), () => consume(ledger, options, { count: 0 }, result))
      expect(ledger.records).toEqual([{
        sequence: 1,
        coreRequestDigest: 'b'.repeat(64),
        providerRequestDigest: providerRequestDigest(options),
        provider: 'provider-fixture',
        model: 'model-fixture',
        reasoningEffort: 'high',
        promptVersion: 'phase1e-v1',
        schemaSha256: 'f'.repeat(64),
        toolNames: ['structured_output'],
        result,
      }])
      const serialized = JSON.stringify(ledger.records)
      expect(serialized).not.toContain('canary-document-secret-7341')
      expect(serialized).not.toContain('canary-system-secret-9082')
      expect(serialized).not.toContain('messages')
    },
  )

  test('does not record when next throws before a terminal result', async () => {
    const ledger = new ProviderLedger()
    const next = (): AsyncIterable<StreamChunk> => ({
      async *[Symbol.asyncIterator]() { throw new Error('adapter exploded') },
    })
    await expect(ledger.runInAttempt(attempt('c'.repeat(64)), async () => {
      for await (const _chunk of ledger.wrap(request(), next)) { /* consume */ }
    })).rejects.toThrow('adapter exploded')
    expect(ledger.records).toEqual([])
  })

  test('atomically consumes one stream allowance per Core request digest', async () => {
    const ledger = new ProviderLedger()
    const first = { count: 0 }
    await ledger.runInAttempt(attempt('d'.repeat(64)), () => consume(ledger, request(), first))
    expect(first.count).toBe(1)

    const sequential = { count: 0 }
    await expect(ledger.runInAttempt(attempt('d'.repeat(64)), () => (
      consume(ledger, request(), sequential)
    ))).rejects.toThrow('PROVIDER_CALL_BUDGET_EXCEEDED')
    expect(sequential.count).toBe(0)

    const other = { count: 0 }
    await ledger.runInAttempt(attempt('e'.repeat(64)), () => consume(ledger, request(), other))
    expect(other.count).toBe(1)
  })

  test('claims before next and never restores allowance after failure', async () => {
    const ledger = new ProviderLedger()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let entered = 0
    const next = (): AsyncIterable<StreamChunk> => ({
      async *[Symbol.asyncIterator]() {
        entered += 1
        await held
        throw new Error('provider failed')
      },
    })
    const context = attempt('9'.repeat(64))
    const first = ledger.runInAttempt(context, async () => {
      for await (const _chunk of ledger.wrap(request(), next)) { /* consume */ }
    })
    await Promise.resolve()
    const secondReached = { count: 0 }
    await expect(ledger.runInAttempt(context, () => consume(ledger, request(), secondReached)))
      .rejects.toThrow('PROVIDER_CALL_BUDGET_EXCEEDED')
    expect(secondReached.count).toBe(0)
    release()
    await expect(first).rejects.toThrow('provider failed')
    expect(entered).toBe(1)

    await expect(ledger.runInAttempt(context, () => consume(ledger, request(), secondReached)))
      .rejects.toThrow('PROVIDER_CALL_BUDGET_EXCEEDED')
    expect(secondReached.count).toBe(0)
  })
})

describe('compareProviderLedgers', () => {
  const options = request()
  const digest = providerRequestDigest(options)
  const boundary = [{
    sequence: 1,
    coreRequestDigest: 'd'.repeat(64),
    providerRequestDigest: digest,
    provider: 'provider-fixture',
    model: 'model-fixture',
    reasoningEffort: 'high',
    promptVersion: 'phase1e-v1',
    schemaSha256: 'f'.repeat(64),
    toolNames: ['structured_output'] as ['structured_output'],
    result: 'structured' as const,
  }]
  const fake: FakeLedgerRecord[] = [{
    sequence: 1,
    providerRequestDigest: digest,
    provider: 'provider-fixture',
    model: 'model-fixture',
    reasoningEffort: 'high',
    toolNames: ['structured_output'],
    result: 'structured',
    adapterNonce: 'n'.repeat(32),
  }]
  const transcripts = [{ sequence: 1, coreRequestDigest: 'd'.repeat(64) }]

  test('accepts exact independently-computed rows and prepared Core transcripts', () => {
    expect(compareProviderLedgers(boundary, fake, transcripts, 'n'.repeat(32))).toEqual({ calls: 1 })
  })

  test.each([
    ['missing row', [], transcripts, 'n'.repeat(32)],
    ['extra row', [...fake, { ...fake[0], sequence: 2 }], transcripts, 'n'.repeat(32)],
    ['wrong sequence', [{ ...fake[0], sequence: 2 }], transcripts, 'n'.repeat(32)],
    ['wrong nonce', [{ ...fake[0], adapterNonce: 'x'.repeat(32) }], transcripts, 'n'.repeat(32)],
    ['wrong identity', [{ ...fake[0], model: 'other' as never }], transcripts, 'n'.repeat(32)],
    ['wrong provider digest', [{ ...fake[0], providerRequestDigest: '0'.repeat(64) }], transcripts, 'n'.repeat(32)],
    ['missing transcript', fake, [], 'n'.repeat(32)],
    ['wrong core digest', fake, [{ sequence: 1, coreRequestDigest: 'e'.repeat(64) }], 'n'.repeat(32)],
  ])('rejects %s', (_name, candidateFake, candidateTranscripts, nonce) => {
    expect(() => compareProviderLedgers(
      boundary,
      candidateFake as FakeLedgerRecord[],
      candidateTranscripts,
      nonce,
    )).toThrow('PROVIDER_LEDGER_MISMATCH')
  })
})
