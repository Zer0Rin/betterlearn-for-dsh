import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { BetterLearnFloatingApp } from '../src/client/floating-workbench.js'
import { LEARNING_LAYOUT_STORAGE_KEY } from '../src/client/learning-layout.js'
import { sessionKey } from '../src/client/session-state.js'
import type { ClientApi, KnowledgePointSnapshot, RunSnapshot } from '../src/client/types.js'
import { WORKBENCH_SIZE_STORAGE_KEY } from '../src/client/workbench-size.js'

interface SessionSnapshot {
  ids: string[]
  byId: Record<string, unknown>
  current?: string
  phase: 'ready'
  subagentsByParent: Record<string, unknown>
  jobsBySession: Record<string, unknown>
  currentAddress?: unknown
}

function sessionSource(current?: string) {
  let snapshot: SessionSnapshot = {
    ids: current ? [current] : [], byId: {}, current, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    setCurrent(next?: string) {
      snapshot = { ...snapshot, ids: next ? [next] : [], current: next }
      listeners.forEach(listener => listener())
    },
    setRows(ids: string[], byId: Record<string, unknown>, current = snapshot.current) {
      snapshot = { ...snapshot, ids, byId, current }
      listeners.forEach(listener => listener())
    },
  }
}

const storage = {
  length: 0,
  clear() {}, getItem: vi.fn(() => null), key: () => null, removeItem() {}, setItem: vi.fn(),
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

const api = {
  listRuns: vi.fn(async () => ({ runs: [] })),
  importText: vi.fn(), retryRun: vi.fn(), reviewCandidate: vi.fn(),
  getRun: vi.fn(), listEvents: vi.fn(), listCandidates: vi.fn(), listKnowledgePoints: vi.fn(),
} as unknown as ClientApi

const modelDirectoryState = {
  current: { provider: 'provider-a', model: 'model-a' }, routable: true, status: 'ready' as const,
}
const modelDirectories = {
  directoryFor: vi.fn(() => ({
    load: vi.fn(async () => ({ current: modelDirectoryState.current, routable: true })),
    store: { getSnapshot: () => modelDirectoryState, subscribe: () => () => undefined },
  })),
}

describe('BetterLearn floating workbench shell', () => {
  let keydown: ((event: { key: string }) => void) | undefined
  let renderer: ReactTestRenderer
  let windowListeners: Map<string, Set<(event: Record<string, unknown>) => void>>

  beforeEach(() => {
    keydown = undefined
    windowListeners = new Map()
    storage.getItem.mockClear()
    storage.setItem.mockClear()
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener(type: string, listener: (event: { key: string }) => void) {
        if (type === 'keydown') keydown = listener
      },
      removeEventListener(type: string, listener: (event: { key: string }) => void) {
        if (type === 'keydown' && keydown === listener) keydown = undefined
      },
    })
    vi.stubGlobal('window', {
      innerWidth: 1440,
      innerHeight: 900,
      setTimeout,
      clearTimeout,
      localStorage: new MemoryStorage(),
      addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
        const listeners = windowListeners.get(type) ?? new Set()
        listeners.add(listener)
        windowListeners.set(type, listeners)
      },
      removeEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
        windowListeners.get(type)?.delete(listener)
      },
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    vi.unstubAllGlobals()
  })

  function renderEmpty(sizeStorage = new MemoryStorage()) {
    const source = sessionSource()
    act(() => {
      renderer = create(<BetterLearnFloatingApp sessions={{ list: source, subagentAddress: () => undefined } as never}
        modelDirectories={{} as never} storage={storage as never} sizeStorage={sizeStorage} />)
    })
    return { source, sizeStorage }
  }

  function dispatchWindow(type: string, event: Record<string, unknown>) {
    for (const listener of windowListeners.get(type) ?? []) listener(event)
  }

  test('starts collapsed and opens from the BetterLearn launcher', () => {
    renderEmpty()
    const launcher = renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' })
    expect(launcher.props['aria-expanded']).toBe(false)

    act(() => launcher.props.onClick())

    expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' })).toBeDefined()
    expect(renderer.root.findAllByProps({ 'data-testid': 'betterlearn-launcher' })).toHaveLength(0)
  })

  test('collapses an open panel on Escape', () => {
    renderEmpty()
    act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' }).props.onClick())
    expect(keydown).toBeTypeOf('function')

    act(() => keydown?.({ key: 'Escape' }))

    expect(renderer.root.findAllByProps({ 'data-testid': 'betterlearn-floating-panel' })).toHaveLength(0)
    expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' })).toBeDefined()
  })

  test('shows guidance without a current DSH session', () => {
    renderEmpty()
    act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' }).props.onClick())

    expect(JSON.stringify(renderer.toJSON())).toContain('先在 DSH 创建或选择普通会话')
    expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' }).props['data-screen']).toBe('empty')
    expect(storage.getItem).not.toHaveBeenCalled()
  })

  test('binds the expanded workbench to the current DSH session', async () => {
    const source = sessionSource('session-a')
    const sessions = { list: source, subagentAddress: () => undefined }
    await act(async () => {
      renderer = create(<BetterLearnFloatingApp sessions={sessions as never}
        modelDirectories={modelDirectories} storage={storage as never} api={api} />)
      await Promise.resolve()
    })
    act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' }).props.onClick())
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(storage.getItem).toHaveBeenCalledWith('nobei:phase1d:session:session-a')

    await act(async () => {
      source.setCurrent('session-b')
      await Promise.resolve(); await Promise.resolve()
    })

    expect(storage.getItem).toHaveBeenCalledWith('nobei:phase1d:session:session-b')
  })

  test('projects refreshed ordinary session rows into the DSH conversation selector', async () => {
    const source = sessionSource('current')
    source.setRows(['current', 'ordinary', 'blank', 'child', 'addressed'], {
      current: { id: 'current', displayTitle: '当前对话', blank: false, updatedAt: 5 },
      ordinary: { id: 'ordinary', displayTitle: '普通历史', blank: false, updatedAt: 4 },
      blank: { id: 'blank', displayTitle: '新对话', blank: true, updatedAt: 3 },
      child: { id: 'child', displayTitle: '内部子任务', blank: false, origin: 'subagent', updatedAt: 2 },
      addressed: { id: 'addressed', displayTitle: '地址子任务', blank: false, updatedAt: 1 },
    })
    const sessions = {
      list: source,
      subagentAddress: (id: string) => id === 'addressed' ? { parentSessionId: 'current', childSessionId: id } : undefined,
    }
    await act(async () => {
      renderer = create(<BetterLearnFloatingApp sessions={sessions as never}
        modelDirectories={modelDirectories} storage={storage as never} api={api} />)
      await Promise.resolve()
    })
    act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' }).props.onClick())
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    act(() => renderer.root.findByProps({ 'aria-label': '从 DSH 对话提取' }).props.onClick())
    let output = JSON.stringify(renderer.toJSON())
    expect(output).toContain('当前对话')
    expect(output).toContain('普通历史')
    expect(output).not.toContain('新对话')
    expect(output).not.toContain('内部子任务')
    expect(output).not.toContain('地址子任务')

    await act(async () => {
      source.setRows(['current', 'new'], {
        current: { id: 'current', displayTitle: '当前对话', blank: false, updatedAt: 6 },
        new: { id: 'new', displayTitle: '刚刚完成的对话', blank: false, updatedAt: 5 },
      })
      await Promise.resolve()
    })
    output = JSON.stringify(renderer.toJSON())
    expect(output).toContain('刚刚完成的对话')
    expect(output).not.toContain('普通历史')
  })

  test('keeps history collapsed by default, expands it independently, and resets it with the panel', async () => {
    const source = sessionSource('session-a')
    await act(async () => {
      renderer = create(<BetterLearnFloatingApp
        sessions={{ list: source, subagentAddress: () => undefined } as never}
        modelDirectories={modelDirectories} storage={storage as never} api={api} />)
    })
    act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' }).props.onClick())
    let panel = renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' })
    expect(panel.props['data-history-open']).toBe('false')

    await act(async () => {
      renderer.root.findByProps({ 'data-testid': 'betterlearn-history-toggle' }).props.onClick()
      await Promise.resolve(); await Promise.resolve()
    })
    panel = renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' })
    expect(panel.props['data-history-open']).toBe('true')
    expect(api.listRuns).toHaveBeenCalled()

    act(() => renderer.root.findByProps({ 'aria-label': '收起 BetterLearn' }).props.onClick())
    act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' }).props.onClick())
    expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' })
      .props['data-history-open']).toBe('false')
  })

  test('renders three anchored resize handles and persists a left-edge resize', () => {
    const { sizeStorage } = renderEmpty()
    act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' }).props.onClick())
    let panel = renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' })
    expect(panel.props.style).toMatchObject({
      '--betterlearn-user-width': '420px',
      '--betterlearn-user-height': '420px',
    })
    expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-resize-bottom' })).toBeDefined()
    expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-resize-corner' })).toBeDefined()

    const setPointerCapture = vi.fn()
    act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-resize-left' }).props.onPointerDown({
      clientX: 600, clientY: 100, pointerId: 7,
      preventDefault: vi.fn(), currentTarget: { setPointerCapture },
    }))
    expect(setPointerCapture).toHaveBeenCalledWith(7)
    act(() => dispatchWindow('pointermove', { clientX: 520, clientY: 100, pointerId: 7 }))
    panel = renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' })
    expect(panel.props.style['--betterlearn-user-width']).toBe('500px')
    expect(panel.props.style['--betterlearn-user-height']).toBe('420px')
    expect(panel.props['data-resizing']).toBe('true')

    act(() => dispatchWindow('pointerup', { clientX: 520, clientY: 100, pointerId: 7 }))
    expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' })
      .props['data-resizing']).toBe('false')
    expect(JSON.parse(sizeStorage.getItem(WORKBENCH_SIZE_STORAGE_KEY) ?? '{}').empty)
      .toEqual({ width: 500, height: 420 })
  })

  test('marks the panel compact only while its height is 420px or less', () => {
    renderEmpty()
    act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' }).props.onClick())
    expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' })
      .props['data-compact-height']).toBe('true')

    act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-resize-bottom' }).props.onPointerDown({
      clientX: 600, clientY: 500, pointerId: 8,
      preventDefault: vi.fn(), currentTarget: { setPointerCapture: vi.fn() },
    }))
    act(() => dispatchWindow('pointermove', { clientX: 600, clientY: 580, pointerId: 8 }))

    expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' })
      .props['data-compact-height']).toBe('false')
  })

  test('restores sizes independently when the workbench screen changes', async () => {
    const sizeStorage = new MemoryStorage()
    sizeStorage.setItem(WORKBENCH_SIZE_STORAGE_KEY, JSON.stringify({
      empty: { width: 390, height: 440 },
      import: { width: 520, height: 680 },
    }))
    const source = sessionSource()
    await act(async () => {
      renderer = create(<BetterLearnFloatingApp
        sessions={{ list: source, subagentAddress: () => undefined } as never}
        modelDirectories={modelDirectories} storage={storage as never} sizeStorage={sizeStorage} api={api} />)
    })
    act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' }).props.onClick())
    expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' }).props.style)
      .toMatchObject({ '--betterlearn-user-width': '390px', '--betterlearn-user-height': '440px' })

    await act(async () => {
      source.setCurrent('session-a')
      await Promise.resolve(); await Promise.resolve()
    })
    expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' }).props.style)
      .toMatchObject({ '--betterlearn-user-width': '520px', '--betterlearn-user-height': '680px' })
  })

  test('opens a selected result as an expanded learning mode and restores the ordinary size', async () => {
    const sessionStorage = new MemoryStorage()
    sessionStorage.setItem(sessionKey('session-a'), JSON.stringify({
      version: 1, runId: 'job_saved', lastEventSeq: 0,
    }))
    const sizeStorage = new MemoryStorage()
    sizeStorage.setItem(WORKBENCH_SIZE_STORAGE_KEY, JSON.stringify({ result: { width: 460, height: 720 } }))
    const snapshot: RunSnapshot = {
      runId: 'job_saved', documentId: 'doc_1', status: 'completed', stage: 'done', revision: 4,
      retryCount: 0, lastEventSeq: 2, modelSelection: { provider: 'provider-a', model: 'model-a' },
      counts: { rawCandidates: 1, validCandidates: 1, pending: 0, accepted: 1,
        editedAndAccepted: 0, rejected: 0, knowledgePoints: 1 }, error: null,
      document: { filename: '闭包.md', mediaType: 'text/markdown', byteSize: 30,
        characterCount: 16, text: '内部函数保留对词法环境的引用。' },
    }
    const point: KnowledgePointSnapshot = {
      knowledgePointId: 'kp_closure', documentId: 'doc_1', type: 'concept', title: '闭包',
      statement: '闭包由函数及其词法环境构成。',
      evidence: [{ seq: 0, quote: '内部函数保留对词法环境的引用', textStart: 0, textEnd: 15,
        contextBefore: '', contextAfter: '。' }],
    }
    const resultApi = {
      listRuns: vi.fn(async () => ({ runs: [] })),
      importText: vi.fn(), retryRun: vi.fn(), reviewCandidate: vi.fn(),
      getRun: vi.fn(async () => snapshot),
      listEvents: vi.fn(async (_runId: string, after: number) => ({ events: [], nextAfter: after })),
      listCandidates: vi.fn(async () => ({ candidates: [] })),
      listKnowledgePoints: vi.fn(async () => ({ knowledgePoints: [point] })),
    } as unknown as ClientApi
    const source = sessionSource('session-a')

    await act(async () => {
      renderer = create(<BetterLearnFloatingApp
        sessions={{ list: source, subagentAddress: () => undefined } as never}
        modelDirectories={modelDirectories} storage={sessionStorage} sizeStorage={sizeStorage} api={resultApi} />)
    })
    act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' }).props.onClick())
    await vi.waitFor(() => expect(renderer.root.findByProps({ 'data-screen': 'result' })).toBeDefined())
    expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' }).props.style)
      .toMatchObject({ '--betterlearn-user-width': '460px', '--betterlearn-user-height': '720px' })

    act(() => renderer.root.findByProps({ 'data-testid': 'nobei-start-learning' }).props.onClick())

    let panel = renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' })
    expect(panel.props['data-mode']).toBe('learning')
    expect(panel.props.style).toMatchObject({
      '--betterlearn-user-width': '1080px', '--betterlearn-user-height': '868px',
    })
    expect(renderer.root.findByProps({ 'data-testid': 'learning-lesson' })).toBeDefined()
    expect(renderer.root.findAllByProps({ 'data-testid': 'betterlearn-history-toggle' })).toHaveLength(0)

    act(() => renderer.root.findByProps({ 'aria-label': '收起课程路径' }).props.onClick())
    expect(JSON.parse(sizeStorage.getItem(LEARNING_LAYOUT_STORAGE_KEY)!)).toMatchObject({ leftOpen: false })

    act(() => renderer.root.findByProps({ 'aria-label': '返回普通工作台' }).props.onClick())
    panel = renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' })
    expect(panel.props['data-mode']).toBe('workbench')
    expect(panel.props.style).toMatchObject({
      '--betterlearn-user-width': '460px', '--betterlearn-user-height': '720px',
    })
    expect(JSON.parse(sizeStorage.getItem(WORKBENCH_SIZE_STORAGE_KEY)!).result)
      .toEqual({ width: 460, height: 720 })
  })
})
