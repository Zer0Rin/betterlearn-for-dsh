import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { CLIENT_SEAM_PACKAGES, CRITICAL_PROFILE_PACKAGES } from '../scripts/dsh-topology.mjs'

const RC7 = '0.1.0-rc.7'
const RC7_COMMIT = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'

describe('rc.7 pinset', () => {
  test('pins every runtime seam to the audited rc.7 release', async () => {
    const [pinsetText, packageText] = await Promise.all([
      readFile('config/dsh-rc7-pins.json', 'utf8'),
      readFile('package.json', 'utf8'),
    ])
    const pinset = JSON.parse(pinsetText) as {
      release: string
      tagCommit: string
      packages: Record<string, string>
    }
    const manifest = JSON.parse(packageText) as {
      peerDependencies: Record<string, string>
      devDependencies: Record<string, string>
    }

    expect(pinset.release).toBe(RC7)
    expect(pinset.tagCommit).toBe(RC7_COMMIT)
    for (const name of [...CRITICAL_PROFILE_PACKAGES, ...CLIENT_SEAM_PACKAGES]) {
      expect(pinset.packages[name], name).toBe(RC7)
    }
    for (const [name, version] of Object.entries(pinset.packages)) {
      if (name.startsWith('@deepseek-ai/dsh')) expect(version, name).toBe(RC7)
    }
    for (const dependencies of [manifest.peerDependencies, manifest.devDependencies]) {
      for (const [name, version] of Object.entries(dependencies)) {
        if (name.startsWith('@deepseek-ai/dsh')) expect(version, name).toBe(RC7)
      }
    }
  })
})
