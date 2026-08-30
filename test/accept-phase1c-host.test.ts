import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  FAKE_MODEL_SELECTION,
  acceptanceRegistryConfig,
  assertAcceptanceProfileLayers,
  buildAcceptanceEnvironment,
  descendantPidsFromProcessTable,
  parseDshReadyUrl,
  productRequestHeaders,
} from '../scripts/accept-phase1c-host.mjs'

const fakeProviderPatchPath = fileURLToPath(
  new URL('../acceptance/fake-provider/cordis.patch.yml', import.meta.url),
)

describe('Phase 1C acceptance runner contract', () => {
  test('renders an optional registry config for DSH profile subprocesses', () => {
    expect(acceptanceRegistryConfig({ PNPM_CONFIG_REGISTRY: 'https://registry.example.test' }))
      .toBe('registry=https://registry.example.test\n')
    expect(acceptanceRegistryConfig({})).toBeUndefined()
  })

  test('builds a minimal provider-neutral environment', () => {
    const env = buildAcceptanceEnvironment({
      PATH: '/bin', HOME: '/private', HTTP_PROXY: 'http://127.0.0.1:1',
      DEEPSEEK_BASE_URL: 'http://example.invalid', DEEPSEEK_API_KEY: 'secret',
      COREPACK_HOME: '/private/corepack', PNPM_CONFIG_REGISTRY: 'https://registry.example.test',
    }, {
      home: '/tmp/home', dshHome: '/tmp/dsh', python: '/tmp/venv/bin/python',
      dataRoot: '/tmp/data', ownershipToken: 'o'.repeat(48), ledgerToken: 'l'.repeat(48),
    })
    expect(env).toMatchObject({
      PATH: '/bin', HOME: '/tmp/home', DSH_HOME: '/tmp/dsh',
      NOBEI_PHASE1C_PYTHON_EXECUTABLE: '/tmp/venv/bin/python',
      NOBEI_PHASE1C_DATA_ROOT: '/tmp/data',
      COREPACK_HOME: '/private/corepack',
      PNPM_CONFIG_REGISTRY: 'https://registry.example.test',
    })
    expect(env).not.toHaveProperty('HTTP_PROXY')
    expect(env).not.toHaveProperty('DEEPSEEK_BASE_URL')
    expect(env).not.toHaveProperty('DEEPSEEK_API_KEY')
  })

  test('extracts exactly one headless ready URL', () => {
    expect(parseDshReadyUrl('ready\ndsh web: http://127.0.0.1:43123\n'))
      .toBe('http://127.0.0.1:43123')
    expect(() => parseDshReadyUrl('')).toThrow('DSH_READINESS_LINE_INVALID')
    expect(() => parseDshReadyUrl('dsh web: http://127.0.0.1:1\ndsh web: http://127.0.0.1:2'))
      .toThrow('DSH_READINESS_LINE_INVALID')
  })

  test('uses same-origin JSON headers without browser automation', () => {
    expect(productRequestHeaders('http://127.0.0.1:43123')).toEqual({
      origin: 'http://127.0.0.1:43123',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    })
  })

  test('freezes the fake acceptance model and disables real provider adapters', () => {
    expect(FAKE_MODEL_SELECTION).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })

    const patch = readFileSync(fakeProviderPatchPath, 'utf8')
    expect(patch).toMatch(/- id: llm-deepseek\s+disabled: true/)
    expect(patch).toMatch(/- id: llm-pi-ai\s+disabled: true/)
  })

  test('finds the complete Core descendant tree from a process table', () => {
    const table = '10 1 dsh\n11 10 python -m nobei_core.main\n12 11 helper\n20 1 unrelated\n'
    expect(descendantPidsFromProcessTable(table, 10)).toEqual([11, 12])
  })

  test('requires a product baseline before the test-only fake layer', () => {
    const baseline = { dependencies: {
      '@deepseek-ai/dsh-base': '0.1.0-rc.7',
      '@deepseek-ai/dsh-web-app': '0.1.0-rc.7',
      '@nobei/dsh-phase1': 'file:product.tgz',
    } }
    const acceptance = { dependencies: {
      ...baseline.dependencies,
      '@nobei/dsh-phase1c-fake-provider': 'file:fake.tgz',
    } }
    expect(assertAcceptanceProfileLayers(baseline, acceptance)).toEqual({
      product: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@nobei/dsh-phase1'],
      acceptance: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@nobei/dsh-phase1', '@nobei/dsh-phase1c-fake-provider'],
    })
    expect(() => assertAcceptanceProfileLayers(acceptance, acceptance))
      .toThrow('PRODUCT_PROFILE_LAYER_INVALID')
    expect(() => assertAcceptanceProfileLayers(baseline, baseline))
      .toThrow('ACCEPTANCE_PROFILE_LAYER_INVALID')
  })
})
