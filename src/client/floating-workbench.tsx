import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import {
  useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type PointerEvent as ReactPointerEvent,
} from 'react'
import { createRoot } from 'react-dom/client'
import { createClientApi } from './client-api.js'
import {
  BetterLearnGateway, LearningBookComposer, LearningBookshelf,
  type LearningBookDraftResult,
} from './components/LearningLibrary.js'
import { LearningSpace } from './components/LearningSpace.js'
import {
  createLearningBook, readLearningBooks, updateLearningBookCourse, writeLearningBooks, type LearningBook,
} from './learning-book-library.js'
import { readLearningLayout, writeLearningLayout } from './learning-layout.js'
import { NobeiWorkspace } from './NobeiClientView.js'
import { modelSelectionInjection, type ModelDirectoryResolverPort } from './model-directory-bridge.js'
import { ensureClientStyles } from './styles.js'
import type { ClientApi, KnowledgePointSnapshot, LearningCourse } from './types.js'
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
  persist: boolean
}

type FloatingMode = 'workbench' | 'learning'
type WorkbenchArea = 'home' | 'knowledge' | 'compose' | 'library'

interface LearningBookDraft {
  points: KnowledgePointSnapshot[]
  sourceText: string
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
  onOrganizeLearningBook(points: KnowledgePointSnapshot[], sourceText: string): void
}

