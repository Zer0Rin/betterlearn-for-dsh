import { useLayoutEffect } from 'react'
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
}

export function NobeiWorkspace({
  sessionId, api, storage, modelDirectoryState, loadModelSelection, readModelDirectory, ordinarySession, scheduler,
  onScreenChange,
}: NobeiWorkspaceProps) {
  const workspace = useNobeiWorkspace({
    sessionId, api, storage, modelDirectoryState, loadModelSelection, readModelDirectory, ordinarySession, scheduler,
  })
  const sourceName = workspace.run?.document.filename ?? '新的学习材料'
  useLayoutEffect(() => onScreenChange?.(workspace.screen), [onScreenChange, workspace.screen])
  const activeModel = workspace.run?.modelSelection ?? workspace.modelSelection
  const unavailableMessage = workspace.serviceUnavailable ? workspaceCopy.unavailable : undefined
  const operationError = unavailableMessage
    ?? (workspace.screen === 'import' || workspace.message === workspaceCopy.operationFailed
      || workspace.message === workspaceCopy.reviewUnconfirmed
      ? workspace.message
      : undefined)
  return (
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
          onReset={workspace.reset} />}
      </div>
      <p className="nobei-client__live-status" aria-live="polite">{workspace.message ?? unavailableMessage ?? ''}</p>
    </main>
  )
}
