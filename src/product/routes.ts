import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerationProgress } from '../generation-progress.js'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CoreRpcError } from './core-rpc-client.js'
import { GenerationBusyError, type GenerationLaunch } from './generation-coordinator.js'
import { ModelSelectionResolutionError } from './model-selection-resolver.js'
import { DshConversationSourceError } from './dsh-conversation-source.js'
import {
  authorizeProductRequest,
  parseProductJsonBody,
  ProductRequestError,
  requestHasBody,
} from './request-security.js'
import type {
  DocumentPreview,
  DocumentPreviewParams,
  DshConversationImportParams,
  DshConversationPreview,
  CandidateList,
  CoreObjectResult,
  CoreRunSnapshot,
  CoreState,
  EventList,
  ImportAndPrepareParams,
  KnowledgePointList,
  LearningAttemptParams,
  LearningAttemptResult,
  LearningCourseSnapshot,
  LearningCourseSyncParams,
  ModelSelectionSnapshot,
  ReviewCandidateParams,
  RetryAndPrepareParams,
  RunHistoryResult,
  RunDeleteResult,
  UpdateKnowledgePointParams,
} from './types.js'

export interface ProductOperations {
  previewDocument(params: DocumentPreviewParams, signal?: AbortSignal): Promise<DocumentPreview>
  previewDshConversations(sessionIds: string[], signal?: AbortSignal): Promise<DshConversationPreview>
  watchRun(runId: string, onChange: (progress?: GenerationProgress) => void): () => void
  getProgress(runId: string): GenerationProgress | null
  launchImport(params: ImportAndPrepareParams, signal?: AbortSignal): Promise<GenerationLaunch>
  importDshConversations(params: DshConversationImportParams, signal?: AbortSignal): Promise<GenerationLaunch>
  listRuns(signal?: AbortSignal): Promise<RunHistoryResult>
  getRun(runId: string, signal?: AbortSignal): Promise<CoreRunSnapshot>
  listEvents(runId: string, after: number, signal?: AbortSignal): Promise<EventList>
  launchRetry(params: RetryAndPrepareParams, signal?: AbortSignal): Promise<GenerationLaunch>
  listCandidates(runId: string, signal?: AbortSignal): Promise<CandidateList>
  reviewCandidate(params: ReviewCandidateParams, signal?: AbortSignal): Promise<CoreObjectResult>
  listKnowledgePoints(runId: string, signal?: AbortSignal): Promise<KnowledgePointList>
  updateKnowledgePoint(params: UpdateKnowledgePointParams, signal?: AbortSignal): Promise<CoreObjectResult>
  deleteRun(runId: string, signal?: AbortSignal): Promise<RunDeleteResult>
  syncLearningCourse(params: LearningCourseSyncParams, signal?: AbortSignal): Promise<LearningCourseSnapshot>
  getLearningCourse(courseId: string, signal?: AbortSignal): Promise<LearningCourseSnapshot>
  submitLearningAttempt(params: LearningAttemptParams, signal?: AbortSignal): Promise<LearningAttemptResult>
}

interface SupervisorState {
  readonly state: CoreState
}

type RouteMatch =
  | { kind: 'preview'; method: 'POST' }
  | { kind: 'import'; method: 'POST' }
  | { kind: 'dsh-preview'; method: 'POST' }
  | { kind: 'dsh-import'; method: 'POST' }
  | { kind: 'stream'; method: 'GET'; runId: string }
  | { kind: 'progress'; method: 'GET'; runId: string }
  | { kind: 'runs'; method: 'GET' }
  | { kind: 'run'; method: 'GET'; runId: string }
  | { kind: 'run-delete'; method: 'DELETE'; runId: string }
  | { kind: 'events'; method: 'GET'; runId: string; after: string | undefined; queryValid: boolean }
  | { kind: 'retry'; method: 'POST'; runId: string }
  | { kind: 'candidates'; method: 'GET'; runId: string }
  | { kind: 'review'; method: 'POST'; candidateId: string }
  | { kind: 'knowledge-points'; method: 'GET'; runId: string }
  | { kind: 'knowledge-point-update'; method: 'PATCH'; knowledgePointId: string }
  | { kind: 'learning-course-sync'; method: 'POST' }
  | { kind: 'learning-course'; method: 'GET'; courseId: string }
  | { kind: 'learning-attempt'; method: 'POST'; assessmentId: string }

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

