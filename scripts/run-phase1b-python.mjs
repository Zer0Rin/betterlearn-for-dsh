import { access, constants } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const venvRoot = join(packageRoot, '.venv-phase1b')
const venvPython = join(venvRoot, 'bin', 'python')
const candidates = [
  process.env.NOBEI_PHASE1_PYTHON,
  '/opt/homebrew/bin/python3.12',
  'python3.12',
].filter(Boolean)

function run(argv, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', ...options })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`PHASE1_PYTHON_COMMAND_FAILED:${argv[0]}:${code ?? signal}`))
    })
  })
}

async function usablePython(candidate) {
  try {
    if (candidate.includes('/')) await access(candidate, constants.X_OK)
    const version = await new Promise((resolveVersion, rejectVersion) => {
      let stdout = ''
      const child = spawn(candidate, ['-c', 'import sys; print(sys.version)'])
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.once('error', rejectVersion)
      child.once('exit', (code) => code === 0 ? resolveVersion(stdout.trim()) : rejectVersion(new Error('PYTHON_VERSION_PROBE_FAILED')))
    })
    if (!version.startsWith('3.12.')) throw new Error(`PYTHON_VERSION_INVALID:${version}`)
    return candidate
  } catch (error) {
    if (String(error.message).startsWith('PYTHON_VERSION_INVALID:')) throw error
    return undefined
  }
}

let python
for (const candidate of candidates) {
  python = await usablePython(candidate)
  if (python) break
}
if (!python) throw new Error('PYTHON_3_12_NOT_FOUND')

await run([python, '-m', 'venv', venvRoot])
await run([venvPython, '-m', 'pip', 'install', '-r', join(packageRoot, 'python', 'requirements-phase1-dev.lock')])
const selectors = process.argv.slice(2)
await run([
  venvPython,
  '-m',
  'pytest',
  ...(selectors.length > 0 ? selectors : ['python/tests']),
  '-q',
], {
  cwd: packageRoot,
  env: { ...process.env, PYTHONPATH: join(packageRoot, 'python') },
})
