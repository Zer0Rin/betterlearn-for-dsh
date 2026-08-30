import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const schemaPath = fileURLToPath(new URL('../contracts/l1-candidate.schema.json', import.meta.url))
const runtimeSchemaSha256 = createHash('sha256').update(readFileSync(schemaPath)).digest('hex')
const schemaSentinel = '__RUNTIME_SCHEMA_SHA256__'

function fixture(name: string): { raw: string, value: Record<string, unknown> } {
  const path = fileURLToPath(new URL(`../contracts/rpc/${name}`, import.meta.url))
  const raw = readFileSync(path, 'utf8')
  return { raw, value: JSON.parse(raw) as Record<string, unknown> }
}

function resolveRuntime(value: unknown, replacements: Readonly<Record<string, unknown>>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveRuntime(item, replacements))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveRuntime(item, replacements)]))
  }
  return typeof value === 'string' && Object.hasOwn(replacements, value) ? replacements[value] : value
}

function expectExactKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  expect(value).not.toBeNull()
  expect(typeof value).toBe('object')
  expect(Array.isArray(value)).toBe(false)
  expect(Object.keys(value as object).sort()).toEqual([...keys].sort())
}

describe('runtime-resolved JSON-RPC fixtures', () => {
  test('phase1e hello is closed and resolves the packaged schema digest only in memory', () => {
    const loaded = fixture('hello-v3.json')
    expect(loaded.raw).toContain(schemaSentinel)
    expect(loaded.raw).not.toContain(runtimeSchemaSha256)
    const resolved = resolveRuntime(loaded.value, { [schemaSentinel]: runtimeSchemaSha256 })
    expectExactKeys(resolved, ['request', 'response'])
    expect(resolved).toEqual({
      request: {
        jsonrpc: '2.0',
        id: 'rpc_hello_v3_fixture',
        method: 'system.hello',
        params: { protocolVersion: 3, schemaVersion: 1, schemaSha256: runtimeSchemaSha256 },
      },
      response: {
        jsonrpc: '2.0',
        id: 'rpc_hello_v3_fixture',
        result: {
          protocolVersion: 3,
          coreVersion: 'phase1e',
          databaseKind: 'sqlite',
          capabilities: ['l1-text-extraction', 'atomic-generation-commands', 'model-selection-snapshot'],
          schemaVersion: 1,
          schemaSha256: runtimeSchemaSha256,
          dataRootKind: 'isolated-phase1',
        },
      },
    })
    expect(JSON.stringify(resolved)).not.toContain(schemaSentinel)
  })

  test('atomic import and retry fixtures expose only prepared generation results', () => {
    const replacements = {
      [schemaSentinel]: runtimeSchemaSha256,
      __RUNTIME_RUN_ID__: 'job_0123456789abcdefabcd',
      __RUNTIME_ATTEMPT_ID__: 'att_0123456789abcdefabcd',
      __RUNTIME_EXPECTED_REVISION__: 3,
      __RUNTIME_REVISION__: 5,
      __RUNTIME_DOCUMENT_SHA256__: 'a'.repeat(64),
      __RUNTIME_REQUEST_DIGEST__: 'b'.repeat(64),
      __RUNTIME_PROVIDER_IDEMPOTENCY_KEY__: `nobei:${'b'.repeat(64)}`,
    }
    const imported = resolveRuntime(fixture('import-and-prepare.json').value, replacements) as Record<string, unknown>
    const retried = resolveRuntime(fixture('retry-and-prepare.json').value, replacements) as Record<string, unknown>

    expect((imported.request as Record<string, unknown>).method).toBe('documents.import_and_prepare_generation')
    expect((retried.request as Record<string, unknown>).method).toBe('runs.retry_and_prepare_generation')
    expect((imported.response as { result: Record<string, unknown> }).result).toMatchObject({
      runId: replacements.__RUNTIME_RUN_ID__, attemptNumber: 1, revision: 2,
      promptVersion: 'l1-v2',
      modelSelection: { provider: 'provider-fixture', model: 'model-fixture', reasoningEffort: 'medium' },
    })
    expect((retried.response as { result: Record<string, unknown> }).result).toMatchObject({
      runId: replacements.__RUNTIME_RUN_ID__, attemptNumber: 2, revision: 5,
      promptVersion: 'l1-v2',
      modelSelection: { provider: 'provider-fixture', model: 'model-fixture', reasoningEffort: 'medium' },
    })
    expect(Object.keys((imported.response as { result: Record<string, unknown> }).result).sort()).toEqual([
      'attemptId', 'attemptNumber', 'document', 'modelSelection', 'promptVersion',
      'providerIdempotencyKey', 'requestDigest', 'revision', 'runId', 'schemaSha256', 'schemaVersion',
    ])
  })

  test('import text fixture has exact request and runtime result shapes', () => {
    const loaded = fixture('import-text.json')
    const resolved = resolveRuntime(loaded.value, {
      __RUNTIME_DOCUMENT_ID__: 'doc_0123456789abcdefabcd',
      __RUNTIME_RUN_ID__: 'job_0123456789abcdefabcd',
    })
    expect(resolved).toEqual({
      request: {
        jsonrpc: '2.0',
        id: 'rpc_import_fixture',
        method: 'documents.import_text',
        params: {
          filename: 'photosynthesis.md',
          mediaType: 'text/markdown',
          text: 'Plants convert light energy into chemical energy.',
        },
      },
      response: {
        jsonrpc: '2.0',
        id: 'rpc_import_fixture',
        result: {
          documentId: 'doc_0123456789abcdefabcd',
          runId: 'job_0123456789abcdefabcd',
          revision: 1,
        },
      },
    })
  })

  test('generation finalization fixtures cannot rewrite the stored model selection', () => {
    const replacements = {
      __RUNTIME_RUN_ID__: 'job_0123456789abcdefabcd',
      __RUNTIME_ATTEMPT_ID__: 'att_0123456789abcdefabcd',
      __RUNTIME_EXPECTED_REVISION__: 2,
    }
    const submitted = resolveRuntime(fixture('submit-generation.json').value, replacements)
    const failed = resolveRuntime(fixture('fail-generation.json').value, replacements)

    expect(submitted).toEqual({
      jsonrpc: '2.0',
      id: 'rpc_submit_generation_fixture',
      method: 'runs.submit_generation',
      params: {
        runId: replacements.__RUNTIME_RUN_ID__,
        attemptId: replacements.__RUNTIME_ATTEMPT_ID__,
        expectedRevision: 2,
        output: { schemaVersion: 1, candidates: [] },
      },
    })
    expect(failed).toEqual({
      jsonrpc: '2.0',
      id: 'rpc_fail_generation_fixture',
      method: 'runs.fail_generation',
      params: {
        runId: replacements.__RUNTIME_RUN_ID__,
        attemptId: replacements.__RUNTIME_ATTEMPT_ID__,
        expectedRevision: 2,
        code: 'GENERATION_PROVIDER_ERROR',
      },
    })
    expect(JSON.stringify([submitted, failed])).not.toContain('modelMetadata')
  })

  test('review conflict fixture is a stable exact public error', () => {
    const loaded = fixture('review-conflict.json')
    const resolved = resolveRuntime(loaded.value, {
      __RUNTIME_CANDIDATE_ID__: 'cand_0123456789abcdefabcd',
    })
    expect(resolved).toEqual({
      request: {
        jsonrpc: '2.0',
        id: 'rpc_review_conflict_fixture',
        method: 'candidates.review',
        params: {
          candidateId: 'cand_0123456789abcdefabcd',
          action: 'accept',
          expectedRevision: 2,
          idempotencyKey: 'idem_0123456789abcdefabcd',
        },
      },
      response: {
        jsonrpc: '2.0',
        id: 'rpc_review_conflict_fixture',
        error: {
          code: -32000,
          message: 'REVISION_CONFLICT',
          data: { code: 'REVISION_CONFLICT' },
        },
      },
    })
  })
})
