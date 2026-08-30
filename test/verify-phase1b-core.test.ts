import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import {
  REQUIRED_CORE_PYTHON_ASSETS,
  assertAllowedGitStatus,
  assertCanonicalPathsOutsideFormal,
  assertGitCommitProvenance,
  assertPackedModuleProvenance,
  buildPackedPythonEnvironment,
  publishEvidenceAtomically,
  runCommand,
  terminateChildProcess,
  validateEvidenceTree,
  verifyPackagedStaticAssets,
} from '../scripts/verify-phase1b-core.mjs'
import * as phase1bVerifier from '../scripts/verify-phase1b-core.mjs'

const roots: string[] = []
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: new URL('../..', import.meta.url), encoding: 'utf8',
}).trim()

function processExists(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForProcessesToExit(pids: number[], timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (pids.some(processExists) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  return pids.map(processExists)
}

async function fakeEvidenceTree({ legacyPass = false }: { legacyPass?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nobei-phase1b-fake-evidence-'))
  roots.push(root)
  const schemaSha256 = digest('canonical-schema')
  const tarballSha256 = digest('packed-tarball')
  const formalDataDirectory = '/formal/nobei-data'
  const providerAuditStdout = '{"providerCapability":"ABSENT","auditedFiles":13}\n'
  const vitestStdout = ' Test Files  19 passed (19)\n Tests  158 passed (158)\n'
  const pytestStdout = '431 passed in 5.73s\n'
  const transactionFaultStdout = '20 passed in 0.50s\n'
  const pathIsolationStdout = '20 passed in 0.40s\n'
  const entries = [
    'package/contracts/l1-candidate.schema.json',
    'package/python/requirements-phase1.txt',
    'package/python/requirements-phase1.lock',
    'package/python/nobei_core/sql/phase1_schema.sql',
    'package/python/nobei_core/sql/v8/manifest.json',
    ...REQUIRED_CORE_PYTHON_ASSETS,
    ...[
      '001_init.sql',
      '002_stage_layer.sql',
      '003_kp_source_denorm.sql',
      '004_document_file.sql',
      '005_qi_generator.sql',
      '006_review_idempotency.sql',
      '007_book_library.sql',
      '008_book_usage_cleanup.sql',
    ].map((name) => `package/python/nobei_core/sql/v8/${name}`),
  ].sort()
  const manifest = {
    version: 1,
    gitCommit: currentCommit,
    artifact: { name: 'nobei-dsh-phase1-0.0.0.tgz', sha256: tarballSha256 },
    runtime: { nodeVersion: 'v24.14.1', pythonVersion: '3.12.13' },
    schema: { version: 1, sha256: schemaSha256, databaseVersion: 8, phase1Version: 1 },
    operationalPaths: ['/tmp/nobei-phase1b-owned-a', '/tmp/nobei-phase1b-packed-a'],
    observations: {
      providerBoundary: {
        capability: 'ABSENT', auditedFiles: 13,
        stdoutSha256: digest(providerAuditStdout),
      },
      transactionFaults: {
        passedTests: 20, stdoutSha256: digest(transactionFaultStdout),
      },
      pathIsolation: {
        passedTests: 20, stdoutSha256: digest(pathIsolationStdout),
        formalDataSource: 'explicit',
        formalDataDirectorySha256: digest(formalDataDirectory),
        checkedOperationalPaths: 2,
      },
    },
    results: {
      stageV8: 'PASS', vitest: 'PASS', pytest: 'PASS', packageInspection: 'PASS',
      coreLifecycle: 'PASS', rpcContract: 'PASS', secretScan: 'PASS',
    },
  }
  const finalResult = {
    version: 1,
    decision: 'PHASE1B_CORE_GO',
    providerCapability: 'ABSENT',
    schemaVersion: 1,
    schemaSha256,
    databaseSchemaVersion: 8,
    phase1SchemaVersion: 1,
    coreLifecycle: 'PASS',
    transactionFaults: {
      passedTests: 20, stdoutSha256: digest(transactionFaultStdout),
    },
    rpcContract: 'PASS',
    secretScan: 'PASS',
  }
  const packageInspection = {
    version: 1,
    tarballSha256,
    schemaSha256,
    entries,
    corePythonFiles: [...REQUIRED_CORE_PYTHON_ASSETS],
    migrationNames: [
      '001_init.sql', '002_stage_layer.sql', '003_kp_source_denorm.sql',
      '004_document_file.sql', '005_qi_generator.sql', '006_review_idempotency.sql',
      '007_book_library.sql', '008_book_usage_cleanup.sql',
    ],
    staticAssetSha256: {
      'python/requirements-phase1.txt': digest('requirements'),
      'python/requirements-phase1.lock': digest('lock'),
      'python/nobei_core/sql/phase1_schema.sql': digest('phase1-schema'),
      'python/nobei_core/sql/v8/manifest.json': digest('v8-manifest'),
    },
    moduleFiles: REQUIRED_CORE_PYTHON_ASSETS.map((entry) => entry.slice('package/python/'.length)),
    provenanceSha256: digest('provenance\n'),
    tarListSha256: digest('tar-list\n'),
  }
  const lifecycle = {
    version: 1,
    source: 'packed-tarball',
    secondCoreConflict: 'CORE_INSTANCE_CONFLICT',
    forcedKill: 'SIGKILL',
    recoveredStatus: 'failed_retryable',
    restartSnapshotsEqual: true,
    residualProcessCount: 0,
  }
  const fixtureText = 'fixture'
  const rpcTranscript = {
    version: 1,
    source: 'packed-tarball',
    fixtureSha256: digest(fixtureText),
    requestCount: 17,
    reviewActions: ['accept', 'edited_and_accept', 'reject'],
    snapshots: {
      run: {
        runId: 'job_0123456789abcdefabcd',
        documentId: 'doc_0123456789abcdefabcd',
        status: 'completed',
        stage: 'done',
        revision: 7,
        retryCount: 0,
        lastEventSeq: 10,
        counts: {
          rawCandidates: 3, validCandidates: 3, pending: 0, accepted: 1,
          editedAndAccepted: 1, rejected: 1, knowledgePoints: 2,
        },
        error: null,
        document: {
          filename: 'fixture.md', mediaType: 'text/markdown', byteSize: 7,
          characterCount: 7, text: fixtureText,
        },
        modelSelection: { provider: 'phase1b-verifier', model: 'deterministic-fixture' },
      },
      events: {
        events: [
          ['run.created', 'source'], ['document.ready', 'parse'], ['generation.awaiting', 'extract'],
          ['generation.started', 'extract'], ['generation.validating', 'verify'],
          ['candidates.ready', 'confirm'], ['candidate.accepted', 'confirm'],
          ['candidate.edited_and_accepted', 'confirm'], ['candidate.rejected', 'confirm'],
          ['run.completed', 'done'],
        ].map(([type, stage], index) => ({
          seq: index + 1, type, stage,
          payload: [
            { runId: 'job_0123456789abcdefabcd' },
            { documentId: 'doc_0123456789abcdefabcd' },
            { retryCount: 0 },
            { attemptId: 'att_0123456789abcdefabcd', attemptNumber: 1 },
            { attemptId: 'att_0123456789abcdefabcd' },
            { rawCandidateCount: 3, validCandidateCount: 3 },
            { candidateId: 'cand_0123456789abcdefabcd' },
            { candidateId: 'cand_1123456789abcdefabcd' },
            { candidateId: 'cand_2123456789abcdefabcd' },
            { reason: 'reviewed_all' },
          ][index],
        })),
        nextAfter: 10,
      },
      candidates: {
        candidates: [
          ['accepted', 'kp_0123456789abcdefabcd'],
          ['edited_and_accepted', 'kp_1123456789abcdefabcd'],
          ['rejected', null],
        ].map(([reviewStatus, knowledgePointId], index) => ({
          candidateId: `cand_${index}123456789abcdefabcd`, type: index === 0 ? 'concept' : index === 1 ? 'process' : 'fact',
          title: `title-${index}`, statement: `statement-${index}`, reviewStatus, revision: 2,
          knowledgePointId,
          evidence: [{ seq: 0, quote: fixtureText, textStart: 0, textEnd: 7, contextBefore: '', contextAfter: '' }],
        })),
      },
      knowledgePoints: {
        knowledgePoints: [0, 1].map((index) => ({
          knowledgePointId: `kp_${index}123456789abcdefabcd`, type: index === 0 ? 'concept' : 'process',
          title: `title-${index}`, statement: `statement-${index}`,
          documentId: 'doc_0123456789abcdefabcd',
          evidence: [{ seq: 0, quote: fixtureText, textStart: 0, textEnd: 7, contextBefore: '', contextAfter: '' }],
        })),
      },
    },
    restartSnapshotsEqual: true,
  }
  const python = '[REDACTED_PATH]/.venv-phase1b/bin/python'
  const owned = '/tmp/nobei-phase1b-owned-a'
  const recovery = '/tmp/nobei-phase1b-owned-b'
  const coreArgv = (root: string) => [python, '-m', 'nobei_core.main', '--data-root', root, '--ownership-token', '[REDACTED_OWNERSHIP_TOKEN]']
  const commands = [
    ['git-status-preflight', ['git', 'status', '--porcelain=v1', '--untracked-files=all']],
    ['git-commit-preflight', ['git', 'rev-parse', 'HEAD']],
    ['stage-v8', ['node', 'scripts/stage-v8-migrations.mjs']],
    ['build', ['corepack', 'pnpm@11.23.0', 'build']],
    ['vitest', ['corepack', 'pnpm@11.23.0', 'vitest', 'run']],
    ['pytest', ['node', 'scripts/run-phase1b-python.mjs']],
    ['provider-boundary-audit', ['node', 'scripts/audit-phase1b-provider-boundary.mjs']],
    ['pytest-transaction-faults', ['node', 'scripts/run-phase1b-python.mjs', 'python/tests/test_fault_injection.py']],
    ['pytest-path-isolation', ['node', 'scripts/run-phase1b-python.mjs', 'python/tests/test_ownership.py']],
    ['python-version', [python, '-c', 'import platform; print(platform.python_version())']],
    ['pack', ['corepack', 'pnpm@11.23.0', 'pack', '--pack-destination', '/tmp/pack']],
    ['tar-list', ['tar', '-tzf', '/tmp/package.tgz']],
    ['tar-extract', ['tar', '-xzf', '/tmp/package.tgz', '-C', '/tmp/extract']],
    ['provenance-probe', [python, '-c', 'import nobei_core; print(nobei_core.__file__)']],
    ['initialize-transcript-root', [python, '-c', 'from nobei_core.ownership import initialize_owned_root', owned, '[REDACTED_OWNERSHIP_TOKEN]']],
    ['second-core-conflict', coreArgv(owned)],
    ['core-transcript', coreArgv(owned)],
    ['core-restart', coreArgv(owned)],
    ['initialize-recovery-root', [python, '-c', 'from nobei_core.ownership import initialize_owned_root', recovery, '[REDACTED_OWNERSHIP_TOKEN]']],
    ['core-kill-victim', coreArgv(recovery)],
    ['core-recovery', coreArgv(recovery)],
    ['core-recovery-restart', coreArgv(recovery)],
    ['lsof-owned-root', ['/usr/sbin/lsof', '-nP', '+D', owned]],
    ['lsof-owned-root', ['/usr/sbin/lsof', '-nP', '+D', recovery]],
    ['schema-version-probe', [python, '-c', 'from nobei_core.database import Phase1Database', owned, '[REDACTED_OWNERSHIP_TOKEN]', '/tmp/nobei_core']],
  ].map(([slug, argv], index) => {
    const exitStatus = slug === 'second-core-conflict' ? 73 : slug === 'core-kill-victim' ? null
      : slug === 'lsof-owned-root' ? 1 : 0
    const signal = slug === 'core-kill-victim' ? 'SIGKILL' : null
    const stdout = slug === 'git-commit-preflight' ? `${currentCommit}\n`
      : slug === 'vitest' ? vitestStdout
        : slug === 'pytest' ? pytestStdout
      : slug === 'provider-boundary-audit' ? providerAuditStdout
        : slug === 'pytest-transaction-faults' ? transactionFaultStdout
          : slug === 'pytest-path-isolation' ? pathIsolationStdout
            : slug === 'tar-list' ? 'tar-list\n' : slug === 'provenance-probe' ? 'provenance\n' : ''
    return {
      version: 1, index: index + 1, slug, argv, exitStatus, signal, timedOut: false,
      stableCode: slug === 'core-kill-victim' ? 'EXPECTED_SIGKILL' : 'OK',
      stdoutSha256: digest(stdout), stdoutBytes: Buffer.byteLength(stdout), stderr: '',
    }
  })
  const testResults = { version: 1, vitestStdout, pytestStdout }
  if (!legacyPass) {
    const gateClaims = {
      vitest: { passedTests: 158, stdoutSha256: digest(vitestStdout) },
      pytest: { passedTests: 431, stdoutSha256: digest(pytestStdout) },
      coreLifecycle: {
        eventCount: 5,
        transcriptSha256: digest(`${JSON.stringify(lifecycle)}\n`),
      },
      rpcContract: {
        requestCount: rpcTranscript.requestCount,
        transcriptSha256: digest(`${JSON.stringify(rpcTranscript)}\n`),
      },
      secretScan: { findingCount: 0, scanSha256: digest('') },
    }
    Object.assign(manifest.results, gateClaims)
    Object.assign(finalResult, gateClaims)
  }
  await Promise.all([
    writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`),
    writeFile(join(root, 'final-result.json'), `${JSON.stringify(finalResult)}\n`),
    writeFile(join(root, 'package-inspection.json'), `${JSON.stringify(packageInspection)}\n`),
    writeFile(join(root, 'lifecycle.json'), `${JSON.stringify(lifecycle)}\n`),
    writeFile(join(root, 'rpc-transcript.json'), `${JSON.stringify(rpcTranscript)}\n`),
    writeFile(join(root, 'test-results.json'), `${JSON.stringify(testResults)}\n`),
    writeFile(join(root, 'commands.ndjson'), `${commands.map((row) => JSON.stringify(row)).join('\n')}\n`),
    writeFile(join(root, 'secret-scan.txt'), ''),
  ])
  return {
    root, formalDataDirectory, manifest, finalResult, packageInspection, lifecycle,
    rpcTranscript, testResults, commands,
  }
}

async function overwrite(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value)}\n`)
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Phase 1B evidence verifier', () => {
  test('accepts the locator replay module as a packaged Core asset', () => {
    expect(REQUIRED_CORE_PYTHON_ASSETS)
      .toContain('package/python/nobei_core/evidence_replay.py')
  })

  test('derives the formal data directory from the main git common directory, not the worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nobei-phase1b-git-common-'))
    roots.push(root)
    const mainRoot = join(root, 'main')
    const gitCommonDirectory = join(mainRoot, '.git')
    const formalDataDirectory = join(mainRoot, 'nobei-backend-2', 'data')
    await mkdir(gitCommonDirectory, { recursive: true })
    await mkdir(formalDataDirectory, { recursive: true })

    const resolver = (phase1bVerifier as Record<string, unknown>).resolveFormalDataDirectory
    expect(resolver).toBeTypeOf('function')
    await expect((resolver as (input: object) => Promise<object>)({ gitCommonDirectory }))
      .resolves.toMatchObject({
        path: await realpath(formalDataDirectory),
        source: 'git-common-dir',
        exists: true,
      })
  })

  test('refuses a missing formal data directory instead of silently guarding a hypothetical path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nobei-phase1b-missing-formal-'))
    roots.push(root)
    const gitCommonDirectory = join(root, 'main', '.git')
    await mkdir(gitCommonDirectory, { recursive: true })

    const resolver = (phase1bVerifier as Record<string, unknown>).resolveFormalDataDirectory
    expect(resolver).toBeTypeOf('function')
    await expect((resolver as (input: object) => Promise<object>)({ gitCommonDirectory }))
      .rejects.toThrow('FORMAL_DATA_DIRECTORY_INVALID')
  })

  test('derives gate claims from command observations rather than PASS literals', () => {
    const derive = (phase1bVerifier as Record<string, unknown>).deriveVerificationObservations
    expect(derive).toBeTypeOf('function')
    const provider = '{"providerCapability":"ABSENT","auditedFiles":13}\n'
    const observations = (derive as (input: object) => object)({
      providerAuditStdout: provider,
      providerAuditSha256: digest(provider),
      transactionFaultStdout: '20 passed in 0.50s\n',
      transactionFaultSha256: digest('20 passed in 0.50s\n'),
      pathIsolationStdout: '25 passed in 0.40s\n',
      pathIsolationSha256: digest('25 passed in 0.40s\n'),
      formalDataDirectory: '/formal/nobei-data',
      operationalPathCount: 7,
    })
    expect(observations).toMatchObject({
      providerBoundary: { capability: 'ABSENT', auditedFiles: 13 },
      transactionFaults: { passedTests: 20 },
      pathIsolation: { passedTests: 25, checkedOperationalPaths: 7 },
    })
  })

  test('provider-boundary audit reports absent capability after source and environment inspection', () => {
    const audit = spawnSync(process.execPath, ['scripts/audit-phase1b-provider-boundary.mjs'], {
      cwd: new URL('..', import.meta.url),
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
      },
      encoding: 'utf8',
    })
    expect(audit.status).toBe(0)
    expect(audit.stderr).toBe('')
    expect(JSON.parse(audit.stdout)).toMatchObject({
      providerCapability: 'ABSENT',
    })
  })

  test('clean-tree preflight permits only the pre-existing untracked build tree', () => {
    expect(assertAllowedGitStatus('?? dsh-phase1/lib/index.js\n')).toBe(true)
    expect(() => assertAllowedGitStatus(' M dsh-phase1/package.json\n')).toThrow('GIT_TREE_DIRTY')
    expect(() => assertAllowedGitStatus('A  staged.txt\n')).toThrow('GIT_TREE_DIRTY')
  })

  test('commit provenance accepts only the implementation HEAD or its exact evidence-only child', () => {
    const implementation = 'a'.repeat(40)
    const evidence = 'b'.repeat(40)
    const files = [
      'commands.ndjson', 'final-result.json', 'lifecycle.json', 'manifest.json',
      'package-inspection.json', 'rpc-transcript.json', 'secret-scan.txt', 'test-results.json',
    ].map((name) => `dsh-phase1/evidence/core/stamp/${name}`)
    expect(assertGitCommitProvenance({
      manifestCommit: implementation, headCommit: implementation,
      parentCommit: null, changedPaths: [], evidenceRelativeRoot: 'dsh-phase1/evidence/core/stamp',
    })).toBe(true)
    expect(assertGitCommitProvenance({
      manifestCommit: implementation, headCommit: evidence,
      parentCommit: implementation, changedPaths: files, evidenceRelativeRoot: 'dsh-phase1/evidence/core/stamp',
    })).toBe(true)
    expect(() => assertGitCommitProvenance({
      manifestCommit: implementation, headCommit: evidence,
      parentCommit: implementation, changedPaths: [...files, 'dsh-phase1/package.json'],
      evidenceRelativeRoot: 'dsh-phase1/evidence/core/stamp',
    })).toThrow('GIT_COMMIT_MISMATCH')
  })

  test('failure cleanup terminates and waits for an in-flight child', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    await terminateChildProcess(child, { termTimeoutMs: 100 })
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  test('accepts one complete, closed fake evidence tree', async () => {
    const fixture = await fakeEvidenceTree()
    await expect(validateEvidenceTree(fixture.root, {
      formalDataDirectory: fixture.formalDataDirectory,
    })).resolves.toMatchObject({ decision: 'PHASE1B_CORE_GO' })
  })

  test('rejects inherited PASS literals for lifecycle RPC tests and secret scan', async () => {
    const fixture = await fakeEvidenceTree({ legacyPass: true })
    await expect(validateEvidenceTree(fixture.root, {
      formalDataDirectory: fixture.formalDataDirectory,
    })).rejects.toThrow(/FINAL_RESULT_INVALID|MANIFEST_INVALID/)
  })

  test('accepts only observation-backed lifecycle RPC test and secret gate claims', async () => {
    const fixture = await fakeEvidenceTree()
    await expect(validateEvidenceTree(fixture.root, {
      formalDataDirectory: fixture.formalDataDirectory,
    })).resolves.toMatchObject({
      coreLifecycle: { eventCount: 5 },
      rpcContract: { requestCount: 17 },
      secretScan: { findingCount: 0 },
      vitest: { passedTests: 158 },
      pytest: { passedTests: 431 },
    })
  })

  test('rejects observation-shaped summaries when the lifecycle transcript changes', async () => {
    const fixture = await fakeEvidenceTree()
    await writeFile(
      join(fixture.root, 'lifecycle.json'),
      `${JSON.stringify(fixture.lifecycle, null, 2)}\n`,
    )
    await expect(validateEvidenceTree(fixture.root, {
      formalDataDirectory: fixture.formalDataDirectory,
    })).rejects.toThrow('EVIDENCE_PROVENANCE_MISMATCH')
  })

  test('rejects observation-shaped summaries when raw test stdout changes', async () => {
    const fixture = await fakeEvidenceTree()
    await overwrite(join(fixture.root, 'test-results.json'), {
      ...fixture.testResults,
      pytestStdout: '430 passed in 5.73s\n',
    })
    await expect(validateEvidenceTree(fixture.root, {
      formalDataDirectory: fixture.formalDataDirectory,
    })).rejects.toThrow('TEST_OBSERVATION_MISMATCH')
  })

  test('rejects GO claims that have no independently recorded observation basis', async () => {
    const fixture = await fakeEvidenceTree()
    delete (fixture.manifest as { observations?: unknown }).observations
    await overwrite(join(fixture.root, 'manifest.json'), fixture.manifest)
    await expect(validateEvidenceTree(fixture.root, {
      formalDataDirectory: fixture.formalDataDirectory,
    })).rejects.toThrow(/MANIFEST_INVALID|VERIFICATION_OBSERVATION_INVALID/)
  })

  test('rejects missing packaged Core assets', async () => {
    const fixture = await fakeEvidenceTree()
    fixture.packageInspection.entries = fixture.packageInspection.entries
      .filter((entry) => entry !== REQUIRED_CORE_PYTHON_ASSETS[0])
    await overwrite(join(fixture.root, 'package-inspection.json'), fixture.packageInspection)
    await expect(validateEvidenceTree(fixture.root, { formalDataDirectory: fixture.formalDataDirectory }))
      .rejects.toThrow('PACKAGE_ASSET_MISSING')
  })

  test('rejects schema digest mismatch', async () => {
    const fixture = await fakeEvidenceTree()
    fixture.packageInspection.schemaSha256 = digest('different-schema')
    await overwrite(join(fixture.root, 'package-inspection.json'), fixture.packageInspection)
    await expect(validateEvidenceTree(fixture.root, { formalDataDirectory: fixture.formalDataDirectory }))
      .rejects.toThrow('SCHEMA_DIGEST_MISMATCH')
  })

  test('rejects Python older than 3.12', async () => {
    const fixture = await fakeEvidenceTree()
    fixture.manifest.runtime.pythonVersion = '3.11.9'
    await overwrite(join(fixture.root, 'manifest.json'), fixture.manifest)
    await expect(validateEvidenceTree(fixture.root, { formalDataDirectory: fixture.formalDataDirectory }))
      .rejects.toThrow('PYTHON_VERSION_INVALID')
  })

  test('rejects a failed pytest command', async () => {
    const fixture = await fakeEvidenceTree()
    const pytest = fixture.commands.find((command) => command.slug === 'pytest')
    if (!pytest) throw new Error('fixture missing pytest')
    pytest.exitStatus = 1
    await writeFile(join(fixture.root, 'commands.ndjson'), `${fixture.commands.map((row) => JSON.stringify(row)).join('\n')}\n`)
    await expect(validateEvidenceTree(fixture.root, { formalDataDirectory: fixture.formalDataDirectory }))
      .rejects.toThrow('PYTEST_FAILED')
  })

  test('rejects a non-empty secret scan', async () => {
    const fixture = await fakeEvidenceTree()
    await writeFile(join(fixture.root, 'secret-scan.txt'), 'credential-like finding\n')
    await expect(validateEvidenceTree(fixture.root, { formalDataDirectory: fixture.formalDataDirectory }))
      .rejects.toThrow('SECRET_SCAN_NOT_EMPTY')
  })

  test('rejects residual child processes', async () => {
    const fixture = await fakeEvidenceTree()
    fixture.lifecycle.residualProcessCount = 1
    await overwrite(join(fixture.root, 'lifecycle.json'), fixture.lifecycle)
    await expect(validateEvidenceTree(fixture.root, { formalDataDirectory: fixture.formalDataDirectory }))
      .rejects.toThrow('RESIDUAL_PROCESS')
  })

  test.each([
    '/formal/nobei-data',
    '/formal/nobei-data/state',
    '/formal/nobei-data/state/phase1.db',
  ])('rejects operational path equal to or below formal data: %s', async (unsafePath) => {
    const fixture = await fakeEvidenceTree()
    fixture.manifest.operationalPaths[0] = unsafePath
    await overwrite(join(fixture.root, 'manifest.json'), fixture.manifest)
    await expect(validateEvidenceTree(fixture.root, { formalDataDirectory: fixture.formalDataDirectory }))
      .rejects.toThrow('FORMAL_DATA_PATH_FORBIDDEN')
  })

  test('rejects symlinked evidence files instead of following them', async () => {
    const fixture = await fakeEvidenceTree()
    const target = `${fixture.root}-outside.json`
    roots.push(target)
    await overwrite(target, fixture.finalResult)
    const { rm, symlink } = await import('node:fs/promises')
    await rm(join(fixture.root, 'final-result.json'))
    await symlink(target, join(fixture.root, 'final-result.json'))
    await expect(validateEvidenceTree(fixture.root, { formalDataDirectory: fixture.formalDataDirectory }))
      .rejects.toThrow('EVIDENCE_FILE_INVALID')
  })

  test('canonical preflight rejects a candidate symlink alias into formal data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nobei-phase1b-path-alias-'))
    roots.push(root)
    const formal = join(root, 'formal')
    const alias = join(root, 'candidate-alias')
    await mkdir(join(formal, 'state'), { recursive: true })
    await symlink(formal, alias)
    await expect(assertCanonicalPathsOutsideFormal([join(alias, 'state')], formal))
      .rejects.toThrow('FORMAL_DATA_PATH_FORBIDDEN')
  })

  test('canonical preflight resolves a symlinked formal directory before comparison', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nobei-phase1b-formal-alias-'))
    roots.push(root)
    const actualFormal = join(root, 'actual-formal')
    const formalAlias = join(root, 'formal-alias')
    await mkdir(join(actualFormal, 'state'), { recursive: true })
    await symlink(actualFormal, formalAlias)
    await expect(assertCanonicalPathsOutsideFormal([actualFormal], formalAlias))
      .rejects.toThrow('FORMAL_DATA_PATH_FORBIDDEN')
    await expect(assertCanonicalPathsOutsideFormal([join(actualFormal, 'state')], formalAlias))
      .rejects.toThrow('FORMAL_DATA_PATH_FORBIDDEN')
  })

  test('canonical rejection performs no filesystem mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nobei-phase1b-no-mutation-'))
    roots.push(root)
    const formal = join(root, 'formal')
    const candidate = join(formal, 'must-not-exist')
    await mkdir(formal)
    await expect(assertCanonicalPathsOutsideFormal([candidate], formal))
      .rejects.toThrow('FORMAL_DATA_PATH_FORBIDDEN')
    await expect(access(candidate)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(formal)).toEqual([])
  })

  test('rejects an extra evidence file', async () => {
    const fixture = await fakeEvidenceTree()
    await writeFile(join(fixture.root, 'unexpected.json'), '{}\n')
    await expect(validateEvidenceTree(fixture.root, { formalDataDirectory: fixture.formalDataDirectory }))
      .rejects.toThrow('EVIDENCE_FILE_SET_INVALID')
  })

  test('rejects an extra failed command', async () => {
    const fixture = await fakeEvidenceTree()
    fixture.commands.push({
      version: 1, index: fixture.commands.length + 1, slug: 'hidden-failure',
      argv: ['false'], exitStatus: 1, signal: null, timedOut: false,
      stableCode: 'HIDDEN_FAILURE', stdoutSha256: digest(''), stdoutBytes: 0, stderr: '',
    })
    await writeFile(join(fixture.root, 'commands.ndjson'), `${fixture.commands.map((row) => JSON.stringify(row)).join('\n')}\n`)
    await expect(validateEvidenceTree(fixture.root, { formalDataDirectory: fixture.formalDataDirectory }))
      .rejects.toThrow('COMMAND_SEQUENCE_INVALID')
  })

  test('rejects a forged vitest argv even when its status is zero', async () => {
    const fixture = await fakeEvidenceTree()
    const vitest = fixture.commands.find((command) => command.slug === 'vitest')
    if (!vitest) throw new Error('fixture missing vitest')
    vitest.argv = ['true']
    await writeFile(join(fixture.root, 'commands.ndjson'), `${fixture.commands.map((row) => JSON.stringify(row)).join('\n')}\n`)
    await expect(validateEvidenceTree(fixture.root, { formalDataDirectory: fixture.formalDataDirectory }))
      .rejects.toThrow('COMMAND_ARGV_INVALID')
  })

  test('rejects an empty lifecycle event transcript', async () => {
    const fixture = await fakeEvidenceTree()
    fixture.rpcTranscript.snapshots.events = { events: [], nextAfter: 0 }
    await overwrite(join(fixture.root, 'rpc-transcript.json'), fixture.rpcTranscript)
    await expect(validateEvidenceTree(fixture.root, { formalDataDirectory: fixture.formalDataDirectory }))
      .rejects.toThrow('RPC_EVENT_SEQUENCE_INVALID')
  })

  test('rejects a forged commit even when the manifest is otherwise closed', async () => {
    const fixture = await fakeEvidenceTree()
    fixture.manifest.gitCommit = 'f'.repeat(40)
    await overwrite(join(fixture.root, 'manifest.json'), fixture.manifest)
    await expect(validateEvidenceTree(fixture.root, { formalDataDirectory: fixture.formalDataDirectory }))
      .rejects.toThrow('GIT_COMMIT_MISMATCH')
  })

  test('independently rejects prohibited response text despite an empty scan file', async () => {
    const fixture = await fakeEvidenceTree()
    Object.assign(fixture.rpcTranscript, { responseText: 'raw private model response' })
    await overwrite(join(fixture.root, 'rpc-transcript.json'), fixture.rpcTranscript)
    await writeFile(join(fixture.root, 'secret-scan.txt'), '')
    await expect(validateEvidenceTree(fixture.root, { formalDataDirectory: fixture.formalDataDirectory }))
      .rejects.toThrow(/SECRET_PATTERN_FOUND|RPC_TRANSCRIPT_INVALID/)
  })

  test.each([
    'package/python/nobei_core/rogue.py',
    'package/python/nobei_core/sql/v8/009_rogue.sql',
  ])('rejects rogue packaged Core asset %s', async (entry) => {
    const fixture = await fakeEvidenceTree()
    fixture.packageInspection.entries.push(entry)
    fixture.packageInspection.entries.sort()
    await overwrite(join(fixture.root, 'package-inspection.json'), fixture.packageInspection)
    await expect(validateEvidenceTree(fixture.root, { formalDataDirectory: fixture.formalDataDirectory }))
      .rejects.toThrow(/PACKAGE_(CORE|MIGRATION)_SET_INVALID/)
  })

  test('bounded command timeout terminates and waits without leaving a child', async () => {
    const records: unknown[] = []
    const recorder = { record: (...args: unknown[]) => { records.push(args) } }
    await expect(runCommand(
      recorder,
      'timeout-probe',
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 50 },
    )).rejects.toThrow('COMMAND_TIMEOUT')
    expect(records).toHaveLength(1)
    expect(JSON.stringify(records[0])).toContain('COMMAND_TIMEOUT')
  })

  test('timeout terminates the wrapper process group including a SIGTERM-resistant grandchild', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'nobei-phase1b-process-tree-'))
    roots.push(root)
    const pidFile = join(root, 'pids.json')
    const wrapper = [
      "const {spawn}=require('node:child_process')",
      "const fs=require('node:fs')",
      "const grandchild=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
      "fs.writeFileSync(process.argv[1],JSON.stringify({wrapper:process.pid,grandchild:grandchild.pid}))",
      'setInterval(()=>{},1000)',
    ].join(';')
    let pids: number[] = []
    try {
      await expect(runCommand(
        { record: () => undefined },
        'timeout-tree-probe',
        [process.execPath, '-e', wrapper, pidFile],
        { timeoutMs: 250, termTimeoutMs: 50 },
      )).rejects.toThrow('COMMAND_TIMEOUT')
      const recorded = JSON.parse(await readFile(pidFile, 'utf8'))
      pids = [recorded.wrapper, recorded.grandchild]
      expect(await waitForProcessesToExit(pids)).toEqual([false, false])
    } finally {
      for (const pid of pids) {
        if (Number.isSafeInteger(pid) && pid > 1 && processExists(pid)) {
          try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
        }
      }
    }
  })

  test('unexpected command exit cleans a lingering grandchild process group', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'nobei-phase1b-error-tree-'))
    roots.push(root)
    const pidFile = join(root, 'pids.json')
    const wrapper = [
      "const {spawn}=require('node:child_process')",
      "const fs=require('node:fs')",
      "const grandchild=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
      "fs.writeFileSync(process.argv[1],JSON.stringify({wrapper:process.pid,grandchild:grandchild.pid}))",
      'setTimeout(()=>process.exit(7),50)',
    ].join(';')
    let pids: number[] = []
    try {
      await expect(runCommand(
        { record: () => undefined },
        'error-tree-probe',
        [process.execPath, '-e', wrapper, pidFile],
        { timeoutMs: 1000, termTimeoutMs: 50 },
      )).rejects.toThrow()
      const recorded = JSON.parse(await readFile(pidFile, 'utf8'))
      pids = [recorded.wrapper, recorded.grandchild]
      expect(await waitForProcessesToExit(pids)).toEqual([false, false])
    } finally {
      for (const pid of pids) {
        if (Number.isSafeInteger(pid) && pid > 1 && processExists(pid)) {
          try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
        }
      }
    }
  })

  test('safe Python path policy defeats a workspace-shadow package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nobei-phase1b-python-shadow-'))
    roots.push(root)
    const packedPython = join(root, 'packed')
    const shadowCwd = join(root, 'shadow')
    await mkdir(join(packedPython, 'nobei_core'), { recursive: true })
    await mkdir(join(shadowCwd, 'nobei_core'), { recursive: true })
    await writeFile(join(packedPython, 'nobei_core', '__init__.py'), 'ORIGIN="packed"\n')
    await writeFile(join(shadowCwd, 'nobei_core', '__init__.py'), 'ORIGIN="workspace"\n')
    const python = process.env.NOBEI_PHASE1_PYTHON ?? '/opt/homebrew/bin/python3.12'
    const env = buildPackedPythonEnvironment({
      baseEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      packagePython: packedPython,
      disposableHome: join(root, 'home'),
    })
    await mkdir(join(root, 'home'))
    const probe = spawnSync(python, ['-c', 'import nobei_core; print(nobei_core.ORIGIN); print(nobei_core.__file__)'], {
      cwd: shadowCwd, env, encoding: 'utf8',
    })
    expect(probe.status).toBe(0)
    expect(probe.stdout.split('\n')[0]).toBe('packed')
    await expect(assertPackedModuleProvenance(
      probe.stdout.split('\n').slice(1).filter(Boolean), packedPython,
    )).resolves.toEqual(['nobei_core/__init__.py'])
  })

  test.each([
    'python/requirements-phase1.txt',
    'python/requirements-phase1.lock',
    'python/nobei_core/sql/phase1_schema.sql',
    'python/nobei_core/sql/v8/manifest.json',
  ])('rejects tampered packaged static asset %s', async (asset) => {
    const root = await mkdtemp(join(tmpdir(), 'nobei-phase1b-static-assets-'))
    roots.push(root)
    const source = join(root, 'source')
    const packed = join(root, 'packed')
    for (const relativePath of [
      'python/requirements-phase1.txt',
      'python/requirements-phase1.lock',
      'python/nobei_core/sql/phase1_schema.sql',
      'python/nobei_core/sql/v8/manifest.json',
    ]) {
      await mkdir(dirname(join(source, relativePath)), { recursive: true })
      await mkdir(dirname(join(packed, relativePath)), { recursive: true })
      await writeFile(join(source, relativePath), `canonical:${relativePath}\n`)
      await writeFile(join(packed, relativePath), `canonical:${relativePath}\n`)
    }
    await writeFile(join(packed, asset), 'tampered\n')
    await expect(verifyPackagedStaticAssets({ extractedPackage: packed, packageRoot: source }))
      .rejects.toThrow('PACKAGE_STATIC_ASSET_DIGEST_MISMATCH')
  })

  test.each(['scan', 'validate', 'cleanup', 'rename'])
  ('atomic publication never exposes GO when %s fails', async (failurePoint) => {
    const fixture = await fakeEvidenceTree()
    const stagingRoot = fixture.root
    const finalRoot = `${fixture.root}-final`
    roots.push(finalRoot)
    await rm(join(stagingRoot, 'manifest.json'))
    await rm(join(stagingRoot, 'final-result.json'))
    const hooks = {
      scan: async () => { if (failurePoint === 'scan') throw new Error('INJECT_SCAN') },
      validate: async () => { if (failurePoint === 'validate') throw new Error('INJECT_VALIDATE') },
      cleanup: async () => { if (failurePoint === 'cleanup') throw new Error('INJECT_CLEANUP') },
      rename: async (left: string, right: string) => {
        if (failurePoint === 'rename') throw new Error('INJECT_RENAME')
        const { rename } = await import('node:fs/promises')
        await rename(left, right)
      },
    }
    await expect(publishEvidenceAtomically({
      stagingRoot,
      finalRoot,
      manifest: fixture.manifest,
      finalResult: fixture.finalResult,
      hooks,
    })).rejects.toThrow(`INJECT_${failurePoint.toUpperCase()}`)
    await expect(access(finalRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
