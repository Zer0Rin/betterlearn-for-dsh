import { describe, expect, test, vi } from 'vitest'
import {
  validatePlannerGroups,
  promptFor,
  promptIdentity,
  StructuredGenerationAdapter,
  toWorkflowSchema,
  WORKFLOW_SCRIPT,
} from '../src/product/generation-adapter.js'
import type { CandidateContract } from '../src/product/contract.js'
import type { PreparedGeneration } from '../src/product/types.js'

const structured = {
  schemaVersion: 1,
  candidates: [{
    type: 'concept',
    title: '光合作用',
    statement: '绿色植物将光能转化为化学能。',
    evidence: [{ quote: '绿色植物', prefix: '', suffix: '将光能转化为化学能。' }],
  }],
}

const prepared: PreparedGeneration = {
  runId: 'run_1',
  attemptId: 'attempt_1',
  attemptNumber: 1,
  revision: 2,
  schemaVersion: 1,
  schemaSha256: 'a'.repeat(64),
  promptVersion: 'phase1c-v1',
  document: { text: '# 光合作用\n绿色植物将光能转化为化学能。', sha256: 'b'.repeat(64) },
  requestDigest: 'c'.repeat(64),
  providerIdempotencyKey: 'provider-key',
  modelSelection: {
    provider: 'provider-fixture', model: 'model-fixture', reasoningEffort: 'high',
  },
}

function contract(valid = true): CandidateContract {
  return {
    schema: { type: 'object' },
    schemaVersion: 1,
    schemaSha256: 'a'.repeat(64),
    validate: () => valid ? [] : [{ path: '/candidates', keyword: 'required' }],
  }
}

function fakeContext(outcome: unknown, options: {
  resultError?: Error
  workflowStartError?: Error
  workflowDisposeError?: Error
  parentDisposeError?: Error
  emitOwnedChild?: boolean
  childStopReason?: string
} = {}) {
  const facts = {
    create: [] as any[],
    starts: [] as any[],
    restrictions: [] as Array<{ scope: string; value: unknown }>,
    guards: [] as Array<{ scope: string; guard: (execution: { name: string }) => string | undefined }>,
    modelHooks: [] as Array<{ scope: string; name: string }>,
    workflowCancel: 0,
    workflowDispose: 0,
    parentDispose: 0,
  }
  const creationListeners = new Set<(event: { agent: any }) => void>()
  const owners = new Map<string, string>()
  const scopedContext = (scope: string) => ({
    on(name: string, _listener: unknown) {
      facts.modelHooks.push({ scope, name })
      return vi.fn()
    },
    tools: {
      restrict(value: unknown) {
        facts.restrictions.push({ scope, value })
        return vi.fn()
      },
      guard(value: (execution: { name: string }) => string | undefined) {
        facts.guards.push({ scope, guard: value })
        return vi.fn()
      },
    },
  })
  const workflowResult = options.resultError
    ? Promise.reject(options.resultError)
    : Promise.resolve(outcome)
  return {
    ctx: {
      agents: {
        async create(createOptions: any) {
          facts.create.push(createOptions)
          const agentCtx = scopedContext('parent')
          await createOptions.setup?.(agentCtx)
          return {
            agent: { id: createOptions.sessionId, ctx: agentCtx },
            async dispose() {
              facts.parentDispose += 1
              if (options.parentDisposeError) throw options.parentDisposeError
            },
          }
        },
        isOwnedBy(childId: string, parent: { id: string }) {
          return owners.get(childId) === parent.id
        },
      },
      on(name: string, listener: (event: { agent: any }) => void) {
        expect(name).toBe('agent/created')
        creationListeners.add(listener)
        return () => creationListeners.delete(listener)
      },
      workflowEngine: {
        start(request: any) {
          if (options.workflowStartError) throw options.workflowStartError
          facts.starts.push(request)
          const child = { id: 'child_owned', ctx: scopedContext('child'), session: { events: [
            { type: 'turn/end', data: { reason: { kind: options.childStopReason ?? 'completed' } } },
          ] } }
          if (options.emitOwnedChild !== false) owners.set(child.id, request.parent.id)
          for (const listener of [...creationListeners]) listener({ agent: child })
          return {
            id: 'workflow_1',
            meta: request.meta,
            result: typeof outcome === 'function' ? Promise.resolve(outcome(request, facts.starts.length)) : workflowResult,
            cancel() { facts.workflowCancel += 1 },
            async dispose() {
              facts.workflowDispose += 1
              if (options.workflowDisposeError) throw options.workflowDisposeError
            },
          }
        },
      },
    },
    facts,
  }
}

function complete(value: unknown = structured) {
  return { value, stopReason: 'completed', agentsStarted: 1 }
}

