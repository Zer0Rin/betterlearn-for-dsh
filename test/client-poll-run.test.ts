import { describe, expect, test, vi } from 'vitest'
import { pollRun, type PollScheduler } from '../src/client/poll-run.js'
import type { ClientApi, EventPage, RunSnapshot, RunStatus } from '../src/client/types.js'

function snapshot(status: RunStatus = 'generating'): RunSnapshot {
  return {
    runId: 'job_1', documentId: 'doc_1', status, stage: 'extract', revision: 2,
    retryCount: 0, lastEventSeq: 0,
    counts: {
      rawCandidates: 0, validCandidates: 0, pending: 0, accepted: 0,
      editedAndAccepted: 0, rejected: 0, knowledgePoints: 0,
    },
    error: null,
    document: {
      filename: '教材.md', mediaType: 'text/markdown', byteSize: 6,
      characterCount: 2, text: '正文',
    },
  }
}

function page(after: number, seqs: number[] = []): EventPage {
  return {
    events: seqs.map(seq => ({ seq, type: `event.${seq}`, stage: 'extract', payload: {} })),
    nextAfter: seqs.at(-1) ?? after,
  }
}

function api(getRun: ClientApi['getRun'], listEvents: ClientApi['listEvents']): ClientApi {
  return {
    getRun,
    listEvents,
    importText: vi.fn(), retryRun: vi.fn(), listCandidates: vi.fn(),
    reviewCandidate: vi.fn(), listKnowledgePoints: vi.fn(),
  } as ClientApi
}

