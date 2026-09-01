import { useEffect, useMemo, useState } from 'react'
import type { LearningBook } from '../learning-book-library.js'
import type {
  ClientApi, LearningAssessment, LearningCourse, LearningOption, LearningUnit,
} from '../types.js'

export interface LearningSpaceProps {
  book: LearningBook
  api: Pick<ClientApi, 'syncLearningCourse' | 'submitLearningAttempt'>
  leftOpen: boolean
  rightOpen: boolean
  onLeftOpenChange(open: boolean): void
  onRightOpenChange(open: boolean): void
  onCourseChange(course: LearningCourse): void
  onExit(): void
}

const STATUS_LABELS: Record<LearningUnit['mastery']['status'], string> = {
  new: '尚未检测',
  remediation_required: '需要补救',
  learning: '继续练习',
  mastered: '已掌握',
  mastered_after_remediation: '补救后掌握',
}

function idempotencyKey(): string {
  const bytes = new Uint8Array(10)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  return `idem_${[...bytes].map(value => value.toString(16).padStart(2, '0')).join('')}`
}

function UnitPath({ course, activeUnitId, onSelect }: {
  course: LearningCourse
  activeUnitId: string | undefined
  onSelect(unitId: string): void
}) {
  const now = Date.now()
  const due = course.units.filter(unit => unit.mastery.dueAt !== null
    && Date.parse(unit.mastery.dueAt) <= now).length
  return (
    <nav className="betterlearn-learning__path" data-testid="learning-path" aria-label="课程路径">
      <div className="betterlearn-learning__path-heading">
        <p className="betterlearn-learning__kicker">课程路径</p>
        <h2>{course.title}</h2>
        <p>{course.units.length} 个学习单元</p>
      </div>
      <ol>
        {course.units.map((unit, index) => {
          const completed = unit.mastery.status === 'mastered'
            || unit.mastery.status === 'mastered_after_remediation'
          return (
            <li key={unit.unitId} data-delivery={completed ? 'completed'
              : unit.unitId === activeUnitId ? 'current' : 'upcoming'}>
              <button type="button" data-unit-id={unit.unitId}
                aria-current={unit.unitId === activeUnitId ? 'step' : undefined}
                onClick={() => onSelect(unit.unitId)}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <span><strong>{unit.title}</strong><small>{STATUS_LABELS[unit.mastery.status]} · {unit.mastery.strength}%</small></span>
              </button>
            </li>
          )
        })}
      </ol>
      <div className="betterlearn-learning__today">
        <span>今日复习</span>
        <strong>{due > 0 ? `${due} 个目标已到期` : '当前没有到期目标'}</strong>
      </div>
    </nav>
  )
}

function Options({ options, selected, disabled, onSelect }: {
  options: LearningOption[]
  selected: string | undefined
  disabled?: boolean
  onSelect(optionId: string): void
}) {
  return (
    <div className="betterlearn-learning__options" role="radiogroup">
      {options.map((option, index) => (
        <button key={option.optionId} type="button" role="radio" disabled={disabled}
          data-option-id={option.optionId} aria-checked={selected === option.optionId}
          onClick={() => onSelect(option.optionId)}>
          <span>{String.fromCharCode(65 + index)}</span><span>{option.label}</span>
        </button>
      ))}
    </div>
  )
}

