# BetterLearn Knowledge Point Edit and Run Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users persistently edit completed knowledge points, delete inactive history tasks, and terminate then delete the currently generating task.

**Architecture:** Two new closed Core RPC commands keep SQLite authoritative: `knowledge_points.update` mutates a formal point and its review/statistics transactionally, while `runs.delete` removes a run-owned document graph and review idempotency records. The Host exposes PATCH/DELETE routes; `GenerationCoordinator.terminateRun()` prevents provider finalization before active deletion. React adds inline result-card editing, confirmed history deletion, and a processing-screen terminate/delete action.

**Tech Stack:** Python 3.12, SQLite WAL/foreign keys, JSON-RPC 2.0, Node.js 24, TypeScript 5.9, React 18, Vitest 3, pytest.

## Global Constraints

- Completed knowledge points may edit `title` and `statement` only; type and evidence remain immutable.
- Title length is `1..120`; statement length is `1..2000`.
- First post-completion edit changes its review classification from accepted to edited; later edits do not increment the edited count again.
- History deletion is available for `review_pending`, `completed`, `failed_retryable`, and `failed_terminal` only.
- Active states are not deletable from history; the processing page exposes “终止并删除”.
- Terminate/delete cancels the actual provider flight first and leaves no cancelled or failed history record.
- Run deletion removes document, attempts, candidates, reviews, knowledge points, evidence, events, and candidate-review idempotency results.
- No undo, recycle bin, version history, bulk operations, or model calls.
- All mutations require one user confirmation where destructive and must preserve the current UI on failure.

---

## File Map

- Modify `python/nobei_core/constants.py`: register `knowledge_points.update` and `runs.delete` RPC methods.
- Modify `python/nobei_core/repository.py`: formal-point lookup/update and complete run-graph deletion helpers.
- Modify `python/nobei_core/service.py`: validate and transact both commands.
- Create `python/tests/test_knowledge_point_update.py`: content, hash, counters, repeat edit, invalid state, rollback.
- Create `python/tests/test_run_delete.py`: cascade deletion, idempotency cleanup, invalid id, rollback.
- Modify `python/tests/test_domain_contract.py` and `python/tests/test_rpc.py`: closed method table and dispatcher coverage.
- Modify `src/product/types.ts`: Core command/result interfaces.
- Modify `src/product/core-rpc-client.ts`: new RPC calls.
- Modify `src/product/generation-coordinator.ts`: terminate active flight without submit/fail.
- Modify `src/product/plugin.ts`: bind update/delete operations and coordinator ordering.
- Modify `src/product/routes.ts`: PATCH/DELETE matching, validation, and responses.
- Modify `test/product-core-rpc-client.test.ts`, `test/generation-coordinator.test.ts`, `test/product-plugin.test.ts`, `test/product-routes.test.ts`: Host coverage.
- Modify `src/client/types.ts` and `src/client/client-api.ts`: browser contracts.
- Modify `src/client/components/ResultSummary.tsx`: inline completed-point editing.
- Modify `src/client/components/HistorySidebar.tsx`: inactive delete confirmation.
- Modify `src/client/components/RunProgress.tsx`: terminate/delete confirmation.
- Modify `src/client/use-nobei-workspace.ts` and `src/client/NobeiClientView.tsx`: mutation state and lifecycle cleanup.
- Modify corresponding client component/lifecycle/API tests.
- Modify `scripts/accept-phase1d-client.mjs`, `README.md`, `docs/architecture.md`, and `docs/data-model.md`: zero-cost acceptance and documentation.

### Task 1: Core knowledge-point update transaction

**Files:**
- Modify: `python/nobei_core/constants.py`
- Modify: `python/nobei_core/repository.py`
- Modify: `python/nobei_core/service.py`
- Create: `python/tests/test_knowledge_point_update.py`
- Modify: `python/tests/test_domain_contract.py`
- Modify: `python/tests/test_rpc.py`

**Interfaces:**
- Consumes: existing `_formal_content_hash`, `_review_knowledge_point_snapshot`, `run_snapshot_counts`, `now_iso`, and transactional database boundary.
- Produces: RPC `knowledge_points.update({ knowledgePointId, title, statement }) -> { knowledgePoint, run }`.

