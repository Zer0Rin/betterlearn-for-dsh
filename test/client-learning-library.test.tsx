import { act, create } from 'react-test-renderer'
import { describe, expect, test, vi } from 'vitest'
import { BetterLearnGateway, LearningBookshelf } from '../src/client/components/LearningLibrary.js'
import { createLearningPreviewCourse } from '../src/client/learning-preview.js'
import type { KnowledgePointSnapshot } from '../src/client/types.js'

const point: KnowledgePointSnapshot = {
  knowledgePointId: 'kp_closure', documentId: 'doc_1', type: 'concept', title: '闭包',
  statement: '闭包由函数及其词法环境构成。',
  evidence: [{ seq: 0, quote: '函数保留词法环境', textStart: 0, textEnd: 8,
    contextBefore: '', contextAfter: '。' }],
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
    const book = createLearningPreviewCourse([point], '函数保留词法环境。')
    const onOpenBook = vi.fn()
    const renderer = create(<LearningBookshelf books={[book]} onOpenBook={onOpenBook}
      onOpenKnowledge={vi.fn()} />)

    expect(renderer.root.findByProps({ 'data-testid': 'learning-bookshelf' })).toBeDefined()
    expect(renderer.root.findAllByProps({ 'data-testid': 'learning-lesson' })).toHaveLength(0)
    act(() => renderer.root.findByProps({ 'data-testid': `learning-book-${book.courseId}` }).props.onClick())
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
})
