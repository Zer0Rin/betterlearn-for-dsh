# Learning Book Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a concrete learning-book organizer, create uniquely identified books without replacing existing books, persist them locally, and make the course “返回” action return to the bookshelf.

**Architecture:** A focused `learning-book-library.ts` module owns book creation and versioned storage. `LearningBookComposer` edits a draft without saving it, while the floating workbench owns navigation and persistence. The bookshelf consumes saved `LearningBook` records and opens their generated preview courses.

**Tech Stack:** React 18, TypeScript 5.9, Vitest, react-test-renderer, browser `localStorage`, Playwright.

## Global Constraints

- Every confirmed organizer submission creates a new `bookId`, even for identical knowledge points.
- The organizer is a normal-size page, not an inline result panel or modal.
- Ordering uses explicit up/down controls; drag and drop is out of scope.
- Books persist in versioned browser local storage; SQLite is out of scope.
- A course uses the visible label “返回” and always returns to the bookshelf.
- Empty titles and empty point lists cannot be created.

---

### Task 1: Learning-book domain and versioned storage

**Files:**
- Create: `src/client/learning-book-library.ts`
- Create: `test/client-learning-book-library.test.ts`
- Modify: `src/client/learning-preview.ts`
- Modify: `test/client-learning-preview.test.ts`

**Interfaces:**
- Consumes: `KnowledgePointSnapshot`, `LearningPreviewCourse`, `createLearningPreviewCourse(points, sourceText, options?)`.
- Produces: `LearningBook`, `LearningBookIdentity`, `createLearningBook`, `readLearningBooks`, `writeLearningBooks`, `LEARNING_BOOK_STORAGE_KEY`.

- [ ] **Step 1: Write failing tests for custom course identity, unique books, and storage behavior**

```ts
const first = createLearningBook({ title: '闭包训练', points: [point], sourceText: '正文' },
  { bookId: 'book-1', createdAt: '2026-09-01T10:00:00.000Z' })
const second = createLearningBook({ title: '闭包训练 2', points: [point], sourceText: '正文' },
  { bookId: 'book-2', createdAt: '2026-09-01T10:01:00.000Z' })
expect(first.bookId).not.toBe(second.bookId)
expect(first.course.courseId).toBe('book-1')
expect(second.course.title).toBe('闭包训练 2')
expect(writeLearningBooks(storage, [second, first])).toBe(true)
expect(readLearningBooks(storage)).toEqual([second, first])
```

Also test malformed JSON, unknown versions, exact-key validation, and a throwing `setItem` returning `false`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `corepack pnpm@11.23.0 exec vitest run test/client-learning-preview.test.ts test/client-learning-book-library.test.ts`

Expected: FAIL because the learning-book module and configurable course identity do not exist.

- [ ] **Step 3: Implement the minimal domain and storage module**

```ts
export interface LearningBook {
  bookId: string
  title: string
  createdAt: string
  sourceText: string
  points: KnowledgePointSnapshot[]
  course: LearningPreviewCourse
}

export function createLearningBook(input: {
  title: string
  points: KnowledgePointSnapshot[]
  sourceText: string
}, identity: { bookId: string; createdAt: string }): LearningBook

export function readLearningBooks(storage: Storage): LearningBook[]
export function writeLearningBooks(storage: Storage, books: LearningBook[]): boolean
```

Store only version, identity, source text, and validated point snapshots. Rebuild `course` on read with `{ courseId: bookId, title }` so serialized derived content cannot diverge.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `corepack pnpm@11.23.0 exec vitest run test/client-learning-preview.test.ts test/client-learning-book-library.test.ts`

Expected: all focused tests pass.

- [ ] **Step 5: Commit the domain slice**

```bash
git add src/client/learning-book-library.ts src/client/learning-preview.ts test/client-learning-book-library.test.ts test/client-learning-preview.test.ts
git commit -m "feat: persist distinct learning books"
```

### Task 2: Learning-book organizer component

**Files:**
- Modify: `src/client/components/LearningLibrary.tsx`
- Modify: `test/client-learning-library.test.tsx`

**Interfaces:**
- Consumes: ordered `KnowledgePointSnapshot[]` and `LearningBook[]` from Task 1.
- Produces: `LearningBookComposer`, `LearningBookDraftResult`, and a bookshelf that accepts `newBookId?: string` plus `storageWarning?: string`.

