import type { ClientApi, EventPage, RunEvent, RunSnapshot } from './types.js'
import type { GenerationProgress } from '../generation-progress.js'

export interface PollScheduler {
  sleep(ms: number, signal: AbortSignal): Promise<void>
  isVisible(): boolean
  waitUntilVisible(signal: AbortSignal): Promise<void>
}

export interface PollUpdate {
  run: RunSnapshot
  events: RunEvent[]
  nextAfter: number
}

const PAUSE_OR_TERMINAL = new Set<RunSnapshot['status']>([
  'review_pending',
  'completed',
  'failed_retryable',
  'failed_terminal',
])

function invalidSequence(): never {
  throw new Error('POLL_EVENT_SEQUENCE_INVALID')
}

function validateEventPage(after: number, page: EventPage): void {
  if (!Number.isSafeInteger(page.nextAfter) || page.nextAfter < after) invalidSequence()
  let previous = after
  for (const event of page.events) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= previous) invalidSequence()
    previous = event.seq
  }
  if (page.events.length > 0 && page.nextAfter !== previous) invalidSequence()
}

export async function pollRun(options: {
  api: ClientApi
  runId: string
  after: number
  signal: AbortSignal
  scheduler: PollScheduler
  onUpdate(update: PollUpdate): void
  onProgress?(progress: GenerationProgress | null): void
}): Promise<void> {
  const { api, runId, signal, scheduler, onUpdate } = options
  let after = options.after
  let delayMs = 1_000
  if (signal.aborted) return
  let changed = false
  let finished = false
  let progressVersion = 0
  let sleepController: AbortController | undefined
  let unwatch = api.watchRun?.(runId, () => {
    changed = true
    sleepController?.abort()
  }, progress => {
    if (signal.aborted || finished) return
    progressVersion++
    options.onProgress?.(progress)
  })
  const stopWatching = () => {
    unwatch?.()
    unwatch = undefined
    sleepController?.abort()
  }
  signal.addEventListener('abort', stopWatching, { once: true })

  try {
    while (!signal.aborted) {
      if (!scheduler.isVisible()) {
        await scheduler.waitUntilVisible(signal)
        if (signal.aborted) return
      }
      changed = false
      const requestedProgressVersion = progressVersion
      const [run, page, progress] = await Promise.all([
        api.getRun(runId, signal),
        api.listEvents(runId, after, signal),
        options.onProgress ? api.getProgress?.(runId, signal).catch(() => undefined) : undefined,
      ])
      if (signal.aborted) return
      validateEventPage(after, page)
      finished = PAUSE_OR_TERMINAL.has(run.status)
      if (finished) options.onProgress?.(null)
      else if (progress !== undefined && progressVersion === requestedProgressVersion) options.onProgress?.(progress)
      onUpdate({ run, events: page.events, nextAfter: page.nextAfter })
      after = page.nextAfter
      if (PAUSE_OR_TERMINAL.has(run.status)) return

      const receivedEvents = page.events.length > 0
      if (!changed) {
        sleepController = new AbortController()
        try {
          await scheduler.sleep(receivedEvents ? 1_000 : delayMs, sleepController.signal)
        } catch (error) {
          if (!changed || signal.aborted) throw error
        } finally {
          sleepController = undefined
        }
      }
      delayMs = receivedEvents || changed ? 1_000 : Math.min(delayMs * 2, 8_000)
    }
  } finally {
    finished = true
    signal.removeEventListener('abort', stopWatching)
    stopWatching()
  }
}
