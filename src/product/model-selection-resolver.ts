import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { GENERATION_MAX_TOKENS } from './constants.js'
import type { ModelSelectionSnapshot } from './types.js'

export interface ModelSelectionResolver {
  resolve(selection: ModelSelectionSnapshot, signal?: AbortSignal): Promise<ModelSelectionSnapshot>
}

export class ModelSelectionResolutionError extends Error {
  readonly code = 'MODEL_SELECTION_INVALID'

  constructor() {
    super('MODEL_SELECTION_INVALID')
    this.name = 'ModelSelectionResolutionError'
  }
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maxLength
    && !/[\uD800-\uDFFF]/.test(value)
}

function closedSelection(value: unknown): ModelSelectionSnapshot | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const keys = Object.keys(input).sort().join(',')
  if (keys !== 'model,provider' && keys !== 'model,provider,reasoningEffort') return undefined
  if (!validText(input.provider, 64) || !validText(input.model, 128)) return undefined
  if ('reasoningEffort' in input && !validText(input.reasoningEffort, 64)) return undefined
  return {
    provider: input.provider,
    model: input.model,
    ...('reasoningEffort' in input ? { reasoningEffort: input.reasoningEffort as string } : {}),
  }
}

export class DshModelSelectionResolver implements ModelSelectionResolver {
  constructor(private readonly ctx: Context) {}

  async resolve(
    selection: ModelSelectionSnapshot,
    signal?: AbortSignal,
  ): Promise<ModelSelectionSnapshot> {
    const proposed = closedSelection(selection)
    if (!proposed) throw new ModelSelectionResolutionError()
    try {
      const resolved = await this.ctx.llm.resolveCallConfig({
        provider: proposed.provider,
        model: proposed.model,
        ...(proposed.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(proposed.reasoningEffort) }),
        maxTokens: GENERATION_MAX_TOKENS,
      }, signal)
      const effective = closedSelection({
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: resolved.reasoningEffort }),
      })
      if (!effective) throw new ModelSelectionResolutionError()
      return effective
    } catch {
      throw new ModelSelectionResolutionError()
    }
  }
}
