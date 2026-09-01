import { describe, expect, test } from 'vitest'
import {
  LEARNING_LAYOUT_STORAGE_KEY,
  readLearningLayout,
  writeLearningLayout,
} from '../src/client/learning-layout.js'

class MemoryStorage implements Storage {
  #items = new Map<string, string>()
  get length() { return this.#items.size }
  clear() { this.#items.clear() }
  getItem(key: string) { return this.#items.get(key) ?? null }
  key(index: number) { return [...this.#items.keys()][index] ?? null }
  removeItem(key: string) { this.#items.delete(key) }
  setItem(key: string, value: string) { this.#items.set(key, value) }
}

describe('learning layout preferences', () => {
  test('defaults both adaptive sidebars to open', () => {
    expect(readLearningLayout(new MemoryStorage())).toEqual({ leftOpen: true, rightOpen: true })
  })

  test('round-trips only the versioned sidebar flags', () => {
    const storage = new MemoryStorage()
    writeLearningLayout(storage, { leftOpen: false, rightOpen: true })

    expect(JSON.parse(storage.getItem(LEARNING_LAYOUT_STORAGE_KEY)!)).toEqual({
      version: 1, leftOpen: false, rightOpen: true,
    })
    expect(readLearningLayout(storage)).toEqual({ leftOpen: false, rightOpen: true })
  })

  test('rejects malformed or extended stored objects', () => {
    const storage = new MemoryStorage()
    for (const value of [
      '{',
      JSON.stringify({ version: 2, leftOpen: false, rightOpen: false }),
      JSON.stringify({ version: 1, leftOpen: false, rightOpen: false, answer: 'leak' }),
    ]) {
      storage.setItem(LEARNING_LAYOUT_STORAGE_KEY, value)
      expect(readLearningLayout(storage)).toEqual({ leftOpen: true, rightOpen: true })
    }
  })
})
