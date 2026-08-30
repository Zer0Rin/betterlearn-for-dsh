import { access, readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('rc.7 pinset', () => {
  test('is byte-identical to the audited phase0 pinset', async () => {
    expect(await exists('config/dsh-rc7-pins.json')).toBe(true)
    if (!await exists('config/dsh-rc7-pins.json')) return

    const [actual, audited] = await Promise.all([
      readFile('config/dsh-rc7-pins.json', 'utf8'),
      readFile('../dsh-phase0/config/dsh-rc7-pins.json', 'utf8'),
    ])
    expect(actual).toBe(audited)
  })
})
