# Final bounded review: local plugin delivery

2026-08-31. Reviewed P4 CLI, packaged maintenance entry, package manifest, installation documentation and lifecycle acceptance script directly, including untracked new files. Also reviewed the final P3 Unicode/scroll fixes; actual P3 findings and fixes are recorded in `docs/p3-review.md`. No new production edits were made in this final review and no real models were called.

## Result

No additional concrete functional blocker found in the reviewed P4 implementation. This is a code review with focused branch checks, not a replacement for the root's actual rc.8 lifecycle acceptance or final affected-suite results.

## Checked behavior

- Installation isolates `DSH_HOME` and the `betterlearn` profile, stages the local package, installs Python dependencies, and creates ownership state only for a new empty data directory. Existing configuration preserves the ownership token. Config is saved before DSH package additions so an ordinary package-install failure can be retried.
- Start passes the persisted environment and profile to DSH. SIGINT/SIGTERM forwarding keeps the wrapper alive until the child exits.
- Upgrade takes the existing Core lease, saves a SQLite backup before dependency/plugin changes, then updates config only after success. Partial dependency/plugin installation after a failure remains the documented limitation; user data is not deleted. Only compatible product-schema upgrades are supported.
- Uninstall removes the product registration under the dedicated profile while retaining database, backups, config and runtime for reinstallation.
- Online backup uses SQLite's backup API, includes committed WAL data, refuses overwrite and keeps the destination outside the owned root. Restore validates only explicit source schema/readability, acquires the actual Core lease, saves the current database before any replacement, then uses SQLite backup to replace the target coherently. There is no added SQL fingerprint or per-read/history scan.
- Tarball includes CLI, Python maintenance module through the Python file glob, product SQL and user installation documentation. rc.8 support is exercised by the root against an actual rc.8 installation, not inferred from peer-version strings.

## Focused evidence

1. A one-off local probe used the real Python3.12 and ownership/bootstrap modules, a minimal product tarball and a fake DSH executable that deliberately failed its first plugin-add command. First install exited **1**; repeating install exited **0**. Ownership token and marker were identical across attempts, and config pointed to the successful retry's staged package. No network dependency installation or real DSH/model calls were used. Temporary probe installation was removed afterward. This verifies installer retry control flow, not DSH compatibility.
2. `pnpm exec vitest run test/lifecycle-cli.test.ts -t 'SIGTERM'`: **1 passed**, 526 ms test time. The test proves SIGTERM reaches the child, wrapper waits for its exit, and its PID no longer exists. Ten unrelated tests were filtered out by the focused selector, not changed to skip.
3. Narrow static review of P3 `splitEvidence`, source-pane scrolling and bounded navigation agrees with the final actual-browser result recorded in `evidence/p3/2026-08-31T05-26-31-713Z/final-result.json`: PDF/L2/L3 closed loops, 2/5/23 knowledge points, exact evidence, refresh restoration, failed-planning retry and zero page errors.

No full suites were repeated by this review. The root's final P4 acceptance result and broader verification must remain separate, accurately dated evidence. The earlier P3 static review missed issues subsequently found by actual browser use; those findings and fixes are explicitly retained in the P3 report rather than erased.