- [ ] **Step 1: Write failing component tests for editing and organization**

```tsx
const onCreate = vi.fn()
const renderer = create(<LearningBookComposer points={[first, second]}
  onCreate={onCreate} onCancel={vi.fn()} />)
act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-title' }).props
  .onChange({ currentTarget: { value: '我的学习书' } }))
act(() => renderer.root.findByProps({ 'data-testid': `learning-book-move-up-${second.knowledgePointId}` })
  .props.onClick())
act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-create' }).props.onClick())
expect(onCreate).toHaveBeenCalledWith({ title: '我的学习书', points: [second, first] })
```

Add separate assertions for move-down, remove, cancel, blank title, and removing every point. Update bookshelf tests to pass `LearningBook[]`, assert `data-new="true"` only on `newBookId`, and render the persistence warning without hiding the book.

- [ ] **Step 2: Run the component tests and verify RED**

Run: `corepack pnpm@11.23.0 exec vitest run test/client-learning-library.test.tsx`

Expected: FAIL because `LearningBookComposer` does not exist.

- [ ] **Step 3: Implement `LearningBookComposer` with local draft state**

```ts
export interface LearningBookDraftResult {
  title: string
  points: KnowledgePointSnapshot[]
}
```

Prefill the title from the current course-title convention. Render numbered rows with disabled first-row “上移” and last-row “下移”. Trim the title on submit and disable submission when the trimmed title or point list is empty.

Update `LearningBookshelfProps` to:

```ts
export interface LearningBookshelfProps {
  books: LearningBook[]
  newBookId?: string
  storageWarning?: string
  onOpenBook(book: LearningBook): void
  onOpenKnowledge(): void
}
```

- [ ] **Step 4: Run the component tests and verify GREEN**

Run: `corepack pnpm@11.23.0 exec vitest run test/client-learning-library.test.tsx`

Expected: all organizer and bookshelf tests pass.

- [ ] **Step 5: Commit the organizer component**

```bash
git add src/client/components/LearningLibrary.tsx test/client-learning-library.test.tsx
git commit -m "feat: organize learning book drafts"
```

### Task 3: Floating navigation, unique creation, and return semantics

**Files:**
- Modify: `src/client/components/ResultSummary.tsx`
- Modify: `src/client/NobeiClientView.tsx`
- Modify: `src/client/components/LearningSpace.tsx`
- Modify: `src/client/floating-workbench.tsx`
- Modify: `test/client-result-summary.test.tsx`
- Modify: `test/client-learning-space.test.tsx`
- Modify: `test/client-floating-workbench.test.tsx`

**Interfaces:**
- Consumes: `LearningBookComposer`, `LearningBook`, storage functions from Task 1.
- Produces: `WorkbenchArea = 'home' | 'knowledge' | 'compose' | 'library'` and the complete navigation flow.

- [ ] **Step 1: Write failing integration tests for the new flow**

Assert this sequence:

```text
result → 整理为学习书 → compose
compose → 创建学习书 → library (new book, no lesson)
library → click new book → learning
learning → 返回 → library
```

Create two books from the same point set and assert two different book test IDs remain visible. Remount with the same `sizeStorage` and assert both books are restored. Add a write-failure storage fake and assert the new book stays visible with a persistence warning.

- [ ] **Step 2: Run integration tests and verify RED**

Run: `corepack pnpm@11.23.0 exec vitest run test/client-result-summary.test.tsx test/client-learning-space.test.tsx test/client-floating-workbench.test.tsx`

Expected: FAIL because `compose`, persistence, new-book IDs, and the “返回” copy are missing.

- [ ] **Step 3: Implement the state transition and local persistence**

Rename the callback to `onOrganizeLearningBook`. Store a draft containing selected points and source text. On confirmation, create an identity such as:

```ts
const identity = {
  bookId: `book-${Date.now().toString(36)}-${bookSequence.current++}`,
  createdAt: new Date().toISOString(),
}
```

Prepend the book without filtering by knowledge-point identity, persist the new array, set `newBookId`, and navigate to `library`. On cancellation navigate to `knowledge`. Initialize books with `readLearningBooks(persistentSizeStorage)`.

- [ ] **Step 4: Replace the course action copy**

```tsx
<button type="button" aria-label="返回学习书架" onClick={onExit}>返回</button>
```

