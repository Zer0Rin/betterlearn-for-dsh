#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'


const PNPM_VERSION = '11.23.0'
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const MAX_RECORDED_STDERR_BYTES = 4096
const MAX_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const SHA256 = /^[a-f0-9]{64}$/
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, '..')
const EXPECTED_MIGRATIONS = Object.freeze([
  '001_init.sql',
  '002_stage_layer.sql',
  '003_kp_source_denorm.sql',
  '004_document_file.sql',
  '005_qi_generator.sql',
  '006_review_idempotency.sql',
  '007_book_library.sql',
  '008_book_usage_cleanup.sql',
])

export const REQUIRED_CORE_PYTHON_ASSETS = Object.freeze([
  'package/python/nobei_core/__init__.py',
  'package/python/nobei_core/constants.py',
  'package/python/nobei_core/contract.py',
  'package/python/nobei_core/database.py',
  'package/python/nobei_core/errors.py',
  'package/python/nobei_core/evidence.py',
  'package/python/nobei_core/evidence_replay.py',
  'package/python/nobei_core/ids.py',
  'package/python/nobei_core/main.py',
  'package/python/nobei_core/ownership.py',
  'package/python/nobei_core/repository.py',
  'package/python/nobei_core/rpc.py',
  'package/python/nobei_core/service.py',
])

const REQUIRED_PACKAGE_ASSETS = Object.freeze([
  'package/contracts/l1-candidate.schema.json',
  'package/python/requirements-phase1.txt',
  'package/python/requirements-phase1.lock',
  'package/python/nobei_core/sql/phase1_schema.sql',
  'package/python/nobei_core/sql/v8/manifest.json',
  ...REQUIRED_CORE_PYTHON_ASSETS,
  ...EXPECTED_MIGRATIONS.map((name) => `package/python/nobei_core/sql/v8/${name}`),
])

const SUCCESS_KEYS = Object.freeze([
  'version',
  'decision',
  'providerCapability',
  'schemaVersion',
  'schemaSha256',
  'databaseSchemaVersion',
  'phase1SchemaVersion',
  'vitest',
  'pytest',
  'coreLifecycle',
  'transactionFaults',
  'rpcContract',
  'secretScan',
])
const EVIDENCE_FILES = Object.freeze([
  'commands.ndjson',
  'final-result.json',
  'lifecycle.json',
  'manifest.json',
  'package-inspection.json',
  'rpc-transcript.json',
  'secret-scan.txt',
  'test-results.json',
])
const STATIC_PACKAGE_ASSETS = Object.freeze([
  'python/requirements-phase1.txt',
  'python/requirements-phase1.lock',
  'python/nobei_core/sql/phase1_schema.sql',
  'python/nobei_core/sql/v8/manifest.json',
])

function fail(code) {
  throw new Error(code)
}

function exactKeys(value, keys, code) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).toSorted().join('\0') !== [...keys].toSorted().join('\0')
  ) fail(code)
  return value
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeAtomic(path, bytes) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function pathIsEqualOrDescendant(candidate, parent) {
  const child = resolve(candidate)
  const root = resolve(parent)
  const remainder = relative(root, child)
  return remainder === '' || (!remainder.startsWith(`..${sep}`) && remainder !== '..' && !isAbsolute(remainder))
}

export function assertPathOutsideFormalDataDirectory(candidate, formalDataDirectory) {
  if (
    typeof candidate !== 'string'
    || !isAbsolute(candidate)
    || typeof formalDataDirectory !== 'string'
    || !isAbsolute(formalDataDirectory)
  ) fail('EVIDENCE_PATH_INVALID')
  if (pathIsEqualOrDescendant(candidate, formalDataDirectory)) {
    fail('FORMAL_DATA_PATH_FORBIDDEN')
  }
  return true
}

async function canonicalizeProspectivePath(path) {
  let existing = resolve(path)
  const suffix = []
  while (true) {
    try {
      const canonical = await realpath(existing)
      return resolve(canonical, ...suffix.reverse())
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      const parent = resolve(existing, '..')
      if (parent === existing) fail('EVIDENCE_PATH_INVALID')
      suffix.push(basename(existing))
      existing = parent
    }
  }
}

export async function assertCanonicalPathsOutsideFormal(candidates, formalDataDirectory) {
  if (!Array.isArray(candidates) || !candidates.length) fail('EVIDENCE_PATH_INVALID')
  if (typeof formalDataDirectory !== 'string' || !isAbsolute(formalDataDirectory)) {
    fail('FORMAL_DATA_DIRECTORY_INVALID')
  }
  const canonicalFormal = await canonicalizeProspectivePath(formalDataDirectory)
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !isAbsolute(candidate)) fail('EVIDENCE_PATH_INVALID')
    const canonicalCandidate = await canonicalizeProspectivePath(candidate)
    if (pathIsEqualOrDescendant(canonicalCandidate, canonicalFormal)) {
      fail('FORMAL_DATA_PATH_FORBIDDEN')
    }
  }
  return true
}

export async function resolveFormalDataDirectory({
  explicitFormalDataDirectory,
  gitCommonDirectory,
} = {}) {
  let candidate
  let source
  if (explicitFormalDataDirectory !== undefined) {
    if (typeof explicitFormalDataDirectory !== 'string' || !isAbsolute(explicitFormalDataDirectory)) {
      fail('FORMAL_DATA_DIRECTORY_INVALID')
    }
    candidate = explicitFormalDataDirectory
    source = 'explicit'
  } else {
    const common = gitCommonDirectory ?? (await gitRead([
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ])).trim()
    if (typeof common !== 'string' || !isAbsolute(common)) fail('FORMAL_DATA_DIRECTORY_INVALID')
    candidate = resolve(dirname(common), 'nobei-backend-2', 'data')
    source = 'git-common-dir'
  }
  let metadata
  let canonical
  try {
    metadata = await lstat(candidate)
    canonical = await realpath(candidate)
  } catch {
    fail('FORMAL_DATA_DIRECTORY_INVALID')
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('FORMAL_DATA_DIRECTORY_INVALID')
  return {
    path: canonical,
    source,
    exists: true,
    canonicalPathSha256: sha256(Buffer.from(canonical, 'utf8')),
  }
}

function parsePassedTests(output, code) {
  if (typeof output !== 'string') fail(code)
  const matches = [...output.matchAll(/(?:^|\s)(\d+) passed(?:\s|$)/g)]
  if (matches.length !== 1) fail(code)
  const count = Number(matches[0][1])
  if (!Number.isSafeInteger(count) || count < 1) fail(code)
  return count
}

function parseVitestPassedTests(output) {
  if (typeof output !== 'string') fail('VITEST_OBSERVATION_INVALID')
  const matches = [...output.matchAll(/(?:^|\s)Tests\s+(\d+) passed(?:\s|$)/g)]
  if (matches.length !== 1) fail('VITEST_OBSERVATION_INVALID')
  const count = Number(matches[0][1])
  if (!Number.isSafeInteger(count) || count < 1) fail('VITEST_OBSERVATION_INVALID')
  return count
}

function lifecycleEventCount(lifecycle) {
  return [
    lifecycle.secondCoreConflict,
    lifecycle.forcedKill,
    lifecycle.recoveredStatus,
    lifecycle.restartSnapshotsEqual,
    lifecycle.residualProcessCount,
  ].length
}

function deriveRuntimeGateClaims({
  vitestStdout,
  pytestStdout,
  lifecycle,
  lifecycleBytes,
  transcript,
  transcriptBytes,
  secretScanBytes,
}) {
  return {
    vitest: {
      passedTests: parseVitestPassedTests(vitestStdout),
      stdoutSha256: sha256(Buffer.from(vitestStdout, 'utf8')),
    },
    pytest: {
      passedTests: parsePassedTests(pytestStdout, 'PYTEST_OBSERVATION_INVALID'),
      stdoutSha256: sha256(Buffer.from(pytestStdout, 'utf8')),
    },
    coreLifecycle: {
      eventCount: lifecycleEventCount(lifecycle),
      transcriptSha256: sha256(lifecycleBytes),
    },
    rpcContract: {
      requestCount: transcript.requestCount,
      transcriptSha256: sha256(transcriptBytes),
    },
    secretScan: {
      findingCount: secretScanBytes.length === 0
        ? 0
        : secretScanBytes.toString('utf8').split('\n').filter(Boolean).length,
      scanSha256: sha256(secretScanBytes),
    },
  }
}

export function deriveVerificationObservations({
  providerAuditStdout,
  providerAuditSha256,
  transactionFaultStdout,
  transactionFaultSha256,
  pathIsolationStdout,
  pathIsolationSha256,
  formalDataDirectory,
  formalDataSource = 'git-common-dir',
  operationalPathCount,
}) {
  let provider
  try {
    provider = JSON.parse(providerAuditStdout)
  } catch {
    fail('PROVIDER_AUDIT_INVALID')
  }
  exactKeys(
    provider,
    ['providerCapability', 'auditedFiles'],
    'PROVIDER_AUDIT_INVALID',
  )
  if (
    provider.providerCapability !== 'ABSENT'
    || !Number.isSafeInteger(provider.auditedFiles)
    || provider.auditedFiles < 1
    || providerAuditSha256 !== sha256(Buffer.from(providerAuditStdout, 'utf8'))
    || transactionFaultSha256 !== sha256(Buffer.from(transactionFaultStdout, 'utf8'))
    || pathIsolationSha256 !== sha256(Buffer.from(pathIsolationStdout, 'utf8'))
    || typeof formalDataDirectory !== 'string'
    || !isAbsolute(formalDataDirectory)
    || !['git-common-dir', 'explicit'].includes(formalDataSource)
    || !Number.isSafeInteger(operationalPathCount)
    || operationalPathCount < 1
  ) fail('VERIFICATION_OBSERVATION_INVALID')
  return {
    providerBoundary: {
      capability: provider.providerCapability,
      auditedFiles: provider.auditedFiles,
      stdoutSha256: providerAuditSha256,
    },
    transactionFaults: {
      passedTests: parsePassedTests(transactionFaultStdout, 'TRANSACTION_FAULT_OBSERVATION_INVALID'),
      stdoutSha256: transactionFaultSha256,
    },
    pathIsolation: {
      passedTests: parsePassedTests(pathIsolationStdout, 'PATH_ISOLATION_OBSERVATION_INVALID'),
      stdoutSha256: pathIsolationSha256,
      formalDataSource,
      formalDataDirectorySha256: sha256(Buffer.from(formalDataDirectory, 'utf8')),
      checkedOperationalPaths: operationalPathCount,
    },
  }
}

export function buildPackedPythonEnvironment({ baseEnv = {}, packagePython, disposableHome }) {
  if (!isAbsolute(packagePython) || !isAbsolute(disposableHome)) fail('PYTHON_ENVIRONMENT_INVALID')
  return {
    PATH: baseEnv.PATH ?? '/usr/bin:/bin',
    HOME: disposableHome,
    LANG: 'C',
    LC_ALL: 'C',
    PYTHONPATH: packagePython,
    PYTHONSAFEPATH: '1',
    PYTHONNOUSERSITE: '1',
  }
}

export async function assertPackedModuleProvenance(paths, packagePython) {
  if (!Array.isArray(paths) || !paths.length) fail('PACKED_MODULE_PROVENANCE_INVALID')
  const canonicalPackage = await realpath(packagePython)
  const output = []
  for (const path of paths) {
    if (typeof path !== 'string' || !isAbsolute(path)) fail('PACKED_MODULE_PROVENANCE_INVALID')
    const canonical = await realpath(path)
    if (!pathIsEqualOrDescendant(canonical, canonicalPackage)) fail('PACKED_MODULE_PROVENANCE_INVALID')
    output.push(relative(canonicalPackage, canonical).split(sep).join('/'))
  }
  return output.toSorted()
}

export async function verifyPackagedStaticAssets({ extractedPackage, packageRoot }) {
  const digests = {}
  for (const asset of STATIC_PACKAGE_ASSETS) {
    const [packed, source] = await Promise.all([
      readFile(join(extractedPackage, asset)),
      readFile(join(packageRoot, asset)),
    ])
    if (!packed.equals(source)) fail('PACKAGE_STATIC_ASSET_DIGEST_MISMATCH')
    digests[asset] = sha256(packed)
  }
  return digests
}

async function readRegular(root, name, maximum = MAX_EVIDENCE_FILE_BYTES) {
  if (typeof name !== 'string' || isAbsolute(name) || name.includes('..')) {
    fail('EVIDENCE_FILE_INVALID')
  }
  const path = resolve(root, name)
  const remainder = relative(resolve(root), path)
  if (remainder.startsWith('..') || isAbsolute(remainder)) fail('EVIDENCE_FILE_INVALID')
  let metadata
  try {
    metadata = await lstat(path)
  } catch {
    fail('EVIDENCE_FILE_INVALID')
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximum) {
    fail('EVIDENCE_FILE_INVALID')
  }
  return readFile(path)
}

async function readJson(root, name) {
  const bytes = await readRegular(root, name)
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('EVIDENCE_JSON_INVALID')
  }
}

