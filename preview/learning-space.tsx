import { useMemo, useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { LearningSpace } from '../src/client/components/LearningSpace.js'
import { ResultSummary } from '../src/client/components/ResultSummary.js'
import { createLearningPreviewCourse } from '../src/client/learning-preview.js'
import { CLIENT_CSS } from '../src/client/styles.js'
import type { KnowledgePointSnapshot, RunSnapshot } from '../src/client/types.js'

const sourceText = [
  '工作记忆一次能主动处理的信息有限，所以复杂内容需要拆成边界清晰的小单元。',
  '提取练习要求学习者先尝试从记忆中回答，再查看答案和证据；这种主动回忆比重复阅读更能暴露理解缺口。',
  '间隔复习把同一目标安排到逐渐拉长的时间间隔中，并根据每次回忆表现调整下一次复习时间。',
  '迁移检测不重复原题，而是把同一概念放进新的问题情境，检查学习者能否识别底层关系。',
].join('\n\n')

function point(
  knowledgePointId: string,
  type: KnowledgePointSnapshot['type'],
  title: string,
  statement: string,
  quote: string,
): KnowledgePointSnapshot {
  const textStart = sourceText.indexOf(quote)
  return {
    knowledgePointId,
    documentId: 'doc_learning_science',
    type,
    title,
    statement,
    evidence: [{
      seq: 0,
      quote,
      textStart,
      textEnd: textStart + quote.length,
      contextBefore: sourceText.slice(Math.max(0, textStart - 16), textStart),
      contextAfter: sourceText.slice(textStart + quote.length, textStart + quote.length + 18),
    }],
  }
}

const points: KnowledgePointSnapshot[] = [
  point('kp_chunking', 'process', '单元化学习', '复杂内容应拆成边界清晰、可独立掌握的小单元。',
    '复杂内容需要拆成边界清晰的小单元'),
  point('kp_retrieval', 'concept', '提取练习', '先主动回答，再依据答案与证据暴露理解缺口。',
    '先尝试从记忆中回答，再查看答案和证据'),
  point('kp_spacing', 'process', '间隔复习', '复习间隔应随每次回忆表现动态调整。',
    '根据每次回忆表现调整下一次复习时间'),
  point('kp_transfer', 'comparison', '迁移检测', '用新情境检验能否识别概念的底层关系，而不是复述原题。',
    '把同一概念放进新的问题情境'),
]

const run: RunSnapshot = {
  runId: 'preview_run',
  documentId: 'doc_learning_science',
  status: 'completed',
  stage: 'done',
  revision: 4,
  retryCount: 0,
  lastEventSeq: 4,
  modelSelection: { provider: 'BetterLearn', model: 'evidence-preview' },
  counts: {
    rawCandidates: 4,
    validCandidates: 4,
    pending: 0,
    accepted: 4,
    editedAndAccepted: 0,
    rejected: 0,
    knowledgePoints: 4,
  },
  error: null,
  document: {
    filename: '有效学习方法.md',
    mediaType: 'text/markdown',
    byteSize: new TextEncoder().encode(sourceText).byteLength,
    characterCount: sourceText.length,
    text: sourceText,
  },
}

const PREVIEW_CSS = `
html, body, #root { width: 100%; height: 100%; margin: 0; overflow: hidden; }
body { background: #E9EDF5; }
.preview-host { position: fixed; inset: 0; color: #566176; background: #E9EDF5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
.preview-host__rail { position: absolute; inset: 0 auto 0 0; width: 72px; border-inline-end: 1px solid #D6DCE7; background: #F8FAFD; }
.preview-host__rail::before { content: "DSH"; display: grid; place-items: center; width: 42px; height: 42px; margin: 18px auto; border-radius: 12px; color: #FFFFFF; background: #315EFB; font-size: 11px; font-weight: 800; letter-spacing: .08em; }
.preview-host__header { height: 64px; margin-inline-start: 72px; border-block-end: 1px solid #D6DCE7; background: #F8FAFD; }
.preview-host__copy { width: 210px; margin: 54px 0 0 100px; }
.preview-host__copy p { margin: 7px 0; font-size: 13px; line-height: 1.65; }
.preview-host__copy strong { color: #293348; font-size: 14px; }
`

function PreviewApp() {
  const [expanded, setExpanded] = useState(true)
  const [mode, setMode] = useState<'workbench' | 'learning'>('learning')
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const [selectedPoints, setSelectedPoints] = useState(points)
  const course = useMemo(
    () => createLearningPreviewCourse(selectedPoints, sourceText),
    [selectedPoints],
  )
  const panelStyle = {
    '--betterlearn-user-width': mode === 'learning' ? '1080px' : '460px',
    '--betterlearn-user-height': mode === 'learning' ? '868px' : '720px',
  } as CSSProperties

  return <>
    <style>{CLIENT_CSS}{PREVIEW_CSS}</style>
    <div className="preview-host" aria-hidden="true">
      <div className="preview-host__rail" />
      <div className="preview-host__header" />
      <div className="preview-host__copy">
        <strong>DeepSeek Harness</strong>
        <p>BetterLearn 以悬浮工作台方式运行，不会挤占原会话空间。</p>
      </div>
    </div>
    <div className="betterlearn-floating-root">
      {!expanded ? <button className="betterlearn-floating-launcher" type="button"
        onClick={() => setExpanded(true)}>BetterLearn</button> : (
        <aside className="betterlearn-floating-panel" data-mode={mode}
          data-left-open={leftOpen ? 'true' : 'false'} data-right-open={rightOpen ? 'true' : 'false'}
          data-compact-height="false" data-resizing="false" style={panelStyle}>
          <header className="betterlearn-floating-header">
            <div className="betterlearn-floating-header__leading">
              <strong>{mode === 'learning' ? 'BetterLearn · 学习' : 'BetterLearn'}</strong>
            </div>
            <button type="button" aria-label="收起 BetterLearn" onClick={() => setExpanded(false)}>收起</button>
          </header>
          {mode === 'learning' ? (
            <LearningSpace course={course} sourceText={sourceText}
              leftOpen={leftOpen} rightOpen={rightOpen}
              onLeftOpenChange={setLeftOpen} onRightOpenChange={setRightOpen}
              onExit={() => setMode('workbench')} />
          ) : (
            <div className="betterlearn-floating-workbench">
              <div className="nobei-client-layout"><div className="nobei-client">
                <ResultSummary run={run} candidates={[]} knowledgePoints={points}
                  onUpdate={async () => true} onReset={() => undefined}
                  onStartLearning={nextPoints => {
                    setSelectedPoints(nextPoints)
                    setMode('learning')
                  }} />
              </div></div>
            </div>
          )}
        </aside>
      )}
    </div>
  </>
}

const root = document.getElementById('root')
if (root === null) throw new Error('Preview root is missing')
createRoot(root).render(<PreviewApp />)
