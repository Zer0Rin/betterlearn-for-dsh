import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, test, vi } from 'vitest'
import { EvidenceReader } from '../src/client/components/EvidenceReader.js'
import { ReviewWorkspace } from '../src/client/components/ReviewWorkspace.js'
import type { CandidateSnapshot, EvidenceSpan, RunSnapshot } from '../src/client/types.js'

const documentText = '第一句是证据。第二句也是证据。'
const evidence: EvidenceSpan[] = [
  { seq: 0, quote: '第一句是证据。', textStart: 0, textEnd: 7, contextBefore: '', contextAfter: '第二句' },
  { seq: 1, quote: '第二句也是证据。', textStart: 7, textEnd: 15, contextBefore: '第一句', contextAfter: '' },
]

function candidate(id: string, status: CandidateSnapshot['reviewStatus'] = 'pending'): CandidateSnapshot {
  return { candidateId: id, type: 'concept', title: `标题${id}`, statement: `陈述${id}`,
    reviewStatus: status, revision: 1, knowledgePointId: null, evidence }
}

function run(): RunSnapshot {
  return { runId: 'job_1', documentId: 'doc_1', status: 'review_pending', stage: 'confirm', revision: 4,
    retryCount: 0, lastEventSeq: 5,
    counts: { rawCandidates: 4, validCandidates: 4, pending: 1, accepted: 1,
      editedAndAccepted: 1, rejected: 1, knowledgePoints: 2 }, error: null,
    modelSelection: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
    document: { filename: '教材.md', mediaType: 'text/markdown', byteSize: 48,
      characterCount: documentText.length, text: documentText } }
}

function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.findAllByType('button').find(node => node.children.join('') === label)!
}

describe('phase1d review workspace', () => {
  test('defaults to the first pending candidate and labels every Core review status', () => {
    const candidates = [candidate('accepted', 'accepted'), candidate('pending'),
      candidate('edited', 'edited_and_accepted'), candidate('rejected', 'rejected')]
    const renderer = create(<ReviewWorkspace run={run()} candidates={candidates}
      onSelect={vi.fn()} onReview={vi.fn()} />)
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-candidate-title' }).props.value).toBe('标题pending')
    const output = JSON.stringify(renderer.toJSON())
    for (const label of ['待审核', '已接受', '已修改', '已拒绝']) expect(output).toContain(label)
    expect(output).not.toContain('全部接受')
  })

  test('keeps title and statement read-only until edit mode and cancel restores Core values', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(<ReviewWorkspace run={run()} candidates={[candidate('a')]}
        onSelect={vi.fn()} onReview={vi.fn()} />)
    })
    const title = () => renderer.root.findByProps({ 'data-testid': 'nobei-candidate-title' })
    const statement = () => renderer.root.findByProps({ 'data-testid': 'nobei-candidate-statement' })
    expect(title().props.readOnly).toBe(true)
    expect(statement().props.readOnly).toBe(true)
    act(() => button(renderer, '修改后接受').props.onClick())
    expect(title().props.readOnly).toBe(false)
    act(() => {
      title().props.onChange({ currentTarget: { value: '' } })
      statement().props.onChange({ currentTarget: { value: '新陈述' } })
    })
    expect(button(renderer, '保存并接受').props.disabled).toBe(true)
    act(() => button(renderer, '取消修改').props.onClick())
    expect(title().props.value).toBe('标题a')
    expect(statement().props.value).toBe('陈述a')
    expect(renderer.root.findAll(node => node.props['data-evidence-seq'] !== undefined
      && (node.type === 'input' || node.type === 'textarea'))).toEqual([])
  })

  test('submits one action and advances to the next pending candidate', async () => {
    const onReview = vi.fn(async () => true)
    const onSelect = vi.fn()
    const renderer = create(<ReviewWorkspace run={run()} candidates={[candidate('a'), candidate('b')]}
      activeCandidateId="a" onSelect={onSelect} onReview={onReview} />)
    await act(async () => button(renderer, '接受').props.onClick())
    expect(onReview).toHaveBeenCalledTimes(1)
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ candidateId: 'a' }), { action: 'accept' })
    expect(onSelect).toHaveBeenCalledWith('b')
  })

  test('renders the exact source and scrolls only its pane to clicked evidence', () => {
    const scrollIntoView = vi.fn()
    const pane = { scrollTop: 0, clientHeight: 200, getBoundingClientRect: () => ({ top: 50 }) }
    const renderer = create(<EvidenceReader text={documentText} evidence={evidence} />, {
      createNodeMock(element) {
        if (element.type === 'mark') return { scrollIntoView, getBoundingClientRect: () => ({ top: 350 }) }
        return element.props['data-testid'] === 'nobei-source-text' ? pane : null
      },
    })
    pane.scrollTop = 0
    act(() => button(renderer, '证据 2').props.onClick())
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(pane.scrollTop).toBeGreaterThan(0)
    const source = renderer.root.findByProps({ 'data-testid': 'nobei-source-text' })
    function flatten(node: ReactTestInstance | string): string {
      return typeof node === 'string' ? node : node.children.map(child => flatten(child)).join('')
    }
    expect(flatten(source)).toBe(documentText)
    expect(source.findByType('mark').props.className).toContain('nobei-client__evidence-flash')
  })

  test('keeps the current candidate and shows an error when review fails', async () => {
    const onReview = vi.fn(async () => false)
    const onSelect = vi.fn()
    const renderer = create(<ReviewWorkspace run={run()} candidates={[candidate('a'), candidate('b')]}
      activeCandidateId="a" error="暂时无法完成操作，请重试。"
      onSelect={onSelect} onReview={onReview} />)
    await act(async () => button(renderer, '接受').props.onClick())
    expect(onSelect).not.toHaveBeenCalled()
    expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('暂时无法完成操作')
  })
})
