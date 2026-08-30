import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { CRITICAL_PROFILE_PACKAGES } from '../scripts/dsh-topology.mjs'
import { computeAuthorizationRequestDigest } from '../scripts/accept-spike.mjs'
import { verifyEvidenceRoot } from '../scripts/verify-spike.mjs'

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function preparedEvidence(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nobei-phase1a-verify-'))
  await mkdir(join(root, 'artifacts'), { recursive: true })
  await mkdir(join(root, 'spike-00-public-seams'), { recursive: true })
  await mkdir(join(root, 'commands'), { recursive: true })
  const artifact = Buffer.from('packed-phase1a-artifact')
  const artifactSha256 = createHash('sha256').update(artifact).digest('hex')
  await writeFile(join(root, 'artifacts', 'nobei-dsh-phase1-0.0.0.tgz'), artifact)
  const fields = {
    version: 1,
    artifactSha256,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    maxCalls: 3,
    promptSha256: 'b'.repeat(64),
    schemaSha256: 'c'.repeat(64),
    purpose: 'phase1a-public-seam-spike',
  }
  const request = { ...fields, requestDigest: computeAuthorizationRequestDigest(fields) }
  await json(join(root, 'authorization-request.json'), request)
  await json(join(root, 'manifest.json'), {
    version: 1,
    artifact: 'artifacts/nobei-dsh-phase1-0.0.0.tgz',
    artifactSha256,
    promptSha256: fields.promptSha256,
    schemaSha256: fields.schemaSha256,
    subprocess: { status: 'PASS' },
    decision: 'SPIKE_BLOCKED_USER_AUTHORIZATION',
    modelCalls: {
      spike: { authorizedMax: 3, actual: 0 },
      gate5: { authorizedMax: 0, actual: 0 },
      totalActual: 0,
      futureCombinedCeilingNotAuthorized: 24,
    },
  })
  await json(join(root, 'spike-00-public-seams', 'topology.json'), {
    topology: { expectedVersion: '0.1.0-rc.7', criticalCount: CRITICAL_PROFILE_PACKAGES.length, duplicateCriticalContexts: [] },
    versions: Object.fromEntries(CRITICAL_PROFILE_PACKAGES.map((name) => [name, '0.1.0-rc.7'])),
  })
  await json(join(root, 'spike-00-public-seams', 'subprocess-result.json'), {
    http: { status: 200, byteLength: 100, bodySha256: 'd'.repeat(64) },
    payload: {
      ok: true,
      result: {
        status: 'PASS',
        executableResolved: true,
        handshake: true,
        echoRoundTrip: true,
        environmentIsolation: {
          providerCredentialPresent: false,
          dshHomePresent: false,
          dshToolsModePresent: false,
          dshTelemetryModePresent: false,
        },
        stderr: { readable: true, lossy: false, containsReadyMarker: true, spillPathPresent: false },
        normalExit: { exitCode: 0, treeExited: true },
        abnormalExit: { exitCode: 17, classified: 'CORE_CRASHED', treeExited: true },
        dispose: { rootPid: 100, childPid: 101, waited: true, rootGone: true, childGone: true },
      },
    },
  })
  const command = {
    index: 1,
    argv: ['[REDACTED]/dsh', '--profile', 'nobei', '--port', '0'],
    cwd: 'disposable-runtime',
    envNames: ['PATH', 'HOME', 'DSH_HOME', '[REDACTED_SPIKE_TOKEN_NAME]'],
    startedAt: '2026-08-26T04:00:00.000Z',
    finishedAt: '2026-08-26T04:01:00.000Z',
    exitCode: 0,
    signal: null,
    stdoutFile: 'commands/001-boot.stdout.log',
    stderrFile: 'commands/001-boot.stderr.log',
  }
  await writeFile(join(root, 'commands.ndjson'), `${JSON.stringify(command)}\n`)
  await writeFile(join(root, command.stdoutFile), 'dsh web: http://127.0.0.1:12345\n')
  await writeFile(join(root, command.stderrFile), '')
  return root
}

