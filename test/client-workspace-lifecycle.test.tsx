import { useModelSelectionInput } from './helpers/model-selection.js'
import { useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, test, vi } from 'vitest'
import { ProductApiError } from '../src/client/client-api.js'
import type { PollScheduler } from '../src/client/poll-run.js'
import { readSessionState, reviewRequestDigest, writeSessionState } from '../src/client/session-state.js'
import type { WorkspaceController } from '../src/client/use-nobei-workspace.js'
import { useNobeiWorkspace } from '../src/client/use-nobei-workspace.js'
import type { CandidateSnapshot, ClientApi, EventPage, ReviewResult, RunSnapshot, RunStatus } from '../src/client/types.js'
import type { ModelDirectoryResolverPort } from '../src/client/model-directory-bridge.js'

const modelSelection = { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' }

function modelDirectories(selection = modelSelection): ModelDirectoryResolverPort {
  return { directoryFor: vi.fn(() => ({ load: vi.fn(async () => ({ current: selection, routable: true })) })) }
}

class MemoryStorage implements Storage {
  #items = new Map<string, string>()
  get length() { return this.#items.size }
  clear() { this.#items.clear() }
  getItem(key: string) { return this.#items.get(key) ?? null }
  key(index: number) { return [...this.#items.keys()][index] ?? null }
  removeItem(key: string) { this.#items.delete(key) }
  setItem(key: string, value: string) { this.#items.set(key, value) }
}

function snapshot(status: RunStatus, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: 'job_0123456789abcdefabcd', documentId: 'doc_1', status, stage: 'extract',
    revision: 2, retryCount: status === 'failed_terminal' ? 1 : 0, lastEventSeq: 2,
    modelSelection,
    counts: { rawCandidates: 0, validCandidates: 0, pending: 0, accepted: 0,
      editedAndAccepted: 0, rejected: 0, knowledgePoints: 0 },
    error: status.startsWith('failed') ? { code: 'GENERATION_PROVIDER_ERROR', retryable: status === 'failed_retryable' } : null,
    document: { filename: '教材.md', mediaType: 'text/markdown', byteSize: 6, characterCount: 2, text: '正文' },
    ...overrides,
  }
}

function eventPage(after = 0): EventPage { return { events: [], nextAfter: after } }

function candidate(id = 'cand_0123456789abcdefabcd', status: CandidateSnapshot['reviewStatus'] = 'pending'): CandidateSnapshot {
  return { candidateId: id, type: 'concept', title: '原始标题', statement: '原始陈述',
    reviewStatus: status, revision: 1, knowledgePointId: status === 'accepted' ? 'kp_1' : null,
    evidence: [{ seq: 0, quote: '正文', textStart: 0, textEnd: 2, contextBefore: '', contextAfter: '' }] }
}

function fakeApi(overrides: Partial<ClientApi> = {}): ClientApi {
  return {
    listRuns: vi.fn(async () => ({ runs: [] })),
    importText: vi.fn(), getRun: vi.fn(), listEvents: vi.fn(), retryRun: vi.fn(),
    listCandidates: vi.fn(async () => ({ candidates: [] })),
    reviewCandidate: vi.fn(), listKnowledgePoints: vi.fn(async () => ({ knowledgePoints: [] })),
    updateKnowledgePoint: vi.fn(),
    deleteRun: vi.fn(),
    ...overrides,
  } as ClientApi
}

const scheduler: PollScheduler = {
  async sleep(_ms, signal) { await new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  }) },
  isVisible: () => true,
  async waitUntilVisible() {},
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function mount(
  api: ClientApi,
  storage: Storage,
  sessionId = 'session-1',
  directories: ModelDirectoryResolverPort = modelDirectories(),
  ordinarySession = true,
) {
  let latest!: WorkspaceController
  const screens: WorkspaceController['screen'][] = []
  function Harness() {
    latest = useNobeiWorkspace({
      sessionId, api, storage, scheduler, ...useModelSelectionInput(directories, sessionId, ordinarySession),
    })
    useEffect(() => { screens.push(latest.screen) }, [latest.screen])
    return null
  }
  let renderer!: ReactTestRenderer
  act(() => { renderer = create(<Harness />) })
  return { renderer, screens, get latest() { return latest } }
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

describe('phase1d workspace lifecycle', () => {
  test('launches one DSH conversation import with the current model and adopts its run', async () => {
    const storage = new MemoryStorage()
    const api = fakeApi({
      importDshConversations: vi.fn(async () => ({
        runId: 'job_0123456789abcdefabcd', attemptId: 'attempt_1', revision: 2,
        modelSelection,
      })),
      getRun: vi.fn(() => new Promise<RunSnapshot>(() => undefined)),
      listEvents: vi.fn(() => new Promise<EventPage>(() => undefined)),
    })
    const app = mount(api, storage)
    await flush()

    let succeeded!: boolean
    await act(async () => {
      succeeded = await app.latest.importDshConversations({
        sessionIds: ['session-a', 'session-b'],
        expectedDigest: 'd'.repeat(64),
      })
    })

    expect(succeeded).toBe(true)
    expect(api.importDshConversations).toHaveBeenCalledOnce()
    expect(api.importDshConversations).toHaveBeenCalledWith({
      sessionIds: ['session-a', 'session-b'],
      expectedDigest: 'd'.repeat(64),
      modelSelection,
    }, expect.any(AbortSignal))
    expect(api.importText).not.toHaveBeenCalled()
    expect(app.latest.screen).toBe('processing')
    expect(readSessionState(storage, 'session-1').runId).toBe('job_0123456789abcdefabcd')
    act(() => app.renderer.unmount())
  })

  test('deletes a non-current run without changing the open workspace', async () => {
    const storage = new MemoryStorage()
    writeSessionState(storage, 'session-1', { version: 1, runId: 'job_current', lastEventSeq: 0 })
    const api = fakeApi({
      getRun: vi.fn(async () => snapshot('generating', { runId: 'job_current' })),
      listEvents: vi.fn(async () => eventPage()),
      deleteRun: vi.fn(async runId => ({ runId, deleted: true })),
    })
    const app = mount(api, storage)
    await flush()
    await act(async () => { expect(await app.latest.deleteRun('job_other')).toBe(true) })
    expect(app.latest.currentRunId).toBe('job_current')
    expect(app.latest.screen).toBe('processing')
    expect(readSessionState(storage, 'session-1').runId).toBe('job_current')
    act(() => app.renderer.unmount())
  })

  test('clears the current workspace only after deletion succeeds', async () => {
    const storage = new MemoryStorage()
    writeSessionState(storage, 'session-1', { version: 1, runId: 'job_current', lastEventSeq: 0 })
    const deleteRun = vi.fn()
      .mockRejectedValueOnce(new ProductApiError(503, 'CORE_UNAVAILABLE'))
      .mockResolvedValueOnce({ runId: 'job_current', deleted: true })
    const api = fakeApi({
      getRun: vi.fn(async () => snapshot('generating', { runId: 'job_current' })),
      listEvents: vi.fn(async () => eventPage()),
      deleteRun,
    })
    const app = mount(api, storage)
    await flush()
    await act(async () => { expect(await app.latest.deleteRun('job_current')).toBe(false) })
    expect(app.latest.currentRunId).toBe('job_current')
    expect(readSessionState(storage, 'session-1').runId).toBe('job_current')

    await act(async () => { expect(await app.latest.deleteRun('job_current')).toBe(true) })
    expect(app.latest.currentRunId).toBeUndefined()
    expect(app.latest.screen).toBe('import')
    expect(readSessionState(storage, 'session-1').runId).toBeUndefined()
    act(() => app.renderer.unmount())
  })
  test('replaces the saved knowledge point and run snapshot after an edit', async () => {
    const storage = new MemoryStorage()
    writeSessionState(storage, 'session-1', { version: 1, runId: 'job_saved', lastEventSeq: 0 })
    const original = { knowledgePointId: 'kp_0123456789abcdefabcd', type: 'concept' as const,
      title: '原始标题', statement: '原始陈述', documentId: 'doc_1', evidence: [] }
    const updatedRun = snapshot('completed', { runId: 'job_saved', revision: 4,
      counts: { rawCandidates: 1, validCandidates: 1, pending: 0, accepted: 0,
        editedAndAccepted: 1, rejected: 0, knowledgePoints: 1 } })
    const api = fakeApi({
      getRun: vi.fn(async () => snapshot('completed', { runId: 'job_saved' })),
      listEvents: vi.fn(async () => eventPage()),
      listKnowledgePoints: vi.fn(async () => ({ knowledgePoints: [original] })),
      updateKnowledgePoint: vi.fn(async () => ({ knowledgePoint: { ...original, title: '新标题', statement: '新陈述' }, run: updatedRun })),
    })
    const app = mount(api, storage)
    await flush()

    let saved = false
    await act(async () => { saved = await app.latest.updateKnowledgePoint(original, { title: '新标题', statement: '新陈述' }) })

    expect(saved).toBe(true)
    expect(api.updateKnowledgePoint).toHaveBeenCalledWith(original.knowledgePointId,
      { title: '新标题', statement: '新陈述' }, expect.any(AbortSignal))
    expect(app.latest.knowledgePoints[0]).toMatchObject({ title: '新标题', statement: '新陈述' })
    expect(app.latest.run).toEqual(updatedRun)
    act(() => app.renderer.unmount())
  })
  test('switches the current pointer and polling to a selected historical run', async () => {
    const storage = new MemoryStorage()
    writeSessionState(storage, 'session-1', { version: 1, runId: 'job_old', lastEventSeq: 7 })
    const api = fakeApi({
      getRun: vi.fn(async id => snapshot(id === 'job_old' ? 'generating' : 'completed', { runId: id })),
      listEvents: vi.fn(async (_id, after) => eventPage(after)),
    })
    const app = mount(api, storage)
    await flush()
    expect(app.latest.run?.runId).toBe('job_old')

    act(() => app.latest.openRun('job_new'))
    await flush()

    expect(readSessionState(storage, 'session-1')).toMatchObject({ runId: 'job_new', lastEventSeq: 0 })
    expect(api.getRun).toHaveBeenCalledWith('job_new', expect.any(AbortSignal))
    expect(api.listEvents).toHaveBeenCalledWith('job_new', 0, expect.any(AbortSignal))
    expect(app.latest.currentRunId).toBe('job_new')
    expect(app.latest.run?.runId).toBe('job_new')
    expect(app.latest.progress).toBeNull()
    expect(app.latest.screen).toBe('result')
    act(() => app.renderer.unmount())
  })

  test('enters review immediately on an SSE hint and releases the subscription', async () => {
    const storage = new MemoryStorage()
    writeSessionState(storage, 'session-1', { version: 1, runId: 'job_saved', lastEventSeq: 0 })
    let notify!: () => void
    const close = vi.fn()
    const api = fakeApi({
      watchRun: (_id, listener) => { notify = listener; return close },
      getRun: vi.fn().mockResolvedValueOnce(snapshot('generating'))
        .mockResolvedValueOnce(snapshot('review_pending')),
      listEvents: vi.fn(async () => eventPage(0)),
      listCandidates: vi.fn(async () => ({ candidates: [candidate()] })),
    })
    const app = mount(api, storage)
    await flush()
    expect(app.latest.screen).toBe('processing')
    await act(async () => notify())
    await flush()
    expect(app.latest.screen).toBe('review')
    expect(app.latest.candidates).toHaveLength(1)
    expect(api.getRun).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledOnce()
    act(() => app.renderer.unmount())
  })

  test('uses the latest subscribed model for import without reloading the directory during submit', async () => {
    const oldSelection = { provider: 'provider-old', model: 'model-old' }
    const freshSelection = { provider: 'provider-new', model: 'model-new', reasoningEffort: 'high' }
    let state = { current: oldSelection, routable: true, status: 'ready' as const }
    const listeners = new Set<() => void>()
    const load = vi.fn(async () => ({ current: oldSelection, routable: true }))
    const directories = { directoryFor: vi.fn(() => ({
      load,
      store: {
        getSnapshot: () => state,
        subscribe(listener: () => void) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    })) }
    const api = fakeApi({
      importText: vi.fn(async () => ({
        runId: 'job_0123456789abcdefabcd', attemptId: 'attempt_1', revision: 2,
        modelSelection: freshSelection,
      })),
      getRun: vi.fn(() => new Promise<RunSnapshot>(() => undefined)),
      listEvents: vi.fn(() => new Promise<EventPage>(() => undefined)),
    })
    const app = mount(api, new MemoryStorage(), 'session-1', directories)
    await flush()
    await act(async () => {
      state = { current: freshSelection, routable: true, status: 'ready' }
      listeners.forEach(listener => listener())
    })
    await act(async () => app.latest.importText({
      filename: '教材.md', mediaType: 'text/markdown', text: '不能丢失的正文',
    }))
    expect(load).not.toHaveBeenCalled()
    expect(api.importText).toHaveBeenCalledWith({
      filename: '教材.md', mediaType: 'text/markdown', text: '不能丢失的正文',
      modelSelection: freshSelection,
    }, expect.any(AbortSignal))
    act(() => app.renderer.unmount())
  })

  test('saves a launched run immediately and starts one poller', async () => {
    const runResult = deferred<RunSnapshot>()
    const storage = new MemoryStorage()
    const api = fakeApi({
      importText: vi.fn(async () => ({ runId: 'job_0123456789abcdefabcd', attemptId: 'attempt_1', revision: 2 })),
      getRun: vi.fn(() => runResult.promise),
      listEvents: vi.fn(() => new Promise<EventPage>(() => undefined)),
    })
    const app = mount(api, storage)
    await act(async () => app.latest.importText({ filename: '教材.md', mediaType: 'text/markdown', text: '正文' }))
    expect(app.latest.screen).toBe('processing')
    expect(readSessionState(storage, 'session-1')).toMatchObject({
      runId: 'job_0123456789abcdefabcd', lastEventSeq: 0,
    })
    expect(api.getRun).toHaveBeenCalledTimes(1)
    app.renderer.unmount()
  })

  test('reports a failed import outcome without creating session state', async () => {
    const storage = new MemoryStorage()
    const api = fakeApi({
      importText: vi.fn(async () => { throw new ProductApiError(503, 'CORE_UNAVAILABLE') }),
    })
    const app = mount(api, storage)
    let succeeded!: boolean
    await act(async () => {
      succeeded = await app.latest.importText({ filename: '教材.md', mediaType: 'text/markdown', text: '正文' })
    })
    expect(succeeded).toBe(false)
    expect(app.latest.serviceUnavailable).toBe(true)
    expect(readSessionState(storage, 'session-1').runId).toBeUndefined()
    act(() => app.renderer.unmount())
  })

  test('a remounted conversation view adopts one in-flight import instead of creating a duplicate run', async () => {
    const launch = deferred<Awaited<ReturnType<ClientApi['importText']>>>()
    const storage = new MemoryStorage()
    const api = fakeApi({
      importText: vi.fn(() => launch.promise),
      getRun: vi.fn(() => new Promise<RunSnapshot>(() => undefined)),
      listEvents: vi.fn(() => new Promise<EventPage>(() => undefined)),
    })
    const first = mount(api, storage)
    await flush()
    let submitted!: Promise<boolean>
    act(() => {
      submitted = first.latest.importText({ filename: '教材.md', mediaType: 'text/markdown', text: '正文' })
    })
    act(() => first.renderer.unmount())

    const second = mount(api, storage)
    await flush()
    launch.resolve({
      runId: 'job_0123456789abcdefabcd', attemptId: 'attempt_1', revision: 2,
      modelSelection,
    })
    await act(async () => { await submitted; await new Promise(resolve => setTimeout(resolve, 120)) })

    expect(api.importText).toHaveBeenCalledOnce()
    expect(readSessionState(storage, 'session-1').runId).toBe('job_0123456789abcdefabcd')
    expect(second.latest.screen).toBe('processing')
    act(() => second.renderer.unmount())
  })

  test('commits processing before an immediately available review result', async () => {
    const storage = new MemoryStorage()
    const api = fakeApi({
      importText: vi.fn(async () => ({ runId: 'job_0123456789abcdefabcd', attemptId: 'attempt_1', revision: 2 })),
      getRun: vi.fn(async () => snapshot('review_pending')),
      listEvents: vi.fn(async () => eventPage(0)),
      listCandidates: vi.fn(async () => ({ candidates: [candidate()] })),
    })
    const app = mount(api, storage)
    await act(async () => app.latest.importText({ filename: '教材.md', mediaType: 'text/markdown', text: '正文' }))
    await flush()
    expect(app.screens).toEqual(['import', 'processing', 'review'])
    app.renderer.unmount()
  })

  test('defers the first import poll until the next browser task', async () => {
    vi.useFakeTimers()
    try {
      const storage = new MemoryStorage()
      const api = fakeApi({
        importText: vi.fn(async () => ({ runId: 'job_0123456789abcdefabcd', attemptId: 'attempt_1', revision: 2 })),
        getRun: vi.fn(async () => snapshot('review_pending')),
        listEvents: vi.fn(async () => eventPage(0)),
        listCandidates: vi.fn(async () => ({ candidates: [candidate()] })),
      })
      const app = mount(api, storage)
      let command!: Promise<void>
      act(() => { command = app.latest.importText({ filename: '教材.md', mediaType: 'text/markdown', text: '正文' }) })
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(app.latest.screen).toBe('processing')
      expect(api.getRun).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(99) })
      expect(api.getRun).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(1); await command })
      expect(api.getRun).toHaveBeenCalledOnce()
      app.renderer.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  test('keeps a rejected import on the import screen without saving a run', async () => {
    const storage = new MemoryStorage()
    const api = fakeApi({ importText: vi.fn(async () => { throw new Error('failed') }) })
    const app = mount(api, storage)
    await act(async () => app.latest.importText({ filename: '教材.md', mediaType: 'text/markdown', text: '正文' }))
    expect(app.latest.screen).toBe('import')
    expect(readSessionState(storage, 'session-1').runId).toBeUndefined()
  })

  test('resumes the exact saved cursor and aborts it on unmount', () => {
    const storage = new MemoryStorage()
    writeSessionState(storage, 'session-1', { version: 1, runId: 'job_saved', lastEventSeq: 7 })
    let observedSignal!: AbortSignal
    const api = fakeApi({
      getRun: vi.fn((_id, signal) => { observedSignal = signal!; return new Promise<RunSnapshot>(() => undefined) }),
      listEvents: vi.fn(() => new Promise<EventPage>(() => undefined)),
    })
    const app = mount(api, storage)
    expect(api.listEvents).toHaveBeenCalledWith('job_saved', 7, expect.any(AbortSignal))
    expect(observedSignal.aborted).toBe(false)
    act(() => app.renderer.unmount())
    expect(observedSignal.aborted).toBe(true)
  })

  test.each([
    ['review_pending', 'review'],
    ['completed', 'result'],
  ] as const)('routes %s from Core to the %s screen', async (status, screen) => {
    const storage = new MemoryStorage()
    writeSessionState(storage, 'session-1', { version: 1, runId: 'job_saved', lastEventSeq: 0 })
    const api = fakeApi({
      getRun: vi.fn(async () => snapshot(status, { runId: 'job_saved' })),
      listEvents: vi.fn(async () => eventPage(0)),
      listCandidates: vi.fn(async () => ({ candidates: [] })),
      listKnowledgePoints: vi.fn(async () => ({ knowledgePoints: [] })),
    })
    const app = mount(api, storage)
    await flush()
    expect(app.latest.screen).toBe(screen)
    expect(api.listCandidates).toHaveBeenCalledWith('job_saved', expect.any(AbortSignal))
    if (status === 'completed') expect(api.listKnowledgePoints).toHaveBeenCalled()
    act(() => app.renderer.unmount())
  })

  test('preserves navigation when the Core is temporarily unavailable and reloads it', async () => {
    const storage = new MemoryStorage()
    writeSessionState(storage, 'session-1', { version: 1, runId: 'job_saved', lastEventSeq: 4 })
    const api = fakeApi({
      getRun: vi.fn()
        .mockRejectedValueOnce(new ProductApiError(503, 'CORE_UNAVAILABLE'))
        .mockResolvedValueOnce(snapshot('completed')),
      listEvents: vi.fn().mockResolvedValue(eventPage(4)),
    })
    const app = mount(api, storage)
    await flush()
    expect(app.latest.serviceUnavailable).toBe(true)
    expect(readSessionState(storage, 'session-1').runId).toBe('job_saved')
    await act(async () => app.latest.reload())
    await flush()
    expect(app.latest.serviceUnavailable).toBe(false)
    expect(app.latest.screen).toBe('result')
  })

  test('retries once with the current revision and keeps the same run ID', async () => {
    const storage = new MemoryStorage()
    writeSessionState(storage, 'session-1', { version: 1, runId: 'job_saved', lastEventSeq: 2 })
    const nextRun = deferred<RunSnapshot>()
    const api = fakeApi({
      getRun: vi.fn()
        .mockResolvedValueOnce(snapshot('failed_retryable', { runId: 'job_saved', revision: 5 }))
        .mockImplementation(() => nextRun.promise),
      listEvents: vi.fn(async (_id, after) => eventPage(after)),
      retryRun: vi.fn(async () => ({ runId: 'job_saved', attemptId: 'attempt_2', revision: 6 })),
    })
    const app = mount(api, storage)
    await flush()
    await act(async () => app.latest.retry())
    expect(api.retryRun).toHaveBeenCalledTimes(1)
    expect(api.retryRun).toHaveBeenCalledWith('job_saved', 5, expect.any(AbortSignal))
    expect(app.latest.screen).toBe('processing')
    expect(readSessionState(storage, 'session-1').runId).toBe('job_saved')
    act(() => app.renderer.unmount())
  })

  test('persists one exact review command before sending and clears it after confirmation', async () => {
    const storage = new MemoryStorage()
    writeSessionState(storage, 'session-1', { version: 1, runId: 'job_saved', lastEventSeq: 0 })
    const first = candidate('cand_0123456789abcdefabcd')
    const second = candidate('cand_bbbbbbbbbbbbbbbbbbbb')
    const accepted = { ...first, reviewStatus: 'edited_and_accepted' as const, revision: 2, title: '定稿标题', statement: '定稿陈述' }
    const response = deferred<ReviewResult>()
    const api = fakeApi({
      getRun: vi.fn(async () => snapshot('review_pending', { runId: 'job_saved' })),
      listEvents: vi.fn(async () => eventPage(0)),
      listCandidates: vi.fn()
        .mockResolvedValueOnce({ candidates: [first, second] })
        .mockResolvedValueOnce({ candidates: [accepted, second] }),
      reviewCandidate: vi.fn(() => response.promise),
    })
    const app = mount(api, storage)
    await flush()
    let command!: Promise<void>
    act(() => {
      command = app.latest.review(first, {
        action: 'edited_and_accept', title: '定稿标题', statement: '定稿陈述',
      })
    })
    await vi.waitFor(() => expect(api.reviewCandidate).toHaveBeenCalledTimes(1))
    const pending = readSessionState(storage, 'session-1').pendingReview
    expect(pending).toMatchObject({
      candidateId: first.candidateId,
      request: { action: 'edited_and_accept', expectedRevision: 1, title: '定稿标题', statement: '定稿陈述' },
    })
    expect(pending?.idempotencyKey).toMatch(/^idem_[0-9a-f]{20}$/)
    expect(api.reviewCandidate).toHaveBeenCalledWith(first.candidateId, {
      ...pending?.request, idempotencyKey: pending?.idempotencyKey,
    }, expect.any(AbortSignal))
    act(() => { void app.latest.review(first, { action: 'accept' }) })
    expect(api.reviewCandidate).toHaveBeenCalledTimes(1)
    response.resolve({ candidate: accepted, run: snapshot('review_pending', { runId: 'job_saved' }), knowledgePoint: null })
    await act(async () => command)
    expect(readSessionState(storage, 'session-1').pendingReview).toBeUndefined()
    expect(app.latest.activeCandidateId).toBe(second.candidateId)
    act(() => app.renderer.unmount())
  })

  test('reports a failed review outcome and keeps the current candidate selected', async () => {
    const storage = new MemoryStorage()
    writeSessionState(storage, 'session-1', { version: 1, runId: 'job_saved', lastEventSeq: 0 })
    const first = candidate('cand_0123456789abcdefabcd')
    const second = candidate('cand_bbbbbbbbbbbbbbbbbbbb')
    const api = fakeApi({
      getRun: vi.fn(async () => snapshot('review_pending', { runId: 'job_saved' })),
      listEvents: vi.fn(async () => eventPage(0)),
      listCandidates: vi.fn(async () => ({ candidates: [first, second] })),
      reviewCandidate: vi.fn(async () => { throw new ProductApiError(503, 'CORE_UNAVAILABLE') }),
    })
    const app = mount(api, storage)
    await flush()
    let succeeded!: boolean
    await act(async () => { succeeded = await app.latest.review(first, { action: 'accept' }) })
    expect(succeeded).toBe(false)
    expect(app.latest.activeCandidateId).toBe(first.candidateId)
    expect(app.latest.serviceUnavailable).toBe(true)
    act(() => app.renderer.unmount())
  })

  test('replays the stored pending review with its original key after refresh', async () => {
    const storage = new MemoryStorage()
    const first = candidate()
    const request = { action: 'accept' as const, expectedRevision: 1 }
    const pendingReview = {
      candidateId: first.candidateId,
      request,
      requestDigest: await reviewRequestDigest(first.candidateId, request),
      idempotencyKey: `idem_${'c'.repeat(20)}`,
    }
    writeSessionState(storage, 'session-1', {
      version: 1, runId: 'job_saved', lastEventSeq: 0, pendingReview,
    })
    const accepted = { ...first, reviewStatus: 'accepted' as const, revision: 2, knowledgePointId: 'kp_1' }
    const api = fakeApi({
      getRun: vi.fn(async () => snapshot('review_pending', { runId: 'job_saved' })),
      listEvents: vi.fn(async () => eventPage(0)),
      listCandidates: vi.fn()
        .mockResolvedValueOnce({ candidates: [first] })
        .mockResolvedValueOnce({ candidates: [accepted] }),
      reviewCandidate: vi.fn(async () => ({
        candidate: accepted, run: snapshot('completed', { runId: 'job_saved' }), knowledgePoint: null,
      })),
    })
    const app = mount(api, storage)
    await vi.waitFor(() => expect(api.reviewCandidate).toHaveBeenCalledTimes(1))
    expect(api.reviewCandidate).toHaveBeenCalledWith(first.candidateId, {
      ...request, idempotencyKey: pendingReview.idempotencyKey,
    }, expect.any(AbortSignal))
    expect(readSessionState(storage, 'session-1').pendingReview).toBeUndefined()
    act(() => app.renderer.unmount())
  })

  test('rereads Core state after a review conflict instead of showing optimistic success', async () => {
    const storage = new MemoryStorage()
    writeSessionState(storage, 'session-1', { version: 1, runId: 'job_saved', lastEventSeq: 0 })
    const first = candidate()
    const accepted = { ...first, reviewStatus: 'accepted' as const, revision: 2, knowledgePointId: 'kp_1' }
    const api = fakeApi({
      getRun: vi.fn(async () => snapshot('review_pending', { runId: 'job_saved' })),
      listEvents: vi.fn(async () => eventPage(0)),
      listCandidates: vi.fn()
        .mockResolvedValueOnce({ candidates: [first] })
        .mockResolvedValueOnce({ candidates: [accepted] }),
      reviewCandidate: vi.fn(async () => { throw new ProductApiError(409, 'REVISION_CONFLICT') }),
    })
    const app = mount(api, storage)
    await flush()
    await act(async () => app.latest.review(first, { action: 'accept' }))
    expect(api.getRun).toHaveBeenCalledTimes(2)
    expect(api.listCandidates).toHaveBeenCalledTimes(2)
    expect(app.latest.candidates[0]?.reviewStatus).toBe('accepted')
    expect(app.latest.message).toContain('候选状态已变化')
    expect(readSessionState(storage, 'session-1').pendingReview).toBeUndefined()
    act(() => app.renderer.unmount())
  })
})

test.each([false, true])('model directory identity changes cannot restore old run after reset/import (store=%s)', async withStore => {
  const storage = new MemoryStorage()
  writeSessionState(storage, 'restore-session', { version: 1, runId: 'job_A', lastEventSeq: 0 })
  const api = fakeApi({
    getRun: vi.fn(async id => snapshot(id === 'job_A' ? 'completed' : 'review_pending', { runId: id })),
    listEvents: vi.fn(async () => eventPage()),
    importText: vi.fn(async () => ({ runId: 'job_B', attemptId: 'att_B', revision: 2, modelSelection })),
  })
  const newDirectories = (): ModelDirectoryResolverPort => {
    const state = { current: modelSelection, routable: true, status: 'ready' as const }
    return { directoryFor: () => ({
      load: async () => state,
      ...(withStore ? { store: { getSnapshot: () => state, subscribe: () => () => undefined } } : {}),
    }) }
  }
  let latest!: WorkspaceController
  function Harness({ directories }: { directories: ModelDirectoryResolverPort }) {
    latest = useNobeiWorkspace({ sessionId: 'restore-session', api, storage, scheduler,
      ...useModelSelectionInput(directories, 'restore-session', true) })
    return null
  }
  let renderer!: ReactTestRenderer
  act(() => { renderer = create(<Harness directories={newDirectories()} />) })
  try {
    await flush()
    expect(latest.run?.runId).toBe('job_A')
    expect(latest.screen).toBe('result')
    act(() => latest.reset())
    await flush()
    await act(async () => { await latest.importText({ filename: 'long.txt', mediaType: 'text/plain', text: 'new document' }) })
    await flush()
    expect(latest.run?.runId).toBe('job_B')
    expect(readSessionState(storage, 'restore-session').runId).toBe('job_B')
    const requests = vi.mocked(api.getRun).mock.calls.length
    act(() => renderer.update(<Harness directories={newDirectories()} />))
    await flush()
    expect(latest.run?.runId).toBe('job_B')
    expect(latest.screen).toBe('review')
    expect(readSessionState(storage, 'restore-session').runId).toBe('job_B')
    expect(api.getRun).toHaveBeenCalledTimes(requests)
  } finally { act(() => renderer.unmount()) }
})

test('model directory refresh does not abort an in-flight retry command', async () => {
  const storage = new MemoryStorage()
  writeSessionState(storage, 'retry-session', { version: 1, runId: 'job_B', lastEventSeq: 0 })
  const launch = deferred<Awaited<ReturnType<ClientApi['retryRun']>>>()
  const api = fakeApi({
    getRun: vi.fn(async () => snapshot('failed_retryable', { runId: 'job_B' })),
    listEvents: vi.fn(async () => eventPage()),
    retryRun: vi.fn(() => launch.promise),
  })
  let latest!: WorkspaceController
  function Harness({ directories }: { directories: ModelDirectoryResolverPort }) {
    latest = useNobeiWorkspace({ sessionId: 'retry-session', api, storage, scheduler,
      ...useModelSelectionInput(directories, 'retry-session', true) })
    return null
  }
  let renderer!: ReactTestRenderer
  act(() => { renderer = create(<Harness directories={modelDirectories()} />) })
  try {
    await flush()
    let retry!: Promise<void>
    act(() => { retry = latest.retry() })
    const signal = vi.mocked(api.retryRun).mock.calls[0][2]!
    act(() => renderer.update(<Harness directories={modelDirectories()} />))
    await flush()
    expect(signal.aborted).toBe(false)
    expect(api.getRun).toHaveBeenCalledTimes(1)
    await act(async () => {
      launch.resolve({ runId: 'job_B', attemptId: 'att_2', revision: 5 })
      await retry
    })
    expect(latest.busy).toBe(false)
    expect(readSessionState(storage, 'retry-session').runId).toBe('job_B')
    expect(api.retryRun).toHaveBeenCalledTimes(1)
  } finally { act(() => renderer.unmount()) }
})
