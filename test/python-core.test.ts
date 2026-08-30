import { once } from 'node:events'
import { access } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { describe, expect, test } from 'vitest'

const corePath = new URL('../python/spike_echo_core.py', import.meta.url)

async function fixtureExists(): Promise<boolean> {
  try {
    await access(corePath)
    return true
  } catch {
    return false
  }
}

class Lines {
  readonly #buffer: string[] = []
  readonly #waiters: Array<(line: string) => void> = []

  push(line: string): void {
    const waiter = this.#waiters.shift()
    if (waiter) waiter(line)
    else this.#buffer.push(line)
  }

  next(): Promise<string> {
    const line = this.#buffer.shift()
    if (line !== undefined) return Promise.resolve(line)
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  get buffered(): number {
    return this.#buffer.length
  }
}

function startCore(): {
  child: ChildProcessWithoutNullStreams
  stdout: Lines
  stderr: string[]
} {
  const env = { ...process.env }
  delete env.DEEPSEEK_API_KEY
  delete env.DSH_HOME
  delete env.DSH_TOOLS_MODE
  delete env.DSH_TELEMETRY_MODE
  const child = spawn('python3', [corePath.pathname], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout = new Lines()
  const stderr: string[] = []
  createInterface({ input: child.stdout }).on('line', (line) => stdout.push(line))
  createInterface({ input: child.stderr }).on('line', (line) => stderr.push(line))
  return { child, stdout, stderr }
}

function send(child: ChildProcessWithoutNullStreams, value: unknown): void {
  child.stdin.write(`${JSON.stringify(value)}\n`)
}

describe('disposable Python JSONL-RPC Core', () => {
  test('implements bounded handshake, requests, errors and clean shutdown', async () => {
    expect(await fixtureExists()).toBe(true)
    if (!await fixtureExists()) return

    const { child, stdout, stderr } = startCore()
    const ready = JSON.parse(await stdout.next())
    expect(ready).toMatchObject({
      jsonrpc: '2.0',
      method: 'core.ready',
      params: { protocolVersion: 1 },
    })
    expect(ready.params.pid).toBe(child.pid)

    send(child, { jsonrpc: '2.0', id: 1, method: 'echo', params: { value: '你好' } })
    expect(JSON.parse(await stdout.next())).toEqual({
      jsonrpc: '2.0', id: 1, result: { value: '你好' },
    })
    send(child, { jsonrpc: '2.0', id: 2, method: 'echo', params: { value: 42 } })
    expect(JSON.parse(await stdout.next())).toEqual({
      jsonrpc: '2.0', id: 2, result: { value: 42 },
    })

    send(child, { jsonrpc: '2.0', id: 3, method: 'env_probe', params: {} })
    expect(JSON.parse(await stdout.next())).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: {
        deepseekApiKeyPresent: false,
        dshHomePresent: false,
        dshToolsModePresent: false,
        dshTelemetryModePresent: false,
      },
    })

    send(child, { jsonrpc: '2.0', id: 4, method: 'unknown', params: {} })
    expect(JSON.parse(await stdout.next())).toMatchObject({
      jsonrpc: '2.0', id: 4, error: { code: -32601 },
    })
    send(child, { jsonrpc: '2.0', id: 4, method: 'echo', params: { value: 'duplicate' } })
    expect(JSON.parse(await stdout.next())).toMatchObject({
      jsonrpc: '2.0', id: 4, error: { code: -32600 },
    })
    child.stdin.write('{not-json}\n')
    expect(JSON.parse(await stdout.next())).toMatchObject({
      jsonrpc: '2.0', id: null, error: { code: -32700 },
    })
    child.stdin.write(`${'x'.repeat(65_536)}\n`)
    expect(JSON.parse(await stdout.next())).toMatchObject({
      jsonrpc: '2.0', id: null, error: { code: -32600 },
    })

    send(child, { jsonrpc: '2.0', id: 5, method: 'shutdown', params: {} })
    expect(JSON.parse(await stdout.next())).toEqual({
      jsonrpc: '2.0', id: 5, result: { ok: true },
    })
    const [exitCode] = await once(child, 'exit')
    expect(exitCode).toBe(0)
    expect(stderr).toContain('nobei-phase1a-core ready')
  })

  test('crashes immediately with exit code 17 and no response', async () => {
    expect(await fixtureExists()).toBe(true)
    if (!await fixtureExists()) return

    const { child, stdout } = startCore()
    await stdout.next()
    send(child, { jsonrpc: '2.0', id: 1, method: 'crash', params: {} })
    const [exitCode] = await once(child, 'exit')
    expect(exitCode).toBe(17)
    expect(stdout.buffered).toBe(0)
  })

  test('keeps child output isolated and reaps it during shutdown', async () => {
    expect(await fixtureExists()).toBe(true)
    if (!await fixtureExists()) return

    const { child, stdout } = startCore()
    await stdout.next()
    send(child, { jsonrpc: '2.0', id: 1, method: 'spawn_child', params: {} })
    const response = JSON.parse(await stdout.next())
    expect(response).toMatchObject({ jsonrpc: '2.0', id: 1, result: { childPid: expect.any(Number) } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(stdout.buffered).toBe(0)

    send(child, { jsonrpc: '2.0', id: 2, method: 'shutdown', params: {} })
    await stdout.next()
    await once(child, 'exit')
    expect(() => process.kill(response.result.childPid, 0)).toThrow()
  })
})
