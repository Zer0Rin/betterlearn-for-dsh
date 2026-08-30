import { fileURLToPath } from 'node:url'
import { isAbsolute } from 'node:path'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  CORE_CAPABILITIES,
  CORE_DATABASE_KIND,
  CORE_DATA_ROOT_KIND,
  CORE_MAX_AUTOMATIC_RESTARTS,
  CORE_PROTOCOL_VERSION,
  CORE_STABLE_RESET_MS,
  CORE_VERSION,
} from './constants.js'
import { CoreRpcError, FixedCoreRpcClient } from './core-rpc-client.js'
import type { CoreState, HelloResult } from './types.js'

export interface CoreSupervisorConfig {
  pythonExecutable: string
  dataRoot: string
  ownershipToken: string
}

interface CoreIdentity {
  schemaVersion: number
  schemaSha256: string
}

interface SubprocessPort {
  resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

interface PreflightResult {
  pythonVersion: string
  jsonschemaVersion: string
  coreImportable: boolean
}

const PACKAGE_PYTHON_ROOT = fileURLToPath(new URL('../../python', import.meta.url))
const PREFLIGHT_SCRIPT = [
  'import importlib.metadata,json,platform',
  'ok=True',
  'try:\n import nobei_core',
  'except Exception:\n ok=False',
  'print(json.dumps({"pythonVersion":platform.python_version(),"jsonschemaVersion":importlib.metadata.version("jsonschema"),"coreImportable":ok},separators=(",",":")))',
].join('\n')

const CHILD_ENV: NodeJS.ProcessEnv = {
  PYTHONPATH: PACKAGE_PYTHON_ROOT,
  PYTHONUNBUFFERED: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
}

function supervisorError(code: string): CoreRpcError {
  return new CoreRpcError(code)
}

function validConfig(config: CoreSupervisorConfig): boolean {
  return (
    isAbsolute(config.pythonExecutable)
    && isAbsolute(config.dataRoot)
    && config.ownershipToken.length >= 32
    && !config.ownershipToken.includes('\0')
  )
}

function readPipe(handle: SubprocessHandle, maxBytes = 64 * 1024): Promise<string> {
  const stdout = handle.stdout
  if (!stdout) return Promise.reject(supervisorError('CORE_PIPE_MISSING'))
  stdout.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let output = ''
    stdout.on('data', (chunk: string) => {
      output += chunk
      if (Buffer.byteLength(output, 'utf8') > maxBytes) {
        reject(supervisorError('CORE_PREFLIGHT_FAILED'))
      }
    })
    stdout.once('end', () => resolve(output))
    stdout.once('error', () => reject(supervisorError('CORE_PREFLIGHT_FAILED')))
  })
}

function parsePreflight(output: string): PreflightResult {
  let value: unknown
  try {
    value = JSON.parse(output.trim())
  } catch {
    throw supervisorError('CORE_PREFLIGHT_FAILED')
  }
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'coreImportable,jsonschemaVersion,pythonVersion'
  ) throw supervisorError('CORE_PREFLIGHT_FAILED')
  const result = value as Record<string, unknown>
  if (
    typeof result.pythonVersion !== 'string'
    || !/^3\.12\.\d+$/.test(result.pythonVersion)
    || result.jsonschemaVersion !== '4.25.1'
    || result.coreImportable !== true
  ) throw supervisorError('CORE_PREFLIGHT_FAILED')
  return result as unknown as PreflightResult
}

function assertHelloIdentity(result: HelloResult, identity: CoreIdentity): void {
  if (
    result.protocolVersion !== CORE_PROTOCOL_VERSION
    || result.coreVersion !== CORE_VERSION
    || result.databaseKind !== CORE_DATABASE_KIND
    || result.dataRootKind !== CORE_DATA_ROOT_KIND
    || result.schemaVersion !== identity.schemaVersion
    || result.schemaSha256 !== identity.schemaSha256
    || !Array.isArray(result.capabilities)
    || result.capabilities.length !== CORE_CAPABILITIES.length
    || result.capabilities.some((capability, index) => capability !== CORE_CAPABILITIES[index])
  ) throw supervisorError('PROTOCOL_MISMATCH')
}

export class CoreSupervisor {
  readonly #subprocess: SubprocessPort
  readonly #config: CoreSupervisorConfig
  readonly #identity: CoreIdentity
  #state: CoreState = 'STARTING'
  #generation = 0
  #restartCount = 0
  #handle: SubprocessHandle | null = null
  #client: FixedCoreRpcClient | null = null
  #stableTimer: NodeJS.Timeout | null = null
  #startPromise: Promise<void> | null = null
  #restartPromise: Promise<void> | null = null
  #disposePromise: Promise<void> | null = null

  constructor(
    subprocess: SubprocessPort,
    config: CoreSupervisorConfig,
    identity: CoreIdentity,
  ) {
    this.#subprocess = subprocess
    this.#config = { ...config }
    this.#identity = { ...identity }
  }

  get state(): CoreState {
    return this.#state
  }

