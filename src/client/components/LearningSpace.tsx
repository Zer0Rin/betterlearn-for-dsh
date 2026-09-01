import { useMemo, useState } from 'react'
import {
  gradeLearningPreview,
  type LearningPreviewCourse,
  type LearningPreviewOption,
  type LearningPreviewUnit,
} from '../learning-preview.js'

interface LearningAttemptPreview {
  selected?: string
  result?: 'correct' | 'incorrect'
  retestSelected?: string
  retestPassed?: boolean
}

export interface LearningSpaceProps {
  course: LearningPreviewCourse
  sourceText: string
  leftOpen: boolean
  rightOpen: boolean
  onLeftOpenChange(open: boolean): void
  onRightOpenChange(open: boolean): void
  onExit(): void
}

function UnitPath({ course, activeUnitId, onSelect }: {
  course: LearningPreviewCourse
  activeUnitId: string | undefined
  onSelect(unitId: string): void
}) {
  return (
    <nav className="betterlearn-learning__path" data-testid="learning-path" aria-label="课程路径">
      <div className="betterlearn-learning__path-heading">
        <p className="betterlearn-learning__kicker">课程路径</p>
        <h2>{course.title}</h2>
        <p>{course.units.length} 个学习单元</p>
      </div>
      <ol>
        {course.units.map((unit, index) => (
          <li key={unit.unitId} data-delivery={unit.delivery}>
            <button type="button" data-unit-id={unit.unitId}
              aria-current={unit.unitId === activeUnitId ? 'step' : undefined}
              onClick={() => onSelect(unit.unitId)}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <span><strong>{unit.title}</strong><small>{unit.objective}</small></span>
            </button>
          </li>
        ))}
      </ol>
      <div className="betterlearn-learning__today">
        <span>今日复习</span>
        <strong>预览中暂无到期目标</strong>
      </div>
    </nav>
  )
}

function Options({ options, selected, onSelect }: {
  options: LearningPreviewOption[]
  selected: string | undefined
  onSelect(optionId: string): void
}) {
  return (
    <div className="betterlearn-learning__options" role="radiogroup">
      {options.map((option, index) => (
        <button key={option.optionId} type="button" role="radio"
          data-option-id={option.optionId} aria-checked={selected === option.optionId}
          onClick={() => onSelect(option.optionId)}>
          <span>{String.fromCharCode(65 + index)}</span><span>{option.label}</span>
        </button>
      ))}
    </div>
  )
}

