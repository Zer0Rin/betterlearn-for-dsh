import type { Readable, Writable } from 'node:stream'
import {
  CORE_HANDSHAKE_TIMEOUT_MS,
  CORE_READ_RPC_TIMEOUT_MS,
  CORE_RPC_MAX_LINE_BYTES,
  CORE_WRITE_RPC_TIMEOUT_MS,
  GENERATION_FINALIZE_RPC_TIMEOUT_MS,
} from './constants.js'
import type {
  DocumentPreview,
  DocumentPreviewParams,
  CandidateList,
  CoreObjectResult,
  CoreRunSnapshot,
  EventList,
  EventParams,
  FailGenerationParams,
  HelloParams,
  HelloResult,
  ImportAndPrepareParams,
  KnowledgePointList,
  PreparedGeneration,
  RetryAndPrepareParams,
  ReviewCandidateParams,
  RunHistoryResult,
  RunParams,
  SubmitGenerationParams,
  UpdateKnowledgePointParams,
} from './types.js'

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void
  reject: (reason: CoreRpcError) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  abort?: () => void
}

interface CoreRpcClientOptions {
  onPoisoned: (error: CoreRpcError) => void
}

export class CoreRpcError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CoreRpcError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

export class FixedCoreRpcClient {
  readonly #input: Readable
  readonly #output: Writable
  readonly #onPoisoned: (error: CoreRpcError) => void
  readonly #pending = new Map<number, PendingRequest>()
  readonly #completed = new Set<number>()
  #nextId = 1
  #buffer = ''
  #failure: CoreRpcError | null = null

  constructor(input: Readable, output: Writable, options: CoreRpcClientOptions) {
    this.#input = input
    this.#output = output
    this.#onPoisoned = options.onPoisoned
    input.setEncoding('utf8')
    input.on('data', this.#onData)
    input.on('end', this.#onEnd)
    input.on('error', this.#onStreamError)
    output.on('error', this.#onStreamError)
  }

  hello(params: HelloParams, signal?: AbortSignal): Promise<HelloResult> {
    return this.#request<HelloResult>('system.hello', params, CORE_HANDSHAKE_TIMEOUT_MS, signal)
  }

  previewDocument(params: DocumentPreviewParams, signal?: AbortSignal): Promise<DocumentPreview> {
    return this.#request<DocumentPreview>('documents.preview', params, CORE_WRITE_RPC_TIMEOUT_MS, signal)
  }

  importAndPrepare(params: ImportAndPrepareParams, signal?: AbortSignal): Promise<PreparedGeneration> {
    return this.#request<PreparedGeneration>(
      'documents.import_and_prepare_generation', params, CORE_WRITE_RPC_TIMEOUT_MS, signal,
    )
  }

  retryAndPrepare(params: RetryAndPrepareParams, signal?: AbortSignal): Promise<PreparedGeneration> {
    return this.#request<PreparedGeneration>(
      'runs.retry_and_prepare_generation', params, CORE_WRITE_RPC_TIMEOUT_MS, signal,
    )
  }

  submitGeneration(params: SubmitGenerationParams, signal?: AbortSignal): Promise<CoreObjectResult> {
    return this.#request(
      'runs.submit_generation', params, GENERATION_FINALIZE_RPC_TIMEOUT_MS, signal,
    )
  }

  failGeneration(params: FailGenerationParams, signal?: AbortSignal): Promise<CoreObjectResult> {
    return this.#request(
      'runs.fail_generation', params, GENERATION_FINALIZE_RPC_TIMEOUT_MS, signal,
    )
  }

  getRun(params: RunParams, signal?: AbortSignal): Promise<CoreRunSnapshot> {
    return this.#request('runs.get', params, CORE_READ_RPC_TIMEOUT_MS, signal) as Promise<CoreRunSnapshot>
  }

  listRuns(signal?: AbortSignal): Promise<RunHistoryResult> {
    return this.#request('runs.list', {}, CORE_READ_RPC_TIMEOUT_MS, signal) as Promise<RunHistoryResult>
  }

  listEvents(params: EventParams, signal?: AbortSignal): Promise<EventList> {
    return this.#request('runs.list_events', params, CORE_READ_RPC_TIMEOUT_MS, signal) as Promise<EventList>
  }

  listCandidates(params: RunParams, signal?: AbortSignal): Promise<CandidateList> {
    return this.#request('candidates.list', params, CORE_READ_RPC_TIMEOUT_MS, signal) as Promise<CandidateList>
  }

  reviewCandidate(params: ReviewCandidateParams, signal?: AbortSignal): Promise<CoreObjectResult> {
    return this.#request('candidates.review', params, CORE_WRITE_RPC_TIMEOUT_MS, signal)
  }