- [ ] **Step 1: Write failing Core behavior tests**

Create a fixture helper that imports, submits one candidate, and accepts it. Cover:

```py
def test_update_completed_knowledge_point_persists_and_reclassifies(core, database):
    run, point = completed_point(core)
    result = core.update_knowledge_point({
        "knowledgePointId": point["knowledgePointId"],
        "title": "修改后的标题",
        "statement": "修改后的知识陈述。",
    })
    assert result["knowledgePoint"]["title"] == "修改后的标题"
    assert result["run"]["counts"]["accepted"] == 0
    assert result["run"]["counts"]["editedAndAccepted"] == 1
    stored = core.list_knowledge_points({"runId": run["runId"]})["knowledgePoints"][0]
    assert stored["statement"] == "修改后的知识陈述。"
    row = database.one("SELECT action,final_title,final_statement FROM candidate_reviews")
    assert row == {
        "action": "edited_and_accept",
        "final_title": "修改后的标题",
        "final_statement": "修改后的知识陈述。",
    }

def test_second_update_does_not_increment_edited_count(core):
    run, point = completed_point(core)
    core.update_knowledge_point({"knowledgePointId": point["knowledgePointId"], "title": "一", "statement": "第一次"})
    second = core.update_knowledge_point({"knowledgePointId": point["knowledgePointId"], "title": "二", "statement": "第二次"})
    assert second["run"]["counts"]["editedAndAccepted"] == 1
```

Also parameterize empty/overlong title and statement, an unknown but well-formed `kp_0123456789abcdefabcd`, extra fields, and a point whose run is not completed. Add a fault-injection case after the knowledge-point UPDATE and assert title, review action, counters, revision, and hash all roll back.

- [ ] **Step 2: Run Core tests and verify failure**

Run: `python3.12 -m pytest -q python/tests/test_knowledge_point_update.py python/tests/test_domain_contract.py python/tests/test_rpc.py`

Expected: FAIL because the RPC and service method do not exist.

- [ ] **Step 3: Register the closed RPC and implement repository helpers**

Add:

Add the exact mapping entry `"knowledge_points.update": "update_knowledge_point"` beside `"knowledge_points.list_for_run"` in the existing `RPC_METHODS` mapping.

Repository helpers must expose:

```py
def require_knowledge_point_for_update(con: sqlite3.Connection, knowledge_point_id: str) -> dict[str, Any]:
    require_opaque_id(knowledge_point_id, "kp")
    row = con.execute(
        "SELECT k.*,v.candidate_id,v.action,c.run_id FROM knowledge_points k "
        "JOIN candidate_reviews v ON v.knowledge_point_id=k.id "
        "JOIN candidates c ON c.id=v.candidate_id WHERE k.id=?",
        (knowledge_point_id,),
    ).fetchone()
    if row is None:
        raise CoreProblem("INVALID_IDENTIFIER", "knowledge point does not exist")
    return dict(row)

def update_formal_knowledge_point(con: sqlite3.Connection, *, knowledge_point_id: str,
    title: str, statement: str, content_hash: str, updated_at: str) -> None:
    changed = con.execute(
        "UPDATE knowledge_points SET title=?,statement=?,content_hash=?,updated_at=? WHERE id=?",
        (title, statement, content_hash, updated_at, knowledge_point_id),
    ).rowcount
    if changed != 1:
        raise CoreProblem("TRANSACTION_FAILED", "knowledge point update was lost")

def reclassify_review_after_point_edit(con: sqlite3.Connection, *, candidate_id: str,
    title: str, statement: str, edited_at: str) -> bool:
    row = con.execute(
        "SELECT action FROM candidate_reviews WHERE candidate_id=?", (candidate_id,)
    ).fetchone()
    if row is None or row["action"] not in ("accept", "edited_and_accept"):
        raise CoreProblem("RUN_STATE_CONFLICT", "knowledge point is not editable")
    first_edit = row["action"] == "accept"
    con.execute(
        "UPDATE candidate_reviews SET action='edited_and_accept',final_title=?,"
        "final_statement=?,reviewed_at=? WHERE candidate_id=?",
        (title, statement, edited_at, candidate_id),
    )
    return first_edit
```

