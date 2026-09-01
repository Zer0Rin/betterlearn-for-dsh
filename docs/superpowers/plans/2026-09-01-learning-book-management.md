# Learning Book Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a management mode to Learning Space so users can edit learning books safely and delete a book together with its persisted course and learning records.

**Architecture:** Pure helpers in `learning-book-library.ts` own immutable book revision. `LearningBookshelf` owns transient manage/confirm/error UI, while `BetterLearnFloatingApp` owns saved book state and asynchronous Core deletion. A new idempotent `learning_courses.delete` RPC flows from the browser API through the TypeScript host into the Python Core, where existing cascade foreign keys remove the full learning graph.

**Tech Stack:** React 18, TypeScript 5.9, Vitest/react-test-renderer, Node HTTP routes and JSONL RPC, Python 3.12, SQLite, pytest.

## Global Constraints

- Default bookshelf behavior remains opening a learning book; editing and deletion are exposed only after entering “管理”.
- Editing an unstarted book updates it in place and preserves its bookshelf position.
- Editing a started book creates a new book ID with no `courseId` or `progress`; the original book and progress remain unchanged.
- Confirmed deletion removes the learning book, course, attempts, and mastery state; cancellation changes nothing.
- A Core deletion failure keeps the local book visible and reports an actionable retry message.
- The delete operation is idempotent.
- Do not delete the user's existing learning book during real-browser acceptance.

---

### Task 1: Immutable learning-book revision rules

**Files:**
- Modify: `src/client/learning-book-library.ts`
- Test: `test/client-learning-book-library.test.ts`

**Interfaces:**
- Consumes: `LearningBook`, `LearningBookDraftResult`-shaped `{ title, points }`, and a caller-provided `LearningBookIdentity` for new versions.
- Produces: `hasLearningStarted(book: LearningBook): boolean`, `reviseLearningBook(book: LearningBook, input: { title: string; points: KnowledgePointSnapshot[] }, newIdentity: LearningBookIdentity): { book: LearningBook; replacesBookId?: string }`.

- [ ] **Step 1: Write failing tests for in-place and new-version revision**

```ts
test('revises an unstarted book in place without mutating its snapshots', () => {
  const original = createLearningBook({ title: '旧标题', points: [point], sourceText: '正文' },
    { bookId: 'book-1', createdAt: '2026-09-01T10:00:00.000Z' })
  const result = reviseLearningBook(original, { title: '新标题', points: [second, point] },
    { bookId: 'unused', createdAt: '2026-09-01T11:00:00.000Z' })
  expect(result.replacesBookId).toBe('book-1')
  expect(result.book).toMatchObject({ bookId: 'book-1', title: '新标题', createdAt: original.createdAt })
  expect(result.book.points).toEqual([second, point])
  expect(original).toMatchObject({ title: '旧标题', points: [point] })
})

test('revises a started book as a fresh version without inherited progress', () => {
  const started = { ...createLearningBook({ title: '原书', points: [point], sourceText: '正文' },
    { bookId: 'book-old', createdAt: '2026-09-01T10:00:00.000Z' }),
    courseId: 'course_0123456789abcdefabcd', progress: { completed: 1, total: 1, mastery: 70 } }
  const result = reviseLearningBook(started, { title: '原书 · 新版', points: [point] },
    { bookId: 'book-new', createdAt: '2026-09-01T11:00:00.000Z' })
  expect(result.replacesBookId).toBeUndefined()
  expect(result.book).toMatchObject({ bookId: 'book-new', title: '原书 · 新版' })
  expect(result.book).not.toHaveProperty('courseId')
  expect(result.book).not.toHaveProperty('progress')
  expect(started.courseId).toBe('course_0123456789abcdefabcd')
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run test/client-learning-book-library.test.ts`

Expected: FAIL because `reviseLearningBook` is not exported.

- [ ] **Step 3: Implement immutable revision**

```ts
export function hasLearningStarted(book: LearningBook): boolean {
  return book.courseId !== undefined || book.progress !== undefined
}

export function reviseLearningBook(
  book: LearningBook,
  input: { title: string; points: KnowledgePointSnapshot[] },
  newIdentity: LearningBookIdentity,
): { book: LearningBook; replacesBookId?: string } {
  if (hasLearningStarted(book)) {
    return { book: createLearningBook({ ...input, sourceText: book.sourceText }, newIdentity) }
  }
  return {
    book: createLearningBook({ ...input, sourceText: book.sourceText }, {
      bookId: book.bookId, createdAt: book.createdAt,
    }),
    replacesBookId: book.bookId,
  }
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm exec vitest run test/client-learning-book-library.test.ts`