  listKnowledgePoints(params: RunParams, signal?: AbortSignal): Promise<KnowledgePointList> {
    return this.#request(
      'knowledge_points.list_for_run', params, CORE_READ_RPC_TIMEOUT_MS, signal,
    ) as Promise<KnowledgePointList>
  }

  updateKnowledgePoint(params: UpdateKnowledgePointParams, signal?: AbortSignal): Promise<CoreObjectResult> {
    return this.#request('knowledge_points.update', params, CORE_WRITE_RPC_TIMEOUT_MS, signal)
  }

  close(): void {
    if (this.#failure) return
    this.#finish(new CoreRpcError('CORE_RPC_CLOSED'), false)
  }

  #request<T extends object = Record<string, unknown>>(
    method: string,
    params: object,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.#failure) return Promise.reject(this.#failure)
    const id = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#poison(new CoreRpcError('CORE_RPC_TIMEOUT'))
      }, timeoutMs)
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        signal,
      }
      if (signal) {
        pending.abort = () => this.#poison(new CoreRpcError('CORE_RPC_ABORTED'))
        if (signal.aborted) {
          clearTimeout(timer)
          this.#poison(new CoreRpcError('CORE_RPC_ABORTED'))
          reject(this.#failure ?? new CoreRpcError('CORE_RPC_ABORTED'))
          return
        }
        signal.addEventListener('abort', pending.abort, { once: true })
      }
      this.#pending.set(id, pending)
      try {
        this.#output.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch {
        this.#poison(new CoreRpcError('CORE_RPC_STREAM_ERROR'))
      }
    })
  }

  readonly #onData = (chunk: string): void => {
    if (this.#failure) return
    this.#buffer += chunk
    while (true) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) {
        if (Buffer.byteLength(this.#buffer, 'utf8') > CORE_RPC_MAX_LINE_BYTES) {
          this.#poison(new CoreRpcError('CORE_RPC_MESSAGE_TOO_LARGE'))
        }
        return
      }
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      if (Buffer.byteLength(line, 'utf8') > CORE_RPC_MAX_LINE_BYTES) {
        this.#poison(new CoreRpcError('CORE_RPC_MESSAGE_TOO_LARGE'))
        return
      }
      if (line.length === 0) {
        this.#poison(new CoreRpcError('CORE_RPC_INVALID_MESSAGE'))
        return
      }
      this.#acceptLine(line)
      if (this.#failure) return
    }
  }

  readonly #onEnd = (): void => this.#poison(new CoreRpcError('CORE_RPC_EOF'))
  readonly #onStreamError = (): void => this.#poison(new CoreRpcError('CORE_RPC_STREAM_ERROR'))

  #acceptLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.#poison(new CoreRpcError('CORE_RPC_MALFORMED_JSON'))
      return
    }
    if (!isObject(message) || message.jsonrpc !== '2.0' || !Number.isSafeInteger(message.id)) {
      this.#poison(new CoreRpcError('CORE_RPC_INVALID_MESSAGE'))
      return
    }
    const id = message.id as number
    const pending = this.#pending.get(id)
    if (!pending) {
      this.#poison(new CoreRpcError(
        this.#completed.has(id) ? 'CORE_RPC_DUPLICATE_ID' : 'CORE_RPC_UNKNOWN_ID',
      ))
      return
    }
    if (hasExactKeys(message, ['jsonrpc', 'id', 'result']) && isObject(message.result)) {
      this.#settle(id, pending)
      pending.resolve(message.result)
      return
    }
    if (hasExactKeys(message, ['jsonrpc', 'id', 'error']) && isObject(message.error)) {
      const error = message.error
      const data = error.data
      if (
        !hasExactKeys(error, ['code', 'message', 'data'])
        || typeof error.code !== 'number'
        || typeof error.message !== 'string'
        || !isObject(data)
        || typeof data.code !== 'string'
        || error.message !== data.code
      ) {
        this.#poison(new CoreRpcError('CORE_RPC_INVALID_MESSAGE'))
        return
      }
      this.#settle(id, pending)
      pending.reject(new CoreRpcError(data.code))
      return
    }
    this.#poison(new CoreRpcError('CORE_RPC_INVALID_MESSAGE'))
  }

  #settle(id: number, pending: PendingRequest): void {
    clearTimeout(pending.timer)
    if (pending.signal && pending.abort) pending.signal.removeEventListener('abort', pending.abort)
    this.#pending.delete(id)
    this.#completed.add(id)
  }

  #poison(error: CoreRpcError): void {
    this.#finish(error, true)
  }

  #finish(error: CoreRpcError, notify: boolean): void {
    if (this.#failure) return
    this.#failure = error
    this.#input.off('data', this.#onData)
    this.#input.off('end', this.#onEnd)
    this.#input.off('error', this.#onStreamError)
    this.#output.off('error', this.#onStreamError)
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      if (pending.signal && pending.abort) pending.signal.removeEventListener('abort', pending.abort)
      pending.reject(error)
    }
    this.#pending.clear()
    if (notify) this.#onPoisoned(error)
  }
}
