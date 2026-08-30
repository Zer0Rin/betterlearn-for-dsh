import { describe, expect, test } from 'vitest'
import {
  clearPendingReview,
  createIdempotencyKey,
  readSessionState,
  reviewRequestDigest,
  sessionKey,
  writeSessionState,
} from '../src/client/session-state.js'

class MemoryStorage implements Storage {
  #items = new Map<string, string>()
  get length() { return this.#items.size }
  clear() { this.#items.clear() }
  getItem(key: string) { return this.#items.get(key) ?? null }
  key(index: number) { return [...this.#items.keys()][index] ?? null }
  removeItem(key: string) { this.#items.delete(key) }
  setItem(key: string, value: string) { this.#items.set(key, value) }
}

describe('phase1d session recovery state', () => {
  test('isolates records by DSH session ID', () => {
    const storage = new MemoryStorage()
    expect(sessionKey('session-a')).not.toBe(sessionKey('session-b'))
    writeSessionState(storage, 'session-a', { version: 1, runId: 'job_a', lastEventSeq: 3 })
    expect(readSessionState(storage, 'session-a').runId).toBe('job_a')
    expect(readSessionState(storage, 'session-b')).toEqual({ version: 1, lastEventSeq: 0 })
  })

  test('discards malformed JSON, versions and extra fields', () => {
    const storage = new MemoryStorage()
    for (const value of ['{', '{"version":2,"lastEventSeq":0}', '{"version":1,"lastEventSeq":0,"documentText":"secret"}']) {
      storage.setItem(sessionKey('session'), value)
      expect(readSessionState(storage, 'session')).toEqual({ version: 1, lastEventSeq: 0 })
    }
  })

  test('round-trips an edited pending review and clears only that command', async () => {
    const storage = new MemoryStorage()
    const request = {
      action: 'edited_and_accept' as const,
      expectedRevision: 2,
      title: '定稿标题',
      statement: '定稿陈述',
    }
    const pendingReview = {
      candidateId: 'cand_0123456789abcdefabcd',
      requestDigest: await reviewRequestDigest('cand_0123456789abcdefabcd', request),
      idempotencyKey: `idem_${'a'.repeat(20)}`,
      request,
    }
    writeSessionState(storage, 'session', {
      version: 1, runId: 'job_0123456789abcdefabcd', lastEventSeq: 8, pendingReview,
    })
    expect(readSessionState(storage, 'session')).toEqual({
      version: 1, runId: 'job_0123456789abcdefabcd', lastEventSeq: 8, pendingReview,
    })
    clearPendingReview(storage, 'session')
    expect(readSessionState(storage, 'session')).toEqual({
      version: 1, runId: 'job_0123456789abcdefabcd', lastEventSeq: 8,
    })
  })

  test('creates the stable digest from candidate and request values', async () => {
    const request = { action: 'accept' as const, expectedRevision: 1 }
    const first = await reviewRequestDigest('cand_a', request)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    await expect(reviewRequestDigest('cand_a', request)).resolves.toBe(first)
    await expect(reviewRequestDigest('cand_b', request)).resolves.not.toBe(first)
  })

  test('creates a 20-hex idempotency suffix from Web Crypto', () => {
    const fakeCrypto = {
      getRandomValues(array: Uint8Array) {
        array.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
        return array
      },
    } as Crypto
    expect(createIdempotencyKey(fakeCrypto)).toBe('idem_00010203040506070809')
    expect(createIdempotencyKey(fakeCrypto)).toMatch(/^idem_[0-9a-f]{20}$/)
  })
})
