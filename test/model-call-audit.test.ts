import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, test } from 'vitest'
import { ModelCallAudit } from '../src/spike/model-call-audit.js'

const structuredOutputTool = {
  name: 'structured_output',
  description: 'Report the structured result.',
  parameters: { type: 'object' },
}

const valid = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'sensitive fixture text' }],
  system: 'sensitive system text',
  tools: [structuredOutputTool],
  maxTokens: 2048,
} as unknown as GenerateOptions

async function consume(
  audit: ModelCallAudit,
  options: GenerateOptions,
  reached: { count: number },
): Promise<void> {
  const next = (): AsyncIterable<StreamChunk> => ({
    async *[Symbol.asyncIterator]() {
      reached.count += 1
    },
  })
  for await (const _chunk of audit.wrap(options, next)) {
    // The fake adapter intentionally yields no output.
  }
}

describe('llm/stream budget audit', () => {
  test.each([
    ['provider', { provider: 'wrong-provider' }],
    ['model', { model: 'wrong-model' }],
    ['purpose', { purpose: 'session-title' }],
    ['missing structured output tool', { tools: [] }],
    ['wrong tool', { tools: [{ name: 'bash', description: 'no', parameters: {} }] }],
    ['extra tool', { tools: [structuredOutputTool, { name: 'bash', description: 'no', parameters: {} }] }],
  ])('rejects %s mismatch before reaching the adapter', async (_name, override) => {
    const audit = new ModelCallAudit()
    const reached = { count: 0 }
    await expect(consume(audit, { ...valid, ...override }, reached)).rejects.toThrow('LLM_AUDIT_REJECTED')
    expect(reached.count).toBe(0)
    expect(audit.records).toEqual([])
  })

  test('allows exactly three calls and rejects a fourth before next()', async () => {
    const audit = new ModelCallAudit()
    const reached = { count: 0 }
    await consume(audit, valid, reached)
    await consume(audit, valid, reached)
    await consume(audit, valid, reached)
    await expect(consume(audit, valid, reached)).rejects.toThrow('LLM_CALL_BUDGET_EXCEEDED')
    expect(reached.count).toBe(3)
    expect(audit.records).toHaveLength(3)
  })

  test('records only non-sensitive request facts', async () => {
    const audit = new ModelCallAudit()
    await consume(audit, valid, { count: 0 })
    const serialized = JSON.stringify(audit.records)
    expect(audit.records[0]).toEqual({
      index: 1,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      toolCount: 1,
      toolNames: ['structured_output'],
    })
    expect(serialized).not.toContain('messages')
    expect(serialized).not.toContain('system')
    expect(serialized).not.toContain('sensitive')
    expect(serialized).not.toContain('credential')
  })
})
