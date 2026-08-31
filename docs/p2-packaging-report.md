# P2 packaging report

## Product schema packaging

- Removed the legacy v8 staging script and both v8 migration directories:
  `scripts/stage-v8-migrations.mjs`, `vendor/schema-v8/`, and
  `python/nobei_core/sql/v8/`.
- Removed `stage:v8` from the package scripts. `pretest` builds before Vitest;
  `prepack` builds before creating a tarball.
- The package SQL glob now carries `python/nobei_core/sql/001_product.sql`.
  The product-schema asset test and the package verifier reject remaining
  `phase1_schema.sql`, v8 source/staged directories, or a tarball that omits
  `001_product.sql`.

## Retired historical verifier

`scripts/verify-phase1b-core.mjs` and its test no longer reconstruct the sealed
Phase 1B evidence bundle, provider-boundary observations, or v8 manifest. They
now make one narrow claim: a generated package contains the single product SQL
migration and no legacy schema paths. No fake-provider ledger, spike, or
Phase 1E verifier was changed.

## Default-path audit

- `pnpm test` and `pnpm pack` no longer stage v8 migrations.
- `test/python-core.test.ts`, `test/verify-phase1c-host.test.ts`,
  `scripts/verify-phase1c-host.mjs`, `scripts/accept-phase1c-host.mjs`, and
  `scripts/accept-phase1d-client.mjs` contain no v8 SQL or `phase1_schema.sql`
  assumption.
- The real fake-provider acceptance path packages the product through
  `accept-phase1c-host.mjs`; its existing fake-provider-ledger endpoint is a
  runtime acceptance diagnostic and has no schema-asset dependency.
- `README.md` still has a historical sentence describing `vendor/schema-v8/`.
  It does not participate in build, test, packing, or acceptance and should be
  updated with the P2 documentation sweep.

## Verification

- `pnpm exec vitest run test/v8-migration-assets.test.ts test/verify-phase1b-core.test.ts test/package.test.ts` — 7 tests passed.
- `pnpm build` — passed.
- `node scripts/verify-phase1b-core.mjs` — emitted
  `{"schema":"001_product.sql","packageEntries":111}`.
- `pnpm test` — 56 test files and 582 tests passed.
