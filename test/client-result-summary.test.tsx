import { act, create } from 'react-test-renderer'
import { describe, expect, test, vi } from 'vitest'
import { ResultSummary } from '../src/client/components/ResultSummary.js'
import type { CandidateSnapshot, KnowledgePointSnapshot, RunSnapshot } from '../src/client/types.js'

function run(rawCandidates = 3): RunSnapshot {
  return { runId: 'job_1', documentId: 'doc_1', status: 'completed', stage: 'done', revision: 8,
    retryCount: 0, lastEventSeq: 9,
    counts: { rawCandidates, validCandidates: rawCandidates, pending: 0, accepted: 1,
      editedAndAccepted: 1, rejected: 1, knowledgePoints: rawCandidates === 0 ? 0 : 2 }, error: null,
    modelSelection: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
    document: { filename: '光合作用.md', mediaType: 'text/markdown', byteSize: 6, characterCount: 2, text: '正文' } }
}

const kp: KnowledgePointSnapshot = {
  knowledgePointId: 'kp_1', type: 'concept', title: '正式知识点', statement: '只展示 Core 返回的内容',
  documentId: 'doc_1', evidence: [],
}
const candidates = [{ title: '未被正式接受的候选' }] as CandidateSnapshot[]

describe('phase1d result summary', () => {
  test('shows Core counts, source, and only formal knowledge points', () => {
    const onReset = vi.fn()
    const renderer = create(<ResultSummary run={run()} candidates={candidates}
      knowledgePoints={[kp]} onUpdate={vi.fn()} onReset={onReset} onOrganizeLearningBook={vi.fn()} />)
    const output = JSON.stringify(renderer.toJSON())
    for (const value of ['光合作用.md', '已接受', '已修改', '已拒绝', '正式知识点', '只展示 Core 返回的内容']) {
      expect(output).toContain(value)
    }
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-result-meta' })).toBeDefined()
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-knowledge-list' })).toBeDefined()
    expect(output).not.toContain('未被正式接受的候选')
    act(() => renderer.root.findByProps({ 'data-testid': 'nobei-reset' }).props.onClick())
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  test('treats zero candidates as a normal completed result', () => {
    const renderer = create(<ResultSummary run={run(0)} candidates={[]}
      knowledgePoints={[]} onUpdate={vi.fn()} onReset={vi.fn()} onOrganizeLearningBook={vi.fn()} />)
    expect(JSON.stringify(renderer.toJSON())).toContain('没有发现满足证据要求的候选知识点')
  })

  test('edits a completed point inline and closes only after a successful save', async () => {
    const onUpdate = vi.fn(async () => true)
    const renderer = create(<ResultSummary run={run()} candidates={candidates}
      knowledgePoints={[kp]} onUpdate={onUpdate} onReset={vi.fn()} onOrganizeLearningBook={vi.fn()} />)

    act(() => renderer.root.findByProps({ 'aria-label': '修改“正式知识点”' }).props.onClick())
    const title = renderer.root.findByProps({ 'data-testid': 'nobei-point-title-input' })
    const statement = renderer.root.findByProps({ 'data-testid': 'nobei-point-statement-input' })
    act(() => {
      title.props.onChange({ currentTarget: { value: '修改后的标题' } })
      statement.props.onChange({ currentTarget: { value: '修改后的陈述' } })
    })
    await act(async () => {
      renderer.root.findByProps({ 'data-testid': 'nobei-point-save' }).props.onClick()
      await Promise.resolve()
    })

    expect(onUpdate).toHaveBeenCalledWith(kp, { title: '修改后的标题', statement: '修改后的陈述' })
    expect(renderer.root.findAllByProps({ 'data-testid': 'nobei-point-title-input' })).toHaveLength(0)
  })

  test('keeps the editor open after a failed save and supports cancel', async () => {
    const renderer = create(<ResultSummary run={run()} candidates={candidates}
      knowledgePoints={[kp]} onUpdate={vi.fn(async () => false)} onReset={vi.fn()} onOrganizeLearningBook={vi.fn()} />)
    act(() => renderer.root.findByProps({ 'aria-label': '修改“正式知识点”' }).props.onClick())
    await act(async () => {
      renderer.root.findByProps({ 'data-testid': 'nobei-point-save' }).props.onClick()
      await Promise.resolve()
    })
    expect(renderer.root.findAllByProps({ 'data-testid': 'nobei-point-title-input' })).toHaveLength(1)
    act(() => renderer.root.findByProps({ 'data-testid': 'nobei-point-cancel' }).props.onClick())
    expect(renderer.root.findAllByProps({ 'data-testid': 'nobei-point-title-input' })).toHaveLength(0)
  })

  test('organizes only the selected formal points into a learning book', () => {
    const second = { ...kp, knowledgePointId: 'kp_2', title: '第二个知识点' }
    const onOrganizeLearningBook = vi.fn()
    const renderer = create(<ResultSummary run={run()} candidates={candidates}
      knowledgePoints={[kp, second]} onUpdate={vi.fn()} onReset={vi.fn()}
      onOrganizeLearningBook={onOrganizeLearningBook} />)

    expect(renderer.root.findByProps({ 'data-testid': 'nobei-course-point-kp_1' }).props.checked).toBe(true)
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-course-point-kp_2' }).props.checked).toBe(true)
    act(() => renderer.root.findByProps({ 'data-testid': 'nobei-course-point-kp_1' }).props.onChange())
    act(() => renderer.root.findByProps({ 'data-testid': 'nobei-organize-learning-book' }).props.onClick())

    expect(onOrganizeLearningBook).toHaveBeenCalledWith([second], '正文')
    expect(JSON.stringify(renderer.toJSON())).toContain('整理为学习书')
  })

  test('defaults the master selector to all points and toggles the whole selection', () => {
    const second = { ...kp, knowledgePointId: 'kp_2', title: '第二个知识点' }
    const renderer = create(<ResultSummary run={run()} candidates={candidates}
      knowledgePoints={[kp, second]} onUpdate={vi.fn()} onReset={vi.fn()}
      onOrganizeLearningBook={vi.fn()} />)

    const master = () => renderer.root.findByProps({ 'data-testid': 'nobei-course-select-all' })
    expect(master().props.checked).toBe(true)
    expect(master().props['aria-checked']).toBe(true)
    expect(renderer.root.findByProps({ className: 'nobei-client__knowledge-selection-bar' })
      .findByType('em').children.join('')).toBe('已选择 2 / 2')

    act(() => master().props.onChange())
    expect(master().props.checked).toBe(false)
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-course-point-kp_1' }).props.checked).toBe(false)
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-course-point-kp_2' }).props.checked).toBe(false)
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-organize-learning-book' }).props.disabled).toBe(true)

    act(() => master().props.onChange())
    expect(master().props.checked).toBe(true)
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-course-point-kp_1' }).props.checked).toBe(true)
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-course-point-kp_2' }).props.checked).toBe(true)
  })

  test('shows a mixed master state after the user chooses individual points', () => {
    const second = { ...kp, knowledgePointId: 'kp_2', title: '第二个知识点' }
    const renderer = create(<ResultSummary run={run()} candidates={candidates}
      knowledgePoints={[kp, second]} onUpdate={vi.fn()} onReset={vi.fn()}
      onOrganizeLearningBook={vi.fn()} />)

    act(() => renderer.root.findByProps({ 'data-testid': 'nobei-course-point-kp_1' }).props.onChange())
    const master = renderer.root.findByProps({ 'data-testid': 'nobei-course-select-all' })
    expect(master.props.checked).toBe(false)
    expect(master.props['aria-checked']).toBe('mixed')
    expect(renderer.root.findByProps({ className: 'nobei-client__knowledge-selection-bar' })
      .findByType('em').children.join('')).toBe('已选择 1 / 2')
  })

  test('defaults back to all selected when a different extraction result opens', () => {
    const renderer = create(<ResultSummary run={run()} candidates={candidates}
      knowledgePoints={[kp]} onUpdate={vi.fn()} onReset={vi.fn()}
      onOrganizeLearningBook={vi.fn()} />)
    act(() => renderer.root.findByProps({ 'data-testid': 'nobei-course-select-all' }).props.onChange())
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-course-select-all' }).props.checked).toBe(false)

    const nextPoint = { ...kp, knowledgePointId: 'kp_next', title: '另一份资料的知识点' }
    act(() => renderer.update(<ResultSummary run={{ ...run(), runId: 'job_2' }} candidates={candidates}
      knowledgePoints={[nextPoint]} onUpdate={vi.fn()} onReset={vi.fn()}
      onOrganizeLearningBook={vi.fn()} />))

    expect(renderer.root.findByProps({ 'data-testid': 'nobei-course-select-all' }).props.checked).toBe(true)
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-course-point-kp_next' }).props.checked).toBe(true)
  })
})