The lookup must join `candidate_reviews` and `candidates` so the service can require `runs.status == 'completed'` and recalculate the formal hash with stored evidence.

- [ ] **Step 4: Implement the service transaction**

Validate the exact field set, opaque `kp` id, and string bounds. In one `_transactional_write`:

```py
point = require_knowledge_point_for_update(con, knowledge_point_id)
run = require_run(con, point["run_id"])
if run["status"] != "completed":
    raise CoreProblem("RUN_STATE_CONFLICT", "run is not completed")
evidence = knowledge_point_evidence(con, knowledge_point_id)
content_hash = _formal_content_hash(
    candidate_type=point["type"], title=title, statement=statement,
    document_id=point["document_id"], evidence=_public_evidence(evidence),
)
edited_at = now_iso()
update_formal_knowledge_point(
    con,
    knowledge_point_id=knowledge_point_id,
    title=title,
    statement=statement,
    content_hash=content_hash,
    updated_at=edited_at,
)
first_edit = reclassify_review_after_point_edit(
    con,
    candidate_id=point["candidate_id"],
    title=title,
    statement=statement,
    edited_at=edited_at,
)
con.execute(
    "UPDATE runs SET edited_candidate_count=edited_candidate_count+?,revision=revision+1,updated_at=? WHERE id=?",
    (int(first_edit), edited_at, point["run_id"]),
)
```

After the update, call `require_run(con, point["run_id"])` and return a `knowledgePoint` built with `_review_knowledge_point_snapshot(knowledge_point_id=knowledge_point_id, candidate_type=point["type"], title=title, statement=statement, document_id=point["document_id"], evidence=_public_evidence(evidence))` plus `run: _run_snapshot(con, updated_run, self._contract)`, all read inside the same transaction.

- [ ] **Step 5: Update protocol tests and run the focused suite**

Assert `RPC_METHODS["knowledge_points.update"] == "update_knowledge_point"`, exact request dispatch, extra-field rejection, and closed result keys.

Run: `python3.12 -m pytest -q python/tests/test_knowledge_point_update.py python/tests/test_domain_contract.py python/tests/test_rpc.py`

Expected: PASS.

- [ ] **Step 6: Commit Core editing**

```bash
git add python/nobei_core/constants.py python/nobei_core/repository.py python/nobei_core/service.py python/tests/test_knowledge_point_update.py python/tests/test_domain_contract.py python/tests/test_rpc.py
git commit -m "feat: update completed knowledge points"
```

### Task 2: Host and browser API for knowledge-point updates

**Files:**
- Modify: `src/product/types.ts`
- Modify: `src/product/core-rpc-client.ts`
- Modify: `src/product/plugin.ts`
- Modify: `src/product/routes.ts`
- Modify: `src/client/types.ts`
- Modify: `src/client/client-api.ts`
- Modify: `test/product-core-rpc-client.test.ts`
- Modify: `test/product-plugin.test.ts`
- Modify: `test/product-routes.test.ts`
- Modify: `test/client-api.test.ts`

**Interfaces:**
- Consumes: Core RPC from Task 1.
- Produces:

```ts
interface UpdateKnowledgePointParams { knowledgePointId: string; title: string; statement: string }
updateKnowledgePoint(params: UpdateKnowledgePointParams, signal?: AbortSignal): Promise<CoreObjectResult>
// browser:
updateKnowledgePoint(id: string, input: { title: string; statement: string }, signal?: AbortSignal): Promise<KnowledgePointUpdateResult>
```

- [ ] **Step 1: Write failing transport tests**

Assert the Core client sends:

```ts
{ jsonrpc: '2.0', id: 1, method: 'knowledge_points.update', params: {
  knowledgePointId, title: '新标题', statement: '新陈述',
} }
```

Assert `PATCH /nobei/v1/knowledge-points/:kpId` accepts exactly `{ title, statement }`, rejects missing/extra/overlong fields with `400`, rejects invalid ids, and forwards the typed params. Assert client API uses PATCH and JSON body.

- [ ] **Step 2: Run transport tests and verify failure**

Run: `corepack pnpm@11.23.0 vitest run test/product-core-rpc-client.test.ts test/product-plugin.test.ts test/product-routes.test.ts test/client-api.test.ts`

