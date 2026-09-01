import { act, create } from 'react-test-renderer'
import { describe, expect, test, vi } from 'vitest'
import {
  BetterLearnGateway, LearningBookComposer, LearningBookshelf,
} from '../src/client/components/LearningLibrary.js'
import { createLearningBook } from '../src/client/learning-book-library.js'
import type { KnowledgePointSnapshot } from '../src/client/types.js'

const point: KnowledgePointSnapshot = {
  knowledgePointId: 'kp_closure', documentId: 'doc_1', type: 'concept', title: '闭包',
  statement: '闭包由函数及其词法环境构成。',
  evidence: [{ seq: 0, quote: '函数保留词法环境', textStart: 0, textEnd: 8,
    contextBefore: '', contextAfter: '。' }],
}

const second: KnowledgePointSnapshot = {
  ...point,
  knowledgePointId: 'kp_scope',
  title: '词法作用域',
  statement: '词法作用域由代码书写位置确定。',
}

describe('BetterLearn primary entrances and learning bookshelf', () => {
  test('presents knowledge points and learning space as two primary entrances', () => {
    const onOpenKnowledge = vi.fn()
    const onOpenLearning = vi.fn()
    const renderer = create(<BetterLearnGateway bookCount={2} knowledgeAvailable
      onOpenKnowledge={onOpenKnowledge} onOpenLearning={onOpenLearning} />)

    act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-knowledge-entry' }).props.onClick())
    act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-library-entry' }).props.onClick())

    expect(onOpenKnowledge).toHaveBeenCalledTimes(1)
    expect(onOpenLearning).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(renderer.toJSON())).toContain('2 本学习书')
  })

  test('shows integrated knowledge as a learning book before opening a lesson', () => {
    const book = createLearningBook({ title: '闭包学习书', points: [point], sourceText: '函数保留词法环境。' },
      { bookId: 'book-1', createdAt: '2026-09-01T10:00:00.000Z' })
    const onOpenBook = vi.fn()
    const renderer = create(<LearningBookshelf books={[book]} newBookId="book-1"
      storageWarning="本次可用，关闭后可能丢失" onOpenBook={onOpenBook} onOpenKnowledge={vi.fn()} />)

    expect(renderer.root.findByProps({ 'data-testid': 'learning-bookshelf' })).toBeDefined()
    expect(renderer.root.findAllByProps({ 'data-testid': 'learning-lesson' })).toHaveLength(0)
    expect(renderer.root.findByProps({ 'data-testid': 'learning-book-book-1' }).props['data-new']).toBe('true')
    expect(JSON.stringify(renderer.toJSON())).toContain('本次可用，关闭后可能丢失')
    act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-book-1' }).props.onClick())
    expect(onOpenBook).toHaveBeenCalledWith(book)
  })

  test('guides an empty learning space back to knowledge extraction', () => {
    const onOpenKnowledge = vi.fn()
    const renderer = create(<LearningBookshelf books={[]} onOpenBook={vi.fn()}
      onOpenKnowledge={onOpenKnowledge} />)

    expect(JSON.stringify(renderer.toJSON())).toContain('还没有学习书')
    act(() => renderer.root.findByProps({ 'data-testid': 'learning-library-empty-action' }).props.onClick())
    expect(onOpenKnowledge).toHaveBeenCalledTimes(1)
  })

  test('edits the title and moves points before creating a draft', () => {
    const onCreate = vi.fn()
    const renderer = create(<LearningBookComposer points={[point, second]}
      onCreate={onCreate} onCancel={vi.fn()} />)

    act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-title' }).props
      .onChange({ currentTarget: { value: '我的学习书' } }))
    act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-move-up-kp_scope' })
      .props.onClick())
    act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-create' }).props.onClick())

    expect(onCreate).toHaveBeenCalledWith({ title: '我的学习书', points: [second, point] })
  })

  test('supports moving down, removing a point, and cancelling', () => {
    const onCancel = vi.fn()
    const renderer = create(<LearningBookComposer points={[point, second]}
      onCreate={vi.fn()} onCancel={onCancel} />)

    expect(renderer.root.findByProps({ 'data-testid': 'learning-book-move-up-kp_closure' })
      .props.disabled).toBe(true)
    expect(renderer.root.findByProps({ 'data-testid': 'learning-book-move-down-kp_scope' })
      .props.disabled).toBe(true)
    act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-move-down-kp_closure' })
      .props.onClick())
    act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-remove-kp_closure' })
      .props.onClick())
    expect(renderer.root.findAllByProps({ 'data-testid': 'learning-book-point-kp_closure' }))
      .toHaveLength(0)
    act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-cancel' }).props.onClick())
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test('prevents creation with a blank title or no remaining points', () => {
    const renderer = create(<LearningBookComposer points={[point]}
      onCreate={vi.fn()} onCancel={vi.fn()} />)

    act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-title' }).props
      .onChange({ currentTarget: { value: '   ' } }))
    expect(renderer.root.findByProps({ 'data-testid': 'learning-book-create' }).props.disabled).toBe(true)
    act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-title' }).props
      .onChange({ currentTarget: { value: '新书' } }))
    act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-remove-kp_closure' })
      .props.onClick())
    expect(renderer.root.findByProps({ 'data-testid': 'learning-book-create' }).props.disabled).toBe(true)
    expect(JSON.stringify(renderer.toJSON())).toContain('至少保留一个知识点')
  })
})
