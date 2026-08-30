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
      knowledgePoints={[kp]} onReset={onReset} />)
    const output = JSON.stringify(renderer.toJSON())
    for (const value of ['光合作用.md', '已接受', '已修改', '已拒绝', '正式知识点', '只展示 Core 返回的内容']) {
      expect(output).toContain(value)
    }
    expect(output).not.toContain('未被正式接受的候选')
    act(() => renderer.root.findByProps({ 'data-testid': 'nobei-reset' }).props.onClick())
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  test('treats zero candidates as a normal completed result', () => {
    const renderer = create(<ResultSummary run={run(0)} candidates={[]}
      knowledgePoints={[]} onReset={vi.fn()} />)
    expect(JSON.stringify(renderer.toJSON())).toContain('没有发现满足证据要求的候选知识点')
  })
})
