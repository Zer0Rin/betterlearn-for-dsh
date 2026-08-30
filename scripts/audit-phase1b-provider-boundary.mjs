#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const coreRoot = join(packageRoot, 'python', 'nobei_core')
const verifierPath = join(packageRoot, 'scripts', 'verify-phase1b-core.mjs')
const forbiddenEnvironment = /^(?:DEEPSEEK|OPENAI|ANTHROPIC)[_-]?(?:API[_-]?KEY|TOKEN)$/i
const forbiddenPythonImport = /^\s*(?:from|import)\s+(?:socket|urllib|http|requests|subprocess|openai|anthropic|deepseek)\b/m
const forbiddenVerifierCapability = /(?:from\s+['"]node:(?:http|https|net|tls)['"]|\bfetch\s*\(|dsh-llm|accept-spike\.mjs\s+execute)/

async function main() {
  if (Object.keys(process.env).some((name) => forbiddenEnvironment.test(name))) {
    throw new Error('PROVIDER_CREDENTIAL_PRESENT')
  }
  const names = (await readdir(coreRoot)).filter((name) => name.endsWith('.py')).sort()
  if (!names.length || !names.includes('__init__.py')) throw new Error('PROVIDER_AUDIT_INVALID')
  for (const name of names) {
    const source = await readFile(join(coreRoot, name), 'utf8')
    if (forbiddenPythonImport.test(source)) throw new Error(`PROVIDER_CAPABILITY_PRESENT:${basename(name)}`)
  }
  const verifier = await readFile(verifierPath, 'utf8')
  if (forbiddenVerifierCapability.test(verifier)) throw new Error('VERIFIER_PROVIDER_CAPABILITY_PRESENT')
  process.stdout.write(`${JSON.stringify({
    providerCapability: 'ABSENT',
    auditedFiles: names.length + 1,
  })}\n`)
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${String(error?.message ?? 'PROVIDER_AUDIT_FAILED')}\n`)
  process.exitCode = 1
}
