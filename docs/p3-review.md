# P3 bounded functional review

2026-08-31. Reviewed the final P3 extraction contract, Core/Host implementation reports, new extraction planner/PDF decoder, batched submission and evidence merge, Host semantic planner/extraction adapter, preview API wiring, and Client import/long-run retry paths. Scope was normal local-plugin behavior, not retired P2 anti-tamper checks. No production files were edited by this reviewer; no models or paid providers were called.

## Finding and resolution

**P2: a transient long-document preview error stranded the explicit retry UI.** Before the fix, `useDocumentPreview` retained its error until the input or preview function identity changed. `RunProgress` memoized input from the unchanged document text, and its extraction retry remained disabled while the call ceiling was unknown. There was no action to reread the preview; even refreshing the same run did not change those dependencies. This affected a normal failed long-document run after a temporary preview connection error.

The root agent added an explicit read-only “重新读取提取计划” action to import and retry views and a hook retry nonce. The reviewer added one focused regression to `test/client-run-progress.test.tsx`: first preview rejects, extraction stays disabled, explicit preview refresh succeeds with the same input, the four-call ceiling is visible, and no model retry is invoked until the user clicks “重新提取”.

Verification: `pnpm exec vitest run test/client-run-progress.test.tsx` → **4 passed**, 1 test file, 184 ms total (9 ms tests). This is an additive regression; no full-suite repeat was performed. The initial temporary reproduction ran after the root fix had already landed, so it is not presented as pre-fix runtime evidence. It was removed after the permanent regression passed.

## Remaining assessment

No additional concrete functional blocker found in this bounded review. The inspected planner covers all physical blocks and the final tail, Host groups must cover each container contiguously, L3 adds boundary extraction, slices use code points, and Core locates within batch ranges before converting to document-absolute evidence and merging exact duplicates. Batched contract/limit failures precede candidate persistence. PDF errors and explicit call budgets reach the client. These statements reflect code inspection and the referenced implementation tests, not a new full integration run.

Actual DSH/browser/PDF end-to-end acceptance remains the root task's separate evidence. This review does not certify P4 installation, backup/restore, or a real-model quality run.

## Actual DSH follow-up findings

The root's subsequent browser runs found three additional functional issues that the initial static review did not catch. These supersede the earlier bounded assessment; all three were repaired before final P3 browser acceptance.

1. **Restored run A replaced newly imported run B after model-directory refresh.** The initial run-restoration effect also depended on Cordis model-directory references, so a new resolver/store identity restarted polling the captured old run. This reviewer reproduced two failures (with and without a directory store), then split session/storage restoration and unmount cleanup from model loading in `use-nobei-workspace.ts`. Three regressions cover A→reset→B staying current without extra polls and an in-flight retry not being aborted by directory refresh. Lifecycle + view tests: **27 passed**; client typecheck passed.
2. **Supplementary Unicode broke evidence rendering.** Python offsets count code points; the previous client sliced UTF-16 code units. Root changed `splitEvidence` to `Array.from(text)` for bounds and all slices, with a regression for emoji before and inside evidence. Narrow static review confirms prefix/evidence/suffix retain the original text and use the same coordinate convention as Core.
3. **A long candidate list moved controls outside the DSH viewport.** Root bounded the main pane and candidate navigation with their own scroll, adapted review layout to container width, and replaced `scrollIntoView` with source-pane-only `scrollTop` adjustment. Narrow static review confirms evidence navigation no longer scrolls host ancestors; final browser evidence exercises a 23-candidate case.

Final actual DSH evidence inspected: `evidence/p3/2026-08-31T05-26-31-713Z/final-result.json` reports **GO**, zero real-model calls and no page errors. PDF/L1, L2 and L3 produced **2/5/23 knowledge points**, exact evidence and refresh restoration; long cases executed 4/23 calls against ceilings 6/36. Invalid planning failed atomically and an explicit retry was exercised. This is the root's integration run, not a duplicate reviewer run.
