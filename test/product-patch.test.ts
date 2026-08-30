import { readFile } from 'node:fs/promises'
import { DEFAULT_SCHEMA, load as parseYaml, Schema, Type } from 'js-yaml'
import { describe, expect, test } from 'vitest'

type PatchEntry = { id?: string, disabled?: boolean }

async function patchEntries(path: string): Promise<PatchEntry[]> {
  const cordisExpression = new Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: (value) => value,
  })
  const value = parseYaml(await readFile(path, 'utf8'), {
    schema: new Schema({
      implicit: DEFAULT_SCHEMA.implicit,
      explicit: [...DEFAULT_SCHEMA.explicit, cordisExpression],
    }),
  })
  if (!Array.isArray(value)) throw new Error('PATCH_NOT_LIST')
  return value as PatchEntry[]
}

function disabled(entries: PatchEntry[], id: string): boolean {
  return entries.some((entry) => entry.id === id && entry.disabled === true)
}

describe('Phase 1E provider patch ownership', () => {
  test('keeps real provider adapters enabled in the product patch', async () => {
    const product = await patchEntries('cordis.patch.yml')
    expect(disabled(product, 'llm-deepseek')).toBe(false)
    expect(disabled(product, 'llm-pi-ai')).toBe(false)
  })

  test('keeps real provider adapters disabled only in the fake acceptance patch', async () => {
    const fake = await patchEntries('acceptance/fake-provider/cordis.patch.yml')
    expect(disabled(fake, 'llm-deepseek')).toBe(true)
    expect(disabled(fake, 'llm-pi-ai')).toBe(true)
  })
})
