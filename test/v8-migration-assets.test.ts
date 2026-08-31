import { access, readdir } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

const sqlDirectory = new URL('../python/nobei_core/sql/', import.meta.url)
const productSchema = new URL('../python/nobei_core/sql/001_product.sql', import.meta.url)
const legacySchemaSource = new URL('../vendor/schema-v8/', import.meta.url)
const legacyStagedSchema = new URL('../python/nobei_core/sql/v8/', import.meta.url)

async function exists(url: URL): Promise<boolean> {
  try {
    await access(url)
    return true
  } catch {
    return false
  }
}

describe('product schema package assets', () => {
  test('ships the single product migration and no v8 staging assets', async () => {
    expect(await exists(productSchema)).toBe(true)
    expect((await readdir(sqlDirectory)).filter((name) => name.endsWith('.sql')).sort())
      .toEqual(['001_product.sql'])
    expect(await exists(legacySchemaSource)).toBe(false)
    expect(await exists(legacyStagedSchema)).toBe(false)
  })
})
