# DSH Conversation Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select one or more ordinary DSH conversations, verify a user/assistant-text-only merged preview, and create one existing BetterLearn extraction run.

**Architecture:** The browser derives selectable ordinary-session summaries from DSH's public client session list. New Host routes read the selected persisted logs through `ctx.sessionQuery`, normalize only append-origin human/model text, fingerprint the exact preview, and reuse the existing Core preview and generation coordinator. A private media type stored in the existing `documents.media_type` column identifies conversation runs without a database migration.

**Tech Stack:** TypeScript 5.9, React 18, Vitest 3, DSH `0.1.0-rc.7 || 0.1.0-rc.8`, Python 3.12, pytest, SQLite.

## Global Constraints

- Only ordinary DSH sessions are selectable; never open or switch the selected sessions.
- Include only append-origin `source.kind === 'user'` user text and `source.kind === 'model'` assistant text blocks.
- Exclude system prompts, reasoning, tools, plugin context, images, metadata, replacements, and all subagent sessions structurally.
- Merge 1–50 unique conversations into one task, ordered by `createdAt` ascending and stable request order.
- Preserve the existing 512 KiB UTF-8 task limit; never truncate or silently omit a selected conversation.
- A full merged preview is mandatory; import must re-read and match the preview SHA-256 digest.
- Selection and preview must make zero model calls; only confirmed import may start generation.
- Existing file, paste, PDF, review, result, history, edit, and deletion behaviors must not regress.

---

## File Structure

- Create `src/product/dsh-conversation-source.ts`: DSH log reading, structural filtering, Markdown normalization, metadata, filename, digest, and typed source failures.
- Create `test/dsh-conversation-source.test.ts`: direct behavior tests for the source adapter.
- Modify `src/product/types.ts`: internal conversation media type and preview/import contracts.
- Modify `python/nobei_core/service.py` and `python/nobei_core/repository.py`: accept the internal media type and expose the persisted source type in run history.
- Modify `python/tests/test_import_and_state.py` and `python/tests/test_run_history.py`: Core media and history coverage.
- Modify `src/product/routes.ts`: two closed conversation routes, request parsers, statuses, and typed error mapping.
- Modify `src/product/plugin.ts`: required `sessionQuery` injection and operations that join source, Core preview, and generation.
- Modify `package.json`: required DSH peer/dev dependencies.
- Modify `test/product-routes.test.ts` and `test/product-plugin.test.ts`: route and composition coverage.
- Create `src/client/dsh-conversation-sessions.ts`: pure projection of selectable summaries from DSH session state.
- Create `test/client-dsh-conversation-sessions.test.ts`: ordinary/blank/subagent filtering tests.
- Modify `src/client/types.ts` and `src/client/client-api.ts`: browser contracts and HTTP calls.
- Modify `test/client-api.test.ts`: exact request coverage.
- Create `src/client/components/DshConversationImport.tsx`: independent selector and mandatory preview state machine.
- Create `test/client-dsh-conversation-import.test.tsx`: selector, preview, conflict, and submit coverage.
- Modify `src/client/components/ImportWorkspace.tsx`: source landing and conversation entry.
- Modify `src/client/floating-workbench.tsx`, `src/client/NobeiClientView.tsx`, and `src/client/use-nobei-workspace.ts`: session-summary plumbing and confirmed-import lifecycle.
- Modify `test/client-import-workspace.test.tsx`, `test/client-view.test.tsx`, `test/client-floating-workbench.test.tsx`, and `test/client-workspace-lifecycle.test.tsx`: composed behavior and regressions.
- Modify `src/client/styles.ts`: narrow-window selector and preview styles.
- Modify `README.md` and `docs/validation.md`: supported input and verification scope.

---

### Task 1: DSH Conversation Source Adapter

**Files:**
- Create: `src/product/dsh-conversation-source.ts`
- Create: `test/dsh-conversation-source.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `Pick<SessionQueryEngine, 'readSession'>`, `SessionLogSnapshot`, `foldSessionTitle`, `isAppendSurfaceEvent`, and `deriveEventMessage`.
- Produces:

```ts
export const DSH_CONVERSATION_MEDIA_TYPE = 'application/vnd.betterlearn.dsh-conversation+markdown' as const