function validateFinalResult(value) {
  exactKeys(value, SUCCESS_KEYS, 'FINAL_RESULT_INVALID')
  exactKeys(value.vitest, ['passedTests', 'stdoutSha256'], 'FINAL_RESULT_INVALID')
  exactKeys(value.pytest, ['passedTests', 'stdoutSha256'], 'FINAL_RESULT_INVALID')
  exactKeys(value.coreLifecycle, ['eventCount', 'transcriptSha256'], 'FINAL_RESULT_INVALID')
  exactKeys(value.transactionFaults, ['passedTests', 'stdoutSha256'], 'FINAL_RESULT_INVALID')
  exactKeys(value.rpcContract, ['requestCount', 'transcriptSha256'], 'FINAL_RESULT_INVALID')
  exactKeys(value.secretScan, ['findingCount', 'scanSha256'], 'FINAL_RESULT_INVALID')
  if (
    value.version !== 1
    || value.decision !== 'PHASE1B_CORE_GO'
    || value.providerCapability !== 'ABSENT'
    || value.schemaVersion !== 1
    || !SHA256.test(value.schemaSha256 ?? '')
    || value.databaseSchemaVersion !== 8
    || value.phase1SchemaVersion !== 1
    || !Number.isSafeInteger(value.vitest.passedTests)
    || value.vitest.passedTests < 1
    || !SHA256.test(value.vitest.stdoutSha256 ?? '')
    || !Number.isSafeInteger(value.pytest.passedTests)
    || value.pytest.passedTests < 1
    || !SHA256.test(value.pytest.stdoutSha256 ?? '')
    || !Number.isSafeInteger(value.coreLifecycle.eventCount)
    || value.coreLifecycle.eventCount < 1
    || !SHA256.test(value.coreLifecycle.transcriptSha256 ?? '')
    || !Number.isSafeInteger(value.transactionFaults.passedTests)
    || value.transactionFaults.passedTests < 1
    || !SHA256.test(value.transactionFaults.stdoutSha256 ?? '')
    || !Number.isSafeInteger(value.rpcContract.requestCount)
    || value.rpcContract.requestCount < 1
    || !SHA256.test(value.rpcContract.transcriptSha256 ?? '')
    || value.secretScan.findingCount !== 0
    || !SHA256.test(value.secretScan.scanSha256 ?? '')
  ) fail('FINAL_RESULT_INVALID')
  return value
}

function validateRuntimeGateClaims(value, code) {
  exactKeys(value.vitest, ['passedTests', 'stdoutSha256'], code)
  exactKeys(value.pytest, ['passedTests', 'stdoutSha256'], code)
  exactKeys(value.coreLifecycle, ['eventCount', 'transcriptSha256'], code)
  exactKeys(value.rpcContract, ['requestCount', 'transcriptSha256'], code)
  exactKeys(value.secretScan, ['findingCount', 'scanSha256'], code)
  if (
    !Number.isSafeInteger(value.vitest.passedTests) || value.vitest.passedTests < 1
    || !SHA256.test(value.vitest.stdoutSha256 ?? '')
    || !Number.isSafeInteger(value.pytest.passedTests) || value.pytest.passedTests < 1
    || !SHA256.test(value.pytest.stdoutSha256 ?? '')
    || !Number.isSafeInteger(value.coreLifecycle.eventCount) || value.coreLifecycle.eventCount < 1
    || !SHA256.test(value.coreLifecycle.transcriptSha256 ?? '')
    || !Number.isSafeInteger(value.rpcContract.requestCount) || value.rpcContract.requestCount < 1
    || !SHA256.test(value.rpcContract.transcriptSha256 ?? '')
    || value.secretScan.findingCount !== 0
    || !SHA256.test(value.secretScan.scanSha256 ?? '')
  ) fail(code)
  return value
}

function validateTestResults(value) {
  exactKeys(value, ['version', 'vitestStdout', 'pytestStdout'], 'TEST_OBSERVATION_INVALID')
  if (
    value.version !== 1
    || typeof value.vitestStdout !== 'string'
    || typeof value.pytestStdout !== 'string'
    || Buffer.byteLength(value.vitestStdout, 'utf8') > MAX_CAPTURE_BYTES
    || Buffer.byteLength(value.pytestStdout, 'utf8') > MAX_CAPTURE_BYTES
  ) fail('TEST_OBSERVATION_INVALID')
  parseVitestPassedTests(value.vitestStdout)
  parsePassedTests(value.pytestStdout, 'PYTEST_OBSERVATION_INVALID')
  return value
}

function validateObservations(value, formalDataDirectory) {
  exactKeys(
    value,
    ['providerBoundary', 'transactionFaults', 'pathIsolation'],
    'VERIFICATION_OBSERVATION_INVALID',
  )
  exactKeys(
    value.providerBoundary,
    ['capability', 'auditedFiles', 'stdoutSha256'],
    'VERIFICATION_OBSERVATION_INVALID',
  )
  exactKeys(
    value.transactionFaults,
    ['passedTests', 'stdoutSha256'],
    'VERIFICATION_OBSERVATION_INVALID',
  )
  exactKeys(
    value.pathIsolation,
    [
      'passedTests', 'stdoutSha256', 'formalDataSource',
      'formalDataDirectorySha256', 'checkedOperationalPaths',
    ],
    'VERIFICATION_OBSERVATION_INVALID',
  )
  if (
    value.providerBoundary.capability !== 'ABSENT'
    || !Number.isSafeInteger(value.providerBoundary.auditedFiles)
    || value.providerBoundary.auditedFiles < 1
    || !SHA256.test(value.providerBoundary.stdoutSha256 ?? '')
    || !Number.isSafeInteger(value.transactionFaults.passedTests)
    || value.transactionFaults.passedTests < 1
    || !SHA256.test(value.transactionFaults.stdoutSha256 ?? '')
    || !Number.isSafeInteger(value.pathIsolation.passedTests)
    || value.pathIsolation.passedTests < 1
    || !SHA256.test(value.pathIsolation.stdoutSha256 ?? '')
    || !['git-common-dir', 'explicit'].includes(value.pathIsolation.formalDataSource)
    || value.pathIsolation.formalDataDirectorySha256
      !== sha256(Buffer.from(formalDataDirectory, 'utf8'))
    || !Number.isSafeInteger(value.pathIsolation.checkedOperationalPaths)
    || value.pathIsolation.checkedOperationalPaths < 1
  ) fail('VERIFICATION_OBSERVATION_INVALID')
  return value
}

function validateManifest(value, formalDataDirectory) {
  exactKeys(
    value,
    [
      'version', 'gitCommit', 'artifact', 'runtime', 'schema',
      'operationalPaths', 'observations', 'results',
    ],
    'MANIFEST_INVALID',
  )
  exactKeys(value.artifact, ['name', 'sha256'], 'MANIFEST_INVALID')
  exactKeys(value.runtime, ['nodeVersion', 'pythonVersion'], 'MANIFEST_INVALID')
  exactKeys(value.schema, ['version', 'sha256', 'databaseVersion', 'phase1Version'], 'MANIFEST_INVALID')
  const observations = validateObservations(value.observations, formalDataDirectory)
  exactKeys(
    value.results,
    [
      'stageV8', 'vitest', 'pytest', 'packageInspection', 'coreLifecycle',
      'rpcContract', 'secretScan',
    ],
    'MANIFEST_INVALID',
  )
  validateRuntimeGateClaims(value.results, 'MANIFEST_INVALID')
  if (
    value.version !== 1
    || !/^[a-f0-9]{40}$/.test(value.gitCommit ?? '')
    || typeof value.artifact.name !== 'string'
    || value.artifact.name.includes('/')
    || !value.artifact.name.endsWith('.tgz')
    || !SHA256.test(value.artifact.sha256 ?? '')
    || !/^v\d+\.\d+\.\d+/.test(value.runtime.nodeVersion ?? '')
    || !/^3\.12\.\d+(?:\s|$)/.test(value.runtime.pythonVersion ?? '')
    || value.schema.version !== 1
    || !SHA256.test(value.schema.sha256 ?? '')
    || value.schema.databaseVersion !== 8
    || value.schema.phase1Version !== 1
    || !Array.isArray(value.operationalPaths)
    || value.operationalPaths.length < 1
    || new Set(value.operationalPaths).size !== value.operationalPaths.length
    || observations.pathIsolation.checkedOperationalPaths !== value.operationalPaths.length
    || value.results.stageV8 !== 'PASS'
    || value.results.packageInspection !== 'PASS'
  ) {
    if (!/^3\.12\.\d+(?:\s|$)/.test(value?.runtime?.pythonVersion ?? '')) {
      fail('PYTHON_VERSION_INVALID')
    }
    fail('MANIFEST_INVALID')
  }
  for (const path of value.operationalPaths) {
    assertPathOutsideFormalDataDirectory(path, formalDataDirectory)
  }
  return value
}