function matchRoute(url: URL, requestMethod?: string): RouteMatch | undefined {
  if (url.pathname === '/nobei/v1/documents/preview' && url.search === '') return { kind: 'preview', method: 'POST' }
  if (url.pathname === '/nobei/v1/imports' && url.search === '') return { kind: 'import', method: 'POST' }
  if (url.pathname === '/nobei/v1/dsh-conversations/preview' && url.search === '') return { kind: 'dsh-preview', method: 'POST' }
  if (url.pathname === '/nobei/v1/dsh-conversations/imports' && url.search === '') return { kind: 'dsh-import', method: 'POST' }
  if (url.pathname === '/nobei/v1/runs' && url.search === '') return { kind: 'runs', method: 'GET' }
  if (url.pathname === '/nobei/v1/learning-courses' && url.search === '') {
    return { kind: 'learning-course-sync', method: 'POST' }
  }
  let learningMatch = /^\/nobei\/v1\/learning-courses\/([^/]+)$/.exec(url.pathname)
  if (learningMatch && url.search === '') {
    return { kind: 'learning-course', method: 'GET', courseId: learningMatch[1] }
  }
  learningMatch = /^\/nobei\/v1\/learning-assessments\/([^/]+)\/attempts$/.exec(url.pathname)
  if (learningMatch && url.search === '') {
    return { kind: 'learning-attempt', method: 'POST', assessmentId: learningMatch[1] }
  }
  let match = /^\/nobei\/v1\/runs\/([^/]+)$/.exec(url.pathname)
  if (match && url.search === '') return requestMethod === 'DELETE'
    ? { kind: 'run-delete', method: 'DELETE', runId: match[1] }
    : { kind: 'run', method: 'GET', runId: match[1] }
  match = /^\/nobei\/v1\/runs\/([^/]+)\/stream$/.exec(url.pathname)
  if (match && url.search === '') return { kind: 'stream', method: 'GET', runId: match[1] }
  match = /^\/nobei\/v1\/runs\/([^/]+)\/progress$/.exec(url.pathname)
  if (match && url.search === '') return { kind: 'progress', method: 'GET', runId: match[1] }
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
  match = /^\/nobei\/v1\/knowledge-points\/([^/]+)$/.exec(url.pathname)
  if (match && url.search === '') return { kind: 'knowledge-point-update', method: 'PATCH', knowledgePointId: match[1] }
  return undefined
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function resourceId(value: string, prefix: 'job' | 'cand' | 'kp' | 'course' | 'asm'): boolean {
  return new RegExp(`^${prefix}_[0-9a-f]{20}$`).test(value)
}

function parseLearningCourseSync(value: unknown): LearningCourseSyncParams | undefined {
  if (!exactObject(value, ['clientBookId', 'title', 'knowledgePointIds'])) return undefined
  if (
    typeof value.clientBookId !== 'string'
    || !/^book-[a-z0-9-]{1,123}$/.test(value.clientBookId)
    || !validModelText(value.title, 160)
    || !Array.isArray(value.knowledgePointIds)
    || value.knowledgePointIds.length < 1
    || value.knowledgePointIds.length > 100
    || !value.knowledgePointIds.every(id => typeof id === 'string' && resourceId(id, 'kp'))
    || new Set(value.knowledgePointIds).size !== value.knowledgePointIds.length
  ) return undefined
  return {
    clientBookId: value.clientBookId,
    title: value.title,
    knowledgePointIds: [...value.knowledgePointIds] as string[],
  }
}

function parseLearningAttempt(value: unknown, assessmentId: string): LearningAttemptParams | undefined {
  if (!exactObject(value, ['optionId', 'idempotencyKey'])) return undefined
  if (
    typeof value.optionId !== 'string'
    || !/^opt_[0-9a-f]{20}$/.test(value.optionId)
    || typeof value.idempotencyKey !== 'string'
    || !/^idem_[0-9a-f]{20}$/.test(value.idempotencyKey)
  ) return undefined
  return { assessmentId, optionId: value.optionId, idempotencyKey: value.idempotencyKey }
}

function parseKnowledgePointUpdate(value: unknown, knowledgePointId: string): UpdateKnowledgePointParams | undefined {
  if (!exactObject(value, ['title', 'statement'])) return undefined
  if (!validModelText(value.title, 120) || !validModelText(value.statement, 2_000)) return undefined
  return { knowledgePointId, title: value.title, statement: value.statement }
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

function parseModelSelection(value: unknown): ModelSelectionSnapshot | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const selection = value as Record<string, unknown>
  const selectionKeys = Object.keys(selection).sort().join(',')
  if (
    (selectionKeys !== 'model,provider' && selectionKeys !== 'model,provider,reasoningEffort')
    || !validModelText(selection.provider, 64)
    || !validModelText(selection.model, 128)
    || ('reasoningEffort' in selection && !validModelText(selection.reasoningEffort, 64))
  ) return undefined
  return {
    provider: selection.provider,
    model: selection.model,
    ...('reasoningEffort' in selection
      ? { reasoningEffort: selection.reasoningEffort as string }
      : {}),
  }
}

function parseImport(value: unknown): ImportAndPrepareParams | undefined {
  if (!exactObject(value, ['filename', 'mediaType', 'text', 'modelSelection'])) return undefined
  const { filename, mediaType, text, modelSelection } = value
  const parsedSelection = parseModelSelection(modelSelection)
  if (
    typeof filename !== 'string' || filename.length < 1 || filename.length > 255
    || filename === '.' || filename === '..' || /[\\/\0]/.test(filename)
    || (mediaType !== 'text/plain' && mediaType !== 'text/markdown' && mediaType !== 'application/pdf')
    || typeof text !== 'string' || text.length === 0
    || Buffer.byteLength(text, 'utf8') > 512 * 1024
    || !parsedSelection
  ) return undefined
  return {
    filename,
    mediaType,
    text,
    modelSelection: parsedSelection,
  }
}

function validSessionIds(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 50
    && value.every(sessionId => validModelText(sessionId, 256))
    && new Set(value).size === value.length
}

function parseDshSelection(value: unknown): string[] | undefined {
  if (!exactObject(value, ['sessionIds']) || !validSessionIds(value.sessionIds)) return undefined
  return [...value.sessionIds]
}

function parseDshImport(value: unknown): DshConversationImportParams | undefined {
  if (!exactObject(value, ['sessionIds', 'expectedDigest', 'modelSelection'])) return undefined
  const selection = parseModelSelection(value.modelSelection)
  if (
    !validSessionIds(value.sessionIds)
    || typeof value.expectedDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.expectedDigest)
    || !selection
  ) return undefined
  return {
    sessionIds: [...value.sessionIds],
    expectedDigest: value.expectedDigest,
    modelSelection: selection,
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
    && (mediaType === 'text/plain' || mediaType === 'text/markdown' || mediaType === 'application/pdf'
      || mediaType === 'application/vnd.betterlearn.dsh-conversation+markdown')
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
      const route = matchRoute(url, req.method)
      if (!route) return sendError(res, 404, 'ROUTE_NOT_FOUND')
      if (req.method !== route.method) {
        return sendError(res, 405, 'METHOD_NOT_ALLOWED', { allow: route.method })
      }

      let body: unknown
      if (route.method === 'GET' || route.method === 'DELETE') {
        if (requestHasBody(req)) {
          req.resume()
          return sendError(res, 400, route.method === 'GET' ? 'GET_BODY_FORBIDDEN' : 'DELETE_BODY_FORBIDDEN')
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
      if (route.kind === 'knowledge-point-update' && !resourceId(route.knowledgePointId, 'kp')) {
        return sendError(res, 400, 'REQUEST_INPUT_INVALID')
      }
      if (route.kind === 'learning-course' && !resourceId(route.courseId, 'course')) {
        return sendError(res, 400, 'REQUEST_INPUT_INVALID')
      }
      if (route.kind === 'learning-attempt' && !resourceId(route.assessmentId, 'asm')) {
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
      const dshPreviewParams = route.kind === 'dsh-preview' ? parseDshSelection(body) : undefined
      const dshImportParams = route.kind === 'dsh-import' ? parseDshImport(body) : undefined
      const retryParams = route.kind === 'retry' ? parseRetry(body, route.runId) : undefined
      const reviewParams = route.kind === 'review' ? parseReview(body, route.candidateId) : undefined
      const updateParams = route.kind === 'knowledge-point-update'
        ? parseKnowledgePointUpdate(body, route.knowledgePointId)
        : undefined
      const learningCourseParams = route.kind === 'learning-course-sync'
        ? parseLearningCourseSync(body)
        : undefined
      const learningAttemptParams = route.kind === 'learning-attempt'
        ? parseLearningAttempt(body, route.assessmentId)
        : undefined
      if (
        (route.kind === 'preview' && !previewParams)
        || (route.kind === 'import' && !importParams)
        || (route.kind === 'dsh-preview' && !dshPreviewParams)
        || (route.kind === 'dsh-import' && !dshImportParams)
        || (route.kind === 'retry' && !retryParams)
        || (route.kind === 'review' && !reviewParams)
        || (route.kind === 'knowledge-point-update' && !updateParams)
        || (route.kind === 'learning-course-sync' && !learningCourseParams)
        || (route.kind === 'learning-attempt' && !learningAttemptParams)
      ) return sendError(res, 400, 'REQUEST_INPUT_INVALID')

      if (supervisor.state !== 'READY') return sendError(res, 503, 'CORE_UNAVAILABLE')
      try {
        if (route.kind === 'stream') {
          const notify = (progress?: GenerationProgress) => {
            if (!res.destroyed && !res.writableEnded) res.write(progress
              ? `event: run.progress\ndata: ${JSON.stringify(progress)}\n\n`
              : 'event: run.changed\ndata: {}\n\n')
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
          const progress = operations.getProgress(route.runId)
          if (progress) notify(progress)
          return
        }
        let result: unknown
        if (route.kind === 'preview') result = await operations.previewDocument(previewParams as DocumentPreviewParams)
        else if (route.kind === 'import') result = await operations.launchImport(importParams as ImportAndPrepareParams)
        else if (route.kind === 'dsh-preview') result = await operations.previewDshConversations(dshPreviewParams as string[])
        else if (route.kind === 'dsh-import') result = await operations.importDshConversations(dshImportParams as DshConversationImportParams)
        else if (route.kind === 'runs') result = await operations.listRuns()
        else if (route.kind === 'run') result = await operations.getRun(route.runId)
        else if (route.kind === 'run-delete') result = await operations.deleteRun(route.runId)
        else if (route.kind === 'progress') result = operations.getProgress(route.runId)
        else if (route.kind === 'events') result = await operations.listEvents(route.runId, after as number)
        else if (route.kind === 'retry') result = await operations.launchRetry(retryParams as RetryAndPrepareParams)
        else if (route.kind === 'candidates') result = await operations.listCandidates(route.runId)
        else if (route.kind === 'review') result = await operations.reviewCandidate(reviewParams as ReviewCandidateParams)
        else if (route.kind === 'knowledge-points') result = await operations.listKnowledgePoints(route.runId)
        else if (route.kind === 'knowledge-point-update') result = await operations.updateKnowledgePoint(updateParams as UpdateKnowledgePointParams)
        else if (route.kind === 'learning-course-sync') result = await operations.syncLearningCourse(learningCourseParams as LearningCourseSyncParams)
        else if (route.kind === 'learning-course') result = await operations.getLearningCourse(route.courseId)
        else result = await operations.submitLearningAttempt(learningAttemptParams as LearningAttemptParams)
        if (!res.destroyed && !res.writableEnded) {
          sendJson(res, route.kind === 'import' || route.kind === 'dsh-import' || route.kind === 'retry' ? 202 : 200, { ok: true, result })
        }
      } catch (error) {
        if (res.destroyed || res.writableEnded) return
        if (error instanceof GenerationBusyError) return sendError(res, 429, 'GENERATION_BUSY')
        if (error instanceof ModelSelectionResolutionError) {
          return sendError(res, 422, error.code)
        }
        if (error instanceof DshConversationSourceError) {
          const status = error.code === 'DSH_CONVERSATION_NOT_FOUND' ? 404
            : error.code === 'DSH_CONVERSATION_READ_FAILED' ? 503
              : error.code === 'DSH_CONVERSATION_CHANGED' ? 409
                : 400
          return sendError(res, status, error.code)
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
