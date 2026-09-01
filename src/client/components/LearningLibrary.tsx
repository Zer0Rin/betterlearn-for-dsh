import { useState } from 'react'
import type { LearningBook } from '../learning-book-library.js'
import type { KnowledgePointSnapshot } from '../types.js'

export interface BetterLearnGatewayProps {
  bookCount: number
  knowledgeAvailable: boolean
  onOpenKnowledge(): void
  onOpenLearning(): void
}

export function BetterLearnGateway({
  bookCount, knowledgeAvailable, onOpenKnowledge, onOpenLearning,
}: BetterLearnGatewayProps) {
  return (
    <main className="betterlearn-gateway" data-testid="betterlearn-gateway">
      <header>
        <p>BetterLearn</p>
        <h1>今天从哪里开始？</h1>
        <span>知识整理与学习训练是两个独立入口。</span>
      </header>
      <div className="betterlearn-gateway__entries">
        <button type="button" data-testid="betterlearn-knowledge-entry"
          disabled={!knowledgeAvailable} onClick={onOpenKnowledge}>
          <span>01 · Knowledge</span>
          <strong>知识点</strong>
          <p>从对话、文件或正文中提取并核对知识点。</p>
          <em>{knowledgeAvailable ? '进入知识整理 →' : '先在 DSH 创建或选择普通会话'}</em>
        </button>
        <button type="button" data-testid="betterlearn-library-entry" onClick={onOpenLearning}>
          <span>02 · Learning</span>
          <strong>学习空间</strong>
          <p>先选择由知识点整合成的学习书，再进入具体学习。</p>
          <em>{`${bookCount} 本学习书 →`}</em>
        </button>
      </div>
    </main>
  )
}

export interface LearningBookshelfProps {
  books: LearningBook[]
  newBookId?: string
  storageWarning?: string
  onOpenBook(book: LearningBook): void
  onOpenKnowledge(): void
}

export function LearningBookshelf({
  books, newBookId, storageWarning, onOpenBook, onOpenKnowledge,
}: LearningBookshelfProps) {
  return (
    <main className="betterlearn-library" data-testid="learning-bookshelf">
      <header className="betterlearn-library__heading">
        <div>
          <p>Learning Space</p>
          <h1>学习空间</h1>
          <span>知识点先被整合为学习书；打开一本书，才进入具体学习。</span>
        </div>
      </header>
      {storageWarning && <p className="betterlearn-library__warning">{storageWarning}</p>}
      {books.length === 0 ? (
        <section className="betterlearn-library__empty">
          <span>空书架</span>
          <h2>还没有学习书</h2>
          <p>先完成一次知识提取，并把确认后的知识点整理为学习书。</p>
          <button type="button" data-testid="learning-library-empty-action"
            onClick={onOpenKnowledge}>去知识点入口</button>
        </section>
      ) : (
        <section className="betterlearn-library__shelf" aria-label="学习书">
          {books.map((book, index) => (
            <button key={book.bookId} type="button" className="betterlearn-library__book"
              data-testid={`learning-book-${book.bookId}`}
              data-new={book.bookId === newBookId ? 'true' : 'false'}
              onClick={() => onOpenBook(book)}>
              <span className="betterlearn-library__cover" aria-hidden="true">
                <i>{String(index + 1).padStart(2, '0')}</i>
                <b>BETTER<br />LEARN</b>
                <small>学习书</small>
              </span>
              <span className="betterlearn-library__book-copy">
                <small>{book.points.length} 个知识点 · {book.progress
                  ? `已完成 ${book.progress.completed}/${book.progress.total} · 掌握度 ${book.progress.mastery}%`
                  : book.bookId === newBookId ? '刚刚创建' : '尚未开始'}</small>
                <strong>{book.title}</strong>
                <span>{book.points.slice(0, 3).map(point => point.title).join(' · ')}</span>
                <em>{book.progress ? '继续学习 →' : '开始学习 →'}</em>
              </span>
            </button>
          ))}
        </section>
      )}
    </main>
  )
}

export interface LearningBookDraftResult {
  title: string
  points: KnowledgePointSnapshot[]
}

export interface LearningBookComposerProps {
  points: KnowledgePointSnapshot[]
  onCreate(result: LearningBookDraftResult): void
  onCancel(): void
}

function defaultBookTitle(points: KnowledgePointSnapshot[]): string {
  const first = points[0]
  if (!first) return '新的学习书'
  if (points.length === 1) return `${first.title} · 学习书`
  return `${first.title}等 ${points.length} 个知识点`
}

export function LearningBookComposer({ points, onCreate, onCancel }: LearningBookComposerProps) {
  const [title, setTitle] = useState(() => defaultBookTitle(points))
  const [orderedPoints, setOrderedPoints] = useState(() => [...points])

  const movePoint = (index: number, offset: -1 | 1) => {
    setOrderedPoints(current => {
      const destination = index + offset
      if (destination < 0 || destination >= current.length) return current
      const next = [...current]
      const [moving] = next.splice(index, 1)
      next.splice(destination, 0, moving)
      return next
    })
  }

  const removePoint = (knowledgePointId: string) => {
    setOrderedPoints(current => current.filter(item => item.knowledgePointId !== knowledgePointId))
  }

  const canCreate = title.trim().length > 0 && orderedPoints.length > 0

  return (
    <main className="betterlearn-composer" data-testid="learning-book-composer">
      <header className="betterlearn-composer__heading">
        <p>Compose a Learning Book</p>
        <h1>整理为学习书</h1>
        <span>命名这本书，并确定知识点的学习顺序。</span>
      </header>

      <section className="betterlearn-composer__editor">
        <label htmlFor="learning-book-title">学习书名称</label>
        <input id="learning-book-title" data-testid="learning-book-title" value={title}
          onChange={event => setTitle(event.currentTarget.value)} />
        <div className="betterlearn-composer__count">
          <span>学习顺序</span>
          <strong>{orderedPoints.length} 个知识点</strong>
        </div>

        {orderedPoints.length === 0 ? (
          <p className="betterlearn-composer__empty">至少保留一个知识点</p>
        ) : (
          <ol className="betterlearn-composer__points">
            {orderedPoints.map((point, index) => (
              <li key={point.knowledgePointId}
                data-testid={`learning-book-point-${point.knowledgePointId}`}>
                <span className="betterlearn-composer__sequence">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="betterlearn-composer__point-copy">
                  <strong>{point.title}</strong>
                  <small>{point.statement}</small>
                </span>
                <span className="betterlearn-composer__point-actions">
                  <button type="button" disabled={index === 0}
                    data-testid={`learning-book-move-up-${point.knowledgePointId}`}
                    onClick={() => movePoint(index, -1)}>上移</button>
                  <button type="button" disabled={index === orderedPoints.length - 1}
                    data-testid={`learning-book-move-down-${point.knowledgePointId}`}
                    onClick={() => movePoint(index, 1)}>下移</button>
                  <button type="button" data-testid={`learning-book-remove-${point.knowledgePointId}`}
                    onClick={() => removePoint(point.knowledgePointId)}>移除</button>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer className="betterlearn-composer__actions">
        <button type="button" data-testid="learning-book-cancel" onClick={onCancel}>取消</button>
        <button type="button" data-testid="learning-book-create" disabled={!canCreate}
          onClick={() => canCreate && onCreate({ title: title.trim(), points: orderedPoints })}>
          创建学习书
        </button>
      </footer>
    </main>
  )
}
