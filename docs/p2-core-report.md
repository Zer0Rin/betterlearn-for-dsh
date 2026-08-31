# P2 Core implementation report

Date: 2026-08-31. No provider/model calls; no commits.

## Implemented

- Product bootstrap now defaults to `sql/001_product.sql`; exactly the eleven product tables from `docs/data-model.md`. Removed embedded v8 migrations and the temporary Phase 1 schema. No automatic migration or deletion. Existing non-product schemas raise `DATABASE_UNAVAILABLE` with guidance to back up and choose an empty data directory.
- `documents.canonical_text` owns normalized Unicode text, its UTF-8 byte count, Python-character count, and SHA-256. Evidence offsets remain absolute Python-character positions in the document.
- `runs` owns state, revision, strategy, contract identity, statistics and errors. Added `valid_candidate_count`, `edited_candidate_count`, and `rejected_candidate_count` to the DDL draft; existing `accepted_candidate_count` counts all accepted points. Submission initializes valid count once; each review increments its counters once. Snapshot pending/accepted/KP counts are arithmetic over a single runs row, without candidate aggregate scans. Removed import-job projection, placeholder courses, one-chunk-per-document storage, and foreign-domain guards.
- Immutable `candidates` retain model proposals. `candidate_reviews` records one accept/edit/reject decision and optional edited text. Candidate snapshots derive revision 1/2 and review status; knowledge point snapshots expose final text. Formal evidence copies the stored exact document positions.
- Review idempotency compares the request digest and returns the originally stored result before reading current candidate/run state. All review effects, event append, formal point/evidence, and idempotency insert share a transaction.
- Retained exact evidence locator, two-transaction submission, revision/attempt checks, bounded retry, model selection snapshots, stable request digests, ordered event append, and startup interruption recovery.
- Reads use current product rows, small model metadata, and transaction-maintained counters. They do not select raw provider output, parse candidate JSON again, relocate evidence, reconstruct confirmation history, or replay the event ledger. The explicit offline `evidence_replay` utility remains available with product-schema queries.
- `CoreLease` is unchanged. Storage filename remains `phase1.db` for host compatibility. `Phase1Database.open(root, token)` is the preferred API; legacy positional schema-path arguments are still accepted for callers, without v8 behavior.
- Public RPC parameter shapes and Run/Candidate/KnowledgePoint snapshots remain unchanged. The existing `system.hello` identity is retained for protocol compatibility.

## Verification

- Manual temporary-directory smoke: Unicode import (`你好🙂 world`), prepared fake selection, exact candidate submission, edit-and-accept, unchanged original candidate row, formal knowledge point with matching evidence, and identical idempotent replay all passed.
- `PYTHONPATH=python .venv-phase1b/bin/pytest -q python/tests/test_phase1c_protocol.py python/tests/test_contract.py python/tests/test_evidence.py python/tests/test_rpc.py`: **95 passed in 2.05s**.
- `PYTHONPATH=python .venv-phase1b/bin/pytest -q python/tests`: **305 passed in 4.20s**, with independently adapted tests. Additional test additions/final rerun are recorded by the test owner.

P3/PDF/chunk planning is not included in this P2 change. No historical real-model results are claimed as fresh qualification.

- Final post-counter-change suite: `PYTHONPATH=python .venv-phase1b/bin/pytest -q python/tests` **307 passed in 4.17s**.

## Review boundary correction

The reviewer reproduced a valid 65,536-byte document whose full review response exceeded the former 65,536-byte idempotency record limit. Raised both the Python byte cap and SQL character cap to 524,288, allowing full document/candidate/knowledge-point snapshots and JSON escaping without trimming replay results. The source document and RPC shapes/limits remain unchanged.

Focused regressions cover maximum-size documents using ordinary text and escaped tabs, all three review actions, maximum edited title/statement lengths, preserved absolute evidence, exact stored-result replay, and absence of duplicate review/KP/event writes. `PYTHONPATH=python .venv-phase1b/bin/pytest -q python/tests/test_max_document_review.py python/tests/test_candidate_review.py`: **46 passed in 0.27s**.
