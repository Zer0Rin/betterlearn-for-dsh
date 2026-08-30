import { describe, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  assertModelSelectionPropagation,
  createChildSelectionObserver,
  modelSelectionAgentOptions,
  modelSelectionRef,
  type ModelSelectionPropagationObservation,
} from '../src/spike/model-selection-propagation.js'

const low = { provider: 'fake-a', model: 'model-a', reasoningEffort: 'low' }
const high = { provider: 'fake-b', model: 'model-b', reasoningEffort: 'high' }
const absent = { provider: 'fake-c', model: 'model-c' }

function observation(overrides: Partial<ModelSelectionPropagationObservation> = {}): ModelSelectionPropagationObservation {
  return {
    runId: 'run-a', parentId: 'parent-a', childId: 'child-a', ownedByParent: true,
    selectionInstalled: true, requested: low, expectedStream: low, observed: low,
    ...overrides,
  }
}

function host() {
  const listeners = new Set<(event: { agent: { id: string, ctx: object } }) => void>()
  return {
    ctx: {
      agents: { isOwnedBy: (childId: string, parent: { id: string }) => childId.endsWith(parent.id) },
      on: (_name: 'agent/created', listener: (event: { agent: { id: string, ctx: object } }) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    emit(childId: string) { for (const listener of listeners) listener({ agent: { id: childId, ctx: {} } }) },
    listeners,
  }
}

function scriptFunction(source: string, name: string, occurrence: 'first' | 'last' = 'first') {
  const signature = `function ${name}(`
  const start = occurrence === 'first' ? source.indexOf(signature) : source.lastIndexOf(signature)
  if (start === -1) throw new Error(`Missing ${name} in spike script`)
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`Unclosed ${name} in spike script`)
}

async function spikeAssertions() {
  const source = await readFile(new URL('../scripts/spike-phase1e-model-propagation.mjs', import.meta.url), 'utf8')
  const hard = (condition: unknown, code: string) => { if (!condition) throw new Error(code) }
  const assertConcurrentListenerMatrix = new Function('hard', `${scriptFunction(source, 'assertConcurrentListenerMatrix')}\nreturn assertConcurrentListenerMatrix`)(hard) as (a: { events: unknown[] }, b: { events: unknown[] }) => void
  const closeLedgerBackedRows = new Function(
    `${scriptFunction(source, 'own', 'last')}\n${scriptFunction(source, 'snapshot', 'last')}\n${scriptFunction(source, 'sameSnapshot')}\n${scriptFunction(source, 'hard', 'last')}\n${scriptFunction(source, 'closeLedgerBackedRows')}\nreturn closeLedgerBackedRows`,
  )() as (runtime: { claims: unknown[] }, ledger: { records: unknown[] }) => unknown[]
  return { assertConcurrentListenerMatrix, closeLedgerBackedRows }
}

describe('rc.7 model selection propagation spike', () => {
  test('renders a real workflow newline in the disposable runtime plugin', async () => {
    const source = await readFile(new URL('../scripts/spike-phase1e-model-propagation.mjs', import.meta.url), 'utf8')
    expect(source).toContain("const script = 'const value = await agent(args.prompt)\\nreturn value'")
    expect(source).not.toContain("const script = 'const value = await agent(args.prompt)\\\\nreturn value'")
  })

  test('makes a runtime timeout identify the last completed public-seam boundary', async () => {
    const source = await readFile(new URL('../scripts/spike-phase1e-model-propagation.mjs', import.meta.url), 'utf8')
    expect(source).toContain("checkpoint('apply-entered')")
    expect(source).toContain('PHASE1E_RUNTIME_DIAGNOSTIC')
    expect(source).toContain('PHASE1E_DIAGNOSTIC_ROOT')
  })

  test('writes result and error records with a real trailing newline', async () => {
    const source = await readFile(new URL('../scripts/spike-phase1e-model-propagation.mjs', import.meta.url), 'utf8')
    expect(source).toContain("realProviderCalls: 0, claims }) + '\\n')")
    expect(source).toContain("String(error) }) + '\\n')")
    expect(source).not.toContain("realProviderCalls: 0, claims }) + '\\\\n')")
    expect(source).not.toContain("String(error) }) + '\\\\n')")
  })

  test('distinguishes a missing result from an existing malformed result', async () => {
    const source = await readFile(new URL('../scripts/spike-phase1e-model-propagation.mjs', import.meta.url), 'utf8')
    expect(source).toContain("if (error?.code === 'ENOENT') return undefined")
    expect(source).toContain('PHASE1E_RESULT_INVALID')
  })

  test('builds the fake provider from tracked source into a temporary package and verifies its packed main entry', async () => {
    const source = await readFile(new URL('../scripts/spike-phase1e-model-propagation.mjs', import.meta.url), 'utf8')
    expect(source).toContain('buildFakeProviderFromSource')
    expect(source).toContain("'--outDir'")
    expect(source).toContain('assertPackedMain')
    expect(source).toContain("'package/lib/index.js'")
    expect(source).not.toContain("cwd: join(ROOT, 'acceptance/fake-provider')")
  })

  test('uses the authenticated fake-adapter ledger to close and assert the runtime observation rows', async () => {
    const source = await readFile(new URL('../scripts/spike-phase1e-model-propagation.mjs', import.meta.url), 'utf8')
    expect(source).toContain('NOBEI_PHASE1C_FAKE_LEDGER_TOKEN')
    expect(source).toContain('readFakeLedger')
    expect(source).toContain("'/nobei-acceptance/fake-provider-ledger'")
    expect(source).toContain('closeLedgerBackedRows')
    expect(source).toContain('assertLedgerBackedRows')
    expect(source).toContain('runId, parentId, childId, ownedByParent, selectionInstalled, requested, expectedStream, observed')
  })

  test('makes the A/B shared-Host listener matrix a GO requirement', async () => {
    const source = await readFile(new URL('../scripts/spike-phase1e-model-propagation.mjs', import.meta.url), 'utf8')
    expect(source).toContain('assertConcurrentListenerMatrix')
    expect(source).toContain('const targetChildIds = new Set([...aOwned, ...bOwned].map((row) => row.childId))')
    expect(source).toContain("hard(aOwned.length === 1 && bOwned.length === 1, 'SPAWN_CHILD_NOT_OWNED')")
  })

  test('allows a listener to record an unrelated parent creation while checking both workflow children', async () => {
    const { assertConcurrentListenerMatrix } = await spikeAssertions()
    const ownedA = { childId: 'workflow-child-a', ownedByParent: true, selectionInstalled: true }
    const ownedB = { childId: 'workflow-child-b', ownedByParent: true, selectionInstalled: true }
    const counterpartForA = { childId: 'workflow-child-b', ownedByParent: false, selectionInstalled: false }
    const counterpartForB = { childId: 'workflow-child-a', ownedByParent: false, selectionInstalled: false }
    const unrelatedParent = { childId: 'parent-b', ownedByParent: false, selectionInstalled: false }

    expect(() => assertConcurrentListenerMatrix(
      { events: [unrelatedParent, ownedA, counterpartForA] },
      { events: [ownedB, counterpartForB] },
    )).not.toThrow()
  })

  test('rejects a duplicate counterpart workflow-child listener event instead of emitting GO', async () => {
    const { assertConcurrentListenerMatrix } = await spikeAssertions()
    const ownedA = { childId: 'workflow-child-a', ownedByParent: true, selectionInstalled: true }
    const ownedB = { childId: 'workflow-child-b', ownedByParent: true, selectionInstalled: true }
    const counterpartForA = { childId: 'workflow-child-b', ownedByParent: false, selectionInstalled: false }
    const counterpartForB = { childId: 'workflow-child-a', ownedByParent: false, selectionInstalled: false }
    const unrelatedParent = { childId: 'parent-b', ownedByParent: false, selectionInstalled: false }

    expect(() => assertConcurrentListenerMatrix(
      { events: [unrelatedParent, ownedA, counterpartForA, counterpartForA] },
      { events: [counterpartForB, ownedB] },
    )).toThrow('MODEL_SELECTION_PROPAGATION_MISMATCH')
  })

  test('rejects an extra unmatched fake stream ledger record', async () => {
    const { closeLedgerBackedRows } = await spikeAssertions()
    const defaultLow = { provider: 'fake-b', model: 'model-b', reasoningEffort: 'low' }
    const claims = [
      { runId: 'run-a', parentId: 'parent-a', childId: 'child-a', ownedByParent: true, selectionInstalled: true, requested: low, expectedStream: low },
      { runId: 'run-b', parentId: 'parent-b', childId: 'child-b', ownedByParent: true, selectionInstalled: true, requested: high, expectedStream: high },
      { runId: 'run-c', parentId: 'parent-c', childId: 'child-c', ownedByParent: true, selectionInstalled: true, requested: absent, expectedStream: absent },
      { runId: 'run-d-negative-control', parentId: 'parent-d', childId: 'child-d', ownedByParent: true, selectionInstalled: false, requested: high, expectedStream: defaultLow },
    ]
    const records = [
      { result: 'text', ...defaultLow },
      { result: 'text', ...high },
      { result: 'text', ...absent },
      { result: 'text', ...low },
      { result: 'aborted', provider: 'unexpected', model: 'fifth-stream' },
    ]

    expect(() => closeLedgerBackedRows({ claims }, { records })).toThrow('MODEL_SELECTION_PROPAGATION_MISMATCH')
  })

  test('resolves the driver manifest through the enabled spawn provider package context', async () => {
    const source = await readFile(new URL('../scripts/spike-phase1e-model-propagation.mjs', import.meta.url), 'utf8')
    expect(source).toContain("import { createRequire } from 'node:module'")
    expect(source).toContain("'@deepseek-ai/dsh-subagent-spawn-in-process/package.json'")
    expect(source).toContain("providerRequire.resolve('@deepseek-ai/dsh-subagent-in-process-driver/package.json')")
    expect(source).not.toContain("join(profileRoot, 'node_modules', '@deepseek-ai', 'dsh-subagent-in-process-driver', 'package.json')")
  })

  test('keeps AgentOptions to provider/model/maxTokens and installs a complete parent selection', () => {
    expect(modelSelectionAgentOptions(high)).toEqual({ provider: 'fake-b', model: 'model-b', maxTokens: 2_048 })
    expect(modelSelectionAgentOptions(high)).not.toHaveProperty('reasoningEffort')
    expect(modelSelectionRef(high).current).toMatchObject(high)
  })

  test('records the actual ownership boolean and rejects an unowned child before workflow success', () => {
    const recorded: ModelSelectionPropagationObservation[] = []
    const ctx = host()
    const stop = createChildSelectionObserver(ctx.ctx as never, { id: 'parent-a' } as never, low, 'run-a', recorded, () => undefined)
    ctx.emit('child-other')
    stop()
    expect(recorded).toEqual([expect.objectContaining({ childId: 'child-other', ownedByParent: false, selectionInstalled: false })])
    expect(() => assertModelSelectionPropagation(recorded[0]!)).toThrow('SPAWN_CHILD_NOT_OWNED')
  })

  test('installs and requires an equal selection for an owned child', () => {
    const recorded: ModelSelectionPropagationObservation[] = []
    const installs: object[] = []
    const ctx = host()
    const stop = createChildSelectionObserver(ctx.ctx as never, { id: 'parent-a' } as never, low, 'run-a', recorded, (childCtx) => installs.push(childCtx))
    ctx.emit('child-parent-a')
    stop()
    expect(recorded).toEqual([expect.objectContaining({ ownedByParent: true, selectionInstalled: true })])
    expect(installs).toHaveLength(1)
    expect(() => assertModelSelectionPropagation(observation({ observed: high }))).toThrow('MODEL_SELECTION_PROPAGATION_MISMATCH')
  })

  test('distinguishes explicit and absent effort by property ownership', () => {
    expect(() => assertModelSelectionPropagation(observation({
      requested: high, expectedStream: high, observed: { provider: 'fake-b', model: 'model-b' },
    }))).toThrow('MODEL_SELECTION_PROPAGATION_MISMATCH')
    expect(() => assertModelSelectionPropagation(observation({
      requested: absent, expectedStream: absent, observed: { ...absent, reasoningEffort: undefined },
    }))).toThrow('MODEL_SELECTION_PROPAGATION_MISMATCH')
  })

  test('disposal prevents later children from being claimed', () => {
    const recorded: ModelSelectionPropagationObservation[] = []
    const ctx = host()
    const stop = createChildSelectionObserver(ctx.ctx as never, { id: 'parent-a' } as never, low, 'run-a', recorded, () => undefined)
    stop()
    ctx.emit('child-parent-a')
    expect(recorded).toEqual([])
  })

  test('concurrent listeners share one Host, observe both children, and claim only their own child', () => {
    const ctx = host()
    const a: ModelSelectionPropagationObservation[] = []
    const b: ModelSelectionPropagationObservation[] = []
    const stopA = createChildSelectionObserver(ctx.ctx as never, { id: 'parent-a' } as never, low, 'run-a', a, () => undefined)
    const stopB = createChildSelectionObserver(ctx.ctx as never, { id: 'parent-b' } as never, high, 'run-b', b, () => undefined)
    ctx.emit('child-parent-a')
    ctx.emit('child-parent-b')
    stopA(); stopB()
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(2)
    expect(new Set(a.map((row) => row.childId))).toEqual(new Set(b.map((row) => row.childId)))
    expect(a.filter((row) => row.ownedByParent)).toHaveLength(1)
    expect(b.filter((row) => row.ownedByParent)).toHaveLength(1)
    expect(a.filter((row) => row.selectionInstalled)).toHaveLength(1)
    expect(b.filter((row) => row.selectionInstalled)).toHaveLength(1)
    expect(a.find((row) => row.ownedByParent)?.childId).toBe('child-parent-a')
    expect(b.find((row) => row.ownedByParent)?.childId).toBe('child-parent-b')
  })
})
