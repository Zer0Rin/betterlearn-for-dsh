export type OpaqueId = string
export type CoreState =
  | 'STARTING'
  | 'READY'
  | 'RESTARTING'
  | 'DEGRADED'
  | 'DISPOSING'
  | 'DISPOSED'

export interface HelloParams {
  protocolVersion: 3
  schemaVersion: number
  schemaSha256: string
}

export interface HelloResult {
  protocolVersion: 3
  coreVersion: 'phase1e'
  databaseKind: 'sqlite'
  capabilities: ['l1-text-extraction', 'atomic-generation-commands', 'model-selection-snapshot']
  schemaVersion: number
  schemaSha256: string
  dataRootKind: 'isolated-phase1'
}

export interface ImportTextParams {
  filename: string
  mediaType: 'text/plain' | 'text/markdown'
  text: string
}

export interface ModelSelectionSnapshot {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ImportAndPrepareParams extends ImportTextParams {
  modelSelection: ModelSelectionSnapshot
}

export interface PreparedGeneration {
  runId: OpaqueId
  attemptId: OpaqueId
  attemptNumber: 1 | 2
  revision: number
  schemaVersion: number
  schemaSha256: string
  promptVersion: string
  document: { text: string; sha256: string }
  requestDigest: string
  providerIdempotencyKey: string
  modelSelection: ModelSelectionSnapshot
}

export interface RetryAndPrepareParams {
  runId: OpaqueId
  expectedRevision: number
}

export type GenerationFailureCode =
  | 'GENERATION_TIMEOUT'
  | 'GENERATION_SCHEMA_INVALID'
  | 'GENERATION_NO_OUTPUT'
  | 'GENERATION_PROVIDER_ERROR'

export interface SubmitGenerationParams {
  runId: OpaqueId
  attemptId: OpaqueId
  expectedRevision: number
  output: Record<string, unknown>
}

export interface FailGenerationParams {
  runId: OpaqueId
  attemptId: OpaqueId
  expectedRevision: number
  code: GenerationFailureCode
}

export interface RunParams { runId: OpaqueId }
export interface EventParams extends RunParams { after: number }

export interface ReviewCandidateParams {
  candidateId: OpaqueId
  action: 'accept' | 'edited_and_accept' | 'reject'
  expectedRevision: number
  idempotencyKey: string
  title?: string
  statement?: string
}

export interface CoreRunSnapshot extends Record<string, unknown> {
  runId: OpaqueId
  documentId: OpaqueId
  status: string
  stage: string
  revision: number
  retryCount: number
  lastEventSeq: number
}

export interface EventList extends Record<string, unknown> {
  events: Array<Record<string, unknown>>
  nextAfter: number
}

export interface CandidateList extends Record<string, unknown> {
  candidates: Array<Record<string, unknown>>
}

export interface KnowledgePointList extends Record<string, unknown> {
  knowledgePoints: Array<Record<string, unknown>>
}

export type CoreObjectResult = Record<string, unknown>
