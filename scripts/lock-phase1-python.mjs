import { access, constants, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const python = process.env.NOBEI_PHASE1_PYTHON ?? '/opt/homebrew/bin/python3.12'

function run(argv, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    let stdout = ''
    const child = spawn(argv[0], argv.slice(1), { ...options, stdio: ['ignore', 'pipe', 'inherit'] })
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun(stdout)
      else rejectRun(new Error(`PHASE1_LOCK_COMMAND_FAILED:${argv[0]}:${code ?? signal}`))
    })
  })
}

async function assertPython312() {
  await access(python, constants.X_OK)
  const version = (await run([python, '-c', 'import sys; print(sys.version)'])).trim()
  if (!version.startsWith('3.12.')) throw new Error(`PYTHON_VERSION_INVALID:${version}`)
}

async function validateRequirements(requirementsPath, seen = new Set()) {
  const absolutePath = resolve(requirementsPath)
  if (seen.has(absolutePath)) throw new Error('PYTHON_REQUIREMENTS_CYCLE')
  seen.add(absolutePath)
  for (const rawLine of (await readFile(absolutePath, 'utf8')).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('-r ')) {
      const include = line.slice(3).trim()
      if (!include || include.includes('/') || include.includes('\\')) throw new Error('PYTHON_REQUIREMENT_LOCAL_PATH_FORBIDDEN')
      await validateRequirements(join(resolve(absolutePath, '..'), include), seen)
      continue
    }
    if (
      line.startsWith('-e') || line.includes('://') || line.startsWith('file:')
      || line.includes('@') || line.startsWith('.') || line.startsWith('/') || line.startsWith('~')
    ) throw new Error('PYTHON_REQUIREMENT_SOURCE_FORBIDDEN')
    if (!/^[A-Za-z0-9_.-]+==[A-Za-z0-9_.!+~-]+$/.test(line)) throw new Error('PYTHON_REQUIREMENT_INVALID')
  }
}

async function assertLockAbsent(lockPath) {
  try {
    await access(lockPath)
    throw new Error(`PYTHON_LOCK_EXISTS:${lockPath}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function writeLock(requirementsName, lockName) {
  const requirementsPath = join(packageRoot, 'python', requirementsName)
  const lockPath = join(packageRoot, 'python', lockName)
  await validateRequirements(requirementsPath)
  const tempRoot = await mkdtemp(join(tmpdir(), 'nobei-phase1-lock-'))
  try {
    const venvRoot = join(tempRoot, 'venv')
    const venvPython = join(venvRoot, 'bin', 'python')
    await run([python, '-m', 'venv', venvRoot])
    await run([venvPython, '-m', 'pip', 'install', '-r', requirementsPath])
    const lockText = (await run([venvPython, '-m', 'pip', 'freeze']))
      .split(/\r?\n/).filter(Boolean).sort((left, right) => left.localeCompare(right)).join('\n') + '\n'
    await writeFile(lockPath, lockText, { flag: 'wx' })
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

await assertPython312()
await assertLockAbsent(join(packageRoot, 'python', 'requirements-phase1.lock'))
await assertLockAbsent(join(packageRoot, 'python', 'requirements-phase1-dev.lock'))
await writeLock('requirements-phase1.txt', 'requirements-phase1.lock')
await writeLock('requirements-phase1-dev.txt', 'requirements-phase1-dev.lock')