function scheduler(options: {
  abort?: AbortController
  abortAfterSleeps?: number
  visible?: boolean
} = {}): PollScheduler & { delays: number[]; waits: number } {
  let visible = options.visible ?? true
  const result = {
    delays: [] as number[],
    waits: 0,
    isVisible: () => visible,
    async waitUntilVisible(signal: AbortSignal) {
      expect(signal.aborted).toBe(false)
      result.waits += 1
      visible = true
    },
    async sleep(ms: number, signal: AbortSignal) {
      expect(signal.aborted).toBe(false)
      result.delays.push(ms)
      if (result.delays.length === options.abortAfterSleeps) options.abort?.abort()
    },
  }
  return result
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('phase1d run polling', () => {
  test('a change hint wakes a sleeping poller and closes the stream at review', async () => {
    let notify!: () => void
    const close = vi.fn()
    const sleeping = deferred<void>()
    const getRun = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot('review_pending'))
    const client = api(getRun, async () => page(0))
    client.watchRun = (_id, listener) => { notify = listener; return close }
    const plan = scheduler()
    plan.sleep = async (_ms, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      sleeping.resolve()
    })
    const updates: RunStatus[] = []
    const polling = pollRun({ api: client, runId: 'job_1', after: 0,
      signal: new AbortController().signal, scheduler: plan,
      onUpdate: update => updates.push(update.run.status) })
    await sleeping.promise
    notify()
    await polling
    expect(updates).toEqual(['generating', 'review_pending'])
    expect(close).toHaveBeenCalledOnce()
  })

  test('a hint during a read is not lost and does not start a concurrent read', async () => {
    let notify!: () => void
    const first = deferred<RunSnapshot>()
    const getRun = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(snapshot('completed'))
    const client = api(getRun, async () => page(0))
    client.watchRun = (_id, listener) => { notify = listener; return vi.fn() }
    const plan = scheduler()
    const polling = pollRun({ api: client, runId: 'job_1', after: 0,
      signal: new AbortController().signal, scheduler: plan, onUpdate: vi.fn() })
    notify()
    notify()
    expect(getRun).toHaveBeenCalledOnce()
    first.resolve(snapshot())
    await polling
    expect(getRun).toHaveBeenCalledTimes(2)
    expect(plan.delays).toEqual([])
  })

  test('polls immediately and backs off empty pages to 1/2/4/8 seconds', async () => {
    const controller = new AbortController()
    const plan = scheduler({ abort: controller, abortAfterSleeps: 5 })
    const getRun = vi.fn(async () => snapshot())
    const listEvents = vi.fn(async (_runId: string, after: number) => page(after))
    const close = vi.fn()
    const client = api(getRun, listEvents)
    client.watchRun = () => close // A silent/dropped stream must not suppress fallback polling.
    await pollRun({ api: client, runId: 'job_1', after: 0,
      signal: controller.signal, scheduler: plan, onUpdate: vi.fn() })
    expect(getRun).toHaveBeenCalledTimes(5)
    expect(plan.delays).toEqual([1000, 2000, 4000, 8000, 8000])
    expect(close).toHaveBeenCalledOnce()
  })

  test('resets the next delay after receiving events', async () => {
    const controller = new AbortController()
    const plan = scheduler({ abort: controller, abortAfterSleeps: 4 })
    const pages = [page(0), page(0), page(0, [1]), page(1)]
    const listEvents = vi.fn(async () => pages.shift()!)
    await pollRun({ api: api(async () => snapshot(), listEvents), runId: 'job_1', after: 0,
      signal: controller.signal, scheduler: plan, onUpdate: vi.fn() })
    expect(plan.delays).toEqual([1000, 2000, 1000, 1000])
  })

  test.each<RunStatus>(['review_pending', 'completed', 'failed_retryable', 'failed_terminal'])(
    'stops at %s without another sleep', async (status) => {
      const plan = scheduler()
      const update = vi.fn()
      await pollRun({ api: api(async () => snapshot(status), async () => page(0)),
        runId: 'job_1', after: 0, signal: new AbortController().signal,
        scheduler: plan, onUpdate: update })
      expect(update).toHaveBeenCalledTimes(1)
      expect(plan.delays).toEqual([])
    },
  )

  test('waits while hidden, then performs an immediate visible cycle', async () => {
    const plan = scheduler({ visible: false })
    const getRun = vi.fn(async () => snapshot('completed'))
    await pollRun({ api: api(getRun, async () => page(0)), runId: 'job_1', after: 0,
      signal: new AbortController().signal, scheduler: plan, onUpdate: vi.fn() })
    expect(plan.waits).toBe(1)
    expect(getRun).toHaveBeenCalledTimes(1)
    expect(plan.delays).toEqual([])
  })

  test('passes one AbortSignal to both requests and suppresses a late aborted update', async () => {
    const oldRun = deferred<RunSnapshot>()
    const oldEvents = deferred<EventPage>()
    const controller = new AbortController()
    const getRun = vi.fn((_id: string, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal)
      return oldRun.promise
    })
    const listEvents = vi.fn((_id: string, _after: number, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal)
      return oldEvents.promise
    })
    const oldUpdate = vi.fn()
    const close = vi.fn()
    const client = api(getRun, listEvents)
    client.watchRun = () => close
    const oldPoll = pollRun({ api: client, runId: 'job_1', after: 0,
      signal: controller.signal, scheduler: scheduler(), onUpdate: oldUpdate })
    controller.abort()
    expect(close).toHaveBeenCalledOnce()
    oldRun.resolve(snapshot('completed'))
    oldEvents.resolve(page(0))
    await oldPoll
    expect(oldUpdate).not.toHaveBeenCalled()

    const newUpdate = vi.fn()
    await pollRun({ api: api(async () => snapshot('completed'), async () => page(0)),
      runId: 'job_2', after: 0, signal: new AbortController().signal,
      scheduler: scheduler(), onUpdate: newUpdate })
    expect(newUpdate).toHaveBeenCalledTimes(1)
  })

  test('uses only the last confirmed cursor and never decreases it', async () => {
    const controller = new AbortController()
    const plan = scheduler({ abort: controller, abortAfterSleeps: 2 })
    const listEvents = vi.fn()
      .mockResolvedValueOnce(page(0, [1, 2]))
      .mockResolvedValueOnce(page(2))
    const updates: number[] = []
    await pollRun({ api: api(async () => snapshot(), listEvents), runId: 'job_1', after: 0,
      signal: controller.signal, scheduler: plan,
      onUpdate: update => updates.push(update.nextAfter) })
    expect(listEvents.mock.calls.map(call => call[1])).toEqual([0, 2])
    expect(updates).toEqual([2, 2])
  })

  test.each([
    { after: 3, value: page(2), label: 'decreasing empty cursor' },
    { after: 0, value: { ...page(0, [1, 2]), events: page(0, [1, 1]).events }, label: 'duplicate seq' },
    { after: 0, value: { ...page(0, [2]), nextAfter: 1 }, label: 'cursor behind event' },
  ])('rejects $label before publishing an update', async ({ after, value }) => {
    const update = vi.fn()
    await expect(pollRun({
      api: api(async () => snapshot(), async () => value), runId: 'job_1', after,
      signal: new AbortController().signal, scheduler: scheduler(), onUpdate: update,
    })).rejects.toThrow('POLL_EVENT_SEQUENCE_INVALID')
    expect(update).not.toHaveBeenCalled()
  })
})
