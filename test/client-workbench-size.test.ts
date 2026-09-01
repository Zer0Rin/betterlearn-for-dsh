import { describe, expect, test } from 'vitest'
import {
  WORKBENCH_SIZE_STORAGE_KEY,
  clampWorkbenchSize,
  defaultWorkbenchSize,
  readWorkbenchSize,
  resizeFromPointer,
  writeWorkbenchSize,
} from '../src/client/workbench-size.js'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe('workbench size model', () => {
  test('uses a narrow result default and a wide review default', () => {
    expect(defaultWorkbenchSize('result', { width: 1440, height: 900 }))
      .toEqual({ width: 460, height: 720 })
    expect(defaultWorkbenchSize('review', { width: 1440, height: 900 }))
      .toEqual({ width: 900, height: 868 })
  })

  test('left-edge movement changes width opposite to pointer movement', () => {
    expect(resizeFromPointer(
      { width: 460, height: 600 }, 'width', -80, 0, { width: 1440, height: 900 },
    )).toEqual({ width: 540, height: 600 })
  })

  test('bottom movement changes height with pointer movement', () => {
    expect(resizeFromPointer(
      { width: 460, height: 600 }, 'height', 0, 80, { width: 1440, height: 900 },
    )).toEqual({ width: 460, height: 680 })
  })

  test('clamps both axes to desktop bounds', () => {
    expect(clampWorkbenchSize({ width: 10, height: 9 }, { width: 800, height: 600 }))
      .toEqual({ width: 360, height: 420 })
    expect(clampWorkbenchSize({ width: 5000, height: 5000 }, { width: 800, height: 600 }))
      .toEqual({ width: 768, height: 568 })
  })

  test('uses the visible viewport when it is smaller than desktop minimums', () => {
    expect(clampWorkbenchSize({ width: 460, height: 720 }, { width: 340, height: 400 }))
      .toEqual({ width: 308, height: 368 })
  })

  test('stores independent sizes by screen and ignores malformed storage', () => {
    const storage = memoryStorage()
    writeWorkbenchSize(storage, 'result', { width: 430, height: 650 })
    writeWorkbenchSize(storage, 'review', { width: 820, height: 700 })
    expect(readWorkbenchSize(storage, 'result')).toEqual({ width: 430, height: 650 })
    expect(readWorkbenchSize(storage, 'review')).toEqual({ width: 820, height: 700 })
    storage.setItem(WORKBENCH_SIZE_STORAGE_KEY, '{')
    expect(readWorkbenchSize(storage, 'result')).toBeUndefined()
  })

  test('ignores malformed entries without losing valid entries', () => {
    const storage = memoryStorage()
    storage.setItem(WORKBENCH_SIZE_STORAGE_KEY, JSON.stringify({
      result: { width: 'wide', height: 500 },
      review: { width: 800, height: 700 },
    }))
    expect(readWorkbenchSize(storage, 'result')).toBeUndefined()
    expect(readWorkbenchSize(storage, 'review')).toEqual({ width: 800, height: 700 })
  })
})