function KnowledgeCheck({ unit, attempt, onChange }: {
  unit: LearningPreviewUnit
  attempt: LearningAttemptPreview
  onChange(next: LearningAttemptPreview): void
}) {
  const submit = () => {
    if (attempt.selected === undefined) return
    onChange({
      ...attempt,
      result: gradeLearningPreview(unit.check.questionId, attempt.selected) ? 'correct' : 'incorrect',
    })
  }
  const submitRetest = () => {
    if (attempt.retestSelected === undefined) return
    onChange({
      ...attempt,
      retestPassed: gradeLearningPreview(unit.check.retest.questionId, attempt.retestSelected),
    })
  }
  return (
    <section className="betterlearn-learning__check" aria-labelledby={`check-${unit.unitId}`}>
      <div className="betterlearn-learning__section-label"><span>理解检测</span><em>交互预览</em></div>
      <h3 id={`check-${unit.unitId}`}>{unit.check.prompt}</h3>
      <Options options={unit.check.options} selected={attempt.selected}
        onSelect={selected => onChange({ ...attempt, selected, result: undefined })} />
      <button className="betterlearn-learning__primary" data-testid="learning-submit-check"
        type="button" disabled={attempt.selected === undefined} onClick={submit}>提交答案</button>
      {attempt.result === 'correct' && (
        <div className="betterlearn-learning__passed" data-testid="learning-passed">
          <strong>检测通过</strong><span>你把结论和证据联系起来了。</span>
        </div>
      )}
      {attempt.result === 'incorrect' && (
        <div className="betterlearn-learning__remediation" data-testid="learning-remediation">
          <p className="betterlearn-learning__kicker">先回到证据</p>
          <h4>补上“结论从哪里来”这一步</h4>
          <p>{unit.check.remediation}</p>
          <div className="betterlearn-learning__retest">
            <div className="betterlearn-learning__section-label"><span>变式复测</span><em>不重复原题</em></div>
            <h4>{unit.check.retest.prompt}</h4>
            <Options options={unit.check.retest.options} selected={attempt.retestSelected}
              onSelect={retestSelected => onChange({ ...attempt, retestSelected, retestPassed: undefined })} />
            <button className="betterlearn-learning__primary" data-testid="learning-submit-retest"
              type="button" disabled={attempt.retestSelected === undefined} onClick={submitRetest}>提交复测</button>
            {attempt.retestPassed === true && (
              <div className="betterlearn-learning__passed" data-testid="learning-passed">
                <strong>复测通过</strong><span>这个目标在正式版本中会进入掌握记录。</span>
              </div>
            )}
            {attempt.retestPassed === false && (
              <p className="betterlearn-learning__retry">还差一步：关键词相同不等于证据关系相同。</p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function Lesson({ unit, attempt, onAttemptChange }: {
  unit: LearningPreviewUnit
  attempt: LearningAttemptPreview
  onAttemptChange(next: LearningAttemptPreview): void
}) {
  return (
    <main className="betterlearn-learning__lesson" data-testid="learning-lesson">
      <header className="betterlearn-learning__lesson-heading">
        <div>
          <p className="betterlearn-learning__kicker">当前单元 · {unit.type}</p>
          <h1>{unit.title}</h1>
        </div>
        <span className="betterlearn-learning__preview-chip">交互预览 · 数据不会保存</span>
      </header>
      <section className="betterlearn-learning__objective">
        <span>本单元目标</span><strong>{unit.objective}</strong>
      </section>
      <section className="betterlearn-learning__explanation">
        <div className="betterlearn-learning__section-label"><span>核心讲解</span><em>来自已确认知识点</em></div>
        <p>{unit.lesson.explanation}</p>
      </section>
      <section className="betterlearn-learning__worked-example">
        <div className="betterlearn-learning__section-label"><span>证据练习</span><em>先定位，再解释</em></div>
        <p>{unit.lesson.workedExample}</p>
      </section>
      <aside className="betterlearn-learning__supplement">
        <span>辅助解释</span><p>{unit.lesson.supplemental.replace(/^辅助解释：/, '')}</p>
      </aside>
      <KnowledgeCheck unit={unit} attempt={attempt} onChange={onAttemptChange} />
    </main>
  )
}

function EvidencePanel({ unit, sourceText }: { unit: LearningPreviewUnit; sourceText: string }) {
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
        <div className="betterlearn-learning__section-label"><span>学习状态</span><em>预览</em></div>
        <div className="betterlearn-learning__mastery-ring"><strong>0%</strong><span>尚未记录</span></div>
        <dl>
          <div><dt>核心目标</dt><dd>1</dd></div>
          <div><dt>复习到期</dt><dd>—</dd></div>
          <div><dt>证据锚点</dt><dd>{unit.evidence.kind === 'quote' ? 1 : 0}</dd></div>
        </dl>
      </section>
    </aside>
  )
}

export function LearningSpace({
  course, sourceText, leftOpen, rightOpen,
  onLeftOpenChange, onRightOpenChange, onExit,
}: LearningSpaceProps) {
  const [activeUnitId, setActiveUnitId] = useState(course.units[0]?.unitId)
  const [attempts, setAttempts] = useState<Record<string, LearningAttemptPreview>>({})
  const activeUnit = useMemo(
    () => course.units.find(unit => unit.unitId === activeUnitId) ?? course.units[0],
    [activeUnitId, course.units],
  )
  const attempt = activeUnit === undefined ? {} : attempts[activeUnit.unitId] ?? {}
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
        <p><span>学习进度</span><strong>{course.progress.completed} / {course.progress.total}</strong></p>
        <button type="button" aria-label="返回学习书架" onClick={onExit}>返回</button>
      </header>
      <div className="betterlearn-learning__body">
        {leftOpen && <UnitPath course={course} activeUnitId={activeUnit?.unitId} onSelect={setActiveUnitId} />}
        {activeUnit === undefined ? (
          <main className="betterlearn-learning__empty">没有可预览的知识点。</main>
        ) : (
          <Lesson unit={activeUnit} attempt={attempt}
            onAttemptChange={next => setAttempts(current => ({ ...current, [activeUnit.unitId]: next }))} />
        )}
        {rightOpen && activeUnit !== undefined && <EvidencePanel unit={activeUnit} sourceText={sourceText} />}
      </div>
    </section>
  )
}
