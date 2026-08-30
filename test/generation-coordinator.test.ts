import { afterEach, describe, expect, test, vi } from 'vitest'
import { GENERATION_TIMEOUT_MS } from '../src/product/constants.js'
import {
  GenerationBusyError,
  GenerationCoordinator,
} from '../src/product/generation-coordinator.js'
import type { GenerationAdapterResult, GenerationHandle } from '../src/product/generation-adapter.js'
import type { PreparedGeneration } from '../src/product/types.js'

const modelSelection = {
  provider: 'provider-fixture', model: 'model-fixture', reasoningEffort: 'medium',
}

const importParams = (filename = 'a.txt', mediaType: 'text/plain' | 'text/markdown' = 'text/plain') => ({
  filename, mediaType, text: filename === 'lesson.md' ? '# Lesson' : 'a', modelSelection,
})

class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T) => void
  reject!: (reason: unknown) => void
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

const prepared = (runId = 'run_1', attemptId = 'attempt_1'): PreparedGeneration => ({
  runId,
  attemptId,
  attemptNumber: 1,
  revision: 2,
  schemaVersion: 1,
  schemaSha256: 'a'.repeat(64),
  promptVersion: 'phase1c-v1',
  document: { text: 'source', sha256: 'b'.repeat(64) },
  requestDigest: 'c'.repeat(64),
  providerIdempotencyKey: 'provider-key',
  modelSelection,
})

