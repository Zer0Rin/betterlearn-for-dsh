import { describe, expect, test } from 'vitest'
import {
  LEARNING_BOOK_STORAGE_KEY,
  createLearningBook,
  reviseLearningBook,
  updateLearningBookCourse,
  readLearningBooks,
  writeLearningBooks,
} from '../src/client/learning-book-library.js'
import type { KnowledgePointSnapshot } from '../src/client/types.js'

class MemoryStorage implements Storage {
  #items = new Map<string, string>()
  get length() { return this.#items.size }
  clear() { this.#items.clear() }
  getItem(key: string) { return this.#items.get(key) ?? null }
  key(index: number) { return [...this.#items.keys()][index] ?? null }
  removeItem(key: string) { this.#items.delete(key) }
  setItem(key: string, value: string) { this.#items.set(key, value) }
}

const point: KnowledgePointSnapshot = {
  knowledgePointId: 'kp_closure', documentId: 'doc_1', type: 'concept', title: '闭包',
  statement: '闭包由函数及其词法环境构成。',
  evidence: [{ seq: 0, quote: '内部函数保留词法环境', textStart: 0, textEnd: 10,
    contextBefore: '', contextAfter: '。' }],
}

const second: KnowledgePointSnapshot = {
  ...point,
  knowledgePointId: 'kp_scope',
  title: '词法作用域',
  statement: '词法作用域由代码书写位置确定。',
}

describe('learning book library', () => {
  test('revises an unstarted book in place without mutating its snapshots', () => {
    const original = createLearningBook({ title: '旧标题', points: [point], sourceText: '正文' },
      { bookId: 'book-1', createdAt: '2026-09-01T10:00:00.000Z' })

    const result = reviseLearningBook(original, { title: '新标题', points: [second, point] },
      { bookId: 'unused', createdAt: '2026-09-01T11:00:00.000Z' })

    expect(result.replacesBookId).toBe('book-1')
    expect(result.book).toMatchObject({
      bookId: 'book-1', title: '新标题', createdAt: original.createdAt,
    })
    expect(result.book.points).toEqual([second, point])
    expect(original).toMatchObject({ title: '旧标题', points: [point] })
    expect(result.book.points).not.toBe(original.points)
  })

  test('revises a started book as a fresh version without inherited progress', () => {
    const started = {
      ...createLearningBook({ title: '原书', points: [point], sourceText: '正文' },
        { bookId: 'book-old', createdAt: '2026-09-01T10:00:00.000Z' }),
      courseId: 'course_0123456789abcdefabcd',
      progress: { completed: 1, total: 1, mastery: 70 },
    }

    const result = reviseLearningBook(started, { title: '原书 · 新版', points: [point] },
      { bookId: 'book-new', createdAt: '2026-09-01T11:00:00.000Z' })

    expect(result.replacesBookId).toBeUndefined()
    expect(result.book).toMatchObject({ bookId: 'book-new', title: '原书 · 新版' })
    expect(result.book).not.toHaveProperty('courseId')
    expect(result.book).not.toHaveProperty('progress')
    expect(started.courseId).toBe('course_0123456789abcdefabcd')
  })

  test('creates distinct books from the same formal knowledge points', () => {
    const first = createLearningBook({ title: '闭包训练', points: [point], sourceText: '正文' },
      { bookId: 'book-1', createdAt: '2026-09-01T10:00:00.000Z' })
    const second = createLearningBook({ title: '闭包训练 2', points: [point], sourceText: '正文' },
      { bookId: 'book-2', createdAt: '2026-09-01T10:01:00.000Z' })

    expect(first.bookId).not.toBe(second.bookId)
    expect(first).not.toHaveProperty('course')
    expect(first.courseId).toBeUndefined()
    expect(second.courseId).toBeUndefined()
  })

  test('round trips ordered books and caches only Core progress projection', () => {
    const storage = new MemoryStorage()
    const first = createLearningBook({ title: '第一本', points: [point], sourceText: '正文一' },
      { bookId: 'book-1', createdAt: '2026-09-01T10:00:00.000Z' })
    const second = createLearningBook({ title: '第二本', points: [point], sourceText: '正文二' },
      { bookId: 'book-2', createdAt: '2026-09-01T10:01:00.000Z' })

    const learned = updateLearningBookCourse(second, {
      courseId: 'course_0123456789abcdefabcd', clientBookId: second.bookId,
      title: second.title, status: 'active', progress: { completed: 1, total: 1, mastery: 70 }, units: [],
    })
    expect(writeLearningBooks(storage, [learned, first])).toBe(true)
    expect(JSON.parse(storage.getItem(LEARNING_BOOK_STORAGE_KEY)!)).toMatchObject({ version: 2 })
    expect(readLearningBooks(storage)).toEqual([learned, first])
  })

  test('rejects malformed, unknown-version, and extra-field storage payloads', () => {
    const storage = new MemoryStorage()
    for (const raw of [
      '{',
      JSON.stringify({ version: 3, books: [] }),
      JSON.stringify({ version: 1, books: [], extra: true }),
      JSON.stringify({ version: 1, books: [{ bookId: 'x' }] }),
    ]) {
      storage.setItem(LEARNING_BOOK_STORAGE_KEY, raw)
      expect(readLearningBooks(storage)).toEqual([])
    }
  })

  test('reads existing version-one books without inventing course state', () => {
    const storage = new MemoryStorage()
    storage.setItem(LEARNING_BOOK_STORAGE_KEY, JSON.stringify({
      version: 1,
      books: [{
        bookId: 'book-legacy', title: '旧学习书', createdAt: '2026-09-01T10:00:00.000Z',
        sourceText: '正文', points: [point],
      }],
    }))

    const [legacy] = readLearningBooks(storage)
    expect(legacy).toMatchObject({ bookId: 'book-legacy', title: '旧学习书' })
    expect(legacy).not.toHaveProperty('courseId')
    expect(legacy).not.toHaveProperty('progress')
  })

  test('reports blocked local storage without throwing', () => {
    const storage = new MemoryStorage()
    storage.setItem = () => { throw new Error('blocked') }
    const book = createLearningBook({ title: '仍可使用', points: [point], sourceText: '正文' },
      { bookId: 'book-memory', createdAt: '2026-09-01T10:00:00.000Z' })

    expect(writeLearningBooks(storage, [book])).toBe(false)
  })
})
