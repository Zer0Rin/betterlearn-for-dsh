import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  SPIKE_MAX_CALLS,
  SPIKE_MODEL,
  SPIKE_PROVIDER,
  STRUCTURED_OUTPUT_TOOL,
} from './constants.js'

export interface ModelCallAuditRecord {
  index: number
  provider: typeof SPIKE_PROVIDER
  model: typeof SPIKE_MODEL
  toolCount: 1
  toolNames: [typeof STRUCTURED_OUTPUT_TOOL]
}

export class ModelCallAudit {
  readonly #records: ModelCallAuditRecord[] = []

  get records(): readonly ModelCallAuditRecord[] {
    return this.#records.map((record) => ({ ...record, toolNames: [...record.toolNames] }))
  }

  async *wrap(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const toolNames = options.tools?.map((tool) => tool.name) ?? []
    if (
      options.provider !== SPIKE_PROVIDER
      || options.model !== SPIKE_MODEL
      || options.purpose !== undefined
      || toolNames.length !== 1
      || toolNames[0] !== STRUCTURED_OUTPUT_TOOL
    ) {
      throw new Error('LLM_AUDIT_REJECTED')
    }
    if (this.#records.length >= SPIKE_MAX_CALLS) {
      throw new Error('LLM_CALL_BUDGET_EXCEEDED')
    }
    this.#records.push({
      index: this.#records.length + 1,
      provider: SPIKE_PROVIDER,
      model: SPIKE_MODEL,
      toolCount: 1,
      toolNames: [STRUCTURED_OUTPUT_TOOL],
    })
    yield* next()
  }
}

export function installModelCallAudit(ctx: Context, audit: ModelCallAudit): () => void {
  return ctx.on('llm/stream', async function* (options, next) {
    yield* audit.wrap(options, next)
  })
}
