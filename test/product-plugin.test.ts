import { describe, expect, test, vi } from 'vitest'
import {
  applyProductPlugin,
  inject,
  name,
  type ProductPluginDependencies,
} from '../src/product/plugin.js'

const config = {
  pythonExecutable: '/owned/python3.12',
  dataRoot: '/owned/nobei-phase1c',
  ownershipToken: 't'.repeat(32),
}

function dependencies(options: { startError?: Error } = {}) {
  const order: string[] = []
  const supervisor = {
    state: 'STARTING',
    start: vi.fn(async () => {
      order.push('supervisor:start')
      if (options.startError) throw options.startError
      supervisor.state = 'READY'
    }),
    withReadyClient: vi.fn(),
    poison: vi.fn(),
    dispose: vi.fn(async () => { order.push('supervisor:dispose') }),
  }
  const coordinator = {
    launchImport: vi.fn(),
    launchRetry: vi.fn(),
    dispose: vi.fn(async () => { order.push('coordinator:dispose') }),
  }
  const resolver = { resolve: vi.fn() }
  const deps: ProductPluginDependencies = {
    packageRoot: '/owned/package',
    loadContract: vi.fn(() => ({
      schema: { type: 'object' }, schemaVersion: 1, schemaSha256: 'a'.repeat(64), validate: () => [],
    })),
    createLedger: vi.fn(() => ({ records: [] }) as never),
    installLedger: vi.fn(() => {
      order.push('ledger:install')
      return () => { order.push('ledger:dispose') }
    }),
    createSupervisor: vi.fn(() => supervisor as never),
    createAdapter: vi.fn(() => ({}) as never),
    createModelSelectionResolver: vi.fn(() => resolver as never),
    createCoordinator: vi.fn(() => coordinator as never),
    registerRoutes: vi.fn(() => {
      order.push('routes:register')
      return () => { order.push('routes:dispose') }
    }),
  }
  return { deps, order, supervisor, coordinator, resolver }
}

describe('phase1c product plugin', () => {
  test('has the exact public identity and service dependencies', () => {
    expect(name).toBe('nobei-phase1c')
    expect(inject).toEqual(['agents', 'llm', 'subprocess', 'tools', 'webServer', 'workflowEngine'])
  })

  test.each([
    [{ ...config, pythonExecutable: 'python3.12' }],
    [{ ...config, dataRoot: 'relative' }],
    [{ ...config, ownershipToken: 'short' }],
    [{ ...config, extra: true }],
  ])('rejects invalid or open config before side effects', async (invalid) => {
    const { deps } = dependencies()
    await expect(applyProductPlugin({} as never, invalid as never, deps)).rejects.toThrow('NOBEI_PHASE1C_CONFIG_INVALID')
    expect(deps.registerRoutes).not.toHaveBeenCalled()
  })

  test('registers routes before startup and disposes route, coordinator, supervisor, ledger', async () => {
    const { deps, order, supervisor, resolver } = dependencies()
    const ctx = { subprocess: {} } as never
    const dispose = await applyProductPlugin(ctx, config, deps)
    expect(order).toEqual(['routes:register', 'ledger:install', 'supervisor:start'])
    expect(deps.createModelSelectionResolver).toHaveBeenCalledWith(ctx)
    expect(deps.createCoordinator).toHaveBeenCalledWith(
      supervisor, expect.anything(), resolver,
    )
    await dispose()
    await dispose()
    expect(order).toEqual([
      'routes:register', 'ledger:install', 'supervisor:start',
      'routes:dispose', 'coordinator:dispose', 'supervisor:dispose', 'ledger:dispose',
    ])
  })

  test('rolls back in the same order when startup fails', async () => {
    const { deps, order } = dependencies({ startError: new Error('start failed') })
    await expect(applyProductPlugin({ subprocess: {} } as never, config, deps)).rejects.toThrow('start failed')
    expect(order).toEqual([
      'routes:register', 'ledger:install', 'supervisor:start',
      'routes:dispose', 'coordinator:dispose', 'supervisor:dispose', 'ledger:dispose',
    ])
  })
})
