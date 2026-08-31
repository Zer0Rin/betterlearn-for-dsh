import { act, create } from 'react-test-renderer'
import { describe, expect, test, vi } from 'vitest'
import { RunProgress } from '../src/client/components/RunProgress.js'
import type { RunSnapshot, RunStatus } from '../src/client/types.js'

function run(status: RunStatus): RunSnapshot {
  return {
    runId: 'job_secret', documentId: 'doc_secret', status, stage: 'internal_stage',
    revision: 99, retryCount: status === 'failed_terminal' ? 1 : 0, lastEventSeq: 4,
    counts: { rawCandidates: 0, validCandidates: 0, pending: 0, accepted: 0,
      editedAndAccepted: 0, rejected: 0, knowledgePoints: 0 },
    modelSelection: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
    error: status.startsWith('failed') ? { code: 'INTERNAL_CODE', retryable: status === 'failed_retryable' } : null,
    document: { filename: '教材.md', mediaType: 'text/markdown', byteSize: 6, characterCount: 2, text: '正文' },
  }
}

function text(status: RunStatus) {
  const renderer = create(<RunProgress run={run(status)} busy={false} serviceUnavailable={false}
    onRetry={vi.fn()} onReload={vi.fn()} onReset={vi.fn()} />)
  return JSON.stringify(renderer.toJSON())
}

describe('phase1d run progress', () => {
  test('shows batch progress and actual response time, not a made-up heartbeat', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-31T08:00:00Z'))
    const props = { run: run('generating'), busy: false, serviceUnavailable: false,
      onRetry: vi.fn(), onReload: vi.fn(), onReset: vi.fn(),
      progress: { phase: 'extracting' as const, completedBatches: 2, totalBatches: 4,
        startedAt: Date.now() - 60000, lastResponseAt: null as number | null } }
    let renderer!: ReturnType<typeof create>
    act(() => { renderer = create(<RunProgress {...props} />) })
    const content = () => renderer.root.findByProps({ 'data-testid': 'nobei-generation-detail' }).findAllByType('p').map(p => p.children.join('')).join(' ')
    expect(content()).toContain('正在提取第 3 / 4 批')
    expect(content()).toContain('尚未收到模型响应')
    act(() => renderer.update(<RunProgress {...props} progress={{ ...props.progress, lastResponseAt: Date.now() }} />))
    expect(content()).toContain('0 秒前')
    act(() => vi.advanceTimersByTime(35000))
    expect(content()).toContain('35 秒前')
    expect(content()).toContain('暂未收到新数据')
    act(() => renderer.update(<RunProgress {...props} progress={{ ...props.progress, totalBatches: null }} />))
    expect(content()).toContain('总批数规划中')
    act(() => renderer.update(<RunProgress {...props} run={run('failed_retryable')} />))
    expect(renderer.root.findAllByProps({ 'data-testid': 'nobei-generation-detail' })).toHaveLength(0)
    act(() => renderer.unmount()); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers()
  })

  test.each(['failed_retryable', 'failed_terminal'] as const)('explains the output limit in %s without starting another call', (status) => {
    const snapshot = run(status)
    snapshot.error = { code: 'GENERATION_OUTPUT_LIMIT', retryable: status === 'failed_retryable' }
    const onRetry = vi.fn()
    const renderer = create(<RunProgress run={snapshot} busy={false} serviceUnavailable={false}
      onRetry={onRetry} onReload={vi.fn()} onReset={vi.fn()} />)
    const output = JSON.stringify(renderer.toJSON())
    expect(output).toContain('达到单次输出上限')
    expect(output).toContain('推理也占用此上限')
    expect(output).toContain('提取已停止')
    expect(output).not.toContain('正在生成候选')
    expect(onRetry).not.toHaveBeenCalled()
    renderer.unmount()
  })

  test('explains historical no-output failures without claiming every one was a token limit', () => {
    const snapshot = run('failed_retryable')
    snapshot.error = { code: 'GENERATION_NO_OUTPUT', retryable: true }
    const renderer = create(<RunProgress run={snapshot} busy={false} serviceUnavailable={false}
      onRetry={vi.fn()} onReload={vi.fn()} onReset={vi.fn()} />)
    expect(JSON.stringify(renderer.toJSON())).toContain('未收到可用的结构化结果')
    renderer.unmount()
  })
  test('reloads the long-document call budget before enabling an explicit retry', async () => {
    vi.useFakeTimers()
    const snapshot = run('failed_retryable')
    snapshot.document = { ...snapshot.document, text: 'x'.repeat(9000), byteSize: 9000, characterCount: 9000 }
    const previewDocument = vi.fn(async () => ({ ...snapshot.document, pages: [], extractionPlan: { strategy: 'L2' as const, maxCalls: 4 } }))
    const onRetry = vi.fn()
    let renderer!: ReturnType<typeof create>
    act(() => { renderer = create(<RunProgress run={snapshot} busy={false} serviceUnavailable={false}
      onRetry={onRetry} onReload={vi.fn()} onReset={vi.fn()} previewDocument={previewDocument} />) })
    try {
      expect(renderer.root.findByType('button').props.disabled).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(JSON.stringify(renderer.toJSON())).toContain('最多再发起 4 次模型调用')
      expect(renderer.root.findByType('button').props.disabled).toBe(false)
      expect(onRetry).not.toHaveBeenCalled()
      act(() => renderer.root.findByType('button').props.onClick())
      expect(onRetry).toHaveBeenCalledOnce()
    } finally { act(() => renderer.unmount()); vi.useRealTimers() }
  })
  test('shows only persisted user-facing phase copy', () => {
    expect(text('generating')).toContain('正在生成候选')
    expect(text('validating')).toContain('正在校验证据')
    expect(text('review_pending')).toContain('等待审核')
    for (const output of [text('generating'), text('validating'), text('review_pending')]) {
      expect(output).toContain('文档已保存')
      expect(output).not.toMatch(/%|预计|ETA|internal_stage|revision|JSON-RPC|job_secret|doc_secret/)
    }
  })

  test('offers only the recovery action appropriate to the current fact', () => {
    let renderer = create(<RunProgress run={run('failed_retryable')} busy={false} serviceUnavailable={false}
      onRetry={vi.fn()} onReload={vi.fn()} onReset={vi.fn()} />)
    expect(JSON.stringify(renderer.toJSON())).toContain('重新提取')
    expect(JSON.stringify(renderer.toJSON())).toContain('仍使用创建时的模型')
    expect(JSON.stringify(renderer.toJSON())).toContain('再发起 1 次模型调用')
    act(() => renderer.update(<RunProgress run={run('failed_terminal')} busy={false} serviceUnavailable={false}
      onRetry={vi.fn()} onReload={vi.fn()} onReset={vi.fn()} />))
    expect(JSON.stringify(renderer.toJSON())).toContain('返回导入')
    expect(JSON.stringify(renderer.toJSON())).not.toContain('材料需要调整')
    act(() => renderer.update(<RunProgress run={run('generating')} busy={false} serviceUnavailable
      onRetry={vi.fn()} onReload={vi.fn()} onReset={vi.fn()} />))
    expect(JSON.stringify(renderer.toJSON())).toContain('暂时无法连接')
    expect(JSON.stringify(renderer.toJSON())).toContain('不会重新提取或调用模型')
    expect(JSON.stringify(renderer.toJSON())).toContain('重新连接')
  })
})