Expected: all learning-book library tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/learning-book-library.ts test/client-learning-book-library.test.ts
git commit -m "feat: define safe learning book revisions"
```

---

### Task 2: Idempotent Core course deletion

**Files:**
- Modify: `python/nobei_core/learning.py`
- Modify: `python/nobei_core/service.py`
- Modify: `python/nobei_core/constants.py`
- Test: `python/tests/test_learning.py`
- Test: `python/tests/test_rpc.py`
- Test: `python/tests/test_domain_contract.py`

**Interfaces:**
- Consumes: exact RPC params `{ "courseId": "course_<20 lowercase hex>" }`.
- Produces: Python service method `delete_learning_course(params: object) -> dict[str, object]` and public RPC method `learning_courses.delete`, returning `{ "courseId": course_id, "deleted": True }`.

- [ ] **Step 1: Write a failing cascade-and-idempotency test**

```py
def test_course_delete_cascades_learning_graph_and_is_idempotent(database):
    core = _core(database)
    point_ids = _seed_points(database)
    course = _sync(core, point_ids)
    main = _find_assessment(course, 0, "main")
    option = main["options"][0]
    core.submit_learning_attempt({
        "assessmentId": main["assessmentId"],
        "optionId": option["optionId"],
        "idempotencyKey": "idem_" + "d" * 20,
    })

    expected = {"courseId": course["courseId"], "deleted": True}
    assert core.delete_learning_course({"courseId": course["courseId"]}) == expected
    assert core.delete_learning_course({"courseId": course["courseId"]}) == expected
    for table in (
        "learning_courses", "learning_units", "learning_assessments",
        "learning_attempts", "learning_mastery_states",
    ):
        assert database.scalar(f"SELECT COUNT(*) FROM {table}") == 0
```

Add an invalid-params case asserting `INVALID_PARAMS` for an extra field, and extend the mapped RPC test with `learning_courses.delete`.

- [ ] **Step 2: Run Python tests and verify RED**

Run: `pnpm test:phase1b-python -- python/tests/test_learning.py python/tests/test_rpc.py python/tests/test_domain_contract.py`

Expected: FAIL because the service method and RPC mapping do not exist.

- [ ] **Step 3: Implement the Core deletion transaction and RPC mapping**

In `learning.py`:

```py
def delete_course(connection, course_id: object) -> dict[str, object]:
    validated = require_opaque_id(course_id, "course")
    connection.execute("DELETE FROM learning_courses WHERE id=?", (validated,))
    return {"courseId": validated, "deleted": True}
```

In `service.py`, import `delete_course` and add:

```py
def delete_learning_course(self, params: object) -> dict[str, object]:
    command = _require_params(params, frozenset({"courseId"}))
    with _transactional_write(self._database, "learning course delete failed") as con:
        return delete_course(con, command["courseId"])