function KnowledgeCheck({ unit, selected, submittingId, error, onSelect, onSubmit }: {
  unit: LearningUnit
  selected: Record<string, string>
  submittingId?: string
  error?: string
  onSelect(assessmentId: string, optionId: string): void
  onSubmit(assessment: LearningAssessment): void
}) {
  const main = unit.check.main
  const retest = unit.check.retest
  const mainSelection = selected[main.assessmentId] ?? main.attempt?.selectedOptionId
  const retestSelection = selected[retest.assessmentId] ?? retest.attempt?.selectedOptionId
  const needsRemediation = main.attempt?.correct === false
    || unit.mastery.status === 'remediation_required'
    || unit.mastery.status === 'learning'
    || unit.mastery.status === 'mastered_after_remediation'
  return (
    <section className="betterlearn-learning__check" aria-labelledby={`check-${unit.unitId}`}>
      <div className="betterlearn-learning__section-label"><span>理解检测</span><em>陈述辨析 · Core 判分</em></div>
      <h3 id={`check-${unit.unitId}`}>{main.prompt}</h3>
      <Options options={main.options} selected={mainSelection} disabled={main.attempt !== null}
        onSelect={optionId => onSelect(main.assessmentId, optionId)} />
      <button className="betterlearn-learning__primary" data-testid="learning-submit-check"
        type="button" disabled={mainSelection === undefined || main.attempt !== null || submittingId !== undefined}
        onClick={() => onSubmit(main)}>{submittingId === main.assessmentId ? '正在判分…' : main.attempt ? '已提交' : '提交答案'}</button>
      {main.attempt?.correct === true && (
        <div className="betterlearn-learning__passed" data-testid="learning-passed">
          <strong>检测通过</strong><span>你识别出了“{unit.title}”的准确陈述，掌握记录已保存。</span>
        </div>
      )}
      {needsRemediation && (
        <div className="betterlearn-learning__remediation" data-testid="learning-remediation">
          <p className="betterlearn-learning__kicker">根据本题结果补救</p>
          <h4>{unit.check.remediation.title}</h4>
          <p>{unit.check.remediation.body}</p>
          <div className="betterlearn-learning__retest">
            <div className="betterlearn-learning__section-label"><span>证据复测</span><em>定位真实原文</em></div>
            <h4>{retest.prompt}</h4>
            <Options options={retest.options} selected={retestSelection}
              disabled={retest.attempt?.correct === true}
              onSelect={optionId => onSelect(retest.assessmentId, optionId)} />
            <button className="betterlearn-learning__primary" data-testid="learning-submit-retest"
              type="button" disabled={retestSelection === undefined || retest.attempt?.correct === true || submittingId !== undefined}
              onClick={() => onSubmit(retest)}>{submittingId === retest.assessmentId ? '正在判分…' : '提交复测'}</button>
            {retest.attempt?.correct === true && (
              <div className="betterlearn-learning__passed" data-testid="learning-retest-passed">
                <strong>复测通过</strong><span>结论与原文证据已经对应，掌握度和复习时间已更新。</span>
              </div>
            )}
            {retest.attempt?.correct === false && (
              <p className="betterlearn-learning__retry">这段引文支持的是另一个知识点。重新比较结论的对象与关系后再试一次。</p>
            )}
          </div>
        </div>
      )}
      {error && <p className="betterlearn-learning__operation-error" role="alert">{error}</p>}
    </section>
  )
}

function Lesson({ unit, selected, submittingId, error, onSelect, onSubmit }: {
  unit: LearningUnit
  selected: Record<string, string>
  submittingId?: string
  error?: string
  onSelect(assessmentId: string, optionId: string): void
  onSubmit(assessment: LearningAssessment): void
}) {
  return (
    <main className="betterlearn-learning__lesson" data-testid="learning-lesson">
      <header className="betterlearn-learning__lesson-heading">
        <div>
          <p className="betterlearn-learning__kicker">当前单元 · {unit.type}</p>
          <h1>{unit.title}</h1>
        </div>
        <span className="betterlearn-learning__preview-chip">学习记录已保存</span>
      </header>
      <section className="betterlearn-learning__objective">
        <span>本单元目标</span><strong>{unit.objective}</strong>
      </section>
      <section className="betterlearn-learning__explanation">
        <div className="betterlearn-learning__section-label"><span>核心讲解</span><em>来自已确认知识点</em></div>
        <p>{unit.lesson.explanation}</p>
      </section>
      <section className="betterlearn-learning__worked-example">
        <div className="betterlearn-learning__section-label"><span>证据练习</span><em>结论对应原文</em></div>
        <p>{unit.lesson.workedExample}</p>
      </section>
      <aside className="betterlearn-learning__supplement">
        <span>学习提示</span><p>{unit.lesson.supplemental}</p>
      </aside>
      <KnowledgeCheck unit={unit} selected={selected} submittingId={submittingId} error={error}
        onSelect={onSelect} onSubmit={onSubmit} />
    </main>
  )
}