Expected: FAIL because the types and routes do not exist.

- [ ] **Step 3: Implement Core client and plugin binding**

Add `UpdateKnowledgePointParams` and `KnowledgePointUpdateResult` to product types. Add a `FixedCoreRpcClient.updateKnowledgePoint()` request using `CORE_WRITE_RPC_TIMEOUT_MS`. Extend `ProductOperations` and bind through `supervisor.withReadyClient(client => client.updateKnowledgePoint(params, signal))`.

- [ ] **Step 4: Implement PATCH routing and validation**

Add route match:

```ts
| { kind: 'knowledge-point-update'; method: 'PATCH'; knowledgePointId: string }
```

Match `/nobei/v1/knowledge-points/:id`, extend `resourceId` to `kp`, parse exact `{ title, statement }` with existing text length rules, then dispatch `operations.updateKnowledgePoint(updateParams as UpdateKnowledgePointParams)`. PATCH continues to require same-origin mutation authorization and JSON content type.

- [ ] **Step 5: Implement browser ClientApi**

Add a generic `patch()` helper next to `post()`, the interface method, and:

```ts
updateKnowledgePoint(knowledgePointId, input, signal) {
  return patch<KnowledgePointUpdateResult>(
    `/nobei/v1/knowledge-points/${encodeURIComponent(knowledgePointId)}`,
    input,
    signal,
  )
}
```

- [ ] **Step 6: Run transport tests**

Run: `corepack pnpm@11.23.0 vitest run test/product-core-rpc-client.test.ts test/product-plugin.test.ts test/product-routes.test.ts test/client-api.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the update API**

```bash
git add src/product/types.ts src/product/core-rpc-client.ts src/product/plugin.ts src/product/routes.ts src/client/types.ts src/client/client-api.ts test/product-core-rpc-client.test.ts test/product-plugin.test.ts test/product-routes.test.ts test/client-api.test.ts
git commit -m "feat: serve knowledge point updates"
```

### Task 3: Completed-result inline editor

**Files:**
- Modify: `src/client/components/ResultSummary.tsx`
- Modify: `src/client/use-nobei-workspace.ts`
- Modify: `src/client/NobeiClientView.tsx`
- Modify: `test/client-result-summary.test.tsx`
- Modify: `test/client-workspace-lifecycle.test.tsx`
- Modify: `test/client-view.test.tsx`
- Modify: `src/client/styles.ts`

**Interfaces:**
- Consumes: `ClientApi.updateKnowledgePoint` and `KnowledgePointUpdateResult` from Task 2.
- Produces: workspace method `updateKnowledgePoint(point, { title, statement }): Promise<boolean>` and per-card inline edit UI.

- [ ] **Step 1: Write failing component and lifecycle tests**

In the result component test, click the first card's `knowledge-point-edit`, modify `knowledge-point-title` and `knowledge-point-statement`, then click `knowledge-point-save`. Assert the callback receives the point and exact strings. Assert cancel restores prior text, invalid empty title disables save, and a callback result of `false` keeps inputs plus renders `role="alert"`.

In lifecycle tests, stub API result with an updated point and run whose counts are `{ accepted: 0, editedAndAccepted: 1 }`; assert local state replaces only that point and run. Assert failure returns `false` without optimistic mutation.

- [ ] **Step 2: Run client tests and verify failure**

Run: `corepack pnpm@11.23.0 vitest run test/client-result-summary.test.tsx test/client-workspace-lifecycle.test.tsx test/client-view.test.tsx`

Expected: FAIL because result cards are read-only.

- [ ] **Step 3: Add workspace mutation**

Expose:

```ts
async function updateKnowledgePoint(point: KnowledgePointSnapshot,
  input: { title: string; statement: string }): Promise<boolean> {
  if (busy || run?.status !== 'completed') return false
  setBusy(true)
  try {
    const result = await api.updateKnowledgePoint(point.knowledgePointId, input)
    setRun(result.run)
    setKnowledgePoints(items => items.map(item =>
      item.knowledgePointId === point.knowledgePointId ? result.knowledgePoint : item))
    return true
  } catch (error) {
    setFailure(error)
    return false
  } finally {
    setBusy(false)
  }
}
```

Pass it through `NobeiWorkspace` to `ResultSummary`. If global `busy` would block unrelated reading, use a dedicated `updatingKnowledgePointId` instead and expose it with the method.

- [ ] **Step 4: Implement inline card editing**

Extract a small local `EditableKnowledgePointCard` inside `ResultSummary.tsx` or a focused new component if the file exceeds roughly 150 lines. It owns draft title/statement and card-local error. Render edit/save/cancel controls with the test ids from Step 1. Saving awaits `onUpdate`; exit edit mode only on `true`.

- [ ] **Step 5: Add editor styles**

Keep the current green evidence/result card identity. Inputs fill the card width; textarea starts near `120px`, remains vertically resizable, and actions are compact. Reuse existing focus, disabled, action-blue, and rejection-red variables.

- [ ] **Step 6: Run result/lifecycle tests**

Run: `corepack pnpm@11.23.0 vitest run test/client-result-summary.test.tsx test/client-workspace-lifecycle.test.tsx test/client-view.test.tsx test/client-styles.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit completed editing UI**

