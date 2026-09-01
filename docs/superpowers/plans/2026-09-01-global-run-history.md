# BetterLearn Global Run History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a globally persisted, collapsible extraction-history sidebar that can reopen every BetterLearn run without re-running the model or shrinking the existing workspace content.

**Architecture:** SQLite remains the source of truth. A new closed `runs.list` Core RPC method returns lightweight summaries through `GET /nobei/v1/runs`; the client renders those summaries in a left sidebar and switches the existing workspace controller to the chosen `runId`. The sidebar is collapsed by default and changes only the floating shell width, while each existing workspace screen keeps its accepted width.

**Tech Stack:** Python 3.12, SQLite, newline JSON-RPC 2.0, TypeScript 5.9, React 18, Vitest, react-test-renderer, Playwright, DSH local plugin runtime.

## Global Constraints

- History is global to BetterLearn SQLite and must not be assembled from DSH sessions or `sessionStorage`.
- History is collapsed by default; opening it widens the floating panel to the left without shrinking the active workspace.
- Existing import, processing, review, result, retry, model-selection, and evidence flows remain the only task-detail implementation.
- History navigation performs read-only product requests and never invokes a model provider.
- First version has no delete, search, categorization, pinning, pagination, vector database, or DSH-conversation import.
- The existing SQLite schema is sufficient; do not add a migration.
- Use the existing fake provider for browser acceptance so verification has zero model cost.

---

### Task 1: Core run-history query and RPC contract

**Files:**
- Create: `python/tests/test_run_history.py`
- Modify: `python/nobei_core/repository.py`
- Modify: `python/nobei_core/service.py`
- Modify: `python/nobei_core/constants.py`
- Modify: `python/tests/test_rpc.py`
- Modify: `python/tests/test_domain_contract.py`

**Interfaces:**
- Consumes: existing `Database.read_snapshot()`, `runs`, and `documents` tables.
- Produces: repository function `read_run_history(con)`, service method `Phase1Core.list_runs({})`, and RPC method `runs.list`.

- [ ] **Step 1: Write failing Core history tests**

Create `python/tests/test_run_history.py` with fixtures that create two runs, update their timestamps and counts, and assert the exact closed result:

```python
def test_list_runs_returns_global_summaries_in_updated_order(core, database):
    older = core.import_text({"filename": "旧材料.md", "mediaType": "text/markdown", "text": "旧内容"})
    newer = core.import_text({"filename": "新材料.md", "mediaType": "text/markdown", "text": "新内容"})
    database.execute("UPDATE runs SET updated_at='2026-09-01T01:00:00Z' WHERE id=?", (older["runId"],))
    database.execute("UPDATE runs SET updated_at='2026-09-01T02:00:00Z' WHERE id=?", (newer["runId"],))

    result = core.list_runs({})

    assert [row["runId"] for row in result["runs"]] == [newer["runId"], older["runId"]]
    assert set(result["runs"][0]) == {
        "runId", "sourceType", "sourceLabel", "status", "stage",
        "updatedAt", "candidateCount", "knowledgePointCount",
    }
    assert result["runs"][0]["sourceType"] == "document"
    assert result["runs"][0]["sourceLabel"] == "新材料.md"
```

Add tests for an empty database, stable secondary ordering, all run statuses, correct valid-candidate / accepted-knowledge-point counts, and rejecting non-empty RPC parameters.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
.venv-phase1b/bin/python -m pytest python/tests/test_run_history.py python/tests/test_domain_contract.py python/tests/test_rpc.py -q
```

Expected: failures because `list_runs`, `read_run_history`, and `runs.list` do not exist.

- [ ] **Step 3: Implement the minimal read-only history query**

Add a parameterized repository query equivalent to:

```python
def read_run_history(con: sqlite3.Connection) -> list[dict[str, Any]]:
    return [dict(row) for row in con.execute(
        "SELECT r.id AS run_id,d.filename,r.status,r.stage,r.updated_at,"
        "r.valid_candidate_count,r.accepted_candidate_count "
        "FROM runs r JOIN documents d ON d.id=r.document_id "
        "ORDER BY r.updated_at DESC,r.created_at DESC,r.id DESC"
    )]
```

Add `Phase1Core.list_runs` with exact empty parameters and closed camelCase summaries:

```python
def list_runs(self, params: object) -> dict[str, object]:
    _require_params(params, frozenset())
    with self._database.read_snapshot() as con:
        return {"runs": [{
            "runId": row["run_id"],
            "sourceType": "document",
            "sourceLabel": row["filename"],
            "status": row["status"],
            "stage": row["stage"],
            "updatedAt": row["updated_at"],
            "candidateCount": row["valid_candidate_count"],
            "knowledgePointCount": row["accepted_candidate_count"],
        } for row in read_run_history(con)]}