export type DshConversationSourceErrorCode =
  | 'DSH_CONVERSATION_NOT_FOUND'
  | 'DSH_CONVERSATION_NOT_ORDINARY'
  | 'DSH_CONVERSATION_EMPTY'
  | 'DSH_CONVERSATION_TOO_LARGE'
  | 'DSH_CONVERSATION_READ_FAILED'

export class DshConversationSourceError extends Error {
  constructor(readonly code: DshConversationSourceErrorCode, readonly detail?: Record<string, number>)
}

export interface DshConversationDocument {
  sessionIds: string[]
  filename: string
  mediaType: typeof DSH_CONVERSATION_MEDIA_TYPE
  text: string
  contentDigest: string
  conversationCount: number
  messageCount: number
  byteSize: number
  characterCount: number
}

export class DshConversationSource {
  constructor(query: Pick<SessionQueryEngine, 'readSession'>)
  read(sessionIds: readonly string[], signal?: AbortSignal): Promise<DshConversationDocument>
}
```

- [ ] **Step 1: Write failing structural-filter tests**

Create typed event fixtures for append-origin human user text, model assistant text, plugin user context, tool results, reasoning, tool calls, images, request headers, and replacement events. Assert the output contains only:

```md
# DSH 对话合集

## 对话：主题一

### 用户

用户问题

### DSH

公开回答
```

Also assert CRLF normalization, multi-text-block order, empty-message removal, title fallback, stable multi-session ordering, counts, SHA-256, filename safety, non-ordinary rejection, one failed read failing the batch, 512 KiB acceptance, and 512 KiB + 1 rejection.

- [ ] **Step 2: Run the source tests and verify RED**

Run: `pnpm vitest run test/dsh-conversation-source.test.ts`

Expected: FAIL because `src/product/dsh-conversation-source.ts` does not exist.

- [ ] **Step 3: Implement the minimal source adapter**

Implement message extraction around the public DSH helpers:

```ts
for (const event of snapshot.events) {
  if (!isAppendSurfaceEvent(event)) continue
  const message = deriveEventMessage(event)
  if (!message) continue
  const role = message.role === 'user' && message.source.kind === 'user'
    ? '用户'
    : message.role === 'assistant' && message.source.kind === 'model'
      ? 'DSH'
      : undefined
  if (!role) continue
  const text = message.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (text) messages.push({ role, text })
}
```

Read sequentially with abort checks, translate DSH not-found failures without leaking storage details, sort detached results, build the exact Markdown, enforce byte size, and hash `Buffer.from(text, 'utf8')` with `node:crypto`.

Add exact peer/dev dependencies for `@deepseek-ai/dsh-session-query` and `@deepseek-ai/dsh-session-title` using the project's existing rc.7/rc.8 policy.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
pnpm vitest run test/dsh-conversation-source.test.ts
pnpm exec tsc -p tsconfig.host.json --noEmit
```

Expected: all source tests PASS; Host typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/product/dsh-conversation-source.ts test/dsh-conversation-source.test.ts
git commit -m "feat: normalize DSH conversation sources"
```

---

### Task 2: Persist DSH Conversation Source Identity in Core

**Files:**
- Modify: `src/product/types.ts`
- Modify: `python/nobei_core/service.py`
- Modify: `python/nobei_core/repository.py`
- Modify: `python/tests/test_import_and_state.py`
- Modify: `python/tests/test_run_history.py`

**Interfaces:**
- Consumes: `DSH_CONVERSATION_MEDIA_TYPE` string from Task 1 through internal import parameters.
- Produces: Core accepts the private media type for text preview/import and `RunHistorySummary.sourceType` becomes `'document' | 'dsh_conversation'`.

- [ ] **Step 1: Write failing Python tests**

Add a Core import using:

```python
conversation = core.import_text({
    "filename": "DSH对话合集-主题.md",
    "mediaType": "application/vnd.betterlearn.dsh-conversation+markdown",
    "text": "# DSH 对话合集\n\n### 用户\n\n问题",
})
```

Assert its snapshot preserves the media type and `list_runs({})` returns `sourceType == 'dsh_conversation'`. Keep an adjacent Markdown import asserting `sourceType == 'document'`.

- [ ] **Step 2: Run Python tests and verify RED**

Run: `pnpm test:phase1b-python -- python/tests/test_run_history.py python/tests/test_import_and_state.py`

Expected: FAIL with `UNSUPPORTED_MEDIA_TYPE` or the old `sourceType`.

- [ ] **Step 3: Implement the private media type**

Extend `_SUPPORTED_MEDIA_TYPES`; include `d.media_type` in `read_run_history`; map only the exact private media type to `dsh_conversation`:

```python
"sourceType": (
    "dsh_conversation"
    if row["media_type"] == "application/vnd.betterlearn.dsh-conversation+markdown"
    else "document"
),
```

Expand TypeScript internal media/source unions while leaving the public `/imports` parser restricted to TXT, Markdown, and PDF.

- [ ] **Step 4: Run focused Core tests**

Run: `pnpm test:phase1b-python -- python/tests/test_run_history.py python/tests/test_import_and_state.py`

Expected: selected Python tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/product/types.ts python/nobei_core/service.py python/nobei_core/repository.py python/tests/test_import_and_state.py python/tests/test_run_history.py
git commit -m "feat: persist DSH conversation source type"
```