function validatePackageInspection(value) {
  exactKeys(
    value,
    [
      'version', 'tarballSha256', 'schemaSha256', 'entries', 'corePythonFiles',
      'migrationNames', 'staticAssetSha256', 'moduleFiles', 'provenanceSha256', 'tarListSha256',
    ],
    'PACKAGE_INSPECTION_INVALID',
  )
  if (
    value.version !== 1
    || !SHA256.test(value.tarballSha256 ?? '')
    || !SHA256.test(value.schemaSha256 ?? '')
    || !Array.isArray(value.entries)
    || !Array.isArray(value.corePythonFiles)
    || !Array.isArray(value.migrationNames)
    || !Array.isArray(value.moduleFiles)
    || value.moduleFiles.join('\0') !== REQUIRED_CORE_PYTHON_ASSETS
      .map((entry) => entry.slice('package/python/'.length)).join('\0')
    || !SHA256.test(value.provenanceSha256 ?? '')
    || !SHA256.test(value.tarListSha256 ?? '')
    || value.entries.some((entry) => typeof entry !== 'string' || isAbsolute(entry) || entry.split('/').includes('..'))
    || value.entries.join('\0') !== [...value.entries].toSorted().join('\0')
    || new Set(value.entries).size !== value.entries.length
  ) fail('PACKAGE_INSPECTION_INVALID')
  exactKeys(value.staticAssetSha256, STATIC_PACKAGE_ASSETS, 'PACKAGE_INSPECTION_INVALID')
  if (Object.values(value.staticAssetSha256).some((digest) => !SHA256.test(digest ?? ''))) {
    fail('PACKAGE_INSPECTION_INVALID')
  }
  for (const required of REQUIRED_PACKAGE_ASSETS) {
    if (!value.entries.includes(required)) fail('PACKAGE_ASSET_MISSING')
  }
  if (
    value.corePythonFiles.join('\0') !== REQUIRED_CORE_PYTHON_ASSETS.join('\0')
    || value.migrationNames.join('\0') !== EXPECTED_MIGRATIONS.join('\0')
  ) fail('PACKAGE_ASSET_SET_INVALID')
  const packagedCore = value.entries.filter((entry) => (
    entry.startsWith('package/python/nobei_core/')
  ))
  const expectedCoreTree = [
    ...REQUIRED_CORE_PYTHON_ASSETS,
    'package/python/nobei_core/sql/phase1_schema.sql',
    'package/python/nobei_core/sql/v8/manifest.json',
    ...EXPECTED_MIGRATIONS.map((name) => `package/python/nobei_core/sql/v8/${name}`),
  ].toSorted()
  const packagedMigrations = value.entries.filter((entry) => (
    /^package\/python\/nobei_core\/sql\/(?:[^/]+\/)*\d{3}_.+\.sql$/.test(entry)
  ))
  if (packagedCore.join('\0') !== expectedCoreTree.join('\0')) {
    fail('PACKAGE_CORE_SET_INVALID')
  }
  if (
    packagedMigrations.join('\0')
    !== EXPECTED_MIGRATIONS.map((name) => `package/python/nobei_core/sql/v8/${name}`).join('\0')
  ) {
    fail('PACKAGE_MIGRATION_SET_INVALID')
  }
  return value
}

function validateLifecycle(value) {
  exactKeys(
    value,
    [
      'version', 'source', 'secondCoreConflict', 'forcedKill', 'recoveredStatus',
      'restartSnapshotsEqual', 'residualProcessCount',
    ],
    'LIFECYCLE_INVALID',
  )
  if (
    value.version !== 1
    || value.source !== 'packed-tarball'
    || value.secondCoreConflict !== 'CORE_INSTANCE_CONFLICT'
    || value.forcedKill !== 'SIGKILL'
    || value.recoveredStatus !== 'failed_retryable'
    || value.restartSnapshotsEqual !== true
  ) fail('LIFECYCLE_INVALID')
  if (value.residualProcessCount !== 0) fail('RESIDUAL_PROCESS')
  return value
}

function validateRpcTranscript(value) {
  exactKeys(
    value,
    [
      'version', 'source', 'fixtureSha256', 'requestCount', 'reviewActions',
      'snapshots', 'restartSnapshotsEqual',
    ],
    'RPC_TRANSCRIPT_INVALID',
  )
  exactKeys(value.snapshots, ['run', 'events', 'candidates', 'knowledgePoints'], 'RPC_TRANSCRIPT_INVALID')
  const run = exactKeys(
    value.snapshots.run,
    [
      'runId', 'documentId', 'status', 'stage', 'revision', 'retryCount',
      'lastEventSeq', 'counts', 'error', 'document', 'modelSelection',
    ],
    'RPC_TRANSCRIPT_INVALID',
  )
  const counts = exactKeys(
    run.counts,
    [
      'rawCandidates', 'validCandidates', 'pending', 'accepted',
      'editedAndAccepted', 'rejected', 'knowledgePoints',
    ],
    'RPC_TRANSCRIPT_INVALID',
  )
  const document = exactKeys(
    run.document,
    ['filename', 'mediaType', 'byteSize', 'characterCount', 'text'],
    'RPC_TRANSCRIPT_INVALID',
  )
  const events = exactKeys(value.snapshots.events, ['events', 'nextAfter'], 'RPC_TRANSCRIPT_INVALID')
  const candidates = exactKeys(value.snapshots.candidates, ['candidates'], 'RPC_TRANSCRIPT_INVALID')
  const knowledgePoints = exactKeys(
    value.snapshots.knowledgePoints, ['knowledgePoints'], 'RPC_TRANSCRIPT_INVALID',
  )
  if (
    value.version !== 1
    || value.source !== 'packed-tarball'
    || !SHA256.test(value.fixtureSha256 ?? '')
    || !Number.isInteger(value.requestCount)
    || value.requestCount !== 17
    || value.reviewActions?.join('\0') !== 'accept\0edited_and_accept\0reject'
    || value.restartSnapshotsEqual !== true
    || run.status !== 'completed'
    || run.stage !== 'done'
    || run.error !== null
    || counts.rawCandidates !== 3
    || counts.validCandidates !== 3
    || counts.pending !== 0
    || counts.accepted !== 1
    || counts.editedAndAccepted !== 1
    || counts.rejected !== 1
    || counts.knowledgePoints !== 2
    || run.modelSelection?.provider !== 'phase1b-verifier'
    || run.modelSelection?.model !== 'deterministic-fixture'
    || 'reasoningEffort' in run.modelSelection
    || typeof document.text !== 'string'
    || document.byteSize !== Buffer.byteLength(document.text, 'utf8')
    || document.characterCount !== [...document.text].length
    || sha256(Buffer.from(document.text, 'utf8')) !== value.fixtureSha256
    || !Array.isArray(events.events)
    || !Number.isInteger(events.nextAfter)
    || !Array.isArray(candidates.candidates)
    || candidates.candidates.length !== 3
    || candidates.candidates.map((candidate) => candidate?.reviewStatus).join('\0')
      !== 'accepted\0edited_and_accepted\0rejected'
    || !Array.isArray(knowledgePoints.knowledgePoints)
    || knowledgePoints.knowledgePoints.length !== 2
  ) fail('RPC_TRANSCRIPT_INVALID')
  const expectedEvents = [
    ['run.created', 'source'], ['document.ready', 'parse'], ['generation.awaiting', 'extract'],
    ['generation.started', 'extract'], ['generation.validating', 'verify'],
    ['candidates.ready', 'confirm'], ['candidate.accepted', 'confirm'],
    ['candidate.edited_and_accepted', 'confirm'], ['candidate.rejected', 'confirm'],
    ['run.completed', 'done'],
  ]
  if (
    events.events.length !== expectedEvents.length
    || events.nextAfter !== 10
    || run.lastEventSeq !== 10
    || run.revision !== 7
  ) fail('RPC_EVENT_SEQUENCE_INVALID')
  for (const [index, event] of events.events.entries()) {
    exactKeys(event, ['seq', 'type', 'stage', 'payload'], 'RPC_TRANSCRIPT_INVALID')
    if (
      event.seq !== index + 1
      || event.type !== expectedEvents[index][0]
      || event.stage !== expectedEvents[index][1]
      || event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)
    ) fail('RPC_EVENT_SEQUENCE_INVALID')
    const payloadKeys = [
      ['runId'], ['documentId'], ['retryCount'], ['attemptId', 'attemptNumber'], ['attemptId'],
      ['rawCandidateCount', 'validCandidateCount'], ['candidateId'], ['candidateId'],
      ['candidateId'], ['reason'],
    ][index]
    exactKeys(event.payload, payloadKeys, 'RPC_TRANSCRIPT_INVALID')
  }
  const evidenceKeys = ['seq', 'quote', 'textStart', 'textEnd', 'contextBefore', 'contextAfter']
  const candidateKeys = [
    'candidateId', 'type', 'title', 'statement', 'reviewStatus', 'revision',
    'knowledgePointId', 'evidence',
  ]
  for (const [index, candidate] of candidates.candidates.entries()) {
    exactKeys(candidate, candidateKeys, 'RPC_TRANSCRIPT_INVALID')
    if (!Array.isArray(candidate.evidence) || candidate.evidence.length !== 1 || candidate.revision !== 2) {
      fail('RPC_TRANSCRIPT_INVALID')
    }
    const evidence = exactKeys(candidate.evidence[0], evidenceKeys, 'RPC_TRANSCRIPT_INVALID')
    if (
      evidence.seq !== 0
      || typeof evidence.quote !== 'string'
      || evidence.quote.length === 0
      || document.text.slice(evidence.textStart, evidence.textEnd) !== evidence.quote
      || typeof evidence.contextBefore !== 'string'
      || typeof evidence.contextAfter !== 'string'
      || (index < 2 && typeof candidate.knowledgePointId !== 'string')
      || (index === 2 && candidate.knowledgePointId !== null)
      || !['concept', 'process', 'fact'].includes(candidate.type)
      || typeof candidate.title !== 'string'
      || typeof candidate.statement !== 'string'
    ) fail('RPC_TRANSCRIPT_INVALID')
  }
  const knowledgeKeys = [
    'knowledgePointId', 'type', 'title', 'statement', 'documentId', 'evidence',
  ]
  for (const [index, knowledgePoint] of knowledgePoints.knowledgePoints.entries()) {
    exactKeys(knowledgePoint, knowledgeKeys, 'RPC_TRANSCRIPT_INVALID')
    if (
      knowledgePoint.knowledgePointId !== candidates.candidates[index].knowledgePointId
      || knowledgePoint.documentId !== run.documentId
      || JSON.stringify(knowledgePoint.evidence) !== JSON.stringify(candidates.candidates[index].evidence)
      || knowledgePoint.type !== candidates.candidates[index].type
      || knowledgePoint.title !== candidates.candidates[index].title
      || knowledgePoint.statement !== candidates.candidates[index].statement
    ) fail('RPC_TRANSCRIPT_INVALID')
  }
  return value
}

const COMMAND_SLUGS = Object.freeze([
  'git-status-preflight', 'git-commit-preflight', 'stage-v8', 'build', 'vitest', 'pytest',
  'provider-boundary-audit', 'pytest-transaction-faults', 'pytest-path-isolation',
  'python-version', 'pack', 'tar-list', 'tar-extract', 'provenance-probe',
  'initialize-transcript-root', 'second-core-conflict', 'core-transcript', 'core-restart',
  'initialize-recovery-root', 'core-kill-victim', 'core-recovery', 'core-recovery-restart',
  'lsof-owned-root', 'lsof-owned-root', 'schema-version-probe',
])

