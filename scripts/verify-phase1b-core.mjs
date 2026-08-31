#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function assertProductSchemaAssets(root = packageRoot) {
  const sqlRoot = join(root, 'python', 'nobei_core', 'sql')
  const expectedSchema = join(sqlRoot, '001_product.sql')
  if (!await exists(expectedSchema)) throw new Error('PRODUCT_SCHEMA_MISSING')
  const sqlFiles = (await readdir(sqlRoot)).filter((name) => name.endsWith('.sql')).sort()
  if (sqlFiles.join('\0') !== '001_product.sql') throw new Error('PRODUCT_SCHEMA_SET_INVALID')
  if (await exists(join(root, 'vendor', 'schema-v8')) || await exists(join(sqlRoot, 'v8'))) {
    throw new Error('LEGACY_V8_SCHEMA_PRESENT')
  }
  return { schema: '001_product.sql' }
}

export async function verifyProductSchemaPackage(root = packageRoot) {
  await assertProductSchemaAssets(root)
  const outputDirectory = await mkdtemp(join(tmpdir(), 'betterlearn-product-schema-pack-'))
  try {
    await run('pnpm', ['pack', '--pack-destination', outputDirectory], { cwd: root })
    const tarballs = (await readdir(outputDirectory)).filter((name) => name.endsWith('.tgz'))
    if (tarballs.length !== 1) throw new Error('PACKAGE_TARBALL_INVALID')
    const { stdout } = await run('tar', ['-tzf', join(outputDirectory, tarballs[0])])
    const entries = stdout.trim().split('\n').filter(Boolean)
    if (!entries.includes('package/python/nobei_core/sql/001_product.sql')) {
      throw new Error('PRODUCT_SCHEMA_NOT_PACKAGED')
    }
    if (entries.some((entry) => entry.includes('/sql/v8/') || entry.includes('schema-v8') || entry.endsWith('/phase1_schema.sql'))) {
      throw new Error('LEGACY_SCHEMA_PACKAGED')
    }
    return { schema: '001_product.sql', packageEntries: entries.length }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyProductSchemaPackage()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${String(error?.message ?? 'PRODUCT_SCHEMA_PACKAGE_VERIFICATION_FAILED')}\n`)
      process.exitCode = 1
    })
}
