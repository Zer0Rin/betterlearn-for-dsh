import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ProductApiError } from '../src/client/client-api.js'
import { ViewWithDirectory as NobeiClientView, WorkspaceWithDirectory as NobeiWorkspace } from './helpers/model-selection.js'
import { sessionKey, writeSessionState } from '../src/client/session-state.js'
import type { CandidateSnapshot, ClientApi, RunSnapshot } from '../src/client/types.js'

const modelSelection = { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' }
const modelDirectories = {
  directoryFor: vi.fn(() => ({ load: vi.fn(async () => ({ current: modelSelection, routable: true })) })),
}

class MemoryStorage implements Storage {
  #items = new Map<string, string>()
  get length() { return this.#items.size }
  clear() { this.#items.clear() }
  getItem = vi.fn((key: string) => this.#items.get(key) ?? null)
  key(index: number) { return [...this.#items.keys()][index] ?? null }
  removeItem(key: string) { this.#items.delete(key) }
  setItem(key: string, value: string) { this.#items.set(key, value) }
}

function run(status: RunSnapshot['status']): RunSnapshot {
  return { runId: 'job_saved', documentId: 'doc_1', status, stage: 'confirm', revision: 3,
    retryCount: 0, lastEventSeq: 2,
    modelSelection,
    counts: { rawCandidates: 0, validCandidates: 0, pending: 0, accepted: 0,
      editedAndAccepted: 0, rejected: 0, knowledgePoints: 0 }, error: null,
    document: { filename: '细胞生物学.md', mediaType: 'text/markdown', byteSize: 6, characterCount: 2, text: '正文' } }
}

function apiFor(status?: RunSnapshot['status']): ClientApi {
  return {
    importText: vi.fn(), retryRun: vi.fn(), reviewCandidate: vi.fn(),
    getRun: vi.fn(async () => run(status!)),
    listEvents: vi.fn(async (_id, after) => ({ events: [], nextAfter: after })),
    listCandidates: vi.fn(async () => ({ candidates: [] })),
    listKnowledgePoints: vi.fn(async () => ({ knowledgePoints: [] })),
  } as ClientApi
}

const terminalScheduler = {
  async sleep() { await new Promise<void>(() => undefined) },
  isVisible: () => true, async waitUntilVisible() {},
}

async function workspace(status?: RunSnapshot['status']) {
  const storage = new MemoryStorage()
  if (status) writeSessionState(storage, 'session', { version: 1, runId: 'job_saved', lastEventSeq: 0 })
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<NobeiWorkspace sessionId="session" api={apiFor(status)} storage={storage}
      scheduler={terminalScheduler} modelDirectories={modelDirectories} ordinarySession />)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  })
  return renderer
}

afterEach(() => vi.unstubAllGlobals())

describe('phase1d composed workspace', () => {
  test('reflects a DSH model switch in the import card before a new task is created', async () => {
    const listeners = new Set<() => void>()
    let state = { current: modelSelection, routable: true as boolean | null, status: 'ready' as const }
    const directory = {
      store: {
        getSnapshot: () => state,
        subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
      },
      load: vi.fn(async () => ({ current: state.current, routable: state.routable === true })),
    }
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<NobeiWorkspace sessionId="session" api={apiFor()} storage={new MemoryStorage()}
        scheduler={terminalScheduler} modelDirectories={{ directoryFor: () => directory }} ordinarySession />)
      await Promise.resolve(); await Promise.resolve()
    })
    expect(JSON.stringify(renderer.toJSON())).toContain('provider-a / model-a')
    expect(listeners.size).toBe(1)
    await act(async () => {
      state = {
        current: { provider: 'provider-b', model: 'model-b', reasoningEffort: 'low' },
        routable: true,
        status: 'ready',
      }
      for (const listener of listeners) listener()
    })
    expect(JSON.stringify(renderer.toJSON())).toContain('provider-b / model-b · low')
    act(() => renderer.unmount())
    expect(listeners.size).toBe(0)
  })

  test('blocks addressed subagent sessions before resolving a model directory', async () => {
    const directoryFor = vi.fn()
    const api = apiFor()
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<NobeiWorkspace sessionId="child-session" api={api} storage={new MemoryStorage()}
        scheduler={terminalScheduler} modelDirectories={{ directoryFor }} ordinarySession={false} />)
      await Promise.resolve(); await Promise.resolve()
    })
    const output = JSON.stringify(renderer.toJSON())
    expect(output).toContain('子 Agent 会话')
    expect(output).toContain('普通会话')
    expect(directoryFor).not.toHaveBeenCalled()
    expect(api.importText).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  test('preserves pasted text and blocks HTTP when the subscribed model becomes unroutable', async () => {
    const listeners = new Set<() => void>()
    let state = { current: modelSelection, routable: true as boolean | null, status: 'ready' as const }
    const directory = {
      load: vi.fn(async () => ({ current: state.current, routable: state.routable === true })),
      store: {
        getSnapshot: () => state,
        subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
      },
    }
    const api = apiFor()
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<NobeiWorkspace sessionId="session" api={api} storage={new MemoryStorage()}
        scheduler={terminalScheduler} modelDirectories={{ directoryFor: () => directory }} ordinarySession />)
      await Promise.resolve(); await Promise.resolve()
    })
    const pasteTab = renderer.root.findAllByType('button').find(node => node.children.join('') === '粘贴文本')!
    act(() => pasteTab.props.onClick())
    const textarea = () => renderer.root.findByProps({ 'data-testid': 'nobei-paste-text' })
    act(() => textarea().props.onChange({ currentTarget: { value: '模型失败也不能丢失' } }))
    await act(async () => {
      state = { current: modelSelection, routable: false, status: 'ready' }
      listeners.forEach(listener => listener())
    })
    expect(textarea().props.value).toBe('模型失败也不能丢失')
    expect(api.importText).not.toHaveBeenCalled()
    expect(renderer.root.findAllByType('button').find(node => node.children.join('') === '开始提取')?.props.disabled).toBe(true)
    expect(JSON.stringify(renderer.toJSON())).toContain('当前 DSH 模型不可用')
    act(() => renderer.unmount())
  })

  test('keeps a pasted draft and surfaces Core unavailability after a failed import', async () => {
    const storage = new MemoryStorage()
    const api = apiFor()
    api.importText = vi.fn(async () => { throw new ProductApiError(503, 'CORE_UNAVAILABLE') })
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(<NobeiWorkspace sessionId="session" api={api} storage={storage}
        scheduler={terminalScheduler} modelDirectories={modelDirectories} ordinarySession />)
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const pasteTab = renderer.root.findAllByType('button').find(node => node.children.join('') === '粘贴文本')!
    act(() => pasteTab.props.onClick())
    const textarea = () => renderer.root.findByProps({ 'data-testid': 'nobei-paste-text' })
    act(() => textarea().props.onChange({ currentTarget: { value: '不能丢失的正文' } }))
    await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }))
    expect(textarea().props.value).toBe('不能丢失的正文')
    expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('暂时无法连接')
    act(() => renderer.unmount())
  })

  test('keeps the selected candidate and surfaces a failed review', async () => {
    const storage = new MemoryStorage()
    writeSessionState(storage, 'session', { version: 1, runId: 'job_saved', lastEventSeq: 0 })
    const evidence = [{ seq: 0, quote: '正文', textStart: 0, textEnd: 2, contextBefore: '', contextAfter: '' }]
    const candidates: CandidateSnapshot[] = ['a', 'b'].map(id => ({
      candidateId: `cand_${id.repeat(20)}`, type: 'concept', title: `标题${id}`, statement: `陈述${id}`,
      reviewStatus: 'pending', revision: 1, knowledgePointId: null, evidence,
    }))
    const api = apiFor('review_pending')
    api.listCandidates = vi.fn(async () => ({ candidates }))
    api.reviewCandidate = vi.fn(async () => { throw new ProductApiError(503, 'CORE_UNAVAILABLE') })
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<NobeiWorkspace sessionId="session" api={api} storage={storage}
        scheduler={terminalScheduler} modelDirectories={modelDirectories} ordinarySession />)
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    })
    const accept = renderer.root.findAllByType('button').find(node => node.children.join('') === '接受')!
    await act(async () => accept.props.onClick())
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-candidate-title' }).props.value).toBe('标题a')
    await vi.waitFor(() => {
      expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('暂时无法连接')
    })
    const pending = JSON.parse(storage.getItem(sessionKey('session'))!).pendingReview
    api.reviewCandidate = vi.fn(async () => ({
      candidate: { ...candidates[0], reviewStatus: 'accepted' },
      run: run('completed'), knowledgePoint: null,
    }))
    const reconnect = renderer.root.findAllByType('button').find(node => node.children.join('') === '重新连接')!
    expect(reconnect).toBeDefined()
    await act(async () => reconnect.props.onClick())
    await vi.waitFor(() => expect(api.reviewCandidate).toHaveBeenCalledOnce())
    expect(api.reviewCandidate).toHaveBeenCalledWith(candidates[0].candidateId, {
      ...pending.request, idempotencyKey: pending.idempotencyKey,
    }, expect.any(AbortSignal))
    expect(api.retryRun).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  test('renders exactly one import, processing, review, or result screen', async () => {
    const cases = [
      [undefined, 'import'],
      ['generating', 'processing'],
      ['review_pending', 'review'],
      ['completed', 'result'],
    ] as const
    for (const [status, expected] of cases) {
      const renderer = await workspace(status)
      expect(renderer.root.findAll(node => node.props['data-workspace-screen'] !== undefined)).toHaveLength(1)
      expect(renderer.root.findByProps({ 'data-workspace-screen': expected })).toBeDefined()
      expect(renderer.root.findByProps({ 'data-testid': 'nobei-shared-header' })).toBeDefined()
      if (status) expect(JSON.stringify(renderer.toJSON())).toContain('细胞生物学.md')
      act(() => renderer.unmount())
    }
  })

  test('wires the DSH session identity to browser sessionStorage', () => {
    const storage = new MemoryStorage()
    const styles: unknown[] = []
    const fakeDocument = {
      head: { appendChild(node: unknown) { styles.push(node) } },
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => ({ setAttribute() {}, textContent: '' })),
      visibilityState: 'visible',
      addEventListener() {}, removeEventListener() {},
    }
    vi.stubGlobal('window', { sessionStorage: storage, setTimeout, clearTimeout })
    vi.stubGlobal('document', fakeDocument)
    let first!: ReactTestRenderer
    let second!: ReactTestRenderer
    act(() => {
      first = create(<NobeiClientView {...({ sessionId: 'session-a' } as ConvViewProps)}
        modelDirectories={modelDirectories} ordinarySession />)
      second = create(<NobeiClientView {...({ sessionId: 'session-b' } as ConvViewProps)}
        modelDirectories={modelDirectories} ordinarySession />)
    })
    expect(storage.getItem).toHaveBeenCalledWith(sessionKey('session-a'))
    expect(storage.getItem).toHaveBeenCalledWith(sessionKey('session-b'))
    expect(sessionKey('session-a')).not.toBe(sessionKey('session-b'))
    act(() => { first.unmount(); second.unmount() })
  })
})
