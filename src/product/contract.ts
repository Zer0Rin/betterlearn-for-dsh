import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'

export const GENERATION_SCHEMA_INVALID = 'GENERATION_SCHEMA_INVALID'

export interface CandidateContractValidationError {
  path: string
  keyword: string
}

export interface CandidateContract {
  schema: Record<string, unknown>
  schemaVersion: number
  schemaSha256: string
  validate(value: unknown): CandidateContractValidationError[]
}

const schemaResource = ['contracts', 'l1-candidate.schema.json']

function rejectsReferences(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(rejectsReferences)
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => key === '$ref' || rejectsReferences(child))
}

function schemaVersion(schema: Record<string, unknown>): number {
  const properties = schema.properties
  if (properties === null || typeof properties !== 'object') {
    throw new Error('CANDIDATE_CONTRACT_SCHEMA_VERSION_MISSING')
  }
  const versionProperty = (properties as Record<string, unknown>).schemaVersion
  if (versionProperty === null || typeof versionProperty !== 'object') {
    throw new Error('CANDIDATE_CONTRACT_SCHEMA_VERSION_MISSING')
  }
  const version = (versionProperty as Record<string, unknown>).const
  if (typeof version !== 'number') throw new Error('CANDIDATE_CONTRACT_SCHEMA_VERSION_MISSING')
  return version
}

export function loadCandidateContract(packageRoot: string): CandidateContract {
  const schemaPath = join(packageRoot, ...schemaResource)
  const schemaBytes = readFileSync(schemaPath)
  const schema = JSON.parse(schemaBytes.toString('utf8')) as Record<string, unknown>
  if (rejectsReferences(schema)) throw new Error('CANDIDATE_CONTRACT_REFERENCES_FORBIDDEN')

  const ajv = new Ajv2020({ allErrors: true, strict: true })
  const validator = ajv.compile(schema)

  return {
    schema,
    schemaVersion: schemaVersion(schema),
    schemaSha256: createHash('sha256').update(schemaBytes).digest('hex'),
    validate(value: unknown): CandidateContractValidationError[] {
      if (validator(value)) return []
      return (validator.errors ?? [])
        .map((error) => ({ path: error.instancePath, keyword: error.keyword }))
        .sort((left, right) => left.path.localeCompare(right.path) || left.keyword.localeCompare(right.keyword))
    },
  }
}
