import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  ReasoningEffortId,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const PROVIDER = 'deepseek-official' as const
const MODEL = 'deepseek-v4-flash' as const
const TOOL = 'structured_output' as const
const SPIKE_ROUTES = new Map([
  ['fake-a', 'model-a'],
  ['fake-b', 'model-b'],
  ['fake-c', 'model-c'],
])

export interface FakeLedgerRecord {
  sequence: number
  providerRequestDigest: string
  provider: string
  model: string
  reasoningEffort?: string
  toolNames: string[]
  result: 'structured' | 'text' | 'aborted' | 'error'
  adapterNonce: string
}

interface FakeProviderOptions {
  fixtures?: Record<string, unknown>
}

const DEFAULT_FIXTURES: Record<string, unknown> = {
  one: {
    schemaVersion: 1,
    candidates: [{
      type: 'concept',
      title: '光合作用',
      statement: '光合作用是绿色植物利用光能的过程。',
      evidence: [{ quote: '光合作用是绿色植物利用光能的过程。', prefix: '', suffix: '' }],
    }],
  },
  three: {
    schemaVersion: 1,
    candidates: [
      {
        type: 'process',
        title: '光合作用',
        statement: '绿色植物通过光合作用利用光能合成有机物并释放氧气。',
        evidence: [{ quote: '光合作用是绿色植物利用光能合成有机物并释放氧气的过程。', prefix: '', suffix: '' }],
      },
      {
        type: 'concept',
        title: '叶绿素',
        statement: '叶绿体中的叶绿素承担吸收光能的作用。',
        evidence: [{ quote: '叶绿体中的叶绿素负责吸收光能。', prefix: '', suffix: '' }],
      },
      {
        type: 'fact',
        title: '生态系统产物',
        statement: '光合作用为生态系统提供有机物和氧气。',
        evidence: [{ quote: '光合作用为生态系统提供有机物和氧气。', prefix: '', suffix: '' }],
      },
    ],
  },
}

export interface FakeProviderInstallation {
  adapter: FakeProviderAdapter
  ledgerToken: string
  dispose(): void
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

export function fakeProviderRequestDigest(options: GenerateOptions): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(options)), 'utf8')
    .digest('hex')
}