function dueLabel(value: string | null): string {
  if (value === null) return '—'
  return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function EvidencePanel({ unit, sourceText }: { unit: LearningUnit; sourceText: string }) {
  return (
    <aside className="betterlearn-learning__evidence" data-testid="learning-evidence" aria-label="证据与掌握状态">
      <section>
        <p className="betterlearn-learning__kicker">原文证据</p>
        <h2>结论来自这里</h2>
        {unit.evidence.kind === 'quote' ? (
          <blockquote>
            <span>{unit.evidence.contextBefore}</span>
            <mark>{unit.evidence.quote}</mark>
            <span>{unit.evidence.contextAfter}</span>
          </blockquote>
        ) : <p className="betterlearn-learning__evidence-empty">{unit.evidence.text}</p>}
        <small>当前材料 · {sourceText.length.toLocaleString()} 字符</small>
      </section>
      <section className="betterlearn-learning__mastery">
        <div className="betterlearn-learning__section-label"><span>学习状态</span><em>{STATUS_LABELS[unit.mastery.status]}</em></div>
        <div className="betterlearn-learning__mastery-ring"><strong>{unit.mastery.strength}%</strong><span>{STATUS_LABELS[unit.mastery.status]}</span></div>
        <dl>
          <div><dt>核心目标</dt><dd>1</dd></div>
          <div><dt>复习到期</dt><dd>{dueLabel(unit.mastery.dueAt)}</dd></div>
          <div><dt>证据锚点</dt><dd>{unit.evidence.kind === 'quote' ? 1 : 0}</dd></div>
        </dl>
      </section>
    </aside>
  )
}

export function LearningSpace({
  book, api, leftOpen, rightOpen,
  onLeftOpenChange, onRightOpenChange, onCourseChange, onExit,
}: LearningSpaceProps) {
  const [course, setCourse] = useState<LearningCourse>()
  const [loadingError, setLoadingError] = useState<string>()
  const [reload, setReload] = useState(0)
  const [activeUnitId, setActiveUnitId] = useState<string>()
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [submittingId, setSubmittingId] = useState<string>()
  const [operationError, setOperationError] = useState<string>()

  useEffect(() => {
    const controller = new AbortController()
    setLoadingError(undefined)
    api.syncLearningCourse({
      clientBookId: book.bookId,
      title: book.title,
      knowledgePointIds: book.points.map(point => point.knowledgePointId),
    }, controller.signal).then(next => {
      if (controller.signal.aborted) return
      setCourse(next)
      setActiveUnitId(current => current ?? next.units[0]?.unitId)
      onCourseChange(next)
    }).catch(error => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setLoadingError('学习内容加载失败，请重试。')
      }
    })
    return () => controller.abort()
  }, [api, book.bookId, book.title, reload])

  const activeUnit = useMemo(
    () => course?.units.find(unit => unit.unitId === activeUnitId) ?? course?.units[0],
    [activeUnitId, course],
  )

  const submit = async (assessment: LearningAssessment) => {
    const optionId = selected[assessment.assessmentId] ?? assessment.attempt?.selectedOptionId
    if (optionId === undefined || submittingId !== undefined) return
    setSubmittingId(assessment.assessmentId)
    setOperationError(undefined)
    try {
      const result = await api.submitLearningAttempt(assessment.assessmentId, {
        optionId,
        idempotencyKey: idempotencyKey(),
      })
      setCourse(result.course)
      onCourseChange(result.course)
    } catch {
      setOperationError('答案没有保存成功，请重新提交。')
    } finally {
      setSubmittingId(undefined)
    }
  }

  if (course === undefined) {
    return (
      <section className="betterlearn-learning" data-left-open={leftOpen ? 'true' : 'false'}
        data-right-open={rightOpen ? 'true' : 'false'}>
        <header className="betterlearn-learning__toolbar">
          <p><span>{book.title}</span><strong>准备学习内容</strong></p>
          <button type="button" aria-label="返回学习书架" onClick={onExit}>返回</button>
        </header>
        <main className="betterlearn-learning__loading" data-testid={loadingError ? 'learning-load-error' : 'learning-loading'}>
          {loadingError ? <><h2>{loadingError}</h2><button type="button" onClick={() => setReload(value => value + 1)}>重新加载</button></>
            : <><span className="betterlearn-learning__loading-dot" /><h2>正在从已确认知识点编译学习单元…</h2><p>题目、作答和掌握度会保存到 BetterLearn。</p></>}
        </main>
      </section>
    )
  }

  return (
    <section className="betterlearn-learning" data-left-open={leftOpen ? 'true' : 'false'}
      data-right-open={rightOpen ? 'true' : 'false'}>
      <header className="betterlearn-learning__toolbar">
        <div>
          <button type="button" aria-label={leftOpen ? '收起课程路径' : '展开课程路径'}
            aria-expanded={leftOpen} onClick={() => onLeftOpenChange(!leftOpen)}>路径</button>
          <button type="button" aria-label={rightOpen ? '收起证据与掌握状态' : '展开证据与掌握状态'}
            aria-expanded={rightOpen} onClick={() => onRightOpenChange(!rightOpen)}>证据</button>
        </div>
        <p><span>学习进度</span><strong>{course.progress.completed} / {course.progress.total} · {course.progress.mastery}%</strong></p>
        <button type="button" aria-label="返回学习书架" onClick={onExit}>返回</button>
      </header>
      <div className="betterlearn-learning__body">
        {leftOpen && <UnitPath course={course} activeUnitId={activeUnit?.unitId} onSelect={setActiveUnitId} />}
        {activeUnit === undefined ? (
          <main className="betterlearn-learning__empty">这本学习书没有可学习的单元。</main>
        ) : (
          <Lesson unit={activeUnit} selected={selected} submittingId={submittingId}
            error={operationError}
            onSelect={(assessmentId, optionId) => setSelected(current => ({ ...current, [assessmentId]: optionId }))}
            onSubmit={submit} />
        )}
        {rightOpen && activeUnit !== undefined && <EvidencePanel unit={activeUnit} sourceText={book.sourceText} />}
      </div>
    </section>
  )
}
