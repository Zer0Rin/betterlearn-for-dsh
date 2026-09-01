import type { GenerationProgress } from '../generation-progress.js'
export type KnowledgePointType = 'concept' | 'process' | 'comparison' | 'formula' | 'fact' | 'code'
export type RunStatus =
  | 'generating'
  | 'validating'
  | 'review_pending'
  | 'completed'
  | 'failed_retryable'
  | 'failed_terminal'

export type RunHistoryStatus =
  | 'created'
  | 'document_ready'
  | 'awaiting_generation'
  | RunStatus

export interface RunHistorySummary {
  runId: string
  sourceType: 'document' | 'dsh_conversation'
  sourceLabel: string
  status: RunHistoryStatus
  stage: string
  updatedAt: string
  candidateCount: number
  knowledgePointCount: number
}

export interface RunHistoryResult {
  runs: RunHistorySummary[]
}

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
    mediaType:
      | 'text/plain'
      | 'text/markdown'
      | 'application/pdf'
      | 'application/vnd.betterlearn.dsh-conversation+markdown'
    byteSize: number
    characterCount: number
    text: string
  }
}

export interface ImportTextInput {
  filename: string
  mediaType: 'text/plain' | 'text/markdown' | 'application/pdf'
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

export interface DshConversationImportRequest {
  sessionIds: string[]
  expectedDigest: string
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

export interface KnowledgePointUpdateResult {
  knowledgePoint: KnowledgePointSnapshot
  run: RunSnapshot
}

export interface RunDeleteResult {
  runId: string
  deleted: true
}

export interface LearningCourseSyncRequest {
  clientBookId: string
  title: string
  knowledgePointIds: string[]
}

export interface LearningOption {
  optionId: string
  label: string
}

export interface LearningAssessmentAttempt {
  selectedOptionId: string
  correct: boolean
  submittedAt: string
}

export interface LearningAssessment {
  assessmentId: string
  kind: 'claim_choice' | 'evidence_choice'
  prompt: string
  options: LearningOption[]
  attempt: LearningAssessmentAttempt | null
}

export type LearningEvidence = {
  kind: 'quote'
  quote: string
  contextBefore: string
  contextAfter: string
  textStart: number
  textEnd: number
} | { kind: 'summary'; text: string }

export type LearningMasteryStatus =
  | 'new'
  | 'remediation_required'
  | 'learning'
  | 'mastered'
  | 'mastered_after_remediation'

export interface LearningUnit {
  unitId: string
  knowledgePointId: string
  type: KnowledgePointType
  title: string
  objective: string
  lesson: { explanation: string; workedExample: string; supplemental: string }
  evidence: LearningEvidence
  mastery: { status: LearningMasteryStatus; strength: number; dueAt: string | null }
  check: {
    main: LearningAssessment
    remediation: { title: string; body: string }
    retest: LearningAssessment
  }
}

export interface LearningCourse {
  courseId: string
  clientBookId: string
  title: string
  status: 'active' | 'archived'
  progress: { completed: number; total: number; mastery: number }
  units: LearningUnit[]
}

export interface LearningAttemptResult {
  attempt: {
    attemptId: string
    assessmentId: string
    selectedOptionId: string
    correct: boolean
    submittedAt: string
  }
  course: LearningCourse
}

export interface ExtractionPlan {
  strategy: 'L1' | 'L2' | 'L3'
  maxCalls: number
}

export interface DocumentPreviewTextInput {
  filename: string
  mediaType:
    | 'text/plain'
    | 'text/markdown'
    | 'application/pdf'
    | 'application/vnd.betterlearn.dsh-conversation+markdown'
  text: string
}

export type DocumentPreviewRequest = DocumentPreviewTextInput | {
  filename: string
  mediaType: 'application/pdf'
  contentBase64: string
}

export interface DocumentPreview extends DocumentPreviewTextInput {
  byteSize: number
  characterCount: number
  pages: Array<{ page: number; textStart: number; textEnd: number }>
  extractionPlan: ExtractionPlan
}

export interface DshConversationPreview {
  sessionIds: string[]
  filename: string
  mediaType: 'application/vnd.betterlearn.dsh-conversation+markdown'
  text: string
  contentDigest: string
  conversationCount: number
  messageCount: number
  byteSize: number
  characterCount: number
  extractionPlan: ExtractionPlan
}

export interface ClientApi {
  previewDocument?(input: DocumentPreviewRequest, signal?: AbortSignal): Promise<DocumentPreview>
  previewDshConversations(sessionIds: string[], signal?: AbortSignal): Promise<DshConversationPreview>
  watchRun?(runId: string, onChange: () => void, onProgress?: (progress: GenerationProgress) => void): () => void
  getProgress?(runId: string, signal?: AbortSignal): Promise<GenerationProgress | null>
  listRuns(signal?: AbortSignal): Promise<RunHistoryResult>
  importText(input: ImportTextRequest, signal?: AbortSignal): Promise<GenerationLaunch>
  importDshConversations(input: DshConversationImportRequest, signal?: AbortSignal): Promise<GenerationLaunch>
  getRun(runId: string, signal?: AbortSignal): Promise<RunSnapshot>
  listEvents(runId: string, after: number, signal?: AbortSignal): Promise<EventPage>
  retryRun(runId: string, expectedRevision: number, signal?: AbortSignal): Promise<GenerationLaunch>
  listCandidates(runId: string, signal?: AbortSignal): Promise<{ candidates: CandidateSnapshot[] }>
  reviewCandidate(candidateId: string, input: ReviewCommand, signal?: AbortSignal): Promise<ReviewResult>
  listKnowledgePoints(runId: string, signal?: AbortSignal): Promise<{ knowledgePoints: KnowledgePointSnapshot[] }>
  updateKnowledgePoint(knowledgePointId: string, input: { title: string; statement: string }, signal?: AbortSignal): Promise<KnowledgePointUpdateResult>
  deleteRun(runId: string, signal?: AbortSignal): Promise<RunDeleteResult>
  syncLearningCourse(input: LearningCourseSyncRequest, signal?: AbortSignal): Promise<LearningCourse>
  getLearningCourse(courseId: string, signal?: AbortSignal): Promise<LearningCourse>
  submitLearningAttempt(
    assessmentId: string,
    input: { optionId: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<LearningAttemptResult>
}
