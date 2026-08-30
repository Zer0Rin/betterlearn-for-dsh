import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'

const source = new URL('../vendor/schema-v8/', import.meta.url)
const staged = new URL('../python/nobei_core/sql/v8/', import.meta.url)

describe('schema-v8 package assets', () => {
  test('contains byte-identical migrations 001 through 008', async () => {
    const expected = (await readdir(source))
      .filter((name) => /^(00[1-8])_.+\.sql$/.test(name)).sort()
    const actual = (await readdir(staged)).filter((name) => name.endsWith('.sql')).sort()
    expect(actual).toEqual(expected)
    for (const name of expected) {
      const [left, right] = await Promise.all([
        readFile(new URL(name, source)), readFile(new URL(name, staged)),
      ])
      expect(createHash('sha256').update(right).digest('hex'))
        .toBe(createHash('sha256').update(left).digest('hex'))
    }
  })
})