Keep `exitLearning()` fixed to `setArea('library')`.

- [ ] **Step 5: Run integration tests and verify GREEN**

Run: `corepack pnpm@11.23.0 exec vitest run test/client-result-summary.test.tsx test/client-learning-space.test.tsx test/client-floating-workbench.test.tsx`

Expected: all focused integration tests pass.

- [ ] **Step 6: Commit the navigation slice**

```bash
git add src/client/components/ResultSummary.tsx src/client/NobeiClientView.tsx src/client/components/LearningSpace.tsx src/client/floating-workbench.tsx test/client-result-summary.test.tsx test/client-learning-space.test.tsx test/client-floating-workbench.test.tsx
git commit -m "feat: create books through organizer"
```

### Task 4: Organizer and new-book visual states

**Files:**
- Modify: `src/client/styles.ts`
- Modify: `test/client-styles.test.ts`

**Interfaces:**
- Consumes: composer and bookshelf class names from Tasks 2–3.
- Produces: normal-size organizer layout, disabled/reorder states, highlighted new book, and warning presentation.

- [ ] **Step 1: Add failing scoped-style assertions**

Require selectors for `.betterlearn-composer`, `.betterlearn-composer__point`, `.betterlearn-library__book[data-new="true"]`, and `.betterlearn-library__warning` while retaining the scoped-selector and no-external-assets rules.

- [ ] **Step 2: Run style tests and verify RED**

Run: `corepack pnpm@11.23.0 exec vitest run test/client-styles.test.ts`

Expected: FAIL because the new selectors are absent.

- [ ] **Step 3: Implement scoped responsive styles**

Use the existing paper, action-blue, evidence-amber, and accepted-green tokens. Keep the composer vertically scrollable at 460px width, maintain 44px minimum action targets, and use a subtle accepted-green border for the newly created book. Add reduced-motion handling to new transitions.

- [ ] **Step 4: Run style and component tests and verify GREEN**

Run: `corepack pnpm@11.23.0 exec vitest run test/client-styles.test.ts test/client-learning-library.test.tsx`

Expected: all tests pass.

- [ ] **Step 5: Commit the visual slice**

```bash
git add src/client/styles.ts test/client-styles.test.ts
git commit -m "feat: style learning book organizer"
```

### Task 5: Runnable preview and browser acceptance

**Files:**
- Modify: `preview/learning-space.tsx`
- Modify: `scripts/verify-learning-preview.mjs`
- Modify: `test/learning-preview-build.test.ts`

**Interfaces:**
- Consumes: the production organizer, library storage model, bookshelf, and learning space.
- Produces: an interactive preview demonstrating creation of a second book and correct return behavior.

- [ ] **Step 1: Write the failing preview source assertion**

Require the preview to import `LearningBookComposer`, render `area === 'compose'`, and use `onOrganizeLearningBook`.

- [ ] **Step 2: Run preview tests and verify RED**

Run: `corepack pnpm@11.23.0 exec vitest run test/learning-preview-build.test.ts`

Expected: FAIL because the preview still creates or replaces a course directly.

- [ ] **Step 3: Update the preview to exercise the production flow**

Start with one saved fixture book. From the knowledge entry, open the organizer, rename the draft, move a point, create a second book, and return to a two-book shelf. Opening the new book enters expanded learning; “返回” returns to the two-book shelf.

- [ ] **Step 4: Update Playwright acceptance**

Assert `home → knowledge → compose → library (2 books) → learning → library`, plus remediation, sidebars, desktop size restoration, and narrow layout. Assert there are no console or page errors.

- [ ] **Step 5: Run full verification**

Run:

```bash
corepack pnpm@11.23.0 build
corepack pnpm@11.23.0 preview:learning:build
corepack pnpm@11.23.0 exec vitest run --exclude '.worktrees/**' --testTimeout 15000
node scripts/verify-learning-preview.mjs http://127.0.0.1:4173/
```

Expected: TypeScript/build succeeds, all main-workspace tests pass, and browser verification prints the completed organizer flow.

- [ ] **Step 6: Commit the preview and acceptance update**

```bash
git add preview/learning-space.tsx scripts/verify-learning-preview.mjs test/learning-preview-build.test.ts
git commit -m "test: verify learning book creation flow"
```
