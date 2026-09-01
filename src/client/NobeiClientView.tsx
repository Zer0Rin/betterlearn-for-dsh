import { useEffect, useLayoutEffect, useState } from 'react'
import { HistorySidebar } from './components/HistorySidebar.js'
import { ImportWorkspace } from './components/ImportWorkspace.js'
import { ResultSummary } from './components/ResultSummary.js'
import { ReviewWorkspace } from './components/ReviewWorkspace.js'
import { RunProgress } from './components/RunProgress.js'
import type { PollScheduler } from './poll-run.js'
import { modelSelectionLabel, type ModelSelectionInput } from './model-directory-bridge.js'
import type { ClientApi } from './types.js'
import { useNobeiWorkspace, type WorkspaceScreen } from './use-nobei-workspace.js'
import { workspaceCopy } from './workspace-copy.js'

export interface NobeiWorkspaceProps extends ModelSelectionInput {
  sessionId: string
  api: ClientApi
  storage: Storage
  scheduler?: PollScheduler
  onScreenChange?(screen: WorkspaceScreen): void
  historyOpen?: boolean
}

export function NobeiWorkspace({
  sessionId, api, storage, modelDirectoryState, loadModelSelection, readModelDirectory, ordinarySession, scheduler,
  onScreenChange, historyOpen = false,
}: NobeiWorkspaceProps) {
  const workspace = useNobeiWorkspace({
    sessionId, api, storage, modelDirectoryState, loadModelSelection, readModelDirectory, ordinarySession, scheduler,
  })
  const sourceName = workspace.run?.document.filename ?? '新的学习材料'
  const [historyRuns, setHistoryRuns] = useState<Awaited<ReturnType<ClientApi['listRuns']>>['runs']>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string>()
  const [historyReload, setHistoryReload] = useState(0)
  useLayoutEffect(() => onScreenChange?.(workspace.screen), [onScreenChange, workspace.screen])
  useEffect(() => {
    if (!historyOpen) return
    const controller = new AbortController()
    setHistoryLoading(true)
    setHistoryError(undefined)
    api.listRuns(controller.signal).then(result => {
      if (!controller.signal.aborted) setHistoryRuns(result.runs)
    }).catch(error => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setHistoryError('历史记录加载失败')
      }
    }).finally(() => {
      if (!controller.signal.aborted) setHistoryLoading(false)
    })
    return () => controller.abort()
  }, [api, historyOpen, historyReload, workspace.currentRunId, workspace.run?.revision])
  const activeModel = workspace.run?.modelSelection ?? workspace.modelSelection
  const unavailableMessage = workspace.serviceUnavailable ? workspaceCopy.unavailable : undefined
  const operationError = unavailableMessage
    ?? (workspace.screen === 'import' || workspace.message === workspaceCopy.operationFailed
      || workspace.message === workspaceCopy.reviewUnconfirmed
      ? workspace.message
      : undefined)
  return (
    <div className="nobei-client-layout" data-history-open={historyOpen ? 'true' : 'false'}>
      {historyOpen && <HistorySidebar runs={historyRuns} currentRunId={workspace.currentRunId}
        loading={historyLoading} error={historyError}
        onRetry={() => setHistoryReload(value => value + 1)}
        onSelect={workspace.openRun} onNew={workspace.reset} />}
      <main className="nobei-client" data-testid="nobei-client-view">
      <header className="nobei-client__masthead" data-testid="nobei-shared-header">
        <div>
          <p className="nobei-client__brand">Nobei</p>
          <h1>把原文整理成可核对的知识</h1>
        </div>
        <div>
          <p className="nobei-client__source-identity"><span>当前材料</span><strong>{sourceName}</strong></p>
          {activeModel && <p data-testid="nobei-active-model">本次模型：{modelSelectionLabel(activeModel)}</p>}
        </div>
      </header>
      <div className="nobei-client__workspace" data-workspace-screen={workspace.screen}>
        {workspace.screen === 'import' && <ImportWorkspace submitting={workspace.busy}
          error={operationError} onSubmit={workspace.importText} previewDocument={api.previewDocument}
          modelSelection={workspace.modelSelection} modelStatus={workspace.modelDirectoryStatus}
          ordinarySession={workspace.ordinarySession} />}
        {workspace.screen === 'processing' && <RunProgress run={workspace.run} progress={workspace.progress} busy={workspace.busy}
          serviceUnavailable={workspace.serviceUnavailable} message={workspace.message}
          previewDocument={api.previewDocument} onRetry={workspace.retry} onReload={workspace.reload} onReset={workspace.reset} />}
        {workspace.screen === 'review' && workspace.run && <ReviewWorkspace run={workspace.run}
          candidates={workspace.candidates} activeCandidateId={workspace.activeCandidateId}
          submittingCandidateId={workspace.submittingCandidateId}
          error={operationError}
          onSelect={workspace.selectCandidate} onReview={workspace.review} onReload={workspace.reload} />}
        {workspace.screen === 'result' && workspace.run && <ResultSummary run={workspace.run}
          candidates={workspace.candidates} knowledgePoints={workspace.knowledgePoints}
          onUpdate={workspace.updateKnowledgePoint} onReset={workspace.reset} />}
      </div>
      <p className="nobei-client__live-status" aria-live="polite">{workspace.message ?? unavailableMessage ?? ''}</p>
      </main>
    </div>
  )
}
