import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CoreRpcError } from './core-rpc-client.js'
import { GenerationBusyError, type GenerationLaunch } from './generation-coordinator.js'
import { ModelSelectionResolutionError } from './model-selection-resolver.js'
import {
  authorizeProductRequest,
  parseProductJsonBody,
  ProductRequestError,
  requestHasBody,
} from './request-security.js'
import type {
  DocumentPreview,
  DocumentPreviewParams,
  CandidateList,
  CoreObjectResult,
  CoreRunSnapshot,
  CoreState,
  EventList,
  ImportAndPrepareParams,
  KnowledgePointList,
  ReviewCandidateParams,
  RetryAndPrepareParams,
} from './types.js'

export interface ProductOperations {
  previewDocument(params: DocumentPreviewParams, signal?: AbortSignal): Promise<DocumentPreview>
  watchRun(runId: string, onChange: () => void): () => void
  launchImport(params: ImportAndPrepareParams, signal?: AbortSignal): Promise<GenerationLaunch>
  getRun(runId: string, signal?: AbortSignal): Promise<CoreRunSnapshot>
  listEvents(runId: string, after: number, signal?: AbortSignal): Promise<EventList>
  launchRetry(params: RetryAndPrepareParams, signal?: AbortSignal): Promise<GenerationLaunch>
  listCandidates(runId: string, signal?: AbortSignal): Promise<CandidateList>
  reviewCandidate(params: ReviewCandidateParams, signal?: AbortSignal): Promise<CoreObjectResult>
  listKnowledgePoints(runId: string, signal?: AbortSignal): Promise<KnowledgePointList>
}

interface SupervisorState {
  readonly state: CoreState
}

type RouteMatch =
  | { kind: 'preview'; method: 'POST' }
  | { kind: 'import'; method: 'POST' }
  | { kind: 'stream'; method: 'GET'; runId: string }
  | { kind: 'run'; method: 'GET'; runId: string }
  | { kind: 'events'; method: 'GET'; runId: string; after: string | undefined; queryValid: boolean }
  | { kind: 'retry'; method: 'POST'; runId: string }
  | { kind: 'candidates'; method: 'GET'; runId: string }
  | { kind: 'review'; method: 'POST'; candidateId: string }
  | { kind: 'knowledge-points'; method: 'GET'; runId: string }

function sendJson(res: ServerResponse, status: number, value: unknown, extra?: Record<string, string>): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
    ...extra,
  })
  res.end(body)
}

function sendError(res: ServerResponse, status: number, code: string, extra?: Record<string, string>): void {
  sendJson(res, status, { ok: false, error: { code } }, extra)
}

function matchRoute(url: URL): RouteMatch | undefined {
  if (url.pathname === '/nobei/v1/documents/preview' && url.search === '') return { kind: 'preview', method: 'POST' }
  if (url.pathname === '/nobei/v1/imports' && url.search === '') return { kind: 'import', method: 'POST' }
  let match = /^\/nobei\/v1\/runs\/([^/]+)$/.exec(url.pathname)
  if (match && url.search === '') return { kind: 'run', method: 'GET', runId: match[1] }
  match = /^\/nobei\/v1\/runs\/([^/]+)\/stream$/.exec(url.pathname)
  if (match && url.search === '') return { kind: 'stream', method: 'GET', runId: match[1] }
  match = /^\/nobei\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname)
  if (match) {
    const entries = [...url.searchParams.entries()]
    return {
      kind: 'events', method: 'GET', runId: match[1],
      after: url.searchParams.get('after') ?? undefined,
      queryValid: entries.length === 1 && entries[0]?.[0] === 'after',
    }
  }
  match = /^\/nobei\/v1\/runs\/([^/]+)\/retry$/.exec(url.pathname)
  if (match && url.search === '') return { kind: 'retry', method: 'POST', runId: match[1] }
  match = /^\/nobei\/v1\/runs\/([^/]+)\/candidates$/.exec(url.pathname)
  if (match && url.search === '') return { kind: 'candidates', method: 'GET', runId: match[1] }
  match = /^\/nobei\/v1\/candidates\/([^/]+)\/review$/.exec(url.pathname)
  if (match && url.search === '') return { kind: 'review', method: 'POST', candidateId: match[1] }
  match = /^\/nobei\/v1\/runs\/([^/]+)\/knowledge-points$/.exec(url.pathname)
  if (match && url.search === '') return { kind: 'knowledge-points', method: 'GET', runId: match[1] }
  return undefined
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function resourceId(value: string, prefix: 'job' | 'cand'): boolean {
  return new RegExp(`^${prefix}_[0-9a-f]{20}$`).test(value)
}

function positiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

function validModelText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maxLength
    && !/[\uD800-\uDFFF]/.test(value)
}

