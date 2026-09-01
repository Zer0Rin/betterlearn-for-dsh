import { useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import {
  BetterLearnGateway, LearningBookComposer, LearningBookshelf,
} from '../src/client/components/LearningLibrary.js'
import { LearningSpace } from '../src/client/components/LearningSpace.js'
import { ResultSummary } from '../src/client/components/ResultSummary.js'
import {
  createLearningBook, updateLearningBookCourse, type LearningBook,
} from '../src/client/learning-book-library.js'
import { CLIENT_CSS } from '../src/client/styles.js'
import type {
  ClientApi, KnowledgePointSnapshot, LearningCourse, RunSnapshot,
} from '../src/client/types.js'

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

const initialBook = createLearningBook({
  title: '有效学习方法', points, sourceText,
}, { bookId: 'book-preview-1', createdAt: '2026-09-01T08:00:00.000Z' })

function buildPreviewCourse(book: LearningBook): LearningCourse {
  const units = book.points.map((item, index) => {
    const other = book.points[(index + 1) % book.points.length]
    const evidence = item.evidence[0]!
    const distinctOther = other?.knowledgePointId === item.knowledgePointId ? undefined : other
    const otherEvidence = distinctOther?.evidence[0]
    return {
      unitId: `unit-preview-${index + 1}`,
      knowledgePointId: item.knowledgePointId,
      type: item.type,
      title: item.title,
      objective: `能够准确解释${item.title}，并从原文中定位支持证据。`,
      lesson: {
        explanation: item.statement,
        workedExample: `原文写道：“${evidence.quote}”。把这段原文与结论逐项对应。`,
        supplemental: '先辨认结论描述的对象和关系，再核对对应原文。',
      },
      evidence: { kind: 'quote' as const, ...evidence },
      mastery: { status: 'new' as const, strength: 0, dueAt: null },
      check: {
        main: {
          assessmentId: `asm-preview-${index + 1}-main`, kind: 'claim_choice' as const,
          prompt: `以下哪一项准确说明“${item.title}”？`,
          options: [
            { optionId: `opt-preview-${index + 1}-main-correct`, label: item.statement },
            { optionId: `opt-preview-${index + 1}-main-other`, label: distinctOther?.statement
              ?? `“${item.title}”只是材料中的一个标题。` },
          ],
          attempt: null,
        },
        remediation: {
          title: `重新核对“${item.title}”`,
          body: `先读已确认结论：“${item.statement}”再回到原文：“${evidence.quote}”。`,
        },
        retest: {
          assessmentId: `asm-preview-${index + 1}-retest`, kind: 'evidence_choice' as const,
          prompt: `以下哪段原文最直接支持：${item.statement}`,
          options: [
            { optionId: `opt-preview-${index + 1}-retest-correct`, label: evidence.quote },
            { optionId: `opt-preview-${index + 1}-retest-other`, label: otherEvidence?.quote
              ?? '材料中的其他段落不能直接支持这个结论。' },
          ],
          attempt: null,
        },
      },
    }
  })
  return {
    courseId: `course-${book.bookId}`, clientBookId: book.bookId, title: book.title,
    status: 'active', progress: { completed: 0, total: units.length, mastery: 0 }, units,
  }
}

function previewApiFor(book: LearningBook): Pick<ClientApi, 'syncLearningCourse' | 'submitLearningAttempt'> {
  let course = buildPreviewCourse(book)
  return {
    syncLearningCourse: async () => structuredClone(course),
    submitLearningAttempt: async (assessmentId, input) => {
      const next = structuredClone(course)
      const unit = next.units.find(item => item.check.main.assessmentId === assessmentId
        || item.check.retest.assessmentId === assessmentId)
      if (!unit) throw new Error('preview assessment missing')
      const assessment = unit.check.main.assessmentId === assessmentId
        ? unit.check.main : unit.check.retest
      const correct = input.optionId.endsWith('-correct')
      const submittedAt = new Date().toISOString()
      assessment.attempt = { selectedOptionId: input.optionId, correct, submittedAt }
      if (assessment.kind === 'claim_choice') {
        unit.mastery = correct
          ? { status: 'mastered', strength: 100, dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }
          : { status: 'remediation_required', strength: 20, dueAt: null }
      } else {
        unit.mastery = correct
          ? { status: 'mastered_after_remediation', strength: 70, dueAt: new Date(Date.now() + 86_400_000).toISOString() }
          : { status: 'learning', strength: 20, dueAt: null }
      }
      next.progress.completed = next.units.filter(item => item.mastery.status === 'mastered'
        || item.mastery.status === 'mastered_after_remediation').length
      next.progress.mastery = next.units.length === 0 ? 0
        : Math.round(next.units.reduce((total, item) => total + item.mastery.strength, 0) / next.units.length)
      course = next
      return {
        attempt: {
          attemptId: `latt-preview-${Date.now()}`, assessmentId,
          selectedOptionId: input.optionId, correct, submittedAt,
        },
        course: structuredClone(course),
      }
    },
  }
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
  const [mode, setMode] = useState<'workbench' | 'learning'>('workbench')
  const [area, setArea] = useState<'home' | 'knowledge' | 'compose' | 'library'>('home')
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const [books, setBooks] = useState([initialBook])
  const [activeBook, setActiveBook] = useState<LearningBook>()
  const [learningApi, setLearningApi] = useState(() => previewApiFor(initialBook))
  const [draftPoints, setDraftPoints] = useState<KnowledgePointSnapshot[]>()
  const [newBookId, setNewBookId] = useState<string>()
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
          data-area={area}
          data-left-open={leftOpen ? 'true' : 'false'} data-right-open={rightOpen ? 'true' : 'false'}
          data-compact-height="false" data-resizing="false" style={panelStyle}>
          <header className="betterlearn-floating-header">
            <div className="betterlearn-floating-header__leading">
              {mode === 'workbench' && area !== 'home' && <button type="button"
                aria-label="返回 BetterLearn 首页" onClick={() => setArea('home')}>首页</button>}
              <strong>{mode === 'learning' ? 'BetterLearn · 学习'
                : area === 'knowledge' ? 'BetterLearn · 知识点'
                : area === 'compose' ? 'BetterLearn · 整理学习书'
                : area === 'library' ? 'BetterLearn · 学习空间' : 'BetterLearn'}</strong>
            </div>
            <button type="button" aria-label="收起 BetterLearn" onClick={() => setExpanded(false)}>收起</button>
          </header>
          {mode === 'learning' && activeBook ? (
            <LearningSpace book={activeBook} api={learningApi}
              leftOpen={leftOpen} rightOpen={rightOpen}
              onLeftOpenChange={setLeftOpen} onRightOpenChange={setRightOpen}
              onCourseChange={next => setBooks(current => current.map(book =>
                book.bookId === next.clientBookId ? updateLearningBookCourse(book, next) : book))}
              onExit={() => { setMode('workbench'); setArea('library') }} />
          ) : null}
          {mode === 'workbench' && area === 'home' ? (
            <BetterLearnGateway bookCount={books.length} knowledgeAvailable
              onOpenKnowledge={() => setArea('knowledge')} onOpenLearning={() => setArea('library')} />
          ) : null}
          {mode === 'workbench' && area === 'library' ? (
            <LearningBookshelf books={books} newBookId={newBookId}
              onOpenKnowledge={() => setArea('knowledge')}
              onOpenBook={book => {
                setActiveBook(book)
                setLearningApi(() => previewApiFor(book))
                setMode('learning')
              }} />
          ) : null}
          {mode === 'workbench' && area === 'compose' && draftPoints ? (
            <LearningBookComposer points={draftPoints}
              onCancel={() => { setDraftPoints(undefined); setArea('knowledge') }}
              onCreate={draft => {
                const book = createLearningBook({
                  title: draft.title, points: draft.points, sourceText,
                }, {
                  bookId: `book-preview-${books.length + 1}`,
                  createdAt: new Date().toISOString(),
                })
                setBooks(current => [book, ...current])
                setNewBookId(book.bookId)
                setDraftPoints(undefined)
                setArea('library')
              }} />
          ) : null}
          {mode === 'workbench' && area === 'knowledge' ? (
            <div className="betterlearn-floating-workbench">
              <div className="nobei-client-layout"><div className="nobei-client">
                <ResultSummary run={run} candidates={[]} knowledgePoints={points}
                  onUpdate={async () => true} onReset={() => undefined}
                  onOrganizeLearningBook={nextPoints => {
                    setDraftPoints(nextPoints)
                    setArea('compose')
                  }} />
              </div></div>
            </div>
          ) : null}
        </aside>
      )}
    </div>
  </>
}

const root = document.getElementById('root')
if (root === null) throw new Error('Preview root is missing')
createRoot(root).render(<PreviewApp />)