async function makeGo(root: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  const request = JSON.parse(await readFile(join(root, 'authorization-request.json'), 'utf8'))
  manifest.modelCalls.spike.actual = 3
  manifest.modelCalls.totalActual = 3
  manifest.provider = { status: 'PASS', summaries: 3 }
  manifest.decision = 'PENDING_VERIFICATION'
  await json(join(root, 'manifest.json'), manifest)
  await json(join(root, 'authorization-grant.json'), {
    version: 1,
    requestDigest: request.requestDigest,
    authorizedProvider: request.provider,
    authorizedModel: request.model,
    authorizedMaxCalls: request.maxCalls,
    authorizedAt: '2026-08-26T04:02:00.000Z',
    authorizationSource: 'explicit-user-confirmation-in-active-codex-task',
  })
  for (let index = 1; index <= 3; index += 1) {
    await json(join(root, 'spike-00-public-seams', `provider-call-0${index}.json`), {
      index,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      toolCount: 1,
      toolNames: ['structured_output'],
      workflowStopReason: 'completed',
      agentsStarted: 1,
      structuredPresent: true,
      schemaValid: true,
      semanticValid: true,
      structuredSha256: String(index).repeat(64),
      candidateCount: 1,
      evidenceCount: 1,
    })
  }
}

async function makeNoGo(root: string, actualCalls = 0): Promise<void> {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  const request = JSON.parse(await readFile(join(root, 'authorization-request.json'), 'utf8'))
  manifest.modelCalls.spike.actual = actualCalls
  manifest.modelCalls.totalActual = actualCalls
  manifest.provider = { status: 'FAIL', failureCode: 'PROBE_FAILED' }
  manifest.decision = 'SPIKE_NO_GO'
  await json(join(root, 'manifest.json'), manifest)
  await json(join(root, 'authorization-grant.json'), {
    version: 1,
    requestDigest: request.requestDigest,
    authorizedProvider: request.provider,
    authorizedModel: request.model,
    authorizedMaxCalls: request.maxCalls,
    authorizedAt: '2026-08-26T04:02:00.000Z',
    authorizationSource: 'explicit-user-confirmation-in-active-codex-task',
  })
  await json(join(root, 'spike-00-public-seams', 'provider-failure.json'), {
    http: { status: 500, byteLength: 64, bodySha256: 'e'.repeat(64) },
    error: { code: 'PROBE_FAILED', actualCalls, failureStage: 'OUTCOME_VALIDATION' },
  })
}

