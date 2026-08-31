# P2 Python test migration

The Python tests now target the product tables and unchanged public RPC snapshots. No models or paid providers were called. No remaining tests are skipped or marked xfail.

Preserved coverage includes exact evidence location (overlapping/repeated quotations, Unicode, no fuzzy normalization), evidence performance and frozen-output offline qualification, candidate JSON contract validation, full JSON-RPC framing/handshake/error contracts, process ownership and forced-kill recovery, submission races and malformed output, model-selection snapshots, retry budget, startup recovery, and snapshot read/write consistency.

Product acceptance now explicitly checks:

- Only the eleven product tables exist; unknown databases are refused without dropping their data. Reopen and transaction rollback remain tested.
- TXT and Markdown persist normalized inline document text, byte/code-point counts and digest. Unicode evidence offsets are document-absolute and survive acceptance into knowledge-point evidence.
- Accept, edited acceptance, and reject each leave the original proposal/evidence unchanged and persist an independent review. Public snapshots show final text and derived revision/status.
- Review replay returns the first stored response before candidate/revision/state lookup, including after candidate deletion and reopening. Changed digest and new-key repeated reviews return their respective conflicts. Concurrent reviews write once.
- Review fault injection covers actual calls after point/evidence inserts, review insertion, event append, run update, and idempotency persistence, for every applicable action. All product rows roll back. Public write-boundary injections assert that the injected boundary was actually reached.
- Repeated snapshots fail the test if they revalidate the candidate contract, parse saved raw provider output, relocate evidence, or call event-history readers. Explicit event listing still returns identical events.

Retired tests enforce mechanisms explicitly removed by P2: exact v8 migration bytes/manifests, fixture-course lineage and empty unused v8 tables, import_jobs/chunk projections, mutable candidate review columns, kp_confirm_log, and per-read reconciliation of externally corrupted documents, attempts, evidence, event history and idempotency payloads. Review/snapshot/bootstrap modules were replaced or reduced to product behavior instead of rebuilding these anti-tamper checks. The submission gap anti-tamper matrix was retired; genuine transaction A/B interruption, rollback, stale ownership/revision and recovery tests remain.

Validation command: `PYTHONPATH=python .venv-phase1b/bin/python -m pytest python/tests -q --disable-warnings`.

Final full run after switching every test bootstrap to the product default: **307 passed in 4.35s**. `git diff --check` is clean; the test tree contains no skips or xfails. This report only establishes the Python P2 surface; it does not claim P3/P4 or TypeScript/browser acceptance.
