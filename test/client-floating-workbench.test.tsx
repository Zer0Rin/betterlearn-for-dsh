import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { BetterLearnFloatingApp } from '../src/client/floating-workbench.js'
import type { ClientApi } from '../src/client/types.js'

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
  }
}

const storage = {
  length: 0,
  clear() {}, getItem: vi.fn(() => null), key: () => null, removeItem() {}, setItem: vi.fn(),
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

  beforeEach(() => {
    keydown = undefined
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
    vi.stubGlobal('window', { setTimeout, clearTimeout })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    vi.unstubAllGlobals()
  })

  function renderEmpty() {
    const source = sessionSource()
    act(() => {
      renderer = create(<BetterLearnFloatingApp sessions={{ list: source, subagentAddress: () => undefined } as never}
        modelDirectories={{} as never} storage={storage as never} />)
    })
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
})