```

Register `"runs.list": "list_runs"` in the immutable RPC method table.

- [ ] **Step 4: Run Core history and RPC tests**

Run the focused command from Step 2.

Expected: all selected tests pass.

- [ ] **Step 5: Commit the Core slice**

```bash
git add python/nobei_core/repository.py python/nobei_core/service.py python/nobei_core/constants.py python/tests/test_run_history.py python/tests/test_rpc.py python/tests/test_domain_contract.py
git commit -m "feat: expose global run history from core"
```

---

### Task 2: Host RPC client and HTTP endpoint

**Files:**
- Modify: `src/product/types.ts`
- Modify: `src/product/core-rpc-client.ts`
- Modify: `src/product/routes.ts`
- Modify: `src/product/plugin.ts`
- Modify: `test/product-core-rpc-client.test.ts`
- Modify: `test/product-routes.test.ts`
- Modify: `test/product-plugin.test.ts`
- Modify: `test/verify-phase1c-host.test.ts`

**Interfaces:**
- Consumes: Core method `runs.list` returning `RunHistoryResult`.
- Produces: `ProductOperations.listRuns(signal?)` and `GET /nobei/v1/runs`.

- [ ] **Step 1: Add failing host contract tests**

Extend the RPC-client test to assert this exact request:

```ts
const pending = client.listRuns(controller.signal)
expect(JSON.parse(output.read().toString())).toEqual({
  jsonrpc: '2.0', id: 1, method: 'runs.list', params: {},
})
```

Add a product-route case:

```ts
{
  key: 'listRuns',
  method: 'GET',
  path: '/nobei/v1/runs',
  status: 200,
}
```

The fake operation returns `{ runs: [] }`. Extend plugin wiring tests so `listRuns` calls `client.listRuns({}, signal)` through the ready supervisor.

- [ ] **Step 2: Run the focused TypeScript tests and verify failure**

```bash
pnpm vitest run test/product-core-rpc-client.test.ts test/product-routes.test.ts test/product-plugin.test.ts test/verify-phase1c-host.test.ts
```

Expected: type or assertion failures because `RunHistoryResult`, `listRuns`, and the collection route are missing.

- [ ] **Step 3: Add exact host types and forwarding**

Define:

```ts
export interface RunHistorySummary {
  runId: OpaqueId
  sourceType: 'document'
  sourceLabel: string
  status: string
  stage: string
  updatedAt: string
  candidateCount: number
  knowledgePointCount: number
}

