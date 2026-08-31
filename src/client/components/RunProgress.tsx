import { useMemo } from 'react'
import type { ClientApi, RunSnapshot } from '../types.js'
import { useDocumentPreview } from '../use-document-preview.js'
import { modelSelectionLabel } from '../model-directory-bridge.js'
import { generationFailureCopy, workspaceCopy } from '../workspace-copy.js'

export interface RunProgressProps {
  run?: RunSnapshot
  busy: boolean
  serviceUnavailable: boolean
  message?: string
  onRetry(): Promise<void> | void
  onReload(): Promise<void> | void
  onReset(): void
  previewDocument?: ClientApi['previewDocument']
}

const steps = ['文档已保存', '正在生成候选', '正在校验证据', '等待审核'] as const

function activeStep(run: RunSnapshot | undefined): number {
  if (run?.status === 'review_pending' || run?.status === 'completed') return 3
  if (run?.status === 'validating') return 2
  return 1
}

export function RunProgress({
  run, busy, serviceUnavailable, message, onRetry, onReload, onReset, previewDocument,
}: RunProgressProps) {
  const active = activeStep(run)
  const failed = run?.status === 'failed_retryable' || run?.status === 'failed_terminal'
  const failureDetail = generationFailureCopy[run?.error?.code ?? ''] ?? '生成没有完成，原文仍已保存。'
  const longDocument = (run?.document.characterCount ?? 0) > 6000
  const previewInput = useMemo(() => run && longDocument ? {
    filename: run.document.filename, mediaType: run.document.mediaType, text: run.document.text,
  } : undefined, [run?.document.filename, run?.document.mediaType, run?.document.text, longDocument])
  const plan = useDocumentPreview(previewInput, previewDocument)
  const maxCalls = longDocument ? plan.preview?.extractionPlan.maxCalls : 1
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
          <li key={label} data-state={index < active ? 'done' : index === active ? 'current' : 'pending'}>
            <span aria-hidden="true">{index < active ? '✓' : index + 1}</span>
            {failed && index === active ? '提取已停止' : label}
          </li>
        ))}
      </ol>

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
    </section>
  )
}
