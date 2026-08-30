import { PassThrough } from 'node:stream'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CORE_STABLE_RESET_MS } from '../src/product/constants.js'
import { CoreSupervisor } from '../src/product/core-supervisor.js'

const schema = { schemaVersion: 1, schemaSha256: 'a'.repeat(64) }
const config = {
  pythonExecutable: '/opt/nobei/python3.12',
  dataRoot: '/tmp/nobei-phase1e-owned',
  ownershipToken: '0123456789abcdef0123456789abcdef',
}

class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T) => void
  reject!: (error: unknown) => void

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

interface CoreProfile {
  hello?: Record<string, unknown>
  noHello?: boolean
  stdoutPollution?: boolean
}

class FakeHandle implements SubprocessHandle {
  static nextPid = 30_000
  readonly pid = FakeHandle.nextPid++
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = undefined
  readonly collected = {}
  readonly outcome = new Deferred<SubprocessOutcome>()
  readonly done = this.outcome.promise
  terminateCalls = 0
  waitCalls = 0
  exited = false

  terminate(): void {
    this.terminateCalls += 1
    this.exit(null, 'SIGTERM')
  }

  async waitForExit(): Promise<boolean> {
    this.waitCalls += 1
    await this.done
    return true
  }

  exit(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return
    this.exited = true
    this.stdout.end()
    this.outcome.resolve({ exitCode, signal })
  }
}

class FakeSubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []
  readonly coreHandles: FakeHandle[] = []
  readonly profiles: CoreProfile[] = []
  preflight = { pythonVersion: '3.12.13', jsonschemaVersion: '4.25.1', coreImportable: true }

  async resolveExecutable(command: string): Promise<string> {
    return command
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    const handle = new FakeHandle()
    if (spec.argv[1] === '-c') {
      queueMicrotask(() => {
        handle.stdout.write(`${JSON.stringify(this.preflight)}\n`)
        handle.exit(0)
      })
      return handle
    }
    const profile = this.profiles.shift() ?? {}
    this.coreHandles.push(handle)
    let buffer = ''
    handle.stdin.setEncoding('utf8')
    handle.stdin.on('data', (chunk: string) => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n')
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const request = JSON.parse(line) as { id: number; method: string }
        if (request.method !== 'system.hello' || profile.noHello) continue
        if (profile.stdoutPollution) {
          handle.stdout.write('not-json\n')
          continue
        }
        handle.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: profile.hello ?? {
            protocolVersion: 3,
            coreVersion: 'phase1e',
            databaseKind: 'sqlite',
            capabilities: [
              'l1-text-extraction',
              'atomic-generation-commands',
              'model-selection-snapshot',
            ],
            schemaVersion: 1,
            schemaSha256: schema.schemaSha256,
            dataRootKind: 'isolated-phase1',
          },
        })}\n`)
      }
    })
    return handle
  }
}

async function readySupervisor(runtime = new FakeSubprocessRuntime()) {
  const supervisor = new CoreSupervisor(runtime, config, schema)
  await supervisor.start()
  expect(supervisor.state).toBe('READY')
  return { supervisor, runtime }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('CoreSupervisor', () => {
  test.each([
    [{ ...config, pythonExecutable: 'python3.12' }],
    [{ ...config, dataRoot: 'relative-data' }],
    [{ ...config, ownershipToken: 'short' }],
  ])('rejects invalid config before executable resolution or spawn', async (invalid) => {
    const runtime = new FakeSubprocessRuntime()
    const supervisor = new CoreSupervisor(runtime, invalid, schema)
    await expect(supervisor.start()).rejects.toThrow('CORE_CONFIG_INVALID')
    expect(runtime.specs).toEqual([])
    expect(supervisor.state).toBe('DEGRADED')
  })

  test.each([
    [{ pythonVersion: '3.11.9', jsonschemaVersion: '4.25.1', coreImportable: true }],
    [{ pythonVersion: '3.12.13', jsonschemaVersion: '4.24.0', coreImportable: true }],
    [{ pythonVersion: '3.12.13', jsonschemaVersion: '4.25.1', coreImportable: false }],
  ])('fails preflight deterministically for %j', async (preflight) => {
    const runtime = new FakeSubprocessRuntime()
    runtime.preflight = preflight
    const supervisor = new CoreSupervisor(runtime, config, schema)
    await expect(supervisor.start()).rejects.toThrow('CORE_PREFLIGHT_FAILED')
    expect(runtime.coreHandles).toHaveLength(0)
    expect(supervisor.state).toBe('DEGRADED')
  })

  test('spawns the Core with explicit argv cwd stdio and a credential-free env', async () => {
    const { supervisor, runtime } = await readySupervisor()
    const coreSpec = runtime.specs.at(-1)
    expect(coreSpec).toMatchObject({
      argv: [config.pythonExecutable, '-m', 'nobei_core.main', '--data-root', config.dataRoot,
        '--ownership-token', config.ownershipToken],
      cwd: config.dataRoot,
      stdio: { stdin: 'pipe', stdout: 'pipe' },
    })
    expect(Object.keys(coreSpec?.env ?? {}).some((key) =>
      /(?:KEY|TOKEN|SECRET|PASSWORD|^DSH_)/i.test(key),
    )).toBe(false)
    await supervisor.dispose()
  })

  test.each([
    [{ protocolVersion: 2 }, 'PROTOCOL_MISMATCH'],
    [{ coreVersion: 'phase1c' }, 'PROTOCOL_MISMATCH'],
    [{ databaseKind: 'memory' }, 'PROTOCOL_MISMATCH'],
    [{ capabilities: ['l1-text-extraction', 'atomic-generation-commands'] }, 'PROTOCOL_MISMATCH'],
    [{ schemaSha256: 'b'.repeat(64) }, 'PROTOCOL_MISMATCH'],
    [{ dataRootKind: 'formal' }, 'PROTOCOL_MISMATCH'],
  ])('degrades without restart on deterministic handshake mismatch %j', async (override, code) => {
    const runtime = new FakeSubprocessRuntime()
    runtime.profiles.push({ hello: {
      protocolVersion: 3,
      coreVersion: 'phase1e',
      databaseKind: 'sqlite',
      capabilities: [
        'l1-text-extraction',
        'atomic-generation-commands',
        'model-selection-snapshot',
      ],
      schemaVersion: 1,
      schemaSha256: schema.schemaSha256,
      dataRootKind: 'isolated-phase1',
      ...override,
    } })
    const supervisor = new CoreSupervisor(runtime, config, schema)
    await expect(supervisor.start()).rejects.toThrow(code)
    expect(supervisor.state).toBe('DEGRADED')
    expect(runtime.coreHandles).toHaveLength(1)
  })

  test('handshake timeout and stdout pollution degrade deterministically', async () => {
    vi.useFakeTimers()
    const timeoutRuntime = new FakeSubprocessRuntime()
    timeoutRuntime.profiles.push({ noHello: true })
    const timeoutSupervisor = new CoreSupervisor(timeoutRuntime, config, schema)
    const start = timeoutSupervisor.start()
    const observed = start.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await observed).toMatchObject({ code: 'CORE_RPC_TIMEOUT' })
    expect(timeoutSupervisor.state).toBe('DEGRADED')

    vi.useRealTimers()
    const pollutionRuntime = new FakeSubprocessRuntime()
    pollutionRuntime.profiles.push({ stdoutPollution: true })
    const pollutionSupervisor = new CoreSupervisor(pollutionRuntime, config, schema)
    await expect(pollutionSupervisor.start()).rejects.toThrow('CORE_RPC_MALFORMED_JSON')
    expect(pollutionSupervisor.state).toBe('DEGRADED')
  })

  test('two consecutive crashes restart and the third exhausts the budget', async () => {
    const { supervisor, runtime } = await readySupervisor()
    for (let index = 0; index < 2; index += 1) {
      runtime.coreHandles.at(-1)?.exit(17)
      await vi.waitFor(() => expect(runtime.coreHandles).toHaveLength(index + 2))
      await vi.waitFor(() => expect(supervisor.state).toBe('READY'))
    }
    runtime.coreHandles.at(-1)?.exit(17)
    await vi.waitFor(() => expect(supervisor.state).toBe('DEGRADED'))
    expect(runtime.coreHandles).toHaveLength(3)
  })

  test('an unexpected clean Core exit also consumes restart budget', async () => {
    const { supervisor, runtime } = await readySupervisor()
    runtime.coreHandles[0]?.exit(0)
    await vi.waitFor(() => expect(runtime.coreHandles).toHaveLength(2))
    await vi.waitFor(() => expect(supervisor.state).toBe('READY'))
    await supervisor.dispose()
  })

  test('an explicit uncertain-write poison replaces the current Core once', async () => {
    const { supervisor, runtime } = await readySupervisor()
    await supervisor.poison('CORE_FINALIZE_UNCERTAIN')
    expect(runtime.coreHandles).toHaveLength(2)
    expect(supervisor.state).toBe('READY')
    expect(runtime.coreHandles[0]?.terminateCalls).toBe(1)
    await supervisor.dispose()
  })

  test('only a full stable interval resets the consecutive crash budget', async () => {
    vi.useFakeTimers()
    const { supervisor, runtime } = await readySupervisor()
    runtime.coreHandles.at(-1)?.exit(17)
    await vi.runAllTicks()
    await vi.waitFor(() => expect(runtime.coreHandles).toHaveLength(2))
    await vi.advanceTimersByTimeAsync(CORE_STABLE_RESET_MS - 1)
    runtime.coreHandles.at(-1)?.exit(17)
    await vi.runAllTicks()
    await vi.waitFor(() => expect(runtime.coreHandles).toHaveLength(3))
    await vi.advanceTimersByTimeAsync(CORE_STABLE_RESET_MS)
    runtime.coreHandles.at(-1)?.exit(17)
    await vi.runAllTicks()
    await vi.waitFor(() => expect(runtime.coreHandles).toHaveLength(4))
    expect(supervisor.state).toBe('READY')
    await supervisor.dispose()
  })

  test('dispose closes admission then terminates and waits exactly once', async () => {
    const { supervisor, runtime } = await readySupervisor()
    await expect(supervisor.withReadyClient(async () => 'ready')).resolves.toBe('ready')
    const handle = runtime.coreHandles[0]
    const first = supervisor.dispose()
    const second = supervisor.dispose()
    expect(supervisor.state).toBe('DISPOSING')
    await expect(supervisor.withReadyClient(async () => 'late')).rejects.toThrow('CORE_UNAVAILABLE')
    await Promise.all([first, second])
    expect(supervisor.state).toBe('DISPOSED')
    expect(handle?.terminateCalls).toBe(1)
    expect(handle?.waitCalls).toBe(1)
    await expect(supervisor.withReadyClient(async () => 'late')).rejects.toThrow('CORE_UNAVAILABLE')
  })
})
