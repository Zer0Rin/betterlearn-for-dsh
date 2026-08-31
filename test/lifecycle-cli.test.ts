import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { parseArguments } from '../bin/betterlearn.mjs'
const exec = promisify(execFile)
const cli = resolve('bin/betterlearn.mjs')
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'betterlearn cli ')); temporary.push(home)
  const log = join(home, 'argv.json')
  const tool = join(home, 'fake executable.mjs')
  await writeFile(tool, `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({argv:process.argv.slice(2), dshHome:process.env.DSH_HOME, data:process.env.NOBEI_PHASE1C_DATA_ROOT, python:process.env.NOBEI_PHASE1C_PYTHON_EXECUTABLE, pythonPath:process.env.PYTHONPATH, token:process.env.NOBEI_PHASE1C_OWNERSHIP_TOKEN}));\n`)
  await chmod(tool, 0o700)
  const config = { kind: 'betterlearn-local-v1', dsh: tool, python: tool, dshVersion: '0.1.0-rc.8', dshHome: join(home, 'dsh'), dataRoot: join(home, 'data'), packageRoot: join(home, 'packages', 'current'), ownershipToken: 'private-test-token', packageFile: join(home, 'old.tgz') }
  await writeFile(join(home, 'config.json'), JSON.stringify(config), { mode: 0o600 })
  return { home, log, config }
}
test.each([
  ['install', '--home', '/x'], ['start', '--home', '/x', '--port', '65536'],
  ['backup', '--home', '/x'], ['restore', '--home', '/x'],
  ['start', '--home', '/x', '--unknown', 'x'], ['uninstall', '--home', '/x', '--home', '/y'],
])('rejects invalid lifecycle argv %j', argv => { expect(() => parseArguments(argv)).toThrow() })
test('start isolates profile/environment and safely forwards paths with spaces', async () => {
  const { home, log, config } = await fixture()
  const result = await exec(process.execPath, [cli, 'start', '--home', home, '--port', '3001'])
  const call = JSON.parse(await readFile(log, 'utf8'))
  expect(call).toEqual({ argv: ['--profile', 'betterlearn', '--port', '3001'], dshHome: config.dshHome, data: config.dataRoot, python: config.python, pythonPath: join(config.packageRoot, 'python'), token: config.ownershipToken })
  expect(result.stdout + result.stderr).not.toContain(config.ownershipToken)
})
test.each(['backup', 'restore'])('%s forwards packaged maintenance entry without DSH restart', async command => {
  const { home, log, config } = await fixture()
  const file = join(home, 'backup with spaces.sqlite')
  const result = await exec(process.execPath, [cli, command, '--home', home, command === 'backup' ? '--to' : '--from', file])
  const call = JSON.parse(await readFile(log, 'utf8'))
  expect(call.argv).toEqual(['-m', 'nobei_core.maintenance', command, '--data-root', config.dataRoot,
    ...(command === 'backup' ? ['--to', file] : ['--ownership-token', config.ownershipToken, '--from', file, '--backup-dir', join(home, 'backups')])])
  expect(result.stdout + result.stderr).not.toContain(config.ownershipToken)
  expect((await stat(join(home, 'config.json'))).mode & 0o777).toBe(0o600)
})
test('install refuses unknown existing data before package, Python or DSH writes', async () => {
  const { home, log, config } = await fixture()
  await rm(join(home, 'config.json'))
  await mkdir(config.dataRoot)
  await writeFile(join(config.dataRoot, 'unknown'), 'keep this')
  await expect(exec(process.execPath, [cli, 'install', '--home', home, '--dsh', config.dsh, '--dsh-version', '0.1.0-rc.8', '--package', join(home, 'missing.tgz')])).rejects.toThrow('Refusing to initialize nonempty unknown data directory')
  expect(await readFile(join(config.dataRoot, 'unknown'), 'utf8')).toBe('keep this')
  await expect(stat(log)).rejects.toThrow()
})


test('start forwards SIGTERM and waits for the child to exit without orphaning it', async () => {
  const { home, config } = await fixture()
  const ready = join(home, 'ready')
  const stopped = join(home, 'stopped')
  await writeFile(config.dsh, `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); process.on('SIGTERM', () => { setTimeout(() => { fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0) }, 50) }); setInterval(() => {}, 1000);\n`)
  const child = spawn(process.execPath, [cli, 'start', '--home', home], { stdio: 'ignore' })
  const done = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  try {
    await expect.poll(async () => { try { return await readFile(ready, 'utf8') } catch { return '' } }).not.toBe('')
    const pid = Number(await readFile(ready, 'utf8'))
    child.kill('SIGTERM')
    expect(await done).toEqual({ code: 0, signal: null })
    expect(await readFile(stopped, 'utf8')).toBe('stopped')
    expect(() => process.kill(pid, 0)).toThrow()
  } finally { child.kill('SIGKILL') }
})