---

### Task 3: Host Preview and Import Routes

**Files:**
- Modify: `src/product/routes.ts`
- Modify: `src/product/plugin.ts`
- Modify: `test/product-routes.test.ts`
- Modify: `test/product-plugin.test.ts`

**Interfaces:**
- Consumes: `DshConversationSource.read()`, existing `previewDocument()`, `GenerationCoordinator.launchImport()`, and model selection validation.
- Produces:

```ts
previewDshConversations(sessionIds: string[], signal?: AbortSignal): Promise<DshConversationPreview>
importDshConversations(input: {
  sessionIds: string[]
  expectedDigest: string
  modelSelection: ModelSelectionSnapshot
}, signal?: AbortSignal): Promise<GenerationLaunch>
```

- [ ] **Step 1: Write failing route tests**

Add route-table tests for:

```text
POST /nobei/v1/dsh-conversations/preview       -> 200
POST /nobei/v1/dsh-conversations/imports       -> 202
```

Assert exact forwarded bodies, no-store response, 1–50 unique string ids, closed objects, lowercase 64-hex digest, existing model-selection restrictions, wrong method handling, Core readiness gating, and public mappings for each source error. Assert import returns 409 when the operation raises `DSH_CONVERSATION_CHANGED`.

- [ ] **Step 2: Run route/plugin tests and verify RED**

Run: `pnpm vitest run test/product-routes.test.ts test/product-plugin.test.ts`

Expected: FAIL because operations and route matches are missing.

- [ ] **Step 3: Add route contracts and parsing**

Add route kinds, exact parsers, operation fields, source error mapping, and 202 status for conversation import. Keep `/nobei/v1/imports` unchanged and disallow the private media type there.

- [ ] **Step 4: Compose source operations in the plugin**

Add `sessionQuery` to the exact injection list and dependency seam. Preview must normalize then call Core preview:

```ts
const document = await conversationSource.read(sessionIds, signal)
const preview = await supervisor.withReadyClient(client => client.previewDocument(document, signal))
return { ...preview, ...document, extractionPlan: preview.extractionPlan }
```

Import must normalize again, compare digest with `timingSafeEqual`-equivalent fixed-length comparison, raise `DSH_CONVERSATION_CHANGED` before generation on mismatch, and otherwise call:

```ts
coordinator.launchImport({
  filename: document.filename,
  mediaType: document.mediaType,
  text: document.text,
  modelSelection: input.modelSelection,
}, signal)
```

- [ ] **Step 5: Run focused route/plugin tests and Host typecheck**

Run:

```bash
pnpm vitest run test/product-routes.test.ts test/product-plugin.test.ts
pnpm exec tsc -p tsconfig.host.json --noEmit
```

