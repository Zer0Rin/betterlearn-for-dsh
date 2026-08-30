import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { useEffect, useState } from 'react'

export const name = 'nobei-phase1e-real-model-observer-client'
export const inject = ['slots', 'sessions', 'modelDirectories'] as const

export type ModelDirectoryResult =
  | { readonly status: 'READY', readonly provider: string, readonly model: string, readonly reasoningEffort?: string, readonly routable: true }
  | { readonly status: 'MODEL_NOT_ROUTABLE', readonly routable: false }
  | { readonly status: 'MODEL_SELECTION_UNAVAILABLE' }

interface ModelDirectoryInput {
  readonly sessionId: SessionId
  readonly subagentAddress: (sessionId: SessionId) => unknown
  readonly directoryFor: (sessionId: SessionId) => {
    load(): Promise<{ current: { provider: unknown, model: unknown, reasoningEffort?: unknown }, routable: unknown }>
  }
}

export async function readModelDirectory(input: ModelDirectoryInput): Promise<ModelDirectoryResult> {
  if (input.subagentAddress(input.sessionId) !== undefined) return { status: 'MODEL_SELECTION_UNAVAILABLE' }
  try {
    const directory = input.directoryFor(input.sessionId)
    const loaded = await directory.load()
    if (loaded.routable !== true) return { status: 'MODEL_NOT_ROUTABLE', routable: false }
    if (typeof loaded.current?.provider !== 'string' || typeof loaded.current?.model !== 'string') {
      return { status: 'MODEL_SELECTION_UNAVAILABLE' }
    }
    return {
      status: 'READY',
      provider: String(loaded.current.provider),
      model: String(loaded.current.model),
      ...(typeof loaded.current.reasoningEffort === 'string'
        ? { reasoningEffort: String(loaded.current.reasoningEffort) }
        : {}),
      routable: true,
    }
  } catch {
    return { status: 'MODEL_SELECTION_UNAVAILABLE' }
  }
}

export function ObserverClientView({ result: supplied, sessionId, ctx }: {
  readonly result?: ModelDirectoryResult
  readonly sessionId?: SessionId
  readonly ctx?: Context
}): JSX.Element {
  const [result, setResult] = useState<ModelDirectoryResult | undefined>(supplied)
  useEffect(() => {
    if (supplied !== undefined || sessionId === undefined || ctx === undefined) return
    void readModelDirectory({
      sessionId,
      subagentAddress: ctx.sessions.subagentAddress.bind(ctx.sessions),
      directoryFor: ctx.modelDirectories.directoryFor.bind(ctx.modelDirectories),
    }).then(setResult)
  }, [ctx, sessionId, supplied])
  return <div
    data-testid="nobei-phase1e-real-model-observer"
    data-status={result?.status ?? 'LOADING'}
    style={{ display: 'none' }}
    {...(result?.status === 'READY'
      ? {
          'data-provider': result.provider,
          'data-model': result.model,
          ...(result.reasoningEffort === undefined ? {} : { 'data-reasoning-effort': result.reasoningEffort }),
          'data-routable': 'true',
        }
      : result?.status === 'MODEL_NOT_ROUTABLE' ? { 'data-routable': 'false' } : {})}
  />
}

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'phase1e-real-model-observer',
    order: 99,
  }, (props) => <ObserverClientView {...props} ctx={ctx} />))
}