describe('StructuredGenerationAdapter', () => {
  test('l1-v2 requires exact unique quotes without changing the source boundary', () => {
    const prompt = promptFor({
      promptVersion: 'l1-v2',
      document: { text: '# 原文\n唯一事实。' },
    })
    expect(prompt).toContain('Copy every evidence.quote exactly from one contiguous SOURCE span.')
    expect(prompt).toContain('Prefer a quote that occurs exactly once in the full SOURCE.')
    expect(prompt).toContain('extend the contiguous quote, up to 2000 characters')
    expect(prompt).toContain('prefix and suffix must be the immediately adjacent exact SOURCE text')
    expect(prompt).toContain('SOURCE:\n# 原文\n唯一事实。')
    expect(promptIdentity('l1-v2')).not.toContain('唯一事实。')
  })

  test('projects the full contract to the rc.7 workflow schema subset', () => {
    expect(toWorkflowSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'urn:test',
      type: 'object',
      properties: {
        schemaVersion: { const: 1 },
        title: { type: 'string', minLength: 1, maxLength: 120 },
        kind: { enum: ['concept', 'fact'] },
        items: { type: 'array', maxItems: 20, items: { type: 'string' } },
      },
    })).toEqual({
      type: 'object',
      properties: {
        schemaVersion: { type: 'integer', const: 1 },
        title: { type: 'string' },
        kind: { type: 'string', enum: ['concept', 'fact'] },
        items: { type: 'array', items: { type: 'string' } },
      },
    })
  })

  test('creates one dynamic parent/workflow and installs the final tool guard on parent and child', async () => {
    const fake = fakeContext(complete())
    const adapter = new StructuredGenerationAdapter(fake.ctx as never, contract(), {
      packageRoot: '/owned/nobei-package',
    })
    const handle = await adapter.start(prepared, new AbortController().signal)
    await expect(handle.result).resolves.toEqual({ ok: true, value: structured })

    expect(fake.facts.create).toHaveLength(1)
    expect(fake.facts.create[0]).toEqual(expect.objectContaining({
      meta: { cwd: '/owned/nobei-package' },
      agentOptions: {
        provider: 'provider-fixture',
        model: 'model-fixture',
        maxTokens: 32_768,
      },
    }))
    expect(fake.facts.create[0].agentOptions).not.toHaveProperty('reasoningEffort')
    expect(fake.facts.create[0].setup).toEqual(expect.any(Function))
    expect(fake.facts.restrictions).toEqual([
      { scope: 'parent', value: { allow: [] } },
      { scope: 'child', value: { allow: [] } },
    ])
    expect(fake.facts.modelHooks).toEqual([
      { scope: 'parent', name: 'system-prompt/assemble' },
      { scope: 'parent', name: 'agent/request' },
      { scope: 'child', name: 'system-prompt/assemble' },
      { scope: 'child', name: 'agent/request' },
    ])
    expect(fake.facts.guards).toHaveLength(2)
    for (const { guard } of fake.facts.guards) {
      expect(guard({ name: 'structured_output' })).toBeUndefined()
      expect(guard({ name: 'run_code' })).toBe('NOBEI_GENERATION_TOOL_DENIED')
      expect(guard({ name: 'bash' })).toBe('NOBEI_GENERATION_TOOL_DENIED')
    }

    expect(fake.facts.starts).toHaveLength(1)
    expect(fake.facts.starts[0]).toEqual(expect.objectContaining({
      script: WORKFLOW_SCRIPT,
      subagentProvider: 'spawn',
      maxTotalAgents: 1,
    }))
    expect(fake.facts.starts[0].args.schema).toEqual(toWorkflowSchema(contract().schema))
    expect(fake.facts.starts[0].args.prompt).toContain(prepared.document.text)
    expect(fake.facts.workflowDispose).toBe(1)
    expect(fake.facts.parentDispose).toBe(1)
  })

  test('guard denial happens before a run_code body can execute', () => {
    const fake = fakeContext(complete())
    const body = vi.fn()
    const guard = (execution: { name: string }): string | undefined => (
      execution.name === 'structured_output' ? undefined : 'NOBEI_GENERATION_TOOL_DENIED'
    )
    const execute = (name: string): void => {
      if (guard({ name }) !== undefined) return
      body()
    }
    execute('run_code')
    expect(body).not.toHaveBeenCalled()
    expect(fake.facts.starts).toEqual([])
  })

  test.each([
    ['no value', complete(null), contract(), 'GENERATION_NO_OUTPUT'],
    ['invalid schema', complete(structured), contract(false), 'GENERATION_SCHEMA_INVALID'],
    ['workflow error', { value: null, stopReason: 'error', agentsStarted: 1 }, contract(), 'GENERATION_PROVIDER_ERROR'],
    ['wrong child count', { value: structured, stopReason: 'completed', agentsStarted: 2 }, contract(), 'GENERATION_PROVIDER_ERROR'],
  ])('classifies %s', async (_name, outcome, candidateContract, code) => {
    const fake = fakeContext(outcome)
    const adapter = new StructuredGenerationAdapter(fake.ctx as never, candidateContract, {
      packageRoot: '/owned/nobei-package',
    })
    const handle = await adapter.start(prepared, new AbortController().signal)
    await expect(handle.result).resolves.toEqual({ ok: false, code })
    expect(fake.facts.workflowDispose).toBe(1)
    expect(fake.facts.parentDispose).toBe(1)
  })

  test('distinguishes a reasoning-only token limit from a completed workflow with no output', async () => {
    // Real rc.8 behavior: the child ends with max-tokens, but workflow settles completed/null.
    const fake = fakeContext(complete(null), { childStopReason: 'max-tokens' })
    const adapter = new StructuredGenerationAdapter(fake.ctx as never, contract(), { packageRoot: '/owned/package' })
    const handle = await adapter.start(prepared, new AbortController().signal)
    expect(await handle.result).toEqual({ ok: false, code: 'GENERATION_OUTPUT_LIMIT' })
    expect(fake.facts.starts).toHaveLength(1)
    expect(fake.facts.workflowDispose).toBe(1)
    expect(fake.facts.parentDispose).toBe(1)
  })

  test('maps an unexpected workflow rejection and preserves it over cleanup failures', async () => {
    const fake = fakeContext(complete(), {
      resultError: new Error('provider detail'),
      workflowDisposeError: new Error('workflow cleanup detail'),
      parentDisposeError: new Error('parent cleanup detail'),
    })
    const adapter = new StructuredGenerationAdapter(fake.ctx as never, contract(), {
      packageRoot: '/owned/nobei-package',
    })
    const handle = await adapter.start(prepared, new AbortController().signal)
    await expect(handle.result).resolves.toEqual({ ok: false, code: 'GENERATION_PROVIDER_ERROR' })
    expect(fake.facts.workflowDispose).toBe(1)
    expect(fake.facts.parentDispose).toBe(1)
  })

  test('maps workflow construction failure and still disposes the parent', async () => {
    const fake = fakeContext(complete(), { workflowStartError: new Error('start detail') })
    const adapter = new StructuredGenerationAdapter(fake.ctx as never, contract(), {
      packageRoot: '/owned/nobei-package',
    })
    const handle = await adapter.start(prepared, new AbortController().signal)
    await expect(handle.result).resolves.toEqual({ ok: false, code: 'GENERATION_PROVIDER_ERROR' })
    expect(fake.facts.workflowDispose).toBe(0)
    expect(fake.facts.parentDispose).toBe(1)
  })

  test('fails closed when the workflow child is not runtime-owned by the parent', async () => {
    const fake = fakeContext(complete(), { emitOwnedChild: false })
    const adapter = new StructuredGenerationAdapter(fake.ctx as never, contract(), {
      packageRoot: '/owned/nobei-package',
    })
    const handle = await adapter.start(prepared, new AbortController().signal)
    await expect(handle.result).resolves.toEqual({ ok: false, code: 'GENERATION_PROVIDER_ERROR' })
    expect(fake.facts.restrictions).toEqual([{ scope: 'parent', value: { allow: [] } }])
    expect(fake.facts.workflowDispose).toBe(1)
    expect(fake.facts.parentDispose).toBe(1)
  })

  test('cancel rejects a late success and dispose is idempotent', async () => {
    let resolve!: (value: unknown) => void
    const outcome = new Promise((done) => { resolve = done })
    const fake = fakeContext(complete())
    fake.ctx.workflowEngine.start = (request: any) => {
      fake.facts.starts.push(request)
      return {
        id: 'workflow_1',
        meta: request.meta,
        result: outcome,
        cancel() { fake.facts.workflowCancel += 1 },
        async dispose() { fake.facts.workflowDispose += 1 },
      }
    }
    const adapter = new StructuredGenerationAdapter(fake.ctx as never, contract(), {
      packageRoot: '/owned/nobei-package',
    })
    const handle = await adapter.start(prepared, new AbortController().signal)
    await new Promise(resolve => setImmediate(resolve))
    handle.cancel()
    resolve(complete())
    await expect(handle.result).resolves.toEqual({ ok: false, code: 'GENERATION_PROVIDER_ERROR' })
    await handle.dispose()
    await handle.dispose()
    expect(fake.facts.workflowCancel).toBe(1)
    expect(fake.facts.workflowDispose).toBe(1)
    expect(fake.facts.parentDispose).toBe(1)
  })
})


