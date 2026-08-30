import type { ClientApi, EventPage, RunEvent, RunSnapshot } from './types.js'

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
}): Promise<void> {
  const { api, runId, signal, scheduler, onUpdate } = options
  let after = options.after
  let delayMs = 1_000

  while (!signal.aborted) {
    if (!scheduler.isVisible()) {
      await scheduler.waitUntilVisible(signal)
      if (signal.aborted) return
    }
    const [run, page] = await Promise.all([
      api.getRun(runId, signal),
      api.listEvents(runId, after, signal),
    ])
    if (signal.aborted) return
    validateEventPage(after, page)
    onUpdate({ run, events: page.events, nextAfter: page.nextAfter })
    after = page.nextAfter
    if (PAUSE_OR_TERMINAL.has(run.status)) return

    const receivedEvents = page.events.length > 0
    await scheduler.sleep(receivedEvents ? 1_000 : delayMs, signal)
    delayMs = receivedEvents ? 1_000 : Math.min(delayMs * 2, 8_000)
  }
}
