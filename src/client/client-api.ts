import type {
  ClientApi,
  DocumentPreview,
  EventPage,
  GenerationLaunch,
  ImportTextRequest,
  ReviewCommand,
  ReviewResult,
  RunSnapshot,
  CandidateSnapshot,
  KnowledgePointSnapshot,
  KnowledgePointUpdateResult,
  RunHistoryResult,
} from './types.js'
import type { GenerationProgress } from '../generation-progress.js'

export class ProductApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
    this.name = 'ProductApiError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function request<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const headers = {
    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...init.headers,
  }
  const response = await fetch(path, { ...init, headers, signal })
  const body: unknown = await response.json().catch(() => undefined)
  if (
    !response.ok
    || !record(body)
    || body.ok !== true
    || !Object.hasOwn(body, 'result')
  ) {
    const code = record(body) && record(body.error) && typeof body.error.code === 'string'
      ? body.error.code
      : 'INVALID_RESPONSE'
    throw new ProductApiError(response.status, code)
  }
  return body.result as T
}

function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'GET' }, signal)
}

function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) }, signal)
}

function patch<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }, signal)
}

export function createClientApi(): ClientApi {
  return {
    previewDocument(input, signal) {
      return post<DocumentPreview>('/nobei/v1/documents/preview', input, signal)
    },
    getProgress(runId, signal) {
      return get<GenerationProgress | null>(`/nobei/v1/runs/${encodeURIComponent(runId)}/progress`, signal)
    },
    watchRun(runId, onChange, onProgress) {
      if (typeof EventSource === 'undefined') return () => undefined
      const stream = new EventSource(`/nobei/v1/runs/${encodeURIComponent(runId)}/stream`)
      stream.addEventListener('run.changed', onChange)
      if (onProgress) stream.addEventListener('run.progress', event => {
        let progress: GenerationProgress
        try { progress = JSON.parse((event as MessageEvent).data) } catch { return }
        onProgress(progress)
      })
      // Polling continues independently; a broken SSE connection is not a run failure.
      stream.onerror = () => stream.close()
      return () => stream.close()
    },
    listRuns(signal) {
      return get<RunHistoryResult>('/nobei/v1/runs', signal)
    },
    importText(input: ImportTextRequest, signal?: AbortSignal) {
      return post<GenerationLaunch>('/nobei/v1/imports', input, signal)
    },
    getRun(runId: string, signal?: AbortSignal) {
      return get<RunSnapshot>(`/nobei/v1/runs/${encodeURIComponent(runId)}`, signal)
    },
    listEvents(runId: string, after: number, signal?: AbortSignal) {
      return get<EventPage>(`/nobei/v1/runs/${encodeURIComponent(runId)}/events?after=${after}`, signal)
    },
    retryRun(runId: string, expectedRevision: number, signal?: AbortSignal) {
      return post<GenerationLaunch>(
        `/nobei/v1/runs/${encodeURIComponent(runId)}/retry`,
        { expectedRevision },
        signal,
      )
    },
    listCandidates(runId: string, signal?: AbortSignal) {
      return get<{ candidates: CandidateSnapshot[] }>(
        `/nobei/v1/runs/${encodeURIComponent(runId)}/candidates`,
        signal,
      )
    },
    reviewCandidate(candidateId: string, input: ReviewCommand, signal?: AbortSignal) {
      return post<ReviewResult>(
        `/nobei/v1/candidates/${encodeURIComponent(candidateId)}/review`,
        input,
        signal,
      )
    },
    listKnowledgePoints(runId: string, signal?: AbortSignal) {
      return get<{ knowledgePoints: KnowledgePointSnapshot[] }>(
        `/nobei/v1/runs/${encodeURIComponent(runId)}/knowledge-points`,
        signal,
      )
    },
    updateKnowledgePoint(knowledgePointId, input, signal) {
      return patch<KnowledgePointUpdateResult>(
        `/nobei/v1/knowledge-points/${encodeURIComponent(knowledgePointId)}`,
        input,
        signal,
      )
    },
  }
}
