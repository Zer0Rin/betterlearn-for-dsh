# P2 review

Date: 2026-08-31. Scope: current Python product model and package/schema changes; earlier P1.1 TypeScript workspace changes excluded. Reviewed against delivery-plan.md, data-model.md and the three P2 implementation/test/package reports. No code edits, commits, provider calls or repeat suite runs.

## Closed finding

- **P2 — Valid maximum-size documents cannot be reviewed.** `python/nobei_core/service.py:215` encodes the full review response, including `run.document.text`, but `python/nobei_core/constants.py:143` caps that response at the same 65,536 bytes allowed for source text. `python/nobei_core/sql/001_product.sql:158` also caps stored JSON at 65,536 characters. A valid maximum-size source necessarily exceeds the response cap after its snapshot/evidence overhead is added; JSON escaping can increase it further. All review effects correctly roll back, but the candidate stays pending and the user cannot finish the run. This boundary defect was retained from the prior implementation, not introduced by the schema refactor. Raise both response/storage bounds to accommodate the bounded public response, including escaping, and retain the complete original response for replay.

Standalone reproduction on a fresh temporary owned database: import `"x" * 65530 + "UNIQUE"` (65,536 UTF-8 bytes); prepare a fake model selection; submit one fact with exact quote `UNIQUE`; reject its pending candidate. Observed `REQUEST_TOO_LARGE`, followed by `review_pending`. No real model was invoked.

**Resolved and reviewed:** the Python response byte cap (`constants.py:145`) and SQL stored-JSON character cap (`001_product.sql:158`) are now both 524,288. The complete response is still encoded and persisted unchanged; request/document limits and replay semantics were not relaxed or truncated. This accommodates the current bounded source, candidate/knowledge-point text and evidence, including JSON escaping, and remains below the RPC line bound of 2,097,152 bytes. Inspected `python/tests/test_max_document_review.py`: six cases cover maximum source size with plain or escaped-tab padding across accept/edit/reject, maximum edited text lengths, full document preservation, absolute evidence position, exact stored-result replay, and no duplicate writes. The Core owner reports 46 focused tests passed in 0.27s; this reviewer did not rerun them.

## Reviewed behavior

- Bootstrap installs only the eleven product tables and refuses legacy/unknown schemas without deleting their tables. Product SQL is packaged; default bootstrap no longer stages v8.
- Candidates/evidence are immutable proposals. Separate review rows supply final text and derived public revision/status; formal evidence copies document-absolute positions.
- Review replay consults stored response and digest before current candidate/run state. Review, formal knowledge point/evidence, event, counters and idempotency record share one write transaction.
- Submission retains transactions A/B, current attempt/revision checks and exact evidence location before publication. Interrupted current attempts recover once, with the original one-retry budget and model selection preserved.
- Inspected the final persisted counter change: submission initializes valid count once; each review increments only its action's counters; completion checks one pending candidate before that increment. `run_snapshot_counts` now reads run columns only. Snapshot reads do not revalidate model output, relocate evidence or replay event history. Candidate/knowledge lists join current product rows; event listing remains explicit.
- Inspected reported regression coverage, including rollback boundary hooks, concurrent reviews, replay after reopen, Unicode offsets and read/write serialization. The implementation/test owners' recorded suites were not rerun by this reviewer.

## Gate status

**Code-review gate clean:** the sole reproduced response-size finding is closed, and no other actionable P2 product defects remain in the reviewed Python/package paths. Actual DSH browser acceptance is owned by the parent task and is not claimed here; the overall P2 acceptance gate still depends on that separate result.
