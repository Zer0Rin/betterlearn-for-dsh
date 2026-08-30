import type { ReviewPayload } from './types.js'

export interface SessionRecord {
  version: 1
  runId?: string
  lastEventSeq: number
  pendingReview?: {
    candidateId: string
    requestDigest: string
    idempotencyKey: string
    request: ReviewPayload
  }
}

const EMPTY_SESSION: SessionRecord = { version: 1, lastEventSeq: 0 }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted()
  return actual.length === allowed.length
    && actual.every((key, index) => key === allowed.toSorted()[index])
}

function parseReviewPayload(value: unknown): ReviewPayload | undefined {
  if (!record(value) || typeof value.action !== 'string') return undefined
  if (value.action === 'accept' || value.action === 'reject') {
    if (!exactKeys(value, ['action', 'expectedRevision'])) return undefined
    if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1) return undefined
    return { action: value.action, expectedRevision: value.expectedRevision as number }
  }
  if (value.action === 'edited_and_accept') {
    if (!exactKeys(value, ['action', 'expectedRevision', 'title', 'statement'])) return undefined
    if (
      !Number.isSafeInteger(value.expectedRevision)
      || (value.expectedRevision as number) < 1
      || typeof value.title !== 'string'
      || typeof value.statement !== 'string'
    ) return undefined
    return {
      action: value.action,
      expectedRevision: value.expectedRevision as number,
      title: value.title,
      statement: value.statement,
    }
  }
  return undefined
}

function parsePendingReview(value: unknown): SessionRecord['pendingReview'] | undefined {
  if (!record(value) || !exactKeys(value, [
    'candidateId', 'requestDigest', 'idempotencyKey', 'request',
  ])) return undefined
  const request = parseReviewPayload(value.request)
  if (
    typeof value.candidateId !== 'string'
    || !/^[0-9a-f]{64}$/.test(String(value.requestDigest))
    || !/^idem_[0-9a-f]{20}$/.test(String(value.idempotencyKey))
    || request === undefined
  ) return undefined
  return {
    candidateId: value.candidateId,
    requestDigest: value.requestDigest as string,
    idempotencyKey: value.idempotencyKey as string,
    request,
  }
}

export function sessionKey(sessionId: string): string {
  return `nobei:phase1d:session:${encodeURIComponent(sessionId)}`
}

export function readSessionState(storage: Storage, sessionId: string): SessionRecord {
  const raw = storage.getItem(sessionKey(sessionId))
  if (raw === null) return { ...EMPTY_SESSION }
  try {
    const value: unknown = JSON.parse(raw)
    if (!record(value)) return { ...EMPTY_SESSION }
    const allowed = ['version', 'lastEventSeq']
    if (value.runId !== undefined) allowed.push('runId')
    if (value.pendingReview !== undefined) allowed.push('pendingReview')
    if (
      !exactKeys(value, allowed)
      || value.version !== 1
      || !Number.isSafeInteger(value.lastEventSeq)
      || (value.lastEventSeq as number) < 0
      || (value.runId !== undefined && typeof value.runId !== 'string')
    ) return { ...EMPTY_SESSION }
    const pendingReview = value.pendingReview === undefined
      ? undefined
      : parsePendingReview(value.pendingReview)
    if (value.pendingReview !== undefined && pendingReview === undefined) return { ...EMPTY_SESSION }
    return {
      version: 1,
      ...(value.runId === undefined ? {} : { runId: value.runId }),
      lastEventSeq: value.lastEventSeq as number,
      ...(pendingReview === undefined ? {} : { pendingReview }),
    }
  } catch {
    return { ...EMPTY_SESSION }
  }
}

export function writeSessionState(storage: Storage, sessionId: string, value: SessionRecord): void {
  const closed: SessionRecord = {
    version: 1,
    ...(value.runId === undefined ? {} : { runId: value.runId }),
    lastEventSeq: value.lastEventSeq,
    ...(value.pendingReview === undefined ? {} : { pendingReview: value.pendingReview }),
  }
  storage.setItem(sessionKey(sessionId), JSON.stringify(closed))
}

export function clearPendingReview(storage: Storage, sessionId: string): void {
  const current = readSessionState(storage, sessionId)
  writeSessionState(storage, sessionId, {
    version: 1,
    ...(current.runId === undefined ? {} : { runId: current.runId }),
    lastEventSeq: current.lastEventSeq,
  })
}

function canonicalRequest(request: ReviewPayload): ReviewPayload {
  return request.action === 'edited_and_accept'
    ? {
        action: request.action,
        expectedRevision: request.expectedRevision,
        title: request.title,
        statement: request.statement,
      }
    : { action: request.action, expectedRevision: request.expectedRevision }
}

export async function reviewRequestDigest(candidateId: string, request: ReviewPayload): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    candidateId,
    request: canonicalRequest(request),
  }))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function createIdempotencyKey(crypto: Crypto): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return `idem_${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}
