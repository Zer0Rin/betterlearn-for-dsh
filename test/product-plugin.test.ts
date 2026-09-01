import { describe, expect, test, vi } from 'vitest'
import { Context, resolveConfig } from '@deepseek-ai/cordis'
import * as entry from '../src/index.js'
import {
  applyProductPlugin,
  inject,
  name,
  type ProductPluginDependencies,
} from '../src/product/plugin.js'
import { DSH_CONVERSATION_MEDIA_TYPE } from '../src/product/dsh-conversation-source.js'

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
    terminateRun: vi.fn(async () => undefined),
    dispose: vi.fn(async () => { order.push('coordinator:dispose') }),
  }
  const resolver = { resolve: vi.fn() }
  const conversationDocument = {
    sessionIds: ['session_a'],
    filename: 'DSH对话合集-主题.md',
    mediaType: DSH_CONVERSATION_MEDIA_TYPE,
    text: '# DSH 对话合集\n\n## 对话：主题',
    contentDigest: 'd'.repeat(64),
    conversationCount: 1,
    messageCount: 2,
    byteSize: 42,
    characterCount: 31,
  }
  const conversationSource = { read: vi.fn(async () => ({ ...conversationDocument })) }
  const deps: ProductPluginDependencies = {
    packageRoot: '/owned/package',
    loadContract: vi.fn(() => ({
      schema: { type: 'object' }, schemaVersion: 1, schemaSha256: 'a'.repeat(64), validate: () => [],
    })),
    createSupervisor: vi.fn(() => supervisor as never),
    createAdapter: vi.fn(() => ({}) as never),
    createModelSelectionResolver: vi.fn(() => resolver as never),
    createConversationSource: vi.fn(() => conversationSource as never),
    createCoordinator: vi.fn(() => coordinator as never),
    registerRoutes: vi.fn(() => {
      order.push('routes:register')
      return () => { order.push('routes:dispose') }
    }),
  }
  return { deps, order, supervisor, coordinator, resolver, conversationSource, conversationDocument }
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
    expect(inject).toEqual(['agents', 'llm', 'sessionQuery', 'subprocess', 'tools', 'webServer', 'workflowEngine'])
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
    const { deps, order, supervisor, resolver, coordinator, conversationSource, conversationDocument } = dependencies()
    const sessionQuery = { readSession: vi.fn() }
    const ctx = { subprocess: {}, sessionQuery } as never
    const dispose = await applyProductPlugin(ctx, config, deps)
    expect(order).toEqual(['routes:register', 'supervisor:start'])
    expect(deps.createModelSelectionResolver).toHaveBeenCalledWith(ctx)
    expect(deps.createConversationSource).toHaveBeenCalledWith(sessionQuery)
    expect(deps.createCoordinator).toHaveBeenCalledWith(
      supervisor, expect.anything(), resolver,
    )
    const onChange = vi.fn()
    const operations = vi.mocked(deps.registerRoutes).mock.calls[0]![2]
    const corePreview = {
      filename: conversationDocument.filename,
      mediaType: conversationDocument.mediaType,
      text: conversationDocument.text,
      byteSize: conversationDocument.byteSize,
      characterCount: conversationDocument.characterCount,
      pages: [],
      extractionPlan: { strategy: 'L1' as const, blocks: [], containers: [], boundaries: [], maxCalls: 1 },
    }
    const previewDocument = vi.fn(async () => corePreview)
    supervisor.withReadyClient.mockImplementation(async (use: (client: { previewDocument: typeof previewDocument }) => unknown) => use({ previewDocument }))
    await expect(operations.previewDshConversations(['session_a'])).resolves.toEqual({
      ...conversationDocument,
      extractionPlan: corePreview.extractionPlan,
    })
    expect(conversationSource.read).toHaveBeenCalledWith(['session_a'], undefined)
    expect(previewDocument).toHaveBeenCalledWith({
      filename: conversationDocument.filename,
      mediaType: conversationDocument.mediaType,
      text: conversationDocument.text,
    }, undefined)
    const dshImport = {
      sessionIds: ['session_a'],
      expectedDigest: conversationDocument.contentDigest,
      modelSelection: { provider: 'provider-a', model: 'model-a' },
    }
    await operations.importDshConversations(dshImport)
    expect(coordinator.launchImport).toHaveBeenCalledWith({
      filename: conversationDocument.filename,
      mediaType: conversationDocument.mediaType,
      text: conversationDocument.text,
      modelSelection: dshImport.modelSelection,
    }, undefined)
    coordinator.launchImport.mockClear()
    await expect(operations.importDshConversations({
      ...dshImport,
      expectedDigest: 'e'.repeat(64),
    })).rejects.toThrow('DSH_CONVERSATION_CHANGED')
    expect(coordinator.launchImport).not.toHaveBeenCalled()
    operations.watchRun('job_1', onChange)
    expect(coordinator.watchRun).toHaveBeenCalledWith('job_1', onChange)
    const listRuns = vi.fn(async () => ({ runs: [] }))
    supervisor.withReadyClient.mockImplementation(async (use: (client: { listRuns: typeof listRuns }) => unknown) => use({ listRuns }))
    await operations.listRuns()
    expect(listRuns).toHaveBeenCalledWith(undefined)
    const syncLearningCourse = vi.fn(async () => ({ courseId: 'course_0123456789abcdefabcd' }))
    supervisor.withReadyClient.mockImplementation(async (use: (client: { syncLearningCourse: typeof syncLearningCourse }) => unknown) => use({ syncLearningCourse }))
    const learning = { clientBookId: 'book-one', title: '学习书', knowledgePointIds: ['kp_0123456789abcdefabcd'] }
    await operations.syncLearningCourse(learning)
    expect(syncLearningCourse).toHaveBeenCalledWith(learning, undefined)
    const deleteLearningCourse = vi.fn(async () => ({
      courseId: 'course_0123456789abcdefabcd', deleted: true as const,
    }))
    supervisor.withReadyClient.mockImplementation(async (use: (client: {
      deleteLearningCourse: typeof deleteLearningCourse,
    }) => unknown) => use({ deleteLearningCourse }))
    await operations.deleteLearningCourse('course_0123456789abcdefabcd')
    expect(deleteLearningCourse).toHaveBeenCalledWith({
      courseId: 'course_0123456789abcdefabcd',
    }, undefined)
    const updateKnowledgePoint = vi.fn(async () => ({ knowledgePoint: {} }))
    supervisor.withReadyClient.mockImplementation(async (use: (client: { updateKnowledgePoint: typeof updateKnowledgePoint }) => unknown) => use({ updateKnowledgePoint }))
    const update = { knowledgePointId: 'kp_0123456789abcdefabcd', title: '新标题', statement: '新陈述' }
    await operations.updateKnowledgePoint(update)
    expect(updateKnowledgePoint).toHaveBeenCalledWith(update, undefined)
    const deleteRun = vi.fn(async () => ({ runId: 'job_delete', deleted: true }))
    supervisor.withReadyClient.mockImplementation(async (use: (client: { deleteRun: typeof deleteRun }) => unknown) => use({ deleteRun }))
    await operations.deleteRun('job_delete')
    expect(coordinator.terminateRun).toHaveBeenCalledWith('job_delete')
    expect(deleteRun).toHaveBeenCalledWith({ runId: 'job_delete' }, undefined)
    expect(coordinator.terminateRun.mock.invocationCallOrder[0]).toBeLessThan(deleteRun.mock.invocationCallOrder[0]!)
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