export interface RunHistoryResult extends Record<string, unknown> {
  runs: RunHistorySummary[]
}
```

Add `FixedCoreRpcClient.listRuns(signal?)`, the collection route match before the `/:runId` route, a `ProductOperations.listRuns` function, and plugin forwarding through `withReadyClient`.

- [ ] **Step 4: Run host tests and build**

```bash
pnpm vitest run test/product-core-rpc-client.test.ts test/product-routes.test.ts test/product-plugin.test.ts test/verify-phase1c-host.test.ts
pnpm build
```

Expected: all selected tests pass and both TypeScript projects build.

- [ ] **Step 5: Commit the Host slice**

```bash
git add src/product/types.ts src/product/core-rpc-client.ts src/product/routes.ts src/product/plugin.ts test/product-core-rpc-client.test.ts test/product-routes.test.ts test/product-plugin.test.ts test/verify-phase1c-host.test.ts
git commit -m "feat: serve global run history"
```

---

### Task 3: Client history API and sidebar component

**Files:**
- Create: `src/client/components/HistorySidebar.tsx`
- Create: `test/client-history-sidebar.test.tsx`
- Modify: `src/client/types.ts`
- Modify: `src/client/client-api.ts`
- Modify: `test/client-api.test.ts`

**Interfaces:**
- Consumes: `GET /nobei/v1/runs` returning `RunHistoryResult`.
- Produces: `ClientApi.listRuns(signal?)` and `HistorySidebar` props `{ runs, currentRunId, loading, error, onRetry, onSelect, onNew }`.

- [ ] **Step 1: Write failing API and component tests**

Add this Client API assertion:

```ts
await createClientApi().listRuns(controller.signal)
expect(fetchMock).toHaveBeenLastCalledWith('/nobei/v1/runs', {
  method: 'GET', headers: {}, signal: controller.signal,
})
```

Create component tests with two summaries and assert:

```tsx
const renderer = create(<HistorySidebar
  runs={[completed, reviewPending]}
  currentRunId={completed.runId}
  loading={false}
  onRetry={vi.fn()}
  onSelect={select}
  onNew={createNew}
/>)
expect(JSON.stringify(renderer.toJSON())).toContain('材料一.md')
expect(JSON.stringify(renderer.toJSON())).toContain('已完成')
expect(JSON.stringify(renderer.toJSON())).toContain('待审查')
```

Also test processing and failed labels, counts, current-row marking, empty state, loading state, local error/retry, select, and new-extraction callbacks.

- [ ] **Step 2: Run focused client tests and verify failure**

```bash
pnpm vitest run test/client-api.test.ts test/client-history-sidebar.test.tsx
```

Expected: failures because the client method and component do not exist.

- [ ] **Step 3: Implement closed client types, API, and presentational sidebar**

Add matching `RunHistorySummary` / `RunHistoryResult` types to `src/client/types.ts`, then add:

```ts
listRuns(signal?: AbortSignal) {
  return get<RunHistoryResult>('/nobei/v1/runs', signal)
}
```

Implement `HistorySidebar` as a presentational `<aside aria-label="提取历史">` with one button per run, a “新建提取” button, and a retry button only for the sidebar error state. Map raw statuses using one exhaustive local function; do not issue requests from this component.

- [ ] **Step 4: Run focused client tests**

Run the command from Step 2.

Expected: all selected tests pass.

- [ ] **Step 5: Commit the client contract slice**

```bash
git add src/client/types.ts src/client/client-api.ts src/client/components/HistorySidebar.tsx test/client-api.test.ts test/client-history-sidebar.test.tsx
git commit -m "feat: add extraction history sidebar"
```

---

### Task 4: Workspace switching and floating-panel layout

**Files:**
- Modify: `src/client/use-nobei-workspace.ts`
- Modify: `src/client/NobeiClientView.tsx`
- Modify: `src/client/floating-workbench.tsx`
- Modify: `src/client/styles.ts`
- Modify: `test/client-workspace-lifecycle.test.tsx`
- Modify: `test/client-view.test.tsx`
- Modify: `test/client-floating-workbench.test.tsx`
- Modify: `test/client-styles.test.ts`

**Interfaces:**
- Consumes: `ClientApi.listRuns`, `HistorySidebar`, and existing task-detail APIs.
- Produces: `WorkspaceController.openRun(runId)`, collapsible global history behavior, and `data-history-open` sizing state on the floating panel.

- [ ] **Step 1: Write failing workspace-switch tests**

Add a lifecycle test that restores `job_old`, calls `openRun('job_new')`, and asserts:

```ts
expect(savedState(storage, 'session').runId).toBe('job_new')
expect(api.getRun).toHaveBeenCalledWith('job_new', expect.any(AbortSignal))
expect(latest?.progress).toBeNull()
expect(latest?.candidates).toEqual([])
expect(latest?.knowledgePoints).toEqual([])
```

Use a scheduler that records aborts and assert the old poll ends while the new run starts from event cursor `0`. Assert `reset()` removes only the session pointer and does not call any product mutation.

- [ ] **Step 2: Write failing composed-layout tests**

Extend `test/client-view.test.tsx` with `api.listRuns` fixtures. Assert the history toggle is initially collapsed, opening it renders both summaries, selecting a row calls the existing detail APIs without `importText`, and “新建提取” returns to import while the list still contains both rows.

Extend the floating test to assert:

```ts
expect(panel.props['data-history-open']).toBe('false')
act(() => historyButton.props.onClick())
expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' })
  .props['data-history-open']).toBe('true')
```

Extend style tests for a fixed sidebar-width variable, an open-state width expression, unchanged existing screen-width variables, leftward growth, and the existing mobile full-screen rule.

- [ ] **Step 3: Implement `openRun` with stale-request cancellation**

Add to `WorkspaceController`:

```ts
currentRunId?: string
openRun(runId: string): void
```

`openRun` aborts the old poll and command controllers, clears run-specific React state, writes `{ version: 1, runId, lastEventSeq: 0 }`, switches to processing, and starts the existing poll for the selected task. Preserve pending-review replay only when it belongs to the same selected run.

- [ ] **Step 4: Integrate history state into the composed workspace**

In `NobeiWorkspace`, maintain `historyOpen`, `historyRuns`, `historyLoading`, and `historyError`. Fetch on every transition from closed to open and after successful task-changing events. Render:

```tsx
<div className="nobei-client-layout" data-history-open={historyOpen}>
  {historyOpen && <HistorySidebar ... />}
  <main className="nobei-client">...</main>
