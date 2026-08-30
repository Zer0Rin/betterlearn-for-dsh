import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { writeRealModelContinuationGrant } from '../lib/acceptance/real-model-authorization.js'

function parseArgs(argv) {
  if (argv.length !== 4) throw new Error('CONTINUATION_ARGUMENTS_INVALID')
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!['--request', '--output'].includes(flag) || !isAbsolute(value ?? '') || values.has(flag)) {
      throw new Error('CONTINUATION_ARGUMENTS_INVALID')
    }
    values.set(flag, value)
  }
  const requestPath = values.get('--request')
  const outputPath = values.get('--output')
  if (!requestPath || !outputPath) throw new Error('CONTINUATION_ARGUMENTS_INVALID')
  return { requestPath, outputPath }
}

const { requestPath, outputPath } = parseArgs(process.argv.slice(2))
const grant = await writeRealModelContinuationGrant({
  outputPath,
  request: JSON.parse(await readFile(requestPath, 'utf8')),
  explicitContinuationDigest: process.env.NOBEI_PHASE1E_EXPLICIT_CONTINUATION,
})
process.stdout.write(`${grant.requestDigest}\n`)
