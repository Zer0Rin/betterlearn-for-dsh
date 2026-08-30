import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { verifyGrant } from '../lib/spike/authorization.js'

function parseArgs(argv) {
  if (argv.length !== 4) throw new Error('AUTHORIZATION_ARGUMENTS_INVALID')
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!['--request', '--output'].includes(flag) || !value || values.has(flag) || !isAbsolute(value)) {
      throw new Error('AUTHORIZATION_ARGUMENTS_INVALID')
    }
    values.set(flag, value)
  }
  if (!values.has('--request') || !values.has('--output')) throw new Error('AUTHORIZATION_ARGUMENTS_INVALID')
  return values
}

const args = parseArgs(process.argv.slice(2))
const request = JSON.parse(await readFile(args.get('--request'), 'utf8'))
if (process.env.NOBEI_PHASE1A_EXPLICIT_AUTHORIZATION !== request.requestDigest) {
  throw new Error('EXPLICIT_USER_AUTHORIZATION_REQUIRED')
}

const grant = {
  version: 1,
  requestDigest: request.requestDigest,
  authorizedProvider: request.provider,
  authorizedModel: request.model,
  authorizedMaxCalls: request.maxCalls,
  authorizedAt: new Date().toISOString(),
  authorizationSource: 'explicit-user-confirmation-in-active-codex-task',
}
verifyGrant(grant, request)
await writeFile(args.get('--output'), `${JSON.stringify(grant, null, 2)}\n`, { flag: 'wx' })
process.stdout.write(`${grant.requestDigest}\n`)