test('transient plan preview failure can be retried without invoking extraction', async () => {
  vi.useFakeTimers()
  const snapshot = run('failed_retryable')
  snapshot.document = { ...snapshot.document, text: 'x'.repeat(9000), byteSize: 9000, characterCount: 9000 }
  const previewDocument = vi.fn()
    .mockRejectedValueOnce(new Error('CORE_UNAVAILABLE'))
    .mockResolvedValueOnce({ ...snapshot.document, pages: [], extractionPlan: { strategy: 'L2', maxCalls: 4 } })
  const onRetry = vi.fn()
  let renderer!: ReturnType<typeof create>
  act(() => { renderer = create(<RunProgress run={snapshot} busy={false} serviceUnavailable={false}
    onRetry={onRetry} onReload={vi.fn()} onReset={vi.fn()} previewDocument={previewDocument} />) })
  const extractionButton = () => renderer.root.findAllByType('button').find(button => button.children.includes('重新提取'))!
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(previewDocument).toHaveBeenCalledTimes(1)
    expect(extractionButton().props.disabled).toBe(true)
    const refresh = renderer.root.findAllByType('button').find(button => button.children.includes('重新读取提取计划'))!
    expect(refresh.props.disabled).toBeFalsy()
    act(() => refresh.props.onClick())
    expect(extractionButton().props.disabled).toBe(true)
    expect(onRetry).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(previewDocument).toHaveBeenCalledTimes(2)
    expect(previewDocument.mock.calls[1][0]).toEqual(previewDocument.mock.calls[0][0])
    expect(extractionButton().props.disabled).toBe(false)
    expect(JSON.stringify(renderer.toJSON())).toContain('最多再发起 4 次模型调用')
    expect(onRetry).not.toHaveBeenCalled()
    act(() => extractionButton().props.onClick())
    expect(onRetry).toHaveBeenCalledOnce()
  } finally { act(() => renderer.unmount()); vi.useRealTimers() }
})