```bash
git add src/client/components/ResultSummary.tsx src/client/use-nobei-workspace.ts src/client/NobeiClientView.tsx src/client/styles.ts test/client-result-summary.test.tsx test/client-workspace-lifecycle.test.tsx test/client-view.test.tsx test/client-styles.test.ts
git commit -m "feat: edit completed knowledge points"
```

### Task 4: Core run-graph deletion

**Files:**
- Modify: `python/nobei_core/constants.py`
- Modify: `python/nobei_core/repository.py`
- Modify: `python/nobei_core/service.py`
- Create: `python/tests/test_run_delete.py`
- Modify: `python/tests/test_domain_contract.py`
- Modify: `python/tests/test_rpc.py`

**Interfaces:**
- Produces: RPC `runs.delete({ runId }) -> { runId, deleted: true }`.

- [ ] **Step 1: Write failing deletion tests**

Build completed, review-pending, and failed runs. For a completed run, record ids for document, attempt, candidates, candidate evidence, reviews, knowledge points, knowledge-point evidence, events, and review idempotency. Then:

```py
assert core.delete_run({"runId": run_id}) == {"runId": run_id, "deleted": True}
assert database.scalar("SELECT COUNT(*) FROM documents WHERE id=?", (document_id,)) == 0
assert database.scalar("SELECT COUNT(*) FROM runs WHERE id=?", (run_id,)) == 0
assert database.scalar("SELECT COUNT(*) FROM generation_attempts WHERE run_id=?", (run_id,)) == 0
assert database.scalar("SELECT COUNT(*) FROM candidates WHERE run_id=?", (run_id,)) == 0
assert database.scalar("SELECT COUNT(*) FROM candidate_reviews WHERE candidate_id=?", (candidate_id,)) == 0
assert database.scalar("SELECT COUNT(*) FROM knowledge_points WHERE id=?", (knowledge_point_id,)) == 0
assert database.scalar("SELECT COUNT(*) FROM knowledge_point_evidence WHERE knowledge_point_id=?", (knowledge_point_id,)) == 0
assert database.scalar("SELECT COUNT(*) FROM run_events WHERE run_id=?", (run_id,)) == 0
assert database.scalar(
    "SELECT COUNT(*) FROM idempotency_records WHERE scope='candidate_review' AND idempotency_key=?",
    (idempotency_key,),
) == 0
```

Also assert another run and its idempotency record remain untouched. Cover invalid/extra params and a fault injected after review deletion to prove the full graph rolls back.

- [ ] **Step 2: Run Core deletion tests and verify failure**

Run: `python3.12 -m pytest -q python/tests/test_run_delete.py python/tests/test_domain_contract.py python/tests/test_rpc.py`

Expected: FAIL because `runs.delete` is absent.

- [ ] **Step 3: Implement exact idempotency cleanup and graph deletion**

Register `"runs.delete": "delete_run"`. Add repository helper:

