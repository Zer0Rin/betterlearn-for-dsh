import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { JsonlRpcClient } from './jsonl-rpc.js'

export interface SubprocessProbeResult {
  status: 'PASS'
  executableResolved: true
  handshake: true
  echoRoundTrip: true
  environmentIsolation: {
    deepseekApiKeyPresent: false
    dshHomePresent: false
    dshToolsModePresent: false
    dshTelemetryModePresent: false
  }
  stderr: {
    readable: true
    lossy: false
    containsReadyMarker: true
    spillPathPresent: false
  }
  normalExit: { exitCode: 0; treeExited: true }
  abnormalExit: { exitCode: 17; classified: 'CORE_CRASHED'; treeExited: true }
  dispose: {
    rootPid: number
    childPid: number
    waited: true
    rootGone: true
    childGone: true
  }
}

interface SubprocessProbeOptions {
  absoluteCorePath: string
  ownedSpikeRoot: string
  signal?: AbortSignal
  isPidAlive?: (pid: number) => boolean
}

interface EnvironmentProbe {
  deepseekApiKeyPresent: false
  dshHomePresent: false
  dshToolsModePresent: false
  dshTelemetryModePresent: false
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function assertReady(value: unknown, pid: number): void {
  if (
    value === null
    || typeof value !== 'object'
    || (value as Record<string, unknown>).protocolVersion !== 1
    || (value as Record<string, unknown>).pid !== pid
  ) {
    throw new Error('CORE_HANDSHAKE_INVALID')
  }
}

function assertEnvironment(value: unknown): asserts value is EnvironmentProbe {
  if (
    value === null
    || typeof value !== 'object'
    || Object.keys(value as object).length !== 4
    || Object.values(value as Record<string, unknown>).some((present) => present !== false)
  ) {
    throw new Error('CORE_ENVIRONMENT_NOT_ISOLATED')
  }
}

function assertOutcome(outcome: SubprocessOutcome, expectedExitCode: number): void {
  if (outcome.exitCode !== expectedExitCode || outcome.signal !== null) {
    throw new Error('CORE_EXIT_UNEXPECTED')
  }
}

function inspectStderr(handle: SubprocessHandle): void {
  const reader = handle.collected.stderr
  if (!reader) throw new Error('CORE_STDERR_NOT_COLLECTED')
  const output = reader.readFrom(0)
  if (
    output.lossy
    || output.spillPath !== undefined
    || !output.text.includes('nobei-phase1a-core ready')
  ) {
    throw new Error('CORE_STDERR_INVALID')
  }
}

async function cleanupOnFailure(handle: SubprocessHandle, treeExited: boolean): Promise<void> {
  if (treeExited) return
  handle.terminate()
  const waited = await handle.waitForExit()
  if (!waited) throw new Error('CORE_TREE_DID_NOT_EXIT')
}

export async function runSubprocessProbe(
  ctx: Context,
  options: SubprocessProbeOptions,
): Promise<SubprocessProbeResult> {
  const python = await ctx.subprocess.resolveExecutable('python3', undefined, options.signal)
  if (!python.startsWith('/')) throw new Error('PYTHON_EXECUTABLE_NOT_ABSOLUTE')

  const spawnCore = (): SubprocessHandle => ctx.subprocess.spawn({
    argv: [python, options.absoluteCorePath],
    cwd: options.ownedSpikeRoot,
    stdio: {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: { maxBytes: 16 * 1024 },
    },
    graceMs: 1_000,
    signal: options.signal,
    env: {
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    },
  })

  const normal = spawnCore()
  let normalTreeExited = false
  let environment: EnvironmentProbe
  try {
    if (!normal.stdin || !normal.stdout) throw new Error('CORE_PIPE_MISSING')
    const rpc = new JsonlRpcClient(normal.stdout, normal.stdin)
    assertReady(await rpc.waitForNotification('core.ready'), normal.pid)
    const echoed = await rpc.request('echo', { value: 'nobei-phase1a' }, options.signal)
    if (
      echoed === null
      || typeof echoed !== 'object'
      || (echoed as Record<string, unknown>).value !== 'nobei-phase1a'
    ) throw new Error('CORE_ECHO_MISMATCH')
    const environmentResult = await rpc.request('env_probe', {}, options.signal)
    assertEnvironment(environmentResult)
    environment = environmentResult
    const shutdown = await rpc.request('shutdown', {}, options.signal)
    if (shutdown === null || typeof shutdown !== 'object' || (shutdown as Record<string, unknown>).ok !== true) {
      throw new Error('CORE_SHUTDOWN_INVALID')
    }
    assertOutcome(await normal.done, 0)
    normalTreeExited = await normal.waitForExit(options.signal)
    if (!normalTreeExited) throw new Error('CORE_TREE_DID_NOT_EXIT')
    inspectStderr(normal)
  } finally {
    await cleanupOnFailure(normal, normalTreeExited)
  }

  const abnormal = spawnCore()
  let abnormalTreeExited = false
  try {
    if (!abnormal.stdin || !abnormal.stdout) throw new Error('CORE_PIPE_MISSING')
    const rpc = new JsonlRpcClient(abnormal.stdout, abnormal.stdin)
    assertReady(await rpc.waitForNotification('core.ready'), abnormal.pid)
    const noResponse = rpc.request('crash', {}, options.signal).then(() => false, () => true)
    assertOutcome(await abnormal.done, 17)
    if (!await noResponse) throw new Error('CORE_CRASH_RETURNED_RESPONSE')
    abnormalTreeExited = await abnormal.waitForExit(options.signal)
    if (!abnormalTreeExited) throw new Error('CORE_TREE_DID_NOT_EXIT')
    inspectStderr(abnormal)
  } finally {
    await cleanupOnFailure(abnormal, abnormalTreeExited)
  }

  const disposeHandle = spawnCore()
  let disposeWaited = false
  let childPid = -1
  try {
    if (!disposeHandle.stdin || !disposeHandle.stdout) throw new Error('CORE_PIPE_MISSING')
    const rpc = new JsonlRpcClient(disposeHandle.stdout, disposeHandle.stdin)
    assertReady(await rpc.waitForNotification('core.ready'), disposeHandle.pid)
    const child = await rpc.request('spawn_child', {}, options.signal)
    if (
      child === null
      || typeof child !== 'object'
      || !Number.isInteger((child as Record<string, unknown>).childPid)
    ) throw new Error('CORE_CHILD_PID_INVALID')
    childPid = (child as { childPid: number }).childPid

    const fiber = ctx.plugin(() => async () => {
      disposeHandle.terminate()
      disposeWaited = await disposeHandle.waitForExit(options.signal)
      if (!disposeWaited) throw new Error('CORE_TREE_DID_NOT_EXIT')
    })
    await fiber
    await fiber.dispose()
  } finally {
    await cleanupOnFailure(disposeHandle, disposeWaited)
  }

  const isPidAlive = options.isPidAlive ?? defaultPidAlive
  const rootGone = !isPidAlive(disposeHandle.pid)
  const childGone = !isPidAlive(childPid)
  if (!rootGone || !childGone) throw new Error('CORE_PROCESS_TREE_STILL_ALIVE')

  return {
    status: 'PASS',
    executableResolved: true,
    handshake: true,
    echoRoundTrip: true,
    environmentIsolation: environment,
    stderr: {
      readable: true,
      lossy: false,
      containsReadyMarker: true,
      spillPathPresent: false,
    },
    normalExit: { exitCode: 0, treeExited: true },
    abnormalExit: { exitCode: 17, classified: 'CORE_CRASHED', treeExited: true },
    dispose: {
      rootPid: disposeHandle.pid,
      childPid,
      waited: true,
      rootGone: true,
      childGone: true,
    },
  }
}
