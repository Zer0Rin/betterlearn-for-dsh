import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  verifyRealModelAuthorizationRequest,
  writeRealModelAuthorizationGrant,
} from '../lib/acceptance/real-model-authorization.js'

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
const request = verifyRealModelAuthorizationRequest(JSON.parse(await readFile(args.get('--request'), 'utf8')))
const grant = await writeRealModelAuthorizationGrant({
  outputPath: args.get('--output'),
  request,
  explicitAuthorizationDigest: process.env.NOBEI_PHASE1E_EXPLICIT_AUTHORIZATION,
})
process.stdout.write(`${grant.requestDigest}\n`)
