import type { RunHistoryStatus, RunHistorySummary } from '../types.js'


export interface HistorySidebarProps {
  runs: RunHistorySummary[]
  currentRunId?: string
  loading: boolean
  error?: string
  onRetry(): void
  onSelect(runId: string): void
  onNew(): void
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
  runs, currentRunId, loading, error, onRetry, onSelect, onNew,
}: HistorySidebarProps) {
  return <aside className="nobei-history" aria-label="提取历史">
    <header className="nobei-history__header">
      <div>
        <p>BetterLearn</p>
        <h2>提取历史</h2>
      </div>
      <button type="button" data-testid="history-new" onClick={onNew}>新建提取</button>
    </header>
    <div className="nobei-history__body">
      {loading && <p className="nobei-history__state">正在读取历史记录…</p>}
      {!loading && error && <div className="nobei-history__state" role="alert">
        <p>{error}</p>
        <button type="button" data-testid="history-retry" onClick={onRetry}>重试</button>
      </div>}
      {!loading && !error && runs.length === 0
        && <p className="nobei-history__state">还没有提取记录</p>}
      {!loading && !error && runs.map(run => <button key={run.runId} type="button"
        className="nobei-history__item" data-run-id={run.runId}
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
      </button>)}
    </div>
  </aside>
}
