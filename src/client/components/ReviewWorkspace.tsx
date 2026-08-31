import { useEffect, useMemo, useRef, useState } from 'react'
import type { CandidateSnapshot, ReviewActionDraft, RunSnapshot } from '../types.js'
import { modelSelectionLabel } from '../model-directory-bridge.js'
import { EvidenceReader } from './EvidenceReader.js'
import { workspaceCopy } from '../workspace-copy.js'

export interface ReviewWorkspaceProps {
  run: RunSnapshot
  candidates: CandidateSnapshot[]
  activeCandidateId?: string
  submittingCandidateId?: string
  error?: string
  onSelect(candidateId: string): void
  onReview(candidate: CandidateSnapshot, request: ReviewActionDraft): Promise<boolean>
  onReload?(): Promise<void> | void
}

const statusLabel: Record<CandidateSnapshot['reviewStatus'], string> = {
  pending: '待审核',
  accepted: '已接受',
  edited_and_accepted: '已修改',
  rejected: '已拒绝',
}

export function ReviewWorkspace({
  run, candidates, activeCandidateId, submittingCandidateId, error, onSelect, onReview, onReload,
}: ReviewWorkspaceProps) {
  const selected = useMemo(() => candidates.find(item => item.candidateId === activeCandidateId)
    ?? candidates.find(item => item.reviewStatus === 'pending')
    ?? candidates[0], [activeCandidateId, candidates])
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(selected?.title ?? '')
  const [statement, setStatement] = useState(selected?.statement ?? '')
  const localSubmitting = useRef(false)

  useEffect(() => {
    setEditing(false)
    setTitle(selected?.title ?? '')
    setStatement(selected?.statement ?? '')
  }, [selected?.candidateId, selected?.statement, selected?.title])

  if (selected === undefined) {
    return <section className="nobei-client__review"><p>没有待审核候选。</p></section>
  }
  const submitting = submittingCandidateId === selected.candidateId || localSubmitting.current
  const editValid = title.length >= 1 && title.length <= 120
    && statement.length >= 1 && statement.length <= 2_000

  async function submit(draft: ReviewActionDraft): Promise<void> {
    if (localSubmitting.current || selected?.reviewStatus !== 'pending') return
    localSubmitting.current = true
    try {
      const succeeded = await onReview(selected, draft)
      if (!succeeded) return
      const next = candidates.find(item => item.candidateId !== selected.candidateId && item.reviewStatus === 'pending')
      if (next) onSelect(next.candidateId)
    } finally {
      localSubmitting.current = false
    }
  }

  function cancelEdit(): void {
    setTitle(selected!.title)
    setStatement(selected!.statement)
    setEditing(false)
  }

  return (
    <section className="nobei-client__review" aria-labelledby="nobei-review-title">
      <nav className="nobei-client__candidate-nav" aria-label="候选目录">
        <p className="nobei-client__eyebrow">候选目录</p>
        {candidates.map((item, index) => (
          <button key={item.candidateId} type="button"
            aria-current={item.candidateId === selected.candidateId ? 'true' : undefined}
            onClick={() => onSelect(item.candidateId)}>
            <span>{index + 1}. {item.title}</span>
            <small>{statusLabel[item.reviewStatus]}</small>
          </button>
        ))}
      </nav>

      <article className="nobei-client__candidate-card">
        <header>
          <p className="nobei-client__eyebrow">知识点审核 · {statusLabel[selected.reviewStatus]}</p>
          <h2 id="nobei-review-title">逐条确认候选</h2>
          <p>本次模型：{modelSelectionLabel(run.modelSelection)}</p>
        </header>
        {error && <p className="nobei-client__error" role="alert">{error}</p>}
        {error && onReload && (
          <button type="button" disabled={submitting} onClick={() => { void onReload() }}>{workspaceCopy.reconnect}</button>
        )}
        <label htmlFor="nobei-candidate-title">标题</label>
        <input id="nobei-candidate-title" data-testid="nobei-candidate-title" value={title}
          readOnly={!editing} maxLength={120} onChange={event => setTitle(event.currentTarget.value)} />
        <label htmlFor="nobei-candidate-statement">陈述</label>
        <textarea id="nobei-candidate-statement" data-testid="nobei-candidate-statement" value={statement}
          readOnly={!editing} maxLength={2000} onChange={event => setStatement(event.currentTarget.value)} />

        {selected.reviewStatus === 'pending' && (
          <div className="nobei-client__review-actions" aria-busy={submitting}>
            {editing ? (
              <>
                <button type="button" disabled={submitting || !editValid}
                  onClick={() => { void submit({ action: 'edited_and_accept', title, statement }) }}>
                  保存并接受
                </button>
                <button type="button" disabled={submitting} onClick={cancelEdit}>取消修改</button>
              </>
            ) : (
              <>
                <button type="button" disabled={submitting} onClick={() => { void submit({ action: 'accept' }) }}>接受</button>
                <button type="button" disabled={submitting} onClick={() => setEditing(true)}>修改后接受</button>
                <button type="button" disabled={submitting} onClick={() => { void submit({ action: 'reject' }) }}>拒绝</button>
              </>
            )}
          </div>
        )}
      </article>

      <EvidenceReader text={run.document.text} evidence={selected.evidence} />
    </section>
  )
}
