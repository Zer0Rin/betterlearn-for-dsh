import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { CoreSupervisor, type CoreSupervisorConfig } from './core-supervisor.js'
import { StructuredGenerationAdapter } from './generation-adapter.js'
import { GenerationCoordinator } from './generation-coordinator.js'
import { DshModelSelectionResolver, type ModelSelectionResolver } from './model-selection-resolver.js'
import { loadCandidateContract, type CandidateContract } from './contract.js'
import { registerProductRoutes, type ProductOperations } from './routes.js'

export const name = 'nobei-phase1c'
export const inject = ['agents', 'llm', 'subprocess', 'tools', 'webServer', 'workflowEngine'] as const

export interface Config extends CoreSupervisorConfig {}
export type ProductPluginConfig = Config

const absolutePath = () => Schema.transform(Schema.string().required(), value => {
  if (!isAbsolute(value)) throw new Error('Expected an absolute path')
  return value
}).required()

// All three values belong to the local installation; no portable default exists.
export const Config: Schema<Config> = Schema.transform(Schema.object({
  pythonExecutable: absolutePath().description('Absolute path to the Python 3.12 executable.'),
  dataRoot: absolutePath().description('Absolute path to the initialized BetterLearn data directory.'),
  ownershipToken: Schema.string().min(32).pattern(/^[^\0]*$/).role('secret').required(),
}).required(), value => {
  if (Object.keys(value).sort().join(',') !== 'dataRoot,ownershipToken,pythonExecutable') {
    throw new Error('Unexpected BetterLearn configuration field')
  }
  return value as Config
}).required()

export interface ProductPluginDependencies {
  packageRoot: string
  loadContract(packageRoot: string): CandidateContract
  createSupervisor(ctx: Context, config: ProductPluginConfig, contract: CandidateContract): CoreSupervisor
  createAdapter(ctx: Context, contract: CandidateContract, packageRoot: string): StructuredGenerationAdapter
  createModelSelectionResolver(ctx: Context): ModelSelectionResolver
  createCoordinator(supervisor: CoreSupervisor, adapter: StructuredGenerationAdapter, resolver: ModelSelectionResolver): GenerationCoordinator
  registerRoutes(ctx: Context, state: { readonly state: CoreSupervisor['state'] }, operations: ProductOperations): () => void
}

const packageRoot = fileURLToPath(new URL('../..', import.meta.url))

const defaultDependencies: ProductPluginDependencies = {
  packageRoot,
  loadContract: loadCandidateContract,
  createSupervisor: (ctx, config, contract) => new CoreSupervisor(
    ctx.subprocess,
    config,
    { schemaVersion: contract.schemaVersion, schemaSha256: contract.schemaSha256 },
  ),
  createAdapter: (ctx, contract, ownedPackageRoot) => new StructuredGenerationAdapter(
    ctx, contract, { packageRoot: ownedPackageRoot },
  ),
  createModelSelectionResolver: (ctx) => new DshModelSelectionResolver(ctx),
  createCoordinator: (supervisor, adapter, resolver) => new GenerationCoordinator(
    supervisor, adapter, resolver,
  ),
  registerRoutes: registerProductRoutes,
}

async function disposeInOrder(actions: Array<() => void | Promise<void>>): Promise<void> {
  let firstError: unknown
  for (const action of actions) {
    try {
      await action()
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError) throw firstError
}

export async function applyProductPlugin(
  ctx: Context,
  config: ProductPluginConfig,
  dependencies: ProductPluginDependencies = defaultDependencies,
): Promise<() => Promise<void>> {
  try { config = Config(config) } catch { throw new Error('NOBEI_PHASE1C_CONFIG_INVALID') }
  const contract = dependencies.loadContract(dependencies.packageRoot)
  let supervisor: CoreSupervisor | undefined
  let coordinator: GenerationCoordinator | undefined

  const operations: ProductOperations = {
    previewDocument: (params, signal) => supervisor
      ? supervisor.withReadyClient((client) => client.previewDocument(params, signal))
      : Promise.reject(new Error('CORE_UNAVAILABLE')),
    watchRun: (runId, onChange) => coordinator!.watchRun(runId, onChange),
    getProgress: runId => coordinator!.getProgress(runId),
    launchImport: (params, signal) => coordinator
      ? coordinator.launchImport(params, signal)
      : Promise.reject(new Error('CORE_UNAVAILABLE')),
    launchRetry: (params, signal) => coordinator
      ? coordinator.launchRetry(params, signal)
      : Promise.reject(new Error('CORE_UNAVAILABLE')),
    listRuns: signal => supervisor
      ? supervisor.withReadyClient((client) => client.listRuns(signal))
      : Promise.reject(new Error('CORE_UNAVAILABLE')),
    getRun: (runId, signal) => supervisor
      ? supervisor.withReadyClient((client) => client.getRun({ runId }, signal))
      : Promise.reject(new Error('CORE_UNAVAILABLE')),
    listEvents: (runId, after, signal) => supervisor
      ? supervisor.withReadyClient((client) => client.listEvents({ runId, after }, signal))
      : Promise.reject(new Error('CORE_UNAVAILABLE')),
    listCandidates: (runId, signal) => supervisor
      ? supervisor.withReadyClient((client) => client.listCandidates({ runId }, signal))
      : Promise.reject(new Error('CORE_UNAVAILABLE')),
    reviewCandidate: (params, signal) => supervisor
      ? supervisor.withReadyClient((client) => client.reviewCandidate(params, signal))
      : Promise.reject(new Error('CORE_UNAVAILABLE')),
    listKnowledgePoints: (runId, signal) => supervisor
      ? supervisor.withReadyClient((client) => client.listKnowledgePoints({ runId }, signal))
      : Promise.reject(new Error('CORE_UNAVAILABLE')),
    updateKnowledgePoint: (params, signal) => supervisor
      ? supervisor.withReadyClient((client) => client.updateKnowledgePoint(params, signal))
      : Promise.reject(new Error('CORE_UNAVAILABLE')),
    deleteRun: async (runId, signal) => {
      await coordinator!.terminateRun(runId)
      return supervisor
        ? supervisor.withReadyClient((client) => client.deleteRun({ runId }, signal))
        : Promise.reject(new Error('CORE_UNAVAILABLE'))
    },
  }
  const state = {
    get state(): CoreSupervisor['state'] {
      return supervisor?.state ?? 'STARTING'
    },
  }

  let unregisterRoutes: (() => void) | undefined
  let disposePromise: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    disposePromise ??= disposeInOrder([
      () => { unregisterRoutes?.(); unregisterRoutes = undefined },
      () => coordinator?.dispose(),
      () => supervisor?.dispose(),
    ])
    return disposePromise
  }

  try {
    unregisterRoutes = dependencies.registerRoutes(ctx, state, operations)
    supervisor = dependencies.createSupervisor(ctx, config, contract)
    const adapter = dependencies.createAdapter(ctx, contract, dependencies.packageRoot)
    const resolver = dependencies.createModelSelectionResolver(ctx)
    coordinator = dependencies.createCoordinator(supervisor, adapter, resolver)
    await supervisor.start()
    return dispose
  } catch (error) {
    await dispose().catch(() => undefined)
    throw error
  }
}

export function apply(ctx: Context, config: ProductPluginConfig): Promise<() => Promise<void>> {
  return applyProductPlugin(ctx, config)
}
