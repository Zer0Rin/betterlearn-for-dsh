import { describe, expect, test, vi } from 'vitest'
import { Context, resolveConfig } from '@deepseek-ai/cordis'
import * as entry from '../src/index.js'
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
    watchRun: vi.fn(() => vi.fn()),
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
  test('exports a loader schema with required values, preserving valid input and rejecting invalid updates', async () => {
    expect(entry).toHaveProperty('Config')
    expect(resolveConfig(entry, config)).toEqual(config)
    for (const invalid of [undefined, null, {}, [], { ...config, pythonExecutable: 'python' },
      { ...config, dataRoot: 'relative' }, { ...config, ownershipToken: 'short' },
      { ...config, ownershipToken: 't'.repeat(32) + '\0' }, { ...config, extra: true }]) {
      expect(() => resolveConfig(entry, invalid)).toThrow()
    }
    const calls: string[] = []
    const ctx = new Context()
    const fiber = ctx.plugin({ Config: entry.Config, apply(_ctx, value: typeof config) {
      calls.push(value.dataRoot)
      return () => { calls.push('disposed') }
    } }, config)
    await fiber
    expect(() => fiber.update({ ...config, dataRoot: 'relative' })).toThrow()
    expect(calls).toEqual([config.dataRoot])
    await fiber.update({ ...config, dataRoot: '/owned/another-root' })
    expect(calls).toEqual([config.dataRoot, 'disposed', '/owned/another-root'])
    await fiber.dispose()
  })

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

  test('registers routes before startup and disposes route, coordinator, supervisor', async () => {
    const { deps, order, supervisor, resolver, coordinator } = dependencies()
    const ctx = { subprocess: {} } as never
    const dispose = await applyProductPlugin(ctx, config, deps)
    expect(order).toEqual(['routes:register', 'supervisor:start'])
    expect(deps.createModelSelectionResolver).toHaveBeenCalledWith(ctx)
    expect(deps.createCoordinator).toHaveBeenCalledWith(
      supervisor, expect.anything(), resolver,
    )
    const onChange = vi.fn()
    const operations = vi.mocked(deps.registerRoutes).mock.calls[0]![2]
    operations.watchRun('job_1', onChange)
    expect(coordinator.watchRun).toHaveBeenCalledWith('job_1', onChange)
    const listRuns = vi.fn(async () => ({ runs: [] }))
    supervisor.withReadyClient.mockImplementation(async (use: (client: { listRuns: typeof listRuns }) => unknown) => use({ listRuns }))
    await operations.listRuns()
    expect(listRuns).toHaveBeenCalledWith(undefined)
    await dispose()
    await dispose()
    expect(order).toEqual([
      'routes:register', 'supervisor:start',
      'routes:dispose', 'coordinator:dispose', 'supervisor:dispose',
    ])
  })

  test('rolls back in the same order when startup fails', async () => {
    const { deps, order } = dependencies({ startError: new Error('start failed') })
    await expect(applyProductPlugin({ subprocess: {} } as never, config, deps)).rejects.toThrow('start failed')
    expect(order).toEqual([
      'routes:register', 'supervisor:start',
      'routes:dispose', 'coordinator:dispose', 'supervisor:dispose',
    ])
  })
})