function aborted(): StreamChunk {
  return {
    type: 'finish',
    reason: {
      kind: 'aborted',
      failure: { code: 'ABORTED', message: 'Fake provider call aborted.' },
    },
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const finish = (completed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(completed)
    }
    const onAbort = () => finish(false)
    const timer = setTimeout(() => finish(true), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class FakeProviderAdapter extends LlmAdapter {
  readonly nonce = randomBytes(24).toString('hex')
  readonly #fixtures: Record<string, unknown>
  readonly #records: FakeLedgerRecord[] = []

  constructor(options: FakeProviderOptions = {}) {
    super()
    this.#fixtures = options.fixtures ?? DEFAULT_FIXTURES
  }

  get records(): readonly FakeLedgerRecord[] {
    return this.#records.map((record) => ({ ...record, toolNames: [...record.toolNames] }))
  }

  override providerInfo(provider: string): LlmProviderInfo {
    if (provider === PROVIDER) return { id: PROVIDER, name: 'Nobei Phase 1C Fake Provider' }
    if (SPIKE_ROUTES.has(provider)) return { id: provider, name: `Nobei Phase 1E ${provider}` }
    throw new Error('FAKE_PROVIDER_ROUTE_INVALID')
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (provider === PROVIDER) {
      if (model !== MODEL) throw new Error('FAKE_PROVIDER_ROUTE_INVALID')
      return super.resolveModel(provider, model)
    }
    if (SPIKE_ROUTES.get(provider) !== model) throw new Error('FAKE_PROVIDER_ROUTE_INVALID')
    const efforts = [
      { id: ReasoningEffortId('low'), name: 'Low' },
      { id: ReasoningEffortId('high'), name: 'High' },
    ] as const
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts,
        ...(model === 'model-c' ? {} : { defaultEffort: ReasoningEffortId('low') }),
      },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const base = {
      sequence: this.#records.length + 1,
      providerRequestDigest: fakeProviderRequestDigest(options),
      provider: options.provider,
      model: options.model,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) }),
      toolNames: options.tools?.map(tool => tool.name) ?? [],
      adapterNonce: this.nonce,
    }
    if (options.signal?.aborted) {
      this.#records.push({ ...base, result: 'aborted' })
      yield aborted()
      return
    }
    const requestText = JSON.stringify(options.messages)
    if (SPIKE_ROUTES.get(options.provider) === options.model
      && requestText.includes('Phase 1E model selection propagation')) {
      const text = 'Phase 1E fake provider response.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      this.#records.push({ ...base, result: 'text' })
      return
    }
    if (options.provider === PROVIDER
      && options.model === MODEL
      && requestText.includes('Phase 1D WebUI activation. No product data.')) {
      const text = 'Nobei WebUI ready.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      this.#records.push({ ...base, result: 'text' })
      return
    }
    if (
      options.provider !== PROVIDER
      || options.model !== MODEL
      || options.tools?.length !== 1
      || options.tools[0]?.name !== TOOL
    ) {
      this.#records.push({ ...base, result: 'error' })
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'FAKE_REQUEST_INVALID', message: 'Invalid fake provider request.' } },
      }
      return
    }

    const fixtureKey = Object.keys(this.#fixtures).sort().find((key) => requestText.includes(`fixture:${key}`))
    const value = fixtureKey === undefined
      ? { schemaVersion: 1, candidates: [] }
      : this.#fixtures[fixtureKey]
    if (fixtureKey === 'three' && !await delay(1_000, options.signal)) {
      this.#records.push({ ...base, result: 'aborted' })
      yield aborted()
      return
    }
    const id = CallId(`nobei-fake-${this.#records.length + 1}`)
    const argumentsJson = JSON.stringify(value)
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name: TOOL, argumentsDelta: argumentsJson },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: TOOL, arguments: argumentsJson } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    for (const chunk of chunks) {
      if (options.signal?.aborted) {
        this.#records.push({ ...base, result: 'aborted' })
        yield aborted()
        return
      }
      yield chunk
    }
    this.#records.push({ ...base, result: 'structured' })
  }
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(payload.length))
  res.end(payload)
}

export function installFakeProvider(
  ctx: Context,
  options: FakeProviderOptions & { ledgerToken?: string } = {},
): FakeProviderInstallation {
  const ledgerToken = options.ledgerToken ?? randomBytes(24).toString('hex')
  if (ledgerToken.length < 32) throw new Error('FAKE_LEDGER_TOKEN_INVALID')
  const adapter = new FakeProviderAdapter(options)
  const unregisterAdapter = ctx.llm.registerAdapter([PROVIDER, ...SPIKE_ROUTES.keys()], adapter)
  let unregisterRoute: (() => void) | undefined
  try {
    unregisterRoute = ctx.webServer.register({
      kind: 'exact',
      path: '/nobei-acceptance/fake-provider-ledger',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' })
        if (req.headers.authorization !== `Bearer ${ledgerToken}`) {
          return sendJson(res, 403, { error: 'LEDGER_AUTHORIZATION_REQUIRED' })
        }
        return sendJson(res, 200, { nonce: adapter.nonce, records: adapter.records })
      },
    })
  } catch (error) {
    unregisterAdapter()
    throw error
  }
  return {
    adapter,
    ledgerToken,
    dispose() {
      unregisterRoute?.()
      unregisterRoute = undefined
      unregisterAdapter()
    },
  }
}

export const name = 'nobei-phase1c-fake-provider'
export const inject = ['llm', 'webServer'] as const

export function apply(ctx: Context, config: { ledgerToken: string }): () => void {
  const installation = installFakeProvider(ctx, { ledgerToken: config?.ledgerToken })
  return () => installation.dispose()
}
