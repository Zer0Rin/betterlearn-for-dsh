import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'
import { GENERATION_SCHEMA_INVALID, loadCandidateContract } from '../src/product/contract.js'

const execFile = promisify(execFileCallback)
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const schemaPath = fileURLToPath(new URL('../contracts/l1-candidate.schema.json', import.meta.url))

function validCandidates(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    candidates: [{
      type: 'concept',
      title: 'Photosynthesis',
      statement: 'Plants convert light energy into chemical energy.',
      evidence: [{
        quote: 'Plants convert light energy into chemical energy.',
        prefix: '',
        suffix: '',
      }],
    }],
  }
}

async function pythonSha256(path: string): Promise<string> {
  const program = [process.env.NOBEI_PHASE1_PYTHON, '/opt/homebrew/bin/python3.12', 'python3.12']
    .find((candidate): candidate is string => Boolean(candidate))
  if (!program) throw new Error('PYTHON_3_12_NOT_FOUND')
  const { stdout } = await execFile(program, [
    '-c',
    'import hashlib, pathlib, sys; print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())',
    path,
  ])
  return stdout.trim()
}

describe('canonical candidate contract', () => {
  test('loads the Draft 2020-12 resource', () => {
    const contract = loadCandidateContract(packageRoot)

    expect(contract.schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(contract.schemaVersion).toBe(1)
    expect(GENERATION_SCHEMA_INVALID).toBe('GENERATION_SCHEMA_INVALID')
  })

  test('accepts a valid candidate fixture', () => {
    expect(loadCandidateContract(packageRoot).validate(validCandidates())).toEqual([])
  })

  test('rejects an extra top-level field without a validator message', () => {
    expect(loadCandidateContract(packageRoot).validate({
      schemaVersion: 1,
      candidates: [],
      extra: true,
    })).toEqual([{ path: '', keyword: 'additionalProperties' }])
  })

  test('matches the SHA-256 printed by Python for the same resource bytes', async () => {
    const contract = loadCandidateContract(packageRoot)
    const resource = await readFile(schemaPath)

    expect(contract.schemaSha256).toBe(createHash('sha256').update(resource).digest('hex'))
    await expect(pythonSha256(schemaPath)).resolves.toBe(contract.schemaSha256)
  })

  test('fails closed when a future schema contains a $ref', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'nobei-contract-'))
    const temporarySchemaPath = join(temporaryRoot, 'contracts', 'l1-candidate.schema.json')
    await mkdir(dirname(temporarySchemaPath), { recursive: true })
    await writeFile(temporarySchemaPath, JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: 'https://example.invalid/schema.json',
    }), 'utf8')

    try {
      expect(() => loadCandidateContract(temporaryRoot)).toThrow('CANDIDATE_CONTRACT_REFERENCES_FORBIDDEN')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
})