```py
def delete_run_graph(con: sqlite3.Connection, run_id: str) -> None:
    run = require_run(con, run_id)
    candidate_ids = {row["id"] for row in con.execute(
        "SELECT id FROM candidates WHERE run_id=?", (run_id,))}
    for row in con.execute(
        "SELECT idempotency_key,result_json FROM idempotency_records WHERE scope='candidate_review'"
    ):
        result = json.loads(row["result_json"])
        candidate = result.get("candidate") if isinstance(result, dict) else None
        if isinstance(candidate, dict) and candidate.get("candidateId") in candidate_ids:
            con.execute(
                "DELETE FROM idempotency_records WHERE scope='candidate_review' AND idempotency_key=?",
                (row["idempotency_key"],),
            )
    con.execute(
        "DELETE FROM candidate_reviews WHERE candidate_id IN (SELECT id FROM candidates WHERE run_id=?)",
        (run_id,),
    )
    changed = con.execute("DELETE FROM documents WHERE id=?", (run["document_id"],)).rowcount
    if changed != 1:
        raise CoreProblem("TRANSACTION_FAILED", "run document was not deleted")
```

Service validates exact `{ runId }`, runs the helper inside `_transactional_write`, and returns the closed result. Do not restrict Core by UI status because the Host must delete a just-terminated active run through the same command.

- [ ] **Step 4: Update protocol coverage and run tests**

Run: `python3.12 -m pytest -q python/tests/test_run_delete.py python/tests/test_domain_contract.py python/tests/test_rpc.py`

Expected: PASS.

- [ ] **Step 5: Commit Core deletion**

```bash
git add python/nobei_core/constants.py python/nobei_core/repository.py python/nobei_core/service.py python/tests/test_run_delete.py python/tests/test_domain_contract.py python/tests/test_rpc.py
git commit -m "feat: delete BetterLearn run graphs"
```

### Task 5: Terminate provider flight and expose DELETE

**Files:**
- Modify: `src/product/types.ts`
- Modify: `src/product/core-rpc-client.ts`
- Modify: `src/product/generation-coordinator.ts`
- Modify: `src/product/plugin.ts`
- Modify: `src/product/routes.ts`
- Modify: `src/client/types.ts`
- Modify: `src/client/client-api.ts`
- Modify: `test/product-core-rpc-client.test.ts`
- Modify: `test/generation-coordinator.test.ts`
- Modify: `test/product-plugin.test.ts`
- Modify: `test/product-routes.test.ts`
- Modify: `test/client-api.test.ts`

**Interfaces:**
- Consumes: `runs.delete` from Task 4.
- Produces:

```ts
GenerationCoordinator.terminateRun(runId: string): Promise<void>
ProductOperations.deleteRun(runId: string, signal?: AbortSignal): Promise<{ runId: string; deleted: true }>
ClientApi.deleteRun(runId: string, signal?: AbortSignal): Promise<RunDeleteResult>
```

- [ ] **Step 1: Write failing coordinator tests**

Launch a deferred fake generation, call `terminateRun(runId)`, and assert:

```ts
expect(handle.cancel).toHaveBeenCalledOnce()
expect(handle.dispose).toHaveBeenCalledOnce()
expect(core.submitGeneration).not.toHaveBeenCalled()
expect(core.failGeneration).not.toHaveBeenCalled()
expect(coordinator.getProgress(runId)).toBeNull()
```

Resolve/reject the provider after termination and assert no finalize occurs. Add a test where settle has begun: `terminateRun` waits `flight.done` and does not double-dispose.

- [ ] **Step 2: Write failing DELETE transport tests**

Assert Core client sends `runs.delete`. Assert browser DELETE has no body or JSON requirement, preserves mutation origin authorization, validates the job id, and returns 200. Assert the plugin operation calls `coordinator.terminateRun(runId)` before `client.deleteRun({ runId })`.

- [ ] **Step 3: Run Host tests and verify failure**

Run: `corepack pnpm@11.23.0 vitest run test/generation-coordinator.test.ts test/product-core-rpc-client.test.ts test/product-plugin.test.ts test/product-routes.test.ts test/client-api.test.ts`

Expected: FAIL because terminate/delete interfaces are absent.

- [ ] **Step 4: Implement `terminateRun`**

