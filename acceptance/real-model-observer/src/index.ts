import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'

export const name = 'nobei-phase1e-real-model-observer'
export const inject = ['llm', 'webServer'] as const

export interface ObserverLedgerRecord {
  readonly sequence: number
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

interface SelectionInput {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

function validSelection(value: unknown): value is SelectionInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const object = value as Record<string, unknown>
  const keys = Object.keys(object).sort().join(',')
  return (keys === 'model,provider' || keys === 'model,provider,reasoningEffort')
    && typeof object.provider === 'string' && object.provider.length > 0
    && typeof object.model === 'string' && object.model.length > 0
    && (object.reasoningEffort === undefined
      || (typeof object.reasoningEffort === 'string' && object.reasoningEffort.length > 0))
}

export async function resolveObservedSelection(
  ctx: Context,
  selection: unknown,
): Promise<SelectionInput> {
  if (!validSelection(selection)) throw new Error('OBSERVER_MODEL_SELECTION_INVALID')
  const resolved = await ctx.llm.resolveCallConfig({
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort as never }),
  })
  return {
    provider: resolved.provider,
    model: resolved.model,
    ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: String(resolved.reasoningEffort) }),
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 8 * 1024) throw new Error('OBSERVER_BODY_TOO_LARGE')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(payload.length))
  res.end(payload)
}

function validLedgerToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 32
}

/** Test-only observer. It watches the stream boundary but owns no provider route. */
export function apply(ctx: Context, config: { ledgerToken: string }): () => void {
  if (!validLedgerToken(config?.ledgerToken)) throw new Error('OBSERVER_LEDGER_TOKEN_INVALID')
  const records: ObserverLedgerRecord[] = []
  const unobserve = ctx.on('llm/stream', async function* (options, next) {
    records.push({
      sequence: records.length + 1,
      provider: options.provider,
      model: options.model,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) }),
    })
    yield* next()
  })
  const unregister = ctx.webServer.register({
    kind: 'exact',
    path: '/nobei-acceptance/phase1e-observer-ledger',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' })
      if (req.headers.authorization !== `Bearer ${config.ledgerToken}`) {
        return sendJson(res, 403, { error: 'LEDGER_AUTHORIZATION_REQUIRED' })
      }
      return sendJson(res, 200, { records: records.map((record) => ({ ...record })) })
    },
  })
  const unregisterResolver = ctx.webServer.register({
    kind: 'exact',
    path: '/nobei-acceptance/phase1e-resolve-model',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' })
      if (req.headers.authorization !== `Bearer ${config.ledgerToken}`) {
        return sendJson(res, 403, { error: 'LEDGER_AUTHORIZATION_REQUIRED' })
      }
      try {
        return sendJson(res, 200, { selection: await resolveObservedSelection(ctx, await readJson(req)) })
      } catch {
        return sendJson(res, 409, { error: 'MODEL_SELECTION_UNAVAILABLE' })
      }
    },
  })
  return () => {
    unregisterResolver()
    unregister()
    unobserve()
  }
}
