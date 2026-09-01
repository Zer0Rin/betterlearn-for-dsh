# Real Learning Loop V1 Implementation Plan

**Goal:** Replace the generic in-memory learning preview with Core-backed, source-specific assessments, persisted attempts, mastery, and review scheduling.

**Architecture:** Python Core migrates the existing SQLite database to schema v2, freezes learning-book source snapshots, compiles objective assessments, keeps answer keys private, and grades idempotent attempts. Host exposes strict RPC/HTTP transport. Client loads the learner-safe course asynchronously and renders real progress.

**Reference:** `docs/superpowers/specs/2026-09-01-real-learning-loop-v1-design.md`

---

## Task 1: Schema v2 migration and Core learning service

**Files:**

- Create: `python/nobei_core/sql/002_learning.sql`
- Create: `python/nobei_core/learning.py`
- Modify: `python/nobei_core/database.py`
- Modify: `python/nobei_core/constants.py`
- Modify: `python/nobei_core/service.py`
- Create: `python/tests/test_learning.py`
- Modify: `python/tests/test_database_bootstrap.py`

1. Add failing tests proving a v1 database migrates without losing extraction rows and a fresh database opens at v2.
2. Add failing service tests for course freezing, topic-specific public questions, hidden answer keys, idempotent grading, remediation gating, mastery and due dates.
3. Add the v2 migration and guarded v1→v2 bootstrap.
4. Implement deterministic learning compilation and transactional attempt grading.
5. Run the focused Python tests until green.

## Task 2: Core RPC transport

**Files:**

- Modify: `python/nobei_core/constants.py`
- Modify: `python/nobei_core/rpc.py`
- Modify: `python/tests/test_domain_contract.py`
- Modify: `python/tests/test_rpc.py`

1. Add failing closed-method-table and dispatcher tests for course sync/get and attempt submission.
2. Register the three methods and keep pre-hello behavior unchanged.
3. Run focused RPC tests.

## Task 3: Host API transport

**Files:**

- Modify: `src/product/types.ts`
- Modify: `src/product/core-rpc-client.ts`
- Modify: `src/product/plugin.ts`
- Modify: `src/product/routes.ts`
- Modify: `test/product-core-rpc-client.test.ts`
- Modify: `test/product-plugin.test.ts`
- Modify: `test/product-routes.test.ts`

1. Add failing tests for exact RPC frames and strict HTTP routes.
2. Add learning DTOs and RPC client methods.
3. Add strict parsers, opaque ID validation, HTTP status mapping and route dispatch.
4. Run focused Host tests.

## Task 4: Client course API and domain model

**Files:**

- Modify: `src/client/types.ts`
- Modify: `src/client/client-api.ts`
- Replace preview behavior in: `src/client/learning-preview.ts`
- Modify: `src/client/learning-book-library.ts`
- Modify: `test/client-api.test.ts`
- Modify: `test/client-learning-preview.test.ts`
- Modify: `test/client-learning-book-library.test.ts`

1. Add failing tests for client course/attempt calls and learner-safe DTO mapping.
2. Replace fixed question templates with the Core course contract and view helpers.
3. Keep existing local learning books as the browser navigation index while Core owns course facts.
4. Run focused client-domain tests.

## Task 5: Real learning player and bookshelf progress

**Files:**

- Modify: `src/client/components/LearningSpace.tsx`
- Modify: `src/client/components/LearningLibrary.tsx`
- Modify: `src/client/floating-workbench.tsx`
- Modify: `src/client/styles.ts`
- Modify: `test/client-learning-space.test.tsx`
- Modify: `test/client-learning-library.test.tsx`
- Modify: `test/client-floating-workbench.test.tsx`
- Modify: `test/client-styles.test.ts`

1. Add failing tests for loading a real course, content-specific questions, server grading, remediation/retest and returned progress.
2. Add loading/error/retry states and remove all learner-facing preview claims.
3. Render mastery/due state from the Core snapshot and return updated summaries to the bookshelf.
4. Run focused UI tests.

## Task 6: Verification and real installation

1. Run all TypeScript tests and all Python tests.
2. Run the production build and package tarball.
3. Upgrade the actual BetterLearn DSH installation using its existing upgrade workflow.
4. Restart the actual app on `127.0.0.1:3000`.
5. Use the real existing NIST learning book to answer one main question incorrectly, read remediation, pass the evidence retest, reload, and verify persisted progress.
6. Commit the implementation only after all evidence is green.