describe('fail-closed spike evidence verifier', () => {
  test('accepts the prepared zero-call state only as authorization-blocked', async () => {
    const root = await preparedEvidence()
    await expect(verifyEvidenceRoot(root)).resolves.toMatchObject({
      decision: 'SPIKE_BLOCKED_USER_AUTHORIZATION',
      actualCalls: 0,
    })
    expect(await readFile(join(root, 'secret-scan.txt'), 'utf8')).toBe('')
  })

  test.each([
    ['missing artifact', async (root: string) => rm(join(root, 'artifacts', 'nobei-dsh-phase1-0.0.0.tgz'))],
    ['duplicate command', async (root: string) => {
      const command = await readFile(join(root, 'commands.ndjson'), 'utf8')
      await writeFile(join(root, 'commands.ndjson'), command + command)
    }],
    ['artifact mismatch', async (root: string) => writeFile(join(root, 'artifacts', 'nobei-dsh-phase1-0.0.0.tgz'), 'changed')],
    ['critical drift', async (root: string) => {
      const path = join(root, 'spike-00-public-seams', 'topology.json')
      const value = JSON.parse(await readFile(path, 'utf8'))
      value.versions['@deepseek-ai/dsh-agent'] = '0.1.0-rc.8'
      await json(path, value)
    }],
    ['Core credential visibility', async (root: string) => {
      const path = join(root, 'spike-00-public-seams', 'subprocess-result.json')
      const value = JSON.parse(await readFile(path, 'utf8'))
      value.payload.result.environmentIsolation.providerCredentialPresent = true
      await json(path, value)
    }],
    ['lossy stderr', async (root: string) => {
      const path = join(root, 'spike-00-public-seams', 'subprocess-result.json')
      const value = JSON.parse(await readFile(path, 'utf8'))
      value.payload.result.stderr.lossy = true
      await json(path, value)
    }],
    ['stderr spill', async (root: string) => {
      const path = join(root, 'spike-00-public-seams', 'subprocess-result.json')
      const value = JSON.parse(await readFile(path, 'utf8'))
      value.payload.result.stderr.spillPathPresent = true
      await json(path, value)
    }],
    ['secret pattern', async (root: string) => writeFile(join(root, 'leak.txt'), 'Bearer hidden-token')],
    ['unaccounted termination', async (root: string) => {
      const row = JSON.parse((await readFile(join(root, 'commands.ndjson'), 'utf8')).trim())
      row.exitCode = null
      row.signal = 'SIGKILL'
      await writeFile(join(root, 'commands.ndjson'), `${JSON.stringify(row)}\n`)
    }],
    ['browser opener command', async (root: string) => {
      const lines = (await readFile(join(root, 'commands.ndjson'), 'utf8')).trim().split('\n')
      const opener = {
        index: 2,
        argv: ['/usr/bin/open', '-a', 'Safari', 'http://127.0.0.1:12345'],
        cwd: 'disposable-runtime',
        envNames: ['PATH', 'HOME'],
        startedAt: '2026-08-26T04:00:01.000Z',
        finishedAt: '2026-08-26T04:00:02.000Z',
        exitCode: 0,
        signal: null,
        stdoutFile: 'commands/002-browser.stdout.log',
        stderrFile: 'commands/002-browser.stderr.log',
      }
      await writeFile(join(root, 'commands.ndjson'), `${lines[0]}\n${JSON.stringify(opener)}\n`)
      await writeFile(join(root, opener.stdoutFile), '')
      await writeFile(join(root, opener.stderrFile), '')
    }],
  ])('rejects %s', async (_name, mutate) => {
    const root = await preparedEvidence()
    await mutate(root)
    await expect(verifyEvidenceRoot(root)).rejects.toThrow()
  })

  test('accepts exactly three sanitized provider summaries as GO', async () => {
    const root = await preparedEvidence()
    await makeGo(root)
    await expect(verifyEvidenceRoot(root)).resolves.toMatchObject({ decision: 'SPIKE_GO', actualCalls: 3 })
  })

  test.each([0, 1, 2, 3])('accepts a terminal NO_GO with exactly %i attempted calls', async (actualCalls) => {
    const root = await preparedEvidence()
    await makeNoGo(root, actualCalls)
    await expect(verifyEvidenceRoot(root)).resolves.toMatchObject({ decision: 'SPIKE_NO_GO', actualCalls })
  })

  test.each([
    ['wrong call count', async (root: string) => {
      const path = join(root, 'manifest.json'); const value = JSON.parse(await readFile(path, 'utf8'))
      value.modelCalls.spike.actual = 2; value.modelCalls.totalActual = 2; await json(path, value)
    }],
    ['unexpected tool', async (root: string) => {
      const path = join(root, 'spike-00-public-seams', 'provider-call-01.json'); const value = JSON.parse(await readFile(path, 'utf8'))
      value.toolNames = ['bash']; await json(path, value)
    }],
    ['auxiliary purpose', async (root: string) => {
      const path = join(root, 'spike-00-public-seams', 'provider-call-01.json'); const value = JSON.parse(await readFile(path, 'utf8'))
      value.purpose = 'session-title'; await json(path, value)
    }],
    ['provider mismatch', async (root: string) => {
      const path = join(root, 'spike-00-public-seams', 'provider-call-01.json'); const value = JSON.parse(await readFile(path, 'utf8'))
      value.provider = 'wrong'; await json(path, value)
    }],
    ['structured absent', async (root: string) => {
      const path = join(root, 'spike-00-public-seams', 'provider-call-01.json'); const value = JSON.parse(await readFile(path, 'utf8'))
      value.structuredPresent = false; await json(path, value)
    }],
    ['Schema invalid', async (root: string) => {
      const path = join(root, 'spike-00-public-seams', 'provider-call-01.json'); const value = JSON.parse(await readFile(path, 'utf8'))
      value.schemaValid = false; await json(path, value)
    }],
    ['semantics invalid', async (root: string) => {
      const path = join(root, 'spike-00-public-seams', 'provider-call-01.json'); const value = JSON.parse(await readFile(path, 'utf8'))
      value.semanticValid = false; await json(path, value)
    }],
    ['response body leakage', async (root: string) => {
      const path = join(root, 'spike-00-public-seams', 'provider-call-01.json'); const value = JSON.parse(await readFile(path, 'utf8'))
      value.body = 'raw model response'; await json(path, value)
    }],
    ['grant mismatch', async (root: string) => {
      const path = join(root, 'authorization-grant.json'); const value = JSON.parse(await readFile(path, 'utf8'))
      value.authorizedModel = 'wrong'; await json(path, value)
    }],
  ])('rejects GO when %s', async (_name, mutate) => {
    const root = await preparedEvidence()
    await makeGo(root)
    await mutate(root)
    await expect(verifyEvidenceRoot(root)).rejects.toThrow()
  })
})