function harness(options: {
  prepareError?: Error
  submitError?: Error
  failError?: Error
  resolveError?: Error
} = {}) {
  const outcome = new Deferred<GenerationAdapterResult>()
  const facts = {
    imports: [] as unknown[],
    retries: [] as unknown[],
    submits: [] as any[],
    fails: [] as any[],
    starts: [] as Array<{ prepared: PreparedGeneration; signal: AbortSignal }>,
    cancel: 0,
    dispose: 0,
    poison: 0,
    resolutions: [] as unknown[],
  }
  const client = {
    async importAndPrepare(params: unknown) {
      facts.imports.push(params)
      if (options.prepareError) throw options.prepareError
      return prepared()
    },
    async retryAndPrepare(params: any) {
      facts.retries.push(params)
      if (options.prepareError) throw options.prepareError
      return prepared(params.runId, 'attempt_2')
    },
    async submitGeneration(params: unknown) {
      facts.submits.push(params)
      if (options.submitError) throw options.submitError
      return { ok: true }
    },
    async failGeneration(params: unknown) {
      facts.fails.push(params)
      if (options.failError) throw options.failError
      return { ok: true }
    },
  }
  const supervisor = {
    async withReadyClient<T>(operation: (value: typeof client) => Promise<T>): Promise<T> {
      return operation(client)
    },
    async poison() { facts.poison += 1 },
  }
  const handle: GenerationHandle = {
    result: outcome.promise,
    cancel() { facts.cancel += 1 },
    async dispose() { facts.dispose += 1 },
  }
  const adapter = {
    async start(value: PreparedGeneration, signal: AbortSignal) {
      facts.starts.push({ prepared: value, signal })
      return handle
    },
  }
  const resolver = {
    async resolve(selection: unknown) {
      facts.resolutions.push(selection)
      if (options.resolveError) throw options.resolveError
      return { ...modelSelection }
    },
  }
  const coordinator = new GenerationCoordinator(
    supervisor as never, adapter as never, resolver as never,
  )
  return { coordinator, outcome, facts }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('GenerationCoordinator', () => {
  test('reserves globally before Core writes and does not bind work to the browser signal', async () => {
    const { coordinator, facts } = harness()
    const browser = new AbortController()
    await expect(coordinator.launchImport(
      importParams('lesson.md', 'text/markdown'), browser.signal,
    )).resolves.toEqual({
      runId: 'run_1', attemptId: 'attempt_1', revision: 2, modelSelection,
    })
    browser.abort()
    expect(facts.cancel).toBe(0)
    await expect(coordinator.launchRetry({ runId: 'run_2', expectedRevision: 1 }))
      .rejects.toBeInstanceOf(GenerationBusyError)
    expect(facts.retries).toEqual([])
    expect(facts.imports).toHaveLength(1)
    expect(facts.resolutions).toEqual([modelSelection])
  })

  test('releases a reservation when the atomic prepare write fails', async () => {
    const first = harness({ prepareError: new Error('write failed') })
    await expect(first.coordinator.launchImport(importParams())).rejects.toThrow('write failed')
    expect(first.coordinator.activeCount).toBe(0)
  })

  test('submits one successful result without rewriting model metadata', async () => {
    const { coordinator, outcome, facts } = harness()
    await coordinator.launchImport(importParams())
    outcome.resolve({ ok: true, value: { schemaVersion: 1, candidates: [] } })
    await vi.waitFor(() => expect(coordinator.activeCount).toBe(0))
    expect(facts.submits).toEqual([{
      runId: 'run_1',
      attemptId: 'attempt_1',
      expectedRevision: 2,
      output: { schemaVersion: 1, candidates: [] },
    }])
    expect(facts.fails).toEqual([])
    expect(facts.dispose).toBe(1)
  })

  test('writes one classified generation failure', async () => {
    const { coordinator, outcome, facts } = harness()
    await coordinator.launchRetry({ runId: 'run_1', expectedRevision: 7 })
    outcome.resolve({ ok: false, code: 'GENERATION_SCHEMA_INVALID' })
    await vi.waitFor(() => expect(coordinator.activeCount).toBe(0))
    expect(facts.fails).toEqual([expect.objectContaining({
      runId: 'run_1',
      attemptId: 'attempt_2',
      expectedRevision: 2,
      code: 'GENERATION_SCHEMA_INVALID',
    })])
    expect(facts.submits).toEqual([])
  })

  test('closes a stuck generation exactly at the 120000 ms boundary', async () => {
    vi.useFakeTimers()
    const { coordinator, outcome, facts } = harness()
    await coordinator.launchImport(importParams())
    await vi.advanceTimersByTimeAsync(GENERATION_TIMEOUT_MS - 1)
    expect(facts.fails).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(facts.fails).toEqual([expect.objectContaining({ code: 'GENERATION_TIMEOUT' })])
    outcome.resolve({ ok: true, value: { schemaVersion: 1, candidates: [] } })
    await flush()
    await vi.advanceTimersByTimeAsync(GENERATION_TIMEOUT_MS)
    expect(facts.fails).toHaveLength(1)
    expect(facts.submits).toEqual([])
    expect(coordinator.activeCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('poisons the supervisor after an uncertain final write and never replays it', async () => {
    const { coordinator, outcome, facts } = harness({ submitError: new Error('timeout') })
    await coordinator.launchImport(importParams())
    outcome.resolve({ ok: true, value: { schemaVersion: 1, candidates: [] } })
    await vi.waitFor(() => expect(coordinator.activeCount).toBe(0))
    expect(facts.submits).toHaveLength(1)
    expect(facts.poison).toBe(1)
  })

  test('dispose stops admission, cancels and waits for every active flight', async () => {
    vi.useFakeTimers()
    const { coordinator, outcome, facts } = harness()
    await coordinator.launchImport(importParams())
    const disposing = coordinator.dispose()
    outcome.resolve({ ok: false, code: 'GENERATION_PROVIDER_ERROR' })
    await disposing
    await coordinator.dispose()
    await expect(coordinator.launchRetry({ runId: 'run_2', expectedRevision: 1 }))
      .rejects.toThrow('GENERATION_COORDINATOR_DISPOSED')
    expect(facts.cancel).toBe(1)
    expect(facts.dispose).toBe(1)
    expect(coordinator.activeCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('dispose waits for an in-progress prepare and does not start new provider work', async () => {
    const preparing = new Deferred<PreparedGeneration>()
    const failGeneration = vi.fn(async () => ({ ok: true }))
    const supervisor = {
      withReadyClient<T>(operation: (client: any) => Promise<T>): Promise<T> {
        return operation({
          importAndPrepare: () => preparing.promise,
          failGeneration,
        })
      },
      poison: vi.fn(),
    }
    const adapter = { start: vi.fn() }
    const resolver = { resolve: vi.fn(async () => ({ ...modelSelection })) }
    const coordinator = new GenerationCoordinator(
      supervisor as never, adapter as never, resolver as never,
    )
    const launching = coordinator.launchImport(importParams())
    const disposing = coordinator.dispose()
    preparing.resolve(prepared())
    await expect(launching).rejects.toThrow('GENERATION_COORDINATOR_DISPOSED')
    await disposing
    expect(adapter.start).not.toHaveBeenCalled()
    expect(failGeneration).toHaveBeenCalledOnce()
    expect(coordinator.activeCount).toBe(0)
  })

  test('resolver failure releases admission and performs no Core write', async () => {
    const { coordinator, facts } = harness({ resolveError: new Error('MODEL_SELECTION_INVALID') })
    await expect(coordinator.launchImport(importParams())).rejects.toThrow('MODEL_SELECTION_INVALID')
    expect(facts.imports).toEqual([])
    expect(facts.starts).toEqual([])
    expect(coordinator.activeCount).toBe(0)
  })
})