If no flight exists, return immediately. If a flight is already terminal, await its `done`. Otherwise synchronously set `terminal=true`, clear its timer, abort its controller, call `handle.cancel()`, await `flight.cleanup()`, delete it from `#flights`, resolve `done`, and emit a run change. Because `#settle` exits immediately for terminal flights, later provider completion cannot submit or fail the run.

Factor a private final cleanup helper if needed so `#settle`, `terminateRun`, and `dispose` retain exactly-once cleanup.

- [ ] **Step 5: Implement Core/Host/browser DELETE path**

Add `FixedCoreRpcClient.deleteRun({ runId })`. The plugin operation must:

```ts
deleteRun: async (runId, signal) => {
  await coordinator.terminateRun(runId)
  return supervisor.withReadyClient(client => client.deleteRun({ runId }, signal))
}
```

Match `DELETE /nobei/v1/runs/:runId`. Treat DELETE like GET for body parsing: reject a request body but do not require `content-type`. Add client helper:

```ts
function del<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'DELETE' }, signal)
}
```

- [ ] **Step 6: Run Host/API tests**

Run: `corepack pnpm@11.23.0 vitest run test/generation-coordinator.test.ts test/product-core-rpc-client.test.ts test/product-plugin.test.ts test/product-routes.test.ts test/client-api.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit termination and DELETE API**

```bash
git add src/product/types.ts src/product/core-rpc-client.ts src/product/generation-coordinator.ts src/product/plugin.ts src/product/routes.ts src/client/types.ts src/client/client-api.ts test/generation-coordinator.test.ts test/product-core-rpc-client.test.ts test/product-plugin.test.ts test/product-routes.test.ts test/client-api.test.ts
git commit -m "feat: terminate and delete extraction runs"
```

### Task 6: History delete and processing terminate UI

**Files:**
- Modify: `src/client/components/HistorySidebar.tsx`
- Modify: `src/client/components/RunProgress.tsx`
- Modify: `src/client/use-nobei-workspace.ts`
- Modify: `src/client/NobeiClientView.tsx`
- Modify: `src/client/styles.ts`
- Modify: `test/client-history-sidebar.test.tsx`
- Modify: `test/client-run-progress.test.tsx`
- Modify: `test/client-workspace-lifecycle.test.tsx`
- Modify: `test/client-view.test.tsx`

**Interfaces:**
- Consumes: `ClientApi.deleteRun` from Task 5.
- Produces: `deleteRun(runId): Promise<boolean>` workspace method; history `onDelete`; progress `onTerminateDelete`.

- [ ] **Step 1: Write failing history UI tests**

Assert terminal and review-pending items expose a delete button, active items do not, and the item is no longer one nested button. First click enters an inline confirmation with material name; cancel restores the row; confirm calls `onDelete(runId)` once and displays busy state.

- [ ] **Step 2: Write failing progress and lifecycle tests**

Assert processing view renders `terminate-delete`, requires confirmation, and calls its callback. In workspace tests:

- deleting a non-current run calls API and refreshes history without changing current state;
- deleting the current run calls API, aborts polling/SSE, clears sessionStorage, and returns to import;
- terminate/delete follows the same cleanup only after API success;
- API failure leaves the run selected and returns `false`.

- [ ] **Step 3: Run UI tests and verify failure**

Run: `corepack pnpm@11.23.0 vitest run test/client-history-sidebar.test.tsx test/client-run-progress.test.tsx test/client-workspace-lifecycle.test.tsx test/client-view.test.tsx`

Expected: FAIL because callbacks and controls do not exist.

- [ ] **Step 4: Implement workspace deletion lifecycle**

Add a dedicated deleting id/state inside `useNobeiWorkspace`. `deleteRun(targetRunId)` awaits `api.deleteRun`. If it matches `currentRunId`, call the same owned-request abort/cleanup used by `reset`, clear persisted session state, and reset all run-specific React state. Do not clear anything on failure.

`NobeiClientView` owns `historyReload`, so pass this wrapper to the history component and processing screen:

```ts
async function deleteAndRefresh(runId: string): Promise<boolean> {
  const deleted = await workspace.deleteRun(runId)
  if (deleted) setHistoryReload(value => value + 1)
  return deleted
}
```

Expose the workspace method to `NobeiClientView`; pass `deleteAndRefresh` to history and bind the processing action to `workspace.currentRunId`.

- [ ] **Step 5: Implement confirmed controls**

History rows become a wrapper containing a primary selection button and a separate destructive button. `deletableStatus()` returns true only for the four approved statuses. Use local `confirmingRunId` and await `onDelete` before clearing confirmation.

`RunProgress` renders “终止并删除” only for active processing states and uses a local two-step confirmation region with “确认终止并删除” and “取消”. Do not use `window.confirm`, so the behavior remains testable and styled consistently.

- [ ] **Step 6: Add destructive styles and run tests**

Use `--nobei-rejected` for destructive text/borders, keep action buttons compact, and ensure the history select button still fills the row without nesting buttons.

Run: `corepack pnpm@11.23.0 vitest run test/client-history-sidebar.test.tsx test/client-run-progress.test.tsx test/client-workspace-lifecycle.test.tsx test/client-view.test.tsx test/client-styles.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit deletion UI**

