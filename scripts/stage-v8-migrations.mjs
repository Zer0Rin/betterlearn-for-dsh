import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceRoot = resolve(packageRoot, '..', 'nobei-backend-2', 'db', 'migrations')
const destinationRoot = resolve(packageRoot, 'python', 'nobei_core', 'sql', 'v8')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

const entries = (await readdir(sourceRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /^(00[1-8])_.+\.sql$/.test(entry.name))
  .map((entry) => entry.name).sort()
if (entries.length !== 8) throw new Error('V8_MIGRATION_SET_INVALID')
await rm(destinationRoot, { recursive: true, force: true })
await mkdir(destinationRoot, { recursive: true })
const manifest = []
for (const [index, name] of entries.entries()) {
  if (!name.startsWith(`${String(index + 1).padStart(3, '0')}_`)) {
    throw new Error('V8_MIGRATION_SEQUENCE_INVALID')
  }
  const bytes = await readFile(join(sourceRoot, name))
  await writeFile(join(destinationRoot, name), bytes, { flag: 'wx' })
  manifest.push({ version: index + 1, name, sha256: sha256(bytes) })
}
await writeFile(join(destinationRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
