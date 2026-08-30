import type { CandidateSnapshot, KnowledgePointSnapshot, RunSnapshot } from '../types.js'
import { modelSelectionLabel } from '../model-directory-bridge.js'

export interface ResultSummaryProps {
  run: RunSnapshot
  candidates: CandidateSnapshot[]
  knowledgePoints: KnowledgePointSnapshot[]
  onReset(): void
}

export function ResultSummary({ run, knowledgePoints, onReset }: ResultSummaryProps) {
  const zeroCandidates = run.counts.rawCandidates === 0
  return (
    <section className="nobei-client__result" aria-labelledby="nobei-result-title">
      <header>
        <p className="nobei-client__eyebrow">提取完成 · {run.document.filename}</p>
        <h2 id="nobei-result-title">本次学习材料已整理</h2>
        <p>本次模型：{modelSelectionLabel(run.modelSelection)}</p>
      </header>
      {zeroCandidates ? (
        <p className="nobei-client__empty-result">
          没有发现满足证据要求的候选知识点。原文已保存，本次任务没有创建正式知识点。
        </p>
      ) : (
        <>
          <dl className="nobei-client__result-counts">
            <div><dt>已接受</dt><dd>{run.counts.accepted}</dd></div>
            <div><dt>已修改</dt><dd>{run.counts.editedAndAccepted}</dd></div>
            <div><dt>已拒绝</dt><dd>{run.counts.rejected}</dd></div>
          </dl>
          <div className="nobei-client__knowledge-list">
            {knowledgePoints.map(item => (
              <article key={item.knowledgePointId}>
                <p>{item.type}</p>
                <h3>{item.title}</h3>
                <p>{item.statement}</p>
              </article>
            ))}
          </div>
        </>
      )}
      <button data-testid="nobei-reset" type="button" onClick={onReset}>提取另一篇</button>
    </section>
  )
}
