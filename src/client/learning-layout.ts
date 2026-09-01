export const LEARNING_LAYOUT_STORAGE_KEY = 'betterlearn:learning-layout:v1'

export interface LearningLayout {
  leftOpen: boolean
  rightOpen: boolean
}

const DEFAULT_LAYOUT: LearningLayout = { leftOpen: true, rightOpen: true }

function isStoredLayout(value: unknown): value is LearningLayout & { version: 1 } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).sort().join(',') === 'leftOpen,rightOpen,version'
    && record.version === 1
    && typeof record.leftOpen === 'boolean'
    && typeof record.rightOpen === 'boolean'
}

export function readLearningLayout(storage: Storage): LearningLayout {
  try {
    const raw = storage.getItem(LEARNING_LAYOUT_STORAGE_KEY)
    if (raw === null) return { ...DEFAULT_LAYOUT }
    const parsed: unknown = JSON.parse(raw)
    return isStoredLayout(parsed)
      ? { leftOpen: parsed.leftOpen, rightOpen: parsed.rightOpen }
      : { ...DEFAULT_LAYOUT }
  } catch {
    return { ...DEFAULT_LAYOUT }
  }
}

export function writeLearningLayout(storage: Storage, layout: LearningLayout): void {
  try {
    storage.setItem(LEARNING_LAYOUT_STORAGE_KEY, JSON.stringify({ version: 1, ...layout }))
  } catch {
    // A blocked storage implementation must not prevent learning-space navigation.
  }
}
