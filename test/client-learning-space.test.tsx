import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, test, vi } from 'vitest'
import { LearningSpace } from '../src/client/components/LearningSpace.js'
import { createLearningPreviewCourse } from '../src/client/learning-preview.js'
import type { KnowledgePointSnapshot } from '../src/client/types.js'

const points: KnowledgePointSnapshot[] = [
  {
    knowledgePointId: 'kp_scope', documentId: 'doc_1', type: 'concept', title: '词法作用域',
    statement: '变量的解析位置由代码书写时的嵌套关系决定。',
    evidence: [{ seq: 0, quote: '词法作用域决定变量在哪里被解析', textStart: 0, textEnd: 16,
      contextBefore: '', contextAfter: '。内部函数保留环境。' }],
  },
  {
    knowledgePointId: 'kp_closure', documentId: 'doc_1', type: 'concept', title: '闭包',
    statement: '闭包由函数及其保留的词法环境组成。',
    evidence: [{ seq: 0, quote: '内部函数保留环境', textStart: 17, textEnd: 25,
      contextBefore: '变量在哪里被解析。', contextAfter: '。' }],
  },
]

function renderLearning(overrides: Partial<Parameters<typeof LearningSpace>[0]> = {}) {
  const props = {
    course: createLearningPreviewCourse(points, '词法作用域决定变量在哪里被解析。内部函数保留环境。'),
    sourceText: '词法作用域决定变量在哪里被解析。内部函数保留环境。',
    leftOpen: true,
    rightOpen: true,
    onLeftOpenChange: vi.fn(),
    onRightOpenChange: vi.fn(),
    onExit: vi.fn(),
    ...overrides,
  }
  let renderer!: ReactTestRenderer
  act(() => { renderer = create(<LearningSpace {...props} />) })
  return { renderer, props }
}

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('')
}

describe('interactive learning space', () => {
  test('renders course path, current lesson, evidence, and preview status', () => {
    const { renderer } = renderLearning()
    const output = textOf(renderer.root)

    expect(renderer.root.findByProps({ 'data-testid': 'learning-path' })).toBeDefined()
    expect(renderer.root.findByProps({ 'data-testid': 'learning-lesson' })).toBeDefined()
    expect(renderer.root.findByProps({ 'data-testid': 'learning-evidence' })).toBeDefined()
    for (const text of ['交互预览 · 数据不会保存', '词法作用域', '原文证据', '0 / 2']) {
      expect(output).toContain(text)
    }
  })

  test('navigates between units without changing the course model', () => {
    const { renderer } = renderLearning()

    act(() => renderer.root.findByProps({ 'data-unit-id': 'unit-kp_closure' }).props.onClick())

    expect(textOf(renderer.root.findByProps({ 'data-testid': 'learning-lesson' }))).toContain('闭包')
    expect(renderer.root.findByProps({ 'data-unit-id': 'unit-kp_closure' }).props['aria-current'])
      .toBe('step')
  })

  test('exposes independent controls for both sidebars and exit', () => {
    const { renderer, props } = renderLearning()

    act(() => renderer.root.findByProps({ 'aria-label': '收起课程路径' }).props.onClick())
    act(() => renderer.root.findByProps({ 'aria-label': '收起证据与掌握状态' }).props.onClick())
    act(() => renderer.root.findByProps({ 'aria-label': '返回学习书架' }).props.onClick())

    expect(props.onLeftOpenChange).toHaveBeenCalledWith(false)
    expect(props.onRightOpenChange).toHaveBeenCalledWith(false)
    expect(props.onExit).toHaveBeenCalledTimes(1)
  })

  test('reveals targeted remediation after an incorrect answer and passes a transfer retest', () => {
    const { renderer } = renderLearning()

    act(() => renderer.root.findByProps({ 'data-option-id': 'detached' }).props.onClick())
    act(() => renderer.root.findByProps({ 'data-testid': 'learning-submit-check' }).props.onClick())
    expect(JSON.stringify(renderer.toJSON())).toContain('先回到证据')
    expect(renderer.root.findByProps({ 'data-testid': 'learning-remediation' })).toBeDefined()

    act(() => renderer.root.findByProps({ 'data-option-id': 'transfer' }).props.onClick())
    act(() => renderer.root.findByProps({ 'data-testid': 'learning-submit-retest' }).props.onClick())

    expect(renderer.root.findByProps({ 'data-testid': 'learning-passed' })).toBeDefined()
    expect(JSON.stringify(renderer.toJSON())).toContain('复测通过')
  })
})