  start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise
    this.#startPromise = this.#startOnce()
    return this.#startPromise
  }

  async withReadyClient<T>(operation: (client: FixedCoreRpcClient) => Promise<T>): Promise<T> {
    const client = this.#client
    if (this.#state !== 'READY' || !client) throw supervisorError('CORE_UNAVAILABLE')
    return operation(client)
  }

  poison(code = 'CORE_RPC_UNCERTAIN'): Promise<void> {
    if (this.#state !== 'READY') return Promise.resolve()
    return this.#restartAfterFailure(this.#generation, supervisorError(code))
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise
    this.#state = 'DISPOSING'
    this.#generation += 1
    this.#clearStableTimer()
    this.#disposePromise = this.#cleanupCurrent().finally(() => {
      this.#state = 'DISPOSED'
    })
    return this.#disposePromise
  }

  async #startOnce(): Promise<void> {
    if (!validConfig(this.#config)) {
      this.#state = 'DEGRADED'
      throw supervisorError('CORE_CONFIG_INVALID')
    }
    try {
      const executable = await this.#subprocess.resolveExecutable(this.#config.pythonExecutable)
      if (!isAbsolute(executable)) throw supervisorError('CORE_CONFIG_INVALID')
      await this.#runPreflight(executable)
      await this.#launch(executable, 'STARTING')
    } catch (error) {
      this.#state = 'DEGRADED'
      throw error
    }
  }

  async #runPreflight(executable: string): Promise<void> {
    const handle = this.#subprocess.spawn({
      argv: [executable, '-c', PREFLIGHT_SCRIPT],
      cwd: this.#config.dataRoot,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 16 * 1024 } },
      graceMs: 1_000,
      env: { ...CHILD_ENV },
    })
    try {
      const [output, outcome] = await Promise.all([readPipe(handle), handle.done])
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        throw supervisorError('CORE_PREFLIGHT_FAILED')
      }
      parsePreflight(output)
      if (!await handle.waitForExit()) throw supervisorError('CORE_PREFLIGHT_FAILED')
    } catch (error) {
      handle.terminate()
      await handle.waitForExit().catch(() => false)
      throw error
    }
  }

  async #launch(executable: string, state: 'STARTING' | 'RESTARTING'): Promise<void> {
    if (this.#state === 'DISPOSING' || this.#state === 'DISPOSED') return
    this.#state = state
    const generation = ++this.#generation
    const handle = this.#subprocess.spawn({
      argv: [
        executable,
        '-m',
        'nobei_core.main',
        '--data-root',
        this.#config.dataRoot,
        '--ownership-token',
        this.#config.ownershipToken,
      ],
      cwd: this.#config.dataRoot,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
      graceMs: 1_000,
      env: { ...CHILD_ENV },
    })
    if (!handle.stdin || !handle.stdout) {
      handle.terminate()
      await handle.waitForExit().catch(() => false)
      this.#state = 'DEGRADED'
      throw supervisorError('CORE_PIPE_MISSING')
    }
    const client = new FixedCoreRpcClient(handle.stdout, handle.stdin, {
      onPoisoned: (error) => {
        if (generation === this.#generation && this.#state === 'READY') {
          void this.#restartAfterFailure(generation, error)
        }
      },
    })
    this.#handle = handle
    this.#client = client
    void handle.done.then(
      () => {
        if (generation === this.#generation && this.#state === 'READY') {
          void this.#restartAfterFailure(generation, supervisorError('CORE_CRASHED'))
        }
      },
      () => {
        if (generation === this.#generation && this.#state === 'READY') {
          void this.#restartAfterFailure(generation, supervisorError('CORE_CRASHED'))
        }
      },
    )
    try {
      const hello = await client.hello({
        protocolVersion: CORE_PROTOCOL_VERSION,
        schemaVersion: this.#identity.schemaVersion,
        schemaSha256: this.#identity.schemaSha256,
      })
      assertHelloIdentity(hello, this.#identity)
      if (generation !== this.#generation) throw supervisorError('CORE_UNAVAILABLE')
      this.#state = 'READY'
      this.#installStableReset(generation)
    } catch (error) {
      if (generation === this.#generation) {
        await this.#cleanupCurrent()
        this.#state = 'DEGRADED'
      }
      throw error
    }
  }

  #installStableReset(generation: number): void {
    this.#clearStableTimer()
    this.#stableTimer = setTimeout(() => {
      if (generation === this.#generation && this.#state === 'READY') {
        this.#restartCount = 0
      }
    }, CORE_STABLE_RESET_MS)
    this.#stableTimer.unref?.()
  }

  #clearStableTimer(): void {
    if (this.#stableTimer) clearTimeout(this.#stableTimer)
    this.#stableTimer = null
  }

  async #restartAfterFailure(generation: number, _error: CoreRpcError): Promise<void> {
    if (generation !== this.#generation || this.#state !== 'READY') return
    if (this.#restartPromise) return this.#restartPromise
    this.#state = 'RESTARTING'
    this.#clearStableTimer()
    this.#restartPromise = (async () => {
      await this.#cleanupCurrent()
      if (this.#state === 'DISPOSING' || this.#state === 'DISPOSED') return
      if (this.#restartCount >= CORE_MAX_AUTOMATIC_RESTARTS) {
        this.#state = 'DEGRADED'
        return
      }
      this.#restartCount += 1
      try {
        const executable = await this.#subprocess.resolveExecutable(this.#config.pythonExecutable)
        await this.#launch(executable, 'RESTARTING')
      } catch {
        this.#state = 'DEGRADED'
      }
    })().finally(() => {
      this.#restartPromise = null
    })
    return this.#restartPromise
  }

  async #cleanupCurrent(): Promise<void> {
    const client = this.#client
    const handle = this.#handle
    this.#client = null
    this.#handle = null
    client?.close()
    if (!handle) return
    handle.terminate()
    const exited = await handle.waitForExit()
    if (!exited) throw supervisorError('CORE_TERMINATION_FAILED')
  }
}