```bash
git add src/client/components/HistorySidebar.tsx src/client/components/RunProgress.tsx src/client/use-nobei-workspace.ts src/client/NobeiClientView.tsx src/client/styles.ts test/client-history-sidebar.test.tsx test/client-run-progress.test.tsx test/client-workspace-lifecycle.test.tsx test/client-view.test.tsx test/client-styles.test.ts
git commit -m "feat: manage extraction history records"
```

### Task 7: Full verification, zero-cost acceptance, and docs

**Files:**
- Modify: `scripts/accept-phase1d-client.mjs`
- Modify: `test/accept-phase1d-client.test.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/data-model.md`

**Interfaces:**
- Consumes: all prior tasks and the resize acceptance fields from the companion plan.
- Produces: acceptance fields `knowledgePointEdited`, `editProviderCalls`, `deletedFixtureGone`, `deleteProviderCalls`; installed package ready for user inspection.

- [ ] **Step 1: Extend acceptance contract tests**

Accept only results where edit persistence is true, the dedicated disposable fixture disappears from global history, and both edit/delete provider call counters are zero. Do not delete any pre-existing user task.

- [ ] **Step 2: Update zero-cost browser acceptance**

Before browser launch, create a disposable completed run directly through a temporary copied SQLite fixture or Core test setup, not a model call. In the browser:

1. open that result from history;
2. edit one knowledge point and save;
3. reload/reopen and verify the new text;
4. delete the disposable run and confirm it disappears;
5. verify the user's original history count/content remains;
6. record provider calls as zero.

Use fake-provider automated coverage for active terminate/delete; do not start a paid real extraction.

- [ ] **Step 3: Update docs**

Document result-card editing, accepted-to-edited counter behavior, deletion cascades, active terminate/delete, and the absence of recycle bin/version history. Update the data model text to note mutable formal knowledge points while original candidates remain immutable.

- [ ] **Step 4: Run the complete verification suite**

Run:

```bash
corepack pnpm@11.23.0 vitest run
python3.12 -m pytest -q python/tests
corepack pnpm@11.23.0 build
git diff --check
```

Expected: all TypeScript tests pass, all Python tests pass, builds succeed, and diff check is clean.

- [ ] **Step 5: Commit acceptance and docs**

```bash
git add scripts/accept-phase1d-client.mjs test/accept-phase1d-client.test.ts README.md docs/architecture.md docs/data-model.md
git commit -m "test: accept editable BetterLearn history"
```

- [ ] **Step 6: Package, back up, upgrade, and start the installed product**

Run the repository's existing package/upgrade workflow:

```bash
corepack pnpm@11.23.0 pack:acceptance
betterlearn_package=$(ls -t dist/*.tgz | head -n 1)
node bin/betterlearn.mjs upgrade --home /Users/guyue/.betterlearn --package "$betterlearn_package"
node bin/betterlearn.mjs start --home /Users/guyue/.betterlearn --port 3000
```

Resolve the exact tarball name with `ls -t dist/*.tgz | head -n 1` before invoking upgrade. Record the backup path printed by upgrade. Verify `http://127.0.0.1:3000/nobei/v1/runs` with same-origin headers, then run the zero-cost browser acceptance and leave the service running for user inspection.