function validateCommandArgv(command) {
  const argv = command.argv
  const pythonCore = argv.length === 7 && argv[1] === '-m' && argv[2] === 'nobei_core.main'
    && argv[3] === '--data-root' && argv[5] === '--ownership-token'
  const rules = {
    'git-status-preflight': () => argv.join('\0') === 'git\0status\0--porcelain=v1\0--untracked-files=all',
    'git-commit-preflight': () => argv.join('\0') === 'git\0rev-parse\0HEAD',
    'stage-v8': () => argv.join('\0') === 'node\0scripts/stage-v8-migrations.mjs',
    build: () => argv.join('\0') === `corepack\0pnpm@${PNPM_VERSION}\0build`,
    vitest: () => argv.join('\0') === `corepack\0pnpm@${PNPM_VERSION}\0vitest\0run`,
    pytest: () => argv.join('\0') === 'node\0scripts/run-phase1b-python.mjs',
    'provider-boundary-audit': () => argv.join('\0')
      === 'node\0scripts/audit-phase1b-provider-boundary.mjs',
    'pytest-transaction-faults': () => argv.join('\0')
      === 'node\0scripts/run-phase1b-python.mjs\0python/tests/test_fault_injection.py',
    'pytest-path-isolation': () => argv.join('\0')
      === 'node\0scripts/run-phase1b-python.mjs\0python/tests/test_ownership.py',
    'python-version': () => argv.length === 3 && argv[1] === '-c' && argv[2] === 'import platform; print(platform.python_version())',
    pack: () => argv.length === 5 && argv[0] === 'corepack' && argv[1] === `pnpm@${PNPM_VERSION}`
      && argv[2] === 'pack' && argv[3] === '--pack-destination',
    'tar-list': () => argv.length === 3 && argv[0] === 'tar' && argv[1] === '-tzf',
    'tar-extract': () => argv.length === 5 && argv[0] === 'tar' && argv[1] === '-xzf' && argv[3] === '-C',
    'provenance-probe': () => argv.length === 3 && argv[1] === '-c' && argv[2].includes('nobei_core'),
    'initialize-transcript-root': () => argv.length === 5 && argv[1] === '-c' && argv[2].includes('initialize_owned_root'),
    'second-core-conflict': () => pythonCore,
    'core-transcript': () => pythonCore,
    'core-restart': () => pythonCore,
    'initialize-recovery-root': () => argv.length === 5 && argv[1] === '-c' && argv[2].includes('initialize_owned_root'),
    'core-kill-victim': () => pythonCore,
    'core-recovery': () => pythonCore,
    'core-recovery-restart': () => pythonCore,
    'lsof-owned-root': () => argv.length === 4 && argv[0] === '/usr/sbin/lsof' && argv[1] === '-nP' && argv[2] === '+D',
    'schema-version-probe': () => argv.length === 6 && argv[1] === '-c' && argv[2].includes('Phase1Database'),
  }
  if (!rules[command.slug]?.()) fail('COMMAND_ARGV_INVALID')
}

async function validateCommands(root) {
  const text = (await readRegular(root, 'commands.ndjson')).toString('utf8')
  if (!text.endsWith('\n')) fail('COMMAND_EVIDENCE_INVALID')
  const lines = text.split('\n').filter(Boolean)
  if (!lines.length) fail('COMMAND_EVIDENCE_INVALID')
  const commands = lines.map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      fail('COMMAND_EVIDENCE_INVALID')
    }
  })
  if (commands.map((command) => command.slug).join('\0') !== COMMAND_SLUGS.join('\0')) {
    fail('COMMAND_SEQUENCE_INVALID')
  }
  for (const [position, command] of commands.entries()) {
    exactKeys(command, [
      'version', 'index', 'slug', 'argv', 'exitStatus', 'signal', 'timedOut',
      'stableCode', 'stdoutSha256', 'stdoutBytes', 'stderr',
    ], 'COMMAND_EVIDENCE_INVALID')
    if (
      command.version !== 1
      || command.index !== position + 1
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(command.slug ?? '')
      || !Array.isArray(command.argv)
      || command.argv.length < 1
      || command.argv.some((argument) => typeof argument !== 'string')
      || !(command.exitStatus === null || Number.isInteger(command.exitStatus))
      || !(command.signal === null || /^SIG[A-Z]+$/.test(command.signal))
      || typeof command.timedOut !== 'boolean'
      || command.timedOut
      || typeof command.stableCode !== 'string'
      || !SHA256.test(command.stdoutSha256 ?? '')
      || !Number.isInteger(command.stdoutBytes)
      || command.stdoutBytes < 0
      || typeof command.stderr !== 'string'
      || Buffer.byteLength(command.stderr, 'utf8') > MAX_RECORDED_STDERR_BYTES
    ) fail('COMMAND_EVIDENCE_INVALID')
    validateCommandArgv(command)
  }
  for (const command of commands) {
    const expectedExit = command.slug === 'second-core-conflict' ? 73
      : command.slug === 'core-kill-victim' ? null
        : command.slug === 'lsof-owned-root' ? 1 : 0
    const expectedSignal = command.slug === 'core-kill-victim' ? 'SIGKILL' : null
    const expectedStableCode = command.slug === 'core-kill-victim' ? 'EXPECTED_SIGKILL' : 'OK'
    if (
      command.exitStatus !== expectedExit
      || command.signal !== expectedSignal
      || command.stableCode !== expectedStableCode
    ) {
      if (command.slug === 'pytest') fail('PYTEST_FAILED')
      fail('COMMAND_RESULT_INVALID')
    }
  }
  return commands
}

function containsProhibitedEvidence(bytes) {
  const text = bytes.toString('utf8')
  return [
    /Bearer\s+/i,
    /(?:DEEPSEEK|OPENAI|ANTHROPIC)[_-]?API[_-]?KEY/i,
    /sk-[a-z0-9_-]{12,}/i,
    /Traceback \(most recent call last\)/,
    /\/Users\/[^/\s]+\//,
    /[A-Z]:\\Users\\[^\\\s]+\\/i,
    /raw[_-]?output/i,
    /response[_-]?text/i,
    /model[_-]?response/i,
  ].some((pattern) => pattern.test(text))
}

export function assertAllowedGitStatus(status) {
  if (typeof status !== 'string') fail('GIT_TREE_DIRTY')
  const rows = status.split('\n').filter(Boolean)
  if (rows.some((row) => !row.startsWith('?? dsh-phase1/lib/'))) fail('GIT_TREE_DIRTY')
  return true
}

export function assertGitCommitProvenance({
  manifestCommit,
  headCommit,
  parentCommit,
  changedPaths,
  evidenceRelativeRoot,
}) {
  if (manifestCommit === headCommit) return true
  const expectedPaths = EVIDENCE_FILES
    .map((name) => `${evidenceRelativeRoot}/${name}`).toSorted()
  if (
    manifestCommit !== parentCommit
    || !Array.isArray(changedPaths)
    || changedPaths.toSorted().join('\0') !== expectedPaths.join('\0')
  ) fail('GIT_COMMIT_MISMATCH')
  return true
}

