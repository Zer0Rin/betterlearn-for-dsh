import { useState } from 'react'
import type { RunHistoryStatus, RunHistorySummary } from '../types.js'


export interface HistorySidebarProps {
  runs: RunHistorySummary[]
  currentRunId?: string
  loading: boolean
  error?: string
  onRetry(): void
  onSelect(runId: string): void
  onDelete?(runId: string): Promise<boolean>
  onNew(): void
}

function deletableStatus(status: RunHistoryStatus): boolean {
  return status === 'review_pending' || status === 'completed'
    || status === 'failed_retryable' || status === 'failed_terminal'
}


function statusLabel(status: RunHistoryStatus): string {
  if (status === 'review_pending') return '待审查'
  if (status === 'completed') return '已完成'
  if (status === 'failed_retryable' || status === 'failed_terminal') return '失败'
  return '处理中'
}


function displayTime(value: string): string {
  return value.replace('T', ' ').replace(/Z$/, '')
}


export function HistorySidebar({
  runs, currentRunId, loading, error, onRetry, onSelect, onDelete, onNew,
}: HistorySidebarProps) {
  const [confirmingRunId, setConfirmingRunId] = useState<string>()
  const [deletingRunId, setDeletingRunId] = useState<string>()
  return <aside className="nobei-history" aria-label="提取历史">
    <header className="nobei-history__header">
      <div>
        <p>BetterLearn</p>
        <h2>提取历史</h2>
      </div>
      <button type="button" data-testid="history-new" onClick={onNew}>新建提取</button>
    </header>
    <div className="nobei-history__body">
      {loading && runs.length === 0 && <p className="nobei-history__state">正在读取历史记录…</p>}
      {!loading && error && <div className="nobei-history__state" role="alert">
        <p>{error}</p>
        <button type="button" data-testid="history-retry" onClick={onRetry}>重试</button>
      </div>}
      {!loading && !error && runs.length === 0
        && <p className="nobei-history__state">还没有提取记录</p>}
      {!error && runs.map(run => <div key={run.runId} className="nobei-history__item-wrap">
        <button type="button" className="nobei-history__item" data-run-id={run.runId}
          aria-current={run.runId === currentRunId ? 'true' : undefined}
          onClick={() => onSelect(run.runId)}>
          <span className="nobei-history__item-heading">
            <strong>{run.sourceLabel}</strong>
            <em data-status={run.status}>{statusLabel(run.status)}</em>
          </span>
          <span className="nobei-history__counts">
            {`候选 ${run.candidateCount} · 知识点 ${run.knowledgePointCount}`}
          </span>
          <time dateTime={run.updatedAt}>{displayTime(run.updatedAt)}</time>
        </button>
        {onDelete && deletableStatus(run.status) && confirmingRunId !== run.runId &&
          <button className="nobei-history__delete" type="button"
            data-testid={`history-delete-${run.runId}`} aria-label={`删除“${run.sourceLabel}”`}
            onClick={() => setConfirmingRunId(run.runId)}>删除</button>}
        {confirmingRunId === run.runId && <div className="nobei-history__confirm">
          <p>确认删除“{run.sourceLabel}”？提取内容将一并删除。</p>
          <button type="button" data-testid="history-delete-confirm" disabled={deletingRunId === run.runId}
            onClick={() => {
              setDeletingRunId(run.runId)
              void onDelete?.(run.runId).then(deleted => {
                setDeletingRunId(undefined)
                if (deleted) setConfirmingRunId(undefined)
              })
            }}>{deletingRunId === run.runId ? '删除中…' : '确认删除'}</button>
          <button type="button" data-testid="history-delete-cancel" disabled={deletingRunId === run.runId}
            onClick={() => setConfirmingRunId(undefined)}>取消</button>
        </div>}
      </div>)}
    </div>
  </aside>
}
