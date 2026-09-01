import { useEffect, useMemo, useState } from 'react'
import type { GenerationProgress } from '../../generation-progress.js'
import type { ClientApi, RunSnapshot } from '../types.js'
import { useDocumentPreview } from '../use-document-preview.js'
import { modelSelectionLabel } from '../model-directory-bridge.js'
import { generationFailureCopy, workspaceCopy } from '../workspace-copy.js'

export interface RunProgressProps {
  progress?: GenerationProgress | null
  run?: RunSnapshot
  busy: boolean
  serviceUnavailable: boolean
  message?: string
  onRetry(): Promise<void> | void
  onReload(): Promise<void> | void
  onReset(): void
  onTerminateDelete?(): Promise<boolean>
  previewDocument?: ClientApi['previewDocument']
}

const steps = ['文档已保存', '正在生成候选', '正在校验证据', '等待审核'] as const

function GenerationDetail({ progress }: { progress: GenerationProgress }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const since = progress.lastResponseAt === null ? null : Math.max(0, Math.floor((now - progress.lastResponseAt) / 1000))
  const label = progress.phase === 'planning' ? '正在规划提取批次'
    : progress.phase === 'validating' ? '提取完成，正在校验证据'
      : `正在提取第 ${progress.completedBatches + 1}${progress.totalBatches === null ? ' 批（总批数规划中）' : ` / ${progress.totalBatches} 批`}`
  return <div className="nobei-client__notice" data-testid="nobei-generation-detail">
    <p role="status">{label}</p>
    <p>{`已完成 ${progress.completedBatches} 批提取；校验完成后进入审核。`}</p>
    <p>{since === null ? '尚未收到模型响应，正在等待。'
      : `最近模型响应：${new Date(progress.lastResponseAt!).toLocaleTimeString('zh-CN', { hour12: false })}（${since} 秒前）`}</p>
    {since !== null && since >= 30 && <p>暂未收到新数据，仍在等待；不会自动重新提取。</p>}
  </div>
}

function activeStep(run: RunSnapshot | undefined): number {
  if (run?.status === 'review_pending' || run?.status === 'completed') return 3
  if (run?.status === 'validating') return 2
  return 1
}

export function RunProgress({
  run, busy, serviceUnavailable, message, onRetry, onReload, onReset, onTerminateDelete, previewDocument, progress,
}: RunProgressProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailed, setDeleteFailed] = useState(false)
  const activeIndex = activeStep(run)
  const failed = run?.status === 'failed_retryable' || run?.status === 'failed_terminal'
  const failureDetail = generationFailureCopy[run?.error?.code ?? ''] ?? '生成没有完成，原文仍已保存。'
  const longDocument = (run?.document.characterCount ?? 0) > 6000
  const previewInput = useMemo(() => run && longDocument ? {
    filename: run.document.filename, mediaType: run.document.mediaType, text: run.document.text,
  } : undefined, [run?.document.filename, run?.document.mediaType, run?.document.text, longDocument])
  const plan = useDocumentPreview(previewInput, previewDocument)
  const maxCalls = longDocument ? plan.preview?.extractionPlan.maxCalls : 1
  const activeRun = run !== undefined && [
    'created', 'document_ready', 'awaiting_generation', 'generating', 'validating',
  ].includes(run.status)
  return (
    <section className="nobei-client__progress" aria-labelledby="nobei-progress-title" aria-busy={busy}>
      <header>
        <p className="nobei-client__eyebrow">提取进度</p>
        <h2 id="nobei-progress-title">{run?.document.filename ?? '正在读取材料'}</h2>
        {run && <p>本次模型：{modelSelectionLabel(run.modelSelection)}</p>}
        {longDocument && <p>长文先规划，再分批提取；全部完成后自动进入审核。重新连接不会重新调用模型。</p>}
      </header>
      <ol className="nobei-client__steps">
        {steps.map((label, index) => (
          <li key={label} data-state={index < activeIndex ? 'done' : index === activeIndex ? 'current' : 'pending'}>
            <span aria-hidden="true">{index < activeIndex ? '✓' : index + 1}</span>
            {failed && index === activeIndex ? '提取已停止' : label}
          </li>
        ))}
      </ol>

      {!serviceUnavailable && progress && (run?.status === 'generating' || run?.status === 'validating')
        && <GenerationDetail progress={progress} />}

      {serviceUnavailable && (
        <div className="nobei-client__notice" role="status">
          <strong>{workspaceCopy.unavailable}</strong>
          <p>{workspaceCopy.reconnectDetail}</p>
          <button type="button" disabled={busy} onClick={() => { void onReload() }}>{workspaceCopy.reconnect}</button>
        </div>
      )}
      {!serviceUnavailable && run?.status === 'failed_retryable' && (
        <div className="nobei-client__notice" role="status">
          <strong>这次生成没有完成</strong>
          <p>{failureDetail}</p>
          <p>{maxCalls === undefined ? '正在读取提取计划；确认调用上限后才能重试。'
            : `此任务仍使用创建时的模型。点击“重新提取”会重新执行整个计划，最多再发起 ${maxCalls} 次模型调用。`}</p>
          {plan.error && <><p role="alert">{plan.error}</p>
            <button type="button" onClick={plan.retry}>重新读取提取计划</button></>}
          <button type="button" disabled={busy || maxCalls === undefined} onClick={() => { void onRetry() }}>重新提取</button>
        </div>
      )}
      {!serviceUnavailable && run?.status === 'failed_terminal' && (
        <div className="nobei-client__notice" role="status">
          <strong>本任务无法继续重试</strong>
          <p>{failureDetail}</p>
          <p>可返回导入页，检查材料或模型设置后新建任务。新建任务会再次调用模型。</p>
          <button type="button" disabled={busy} onClick={onReset}>返回导入</button>
        </div>
      )}
      {message && <p className="nobei-client__error" role="alert">{message}</p>}
      {!serviceUnavailable && message === workspaceCopy.operationFailed && (
        <button type="button" disabled={busy} onClick={() => { void onReload() }}>{workspaceCopy.reconnect}</button>
      )}
      {activeRun && onTerminateDelete && !confirmingDelete &&
        <button className="nobei-client__destructive" data-testid="terminate-delete" type="button"
          disabled={busy} onClick={() => { setDeleteFailed(false); setConfirmingDelete(true) }}>终止并删除</button>}
      {activeRun && onTerminateDelete && confirmingDelete && <div className="nobei-client__delete-confirm">
        <strong>正在进行的提取会立即停止，已生成的本任务内容也会删除。</strong>
        {deleteFailed && <p role="alert">终止并删除失败，请重试。</p>}
        <div>
          <button className="nobei-client__destructive" data-testid="terminate-delete-confirm" type="button"
            disabled={busy || deleting} onClick={() => {
              setDeleting(true); setDeleteFailed(false)
              void onTerminateDelete().then(deleted => {
                setDeleting(false)
                if (!deleted) setDeleteFailed(true)
              })
            }}>{deleting ? '正在终止…' : '确认终止并删除'}</button>
          <button data-testid="terminate-delete-cancel" type="button" disabled={deleting}
            onClick={() => setConfirmingDelete(false)}>取消</button>
        </div>
      </div>}
    </section>
  )
}