```

Add `"learning_courses.delete": "delete_learning_course"` to `RPC_METHODS`. Extend the RPC fixture core with the exact method and return shape, and update domain-contract method assertions.

- [ ] **Step 4: Run Python tests and verify GREEN**

Run: `pnpm test:phase1b-python -- python/tests/test_learning.py python/tests/test_rpc.py python/tests/test_domain_contract.py`

Expected: all selected Python tests PASS.

- [ ] **Step 5: Commit**

```bash
git add python/nobei_core/learning.py python/nobei_core/service.py python/nobei_core/constants.py python/tests/test_learning.py python/tests/test_rpc.py python/tests/test_domain_contract.py
git commit -m "feat: delete persisted learning courses"
```

---

### Task 3: TypeScript deletion transport

**Files:**
- Modify: `src/product/types.ts`
- Modify: `src/product/core-rpc-client.ts`
- Modify: `src/product/plugin.ts`
- Modify: `src/product/routes.ts`
- Modify: `src/client/types.ts`
- Modify: `src/client/client-api.ts`
- Test: `test/product-core-rpc-client.test.ts`
- Test: `test/product-plugin.test.ts`
- Test: `test/product-routes.test.ts`
- Test: `test/client-api.test.ts`

**Interfaces:**
- Consumes: `courseId: string` at the browser API and host operation boundary; `{ courseId: string }` at JSONL RPC.
- Produces: `LearningCourseDeleteResult { courseId: string; deleted: true }`, `FixedCoreRpcClient.deleteLearningCourse`, `ProductOperations.deleteLearningCourse`, and `ClientApi.deleteLearningCourse`.

- [ ] **Step 1: Write failing transport tests**

Add assertions equivalent to:

```ts
await api.deleteLearningCourse(courseId, controller.signal)
expect(fetchMock).toHaveBeenLastCalledWith(`/nobei/v1/learning-courses/${courseId}`, {
  method: 'DELETE', headers: {}, signal: controller.signal,
})
```

```ts
const deleted = await send(port, {
  method: 'DELETE', path: `/nobei/v1/learning-courses/${courseId}`,
})
expect(deleted.status).toBe(200)
expect(ops.deleteLearningCourse).toHaveBeenCalledWith(courseId)
```

Also assert that DELETE with a body returns `400`, malformed course IDs return `400`, plugin forwarding calls the Core client, and the JSONL frame uses method `learning_courses.delete` with `{ courseId }`.

- [ ] **Step 2: Run focused TypeScript tests and verify RED**

Run: `pnpm exec vitest run test/product-core-rpc-client.test.ts test/product-plugin.test.ts test/product-routes.test.ts test/client-api.test.ts`

Expected: type/build failures or assertion failures because deletion interfaces do not exist.

- [ ] **Step 3: Add exact types and transport methods**

```ts
export interface LearningCourseDeleteResult extends Record<string, unknown> {
  courseId: string
  deleted: true
}
```

```ts
deleteLearningCourse(params: LearningCourseParams, signal?: AbortSignal): Promise<LearningCourseDeleteResult> {
  return this.#request(
    'learning_courses.delete', params, CORE_WRITE_RPC_TIMEOUT_MS, signal,
  ) as Promise<LearningCourseDeleteResult>
}
```

Add `deleteLearningCourse(courseId, signal)` to `ProductOperations` and `ClientApi`. In the browser API call `del('/nobei/v1/learning-courses/' + encodeURIComponent(courseId), signal)`. In `matchRoute`, map the learning-course resource to GET or DELETE according to `requestMethod`; validate the `course` resource ID for both methods, reject bodies on DELETE, and dispatch to `operations.deleteLearningCourse(courseId)`. In the plugin, forward to `client.deleteLearningCourse({ courseId }, signal)`.

- [ ] **Step 4: Run focused TypeScript tests and verify GREEN**

Run: `pnpm exec vitest run test/product-core-rpc-client.test.ts test/product-plugin.test.ts test/product-routes.test.ts test/client-api.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/product/types.ts src/product/core-rpc-client.ts src/product/plugin.ts src/product/routes.ts src/client/types.ts src/client/client-api.ts test/product-core-rpc-client.test.ts test/product-plugin.test.ts test/product-routes.test.ts test/client-api.test.ts
git commit -m "feat: expose learning course deletion"
```

---

### Task 4: Bookshelf management and edit-mode composer

**Files:**
- Modify: `src/client/components/LearningLibrary.tsx`
- Modify: `src/client/styles.ts`
- Test: `test/client-learning-library.test.tsx`
- Test: `test/client-styles.test.ts`

**Interfaces:**
- Consumes: `LearningBook[]`, `onOpenBook(book)`, `onEditBook(book)`, and async `onDeleteBook(book): Promise<void>`.
- Produces: a bookshelf-level `管理 / 完成` toggle, per-card edit/delete controls, inline confirmation, deletion pending/error states, and composer props `initialTitle?: string`, `submitLabel?: string`, `heading?: string`.

- [ ] **Step 1: Write failing component tests**

```tsx
test('keeps management actions hidden until management mode is enabled', () => {
  const onOpenBook = vi.fn()
  const onEditBook = vi.fn()
  const renderer = create(<LearningBookshelf books={[book]} onOpenBook={onOpenBook}
    onEditBook={onEditBook} onDeleteBook={vi.fn()} onOpenKnowledge={vi.fn()} />)
  expect(renderer.root.findAllByProps({ 'data-testid': 'learning-book-edit-book-1' })).toHaveLength(0)
  act(() => renderer.root.findByProps({ 'data-testid': 'learning-library-manage' }).props.onClick())
  act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-edit-book-1' }).props.onClick())
  expect(onEditBook).toHaveBeenCalledWith(book)
  expect(onOpenBook).not.toHaveBeenCalled()
})
```

```tsx
test('requires inline confirmation and keeps a book on deletion failure', async () => {
  const onDeleteBook = vi.fn(async () => { throw new Error('offline') })
  const renderer = create(<LearningBookshelf books={[book]} onOpenBook={vi.fn()}
    onEditBook={vi.fn()} onDeleteBook={onDeleteBook} onOpenKnowledge={vi.fn()} />)
  act(() => renderer.root.findByProps({ 'data-testid': 'learning-library-manage' }).props.onClick())
  act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-delete-book-1' }).props.onClick())
  expect(onDeleteBook).not.toHaveBeenCalled()
  await act(async () => renderer.root.findByProps({
    'data-testid': 'learning-book-delete-confirm-book-1',
  }).props.onClick())
  expect(onDeleteBook).toHaveBeenCalledWith(book)
  expect(JSON.stringify(renderer.toJSON())).toContain('删除失败，请重试')
})
```

Add a cancel case and a composer case asserting the existing title, edit heading, and exact submit label.

- [ ] **Step 2: Run component tests and verify RED**

Run: `pnpm exec vitest run test/client-learning-library.test.tsx test/client-styles.test.ts`

Expected: FAIL because management callbacks, controls, and edit props are absent.

- [ ] **Step 3: Implement management UI and edit-mode copy**

Use state with these exact shapes:

```ts
const [managing, setManaging] = useState(false)
const [deleteBookId, setDeleteBookId] = useState<string>()
const [deletingBookId, setDeletingBookId] = useState<string>()
const [deleteError, setDeleteError] = useState<string>()
```

Render `管理` beside the Learning Space heading when books exist and `完成` while managing. Structure each card as an `article` containing a dedicated open button plus an action row, avoiding nested interactive controls. While managing, disable the open button and expose `修改` and `删除`. The first delete click opens an inline block containing `删除这本学习书及全部学习记录？`, `取消`, and `确认删除`. Await `onDeleteBook`; close confirmation on success; on failure set `删除失败，请重试。学习书和进度仍然保留。`.

Initialize the composer with:

```ts
const [title, setTitle] = useState(() => initialTitle ?? defaultBookTitle(points))
```

Use `heading ?? '整理为学习书'` and `submitLabel ?? '创建学习书'` for its visible heading and primary action.

Add scoped CSS for `.betterlearn-library__heading-actions`, `__book-open`, `__book-actions`, `__delete-confirm`, and disabled/pending states. Keep existing no-external-assets and reduced-motion constraints.

- [ ] **Step 4: Run component tests and verify GREEN**

Run: `pnpm exec vitest run test/client-learning-library.test.tsx test/client-styles.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/components/LearningLibrary.tsx src/client/styles.ts test/client-learning-library.test.tsx test/client-styles.test.ts
git commit -m "feat: add learning book management controls"
```

---

### Task 5: Workbench management orchestration

**Files:**
- Modify: `src/client/floating-workbench.tsx`
- Test: `test/client-floating-workbench.test.tsx`
- Modify: `preview/learning-space.tsx`
- Test: `test/learning-preview-build.test.ts`

**Interfaces:**
- Consumes: Task 1 `reviseLearningBook`, Task 3 `ClientApi.deleteLearningCourse`, and Task 4 bookshelf/composer callbacks.
- Produces: editing draft state, in-place or new-version save, Core-first deletion, and preview-safe no-op management callbacks.

- [ ] **Step 1: Write failing workbench tests for both edit branches and deletion**

Seed `LEARNING_BOOK_STORAGE_KEY` with one unstarted and one started book. Add tests that:

```ts
act(() => renderer.root.findByProps({ 'data-testid': 'learning-library-manage' }).props.onClick())
act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-edit-book-draft' }).props.onClick())
expect(renderer.root.findByProps({ 'data-testid': 'learning-book-title' }).props.value).toBe('未开始')
act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-title' }).props
  .onChange({ currentTarget: { value: '未开始 · 已修改' } }))