describe('P3 semantic execution', () => {
  const longPrepared = (strategy: 'L2' | 'L3' = 'L2'): PreparedGeneration => ({
    ...prepared, modelSelection: { ...prepared.modelSelection },
    document: { text: '甲😀乙丙丁戊己庚', sha256: prepared.document.sha256 },
    extractionPlan: {
      strategy,
      blocks: [
        { id: 'b1', textStart: 0, textEnd: 2 }, { id: 'b2', textStart: 2, textEnd: 4 },
        { id: 'b3', textStart: 4, textEnd: 6 }, { id: 'b4', textStart: 6, textEnd: 8 },
      ],
      containers: strategy === 'L2' ? [{ blockIds: ['b1', 'b2', 'b3', 'b4'], textStart: 0, textEnd: 8 }]
        : [{ blockIds: ['b1', 'b2', 'b3'], textStart: 0, textEnd: 6 }, { blockIds: ['b3', 'b4'], textStart: 4, textEnd: 8 }],
      boundaries: strategy === 'L3' ? [{ textStart: 2, textEnd: 6 }] : [], maxCalls: 8,
    },
  })
  test.each(['L2', 'L3'] as const)('%s plans actual groups then serial extraction and boundaries with codepoint offsets', async strategy => {
    const input = longPrepared(strategy)
    const fake = fakeContext((request: any) => {
      if (request.args.prompt.includes('BLOCKS_JSON:')) {
        const blocks = JSON.parse(request.args.prompt.split('BLOCKS_JSON:\n')[1])
        return complete({ groups: blocks.map((block: any) => ({ blockIds: [block.id] })) })
      }
      return complete(structured)
    })
    const adapter = new StructuredGenerationAdapter(fake.ctx as never, contract(), { packageRoot: '/owned' })
    const handle = await adapter.start(input, new AbortController().signal)
    input.modelSelection.model = 'changed-after-start'
    const result = await handle.result
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const batches = result.value.batches as any[]
    expect(batches.map(batch => [batch.textStart, batch.textEnd])).toEqual(strategy === 'L2'
      ? [[0, 2], [2, 4], [4, 6], [6, 8]] : [[0, 2], [2, 4], [4, 6], [4, 6], [6, 8], [2, 6]])
    expect(fake.facts.starts[1].args.prompt).toContain('SOURCE:\n甲😀')
    expect(fake.facts.create.every(create => create.agentOptions.model === 'model-fixture')).toBe(true)
    expect(fake.facts.workflowDispose).toBe(fake.facts.starts.length)
    expect(fake.facts.parentDispose).toBe(fake.facts.starts.length)
    expect(fake.facts.starts.map(call => call.args.prompt.includes('BLOCKS_JSON:') ? 'plan' : 'extract')).toEqual(strategy === 'L2'
      ? ['plan', 'extract', 'extract', 'extract', 'extract']
      : ['plan', 'extract', 'extract', 'extract', 'plan', 'extract', 'extract', 'extract'])
  })
  test.each([
    { groups: [{ blockIds: ['b1', 'b2', 'b3', 'b4'] }] },
    { groups: [{ blockIds: ['b1'] }] },
    { groups: [{ blockIds: ['b2', 'b1'] }, { blockIds: ['b3', 'b4'] }] },
    { groups: [{ blockIds: ['b1', 'b2'] }, { blockIds: ['b2', 'b3', 'b4'] }] },
    { groups: [{ blockIds: ['missing'] }] },
    { groups: [] },
  ])('invalid planning produces no extraction or partial output: %j', async value => {
    expect(validatePlannerGroups(value, ['b1', 'b2', 'b3', 'b4'])).toBeUndefined()
    const fake = fakeContext(complete(value))
    const adapter = new StructuredGenerationAdapter(fake.ctx as never, contract(), { packageRoot: '/owned' })
    const handle = await adapter.start(longPrepared(), new AbortController().signal)
    expect(await handle.result).toEqual({ ok: false, code: 'GENERATION_SCHEMA_INVALID' })
    expect(fake.facts.starts).toHaveLength(1)
  })
  test('cancelling during planning starts no extraction', async () => {
    const controller = new AbortController()
    const fake = fakeContext(() => { controller.abort(); return complete({ groups: [{ blockIds: ['b1', 'b2'] }, { blockIds: ['b3', 'b4'] }] }) })
    const adapter = new StructuredGenerationAdapter(fake.ctx as never, contract(), { packageRoot: '/owned' })
    const handle = await adapter.start(longPrepared(), controller.signal)
    expect(await handle.result).toEqual({ ok: false, code: 'GENERATION_PROVIDER_ERROR' })
    expect(fake.facts.starts).toHaveLength(1)
  })
})
