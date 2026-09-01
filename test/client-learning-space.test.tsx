import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, test, vi } from 'vitest'
import { LearningSpace } from '../src/client/components/LearningSpace.js'
import { createLearningBook } from '../src/client/learning-book-library.js'
import type { ClientApi, KnowledgePointSnapshot, LearningCourse } from '../src/client/types.js'

const points: KnowledgePointSnapshot[] = [
  {
    knowledgePointId: 'kp_11111111111111111111', documentId: 'doc_1', type: 'concept', title: '按需自助服务',
    statement: '用户无需人工交互即可自动配置计算资源。',
    evidence: [{ seq: 0, quote: '按需自助服务允许用户自动配置资源', textStart: 0, textEnd: 16,
      contextBefore: '', contextAfter: '。资源池共享资源。' }],
  },
  {
    knowledgePointId: 'kp_22222222222222222222', documentId: 'doc_1', type: 'concept', title: '资源池化',
    statement: '计算资源通过多租户模型形成共享资源池。',
    evidence: [{ seq: 0, quote: '资源池通过多租户模型共享资源', textStart: 17, textEnd: 31,
      contextBefore: '。', contextAfter: '。' }],
  },
]

const book = createLearningBook({
  title: 'NIST 云计算基本特征', points,
  sourceText: '按需自助服务允许用户自动配置资源。资源池通过多租户模型共享资源。',
}, { bookId: 'book-nist', createdAt: '2026-09-01T10:00:00.000Z' })

const course: LearningCourse = {
  courseId: 'course_11111111111111111111',
  clientBookId: book.bookId,
  title: book.title,
  status: 'active',
  progress: { completed: 0, total: 2, mastery: 0 },
  units: points.map((point, index) => ({
    unitId: `unit_${String(index + 1).repeat(20)}`,
    knowledgePointId: point.knowledgePointId,
    type: point.type,
    title: point.title,
    objective: `能够准确解释${point.title}，并从原文中定位支持证据。`,
    lesson: {
      explanation: point.statement,
      workedExample: `原文写道：“${point.evidence[0]!.quote}”。把这段原文与结论“${point.statement}”逐项对应。`,
      supplemental: '把概念拆成定义、成立条件和边界。',
    },
    evidence: { kind: 'quote' as const, quote: point.evidence[0]!.quote,
      contextBefore: point.evidence[0]!.contextBefore, contextAfter: point.evidence[0]!.contextAfter,
      textStart: point.evidence[0]!.textStart, textEnd: point.evidence[0]!.textEnd },
    mastery: { status: 'new' as const, strength: 0, dueAt: null },
    check: {
      main: {
        assessmentId: `asm_${index === 0 ? '1'.repeat(20) : '3'.repeat(20)}`,
        kind: 'claim_choice' as const,
        prompt: `以下哪一项准确说明“${point.title}”？`,
        options: [
          { optionId: `opt_${index === 0 ? '1'.repeat(20) : '3'.repeat(20)}`, label: point.statement },
          { optionId: `opt_${index === 0 ? '2'.repeat(20) : '4'.repeat(20)}`, label: points[index === 0 ? 1 : 0]!.statement },
        ],
        attempt: null,
      },
      remediation: {
        title: `重新核对“${point.title}”`,
        body: `先读已确认结论：“${point.statement}”再回到原文：“${point.evidence[0]!.quote}”。`,
      },
      retest: {
        assessmentId: `asm_${index === 0 ? '5'.repeat(20) : '7'.repeat(20)}`,
        kind: 'evidence_choice' as const,
        prompt: `以下哪段原文最直接支持：${point.statement}`,
        options: [
          { optionId: `opt_${index === 0 ? '5'.repeat(20) : '7'.repeat(20)}`, label: point.evidence[0]!.quote },
          { optionId: `opt_${index === 0 ? '6'.repeat(20) : '8'.repeat(20)}`, label: points[index === 0 ? 1 : 0]!.evidence[0]!.quote },
        ],
        attempt: null,
      },
    },
  })),
}

function cloneCourse(): LearningCourse {
  return JSON.parse(JSON.stringify(course)) as LearningCourse
}

function failedCourse(): LearningCourse {
  const next = cloneCourse()
  next.units[0]!.check.main.attempt = {
    selectedOptionId: 'opt_' + '2'.repeat(20), correct: false, submittedAt: '2026-09-01T10:01:00Z',
  }
  next.units[0]!.mastery = { status: 'remediation_required', strength: 20, dueAt: null }
  next.progress.mastery = 10
  return next
}

function passedRetestCourse(): LearningCourse {
  const next = failedCourse()
  next.units[0]!.check.retest.attempt = {
    selectedOptionId: 'opt_' + '5'.repeat(20), correct: true, submittedAt: '2026-09-01T10:02:00Z',
  }
  next.units[0]!.mastery = {
    status: 'mastered_after_remediation', strength: 70, dueAt: '2026-09-02T10:02:00Z',
  }
  next.progress = { completed: 1, total: 2, mastery: 35 }
  return next
}

