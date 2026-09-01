import type { LearningPreviewCourse } from '../learning-preview.js'

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
  books: LearningPreviewCourse[]
  onOpenBook(book: LearningPreviewCourse): void
  onOpenKnowledge(): void
}

export function LearningBookshelf({ books, onOpenBook, onOpenKnowledge }: LearningBookshelfProps) {
  return (
    <main className="betterlearn-library" data-testid="learning-bookshelf">
      <header className="betterlearn-library__heading">
        <div>
          <p>Learning Space</p>
          <h1>学习空间</h1>
          <span>知识点先被整合为学习书；打开一本书，才进入具体学习。</span>
        </div>
      </header>
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
            <button key={book.courseId} type="button" className="betterlearn-library__book"
              data-testid={`learning-book-${book.courseId}`} onClick={() => onOpenBook(book)}>
              <span className="betterlearn-library__cover" aria-hidden="true">
                <i>{String(index + 1).padStart(2, '0')}</i>
                <b>BETTER<br />LEARN</b>
                <small>学习书</small>
              </span>
              <span className="betterlearn-library__book-copy">
                <small>{book.units.length} 个知识点 · 尚未开始</small>
                <strong>{book.title}</strong>
                <span>{book.units.slice(0, 3).map(unit => unit.title).join(' · ')}</span>
                <em>打开学习书 →</em>
              </span>
            </button>
          ))}
        </section>
      )}
    </main>
  )
}
