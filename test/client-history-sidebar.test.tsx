import { act, create } from 'react-test-renderer'
import { describe, expect, test, vi } from 'vitest'
import { HistorySidebar } from '../src/client/components/HistorySidebar.js'
import type { RunHistorySummary } from '../src/client/types.js'


function summary(
  runId: string,
  sourceLabel: string,
  status: RunHistorySummary['status'],
  candidateCount = 4,
  knowledgePointCount = 2,
): RunHistorySummary {
  return {
    runId,
    sourceType: 'document',
    sourceLabel,
    status,
    stage: 'extract',
    updatedAt: '2026-09-01T08:30:00Z',
    candidateCount,
    knowledgePointCount,
  }
}


describe('BetterLearn extraction history sidebar', () => {
  test('renders all user statuses, counts, time, and current selection', () => {
    const runs = [
      summary('job_processing', '处理中.md', 'generating'),
      summary('job_review', '待审查.md', 'review_pending'),
      summary('job_done', '已完成.md', 'completed', 7, 5),
      summary('job_failed', '失败.md', 'failed_terminal'),
    ]

    const renderer = create(<HistorySidebar runs={runs} currentRunId="job_done"
      loading={false} onRetry={vi.fn()} onSelect={vi.fn()} onNew={vi.fn()} />)
    const output = JSON.stringify(renderer.toJSON())

    for (const value of ['处理中', '待审查', '已完成', '失败', '2026-09-01', '候选 7', '知识点 5']) {
      expect(output).toContain(value)
    }
    expect(renderer.root.findByProps({ 'data-run-id': 'job_done' }).props['aria-current']).toBe('true')
  })

  test('maps pre-generation states to processing and retryable failures to failed', () => {
    const runs = [
      summary('job_created', '刚创建.md', 'created'),
      summary('job_ready', '已解析.md', 'document_ready'),
      summary('job_waiting', '等待生成.md', 'awaiting_generation'),
      summary('job_retryable', '可重试.md', 'failed_retryable'),
    ]
    const output = JSON.stringify(create(<HistorySidebar runs={runs} loading={false}
      onRetry={vi.fn()} onSelect={vi.fn()} onNew={vi.fn()} />).toJSON())
    expect(output.match(/处理中/g)).toHaveLength(3)
    expect(output).toContain('失败')
  })

  test('keeps loading, empty, and error states local to the sidebar', () => {
    const loading = create(<HistorySidebar runs={[]} loading onRetry={vi.fn()}
      onSelect={vi.fn()} onNew={vi.fn()} />)
    expect(JSON.stringify(loading.toJSON())).toContain('正在读取历史记录')

    const empty = create(<HistorySidebar runs={[]} loading={false} onRetry={vi.fn()}
      onSelect={vi.fn()} onNew={vi.fn()} />)
    expect(JSON.stringify(empty.toJSON())).toContain('还没有提取记录')

    const retry = vi.fn()
    const failed = create(<HistorySidebar runs={[]} loading={false} error="历史记录加载失败"
      onRetry={retry} onSelect={vi.fn()} onNew={vi.fn()} />)
    expect(JSON.stringify(failed.toJSON())).toContain('历史记录加载失败')
    act(() => failed.root.findByProps({ 'data-testid': 'history-retry' }).props.onClick())
    expect(retry).toHaveBeenCalledOnce()
  })

  test('reports run selection and new extraction without issuing requests', () => {
    const select = vi.fn()
    const createNew = vi.fn()
    const renderer = create(<HistorySidebar runs={[summary('job_1', '课程.md', 'completed')]}
      loading={false} onRetry={vi.fn()} onSelect={select} onNew={createNew} />)

    act(() => renderer.root.findByProps({ 'data-run-id': 'job_1' }).props.onClick())
    act(() => renderer.root.findByProps({ 'data-testid': 'history-new' }).props.onClick())

    expect(select).toHaveBeenCalledWith('job_1')
    expect(createNew).toHaveBeenCalledOnce()
  })

  test('offers confirmed deletion only for inactive runs', async () => {
    const onDelete = vi.fn(async () => true)
    const renderer = create(<HistorySidebar runs={[
      summary('job_active', '正在提取.md', 'generating'),
      summary('job_review', '待审查.md', 'review_pending'),
      summary('job_done', '已完成.md', 'completed'),
      summary('job_failed', '失败.md', 'failed_retryable'),
    ]} loading={false} onRetry={vi.fn()} onSelect={vi.fn()} onNew={vi.fn()} onDelete={onDelete} />)

    expect(renderer.root.findAllByProps({ 'data-testid': 'history-delete-job_active' })).toHaveLength(0)
    expect(renderer.root.findAll(node => typeof node.props['data-testid'] === 'string'
      && node.props['data-testid'].startsWith('history-delete-job_'))).toHaveLength(3)
    act(() => renderer.root.findByProps({ 'data-testid': 'history-delete-job_done' }).props.onClick())
    expect(renderer.root.findByProps({ className: 'nobei-history__confirm' }).findByType('p').children.join(''))
      .toContain('确认删除“已完成.md”')
    act(() => renderer.root.findByProps({ 'data-testid': 'history-delete-cancel' }).props.onClick())
    expect(onDelete).not.toHaveBeenCalled()

    act(() => renderer.root.findByProps({ 'data-testid': 'history-delete-job_done' }).props.onClick())
    await act(async () => {
      renderer.root.findByProps({ 'data-testid': 'history-delete-confirm' }).props.onClick()
      await Promise.resolve()
    })
    expect(onDelete).toHaveBeenCalledWith('job_done')
  })
})
