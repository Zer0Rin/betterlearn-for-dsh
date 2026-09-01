import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GenerationProgress } from '../generation-progress.js'
import { ProductApiError } from './client-api.js'
import {
  ModelDirectoryBridgeError,
  detachedModelSelection,
  type ModelSelectionInput,
} from './model-directory-bridge.js'
import { pollRun, type PollScheduler } from './poll-run.js'
import { workspaceCopy } from './workspace-copy.js'
import {
  clearPendingReview,
  createIdempotencyKey,
  readSessionState,
  reviewRequestDigest,
  writeSessionState,
} from './session-state.js'
import type {
  CandidateSnapshot,
  ClientApi,
  ImportTextInput,
  KnowledgePointSnapshot,
  ModelSelectionSnapshot,
  ReviewActionDraft,
  ReviewPayload,
  RunEvent,
  RunSnapshot,
} from './types.js'

export type WorkspaceScreen = 'import' | 'processing' | 'review' | 'result'
export type ModelDirectoryStatus = 'loading' | 'ready' | 'unroutable' | 'unavailable'
const INITIAL_POLL_DEFER_MS = 100
type ImportLaunch = Awaited<ReturnType<ClientApi['importText']>>
const pendingImports = new Map<string, Promise<ImportLaunch>>()

export interface WorkspaceController {
  currentRunId?: string
  progress?: GenerationProgress | null
  screen: WorkspaceScreen
  run?: RunSnapshot
  events: RunEvent[]
  candidates: CandidateSnapshot[]
  knowledgePoints: KnowledgePointSnapshot[]
  busy: boolean
  activeCandidateId?: string
  submittingCandidateId?: string
  serviceUnavailable: boolean
  message?: string
  modelSelection?: ModelSelectionSnapshot
  modelDirectoryStatus: ModelDirectoryStatus
  ordinarySession: boolean
  openRun(runId: string): void
  importText(input: ImportTextInput): Promise<boolean>
  retry(): Promise<void>
  reload(): Promise<void>
  selectCandidate(candidateId: string): void
  review(candidate: CandidateSnapshot, draft: ReviewActionDraft): Promise<boolean>
  updateKnowledgePoint(point: KnowledgePointSnapshot, input: { title: string; statement: string }): Promise<boolean>
  deleteRun(runId: string): Promise<boolean>
  reset(): void
}