Expected: tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/product/routes.ts src/product/plugin.ts test/product-routes.test.ts test/product-plugin.test.ts
git commit -m "feat: expose DSH conversation import routes"
```

---

### Task 4: Browser Contracts and Selectable Session Projection

**Files:**
- Create: `src/client/dsh-conversation-sessions.ts`
- Create: `test/client-dsh-conversation-sessions.test.ts`
- Modify: `src/client/types.ts`
- Modify: `src/client/client-api.ts`
- Modify: `test/client-api.test.ts`

**Interfaces:**
- Consumes: `SessionListState` and `ISessions.subagentAddress()` from the DSH client runtime.
- Produces:

```ts
export interface DshConversationSummary {
  sessionId: string
  title: string
  updatedAt: number
}

export function selectableDshConversations(
  state: Pick<SessionListState, 'ids' | 'byId'>,
  subagentAddress: (id: SessionId) => SubagentAddress | undefined,
): DshConversationSummary[]
```

Client API adds:

```ts
previewDshConversations(sessionIds: string[], signal?: AbortSignal): Promise<DshConversationPreview>
importDshConversations(input: DshConversationImportRequest, signal?: AbortSignal): Promise<GenerationLaunch>
```

- [ ] **Step 1: Write failing projection and HTTP tests**

Assert stable DSH order, title/update mapping, removal of blank/origin-subagent/addressed-subagent rows, and detached result objects. Assert exact POST paths and JSON bodies for preview and import.

- [ ] **Step 2: Run focused client tests and verify RED**

Run: `pnpm vitest run test/client-dsh-conversation-sessions.test.ts test/client-api.test.ts`

Expected: FAIL because the helper and methods do not exist.

- [ ] **Step 3: Implement types, projection, and API methods**

Use only public session summary fields and never call `sessions.open()`. Add `sourceType: 'document' | 'dsh_conversation'` and the private run-document media type to snapshot unions.

- [ ] **Step 4: Run focused tests and Client typecheck**

Run:

```bash
pnpm vitest run test/client-dsh-conversation-sessions.test.ts test/client-api.test.ts
pnpm exec tsc -p tsconfig.client.json --noEmit
```

Expected: tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/client/dsh-conversation-sessions.ts src/client/types.ts src/client/client-api.ts test/client-dsh-conversation-sessions.test.ts test/client-api.test.ts
git commit -m "feat: add DSH conversation client contracts"
```

---

### Task 5: Independent Selector, Mandatory Preview, and Workspace Import

**Files:**
- Create: `src/client/components/DshConversationImport.tsx`
- Create: `test/client-dsh-conversation-import.test.tsx`
- Modify: `src/client/components/ImportWorkspace.tsx`
- Modify: `src/client/floating-workbench.tsx`
- Modify: `src/client/NobeiClientView.tsx`
- Modify: `src/client/use-nobei-workspace.ts`
- Modify: `src/client/styles.ts`
- Modify: `test/client-import-workspace.test.tsx`
- Modify: `test/client-view.test.tsx`
- Modify: `test/client-floating-workbench.test.tsx`
- Modify: `test/client-workspace-lifecycle.test.tsx`

**Interfaces:**
- Consumes: `DshConversationSummary[]`, preview/import API methods, current model selection, and existing `adoptImport()` lifecycle.
- Produces:

```ts
importDshConversations(input: {
  sessionIds: string[]
  expectedDigest: string
}): Promise<boolean>
```

The component state is a closed union:

```ts
type ConversationImportState =
  | { step: 'select'; selected: string[]; query: string }
  | { step: 'previewing'; selected: string[]; query: string }
  | { step: 'preview'; selected: string[]; query: string; preview: DshConversationPreview }
```

- [ ] **Step 1: Write failing component tests**

Cover source landing, independent selector, title search, multiple checkboxes, selected count, empty state, preview request, full safe text rendering, stats/plan, back preserving selection, mandatory preview, busy submit, preview error retry, and 409 change conflict returning to a stale-disabled state that requires preview again.

- [ ] **Step 2: Run focused component tests and verify RED**

Run:

```bash
pnpm vitest run test/client-dsh-conversation-import.test.tsx test/client-import-workspace.test.tsx
```

Expected: FAIL because the component and source entry are missing.

- [ ] **Step 3: Implement the component state machine and source landing**

Render preview text only as a React text node in `<pre>`. Keep selected ids when preview/retry fails. Prune ids only when the DSH list no longer contains them. Do not render user content through `dangerouslySetInnerHTML`.

- [ ] **Step 4: Write failing composed-workspace tests**