act(() => renderer.root.findByProps({ 'data-testid': 'learning-book-create' }).props.onClick())
expect(readLearningBooks(sizeStorage).filter(book => book.bookId === 'book-draft')).toHaveLength(1)
```

For the started book, assert that saving yields two books, the original retains its `courseId` and progress, and the new book has neither. For deletion, confirm and assert `deleteLearningCourse(courseId)` is awaited before the book disappears. Reject the API promise and assert the local-storage payload and visible card are unchanged.

- [ ] **Step 2: Run workbench and preview tests and verify RED**

Run: `pnpm exec vitest run test/client-floating-workbench.test.tsx test/learning-preview-build.test.ts`

Expected: FAIL because edit/delete orchestration is absent.

- [ ] **Step 3: Implement draft and deletion orchestration**

Extend the draft shape:

```ts
interface LearningBookDraft {
  points: KnowledgePointSnapshot[]
  sourceText: string
  editingBook?: LearningBook
}
```

Add a single collision-safe `newBookIdentity()` helper around the existing sequence logic. `editLearningBook(book)` opens `compose` with the book's snapshots. In `finishLearningBook`, call `reviseLearningBook` when `editingBook` exists; replace at the same array index when `replacesBookId` is returned, otherwise prepend the fresh version. Set `newBookId` only for newly created books or new versions.

Add:

```ts
async function deleteLearningBook(book: LearningBook): Promise<void> {
  if (book.courseId !== undefined) await clientApi.deleteLearningCourse(book.courseId)
  setLearningBooks(current => {
    const next = current.filter(candidate => candidate.bookId !== book.bookId)
    setStorageWarning(writeLearningBooks(persistentSizeStorage, next)
      ? undefined
      : '学习书已在本次使用中删除，但无法保存；刷新后可能重新出现。')
    return next
  })
  setNewBookId(current => current === book.bookId ? undefined : current)
}
```

Pass `onEditBook` and `onDeleteBook` to the bookshelf. Pass edit-specific title, heading `修改学习书`, and submit label based on `hasLearningStarted`: `保存为新版本` for started books and `保存修改` otherwise. Editing cancellation returns to `library`; new-book cancellation continues returning to `knowledge`. Update the preview to supply safe callbacks so it still builds.

- [ ] **Step 4: Run workbench and preview tests and verify GREEN**

Run: `pnpm exec vitest run test/client-floating-workbench.test.tsx test/learning-preview-build.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/floating-workbench.tsx test/client-floating-workbench.test.tsx preview/learning-space.tsx test/learning-preview-build.test.ts
git commit -m "feat: manage learning books from the workbench"
```

---

### Task 6: Full verification and actual local upgrade

**Files:**
- Verify: all changed production and test files
- Generated package: `dist/nobei-dsh-phase1-0.0.5.tgz`

**Interfaces:**
- Consumes: the complete feature from Tasks 1–5.
- Produces: a built and tested tarball installed into `/Users/guyue/.betterlearn`, with the actual app running at `http://127.0.0.1:3000/`.