async function gitRead(args) {
  const child = spawn('git', args, { cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = captureStream(child.stdout, 64 * 1024)
  const stderr = captureStream(child.stderr, 4096)
  const outcome = await new Promise((resolveOutcome, rejectOutcome) => {
    child.once('error', rejectOutcome)
    child.once('close', (code, signal) => resolveOutcome({ code, signal }))
  })
  if (outcome.code !== 0 || outcome.signal !== null || stderr.result() !== '') fail('GIT_COMMIT_INVALID')
  return stdout.result()
}

async function currentGitCommit() {
  const value = (await gitRead(['rev-parse', 'HEAD'])).trim()
  if (!/^[a-f0-9]{40}$/.test(value)) fail('GIT_COMMIT_INVALID')
  return value
}

export async function validateEvidenceTree(evidenceRoot, { formalDataDirectory, expectedGitCommit } = {}) {
  if (typeof evidenceRoot !== 'string' || !isAbsolute(evidenceRoot)) fail('EVIDENCE_ROOT_INVALID')
  if (typeof formalDataDirectory !== 'string' || !isAbsolute(formalDataDirectory)) {
    fail('FORMAL_DATA_DIRECTORY_INVALID')
  }
  const canonicalFormalDataDirectory = await canonicalizeProspectivePath(formalDataDirectory)
  await assertCanonicalPathsOutsideFormal([evidenceRoot], canonicalFormalDataDirectory)
  let rootMetadata
  try {
    rootMetadata = await lstat(evidenceRoot)
  } catch {
    fail('EVIDENCE_ROOT_INVALID')
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) fail('EVIDENCE_ROOT_INVALID')
  const actualFiles = (await readdir(evidenceRoot)).toSorted()
  if (actualFiles.join('\0') !== [...EVIDENCE_FILES].toSorted().join('\0')) {
    fail('EVIDENCE_FILE_SET_INVALID')
  }
  const [
    manifestValue,
    finalValue,
    packageValue,
    lifecycleValue,
    transcriptValue,
    testResultsValue,
    lifecycleBytes,
    transcriptBytes,
    secretScan,
  ] = await Promise.all([
    readJson(evidenceRoot, 'manifest.json'),
    readJson(evidenceRoot, 'final-result.json'),
    readJson(evidenceRoot, 'package-inspection.json'),
    readJson(evidenceRoot, 'lifecycle.json'),
    readJson(evidenceRoot, 'rpc-transcript.json'),
    readJson(evidenceRoot, 'test-results.json'),
    readRegular(evidenceRoot, 'lifecycle.json'),
    readRegular(evidenceRoot, 'rpc-transcript.json'),
    readRegular(evidenceRoot, 'secret-scan.txt'),
  ])
  if (secretScan.length !== 0) fail('SECRET_SCAN_NOT_EMPTY')
  for (const name of EVIDENCE_FILES.filter((name) => name !== 'secret-scan.txt')) {
    if (containsProhibitedEvidence(await readRegular(evidenceRoot, name))) fail('SECRET_PATTERN_FOUND')
  }
  const manifest = validateManifest(manifestValue, canonicalFormalDataDirectory)
  await assertCanonicalPathsOutsideFormal(manifest.operationalPaths, canonicalFormalDataDirectory)
  const finalResult = validateFinalResult(finalValue)
  const packageInspection = validatePackageInspection(packageValue)
  const lifecycle = validateLifecycle(lifecycleValue)
  const transcript = validateRpcTranscript(transcriptValue)
  const testResults = validateTestResults(testResultsValue)
  const commands = await validateCommands(evidenceRoot)
  const headCommit = await currentGitCommit()
  if (expectedGitCommit !== undefined) {
    if (manifest.gitCommit !== expectedGitCommit || headCommit !== expectedGitCommit) {
      fail('GIT_COMMIT_MISMATCH')
    }
  } else if (manifest.gitCommit !== headCommit) {
    const parentCommit = (await gitRead(['rev-parse', 'HEAD^'])).trim()
    const changedPaths = (await gitRead([
      'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD',
    ])).split('\n').filter(Boolean)
    assertGitCommitProvenance({
      manifestCommit: manifest.gitCommit,
      headCommit,
      parentCommit,
      changedPaths,
      evidenceRelativeRoot: relative(REPOSITORY_ROOT, evidenceRoot).split(sep).join('/'),
    })
  }
  if (
    commands[1].stdoutSha256 !== sha256(Buffer.from(`${manifest.gitCommit}\n`))
  ) fail('GIT_COMMIT_MISMATCH')
  const bySlug = (slug) => commands.filter((command) => command.slug === slug)
  const providerAudit = bySlug('provider-boundary-audit')[0]
  const vitestCommand = bySlug('vitest')[0]
  const pytestCommand = bySlug('pytest')[0]
  const transactionFaults = bySlug('pytest-transaction-faults')[0]
  const pathIsolation = bySlug('pytest-path-isolation')[0]
  const tarList = bySlug('tar-list')[0]
  const provenanceProbe = bySlug('provenance-probe')[0]
  const derivedRuntimeClaims = deriveRuntimeGateClaims({
    vitestStdout: testResults.vitestStdout,
    pytestStdout: testResults.pytestStdout,
    lifecycle,
    lifecycleBytes,
    transcript,
    transcriptBytes,
    secretScanBytes: secretScan,
  })
  if (
    tarList.stdoutSha256 !== packageInspection.tarListSha256
    || provenanceProbe.stdoutSha256 !== packageInspection.provenanceSha256
    || providerAudit.stdoutSha256 !== manifest.observations.providerBoundary.stdoutSha256
    || transactionFaults.stdoutSha256 !== manifest.observations.transactionFaults.stdoutSha256
    || pathIsolation.stdoutSha256 !== manifest.observations.pathIsolation.stdoutSha256
    || bySlug('second-core-conflict')[0].exitStatus !== 73
    || bySlug('core-kill-victim')[0].signal !== lifecycle.forcedKill
    || bySlug('lsof-owned-root').length !== 2
    || transcript.restartSnapshotsEqual !== lifecycle.restartSnapshotsEqual
  ) fail('EVIDENCE_PROVENANCE_MISMATCH')
  if (
    vitestCommand.stdoutSha256 !== derivedRuntimeClaims.vitest.stdoutSha256
    || vitestCommand.stdoutBytes !== Buffer.byteLength(testResults.vitestStdout, 'utf8')
    || pytestCommand.stdoutSha256 !== derivedRuntimeClaims.pytest.stdoutSha256
    || pytestCommand.stdoutBytes !== Buffer.byteLength(testResults.pytestStdout, 'utf8')
  ) fail('TEST_OBSERVATION_MISMATCH')
  for (const [name, claim] of Object.entries(derivedRuntimeClaims)) {
    if (
      JSON.stringify(finalResult[name]) !== JSON.stringify(claim)
      || JSON.stringify(manifest.results[name]) !== JSON.stringify(claim)
    ) {
      fail(name === 'vitest' || name === 'pytest'
        ? 'TEST_OBSERVATION_MISMATCH'
        : 'EVIDENCE_PROVENANCE_MISMATCH')
    }
  }
  if (
    manifest.schema.sha256 !== finalResult.schemaSha256
    || manifest.schema.sha256 !== packageInspection.schemaSha256
  ) fail('SCHEMA_DIGEST_MISMATCH')
  if (
    manifest.artifact.sha256 !== packageInspection.tarballSha256
    || finalResult.providerCapability !== manifest.observations.providerBoundary.capability
    || finalResult.transactionFaults.passedTests
      !== manifest.observations.transactionFaults.passedTests
    || finalResult.transactionFaults.stdoutSha256
      !== manifest.observations.transactionFaults.stdoutSha256
  ) fail('ARTIFACT_DIGEST_MISMATCH')
  return finalResult
}

function redactor(values) {
  const exact = [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))]
    .toSorted((left, right) => right.length - left.length)
  return (input) => {
    let result = String(input)
    for (const value of exact) result = result.split(value).join('[REDACTED_PATH]')
    return result
      .replace(/Bearer\s+[^\s"']+/gi, '[REDACTED]')
      .replace(/(?:DEEPSEEK|OPENAI|ANTHROPIC)[_-]?API[_-]?KEY\s*[=:]\s*[^\s"']+/gi, '[REDACTED]')
      .replace(/sk-[a-z0-9_-]{12,}/gi, '[REDACTED]')
      .replace(/phase1b-[a-f0-9]{32}/gi, '[REDACTED_OWNERSHIP_TOKEN]')
  }
}

class CommandRecorder {
  constructor(root, redact) {
    this.root = root
    this.redact = redact
    this.index = 0
  }

  async record(slug, argv, exitStatus, stderr = '', {
    signal = null,
    timedOut = false,
    stableCode = 'OK',
    stdout = '',
    stdoutSha256 = null,
    stdoutBytes = null,
  } = {}) {
    this.index += 1
    const bounded = Buffer.from(this.redact(stderr), 'utf8').subarray(0, MAX_RECORDED_STDERR_BYTES).toString('utf8')
    const row = {
      version: 1,
      index: this.index,
      slug,
      argv: argv.map((argument) => this.redact(argument)),
      exitStatus,
      signal,
      timedOut,
      stableCode,
      stdoutSha256: stdoutSha256 ?? sha256(Buffer.from(stdout, 'utf8')),
      stdoutBytes: stdoutBytes ?? Buffer.byteLength(stdout, 'utf8'),
      stderr: bounded,
    }
    await appendFile(join(this.root, 'commands.ndjson'), `${JSON.stringify(row)}\n`, 'utf8')
  }
}

function captureStream(stream, maximum = MAX_CAPTURE_BYTES) {
  let length = 0
  const chunks = []
  let exceeded = false
  stream.on('data', (chunk) => {
    length += chunk.length
    if (length <= maximum) chunks.push(chunk)
    else exceeded = true
  })
  return {
    result() {
      if (exceeded) fail('COMMAND_OUTPUT_TOO_LARGE')
      return Buffer.concat(chunks).toString('utf8')
    },
  }
}

const POSIX_PROCESS_GROUP_PLATFORMS = new Set([
  'aix', 'darwin', 'freebsd', 'linux', 'netbsd', 'openbsd', 'sunos',
])

function processGroupExists(processGroupId) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    fail('COMMAND_PROCESS_GROUP_INVALID')
  }
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

function signalProcessGroup(processGroupId, signal) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    fail('COMMAND_PROCESS_GROUP_INVALID')
  }
  try {
    process.kill(-processGroupId, signal)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (processGroupExists(processGroupId) && Date.now() < deadline) {
    await delay(10)
  }
  return !processGroupExists(processGroupId)
}

async function terminateCommandProcessGroup(child, closed, processGroupId, {
  termTimeoutMs,
  killTimeoutMs,
}) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1 || child.pid !== processGroupId) {
    fail('COMMAND_PROCESS_GROUP_INVALID')
  }
  const groupSignaled = signalProcessGroup(processGroupId, 'SIGTERM')
  if (!groupSignaled && child.exitCode === null && child.signalCode === null) {
    await terminateChildProcess(child, { termTimeoutMs })
    fail('COMMAND_PROCESS_GROUP_INVALID')
  }
  await delay(termTimeoutMs)
  if (processGroupExists(processGroupId)) signalProcessGroup(processGroupId, 'SIGKILL')
  let timer
  const outcome = await Promise.race([
    closed,
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(null), killTimeoutMs)
    }),
  ])
  clearTimeout(timer)
  if (outcome === null || outcome.spawnError) fail('COMMAND_PROCESS_TREE_CLEANUP_FAILED')
  if (!await waitForProcessGroupExit(processGroupId, killTimeoutMs)) {
    fail('COMMAND_PROCESS_TREE_CLEANUP_FAILED')
  }
  return outcome
}

export async function runCommand(recorder, slug, argv, {
  cwd,
  env,
  expectedExit = 0,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  termTimeoutMs = 1000,
  killTimeoutMs = 2000,
  evidenceStdoutTransform = (value) => value,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) fail('COMMAND_TIMEOUT_INVALID')
  if (!Number.isInteger(termTimeoutMs) || termTimeoutMs < 1) fail('COMMAND_TIMEOUT_INVALID')
  if (!Number.isInteger(killTimeoutMs) || killTimeoutMs < 1) fail('COMMAND_TIMEOUT_INVALID')
  if (typeof evidenceStdoutTransform !== 'function') fail('COMMAND_EVIDENCE_INVALID')
  if (!POSIX_PROCESS_GROUP_PLATFORMS.has(process.platform)) {
    fail('COMMAND_PROCESS_GROUP_UNSUPPORTED')
  }
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = captureStream(child.stdout)
  const stderr = captureStream(child.stderr)
  const closed = new Promise((resolveOutcome) => {
    child.once('error', (spawnError) => resolveOutcome({ code: null, signalName: null, spawnError }))
    child.once('close', (code, signalName) => resolveOutcome({ code, signalName }))
  })
  const spawnState = await Promise.race([
    new Promise((resolveSpawn) => child.once('spawn', () => resolveSpawn({ spawned: true }))),
    closed.then((outcome) => ({ spawned: false, outcome })),
  ])
  if (!spawnState.spawned) {
    await recorder.record(slug, argv, null, stderr.result(), {
      stableCode: 'COMMAND_SPAWN_FAILED',
      stdout: stdout.result(),
    })
    fail('COMMAND_SPAWN_FAILED')
  }
  const processGroupId = child.pid
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    await terminateChildProcess(child, { termTimeoutMs })
    fail('COMMAND_PROCESS_GROUP_INVALID')
  }
  let timer
  const first = await Promise.race([
    closed.then((outcome) => ({ timedOut: false, outcome })),
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout({ timedOut: true }), timeoutMs)
    }),
  ])
  clearTimeout(timer)
  let outcome
  let processTreeLeak = false
  if (first.timedOut) {
    outcome = await terminateCommandProcessGroup(child, closed, processGroupId, {
      termTimeoutMs,
      killTimeoutMs,
    })
  } else {
    outcome = first.outcome
    if (processGroupExists(processGroupId)) {
      processTreeLeak = true
      await terminateCommandProcessGroup(child, closed, processGroupId, {
        termTimeoutMs,
        killTimeoutMs,
      })
    }
  }
  const output = { stdout: stdout.result(), stderr: stderr.result(), ...outcome }
  const stableCode = first.timedOut
    ? 'COMMAND_TIMEOUT'
    : processTreeLeak ? 'COMMAND_PROCESS_TREE_LEAK'
    : outcome.code === expectedExit && outcome.signalName === null ? 'OK' : `${slug.toUpperCase().replaceAll('-', '_')}_FAILED`
  await recorder.record(slug, argv, outcome.code, output.stderr, {
    signal: outcome.signalName,
    timedOut: first.timedOut,
    stableCode,
    stdout: evidenceStdoutTransform(output.stdout),
  })
  if (first.timedOut) fail('COMMAND_TIMEOUT')
  if (processTreeLeak) fail('COMMAND_PROCESS_TREE_LEAK')
  if (outcome.code !== expectedExit || outcome.signalName !== null) {
    fail(stableCode)
  }
  return output
}

export async function terminateChildProcess(child, { termTimeoutMs = 1000 } = {}) {
  if (child === null || typeof child !== 'object' || typeof child.kill !== 'function') {
    fail('CHILD_PROCESS_INVALID')
  }
  if (child.exitCode !== null || child.signalCode !== null) return
  const waitForClose = () => new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose)
    child.once('close', resolveClose)
  })
  let timer
  const closed = waitForClose()
  child.kill('SIGTERM')
  const timedOut = await Promise.race([
    closed.then(() => false),
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(true), termTimeoutMs)
    }),
  ])
  clearTimeout(timer)
  if (timedOut && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await closed
  }
}

function coreArgv(python, dataRoot, ownershipToken) {
  return [
    python,
    '-m',
    'nobei_core.main',
    '--data-root',
    dataRoot,
    '--ownership-token',
    ownershipToken,
  ]
}

