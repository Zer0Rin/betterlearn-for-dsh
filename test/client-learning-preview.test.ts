import { describe, expect, test } from 'vitest'
import { createLearningPreviewCourse, gradeLearningPreview } from '../src/client/learning-preview.js'
import type { KnowledgePointSnapshot } from '../src/client/types.js'

const sourceText = '词法作用域决定变量在哪里被解析。内部函数保留对其词法环境的引用，这种组合称为闭包。闭包常用于封装状态。'

function point(id: string, title: string, statement: string, quote?: string): KnowledgePointSnapshot {
  const textStart = quote === undefined ? -1 : sourceText.indexOf(quote)
  return {
    knowledgePointId: id,
    documentId: 'doc_preview',
    type: 'concept',
    title,
    statement,
    evidence: quote === undefined ? [] : [{
      seq: 0,
      quote,
      textStart,
      textEnd: textStart + quote.length,
      contextBefore: sourceText.slice(Math.max(0, textStart - 10), textStart),
      contextAfter: sourceText.slice(textStart + quote.length, textStart + quote.length + 10),
    }],
  }
}

describe('learning space preview model', () => {
  test('creates one evidence-grounded unit from one formal knowledge point', () => {
    const course = createLearningPreviewCourse([
      point('kp_closure', '闭包', '闭包由函数及其词法环境共同构成。', '内部函数保留对其词法环境的引用'),
    ], sourceText)

    expect(course).toMatchObject({
      courseId: 'preview-kp_closure',
      title: '闭包 · 学习路径',
      preview: true,
    })
    expect(course.units).toHaveLength(1)
    expect(course.units[0]).toMatchObject({
      unitId: 'unit-kp_closure',
      knowledgePointId: 'kp_closure',
      title: '闭包',
      objective: '能够用自己的话解释闭包，并把结论对应到原文证据。',
      delivery: 'current',
      evidence: { kind: 'quote', quote: '内部函数保留对其词法环境的引用' },
    })
    expect(course.units[0]?.lesson.explanation).toBe('闭包由函数及其词法环境共同构成。')
  })

  test('preserves selected point order and marks only the first unit current', () => {
    const course = createLearningPreviewCourse([
      point('kp_scope', '词法作用域', '变量解析由代码书写位置决定。', '词法作用域决定变量在哪里被解析'),
      point('kp_closure', '闭包', '闭包保留其词法环境。', '内部函数保留对其词法环境的引用'),
      point('kp_state', '状态封装', '闭包可以封装状态。', '闭包常用于封装状态'),
    ], sourceText)

    expect(course.units.map(unit => unit.title)).toEqual(['词法作用域', '闭包', '状态封装'])
    expect(course.units.map(unit => unit.delivery)).toEqual(['current', 'upcoming', 'upcoming'])
    expect(course.progress).toEqual({ completed: 0, total: 3, mastery: 0 })
  })

  test('uses an explicit summary fallback when no exact evidence exists', () => {
    const course = createLearningPreviewCourse([
      point('kp_summary', '正式陈述', '这是用户审核后的知识点。'),
    ], sourceText)

    expect(course.units[0]?.evidence).toEqual({
      kind: 'summary',
      text: '当前知识点没有可定位的原文引用，本预览只展示已确认陈述。',
    })
  })

  test('grades preview choices without placing an answer key in the public course model', () => {
    const course = createLearningPreviewCourse([
      point('kp_closure', '闭包', '闭包保留其词法环境。', '内部函数保留对其词法环境的引用'),
    ], sourceText)
    const question = course.units[0]!.check

    expect(question).not.toHaveProperty('correctOptionId')
    expect(gradeLearningPreview(question.questionId, 'evidence-backed')).toBe(true)
    expect(gradeLearningPreview(question.questionId, 'detached')).toBe(false)
    expect(gradeLearningPreview(question.retest.questionId, 'transfer')).toBe(true)
  })
})