function api(): Pick<ClientApi, 'syncLearningCourse' | 'submitLearningAttempt'> {
  return {
    syncLearningCourse: vi.fn(async () => cloneCourse()),
    submitLearningAttempt: vi.fn(async (assessmentId, input) => {
      const retest = assessmentId === 'asm_' + '5'.repeat(20)
      return {
        attempt: {
          attemptId: 'latt_' + 'a'.repeat(20), assessmentId,
          selectedOptionId: input.optionId, correct: retest,
          submittedAt: retest ? '2026-09-01T10:02:00Z' : '2026-09-01T10:01:00Z',
        },
        course: retest ? passedRetestCourse() : failedCourse(),
      }
    }),
  }
}

async function renderLearning(overrides: Partial<Parameters<typeof LearningSpace>[0]> = {}) {
  const props = {
    book,
    api: api(),
    leftOpen: true,
    rightOpen: true,
    onLeftOpenChange: vi.fn(),
    onRightOpenChange: vi.fn(),
    onCourseChange: vi.fn(),
    onExit: vi.fn(),
    ...overrides,
  }
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(<LearningSpace {...props} />) })
  await vi.waitFor(() => expect(renderer.root.findByProps({ 'data-testid': 'learning-lesson' })).toBeDefined())
  return { renderer, props }
}

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('')
}

describe('Core-backed learning space', () => {
  test('loads a persisted course and renders source-specific lesson and question', async () => {
    const { renderer, props } = await renderLearning()
    const output = textOf(renderer.root)

    expect(props.api.syncLearningCourse).toHaveBeenCalledWith({
      clientBookId: 'book-nist', title: 'NIST 云计算基本特征',
      knowledgePointIds: points.map(point => point.knowledgePointId),
    }, expect.any(AbortSignal))
    for (const text of [
      '学习记录已保存', '按需自助服务', '用户无需人工交互即可自动配置计算资源。',
      '以下哪一项准确说明“按需自助服务”？', '0 / 2 · 0%',
    ]) expect(output).toContain(text)
    expect(output).not.toContain('哪一种学习方式更可靠')
    expect(output).not.toContain('交互预览')
  })

  test('navigates between real units and preserves sidebar and exit controls', async () => {
    const { renderer, props } = await renderLearning()

    act(() => renderer.root.findByProps({ 'data-unit-id': 'unit_' + '2'.repeat(20) }).props.onClick())
    expect(textOf(renderer.root.findByProps({ 'data-testid': 'learning-lesson' }))).toContain('资源池化')
    act(() => renderer.root.findByProps({ 'aria-label': '收起课程路径' }).props.onClick())
    act(() => renderer.root.findByProps({ 'aria-label': '收起证据与掌握状态' }).props.onClick())
    act(() => renderer.root.findByProps({ 'aria-label': '返回学习书架' }).props.onClick())

    expect(props.onLeftOpenChange).toHaveBeenCalledWith(false)
    expect(props.onRightOpenChange).toHaveBeenCalledWith(false)
    expect(props.onExit).toHaveBeenCalledTimes(1)
  })

  test('persists a wrong answer, shows targeted remediation, and records passed evidence retest', async () => {
    const { renderer, props } = await renderLearning()

    act(() => renderer.root.findByProps({ 'data-option-id': 'opt_' + '2'.repeat(20) }).props.onClick())
    await act(async () => renderer.root.findByProps({ 'data-testid': 'learning-submit-check' }).props.onClick())
    expect(renderer.root.findByProps({ 'data-testid': 'learning-remediation' })).toBeDefined()
    expect(textOf(renderer.root)).toContain('先读已确认结论：“用户无需人工交互即可自动配置计算资源。”')
    expect(textOf(renderer.root)).toContain('以下哪段原文最直接支持')

    act(() => renderer.root.findByProps({ 'data-option-id': 'opt_' + '5'.repeat(20) }).props.onClick())
    await act(async () => renderer.root.findByProps({ 'data-testid': 'learning-submit-retest' }).props.onClick())

    expect(renderer.root.findByProps({ 'data-testid': 'learning-retest-passed' })).toBeDefined()
    expect(textOf(renderer.root)).toContain('1 / 2 · 35%')
    expect(textOf(renderer.root)).toContain('补救后掌握')
    expect(props.api.submitLearningAttempt).toHaveBeenCalledTimes(2)
    expect(props.onCourseChange).toHaveBeenLastCalledWith(expect.objectContaining({
      progress: { completed: 1, total: 2, mastery: 35 },
    }))
    for (const [, input] of vi.mocked(props.api.submitLearningAttempt).mock.calls) {
      expect(input.idempotencyKey).toMatch(/^idem_[0-9a-f]{20}$/)
    }
  })

  test('shows a retryable load failure instead of a fake lesson', async () => {
    const brokenApi = {
      syncLearningCourse: vi.fn(async () => { throw new Error('offline') }),
      submitLearningAttempt: vi.fn(),
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<LearningSpace book={book} api={brokenApi}
      leftOpen rightOpen onLeftOpenChange={vi.fn()} onRightOpenChange={vi.fn()}
      onCourseChange={vi.fn()} onExit={vi.fn()} />) })
    await vi.waitFor(() => expect(renderer.root.findByProps({ 'data-testid': 'learning-load-error' })).toBeDefined())
    expect(textOf(renderer.root)).toContain('学习内容加载失败，请重试。')
    expect(renderer.root.findAllByProps({ 'data-testid': 'learning-lesson' })).toHaveLength(0)
  })
})