class CoreSession {
  constructor({ python, dataRoot, ownershipToken, env, cwd, recorder, slug, activeSessions }) {
    this.argv = coreArgv(python, dataRoot, ownershipToken)
    this.recorder = recorder
    this.slug = slug
    this.activeSessions = activeSessions
    this.recorded = false
    this.child = spawn(this.argv[0], this.argv.slice(1), {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.buffer = Buffer.alloc(0)
    this.frames = []
    this.waiters = []
    this.stderrCapture = captureStream(this.child.stderr, 64 * 1024)
    this.stdoutHash = createHash('sha256')
    this.stdoutBytes = 0
    this.closed = new Promise((resolveClosed, rejectClosed) => {
      this.child.once('error', rejectClosed)
      this.child.once('close', (code, signalName) => resolveClosed({ code, signalName }))
    })
    this.activeSessions?.add(this)
    this.child.stdout.on('data', (chunk) => {
      this.stdoutHash.update(chunk)
      this.stdoutBytes += chunk.length
      this.buffer = Buffer.concat([this.buffer, chunk])
      if (this.buffer.length > MAX_CAPTURE_BYTES) {
        this.child.kill('SIGKILL')
        return
      }
      while (true) {
        const newline = this.buffer.indexOf(0x0a)
        if (newline < 0) break
        const line = this.buffer.subarray(0, newline)
        this.buffer = this.buffer.subarray(newline + 1)
        let frame
        try {
          frame = JSON.parse(line.toString('utf8'))
        } catch {
          frame = new Error('RPC_MALFORMED_RESPONSE')
        }
        const waiter = this.waiters.shift()
        if (waiter) waiter(frame)
        else this.frames.push(frame)
      }
    })
  }

  async request(id, method, params) {
    const frame = { jsonrpc: '2.0', id, method, params }
    const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8')
    if (encoded.length > 2 * 1024 * 1024) fail('RPC_MESSAGE_TOO_LARGE')
    const responsePromise = new Promise((resolveResponse, rejectResponse) => {
      const timeout = setTimeout(() => rejectResponse(new Error('RPC_TIMEOUT')), 10_000)
      const accept = (value) => {
        clearTimeout(timeout)
        if (value instanceof Error) rejectResponse(value)
        else resolveResponse(value)
      }
      if (this.frames.length) accept(this.frames.shift())
      else this.waiters.push(accept)
    })
    await new Promise((resolveWrite, rejectWrite) => {
      this.child.stdin.write(encoded, (error) => error ? rejectWrite(error) : resolveWrite())
    })
    const response = await responsePromise
    if (response?.jsonrpc !== '2.0' || response?.id !== id || (!('result' in response) && !('error' in response))) {
      fail('RPC_MALFORMED_RESPONSE')
    }
    return response
  }

  async result(id, method, params) {
    const response = await this.request(id, method, params)
    if (response.error) fail(response.error?.data?.code ?? 'RPC_COMMAND_FAILED')
    return response.result
  }

  async finish(expectedExit = 0) {
    this.child.stdin.end()
    const outcome = await this.closed
    const stderr = this.stderrCapture.result()
    await this.#record(outcome, stderr)
    if (outcome.code !== expectedExit || outcome.signalName !== null || this.buffer.length !== 0 || stderr !== '') {
      fail('CORE_PROCESS_EXIT_INVALID')
    }
    return outcome
  }

  async forceKill() {
    this.child.kill('SIGKILL')
    const outcome = await this.closed
    const stderr = this.stderrCapture.result()
    await this.#record(outcome, stderr)
    if (outcome.signalName !== 'SIGKILL' || stderr !== '') fail('FORCED_KILL_FAILED')
    return outcome
  }

  async abort() {
    await terminateChildProcess(this.child)
    const outcome = await this.closed
    await this.#record(outcome, this.stderrCapture.result())
  }

  async #record(outcome, stderr) {
    if (!this.recorded) {
      this.recorded = true
      await this.recorder.record(this.slug, this.argv, outcome.code, stderr, {
        signal: outcome.signalName,
        stableCode: outcome.signalName === 'SIGKILL' && this.slug === 'core-kill-victim' ? 'EXPECTED_SIGKILL' : 'OK',
        stdoutSha256: this.stdoutHash.digest('hex'),
        stdoutBytes: this.stdoutBytes,
      })
    }
    this.activeSessions?.delete(this)
  }
}

function assertClosedObject(value, keys, code) {
  return exactKeys(value, keys, code)
}

async function initializePackedRoot({ python, packagePython, root, token, env, cwd, recorder, slug }) {
  await mkdir(root)
  const script = 'import sys; from nobei_core.ownership import initialize_owned_root; initialize_owned_root(sys.argv[1], sys.argv[2])'
  await runCommand(recorder, slug, [python, '-c', script, root, token], {
    cwd,
    env: buildPackedPythonEnvironment({ baseEnv: env, packagePython, disposableHome: env.HOME }),
  })
}

function helloParams(schemaSha256) {
  return { protocolVersion: 3, schemaVersion: 1, schemaSha256 }
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function runCompleteTranscript(context) {
  const {
    python, packagePython, extractedPackage, workRoot, env, recorder, schemaSha256,
  } = context
  const ownedRoot = join(workRoot, 'owned-transcript')
  const token = `phase1b-${randomBytes(16).toString('hex')}`
  await initializePackedRoot({
    python, packagePython, root: ownedRoot, token, env, cwd: workRoot, recorder, slug: 'initialize-transcript-root',
  })
  const coreEnv = buildPackedPythonEnvironment({ baseEnv: env, packagePython, disposableHome: env.HOME })
  const session = new CoreSession({
    python, dataRoot: ownedRoot, ownershipToken: token, env: coreEnv, cwd: workRoot, recorder,
    slug: 'core-transcript', activeSessions: context.activeSessions,
  })
  const hello = await session.result('hello', 'system.hello', helloParams(schemaSha256))
  assertClosedObject(
    hello,
    ['protocolVersion', 'coreVersion', 'databaseKind', 'capabilities', 'schemaVersion', 'schemaSha256', 'dataRootKind'],
    'HELLO_RESULT_INVALID',
  )
  const fixtureBytes = await readFile(join(PACKAGE_ROOT, 'spike', 'fixtures', 'photosynthesis.md'))
  const fixtureText = fixtureBytes.toString('utf8')
  const imported = await session.result('import', 'documents.import_text', {
    filename: 'photosynthesis.md', mediaType: 'text/markdown', text: fixtureText,
  })
  assertClosedObject(imported, ['documentId', 'runId', 'revision'], 'IMPORT_RESULT_INVALID')
  const prepared = await session.result('prepare', 'runs.prepare_generation', {
    runId: imported.runId,
    modelSelection: { provider: 'phase1b-verifier', model: 'deterministic-fixture' },
  })
  assertClosedObject(
    prepared,
    [
      'runId', 'attemptId', 'attemptNumber', 'revision', 'schemaVersion', 'schemaSha256',
      'promptVersion', 'document', 'modelSelection', 'requestDigest', 'providerIdempotencyKey',
    ],
    'PREPARE_RESULT_INVALID',
  )
  const fakeOutput = {
    schemaVersion: 1,
    candidates: [
      {
        type: 'concept', title: '光合作用', statement: '光合作用把光能转化并储存在有机物中。',
        evidence: [{ quote: '光合作用', prefix: '# ', suffix: '\n\n' }],
      },
      {
        type: 'process', title: '能量转化', statement: '绿色植物利用光能形成储能有机物。',
        evidence: [{ quote: '绿色植物利用光能', prefix: '', suffix: '' }],
      },
      {
        type: 'fact', title: '氧气释放', statement: '该过程会释放氧气。',
        evidence: [{ quote: '释放氧气', prefix: '', suffix: '' }],
      },
    ],
  }
  const submitted = await session.result('submit', 'runs.submit_generation', {
    runId: imported.runId,
    attemptId: prepared.attemptId,
    expectedRevision: prepared.revision,
    output: fakeOutput,
  })
  assertClosedObject(submitted, ['run', 'statistics'], 'SUBMIT_RESULT_INVALID')
  const candidateList = await session.result('candidates-before-review', 'candidates.list', { runId: imported.runId })
  assertClosedObject(candidateList, ['candidates'], 'CANDIDATE_LIST_INVALID')
  if (!Array.isArray(candidateList.candidates) || candidateList.candidates.length !== 3) {
    fail('CANDIDATE_LIST_INVALID')
  }
  const [first, second, third] = candidateList.candidates
  const accepted = await session.result('accept', 'candidates.review', {
    candidateId: first.candidateId,
    action: 'accept',
    expectedRevision: first.revision,
    idempotencyKey: `idem_${'a'.repeat(20)}`,
  })
  const edited = await session.result('edited-accept', 'candidates.review', {
    candidateId: second.candidateId,
    action: 'edited_and_accept',
    title: '编辑后的能量转化',
    statement: '绿色植物把光能转化为有机物中的化学能。',
    expectedRevision: second.revision,
    idempotencyKey: `idem_${'b'.repeat(20)}`,
  })
  const rejected = await session.result('reject', 'candidates.review', {
    candidateId: third.candidateId,
    action: 'reject',
    expectedRevision: third.revision,
    idempotencyKey: `idem_${'c'.repeat(20)}`,
  })
  if (
    accepted.candidate.reviewStatus !== 'accepted'
    || edited.candidate.reviewStatus !== 'edited_and_accepted'
    || rejected.candidate.reviewStatus !== 'rejected'
    || rejected.run.status !== 'completed'
  ) fail('REVIEW_LIFECYCLE_INVALID')
  const snapshots = {
    run: await session.result('run-final', 'runs.get', { runId: imported.runId }),
    events: await session.result('events-final', 'runs.list_events', { runId: imported.runId, after: 0 }),
    candidates: await session.result('candidates-final', 'candidates.list', { runId: imported.runId }),
    knowledgePoints: await session.result(
      'knowledge-final', 'knowledge_points.list_for_run', { runId: imported.runId },
    ),
  }
  if (
    snapshots.run.status !== 'completed'
    || snapshots.run.counts.accepted !== 1
    || snapshots.run.counts.editedAndAccepted !== 1
    || snapshots.run.counts.rejected !== 1
    || snapshots.run.counts.knowledgePoints !== 2
  ) fail('FINAL_SNAPSHOT_INVALID')

  const conflictArgv = coreArgv(python, ownedRoot, token)
  const conflict = await runCommand(recorder, 'second-core-conflict', conflictArgv, {
    env: coreEnv,
    cwd: workRoot,
    expectedExit: 73,
  })
  if (conflict.stdout !== '' || conflict.stderr !== 'CORE_INSTANCE_CONFLICT\n') {
    fail('SECOND_CORE_CONFLICT_INVALID')
  }
  await session.finish()

  const restarted = new CoreSession({
    python, dataRoot: ownedRoot, ownershipToken: token, env: coreEnv, cwd: workRoot, recorder,
    slug: 'core-restart', activeSessions: context.activeSessions,
  })
  await restarted.result('restart-hello', 'system.hello', helloParams(schemaSha256))
  const restartedSnapshots = {
    run: await restarted.result('restart-run', 'runs.get', { runId: imported.runId }),
    events: await restarted.result('restart-events', 'runs.list_events', { runId: imported.runId, after: 0 }),
    candidates: await restarted.result('restart-candidates', 'candidates.list', { runId: imported.runId }),
    knowledgePoints: await restarted.result(
      'restart-knowledge', 'knowledge_points.list_for_run', { runId: imported.runId },
    ),
  }
  await restarted.finish()
  if (!deepEqual(snapshots, restartedSnapshots)) fail('RESTART_SNAPSHOT_MISMATCH')
  return {
    ownedRoot,
    ownershipToken: token,
    transcript: {
      version: 1,
      source: 'packed-tarball',
      fixtureSha256: sha256(fixtureBytes),
      requestCount: 17,
      reviewActions: ['accept', 'edited_and_accept', 'reject'],
      snapshots,
      restartSnapshotsEqual: true,
    },
  }
}

async function runForcedKillRecovery(context) {
  const { python, packagePython, workRoot, env, recorder, schemaSha256 } = context
  const ownedRoot = join(workRoot, 'owned-kill-recovery')
  const token = `phase1b-${randomBytes(16).toString('hex')}`
  await initializePackedRoot({
    python, packagePython, root: ownedRoot, token, env, cwd: workRoot, recorder, slug: 'initialize-recovery-root',
  })
  const coreEnv = buildPackedPythonEnvironment({ baseEnv: env, packagePython, disposableHome: env.HOME })
  const victim = new CoreSession({
    python, dataRoot: ownedRoot, ownershipToken: token, env: coreEnv, cwd: workRoot, recorder,
    slug: 'core-kill-victim', activeSessions: context.activeSessions,
  })
  await victim.result('kill-hello', 'system.hello', helloParams(schemaSha256))
  const imported = await victim.result('kill-import', 'documents.import_text', {
    filename: 'recovery.md', mediaType: 'text/markdown', text: '可恢复的中断任务。',
  })
  const prepared = await victim.result('kill-prepare', 'runs.prepare_generation', {
    runId: imported.runId,
    modelSelection: { provider: 'phase1b-verifier', model: 'deterministic-fixture' },
  })
  await victim.forceKill()

  const recovery = new CoreSession({
    python, dataRoot: ownedRoot, ownershipToken: token, env: coreEnv, cwd: workRoot, recorder,
    slug: 'core-recovery', activeSessions: context.activeSessions,
  })
  await recovery.result('recovery-hello', 'system.hello', helloParams(schemaSha256))
  const recovered = await recovery.result('recovery-run', 'runs.get', { runId: imported.runId })
  const events = await recovery.result('recovery-events', 'runs.list_events', { runId: imported.runId, after: 0 })
  await recovery.finish()
  if (
    recovered.status !== 'failed_retryable'
    || recovered.error?.code !== 'GENERATION_PROVIDER_ERROR'
    || events.events.filter((event) => event.type === 'generation.interrupted').length !== 1
    || !JSON.stringify(events).includes(prepared.attemptId)
  ) fail('FORCED_KILL_RECOVERY_INVALID')

  const stable = new CoreSession({
    python, dataRoot: ownedRoot, ownershipToken: token, env: coreEnv, cwd: workRoot, recorder,
    slug: 'core-recovery-restart', activeSessions: context.activeSessions,
  })
  await stable.result('stable-hello', 'system.hello', helloParams(schemaSha256))
  const stableRun = await stable.result('stable-run', 'runs.get', { runId: imported.runId })
  const stableEvents = await stable.result('stable-events', 'runs.list_events', { runId: imported.runId, after: 0 })
  await stable.finish()
  if (!deepEqual(recovered, stableRun) || !deepEqual(events, stableEvents)) {
    fail('RECOVERY_NOT_IDEMPOTENT')
  }
  return { ownedRoot, recovered }
}

async function assertNoProcessRetainsRoots(recorder, roots) {
  for (const root of roots) {
    const argv = ['/usr/sbin/lsof', '-nP', '+D', root]
    const result = await runCommand(recorder, 'lsof-owned-root', argv, { expectedExit: 1 })
    if (result.stdout !== '' || result.stderr !== '') fail('RESIDUAL_PROCESS')
  }
  return 0
}

async function inspectPackage({ recorder, tarball, extractRoot, python, workRoot, env }) {
  const list = await runCommand(recorder, 'tar-list', ['tar', '-tzf', tarball], { cwd: workRoot, env })
  const rawEntries = list.stdout.split('\n').filter(Boolean)
  if (
    rawEntries.length < 1
    || rawEntries.some((entry) => isAbsolute(entry) || entry.split('/').includes('..') || !entry.startsWith('package/'))
  ) fail('PACKAGE_ENTRY_INVALID')
  const entries = rawEntries.filter((entry) => !entry.endsWith('/')).toSorted()
  if (new Set(entries).size !== entries.length) fail('PACKAGE_ENTRY_DUPLICATE')
  for (const required of REQUIRED_PACKAGE_ASSETS) {
    if (!entries.includes(required)) fail('PACKAGE_ASSET_MISSING')
  }
  const packagedCore = entries.filter((entry) => entry.startsWith('package/python/nobei_core/'))
  const expectedCoreTree = [
    ...REQUIRED_CORE_PYTHON_ASSETS,
    'package/python/nobei_core/sql/phase1_schema.sql',
    'package/python/nobei_core/sql/v8/manifest.json',
    ...EXPECTED_MIGRATIONS.map((name) => `package/python/nobei_core/sql/v8/${name}`),
  ].toSorted()
  if (packagedCore.join('\0') !== expectedCoreTree.join('\0')) fail('PACKAGE_CORE_SET_INVALID')
  const migrationEntries = entries.filter((entry) => (
    /^package\/python\/nobei_core\/sql\/(?:[^/]+\/)*\d{3}_.+\.sql$/.test(entry)
  ))
  const expectedMigrationEntries = EXPECTED_MIGRATIONS.map(
    (name) => `package/python/nobei_core/sql/v8/${name}`,
  )
  if (migrationEntries.join('\0') !== expectedMigrationEntries.join('\0')) {
    fail('PACKAGE_MIGRATION_SET_INVALID')
  }
  const migrationNames = migrationEntries.map((entry) => basename(entry))
  if (migrationNames.join('\0') !== EXPECTED_MIGRATIONS.join('\0')) fail('PACKAGE_MIGRATION_SET_INVALID')
  await mkdir(extractRoot)
  await runCommand(recorder, 'tar-extract', ['tar', '-xzf', tarball, '-C', extractRoot], { cwd: workRoot, env })
  const extractedPackage = join(extractRoot, 'package')
  const packagedSchema = await readFile(join(extractedPackage, 'contracts', 'l1-candidate.schema.json'))
  const workspaceSchema = await readFile(join(PACKAGE_ROOT, 'contracts', 'l1-candidate.schema.json'))
  if (!packagedSchema.equals(workspaceSchema)) fail('SCHEMA_DIGEST_MISMATCH')
  for (const asset of REQUIRED_CORE_PYTHON_ASSETS) {
    const relativeAsset = asset.slice('package/'.length)
    const [packed, source] = await Promise.all([
      readFile(join(extractedPackage, relativeAsset)),
      readFile(join(PACKAGE_ROOT, relativeAsset)),
    ])
    if (!packed.equals(source)) fail('PACKAGE_CORE_DIGEST_MISMATCH')
  }
  const staticAssetSha256 = await verifyPackagedStaticAssets({
    extractedPackage,
    packageRoot: PACKAGE_ROOT,
  })
  for (const name of EXPECTED_MIGRATIONS) {
    const [packed, canonicalMigration] = await Promise.all([
      readFile(join(extractedPackage, 'python', 'nobei_core', 'sql', 'v8', name)),
      readFile(join(REPOSITORY_ROOT, 'nobei-backend-2', 'db', 'migrations', name)),
    ])
    if (!packed.equals(canonicalMigration)) fail('PACKAGE_MIGRATION_DIGEST_MISMATCH')
  }
  const packagePython = join(extractedPackage, 'python')
  const moduleNames = REQUIRED_CORE_PYTHON_ASSETS.map((entry) => (
    entry.slice('package/python/'.length, -3).replaceAll('/', '.')
  ))
  const provenanceScript = [
    'import importlib,json',
    `names=${JSON.stringify(moduleNames)}`,
    'print(json.dumps([importlib.import_module(name).__file__ for name in names]))',
  ].join('; ')
  const provenance = await runCommand(recorder, 'provenance-probe', [python, '-c', provenanceScript], {
    cwd: workRoot,
    env: buildPackedPythonEnvironment({ baseEnv: env, packagePython, disposableHome: env.HOME }),
  })
  let modulePaths
  try {
    modulePaths = JSON.parse(provenance.stdout)
  } catch {
    fail('PACKED_MODULE_PROVENANCE_INVALID')
  }
  const moduleFiles = await assertPackedModuleProvenance(modulePaths, packagePython)
  const expectedModuleFiles = REQUIRED_CORE_PYTHON_ASSETS
    .map((entry) => entry.slice('package/python/'.length)).toSorted()
  if (moduleFiles.join('\0') !== expectedModuleFiles.join('\0')) fail('PACKED_MODULE_PROVENANCE_INVALID')
  return {
    extractedPackage,
    value: {
      version: 1,
      tarballSha256: sha256(await readFile(tarball)),
      schemaSha256: sha256(packagedSchema),
      entries,
      corePythonFiles: [...REQUIRED_CORE_PYTHON_ASSETS],
      migrationNames: [...EXPECTED_MIGRATIONS],
      staticAssetSha256,
      moduleFiles,
      provenanceSha256: sha256(Buffer.from(provenance.stdout, 'utf8')),
      tarListSha256: sha256(Buffer.from(list.stdout, 'utf8')),
    },
  }
}

async function textFiles(root) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && !entry.isSymbolicLink()) files.push(path)
      else fail('EVIDENCE_FILE_INVALID')
    }
  }
  await visit(root)
  return files
}