function FloatingSessionWorkspace({
  sessionId, ordinarySession, conversations, modelDirectories, storage, api, onScreenChange, historyOpen,
  onOrganizeLearningBook,
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
    onScreenChange={onScreenChange} historyOpen={historyOpen}
    onOrganizeLearningBook={onOrganizeLearningBook} conversations={conversations} />
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
  const [mode, setMode] = useState<FloatingMode>('workbench')
  const [area, setArea] = useState<WorkbenchArea>('home')
  const [activeBook, setActiveBook] = useState<LearningBook>()
  const [learningBooks, setLearningBooks] = useState<LearningBook[]>(
    () => readLearningBooks(persistentSizeStorage),
  )
  const [bookDraft, setBookDraft] = useState<LearningBookDraft>()
  const [newBookId, setNewBookId] = useState<string>()
  const [storageWarning, setStorageWarning] = useState<string>()
  const [learningLayout, setLearningLayout] = useState(() => readLearningLayout(persistentSizeStorage))
  const [resizing, setResizing] = useState(false)
  const resizeGesture = useRef<ResizeGesture>()
  const sizeRef = useRef(size)
  const ordinarySize = useRef<WorkbenchSize>()
  const bookSequence = useRef(0)

  useEffect(() => { sizeRef.current = size }, [size])

  useEffect(() => {
    const updateViewport = () => setViewport(currentViewport())
    window.addEventListener('resize', updateViewport)
    return () => window.removeEventListener('resize', updateViewport)
  }, [])

  useEffect(() => {
    if (resizeGesture.current !== undefined) return
    if (mode === 'learning') {
      const next = clampWorkbenchSize(sizeRef.current, viewport)
      sizeRef.current = next
      setSize(next)
      return
    }
    const selected = readWorkbenchSize(persistentSizeStorage, screen)
      ?? defaultWorkbenchSize(screen, viewport)
    const next = clampWorkbenchSize(selected, viewport)
    sizeRef.current = next
    setSize(next)
  }, [mode, persistentSizeStorage, screen, viewport])

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
      if (gesture.persist) {
        writeWorkbenchSize(persistentSizeStorage, gesture.screen, sizeRef.current)
      }
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
      persist: mode === 'workbench',
    }
    sizeRef.current = size
    setResizing(true)
  }

  useEffect(() => setScreen(sessionId === undefined ? 'empty' : 'import'), [sessionId])

  useEffect(() => {
    if (!expanded) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (mode === 'learning') {
          const next = clampWorkbenchSize(
            ordinarySize.current ?? defaultWorkbenchSize(screen, viewport), viewport,
          )
          sizeRef.current = next
          setSize(next)
          setMode('workbench')
          setArea('library')
          setActiveBook(undefined)
        }
        setHistoryOpen(false)
        setExpanded(false)
      }
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [expanded, mode, screen, viewport])

  function updateLearningLayout(side: 'leftOpen' | 'rightOpen', open: boolean): void {
    setLearningLayout(current => {
      const next = { ...current, [side]: open }
      writeLearningLayout(persistentSizeStorage, next)
      return next
    })
  }

  function organizeLearningBook(points: KnowledgePointSnapshot[], sourceText: string): void {
    if (points.length === 0) return
    setBookDraft({ points: [...points], sourceText })
    setHistoryOpen(false)
    setArea('compose')
  }

  function finishLearningBook(draft: LearningBookDraftResult): void {
    if (bookDraft === undefined) return
    let bookId: string
    do {
      bookId = `book-${Date.now().toString(36)}-${(bookSequence.current++).toString(36)}`
    } while (learningBooks.some(book => book.bookId === bookId))
    const book = createLearningBook({
      title: draft.title,
      points: draft.points,
      sourceText: bookDraft.sourceText,
    }, { bookId, createdAt: new Date().toISOString() })
    const nextBooks = [book, ...learningBooks]
    setLearningBooks(nextBooks)
    setStorageWarning(writeLearningBooks(persistentSizeStorage, nextBooks)
      ? undefined
      : '学习书已在本次使用中创建，但无法保存；关闭后可能丢失。')
    setNewBookId(book.bookId)
    setBookDraft(undefined)
    setHistoryOpen(false)
    setArea('library')
  }

  function enterLearning(book: LearningBook): void {
    ordinarySize.current = sizeRef.current
    const next = clampWorkbenchSize({ width: 1080, height: viewport.height - 32 }, viewport)
    sizeRef.current = next
    setSize(next)
    setActiveBook(book)
    setHistoryOpen(false)
    setMode('learning')
  }

  function exitLearning(): void {
    const next = clampWorkbenchSize(
      ordinarySize.current ?? defaultWorkbenchSize(screen, viewport), viewport,
    )
    sizeRef.current = next
    setSize(next)
    setMode('workbench')
    setArea('library')
    setActiveBook(undefined)
  }

  function updateCourse(course: LearningCourse): void {
    setLearningBooks(current => {
      const next = current.map(book => book.bookId === course.clientBookId
        ? updateLearningBookCourse(book, course)
        : book)
      writeLearningBooks(persistentSizeStorage, next)
      return next
    })
    setActiveBook(current => current?.bookId === course.clientBookId
      ? updateLearningBookCourse(current, course)
      : current)
  }

  function openArea(next: WorkbenchArea): void {
    setHistoryOpen(false)
    setArea(next)
  }

  function collapsePanel(): void {
    if (mode === 'learning') exitLearning()
    setHistoryOpen(false)
    setExpanded(false)
  }

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
    data-mode={mode}
    data-area={area}
    data-left-open={learningLayout.leftOpen ? 'true' : 'false'}
    data-right-open={learningLayout.rightOpen ? 'true' : 'false'}
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
        {mode === 'workbench' && area !== 'home' && <button type="button"
          aria-label="返回 BetterLearn 首页" onClick={() => openArea('home')}>首页</button>}
        {mode === 'workbench' && area === 'knowledge' && sessionId !== undefined && <button type="button"
          data-testid="betterlearn-history-toggle"
          aria-label={historyOpen ? '收起提取历史' : '展开提取历史'} aria-expanded={historyOpen}
          onClick={() => setHistoryOpen(value => !value)}>历史</button>}
        <strong>{mode === 'learning' ? 'BetterLearn · 学习'
          : area === 'knowledge' ? 'BetterLearn · 知识点'
          : area === 'compose' ? 'BetterLearn · 整理学习书'
          : area === 'library' ? 'BetterLearn · 学习空间' : 'BetterLearn'}</strong>
      </div>
      <button type="button" aria-label="收起 BetterLearn" onClick={collapsePanel}>收起</button>
    </header>
    {mode === 'workbench' && area === 'home'
      ? <BetterLearnGateway bookCount={learningBooks.length} knowledgeAvailable={sessionId !== undefined}
        onOpenKnowledge={() => openArea('knowledge')} onOpenLearning={() => openArea('library')} />
      : null}
    {mode === 'workbench' && area === 'library'
      ? <LearningBookshelf books={learningBooks} newBookId={newBookId} storageWarning={storageWarning}
        onOpenBook={enterLearning}
        onOpenKnowledge={() => openArea('knowledge')} />
      : null}
    {mode === 'workbench' && area === 'compose' && bookDraft !== undefined
      ? <LearningBookComposer points={bookDraft.points} onCreate={finishLearningBook}
        onCancel={() => { setBookDraft(undefined); openArea('knowledge') }} />
      : null}
    {mode === 'learning' && activeBook !== undefined
      ? <LearningSpace book={activeBook} api={clientApi}
        leftOpen={learningLayout.leftOpen} rightOpen={learningLayout.rightOpen}
        onLeftOpenChange={open => updateLearningLayout('leftOpen', open)}
        onRightOpenChange={open => updateLearningLayout('rightOpen', open)}
        onCourseChange={updateCourse}
        onExit={exitLearning} />
      : null}
    {sessionId !== undefined
      ? <div className="betterlearn-floating-workbench"
        hidden={mode === 'learning' || area !== 'knowledge'}>
          <FloatingSessionWorkspace key={sessionId} sessionId={sessionId} ordinarySession={ordinarySession}
            conversations={conversations}
            modelDirectories={modelDirectories} storage={storage} api={clientApi}
            onScreenChange={setScreen} historyOpen={historyOpen}
            onOrganizeLearningBook={organizeLearningBook} />
        </div>
      : null}
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
