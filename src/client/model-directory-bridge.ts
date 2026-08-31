import type { ModelSelectionSnapshot } from './types.js'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'

export interface ModelDirectorySnapshot {
  current: ModelSelectionSnapshot | null
  routable: boolean | null
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
}

export interface ModelDirectoryPort {
  load(): Promise<{
    current: ModelSelectionSnapshot
    routable: boolean
  }>
  store?: {
    getSnapshot(): ModelDirectorySnapshot
    subscribe(listener: () => void): () => void
  }
}

export interface ModelDirectoryResolverPort {
  directoryFor(sessionId: string): ModelDirectoryPort
}

/** Constructed at slot registration injection; services and observables stay outside components. */
export function modelSelectionInjection(directories: ModelDirectoryResolverPort, sessionId: string, ordinarySession: boolean) {
  let directory: ModelDirectoryPort | undefined
  if (ordinarySession) {
    try { directory = directories.directoryFor(sessionId) } catch { /* The load callback reports unavailability. */ }
  }
  const source = directory?.store ?? {
    getSnapshot: (): ModelDirectorySnapshot | undefined => undefined,
    subscribe: (_listener: () => void) => () => undefined,
  }
  return {
    ordinarySession,
    hooks: { modelDirectory: source },
    loadModelSelection: () => selectionForNewRun(directories, sessionId, ordinarySession),
    readModelDirectory: (): ModelDirectorySnapshot | undefined => source.getSnapshot(),
  }
}

export type ModelSelectionProps = InjectFace<ReturnType<typeof modelSelectionInjection>>
export type ModelSelectionInput = Omit<ModelSelectionProps, 'useModelDirectory'> & {
  modelDirectoryState: ModelDirectorySnapshot | undefined
}

export type ModelDirectoryErrorCode = 'MODEL_SELECTION_UNAVAILABLE' | 'MODEL_NOT_ROUTABLE'

export class ModelDirectoryBridgeError extends Error {
  constructor(readonly code: ModelDirectoryErrorCode) {
    super(code)
    this.name = 'ModelDirectoryBridgeError'
  }
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\uD800-\uDFFF]/.test(value)
}

export function detachedModelSelection(value: unknown): ModelSelectionSnapshot | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const keys = Object.keys(input).sort().join(',')
  if (keys !== 'model,provider' && keys !== 'model,provider,reasoningEffort') return undefined
  if (!validText(input.provider) || !validText(input.model)) return undefined
  if ('reasoningEffort' in input && !validText(input.reasoningEffort)) return undefined
  return {
    provider: input.provider,
    model: input.model,
    ...('reasoningEffort' in input ? { reasoningEffort: input.reasoningEffort as string } : {}),
  }
}

export async function selectionForNewRun(
  directories: ModelDirectoryResolverPort,
  sessionId: string,
  ordinarySession: boolean,
): Promise<ModelSelectionSnapshot> {
  if (!ordinarySession) throw new ModelDirectoryBridgeError('MODEL_SELECTION_UNAVAILABLE')
  try {
    const loaded = await directories.directoryFor(sessionId).load()
    const current = detachedModelSelection(loaded.current)
    if (!current || typeof loaded.routable !== 'boolean') {
      throw new ModelDirectoryBridgeError('MODEL_SELECTION_UNAVAILABLE')
    }
    if (!loaded.routable) throw new ModelDirectoryBridgeError('MODEL_NOT_ROUTABLE')
    return current
  } catch (error) {
    if (error instanceof ModelDirectoryBridgeError) throw error
    throw new ModelDirectoryBridgeError('MODEL_SELECTION_UNAVAILABLE')
  }
}

export function modelSelectionLabel(selection: ModelSelectionSnapshot): string {
  const effort = selection.reasoningEffort === undefined ? '' : ` · ${selection.reasoningEffort}`
  return `${selection.provider} / ${selection.model}${effort}`
}