Add assertions that FloatingApp projects sessions into workspace props, current DSH session changes update the choices, subagent use remains blocked, and confirmed conversation import carries the current model selection into exactly one API call before adopting the returned run.

- [ ] **Step 5: Run composed tests and verify RED**

Run:

```bash
pnpm vitest run test/client-view.test.tsx test/client-floating-workbench.test.tsx test/client-workspace-lifecycle.test.tsx
```

Expected: FAIL because session-summary plumbing and controller command are missing.

- [ ] **Step 6: Implement workspace plumbing and shared launch path**

Derive summaries once in `BetterLearnFloatingApp`, pass them through `NobeiWorkspace`, and add a conversation import command beside `importText`. Refactor only the duplicated “resolve model → register pending launch → adopt run” portion; preserve per-session pending import deduplication and polling behavior.

- [ ] **Step 7: Add focused styles**

Add source cards, searchable list, checkbox rows, sticky preview actions, wrapped metadata, and a bounded preformatted preview that works at the existing 460 px result/import width and mobile full-screen breakpoint. Use existing color variables and focus-visible rules.

- [ ] **Step 8: Run all client-focused tests and typecheck**

Run:

```bash
pnpm vitest run test/client-dsh-conversation-import.test.tsx test/client-import-workspace.test.tsx test/client-view.test.tsx test/client-floating-workbench.test.tsx test/client-workspace-lifecycle.test.tsx test/client-styles.test.ts
pnpm exec tsc -p tsconfig.client.json --noEmit
```

Expected: tests PASS and Client typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/client/components/DshConversationImport.tsx src/client/components/ImportWorkspace.tsx src/client/dsh-conversation-sessions.ts src/client/floating-workbench.tsx src/client/NobeiClientView.tsx src/client/use-nobei-workspace.ts src/client/styles.ts test/client-dsh-conversation-import.test.tsx test/client-import-workspace.test.tsx test/client-view.test.tsx test/client-floating-workbench.test.tsx test/client-workspace-lifecycle.test.tsx
git commit -m "feat: import selected DSH conversations"
```

---

### Task 6: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/validation.md`
- Modify: `docs/superpowers/plans/2026-09-01-dsh-conversation-import.md` only to check completed boxes during execution.

**Interfaces:**
- Consumes: completed behavior from Tasks 1–5.
- Produces: user-facing input documentation and fresh verification evidence.

- [ ] **Step 1: Update user documentation**

Document the new DSH conversation source, structural inclusion/exclusion rules, mandatory preview, 512 KiB limit, one-task merge, zero-call preview, and preview-change behavior. State that source session ids are not persisted and later DSH messages do not sync into an existing run.

- [ ] **Step 2: Run formatting and static checks**

Run:

```bash
git diff --check
pnpm build
```

Expected: no whitespace errors; Host/Client builds and browser bundle complete with exit 0.

- [ ] **Step 3: Run the complete automated suites**

Run:

```bash
pnpm test
pnpm test:phase1b-python
```

Expected: Vitest and pytest report zero failures. These commands must not invoke a real provider.

- [ ] **Step 4: Run package and topology checks**

Run:

```bash
pnpm vitest run test/package.test.ts test/product-patch.test.ts test/dsh-topology.test.ts
pnpm pack --pack-destination dist
```

Expected: dependency/topology/package tests PASS and the package contains the required compiled files without bundling duplicate DSH runtimes.

- [ ] **Step 5: Inspect the final diff against the specification**

Verify every acceptance item in `docs/superpowers/specs/2026-09-01-dsh-conversation-import-design.md`, confirm unrelated user files remain untouched, and record any browser-only validation still pending.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md docs/validation.md docs/superpowers/plans/2026-09-01-dsh-conversation-import.md
git commit -m "docs: document DSH conversation extraction"
```

- [ ] **Step 7: Optional real DSH browser acceptance**

Only when the user authorizes a real model call: install the local build into the BetterLearn profile, select two ordinary conversations, inspect that the preview excludes system/reasoning/tool content, confirm one extraction, and inspect evidence headings. Without that authorization, stop after deterministic browser rendering and fake-provider acceptance and report the real-model step as pending rather than claiming it passed.