function browserScheduler(): PollScheduler {
  return {
    sleep(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, ms)
        signal.addEventListener('abort', () => {
          window.clearTimeout(timer)
          reject(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      })
    },
    isVisible: () => document.visibilityState !== 'hidden',
    waitUntilVisible(signal) {
      if (document.visibilityState !== 'hidden') return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const finish = () => {
          if (document.visibilityState === 'hidden') return
          cleanup()
          resolve()
        }
        const abort = () => {
          cleanup()
          reject(new DOMException('aborted', 'AbortError'))
        }
        const cleanup = () => {
          document.removeEventListener('visibilitychange', finish)
          signal.removeEventListener('abort', abort)
        }
        document.addEventListener('visibilitychange', finish)
        signal.addEventListener('abort', abort, { once: true })
      })
    },
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function useNobeiWorkspace(options: ModelSelectionInput & {
  sessionId: string
  api: ClientApi
  storage: Storage
  scheduler?: PollScheduler
}): WorkspaceController {
  const { sessionId, api, storage, modelDirectoryState, loadModelSelection, readModelDirectory, ordinarySession } = options
  const scheduler = useMemo(() => options.scheduler ?? browserScheduler(), [options.scheduler])
  const initial = useMemo(() => readSessionState(storage, sessionId), [storage, sessionId])
  const [currentRunId, setCurrentRunId] = useState(initial.runId)
  const [screen, setScreen] = useState<WorkspaceScreen>(initial.runId ? 'processing' : 'import')
  const [run, setRun] = useState<RunSnapshot>()
  const [progress, setProgress] = useState<GenerationProgress | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [candidates, setCandidates] = useState<CandidateSnapshot[]>([])
  const [knowledgePoints, setKnowledgePoints] = useState<KnowledgePointSnapshot[]>([])
  const [busy, setBusy] = useState(false)
  const [activeCandidateId, setActiveCandidateId] = useState<string>()
  const [submittingCandidateId, setSubmittingCandidateId] = useState<string>()
  const [serviceUnavailable, setServiceUnavailable] = useState(false)
  const [message, setMessage] = useState<string>()
  const [loadedModelSelection, setModelSelection] = useState<ModelSelectionSnapshot>()
  const [loadedModelStatus, setModelDirectoryStatus] = useState<ModelDirectoryStatus>(
    ordinarySession ? 'loading' : 'unavailable',
  )
  const modelSelection = modelDirectoryState === undefined ? loadedModelSelection
    : detachedModelSelection(modelDirectoryState.current)
  const modelDirectoryStatus: ModelDirectoryStatus = !ordinarySession ? 'unavailable'
    : modelDirectoryState === undefined ? loadedModelStatus
      : modelDirectoryState.status === 'loading' || modelDirectoryState.routable === null ? 'loading'
        : modelDirectoryState.routable === false ? 'unroutable'
          : modelSelection ? 'ready' : 'unavailable'
  const pollController = useRef<AbortController>()
  const commandController = useRef<AbortController>()
  const modelLoadPromise = useRef<Promise<ModelSelectionSnapshot>>()
  const commandBusy = useRef(false)
  const reviewBusy = useRef(false)
  const editBusy = useRef(false)
  const deleteBusy = useRef(false)
  const mounted = useRef(false)
  const replayReview = useRef<(
    snapshot: RunSnapshot,
    candidates: CandidateSnapshot[],
    signal: AbortSignal,
  ) => Promise<void>>()

  const setFailure = useCallback((error: unknown) => {
    if (isAbort(error)) return
    if (error instanceof ModelDirectoryBridgeError) {
      setModelDirectoryStatus(error.code === 'MODEL_NOT_ROUTABLE' ? 'unroutable' : 'unavailable')
      setMessage(error.code === 'MODEL_NOT_ROUTABLE'
        ? '当前 DSH 模型不可用，请先在 DSH 设置中选择可用模型。'
        : ordinarySession
          ? '无法读取 DSH 当前模型，请重试。'
          : '此会话不支持模型选择，请在普通会话中使用 Nobei。')
      return
    }
    if (error instanceof ProductApiError && error.status === 503) {
      setServiceUnavailable(true)
      setMessage(undefined)
      return
    }
    setMessage(workspaceCopy.operationFailed)
  }, [ordinarySession])

  const refreshModelSelection = useCallback(async (): Promise<ModelSelectionSnapshot> => {
    if (modelLoadPromise.current !== undefined) return modelLoadPromise.current
    setModelDirectoryStatus('loading')
    const loading = loadModelSelection()
      .then((selected) => {
        setModelSelection(selected)
        setModelDirectoryStatus('ready')
        return selected
      })
      .catch((error: unknown) => {
        setFailure(error)
        throw error
      })
      .finally(() => {
        if (modelLoadPromise.current === loading) modelLoadPromise.current = undefined
      })
    modelLoadPromise.current = loading
    return loading
  }, [loadModelSelection, setFailure])

  const currentModelSelection = useCallback((): ModelSelectionSnapshot => {
    if (!ordinarySession) throw new ModelDirectoryBridgeError('MODEL_SELECTION_UNAVAILABLE')
    const snapshot = readModelDirectory()
    if (snapshot !== undefined) {
      if (snapshot.routable === false) throw new ModelDirectoryBridgeError('MODEL_NOT_ROUTABLE')
      if (snapshot.routable !== true) throw new ModelDirectoryBridgeError('MODEL_SELECTION_UNAVAILABLE')
      const current = detachedModelSelection(snapshot.current)
      if (current === undefined) throw new ModelDirectoryBridgeError('MODEL_SELECTION_UNAVAILABLE')
      return current
    }
    const current = detachedModelSelection(modelSelection)
    if (modelDirectoryStatus === 'unroutable') throw new ModelDirectoryBridgeError('MODEL_NOT_ROUTABLE')
    if (modelDirectoryStatus !== 'ready' || current === undefined) {
      throw new ModelDirectoryBridgeError('MODEL_SELECTION_UNAVAILABLE')
    }
    return current
  }, [readModelDirectory, modelDirectoryStatus, modelSelection, ordinarySession])

  const loadTerminal = useCallback(async (snapshot: RunSnapshot, signal: AbortSignal) => {
    if (snapshot.status === 'review_pending') {
      const result = await api.listCandidates(snapshot.runId, signal)
      if (signal.aborted) return
      setCandidates(result.candidates)
      setActiveCandidateId(result.candidates.find(item => item.reviewStatus === 'pending')?.candidateId)
      setScreen('review')
      await replayReview.current?.(snapshot, result.candidates, signal)
    } else if (snapshot.status === 'completed') {
      const [candidateResult, knowledgeResult] = await Promise.all([
        api.listCandidates(snapshot.runId, signal),
        api.listKnowledgePoints(snapshot.runId, signal),
      ])
      if (signal.aborted) return
      setCandidates(candidateResult.candidates)
      setKnowledgePoints(knowledgeResult.knowledgePoints)
      setScreen('result')
    }
  }, [api])

  const startPoll = useCallback((runId: string, after: number) => {
    pollController.current?.abort()
    setProgress(null)
    const controller = new AbortController()
    pollController.current = controller
    void pollRun({
      api, runId, after, signal: controller.signal, scheduler,
      onProgress(progress) {
        if (!controller.signal.aborted && pollController.current === controller) setProgress(progress)
      },
      onUpdate(update) {
        if (controller.signal.aborted || pollController.current !== controller) return
        setRun(update.run)
        setCurrentRunId(runId)
        setEvents(current => [...current, ...update.events])
        const current = readSessionState(storage, sessionId)
        writeSessionState(storage, sessionId, {
          version: 1,
          runId,
          lastEventSeq: update.nextAfter,
          ...(current.pendingReview === undefined ? {} : { pendingReview: current.pendingReview }),
        })
        setServiceUnavailable(false)
        setMessage(undefined)
        void loadTerminal(update.run, controller.signal).catch(setFailure)
      },
    }).catch(setFailure)
  }, [api, loadTerminal, scheduler, sessionId, setFailure, storage])

  const openRun = useCallback((runId: string) => {
    pollController.current?.abort()
    commandController.current?.abort()
    commandBusy.current = false
    reviewBusy.current = false
    writeSessionState(storage, sessionId, { version: 1, runId, lastEventSeq: 0 })
    setCurrentRunId(runId)
    setScreen('processing')
    setRun(undefined)
    setProgress(null)
    setEvents([])
    setCandidates([])
    setKnowledgePoints([])
    setActiveCandidateId(undefined)
    setSubmittingCandidateId(undefined)
    setServiceUnavailable(false)
    setMessage(undefined)
    setBusy(false)
    startPoll(runId, 0)
  }, [sessionId, startPoll, storage])

  // Restoring a saved run belongs to the session lifecycle, not the model
  // directory lifecycle. Cordis may supply new directory references on render.
  const startCurrentPoll = useRef(startPoll)
  startCurrentPoll.current = startPoll
  useEffect(() => {
    mounted.current = true
    const saved = readSessionState(storage, sessionId)
    if (saved.runId) startCurrentPoll.current(saved.runId, saved.lastEventSeq)
    return () => {
      mounted.current = false
      pollController.current?.abort()
      commandController.current?.abort()
    }
  }, [sessionId, storage])

  useEffect(() => {
    if (!readSessionState(storage, sessionId).runId && ordinarySession) {
      const snapshot = readModelDirectory()
      const current = detachedModelSelection(snapshot?.current)
      if (snapshot?.routable !== true || current === undefined) {
        void refreshModelSelection().catch(() => undefined)
      }
    } else if (!ordinarySession) {
      setFailure(new ModelDirectoryBridgeError('MODEL_SELECTION_UNAVAILABLE'))
    }
  }, [readModelDirectory, ordinarySession, refreshModelSelection, sessionId, setFailure, storage])

  const adoptImport = useCallback(async (pending: Promise<ImportLaunch>): Promise<boolean> => {
    commandBusy.current = true
    setBusy(true)
    setMessage(undefined)
    setServiceUnavailable(false)
    try {
      const launch = await pending
      writeSessionState(storage, sessionId, { version: 1, runId: launch.runId, lastEventSeq: 0 })
      if (!mounted.current) return false
      setCurrentRunId(launch.runId)
      setScreen('processing')
      setEvents([])
      setCandidates([])
      setKnowledgePoints([])
      setServiceUnavailable(false)
      await new Promise<void>(resolve => globalThis.setTimeout(resolve, INITIAL_POLL_DEFER_MS))
      if (!mounted.current) return false
      startPoll(launch.runId, 0)
      return true
    } catch (error) {
      if (mounted.current) setFailure(error)
      return false
    } finally {
      if (pendingImports.get(sessionId) === pending) pendingImports.delete(sessionId)
      commandBusy.current = false
      if (mounted.current) setBusy(false)
    }
  }, [sessionId, setFailure, startPoll, storage])

  const importText = useCallback(async (input: ImportTextInput) => {
    const existing = pendingImports.get(sessionId)
    if (existing !== undefined) return adoptImport(existing)
    if (commandBusy.current) return false
    let selected: ModelSelectionSnapshot
    try {
      try {
        selected = currentModelSelection()
      } catch (error) {
        if (modelLoadPromise.current === undefined) throw error
        selected = await modelLoadPromise.current
      }
    } catch (error) {
      setFailure(error)
      return false
    }
    const controller = new AbortController()
    const pending = api.importText({ ...input, modelSelection: selected }, controller.signal)
    pendingImports.set(sessionId, pending)
    return adoptImport(pending)
  }, [adoptImport, api, currentModelSelection, sessionId, setFailure])

  useEffect(() => {
    const pending = pendingImports.get(sessionId)
    if (pending !== undefined) void adoptImport(pending)
  }, [adoptImport, sessionId])

  const retry = useCallback(async () => {
    if (commandBusy.current || run === undefined) return
    commandBusy.current = true
    setBusy(true)
    setMessage(undefined)
    const controller = new AbortController()
    commandController.current?.abort()
    commandController.current = controller
    try {
      const launch = await api.retryRun(run.runId, run.revision, controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      const saved = readSessionState(storage, sessionId)
      writeSessionState(storage, sessionId, {
        version: 1, runId: launch.runId, lastEventSeq: saved.lastEventSeq,
      })
      setCurrentRunId(launch.runId)
      setScreen('processing')
      setServiceUnavailable(false)
      startPoll(launch.runId, saved.lastEventSeq)
    } catch (error) {
      setFailure(error)
    } finally {
      if (commandController.current === controller) {
        commandBusy.current = false
        if (mounted.current) setBusy(false)
      }
    }
  }, [api, run, sessionId, setFailure, startPoll, storage])

  const reload = useCallback(async () => {
    const saved = readSessionState(storage, sessionId)
    if (!saved.runId) return
    setServiceUnavailable(false)
    setMessage(undefined)
    setScreen('processing')
    startPoll(saved.runId, saved.lastEventSeq)
  }, [sessionId, startPoll, storage])

  const reset = useCallback(() => {
    pollController.current?.abort()
    commandController.current?.abort()
    commandBusy.current = false
    reviewBusy.current = false
    writeSessionState(storage, sessionId, { version: 1, lastEventSeq: 0 })
    setCurrentRunId(undefined)
    setScreen('import')
    setRun(undefined)
    setProgress(null)
    setEvents([])
    setCandidates([])
    setKnowledgePoints([])
    setActiveCandidateId(undefined)
    setSubmittingCandidateId(undefined)
    setServiceUnavailable(false)
    setMessage(undefined)
    setBusy(false)
    if (ordinarySession) void refreshModelSelection().catch(() => undefined)
  }, [ordinarySession, refreshModelSelection, sessionId, storage])

  const executeReview = useCallback(async (options: {
    candidate: CandidateSnapshot
    request: ReviewPayload
    idempotencyKey: string
    requestDigest: string
    signal: AbortSignal
    persist: boolean
  }) => {
    const { candidate, request, idempotencyKey, requestDigest, signal, persist } = options
    if (persist) {
      const current = readSessionState(storage, sessionId)
      writeSessionState(storage, sessionId, {
        version: 1,
        ...(current.runId === undefined ? {} : { runId: current.runId }),
        lastEventSeq: current.lastEventSeq,
        pendingReview: { candidateId: candidate.candidateId, request, idempotencyKey, requestDigest },
      })
    }
    setSubmittingCandidateId(candidate.candidateId)
    setMessage(undefined)
    try {
      const result = await api.reviewCandidate(candidate.candidateId, {
        ...request,
        idempotencyKey,
      }, signal)
      if (signal.aborted) return false
      clearPendingReview(storage, sessionId)
      setRun(result.run)
      setServiceUnavailable(false)
      setMessage(persist ? workspaceCopy.reviewSaved : workspaceCopy.reviewRecovered)
      await loadTerminal(result.run, signal)
      return true
    } catch (error) {
      if (isAbort(error)) return false
      const conflict = error instanceof ProductApiError && [
        'REVISION_CONFLICT',
        'CANDIDATE_ALREADY_REVIEWED',
        'IDEMPOTENCY_CONFLICT',
      ].includes(error.code)
      if (conflict) {
        clearPendingReview(storage, sessionId)
        const current = readSessionState(storage, sessionId)
        if (current.runId) {
          const fresh = await api.getRun(current.runId, signal)
          if (!signal.aborted) {
            setRun(fresh)
            await loadTerminal(fresh, signal)
            setMessage(workspaceCopy.reviewChanged)
            return true
          }
        }
      } else {
        setFailure(error)
        setMessage(workspaceCopy.reviewUnconfirmed)
      }
      return false
    } finally {
      if (!signal.aborted) setSubmittingCandidateId(undefined)
    }
  }, [api, loadTerminal, sessionId, setFailure, storage])

  const review = useCallback(async (candidate: CandidateSnapshot, draft: ReviewActionDraft) => {
    if (reviewBusy.current || candidate.reviewStatus !== 'pending') return false
    reviewBusy.current = true
    const request: ReviewPayload = draft.action === 'edited_and_accept'
      ? {
          action: draft.action,
          expectedRevision: candidate.revision,
          title: draft.title,
          statement: draft.statement,
        }
      : { action: draft.action, expectedRevision: candidate.revision }
    const controller = new AbortController()
    commandController.current?.abort()
    commandController.current = controller
    try {
      const requestDigest = await reviewRequestDigest(candidate.candidateId, request)
      if (controller.signal.aborted) return false
      return await executeReview({
        candidate,
        request,
        idempotencyKey: createIdempotencyKey(globalThis.crypto),
        requestDigest,
        signal: controller.signal,
        persist: true,
      })
    } finally {
      reviewBusy.current = false
    }
  }, [executeReview])

  const updateKnowledgePoint = useCallback(async (
    point: KnowledgePointSnapshot,
    input: { title: string; statement: string },
  ): Promise<boolean> => {
    if (editBusy.current || run?.status !== 'completed') return false
    editBusy.current = true
    setBusy(true)
    setMessage(undefined)
    const controller = new AbortController()
    commandController.current?.abort()
    commandController.current = controller
    try {
      const result = await api.updateKnowledgePoint(point.knowledgePointId, input, controller.signal)
      if (!mounted.current || controller.signal.aborted) return false
      setRun(result.run)
      setKnowledgePoints(items => items.map(item =>
        item.knowledgePointId === point.knowledgePointId ? result.knowledgePoint : item))
      setServiceUnavailable(false)
      setMessage('知识点修改已保存。')
      return true
    } catch (error) {
      setFailure(error)
      return false
    } finally {
      if (commandController.current === controller) {
        editBusy.current = false
        if (mounted.current) setBusy(false)
      }
    }
  }, [api, run?.status, setFailure])

  const deleteRun = useCallback(async (targetRunId: string): Promise<boolean> => {
    if (deleteBusy.current) return false
    deleteBusy.current = true
    setBusy(true)
    setMessage(undefined)
    const controller = new AbortController()
    commandController.current?.abort()
    commandController.current = controller
    try {
      await api.deleteRun(targetRunId, controller.signal)
      if (!mounted.current || controller.signal.aborted) return false
      if (targetRunId === currentRunId) reset()
      setServiceUnavailable(false)
      return true
    } catch (error) {
      setFailure(error)
      return false
    } finally {
      deleteBusy.current = false
      if (mounted.current) setBusy(false)
    }
  }, [api, currentRunId, reset, setFailure])

  replayReview.current = async (snapshot, availableCandidates, parentSignal) => {
    const saved = readSessionState(storage, sessionId)
    const pending = saved.pendingReview
    if (pending === undefined || parentSignal.aborted || reviewBusy.current) return
    const candidate = availableCandidates.find(item => item.candidateId === pending.candidateId)
    if (candidate === undefined || candidate.reviewStatus !== 'pending') {
      clearPendingReview(storage, sessionId)
      return
    }
    const digest = await reviewRequestDigest(candidate.candidateId, pending.request)
    if (digest !== pending.requestDigest || parentSignal.aborted) {
      clearPendingReview(storage, sessionId)
      setMessage(workspaceCopy.reviewExpired)
      return
    }
    reviewBusy.current = true
    const controller = new AbortController()
    commandController.current?.abort()
    commandController.current = controller
    parentSignal.addEventListener('abort', () => controller.abort(), { once: true })
    try {
      await executeReview({
        candidate,
        request: pending.request,
        idempotencyKey: pending.idempotencyKey,
        requestDigest: pending.requestDigest,
        signal: controller.signal,
        persist: false,
      })
    } finally {
      reviewBusy.current = false
    }
  }

  return {
    currentRunId, screen, run, progress, events, candidates, knowledgePoints, busy, activeCandidateId,
    submittingCandidateId, serviceUnavailable, message, modelSelection,
    modelDirectoryStatus, ordinarySession, openRun, importText, retry, reload,
    selectCandidate: setActiveCandidateId, review, updateKnowledgePoint, deleteRun, reset,
  }
}
