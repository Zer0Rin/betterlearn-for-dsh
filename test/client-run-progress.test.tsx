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
    expect(JSON.stringify(renderer.toJSON())).toContain('返回修改内容')
    act(() => renderer.update(<RunProgress run={run('generating')} busy={false} serviceUnavailable
      onRetry={vi.fn()} onReload={vi.fn()} onReset={vi.fn()} />))
    expect(JSON.stringify(renderer.toJSON())).toContain('服务正在恢复')
    expect(JSON.stringify(renderer.toJSON())).toContain('重新连接')
  })
})
