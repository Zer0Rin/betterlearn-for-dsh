import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import {
  useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type PointerEvent as ReactPointerEvent,
} from 'react'
import { createRoot } from 'react-dom/client'
import { createClientApi } from './client-api.js'
import { NobeiWorkspace } from './NobeiClientView.js'
import { modelSelectionInjection, type ModelDirectoryResolverPort } from './model-directory-bridge.js'
import { ensureClientStyles } from './styles.js'
import type { ClientApi } from './types.js'
import type { WorkspaceScreen } from './use-nobei-workspace.js'
import { selectableDshConversations, type DshConversationSummary } from './dsh-conversation-sessions.js'
import {
  clampWorkbenchSize,
  defaultWorkbenchSize,
  readWorkbenchSize,
  resizeFromPointer,
  writeWorkbenchSize,
  type ResizeAxis,
  type ViewportSize,
  type WorkbenchScreen,
  type WorkbenchSize,
} from './workbench-size.js'

export type { WorkbenchScreen } from './workbench-size.js'

export interface BetterLearnFloatingAppProps {
  sessions: Pick<ISessions, 'list' | 'subagentAddress'>
  modelDirectories: ModelDirectoryResolverPort
  storage: Storage
  sizeStorage?: Storage
  api?: ClientApi
}

interface ResizeGesture {
  axis: ResizeAxis
  pointerId: number
  x: number
  y: number
  size: WorkbenchSize
  screen: WorkbenchScreen
}

function currentViewport(): ViewportSize {
  return { width: window.innerWidth, height: window.innerHeight }
}

interface FloatingSessionWorkspaceProps {
  sessionId: string
  ordinarySession: boolean
  conversations: DshConversationSummary[]
  modelDirectories: ModelDirectoryResolverPort
  storage: Storage
  api: ClientApi
  onScreenChange(screen: WorkspaceScreen): void
  historyOpen: boolean
}

function FloatingSessionWorkspace({
  sessionId, ordinarySession, conversations, modelDirectories, storage, api, onScreenChange, historyOpen,
}: FloatingSessionWorkspaceProps) {
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
    onScreenChange={onScreenChange} historyOpen={historyOpen} conversations={conversations} />
}

export function BetterLearnFloatingApp({
  sessions, modelDirectories, storage, sizeStorage, api,
}: BetterLearnFloatingAppProps) {
  const sessionState = useSyncExternalStore(
    listener => sessions.list.subscribe(listener),
    () => sessions.list.getSnapshot(),
    () => sessions.list.getSnapshot(),
  )
  const sessionId = sessionState.current === undefined ? undefined : String(sessionState.current)
  const conversations = useMemo(() => selectableDshConversations(
    sessionState,
    id => sessions.subagentAddress(id),
  ), [sessionState, sessions])
  const currentRow = sessionState.current === undefined ? undefined : sessionState.byId[sessionState.current]
  const ordinarySession = sessionState.current !== undefined
    && currentRow?.origin !== 'subagent'
    && sessions.subagentAddress(sessionState.current) === undefined
  const [expanded, setExpanded] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [screen, setScreen] = useState<WorkbenchScreen>(sessionId === undefined ? 'empty' : 'import')
  const clientApi = useMemo(() => api ?? createClientApi(), [api])
  const persistentSizeStorage = sizeStorage ?? window.localStorage
  const [viewport, setViewport] = useState(currentViewport)
  const [size, setSize] = useState(() => clampWorkbenchSize(
    readWorkbenchSize(persistentSizeStorage, screen) ?? defaultWorkbenchSize(screen, viewport),
    viewport,
  ))
  const [resizing, setResizing] = useState(false)
  const resizeGesture = useRef<ResizeGesture>()
  const sizeRef = useRef(size)

  useEffect(() => { sizeRef.current = size }, [size])

  useEffect(() => {
    const updateViewport = () => setViewport(currentViewport())
    window.addEventListener('resize', updateViewport)
    return () => window.removeEventListener('resize', updateViewport)
  }, [])

  useEffect(() => {
    if (resizeGesture.current !== undefined) return
    const selected = readWorkbenchSize(persistentSizeStorage, screen)
      ?? defaultWorkbenchSize(screen, viewport)
    setSize(clampWorkbenchSize(selected, viewport))
  }, [persistentSizeStorage, screen, viewport])

  useEffect(() => {
    if (!resizing) return
    const move = (event: PointerEvent) => {
      const gesture = resizeGesture.current
      if (gesture === undefined || event.pointerId !== gesture.pointerId) return
      const next = resizeFromPointer(
        gesture.size,
        gesture.axis,
        event.clientX - gesture.x,
        event.clientY - gesture.y,
        viewport,
      )
      sizeRef.current = next
      setSize(next)
    }
    const finish = (event: PointerEvent) => {
      const gesture = resizeGesture.current
      if (gesture === undefined || event.pointerId !== gesture.pointerId) return
      writeWorkbenchSize(persistentSizeStorage, gesture.screen, sizeRef.current)
      resizeGesture.current = undefined
      setResizing(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [persistentSizeStorage, resizing, viewport])

  function beginResize(axis: ResizeAxis, event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeGesture.current = {
      axis, pointerId: event.pointerId, x: event.clientX, y: event.clientY, size, screen,
    }
    sizeRef.current = size
    setResizing(true)
  }

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

  const panelStyle = {
    '--betterlearn-user-width': `${size.width}px`,
    '--betterlearn-user-height': `${size.height}px`,
  } as CSSProperties

  return <aside className="betterlearn-floating-panel" data-testid="betterlearn-floating-panel"
    data-screen={screen} data-history-open={historyOpen ? 'true' : 'false'}
    data-compact-height={size.height <= 420 ? 'true' : 'false'}
    data-resizing={resizing ? 'true' : 'false'} style={panelStyle} aria-label="BetterLearn 工作台">
    <div className="betterlearn-resize-handle betterlearn-resize-handle--left"
      data-testid="betterlearn-resize-left" role="separator" aria-label="调整 BetterLearn 宽度"
      onPointerDown={event => beginResize('width', event)} />
    <div className="betterlearn-resize-handle betterlearn-resize-handle--bottom"
      data-testid="betterlearn-resize-bottom" role="separator" aria-label="调整 BetterLearn 高度"
      onPointerDown={event => beginResize('height', event)} />
    <div className="betterlearn-resize-handle betterlearn-resize-handle--corner"
      data-testid="betterlearn-resize-corner" role="separator" aria-label="调整 BetterLearn 大小"
      onPointerDown={event => beginResize('both', event)} />
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
      : <FloatingSessionWorkspace key={sessionId} sessionId={sessionId} ordinarySession={ordinarySession}
        conversations={conversations}
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
    storage={window.sessionStorage} sizeStorage={window.localStorage} />)
  return () => {
    root.unmount()
    container.remove()
  }
}