function parseImport(value: unknown): ImportAndPrepareParams | undefined {
  if (!exactObject(value, ['filename', 'mediaType', 'text', 'modelSelection'])) return undefined
  const { filename, mediaType, text, modelSelection } = value
  if (
    modelSelection === null
    || typeof modelSelection !== 'object'
    || Array.isArray(modelSelection)
  ) return undefined
  const selection = modelSelection as Record<string, unknown>
  const selectionKeys = Object.keys(selection).sort().join(',')
  if (
    typeof filename !== 'string' || filename.length < 1 || filename.length > 255
    || filename === '.' || filename === '..' || /[\\/\0]/.test(filename)
    || (mediaType !== 'text/plain' && mediaType !== 'text/markdown' && mediaType !== 'application/pdf')
    || typeof text !== 'string' || text.length === 0
    || Buffer.byteLength(text, 'utf8') > 512 * 1024
    || (selectionKeys !== 'model,provider' && selectionKeys !== 'model,provider,reasoningEffort')
    || !validModelText(selection.provider, 64)
    || !validModelText(selection.model, 128)
    || ('reasoningEffort' in selection && !validModelText(selection.reasoningEffort, 64))
  ) return undefined
  return {
    filename,
    mediaType,
    text,
    modelSelection: {
      provider: selection.provider,
      model: selection.model,
      ...('reasoningEffort' in selection
        ? { reasoningEffort: selection.reasoningEffort as string }
        : {}),
    },
  }
}

function parsePreview(value: unknown): DocumentPreviewParams | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const { filename, mediaType, text, contentBase64 } = input
  if (typeof filename !== 'string' || filename.length < 1 || filename.length > 255
    || filename === '.' || filename === '..' || /[\\/\0]/.test(filename)) return undefined
  if (mediaType === 'application/pdf' && exactObject(input, ['filename', 'mediaType', 'contentBase64'])
    && typeof contentBase64 === 'string' && contentBase64.length > 0
    && contentBase64.length <= 4 * Math.ceil(5 * 1024 * 1024 / 3)) return { filename, mediaType, contentBase64 }
  if (exactObject(input, ['filename', 'mediaType', 'text'])
    && (mediaType === 'text/plain' || mediaType === 'text/markdown' || mediaType === 'application/pdf')
    && typeof text === 'string' && text.length > 0 && Buffer.byteLength(text, 'utf8') <= 512 * 1024) return { filename, mediaType, text }
  return undefined
}

function parseRetry(value: unknown, runId: string): RetryAndPrepareParams | undefined {
  if (!exactObject(value, ['expectedRevision']) || !positiveRevision(value.expectedRevision)) return undefined
  return { runId, expectedRevision: value.expectedRevision }
}

function parseReview(value: unknown, candidateId: string): ReviewCandidateParams | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const action = input.action
  const edited = action === 'edited_and_accept'
  const expectedKeys = edited
    ? ['action', 'expectedRevision', 'idempotencyKey', 'title', 'statement']
    : ['action', 'expectedRevision', 'idempotencyKey']
  if (
    !exactObject(input, expectedKeys)
    || (action !== 'accept' && action !== 'edited_and_accept' && action !== 'reject')
    || !positiveRevision(input.expectedRevision)
    || typeof input.idempotencyKey !== 'string'
    || !/^idem_[0-9a-f]{20}$/.test(input.idempotencyKey)
  ) return undefined
  if (edited && (
    typeof input.title !== 'string' || input.title.length < 1 || input.title.length > 120
    || typeof input.statement !== 'string' || input.statement.length < 1 || input.statement.length > 2_000
  )) return undefined
  return {
    candidateId,
    action,
    expectedRevision: input.expectedRevision,
    idempotencyKey: input.idempotencyKey,
    ...(edited ? { title: input.title as string, statement: input.statement as string } : {}),
  }
}

function contentType(req: IncomingMessage): string | undefined {
  const value = req.headers['content-type']
  if (typeof value !== 'string') return undefined
  return value.split(';', 1)[0]?.trim().toLowerCase()
}

function publicCoreError(error: CoreRpcError): { status: number; code: string } {
  if (error.code === 'CORE_UNAVAILABLE' || error.code.startsWith('CORE_RPC_')) {
    return { status: 503, code: 'CORE_UNAVAILABLE' }
  }
  if (error.code.includes('NOT_FOUND')) return { status: 404, code: error.code }
  if (error.code.includes('CONFLICT') || error.code === 'RUN_STATE_CONFLICT') {
    return { status: 409, code: error.code }
  }
  if (error.code.startsWith('INVALID_') || error.code === 'REQUEST_TOO_LARGE' || error.code.startsWith('PDF_') || error.code.startsWith('DOCUMENT_')) {
    return { status: 400, code: error.code }
  }
  return { status: 500, code: 'INTERNAL_ERROR' }
}