</div>
```

Expose `onHistoryOpenChange?(open: boolean)` so `BetterLearnFloatingApp` can set `data-history-open`. Reset history-open state when the entire BetterLearn panel is collapsed.

- [ ] **Step 5: Implement non-compressing panel styles**

Use one sidebar width and gap, for example:

```css
.betterlearn-floating-panel { --betterlearn-history-width: 300px; }
.betterlearn-floating-panel[data-history-open="true"] {
  width: min(calc(var(--betterlearn-panel-width) + var(--betterlearn-history-width)), calc(100vw - 32px));
}
.nobei-client-layout[data-history-open="true"] {
  grid-template-columns: var(--betterlearn-history-width) var(--betterlearn-panel-width);
}
```

Keep the panel anchored with `right: 16px`; constrain the history list to internal scrolling; retain `inset: 0; width: 100%` at `max-width: 680px`.

- [ ] **Step 6: Run all client-focused tests and build**

```bash
pnpm vitest run test/client-workspace-lifecycle.test.tsx test/client-view.test.tsx test/client-floating-workbench.test.tsx test/client-styles.test.ts test/client-history-sidebar.test.tsx test/client-api.test.ts
pnpm build
```

Expected: all selected tests pass and client bundle builds.

- [ ] **Step 7: Commit the integrated UI slice**

```bash
git add src/client/use-nobei-workspace.ts src/client/NobeiClientView.tsx src/client/floating-workbench.tsx src/client/styles.ts test/client-workspace-lifecycle.test.tsx test/client-view.test.tsx test/client-floating-workbench.test.tsx test/client-styles.test.ts
git commit -m "feat: navigate global extraction history"
```

---

### Task 5: Zero-cost acceptance, full verification, and local upgrade

**Files:**
- Modify: `scripts/accept-phase1d-client.mjs`
- Modify: `test/accept-phase1d-client.test.ts`
- Generate: `evidence/client/*` through the existing acceptance command

**Interfaces:**
- Consumes: completed global-history feature and the installed local fake provider.
- Produces: machine-checked evidence for two retained runs, switching, sizing, DSH-session independence, and zero model calls during history navigation.

- [ ] **Step 1: Extend the acceptance-result contract first**

Add required result fields and failing assertions:

```ts
expect(result.history).toMatchObject({
  collapsedByDefault: true,
  retainedRunCount: 2,
  hostLayoutUnchanged: true,
  contentWidthUnchanged: true,
  globalAcrossSessions: true,
  navigationProviderCalls: 0,
})
```

- [ ] **Step 2: Run the acceptance contract test and verify failure**

```bash
pnpm vitest run test/accept-phase1d-client.test.ts
```

Expected: failure because the browser-result validator does not yet require history evidence.

- [ ] **Step 3: Extend the fake-provider browser flow**

Drive two imports, capture both run ids, open the history sidebar, switch between tasks, switch DSH sessions, and measure:

- host conversation width before and after history expansion;
- active workspace content width before and after history expansion;
- floating panel width before and after history expansion;
- provider request count before and after history-only navigation.

Write the values into the existing `browser-flow.json` and `final-result.json` evidence files and validate them in `assertPhase1dBrowserResult`.

- [ ] **Step 4: Run full automated verification**

```bash
pnpm test
pnpm test:phase1b-python
```

Expected: complete Vitest, TypeScript build, and Python suites pass.

- [ ] **Step 5: Run zero-cost DSH browser acceptance**

Use the existing acceptance prepare/execute workflow with the local fake provider and a fresh evidence directory. Expected terminal marker: `PHASE1D_CLIENT_GO`.

- [ ] **Step 6: Commit acceptance coverage**

```bash
git add scripts/accept-phase1d-client.mjs test/accept-phase1d-client.test.ts
git commit -m "test: accept global extraction history"
```

- [ ] **Step 7: Upgrade the user's local BetterLearn installation and smoke-test it**

Build and pack the current repository, upgrade through the existing BetterLearn maintenance CLI so its backup mechanism runs, restart the local DSH service, and verify:

```text
http://127.0.0.1:3000/nobei/v1/runs
```

returns the user's existing runs without invoking a model. Leave the main service running for user inspection.

- [ ] **Step 8: Final repository audit**

```bash
git status --short --branch
git log --oneline -8
```

Expected: implementation files are committed; `.superpowers/` visual-companion artifacts remain uncommitted and are not included in product commits.
