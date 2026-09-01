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

  test('shows persisted completion and mastery on the bookshelf', () => {
    const book = {
      ...createLearningBook({ title: '闭包学习书', points: [point], sourceText: '正文' },
        { bookId: 'book-progress', createdAt: '2026-09-01T10:00:00.000Z' }),
      courseId: 'course_0123456789abcdefabcd',
      progress: { completed: 1, total: 2, mastery: 35 },
    }
    const renderer = create(<LearningBookshelf books={[book]} onOpenBook={vi.fn()}
      onOpenKnowledge={vi.fn()} />)

    expect(JSON.stringify(renderer.toJSON())).toContain('已完成 1/2 · 掌握度 35%')
    expect(JSON.stringify(renderer.toJSON())).toContain('继续学习')
  })

  test('keeps management actions hidden until management mode is enabled', () => {
    const book = createLearningBook({ title: '闭包学习书', points: [point], sourceText: '正文' },
      { bookId: 'book-1', createdAt: '2026-09-01T10:00:00.000Z' })
    const onOpenBook = vi.fn()
    const onEditBook = vi.fn()
    const renderer = create(<LearningBookshelf books={[book]} onOpenBook={onOpenBook}
      onEditBook={onEditBook} onDeleteBook={vi.fn(async () => undefined)}
      onOpenKnowledge={vi.fn()} />)

    expect(renderer.root.findAllByProps({ 'data-testid': 'learning-book-edit-book-1' }))
      .toHaveLength(0)
    act(() => renderer.root.findByProps({ 'data-testid': 'learning-library-manage' }).props.onClick())
    expect(JSON.stringify(renderer.toJSON())).toContain('完成')
    act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-edit-book-1' }).props.onClick())

    expect(onEditBook).toHaveBeenCalledWith(book)
    expect(onOpenBook).not.toHaveBeenCalled()
  })

  test('requires inline confirmation and supports cancelling deletion', () => {
    const book = createLearningBook({ title: '闭包学习书', points: [point], sourceText: '正文' },
      { bookId: 'book-1', createdAt: '2026-09-01T10:00:00.000Z' })
    const onDeleteBook = vi.fn(async () => undefined)
    const renderer = create(<LearningBookshelf books={[book]} onOpenBook={vi.fn()}
      onEditBook={vi.fn()} onDeleteBook={onDeleteBook} onOpenKnowledge={vi.fn()} />)

    act(() => renderer.root.findByProps({ 'data-testid': 'learning-library-manage' }).props.onClick())
    act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-delete-book-1' }).props.onClick())
    expect(onDeleteBook).not.toHaveBeenCalled()
    expect(JSON.stringify(renderer.toJSON())).toContain('删除这本学习书及全部学习记录？')
    act(() => renderer.root.findByProps({
      'data-testid': 'learning-book-delete-cancel-book-1',
    }).props.onClick())

    expect(onDeleteBook).not.toHaveBeenCalled()
    expect(JSON.stringify(renderer.toJSON())).not.toContain('删除这本学习书及全部学习记录？')
  })

  test('keeps a book actionable and reports when confirmed deletion fails', async () => {
    const book = createLearningBook({ title: '闭包学习书', points: [point], sourceText: '正文' },
      { bookId: 'book-1', createdAt: '2026-09-01T10:00:00.000Z' })
    const onDeleteBook = vi.fn(async () => { throw new Error('offline') })
    const renderer = create(<LearningBookshelf books={[book]} onOpenBook={vi.fn()}
      onEditBook={vi.fn()} onDeleteBook={onDeleteBook} onOpenKnowledge={vi.fn()} />)

    act(() => renderer.root.findByProps({ 'data-testid': 'learning-library-manage' }).props.onClick())
    act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-delete-book-1' }).props.onClick())
    await act(async () => renderer.root.findByProps({
      'data-testid': 'learning-book-delete-confirm-book-1',
    }).props.onClick())

    expect(onDeleteBook).toHaveBeenCalledWith(book)
    expect(JSON.stringify(renderer.toJSON())).toContain('删除失败，请重试。学习书和进度仍然保留。')
    expect(renderer.root.findByProps({ 'data-testid': 'learning-book-delete-confirm-book-1' })
      .props.disabled).toBe(false)
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

  test('uses the existing title and explicit edit-mode copy', () => {
    const onCreate = vi.fn()
    const renderer = create(<LearningBookComposer points={[point]} initialTitle="闭包旧书"
      heading="修改学习书" submitLabel="保存为新版本"
      onCreate={onCreate} onCancel={vi.fn()} />)

    expect(renderer.root.findByProps({ 'data-testid': 'learning-book-title' }).props.value)
      .toBe('闭包旧书')
    expect(JSON.stringify(renderer.toJSON())).toContain('修改学习书')
    act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-create' }).props.onClick())
    expect(onCreate).toHaveBeenCalledWith({ title: '闭包旧书', points: [point] })
    expect(JSON.stringify(renderer.toJSON())).toContain('保存为新版本')
  })
})