- [ ] **Step 1: Run full TypeScript and Python verification**

Run: `pnpm test:phase1b`

Expected: build succeeds, all Vitest tests pass, and all Python tests pass.

- [ ] **Step 2: Build the delivery tarball**

Run: `pnpm pack:acceptance`

Expected: `dist/nobei-dsh-phase1-0.0.5.tgz` is created after a successful clean build.

- [ ] **Step 3: Stop the current BetterLearn process cleanly**

Send Ctrl-C to the existing foreground `betterlearn start` session and verify its DSH and Core child processes exit.

Expected: port 3000 is no longer listening and no `nobei_core.main --data-root /Users/guyue/.betterlearn/data` process remains.

- [ ] **Step 4: Upgrade and restart the actual profile**

Run:

```bash
node bin/betterlearn.mjs upgrade --home /Users/guyue/.betterlearn --package /Users/guyue/Documents/code/betterlearn-for-dsh/dist/nobei-dsh-phase1-0.0.5.tgz
node bin/betterlearn.mjs start --home /Users/guyue/.betterlearn --port 3000
```

Expected: upgrade reports a successful backup/install, then the app serves `http://127.0.0.1:3000/` with Core READY.

- [ ] **Step 5: Inspect the real UI without destructive confirmation**

Open the existing app tab, reload, enter `BetterLearn → 学习空间`, and verify:

- “管理” is visible when books exist.
- Toggling it to “完成” reveals “修改”和“删除”.
- Editing the existing started book opens the composer with its current title and displays “保存为新版本”; cancel returns to the shelf.
- Clicking “删除” displays the full-data confirmation; clicking “取消” keeps the book and progress.
- Do not click “确认删除” on the user's existing book.

- [ ] **Step 6: Commit final integration adjustments if verification required any**

```bash
git add src test python preview
git commit -m "fix: finish learning book management verification"
```

Only run this commit when Step 5 required tracked code changes; otherwise leave the verified Task 5 commit as the implementation head.