async function scanEvidence(root, additionalValues = []) {
  const patterns = [
    /Bearer\s+/i,
    /(?:DEEPSEEK|OPENAI|ANTHROPIC)[_-]?API[_-]?KEY/i,
    /sk-[a-z0-9_-]{12,}/i,
    /Traceback \(most recent call last\)/,
    /\/Users\/[^/\s]+\//,
    /[A-Z]:\\Users\\[^\\\s]+\\/i,
    /raw[_-]?output/i,
    /response[_-]?text/i,
    /model[_-]?response/i,
  ]
  const findings = []
  for (const path of await textFiles(root)) {
    if (basename(path) === 'secret-scan.txt') continue
    const bytes = await readFile(path)
    if (bytes.length > MAX_EVIDENCE_FILE_BYTES || bytes.includes(0)) fail('EVIDENCE_FILE_INVALID')
    const text = bytes.toString('utf8')
    if (patterns.some((pattern) => pattern.test(text))) findings.push(relative(root, path))
  }
  for (const [name, value] of additionalValues) {
    const text = jsonBytes(value).toString('utf8')
    if (patterns.some((pattern) => pattern.test(text))) findings.push(name)
  }
  await writeFile(join(root, 'secret-scan.txt'), findings.length ? `${findings.join('\n')}\n` : '', 'utf8')
  if (findings.length) fail('SECRET_PATTERN_FOUND')
}