export function registerProductRoutes(
  ctx: Context,
  supervisor: SupervisorState,
  operations: ProductOperations,
): () => void {
  const streams = new Set<() => void>()
  const unregister = ctx.webServer.register({
    kind: 'prefix',
    path: '/nobei/v1',
    handler: async (req, res) => {
      const mutation = req.method !== 'GET'
      const trust = authorizeProductRequest(req, mutation, ctx.webServer.port)
      if (!trust.ok) return sendError(res, trust.status, trust.code)
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = matchRoute(url)
      if (!route) return sendError(res, 404, 'ROUTE_NOT_FOUND')
      if (req.method !== route.method) {
        return sendError(res, 405, 'METHOD_NOT_ALLOWED', { allow: route.method })
      }

      let body: unknown
      if (route.method === 'GET') {
        if (requestHasBody(req)) {
          req.resume()
          return sendError(res, 400, 'GET_BODY_FORBIDDEN')
        }
      } else {
        if (contentType(req) !== 'application/json') return sendError(res, 415, 'JSON_REQUIRED')
        try {
          body = await parseProductJsonBody(req)
        } catch (error) {
          if (error instanceof ProductRequestError) {
            return sendError(res, error.status, error.code, error.status === 413 ? { connection: 'close' } : undefined)
          }
          return sendError(res, 400, 'BODY_READ_ERROR')
        }
      }

      if ('runId' in route && !resourceId(route.runId, 'job')) {
        return sendError(res, 400, 'REQUEST_INPUT_INVALID')
      }
      if (route.kind === 'review' && !resourceId(route.candidateId, 'cand')) {
        return sendError(res, 400, 'REQUEST_INPUT_INVALID')
      }
      const after = route.kind === 'events' && route.queryValid && /^(?:0|[1-9]\d*)$/.test(route.after ?? '')
        ? Number(route.after)
        : undefined
      if (route.kind === 'events' && (!Number.isSafeInteger(after) || (after as number) < 0)) {
        return sendError(res, 400, 'REQUEST_INPUT_INVALID')
      }
      const previewParams = route.kind === 'preview' ? parsePreview(body) : undefined
      const importParams = route.kind === 'import' ? parseImport(body) : undefined
      const retryParams = route.kind === 'retry' ? parseRetry(body, route.runId) : undefined
      const reviewParams = route.kind === 'review' ? parseReview(body, route.candidateId) : undefined
      if (
        (route.kind === 'preview' && !previewParams)
        || (route.kind === 'import' && !importParams)
        || (route.kind === 'retry' && !retryParams)
        || (route.kind === 'review' && !reviewParams)
      ) return sendError(res, 400, 'REQUEST_INPUT_INVALID')

      if (supervisor.state !== 'READY') return sendError(res, 503, 'CORE_UNAVAILABLE')
      try {
        if (route.kind === 'stream') {
          const notify = () => {
            if (!res.destroyed && !res.writableEnded) res.write('event: run.changed\ndata: {}\n\n')
          }
          const unsubscribe = operations.watchRun(route.runId, notify)
          const close = () => {
            unsubscribe()
            streams.delete(close)
            res.off('close', close)
            res.end()
          }
          streams.add(close)
          res.once('close', close)
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
          })
          // Refresh once on connection so an already-completed run is not missed.
          notify()
          return
        }
        let result: unknown
        if (route.kind === 'preview') result = await operations.previewDocument(previewParams as DocumentPreviewParams)
        else if (route.kind === 'import') result = await operations.launchImport(importParams as ImportAndPrepareParams)
        else if (route.kind === 'run') result = await operations.getRun(route.runId)
        else if (route.kind === 'events') result = await operations.listEvents(route.runId, after as number)
        else if (route.kind === 'retry') result = await operations.launchRetry(retryParams as RetryAndPrepareParams)
        else if (route.kind === 'candidates') result = await operations.listCandidates(route.runId)
        else if (route.kind === 'review') result = await operations.reviewCandidate(reviewParams as ReviewCandidateParams)
        else result = await operations.listKnowledgePoints(route.runId)
        if (!res.destroyed && !res.writableEnded) {
          sendJson(res, route.kind === 'import' || route.kind === 'retry' ? 202 : 200, { ok: true, result })
        }
      } catch (error) {
        if (res.destroyed || res.writableEnded) return
        if (error instanceof GenerationBusyError) return sendError(res, 429, 'GENERATION_BUSY')
        if (error instanceof ModelSelectionResolutionError) {
          return sendError(res, 422, error.code)
        }
        if (error instanceof CoreRpcError) {
          const mapped = publicCoreError(error)
          return sendError(res, mapped.status, mapped.code)
        }
        return sendError(res, 500, 'INTERNAL_ERROR')
      }
    },
  })
  return () => {
    unregister()
    for (const close of streams) close()
  }
}
