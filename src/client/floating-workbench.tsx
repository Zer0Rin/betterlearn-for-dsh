import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { createClientApi } from './client-api.js'
import { NobeiWorkspace } from './NobeiClientView.js'
import { modelSelectionInjection, type ModelDirectoryResolverPort } from './model-directory-bridge.js'
import { ensureClientStyles } from './styles.js'
import type { ClientApi } from './types.js'
import type { WorkspaceScreen } from './use-nobei-workspace.js'

export type WorkbenchScreen = 'empty' | WorkspaceScreen

export interface BetterLearnFloatingAppProps {
  sessions: Pick<ISessions, 'list' | 'subagentAddress'>
  modelDirectories: ModelDirectoryResolverPort
  storage: Storage
  api?: ClientApi
}

interface FloatingSessionWorkspaceProps {
  sessionId: string
  sessions: Pick<ISessions, 'subagentAddress'>
  modelDirectories: ModelDirectoryResolverPort
  storage: Storage
  api: ClientApi
  onScreenChange(screen: WorkspaceScreen): void
  historyOpen: boolean
}

function FloatingSessionWorkspace({
  sessionId, sessions, modelDirectories, storage, api, onScreenChange, historyOpen,
}: FloatingSessionWorkspaceProps) {
  const ordinarySession = sessions.subagentAddress(sessionId as never) === undefined
  const face = useMemo(() => modelSelectionInjection(modelDirectories, sessionId, ordinarySession),
    [modelDirectories, ordinarySession, sessionId])
  const modelDirectoryState = useSyncExternalStore(
    face.hooks.modelDirectory.subscribe,
    face.hooks.modelDirectory.getSnapshot,
    face.hooks.modelDirectory.getSnapshot,
  )
  return <NobeiWorkspace sessionId={sessionId} api={api} storage={storage}
    ordinarySession={ordinarySession} modelDirectoryState={modelDirectoryState}
    loadModelSelection={face.loadModelSelection} readModelDirectory={face.readModelDirectory}
    onScreenChange={onScreenChange} historyOpen={historyOpen} />
}

export function BetterLearnFloatingApp({ sessions, modelDirectories, storage, api }: BetterLearnFloatingAppProps) {
  const sessionState = useSyncExternalStore(
    listener => sessions.list.subscribe(listener),
    () => sessions.list.getSnapshot(),
    () => sessions.list.getSnapshot(),
  )
  const sessionId = sessionState.current === undefined ? undefined : String(sessionState.current)
  const [expanded, setExpanded] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [screen, setScreen] = useState<WorkbenchScreen>(sessionId === undefined ? 'empty' : 'import')
  const clientApi = useMemo(() => api ?? createClientApi(), [api])

  useEffect(() => setScreen(sessionId === undefined ? 'empty' : 'import'), [sessionId])

  useEffect(() => {
    if (!expanded) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setHistoryOpen(false)
        setExpanded(false)
      }
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [expanded])

  if (!expanded) {
    return <button className="betterlearn-floating-launcher" data-testid="betterlearn-launcher"
      type="button" aria-label="打开 BetterLearn" aria-expanded={false}
      onClick={() => setExpanded(true)}>BetterLearn</button>
  }

  return <aside className="betterlearn-floating-panel" data-testid="betterlearn-floating-panel"
    data-screen={screen} data-history-open={historyOpen ? 'true' : 'false'} aria-label="BetterLearn 工作台">
    <header className="betterlearn-floating-header">
      <div className="betterlearn-floating-header__leading">
        {sessionId !== undefined && <button type="button" data-testid="betterlearn-history-toggle"
          aria-label={historyOpen ? '收起提取历史' : '展开提取历史'} aria-expanded={historyOpen}
          onClick={() => setHistoryOpen(value => !value)}>历史</button>}
        <strong>BetterLearn</strong>
      </div>
      <button type="button" aria-label="收起 BetterLearn" onClick={() => {
        setHistoryOpen(false)
        setExpanded(false)
      }}>收起</button>
    </header>
    {sessionId === undefined
      ? <p className="betterlearn-floating-empty">先在 DSH 创建或选择普通会话，再使用 BetterLearn。</p>
      : <FloatingSessionWorkspace key={sessionId} sessionId={sessionId} sessions={sessions}
        modelDirectories={modelDirectories} storage={storage} api={clientApi} onScreenChange={setScreen}
        historyOpen={historyOpen} />}
  </aside>
}

export function mountFloatingWorkbench(ctx: Context): () => void {
  ensureClientStyles(document)
  const container = document.createElement('div')
  container.className = 'betterlearn-floating-root'
  container.setAttribute('data-betterlearn-floating-root', '')
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(<BetterLearnFloatingApp sessions={ctx.sessions}
    modelDirectories={ctx.modelDirectories as unknown as ModelDirectoryResolverPort}
    storage={window.sessionStorage} />)
  return () => {
    root.unmount()
    container.remove()
  }
}
