import { useState } from 'react'
import type { CandidateSnapshot, KnowledgePointSnapshot, RunSnapshot } from '../types.js'
import { modelSelectionLabel } from '../model-directory-bridge.js'

export interface ResultSummaryProps {
  run: RunSnapshot
  candidates: CandidateSnapshot[]
  knowledgePoints: KnowledgePointSnapshot[]
  onUpdate(point: KnowledgePointSnapshot, input: { title: string; statement: string }): Promise<boolean>
  onReset(): void
  onStartLearning?(points: KnowledgePointSnapshot[], sourceText: string): void
}

function EditableKnowledgePointCard({ item, onUpdate }: {
  item: KnowledgePointSnapshot
  onUpdate: ResultSummaryProps['onUpdate']
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(item.title)
  const [statement, setStatement] = useState(item.statement)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const cancel = () => {
    setTitle(item.title)
    setStatement(item.statement)
    setError(false)
    setEditing(false)
  }
  const save = async () => {
    if (saving || title.length < 1 || title.length > 120 || statement.length < 1 || statement.length > 2_000) return
    setSaving(true)
    setError(false)
    const saved = await onUpdate(item, { title, statement })
    setSaving(false)
    if (saved) setEditing(false)
    else setError(true)
  }
  return (
    <article>
      <p>{item.type}</p>
      {editing ? (
        <div className="nobei-client__knowledge-editor">
          <label>标题
            <input data-testid="nobei-point-title-input" value={title} maxLength={120}
              onChange={event => setTitle(event.currentTarget.value)} />
          </label>
          <label>详细内容
            <textarea data-testid="nobei-point-statement-input" value={statement} maxLength={2_000}
              onChange={event => setStatement(event.currentTarget.value)} />
          </label>
          {error && <p className="nobei-client__knowledge-edit-error" role="alert">保存失败，请重试。</p>}
          <div className="nobei-client__knowledge-actions">
            <button data-testid="nobei-point-save" type="button" disabled={saving || !title || !statement}
              onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
            <button data-testid="nobei-point-cancel" type="button" disabled={saving} onClick={cancel}>取消</button>
          </div>
        </div>
      ) : (
        <>
          <div className="nobei-client__knowledge-heading">
            <h3>{item.title}</h3>
            <button type="button" aria-label={`修改“${item.title}”`} onClick={() => {
              setTitle(item.title); setStatement(item.statement); setError(false); setEditing(true)
            }}>修改</button>
          </div>
          <p>{item.statement}</p>
        </>
      )}
    </article>
  )
}

export function ResultSummary({ run, knowledgePoints, onUpdate, onReset, onStartLearning }: ResultSummaryProps) {
  const zeroCandidates = run.counts.rawCandidates === 0
  const [selectedPointIds, setSelectedPointIds] = useState(
    () => new Set(knowledgePoints.map(point => point.knowledgePointId)),
  )
  const selectedPoints = knowledgePoints.filter(point => selectedPointIds.has(point.knowledgePointId))
  return (
    <section className="nobei-client__result" aria-labelledby="nobei-result-title">
      <div className="nobei-client__result-meta" data-testid="nobei-result-meta">
        <header>
          <p className="nobei-client__eyebrow">提取完成 · {run.document.filename}</p>
          <h2 id="nobei-result-title">本次学习材料已整理</h2>
          <p>本次模型：{modelSelectionLabel(run.modelSelection)}</p>
        </header>
        {!zeroCandidates && <dl className="nobei-client__result-counts">
          <div><dt>已接受</dt><dd>{run.counts.accepted}</dd></div>
          <div><dt>已修改</dt><dd>{run.counts.editedAndAccepted}</dd></div>
          <div><dt>已拒绝</dt><dd>{run.counts.rejected}</dd></div>
        </dl>}
      </div>
      {zeroCandidates ? (
        <p className="nobei-client__empty-result">
          没有发现满足证据要求的候选知识点。原文已保存，本次任务没有创建正式知识点。
        </p>
      ) : (
        <div className="nobei-client__knowledge-list" data-testid="nobei-knowledge-list">
          {knowledgePoints.map(item => (
            <div className="nobei-client__knowledge-selectable" key={item.knowledgePointId}>
              {onStartLearning && <label className="nobei-client__knowledge-selector">
                <input type="checkbox" data-testid={`nobei-course-point-${item.knowledgePointId}`}
                  checked={selectedPointIds.has(item.knowledgePointId)}
                  onChange={() => setSelectedPointIds(current => {
                    const next = new Set(current)
                    if (next.has(item.knowledgePointId)) next.delete(item.knowledgePointId)
                    else next.add(item.knowledgePointId)
                    return next
                  })} />
                <span>加入课程</span>
              </label>}
              <EditableKnowledgePointCard item={item} onUpdate={onUpdate} />
            </div>
          ))}
        </div>
      )}
      {onStartLearning && knowledgePoints.length > 0 && (
        <section className="nobei-client__course-entry" aria-label="创建学习路径">
          <div><span>下一步</span><strong>把已确认知识点变成可学习的路径</strong>
            <p>已选择 {selectedPoints.length} / {knowledgePoints.length} 个知识点</p></div>
          <button data-testid="nobei-start-learning" type="button" disabled={selectedPoints.length === 0}
            onClick={() => onStartLearning(selectedPoints, run.document.text)}>进入学习空间</button>
        </section>
      )}
      <button data-testid="nobei-reset" type="button" onClick={onReset}>提取另一篇</button>
    </section>
  )
}
