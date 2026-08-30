#!/usr/bin/env node
import { createInterface } from 'node:readline'

const schemaSha256 = process.env.NOBEI_FIXTURE_SCHEMA_SHA256 ?? 'a'.repeat(64)
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

for await (const line of lines) {
  const request = JSON.parse(line)
  if (request.method !== 'system.hello') continue
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    result: {
      protocolVersion: 3,
      coreVersion: 'phase1e',
      databaseKind: 'sqlite',
      capabilities: [
        'l1-text-extraction',
        'atomic-generation-commands',
        'model-selection-snapshot',
      ],
      schemaVersion: 1,
      schemaSha256,
      dataRootKind: 'isolated-phase1',
    },
  })}\n`)
}
