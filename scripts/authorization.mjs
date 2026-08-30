import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createAuthorizationRequest } from '../lib/spike/authorization.js'

function parseArgs(argv) {
  const allowed = new Set(['--artifact', '--prompt', '--schema', '--output'])
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(flag) || !value || values.has(flag)) throw new Error('AUTHORIZATION_ARGUMENTS_INVALID')
    values.set(flag, value)
  }
  if (values.size !== allowed.size || [...values.values()].some((value) => !isAbsolute(value))) {
    throw new Error('AUTHORIZATION_ARGUMENTS_INVALID')
  }
  return values
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

const args = parseArgs(process.argv.slice(2))
const request = createAuthorizationRequest({
  version: 1,
  artifactSha256: await sha256(args.get('--artifact')),
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  maxCalls: 3,
  promptSha256: await sha256(args.get('--prompt')),
  schemaSha256: await sha256(args.get('--schema')),
  purpose: 'phase1a-public-seam-spike',
})
await writeFile(args.get('--output'), `${JSON.stringify(request, null, 2)}\n`, { flag: 'wx' })
process.stdout.write(`${request.requestDigest}\n`)
