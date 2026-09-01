import { describe, expect, test } from 'vitest'
import {
  LEARNING_BOOK_STORAGE_KEY,
  createLearningBook,
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

describe('learning book library', () => {
  test('creates distinct books from the same formal knowledge points', () => {
    const first = createLearningBook({ title: '闭包训练', points: [point], sourceText: '正文' },
      { bookId: 'book-1', createdAt: '2026-09-01T10:00:00.000Z' })
    const second = createLearningBook({ title: '闭包训练 2', points: [point], sourceText: '正文' },
      { bookId: 'book-2', createdAt: '2026-09-01T10:01:00.000Z' })

    expect(first.bookId).not.toBe(second.bookId)
    expect(first.course.courseId).toBe('book-1')
    expect(first.course.title).toBe('闭包训练')
    expect(second.course.courseId).toBe('book-2')
    expect(second.course.title).toBe('闭包训练 2')
  })

  test('round trips ordered books and rebuilds their derived courses', () => {
    const storage = new MemoryStorage()
    const first = createLearningBook({ title: '第一本', points: [point], sourceText: '正文一' },
      { bookId: 'book-1', createdAt: '2026-09-01T10:00:00.000Z' })
    const second = createLearningBook({ title: '第二本', points: [point], sourceText: '正文二' },
      { bookId: 'book-2', createdAt: '2026-09-01T10:01:00.000Z' })

    expect(writeLearningBooks(storage, [second, first])).toBe(true)
    expect(JSON.parse(storage.getItem(LEARNING_BOOK_STORAGE_KEY)!)).toMatchObject({ version: 1 })
    expect(readLearningBooks(storage)).toEqual([second, first])
  })

  test('rejects malformed, unknown-version, and extra-field storage payloads', () => {
    const storage = new MemoryStorage()
    for (const raw of [
      '{',
      JSON.stringify({ version: 2, books: [] }),
      JSON.stringify({ version: 1, books: [], extra: true }),
      JSON.stringify({ version: 1, books: [{ bookId: 'x' }] }),
    ]) {
      storage.setItem(LEARNING_BOOK_STORAGE_KEY, raw)
      expect(readLearningBooks(storage)).toEqual([])
    }
  })

  test('reports blocked local storage without throwing', () => {
    const storage = new MemoryStorage()
    storage.setItem = () => { throw new Error('blocked') }
    const book = createLearningBook({ title: '仍可使用', points: [point], sourceText: '正文' },
      { bookId: 'book-memory', createdAt: '2026-09-01T10:00:00.000Z' })

    expect(writeLearningBooks(storage, [book])).toBe(false)
  })
})
