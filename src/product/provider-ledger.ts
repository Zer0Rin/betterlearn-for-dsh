import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ModelSelectionSnapshot } from './types.js'

const TOOL = 'structured_output' as const
const SHA256 = /^[a-f0-9]{64}$/

export interface ProviderAttemptContext {
  coreRequestDigest: string
  modelSelection: ModelSelectionSnapshot
  promptVersion: string
  schemaSha256: string
}

export interface ProviderLedgerRecord {
  sequence: number
  coreRequestDigest: string
  providerRequestDigest: string
  provider: string
  model: string
  reasoningEffort?: string
  promptVersion: string
  schemaSha256: string
  toolNames: [typeof TOOL]
  result: 'structured' | 'aborted' | 'error'
}

export interface FakeLedgerRecord {
  sequence: number
  providerRequestDigest: string
  provider: string
  model: string
  reasoningEffort?: string
  toolNames: string[]
  result: ProviderLedgerRecord['result']
  adapterNonce: string
}

export interface PreparedCoreTranscript {
  sequence: number
  coreRequestDigest: string
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      if (key === 'signal') continue
      const child = (value as Record<string, unknown>)[key]
      if (child !== undefined) result[key] = canonicalize(child)
    }
    return result
  }
  return value
}

export function providerRequestDigest(options: GenerateOptions): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(options)), 'utf8')
    .digest('hex')
}

function resultFromFinish(chunk: StreamChunk): ProviderLedgerRecord['result'] | undefined {
  if (chunk.type !== 'finish') return undefined
  if (chunk.reason.kind === 'tool-calls') return 'structured'
  if (chunk.reason.kind === 'aborted') return 'aborted'
  if (chunk.reason.kind === 'error') return 'error'
  throw new Error('PROVIDER_RESULT_INVALID')
}

export class ProviderLedger {
  readonly #attempt = new AsyncLocalStorage<ProviderAttemptContext>()
  readonly #records: ProviderLedgerRecord[] = []
  readonly #claimedDigests = new Set<string>()

  get records(): readonly ProviderLedgerRecord[] {
    return this.#records.map((record) => ({ ...record, toolNames: [...record.toolNames] }))
  }

  runInAttempt<T>(attempt: ProviderAttemptContext, fn: () => Promise<T>): Promise<T> {
    if (!SHA256.test(attempt.coreRequestDigest)) throw new Error('CORE_REQUEST_DIGEST_INVALID')
    const frozen = {
      coreRequestDigest: attempt.coreRequestDigest,
      modelSelection: { ...attempt.modelSelection },
      promptVersion: attempt.promptVersion,
      schemaSha256: attempt.schemaSha256,
    }
    return this.#attempt.run(frozen, fn)
  }

  async *wrap(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const attempt = this.#attempt.getStore()
    if (!attempt) {
      yield* next()
      return
    }
    const toolNames = [...(options.tools?.map((tool) => tool.name) ?? [])].sort()
    if (
      options.provider !== attempt.modelSelection.provider
      || options.model !== attempt.modelSelection.model
      || (options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort))
        !== attempt.modelSelection.reasoningEffort
      || options.purpose !== undefined
      || toolNames.length !== 1
      || toolNames[0] !== TOOL
    ) throw new Error('PROVIDER_BOUNDARY_REJECTED')
    if (this.#claimedDigests.has(attempt.coreRequestDigest)) {
      throw new Error('PROVIDER_CALL_BUDGET_EXCEEDED')
    }
    this.#claimedDigests.add(attempt.coreRequestDigest)

    let result: ProviderLedgerRecord['result'] | undefined
    for await (const chunk of next()) {
      const terminal = resultFromFinish(chunk)
      if (terminal !== undefined) {
        if (result !== undefined) throw new Error('PROVIDER_RESULT_INVALID')
        result = terminal
      }
      yield chunk
    }
    if (result === undefined) throw new Error('PROVIDER_RESULT_INVALID')
    this.#records.push({
      sequence: this.#records.length + 1,
      coreRequestDigest: attempt.coreRequestDigest,
      providerRequestDigest: providerRequestDigest(options),
      provider: attempt.modelSelection.provider,
      model: attempt.modelSelection.model,
      ...(attempt.modelSelection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: attempt.modelSelection.reasoningEffort }),
      promptVersion: attempt.promptVersion,
      schemaSha256: attempt.schemaSha256,
      toolNames: [TOOL],
      result,
    })
  }
}

export function installProviderLedger(ctx: Context, ledger: ProviderLedger): () => void {
  return ctx.on('llm/stream', async function* (options, next) {
    yield* ledger.wrap(options, next)
  })
}

function mismatch(): never {
  throw new Error('PROVIDER_LEDGER_MISMATCH')
}

export function compareProviderLedgers(
  boundary: readonly ProviderLedgerRecord[],
  fake: readonly FakeLedgerRecord[],
  transcripts: readonly PreparedCoreTranscript[],
  expectedNonce: string,
): { calls: number } {
  if (expectedNonce.length < 32 || boundary.length !== fake.length || boundary.length !== transcripts.length) mismatch()
  for (let index = 0; index < boundary.length; index += 1) {
    const product = boundary[index]
    const adapter = fake[index]
    const transcript = transcripts[index]
    const sequence = index + 1
    if (
      product.sequence !== sequence
      || adapter.sequence !== sequence
      || transcript.sequence !== sequence
      || adapter.adapterNonce !== expectedNonce
      || product.provider !== adapter.provider
      || product.model !== adapter.model
      || product.reasoningEffort !== adapter.reasoningEffort
      || product.result !== adapter.result
      || product.providerRequestDigest !== adapter.providerRequestDigest
      || product.toolNames.length !== 1
      || adapter.toolNames.length !== 1
      || product.toolNames[0] !== TOOL
      || adapter.toolNames[0] !== TOOL
      || product.coreRequestDigest !== transcript.coreRequestDigest
    ) mismatch()
  }
  return { calls: boundary.length }
}
