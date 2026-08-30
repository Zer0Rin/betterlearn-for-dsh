import type { RunSnapshot } from '../types.js'
import { modelSelectionLabel } from '../model-directory-bridge.js'

export interface RunProgressProps {
  run?: RunSnapshot
  busy: boolean
  serviceUnavailable: boolean
  message?: string
  onRetry(): Promise<void> | void
  onReload(): Promise<void> | void
  onReset(): void
}

const steps = ['文档已保存', '正在生成候选', '正在校验证据', '等待审核'] as const

function activeStep(run: RunSnapshot | undefined): number {
  if (run?.status === 'review_pending' || run?.status === 'completed') return 3
  if (run?.status === 'validating') return 2
  return 1
}

export function RunProgress({
  run, busy, serviceUnavailable, message, onRetry, onReload, onReset,
}: RunProgressProps) {
  const active = activeStep(run)
  return (
    <section className="nobei-client__progress" aria-labelledby="nobei-progress-title" aria-busy={busy}>
      <header>
        <p className="nobei-client__eyebrow">提取进度</p>
        <h2 id="nobei-progress-title">{run?.document.filename ?? '正在读取材料'}</h2>
        {run && <p>本次模型：{modelSelectionLabel(run.modelSelection)}</p>}
      </header>
      <ol className="nobei-client__steps">
        {steps.map((label, index) => (
          <li key={label} data-state={index < active ? 'done' : index === active ? 'current' : 'pending'}>
            <span aria-hidden="true">{index < active ? '✓' : index + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      {serviceUnavailable && (
        <div className="nobei-client__notice" role="status">
          <strong>服务正在恢复</strong>
          <p>当前材料和进度已保留，可以稍后重新连接。</p>
          <button type="button" disabled={busy} onClick={() => { void onReload() }}>重新连接</button>
        </div>
      )}
      {!serviceUnavailable && run?.status === 'failed_retryable' && (
        <div className="nobei-client__notice" role="status">
          <strong>这次生成没有完成</strong>
          <p>此任务仍使用创建时的模型。点击“重新提取”会再发起 1 次模型调用。</p>
          <button type="button" disabled={busy} onClick={() => { void onRetry() }}>重新提取</button>
        </div>
      )}
      {!serviceUnavailable && run?.status === 'failed_terminal' && (
        <div className="nobei-client__notice" role="status">
          <strong>当前材料需要调整后再试</strong>
          <button type="button" disabled={busy} onClick={onReset}>返回修改内容</button>
        </div>
      )}
      {message && <p className="nobei-client__error" role="alert">{message}</p>}
    </section>
  )
}