export async function publishEvidenceAtomically({
  stagingRoot,
  finalRoot,
  manifest,
  finalResult,
  expectedGitCommit,
  formalDataDirectory,
  hooks = {},
}) {
  const scan = hooks.scan ?? (() => scanEvidence(stagingRoot))
  const validate = hooks.validate ?? (() => validateEvidenceTree(stagingRoot, {
    formalDataDirectory,
    expectedGitCommit,
  }))
  const cleanup = hooks.cleanup ?? (async () => undefined)
  const renameEvidence = hooks.rename ?? rename
  try {
    await writeAtomic(join(stagingRoot, 'manifest.json'), jsonBytes(manifest))
    await scan()
    await writeAtomic(join(stagingRoot, 'final-result.json'), jsonBytes(finalResult))
    await validate()
    await cleanup()
    await renameEvidence(stagingRoot, finalRoot)
    return finalRoot
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

function successResult(schemaSha256, observations, runtimeGateClaims) {
  if (observations.transactionFaults.passedTests < 1) {
    fail('TRANSACTION_FAULT_OBSERVATION_INVALID')
  }
  return {
    version: 1,
    decision: 'PHASE1B_CORE_GO',
    providerCapability: observations.providerBoundary.capability,
    schemaVersion: 1,
    schemaSha256,
    databaseSchemaVersion: 8,
    phase1SchemaVersion: 1,
    vitest: runtimeGateClaims.vitest,
    pytest: runtimeGateClaims.pytest,
    coreLifecycle: runtimeGateClaims.coreLifecycle,
    transactionFaults: observations.transactionFaults,
    rpcContract: runtimeGateClaims.rpcContract,
    secretScan: runtimeGateClaims.secretScan,
  }
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

export async function runVerification({
  packageRoot = PACKAGE_ROOT,
  formalDataDirectory: explicitFormalDataDirectory,
} = {}) {
  if (resolve(packageRoot) !== PACKAGE_ROOT) fail('PACKAGE_ROOT_INVALID')
  const formalDataGuard = await resolveFormalDataDirectory({
    explicitFormalDataDirectory: explicitFormalDataDirectory
      ?? process.env.NOBEI_FORMAL_DATA_DIRECTORY,
  })
  const formalDataDirectory = formalDataGuard.path
  const stamp = utcStamp()
  const coreEvidenceRoot = join(PACKAGE_ROOT, 'evidence', 'core')
  const evidenceRoot = join(coreEvidenceRoot, stamp)
  const stagingRoot = join(coreEvidenceRoot, `.phase1b-staging-${process.pid}-${randomUUID()}`)
  const prospectiveWorkRoot = join(tmpdir(), 'nobei-phase1b-verify-prospective')
  await assertCanonicalPathsOutsideFormal(
    [PACKAGE_ROOT, coreEvidenceRoot, evidenceRoot, stagingRoot, tmpdir(), prospectiveWorkRoot],
    formalDataDirectory,
  )

  const ignoredRecorder = { record: async () => undefined }
  const preflightEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
  const statusArgv = ['git', 'status', '--porcelain=v1', '--untracked-files=all']
  const commitArgv = ['git', 'rev-parse', 'HEAD']
  const statusProbe = await runCommand(ignoredRecorder, 'git-status-preflight', statusArgv, {
    cwd: REPOSITORY_ROOT, env: preflightEnv,
  })
  assertAllowedGitStatus(statusProbe.stdout)
  const commitProbe = await runCommand(ignoredRecorder, 'git-commit-preflight', commitArgv, {
    cwd: REPOSITORY_ROOT, env: preflightEnv,
  })
  const commit = commitProbe.stdout.trim()
  if (!/^[a-f0-9]{40}$/.test(commit)) fail('GIT_COMMIT_INVALID')

  let workRoot = null
  let recorder = null
  const activeSessions = new Set()
  try {
    await mkdir(coreEvidenceRoot, { recursive: true })
    await mkdir(stagingRoot)
    workRoot = await mkdtemp(join(tmpdir(), 'nobei-phase1b-verify-'))
    const packRoot = join(workRoot, 'pack')
    const extractRoot = join(workRoot, 'extracted')
    const disposableHome = join(workRoot, 'home')
    await assertCanonicalPathsOutsideFormal(
      [workRoot, packRoot, extractRoot, disposableHome], formalDataDirectory,
    )
    await Promise.all([mkdir(packRoot), mkdir(disposableHome)])
    const redact = redactor([PACKAGE_ROOT, REPOSITORY_ROOT, homedir()])
    recorder = new CommandRecorder(stagingRoot, redact)
    await recorder.record('git-status-preflight', statusArgv, 0, statusProbe.stderr, {
      signal: null, stableCode: 'OK', stdout: statusProbe.stdout,
    })
    await recorder.record('git-commit-preflight', commitArgv, 0, commitProbe.stderr, {
      signal: null, stableCode: 'OK', stdout: commitProbe.stdout,
    })
    const operationalPaths = [workRoot, packRoot, extractRoot, disposableHome]
    const cleanEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: disposableHome,
      LANG: 'C',
      LC_ALL: 'C',
    }
    await runCommand(recorder, 'stage-v8', ['node', 'scripts/stage-v8-migrations.mjs'], {
      cwd: PACKAGE_ROOT,
      env: cleanEnv,
    })
    await runCommand(recorder, 'build', ['corepack', `pnpm@${PNPM_VERSION}`, 'build'], {
      cwd: PACKAGE_ROOT,
      env: cleanEnv,
    })
    const vitestProbe = await runCommand(recorder, 'vitest', ['corepack', `pnpm@${PNPM_VERSION}`, 'vitest', 'run'], {
      cwd: PACKAGE_ROOT,
      env: cleanEnv,
      evidenceStdoutTransform: redact,
    })
    const pytestProbe = await runCommand(recorder, 'pytest', ['node', 'scripts/run-phase1b-python.mjs'], {
      cwd: PACKAGE_ROOT,
      env: cleanEnv,
      evidenceStdoutTransform: redact,
    })
    const providerAuditProbe = await runCommand(
      recorder,
      'provider-boundary-audit',
      ['node', 'scripts/audit-phase1b-provider-boundary.mjs'],
      { cwd: PACKAGE_ROOT, env: cleanEnv },
    )
    const transactionFaultProbe = await runCommand(
      recorder,
      'pytest-transaction-faults',
      ['node', 'scripts/run-phase1b-python.mjs', 'python/tests/test_fault_injection.py'],
      { cwd: PACKAGE_ROOT, env: cleanEnv },
    )
    const pathIsolationProbe = await runCommand(
      recorder,
      'pytest-path-isolation',
      ['node', 'scripts/run-phase1b-python.mjs', 'python/tests/test_ownership.py'],
      { cwd: PACKAGE_ROOT, env: cleanEnv },
    )
    const python = join(PACKAGE_ROOT, '.venv-phase1b', 'bin', 'python')
    const pythonProbe = await runCommand(recorder, 'python-version', [python, '-c', 'import platform; print(platform.python_version())'], {
      cwd: workRoot,
      env: cleanEnv,
    })
    const pythonVersion = pythonProbe.stdout.trim()
    if (!/^3\.12\.\d+$/.test(pythonVersion)) fail('PYTHON_VERSION_INVALID')
    await runCommand(recorder, 'pack', ['corepack', `pnpm@${PNPM_VERSION}`, 'pack', '--pack-destination', packRoot], {
      cwd: PACKAGE_ROOT,
      env: cleanEnv,
    })
    const tarballs = (await readdir(packRoot)).filter((name) => name.endsWith('.tgz'))
    if (tarballs.length !== 1) fail('TARBALL_SET_INVALID')
    const tarball = join(packRoot, tarballs[0])
    const inspection = await inspectPackage({
      recorder, tarball, extractRoot, python, workRoot, env: cleanEnv,
    })
    const packagePython = join(inspection.extractedPackage, 'python')
    operationalPaths.push(inspection.extractedPackage)
    await assertCanonicalPathsOutsideFormal([inspection.extractedPackage], formalDataDirectory)
    const context = {
      python,
      packagePython,
      extractedPackage: inspection.extractedPackage,
      workRoot,
      env: cleanEnv,
      recorder,
      schemaSha256: inspection.value.schemaSha256,
      activeSessions,
    }
    const complete = await runCompleteTranscript(context)
    const recovery = await runForcedKillRecovery(context)
    operationalPaths.push(complete.ownedRoot, recovery.ownedRoot)
    for (const path of [complete.ownedRoot, recovery.ownedRoot]) {
      await assertCanonicalPathsOutsideFormal([path], formalDataDirectory)
    }
    const residualProcessCount = await assertNoProcessRetainsRoots(
      recorder, [complete.ownedRoot, recovery.ownedRoot],
    )
    const schemaProbe = await runCommand(
      recorder,
      'schema-version-probe',
      [
        python,
        '-c',
        'import json,sys; from pathlib import Path; from nobei_core.database import Phase1Database; p=Path(sys.argv[3]); d=Phase1Database.open(sys.argv[1],sys.argv[2],p/"sql"/"v8",p/"sql"/"phase1_schema.sql"); print(json.dumps([d.schema_version(),d.p1_schema_version()])); d.close()',
        complete.ownedRoot,
        complete.ownershipToken,
        join(inspection.extractedPackage, 'python', 'nobei_core'),
      ],
      {
        cwd: workRoot,
        env: buildPackedPythonEnvironment({ baseEnv: cleanEnv, packagePython, disposableHome }),
      },
    )
    if (schemaProbe.stdout.trim() !== '[8, 1]') fail('DATABASE_SCHEMA_VERSION_INVALID')

    const lifecycle = {
      version: 1,
      source: 'packed-tarball',
      secondCoreConflict: 'CORE_INSTANCE_CONFLICT',
      forcedKill: 'SIGKILL',
      recoveredStatus: recovery.recovered.status,
      restartSnapshotsEqual: true,
      residualProcessCount,
    }
    const lifecycleBytes = jsonBytes(lifecycle)
    const transcriptBytes = jsonBytes(complete.transcript)
    const testResults = {
      version: 1,
      vitestStdout: redact(vitestProbe.stdout),
      pytestStdout: redact(pytestProbe.stdout),
    }
    await Promise.all([
      writeAtomic(join(stagingRoot, 'package-inspection.json'), jsonBytes(inspection.value)),
      writeAtomic(join(stagingRoot, 'rpc-transcript.json'), transcriptBytes),
      writeAtomic(join(stagingRoot, 'lifecycle.json'), lifecycleBytes),
      writeAtomic(join(stagingRoot, 'test-results.json'), jsonBytes(testResults)),
    ])
    const observations = deriveVerificationObservations({
      providerAuditStdout: providerAuditProbe.stdout,
      providerAuditSha256: sha256(Buffer.from(providerAuditProbe.stdout, 'utf8')),
      transactionFaultStdout: transactionFaultProbe.stdout,
      transactionFaultSha256: sha256(Buffer.from(transactionFaultProbe.stdout, 'utf8')),
      pathIsolationStdout: pathIsolationProbe.stdout,
      pathIsolationSha256: sha256(Buffer.from(pathIsolationProbe.stdout, 'utf8')),
      formalDataDirectory,
      formalDataSource: formalDataGuard.source,
      operationalPathCount: operationalPaths.length,
    })
    const runtimeGateClaims = deriveRuntimeGateClaims({
      vitestStdout: testResults.vitestStdout,
      pytestStdout: testResults.pytestStdout,
      lifecycle,
      lifecycleBytes,
      transcript: complete.transcript,
      transcriptBytes,
      secretScanBytes: Buffer.alloc(0),
    })
    const finalResult = successResult(
      inspection.value.schemaSha256,
      observations,
      runtimeGateClaims,
    )
    const manifest = {
      version: 1,
      gitCommit: commit,
      artifact: { name: basename(tarball), sha256: inspection.value.tarballSha256 },
      runtime: { nodeVersion: process.version, pythonVersion },
      schema: {
        version: 1,
        sha256: inspection.value.schemaSha256,
        databaseVersion: 8,
        phase1Version: 1,
      },
      operationalPaths,
      observations,
      results: {
        stageV8: 'PASS',
        packageInspection: 'PASS',
        ...runtimeGateClaims,
      },
    }
    await assertCanonicalPathsOutsideFormal(manifest.operationalPaths, formalDataDirectory)
    await publishEvidenceAtomically({
      stagingRoot,
      finalRoot: evidenceRoot,
      manifest,
      finalResult,
      expectedGitCommit: commit,
      formalDataDirectory,
      hooks: {
        cleanup: async () => {
          if (activeSessions.size !== 0) fail('RESIDUAL_PROCESS')
          await rm(workRoot, { recursive: true, force: true })
          workRoot = null
        },
      },
    })
    return { evidenceRoot, finalResult }
  } catch (error) {
    await Promise.allSettled([...activeSessions].map((session) => session.abort()))
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  } finally {
    if (workRoot !== null) await rm(workRoot, { recursive: true, force: true })
  }
}

async function main() {
  try {
    const result = await runVerification()
    process.stdout.write(`${result.evidenceRoot}\n`)
    process.stdout.write('PHASE1B_CORE_GO\n')
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? 'VERIFICATION_FAILED').slice(0, 128)}\n`)
    process.stdout.write('PHASE1B_CORE_NO_GO\n')
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
