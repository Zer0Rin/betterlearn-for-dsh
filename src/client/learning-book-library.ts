import type {
  EvidenceSpan, KnowledgePointSnapshot, KnowledgePointType, LearningCourse,
} from './types.js'

export const LEARNING_BOOK_STORAGE_KEY = 'betterlearn:learning-books:v1'

export interface LearningBookIdentity {
  bookId: string
  createdAt: string
}

export interface LearningBook {
  bookId: string
  title: string
  createdAt: string
  sourceText: string
  points: KnowledgePointSnapshot[]
  courseId?: string
  progress?: LearningCourse['progress']
}

interface StoredLearningBook extends LearningBookIdentity {
  title: string
  sourceText: string
  points: KnowledgePointSnapshot[]
  courseId?: string
  progress?: LearningCourse['progress']
}

const POINT_TYPES = new Set<KnowledgePointType>([
  'concept', 'process', 'comparison', 'formula', 'fact', 'code',
])

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function evidence(value: unknown): value is EvidenceSpan {
  if (!record(value) || !exactKeys(value, [
    'seq', 'quote', 'textStart', 'textEnd', 'contextBefore', 'contextAfter',
  ])) return false
  return Number.isInteger(value.seq) && Number(value.seq) >= 0
    && typeof value.quote === 'string'
    && Number.isInteger(value.textStart) && Number(value.textStart) >= 0
    && Number.isInteger(value.textEnd) && Number(value.textEnd) >= Number(value.textStart)
    && typeof value.contextBefore === 'string' && typeof value.contextAfter === 'string'
}

function point(value: unknown): value is KnowledgePointSnapshot {
  if (!record(value) || !exactKeys(value, [
    'knowledgePointId', 'documentId', 'type', 'title', 'statement', 'evidence',
  ])) return false
  return typeof value.knowledgePointId === 'string' && value.knowledgePointId.length > 0
    && typeof value.documentId === 'string' && value.documentId.length > 0
    && typeof value.type === 'string' && POINT_TYPES.has(value.type as KnowledgePointType)
    && typeof value.title === 'string' && value.title.length > 0
    && typeof value.statement === 'string' && value.statement.length > 0
    && Array.isArray(value.evidence) && value.evidence.every(evidence)
}

function progress(value: unknown): value is LearningCourse['progress'] {
  return record(value) && exactKeys(value, ['completed', 'total', 'mastery'])
    && Number.isInteger(value.completed) && Number(value.completed) >= 0
    && Number.isInteger(value.total) && Number(value.total) >= 0
    && Number(value.completed) <= Number(value.total)
    && Number.isInteger(value.mastery) && Number(value.mastery) >= 0 && Number(value.mastery) <= 100
}

function storedBookV1(value: unknown): value is StoredLearningBook {
  if (!record(value) || !exactKeys(value, ['bookId', 'title', 'createdAt', 'sourceText', 'points'])) return false
  return baseStoredBook(value)
}

function storedBookV2(value: unknown): value is StoredLearningBook {
  if (!record(value) || !exactKeys(value, [
    'bookId', 'title', 'createdAt', 'sourceText', 'points', 'courseId', 'progress',
  ])) return false
  return baseStoredBook(value)
    && (value.courseId === null || typeof value.courseId === 'string')
    && (value.progress === null || progress(value.progress))
}

function baseStoredBook(value: Record<string, unknown>): boolean {
  return typeof value.bookId === 'string' && value.bookId.length > 0
    && typeof value.title === 'string' && value.title.length > 0
    && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.sourceText === 'string'
    && Array.isArray(value.points) && value.points.length > 0 && value.points.every(point)
}

function clonePoints(points: KnowledgePointSnapshot[]): KnowledgePointSnapshot[] {
  return points.map(item => ({
    ...item,
    evidence: item.evidence.map(itemEvidence => ({ ...itemEvidence })),
  }))
}

export function createLearningBook(input: {
  title: string
  points: KnowledgePointSnapshot[]
  sourceText: string
}, identity: LearningBookIdentity): LearningBook {
  const points = clonePoints(input.points)
  return {
    ...identity,
    title: input.title,
    sourceText: input.sourceText,
    points,
  }
}

export function updateLearningBookCourse(book: LearningBook, course: LearningCourse): LearningBook {
  if (course.clientBookId !== book.bookId) return book
  return {
    ...book,
    courseId: course.courseId,
    progress: { ...course.progress },
  }
}

export function readLearningBooks(storage: Storage): LearningBook[] {
  try {
    const raw = storage.getItem(LEARNING_BOOK_STORAGE_KEY)
    if (raw === null) return []
    const payload: unknown = JSON.parse(raw)
    if (!record(payload) || !exactKeys(payload, ['version', 'books'])
      || !Array.isArray(payload.books)) return []
    const legacy = payload.version === 1 && payload.books.every(storedBookV1)
    const current = payload.version === 2 && payload.books.every(storedBookV2)
    if (!legacy && !current) return []
    return (payload.books as StoredLearningBook[]).map(book => ({ ...createLearningBook({
      title: book.title,
      points: book.points,
      sourceText: book.sourceText,
    }, { bookId: book.bookId, createdAt: book.createdAt }),
    ...(typeof book.courseId === 'string' ? { courseId: book.courseId } : {}),
    ...(book.progress === undefined || book.progress === null ? {} : { progress: { ...book.progress } }),
    }))
  } catch {
    return []
  }
}

export function writeLearningBooks(storage: Storage, books: LearningBook[]): boolean {
  try {
    storage.setItem(LEARNING_BOOK_STORAGE_KEY, JSON.stringify({
      version: 2,
      books: books.map(({ bookId, title, createdAt, sourceText, points, courseId, progress }) => ({
        bookId, title, createdAt, sourceText, points,
        courseId: courseId ?? null,
        progress: progress ?? null,
      })),
    }))
    return true
  } catch {
    return false
  }
}
