import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { describe, expect, test } from 'vitest'
import { runSubprocessProbe } from '../src/spike/subprocess-probe.js'

type Mode = 'normal' | 'abnormal' | 'dispose'

class FakeHandle implements SubprocessHandle {
  readonly pid: number
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = undefined
  readonly collected
  readonly done: Promise<SubprocessOutcome>
  terminateCalls = 0
  waitCalls = 0
  childPid: number | null = null
  #resolveDone!: (outcome: SubprocessOutcome) => void
  #closed = false

  constructor(readonly mode: Mode, pid: number, readonly spec: SubprocessSpawnSpec) {
    this.pid = pid
    this.collected = {
      stderr: {
        readFrom: () => ({
          text: 'nobei-phase1a-core ready\n',
          nextOffset: 27,
          lossy: false,
        }),
      },
    }
    this.done = new Promise((resolve) => { this.#resolveDone = resolve })
    queueMicrotask(() => {
      this.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', method: 'core.ready', params: { protocolVersion: 1, pid },
      })}\n`)
    })
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      for (const line of chunk.trim().split('\n')) {
        if (!line) continue
        const request = JSON.parse(line)
        if (request.method === 'echo') this.respond(request.id, { value: request.params.value })
        if (request.method === 'env_probe') this.respond(request.id, {
          deepseekApiKeyPresent: false,
          dshHomePresent: false,
          dshToolsModePresent: false,
          dshTelemetryModePresent: false,
        })
        if (request.method === 'shutdown') {
          this.respond(request.id, { ok: true })
          this.close({ exitCode: 0, signal: null })
        }
        if (request.method === 'crash') this.close({ exitCode: 17, signal: null })
        if (request.method === 'spawn_child') {
          this.childPid = pid + 1000
          this.respond(request.id, { childPid: this.childPid })
        }
      }
    })
  }

  respond(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  close(outcome: SubprocessOutcome): void {
    if (this.#closed) return
    this.#closed = true
    this.stdout.end()
    this.#resolveDone(outcome)
  }

  terminate(): void {
    this.terminateCalls += 1
    this.close({ exitCode: null, signal: 'SIGTERM' })
  }

  async waitForExit(): Promise<boolean> {
    this.waitCalls += 1
    await this.done
    return true
  }
}

class FakeRuntime {
  readonly handles: FakeHandle[] = []
  resolveCalls = 0

  async resolveExecutable(command: string): Promise<string> {
    this.resolveCalls += 1
    expect(command).toBe('python3')
    return '/usr/bin/python3'
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const mode = (['normal', 'abnormal', 'dispose'] as const)[this.handles.length]
    const handle = new FakeHandle(mode, 100 + this.handles.length, spec)
    this.handles.push(handle)
    return handle
  }
}

describe('ctx.subprocess lifecycle probe', () => {
  test('uses three explicit managed handles and waits for every process tree', async () => {
    const ctx = new Context()
    const runtime = new FakeRuntime()
    const release = ctx.reflect.provide('subprocess', runtime)
    const live = new Set<number>()
    const result = await runSubprocessProbe(ctx, {
      absoluteCorePath: '/owned/spike/python/spike_echo_core.py',
      ownedSpikeRoot: '/owned/spike',
      isPidAlive: (pid) => live.has(pid),
    })
    await release()

    expect(result).toMatchObject({
      status: 'PASS',
      executableResolved: true,
      handshake: true,
      echoRoundTrip: true,
      normalExit: { exitCode: 0, treeExited: true },
      abnormalExit: { exitCode: 17, classified: 'CORE_CRASHED', treeExited: true },
      dispose: { waited: true, rootGone: true, childGone: true },
    })
    expect(runtime.resolveCalls).toBe(1)
    expect(runtime.handles).toHaveLength(3)
    for (const handle of runtime.handles) {
      expect(handle.waitCalls).toBeGreaterThanOrEqual(1)
      expect(handle.spec).toMatchObject({
        argv: ['/usr/bin/python3', '/owned/spike/python/spike_echo_core.py'],
        cwd: '/owned/spike',
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16 * 1024 } },
        graceMs: 1000,
        env: { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
      })
      expect(handle.spec.env).not.toHaveProperty('DEEPSEEK_API_KEY')
      expect(Object.keys(handle.spec.env ?? {}).some((key) => key.startsWith('DSH_'))).toBe(false)
    }
    expect(runtime.handles[2].terminateCalls).toBe(1)
  })

  test('terminates and waits when the handshake path fails', async () => {
    const ctx = new Context()
    const runtime = new FakeRuntime()
    const release = ctx.reflect.provide('subprocess', runtime)
    runtime.spawn = (spec) => {
      const handle = new FakeHandle('normal', 999, spec)
      handle.stdout.destroy(new Error('fixture failed'))
      runtime.handles.push(handle)
      return handle
    }

    await expect(runSubprocessProbe(ctx, {
      absoluteCorePath: '/owned/spike/python/spike_echo_core.py',
      ownedSpikeRoot: '/owned/spike',
      isPidAlive: () => false,
    })).rejects.toThrow()
    await release()
    expect(runtime.handles[0].terminateCalls).toBe(1)
    expect(runtime.handles[0].waitCalls).toBe(1)
  })
})
