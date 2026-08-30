export type KnowledgePointType = 'concept' | 'process' | 'comparison' | 'formula' | 'fact' | 'code'
export type RunStatus =
  | 'generating'
  | 'validating'
  | 'review_pending'
  | 'completed'
  | 'failed_retryable'
  | 'failed_terminal'

export interface RunCounts {
  rawCandidates: number
  validCandidates: number
  pending: number
  accepted: number
  editedAndAccepted: number
  rejected: number
  knowledgePoints: number
}

export interface ModelSelectionSnapshot {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface RunSnapshot {
  runId: string
  documentId: string
  status: RunStatus
  stage: string
  revision: number
  retryCount: 0 | 1
  lastEventSeq: number
  modelSelection: ModelSelectionSnapshot
  counts: RunCounts
  error: null | { code: string; retryable: boolean }
  document: {
    filename: string
    mediaType: 'text/plain' | 'text/markdown'
    byteSize: number
    characterCount: number
    text: string
  }
}

export interface ImportTextInput {
  filename: string
  mediaType: 'text/plain' | 'text/markdown'
  text: string
}

export interface ImportTextRequest extends ImportTextInput {
  modelSelection: ModelSelectionSnapshot
}

export interface GenerationLaunch {
  runId: string
  attemptId: string
  revision: number
  modelSelection: ModelSelectionSnapshot
}

export interface RunEvent {
  seq: number
  type: string
  stage: string
  payload: Record<string, unknown>
}

export interface EventPage {
  events: RunEvent[]
  nextAfter: number
}

export interface EvidenceSpan {
  seq: number
  quote: string
  textStart: number
  textEnd: number
  contextBefore: string
  contextAfter: string
}

export interface CandidateSnapshot {
  candidateId: string
  type: KnowledgePointType
  title: string
  statement: string
  reviewStatus: 'pending' | 'accepted' | 'edited_and_accepted' | 'rejected'
  revision: number
  knowledgePointId: string | null
  evidence: EvidenceSpan[]
}

export interface KnowledgePointSnapshot {
  knowledgePointId: string
  type: KnowledgePointType
  title: string
  statement: string
  documentId: string
  evidence: EvidenceSpan[]
}

export type ReviewPayload =
  | { action: 'accept' | 'reject'; expectedRevision: number }
  | { action: 'edited_and_accept'; expectedRevision: number; title: string; statement: string }

export type ReviewCommand = ReviewPayload & { idempotencyKey: string }

export type ReviewActionDraft =
  | { action: 'accept' }
  | { action: 'reject' }
  | { action: 'edited_and_accept'; title: string; statement: string }

export interface ReviewResult {
  candidate: CandidateSnapshot
  run: RunSnapshot
  knowledgePoint: KnowledgePointSnapshot | null
}

export interface ClientApi {
  importText(input: ImportTextRequest, signal?: AbortSignal): Promise<GenerationLaunch>
  getRun(runId: string, signal?: AbortSignal): Promise<RunSnapshot>
  listEvents(runId: string, after: number, signal?: AbortSignal): Promise<EventPage>
  retryRun(runId: string, expectedRevision: number, signal?: AbortSignal): Promise<GenerationLaunch>
  listCandidates(runId: string, signal?: AbortSignal): Promise<{ candidates: CandidateSnapshot[] }>
  reviewCandidate(candidateId: string, input: ReviewCommand, signal?: AbortSignal): Promise<ReviewResult>
  listKnowledgePoints(runId: string, signal?: AbortSignal): Promise<{ knowledgePoints: KnowledgePointSnapshot[] }>
}
