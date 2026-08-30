import {
  GENERATION_TIMEOUT_MS,
  MAX_ACTIVE_GENERATIONS,
} from './constants.js'
import type { FixedCoreRpcClient } from './core-rpc-client.js'
import type {
  GenerationAdapterResult,
  GenerationHandle,
  StructuredGenerationAdapter,
} from './generation-adapter.js'
import type {
  ImportAndPrepareParams,
  PreparedGeneration,
  RetryAndPrepareParams,
  ModelSelectionSnapshot,
} from './types.js'
import type { ModelSelectionResolver } from './model-selection-resolver.js'

interface SupervisorPort {
  withReadyClient<T>(operation: (client: FixedCoreRpcClient) => Promise<T>): Promise<T>
  poison(code?: string): void | Promise<void>
}

interface Flight {
  prepared: PreparedGeneration
  handle: GenerationHandle
  abort: AbortController
  timer: NodeJS.Timeout
  terminal: boolean
  done: Promise<void>
  finishDone: () => void
  cleanup(): Promise<void>
}

export interface GenerationLaunch {
  runId: string
  attemptId: string
  revision: number
  modelSelection: ModelSelectionSnapshot
}

export class GenerationBusyError extends Error {
  readonly code = 'GENERATION_BUSY'
  constructor() {
    super('GENERATION_BUSY')
    this.name = 'GenerationBusyError'
  }
}

export class GenerationCoordinator {
  readonly #flights = new Map<string, Flight>()
  readonly #launches = new Set<Promise<unknown>>()
  readonly #transcripts: Array<{ sequence: number; coreRequestDigest: string }> = []
  #reserved = false
  #accepting = true
  #disposePromise: Promise<void> | undefined

  constructor(
    private readonly supervisor: SupervisorPort,
    private readonly adapter: StructuredGenerationAdapter,
    private readonly modelSelectionResolver: ModelSelectionResolver,
  ) {}

  get activeCount(): number {
    return this.#flights.size + (this.#reserved ? 1 : 0)
  }

  get preparedTranscripts(): ReadonlyArray<{ sequence: number; coreRequestDigest: string }> {
    return this.#transcripts.map((row) => ({ ...row }))
  }

  launchImport(params: ImportAndPrepareParams, signal?: AbortSignal): Promise<GenerationLaunch> {
    return this.#trackLaunch(this.#launch(
      undefined,
      async (client) => {
        const modelSelection = await this.modelSelectionResolver.resolve(
          params.modelSelection, signal,
        )
        return client.importAndPrepare({ ...params, modelSelection }, signal)
      },
    ))
  }

  launchRetry(params: RetryAndPrepareParams, signal?: AbortSignal): Promise<GenerationLaunch> {
    return this.#trackLaunch(this.#launch(
      params.runId,
      (client) => client.retryAndPrepare(params, signal),
    ))
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise
    this.#accepting = false
    this.#disposePromise = (async () => {
      await Promise.allSettled([...this.#launches])
      const flights = [...this.#flights.values()]
      for (const flight of flights) {
        flight.abort.abort()
        flight.handle.cancel()
        void flight.cleanup()
      }
      await Promise.all(flights.map((flight) => flight.done))
    })()
    return this.#disposePromise
  }

  #trackLaunch<T>(promise: Promise<T>): Promise<T> {
    this.#launches.add(promise)
    void promise.finally(() => this.#launches.delete(promise)).catch(() => undefined)
    return promise
  }

  async #launch(
    requestedRunId: string | undefined,
    prepare: (client: FixedCoreRpcClient) => Promise<PreparedGeneration>,
  ): Promise<GenerationLaunch> {
    if (!this.#accepting) throw new Error('GENERATION_COORDINATOR_DISPOSED')
    if (
      this.#reserved
      || this.#flights.size >= MAX_ACTIVE_GENERATIONS
      || (requestedRunId !== undefined && this.#flights.has(requestedRunId))
    ) throw new GenerationBusyError()
    this.#reserved = true

    let prepared: PreparedGeneration
    try {
      prepared = await this.supervisor.withReadyClient(prepare)
    } catch (error) {
      this.#reserved = false
      throw error
    }
    if (!this.#accepting) {
      await this.#failUnlaunched(prepared)
      this.#reserved = false
      throw new Error('GENERATION_COORDINATOR_DISPOSED')
    }

    const abort = new AbortController()
    let handle: GenerationHandle
    try {
      handle = await this.adapter.start(prepared, abort.signal)
    } catch (error) {
      this.#reserved = false
      await this.#failUnlaunched(prepared)
      throw error
    }

    let finishDone!: () => void
    const done = new Promise<void>((resolve) => { finishDone = resolve })
    let cleanupPromise: Promise<void> | undefined
    const flight = {} as Flight
    flight.prepared = prepared
    flight.handle = handle
    flight.abort = abort
    flight.terminal = false
    flight.done = done
    flight.finishDone = finishDone
    flight.cleanup = () => {
      cleanupPromise ??= handle.dispose().catch(() => undefined)
      return cleanupPromise
    }
    flight.timer = setTimeout(() => {
      void this.#settle(flight, { ok: false, code: 'GENERATION_TIMEOUT' })
    }, GENERATION_TIMEOUT_MS)
    flight.timer.unref?.()

    this.#flights.set(prepared.runId, flight)
    this.#transcripts.push({
      sequence: this.#transcripts.length + 1,
      coreRequestDigest: prepared.requestDigest,
    })
    this.#reserved = false
    void handle.result.then(
      (result) => this.#settle(flight, result),
      () => this.#settle(flight, { ok: false, code: 'GENERATION_PROVIDER_ERROR' }),
    )
    return {
      runId: prepared.runId,
      attemptId: prepared.attemptId,
      revision: prepared.revision,
      modelSelection: { ...prepared.modelSelection },
    }
  }

  async #settle(flight: Flight, result: GenerationAdapterResult | { ok: false; code: 'GENERATION_TIMEOUT' }): Promise<void> {
    if (flight.terminal) return
    flight.terminal = true
    clearTimeout(flight.timer)
    try {
      if (result.ok) {
        await this.supervisor.withReadyClient((client) => client.submitGeneration({
          runId: flight.prepared.runId,
          attemptId: flight.prepared.attemptId,
          expectedRevision: flight.prepared.revision,
          output: result.value,
        }))
      } else {
        await this.supervisor.withReadyClient((client) => client.failGeneration({
          runId: flight.prepared.runId,
          attemptId: flight.prepared.attemptId,
          expectedRevision: flight.prepared.revision,
          code: result.code,
        }))
      }
    } catch {
      await this.supervisor.poison('CORE_FINALIZE_UNCERTAIN')
    } finally {
      await flight.cleanup()
      this.#flights.delete(flight.prepared.runId)
      flight.finishDone()
    }
  }

  async #failUnlaunched(prepared: PreparedGeneration): Promise<void> {
    try {
      await this.supervisor.withReadyClient((client) => client.failGeneration({
        runId: prepared.runId,
        attemptId: prepared.attemptId,
        expectedRevision: prepared.revision,
        code: 'GENERATION_PROVIDER_ERROR',
      }))
    } catch {
      await this.supervisor.poison('CORE_FINALIZE_UNCERTAIN')
    }
  }
}
