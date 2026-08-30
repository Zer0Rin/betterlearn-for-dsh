import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { scanRawCommand } from './phase1c-secret-scan.mjs'

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export function summarizeHttpResponse({ status, body }) {
  const bytes = Buffer.from(body, 'utf8')
  return {
    status,
    byteLength: bytes.byteLength,
    bodySha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function redactPatterns(value) {
  return value
    .replace(/Bearer\s+[^\s"']+/gi, '[REDACTED_BEARER]')
    .replace(/(?:DEEPSEEK_API_KEY|NOBEI_SPIKE_TOKEN)\s*[=:]\s*[^\s"']+/gi, '[REDACTED_ENV]')
    .replace(/sk-[a-z0-9_-]{12,}/gi, '[REDACTED_KEY]')
}

export class EvidenceRecorder {
  #index = 0
  #initialized = false

  constructor({ root, redactions = [] }) {
    this.root = root
    this.redactions = [...redactions].filter((value) => typeof value === 'string' && value.length > 0)
      .toSorted((left, right) => right.length - left.length)
  }

  redact(value) {
    let result = String(value)
    for (const secret of this.redactions) result = result.split(secret).join('[REDACTED]')
    return redactPatterns(result)
  }

  async #initialize() {
    if (this.#initialized) return
    this.#initialized = true
    try {
      const rows = (await readFile(join(this.root, 'commands.ndjson'), 'utf8'))
        .split('\n').filter(Boolean).map((line) => JSON.parse(line))
      this.#index = Math.max(0, ...rows.map((row) => Number.isInteger(row.index) ? row.index : 0))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  async run({ slug, argv, cwd, cwdLabel, env, interact, timeoutMs = 300_000 }) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new TypeError('COMMAND_SLUG_INVALID')
    if (!Array.isArray(argv) || argv.length < 1) throw new TypeError('COMMAND_ARGV_INVALID')
    await this.#initialize()
    this.#index += 1
    const prefix = `${String(this.#index).padStart(3, '0')}-${slug}`
    const commandDir = join(this.root, 'commands')
    await mkdir(commandDir, { recursive: true })
    const startedAt = new Date().toISOString()
    let stdout = ''
    let stderr = ''
    const listeners = new Set()
    let settled = false
    let exitCode = null
    let exitSignal = null
    const detached = process.platform !== 'win32'
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
      for (const listener of listeners) listener()
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
      for (const listener of listeners) listener()
    })
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        settled = true
        exitCode = code
        exitSignal = signal
        for (const listener of listeners) listener()
        resolve()
      })
    })
    const waitForOutput = (predicate, waitMs = 30_000) => new Promise((resolve, reject) => {
      const inspect = () => {
        try {
          if (predicate({ stdout, stderr })) {
            cleanup()
            resolve({ stdout, stderr })
          } else if (settled) {
            cleanup()
            reject(new Error('COMMAND_EXITED_BEFORE_EXPECTED_OUTPUT'))
          }
        } catch (error) {
          cleanup()
          reject(error)
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('COMMAND_OUTPUT_TIMEOUT'))
      }, waitMs)
      const cleanup = () => {
        clearTimeout(timer)
        listeners.delete(inspect)
      }
      listeners.add(inspect)
      inspect()
    })
    const terminate = () => {
      if (settled || !child.pid) return
      try {
        if (detached) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error
      }
    }
    let operationError
    const timeout = setTimeout(() => {
      operationError = new Error('COMMAND_TIMEOUT')
      terminate()
    }, timeoutMs)
    try {
      if (interact) {
        try {
          await interact({ child, waitForOutput, output: () => ({ stdout, stderr }) })
        } catch (error) {
          operationError = error
        } finally {
          terminate()
        }
      }
      await closed
    } catch (error) {
      operationError = error
      terminate()
      await closed.catch(() => undefined)
    } finally {
      clearTimeout(timeout)
    }
    const finishedAt = new Date().toISOString()
    const stdoutFile = `commands/${prefix}.stdout.log`
    const stderrFile = `commands/${prefix}.stderr.log`
    const findings = scanRawCommand({ argv, stdout, stderr })
    if (findings.length > 0) {
      const error = new Error('EVIDENCE_SECRET_DETECTED')
      error.findings = findings
      throw error
    }
    const redactedStdout = this.redact(stdout)
    const redactedStderr = this.redact(stderr)
    await Promise.all([
      writeFile(join(this.root, stdoutFile), redactedStdout, 'utf8'),
      writeFile(join(this.root, stderrFile), redactedStderr, 'utf8'),
    ])
    const record = {
      index: this.#index,
      argv: argv.map((value) => this.redact(value)),
      cwd: cwdLabel,
      envNames: Object.keys(env ?? {}).map((name) => {
        if (name === 'DEEPSEEK_API_KEY') return '[REDACTED_PROVIDER_CREDENTIAL_NAME]'
        if (name === 'NOBEI_SPIKE_TOKEN') return '[REDACTED_SPIKE_TOKEN_NAME]'
        return name
      }).toSorted(),
      startedAt,
      finishedAt,
      exitCode,
      signal: exitSignal,
      stdoutFile,
      stderrFile,
    }
    await writeFile(join(this.root, 'commands.ndjson'), `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' })
    const result = { ...record, stdout: redactedStdout, stderr: redactedStderr }
    if (operationError) throw Object.assign(operationError, { commandResult: result })
    return result
  }
}
