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

describe('phase1 external bundle package', () => {
  test('publishes the phase1c product bundle contract', async () => {
    expect(await exists('package.json')).toBe(true)
    if (!await exists('package.json')) return

    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    expect(pkg.name).toBe('@nobei/dsh-phase1')
    expect(pkg.version).toBe('0.0.5')
    expect(pkg.dependencies['@deepseek-ai/schemastery']).toBe('3.18.1')
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh.client).toEqual({
      inject: [
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-conversation',
        '@deepseek-ai/dsh-client-ui-model-selection',
      ],
      platform: 'web',
    })
    expect(pkg.exports['.'].default).toBe('./lib/index.js')
    expect(pkg.exports['./client']).toEqual({
      types: './lib/types/client/index.d.ts',
      default: './lib/client.js',
    })
    expect(pkg.files).toEqual(expect.arrayContaining([
      'lib/**/*.js',
      'lib/types/**/*.d.ts',
      'cordis.patch.yml',
      'contracts/**/*.json',
      'python/nobei_core/**/*.py',
      'python/nobei_core/sql/**/*.sql',
    ]))
    expect(JSON.stringify(pkg.files)).not.toContain('acceptance/fake-provider')
    expect(JSON.stringify(pkg.files)).not.toContain('evidence/')
    expect(JSON.stringify(pkg.files)).not.toContain('.env')
    expect(JSON.stringify(pkg.files)).not.toContain('node_modules')
    expect(JSON.stringify(pkg.exports)).not.toContain('/src/')
  })

  test('supports rc7/rc8 peers and keeps local build dependencies exact', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    expect(pkg.peerDependencies).toMatchObject({
      '@deepseek-ai/dsh-client-runtime': '0.1.0-rc.7 || 0.1.0-rc.8',
      '@deepseek-ai/dsh-client-ui-conversation': '0.1.0-rc.7 || 0.1.0-rc.8',
      '@deepseek-ai/dsh-client-ui-model-selection': '0.1.0-rc.7 || 0.1.0-rc.8',
      '@deepseek-ai/dsh-session-query': '0.1.0-rc.7 || 0.1.0-rc.8',
      '@deepseek-ai/dsh-session-title': '0.1.0-rc.7 || 0.1.0-rc.8',
    })
    expect(pkg.devDependencies).toMatchObject({
      '@deepseek-ai/dsh-client-modules': '0.1.0-rc.7',
      '@deepseek-ai/dsh-client-runtime': '0.1.0-rc.7',
      '@deepseek-ai/dsh-client-ui-conversation': '0.1.0-rc.7',
      '@deepseek-ai/dsh-client-ui-model-selection': '0.1.0-rc.7',
      '@deepseek-ai/dsh-client-ui-slots': '0.1.0-rc.7',
      '@deepseek-ai/dsh-session-query': '0.1.0-rc.7',
      '@deepseek-ai/dsh-session-title': '0.1.0-rc.7',
      '@playwright/test': '1.62.1',
      '@types/react': '18.3.1',
      '@types/react-test-renderer': '18.3.0',
      esbuild: '0.25.12',
      react: '18.2.0',
      'react-test-renderer': '18.2.0',
    })
  })

  test('pins development dependencies and limits DSH compatibility peers', async () => {
    expect(await exists('package.json')).toBe(true)
    if (!await exists('package.json')) return

    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    for (const field of ['peerDependencies', 'devDependencies'] as const) {
      for (const [name, version] of Object.entries(pkg[field] ?? {})) {
        if (field === 'peerDependencies' && name.startsWith('@deepseek-ai/dsh-')) {
          expect(version).toBe('0.1.0-rc.7 || 0.1.0-rc.8')
          continue
        }
        expect(version, `${field}.${name}`).toMatch(/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/)
      }
    }
  })

  test('does not stage legacy v8 migrations before testing or packing', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    expect(pkg.scripts['stage:v8']).toBeUndefined()
    expect(pkg.scripts.pretest).not.toContain('stage:v8')
    expect(pkg.scripts.prepack).not.toContain('stage:v8')
  })
})


test('ships lifecycle CLI and instructions, fake provider has no runtime rc7 dependency', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  expect(pkg.bin).toEqual({ betterlearn: 'bin/betterlearn.mjs' })
  expect(pkg.files).toEqual(expect.arrayContaining(['bin/betterlearn.mjs', 'docs/install.md']))
  const fake = JSON.parse(await readFile('acceptance/fake-provider/package.json', 'utf8'))
  expect(fake.dependencies).toBeUndefined()
  expect(fake.peerDependencies['@deepseek-ai/dsh-llm']).toBe('0.1.0-rc.7 || 0.1.0-rc.8')
  expect(fake.devDependencies['@deepseek-ai/dsh-llm']).toBe('0.1.0-rc.7')
})
