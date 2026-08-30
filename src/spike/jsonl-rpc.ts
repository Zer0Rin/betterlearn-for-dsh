import type { Readable, Writable } from 'node:stream'

interface JsonlRpcClientOptions {
  maxLineBytes?: number
  timeoutMs?: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

interface NotificationWaiter {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

function rpcError(code: string): Error {
  return new Error(code)
}

export class JsonlRpcClient {
  readonly #input: Readable
  readonly #output: Writable
  readonly #maxLineBytes: number
  readonly #timeoutMs: number
  readonly #pending = new Map<number, PendingRequest>()
  readonly #completed = new Set<number>()
  readonly #notificationWaiters = new Map<string, NotificationWaiter[]>()
  readonly #notifications = new Map<string, unknown[]>()
  #buffer = ''
  #nextId = 1
  #failure: Error | null = null

  constructor(input: Readable, output: Writable, options: JsonlRpcClientOptions = {}) {
    this.#input = input
    this.#output = output
    this.#maxLineBytes = options.maxLineBytes ?? 64 * 1024
    this.#timeoutMs = options.timeoutMs ?? 2_000
    input.setEncoding('utf8')
    input.on('data', this.#onData)
    input.on('end', () => this.#fail(rpcError('JSONL_RPC_EOF')))
    input.on('error', () => this.#fail(rpcError('JSONL_RPC_STREAM_ERROR')))
    output.on('error', () => this.#fail(rpcError('JSONL_RPC_STREAM_ERROR')))
  }

  request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure)
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(rpcError('JSONL_RPC_TIMEOUT')), this.#timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      if (signal) {
        const abort = (): void => this.#fail(rpcError('JSONL_RPC_ABORTED'))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      }
      if (!this.#failure) {
        this.#output.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      }
    })
  }

  waitForNotification(method: string): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure)
    const queued = this.#notifications.get(method)?.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(rpcError('JSONL_RPC_TIMEOUT')), this.#timeoutMs)
      const waiters = this.#notificationWaiters.get(method) ?? []
      waiters.push({ resolve, reject, timer })
      this.#notificationWaiters.set(method, waiters)
    })
  }

  readonly #onData = (chunk: string): void => {
    if (this.#failure) return
    this.#buffer += chunk
    while (true) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) {
        if (Buffer.byteLength(this.#buffer, 'utf8') > this.#maxLineBytes) {
          this.#fail(rpcError('JSONL_RPC_LINE_TOO_LARGE'))
        }
        return
      }
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      if (Buffer.byteLength(line, 'utf8') > this.#maxLineBytes) {
        this.#fail(rpcError('JSONL_RPC_LINE_TOO_LARGE'))
        return
      }
      if (line.length === 0) continue
      this.#acceptLine(line)
      if (this.#failure) return
    }
  }

  #acceptLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.#fail(rpcError('JSONL_RPC_MALFORMED_JSON'))
      return
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      this.#fail(rpcError('JSONL_RPC_INVALID_MESSAGE'))
      return
    }
    const record = message as Record<string, unknown>
    if (record.jsonrpc !== '2.0') {
      this.#fail(rpcError('JSONL_RPC_INVALID_MESSAGE'))
      return
    }
    if (typeof record.method === 'string' && record.id === undefined) {
      this.#acceptNotification(record.method, record.params)
      return
    }
    if (!Number.isInteger(record.id)) {
      this.#fail(rpcError('JSONL_RPC_INVALID_MESSAGE'))
      return
    }
    const id = record.id as number
    const pending = this.#pending.get(id)
    if (!pending) {
      this.#fail(rpcError(this.#completed.has(id) ? 'JSONL_RPC_DUPLICATE_ID' : 'JSONL_RPC_UNKNOWN_ID'))
      return
    }
    clearTimeout(pending.timer)
    this.#pending.delete(id)
    this.#completed.add(id)
    if (record.error !== undefined) pending.reject(rpcError('JSONL_RPC_REMOTE_ERROR'))
    else pending.resolve(record.result)
  }

  #acceptNotification(method: string, params: unknown): void {
    const waiter = this.#notificationWaiters.get(method)?.shift()
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve(params)
      return
    }
    const queued = this.#notifications.get(method) ?? []
    queued.push(params)
    this.#notifications.set(method, queued)
  }

  #fail(error: Error): void {
    if (this.#failure) return
    this.#failure = error
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
    for (const waiters of this.#notificationWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
    }
    this.#notificationWaiters.clear()
  }
}
