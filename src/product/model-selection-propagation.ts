import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentOptions,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { GENERATION_MAX_TOKENS, GENERATION_TOOL_DENIAL } from './constants.js'
import type { ModelSelectionSnapshot } from './types.js'

export type SelectionInstaller = (
  agentCtx: Context,
  selection: ModelSelectionRef,
) => () => void

type Disposer = () => void

function selectionRef(snapshot: ModelSelectionSnapshot): ModelSelectionRef {
  return {
    current: {
      provider: snapshot.provider,
      model: snapshot.model,
      ...(snapshot.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(snapshot.reasoningEffort) }),
    },
    assembled: undefined,
  }
}

function disposeAll(disposers: Disposer[]): void {
  let firstError: unknown
  for (const dispose of disposers.splice(0).reverse()) {
    try {
      dispose()
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError) throw firstError
}

export class ModelSelectionPropagation {
  readonly agentOptions: AgentOptions
  readonly #selection: ModelSelectionRef
  readonly #parentDisposers: Disposer[] = []
  readonly #childDisposers: Disposer[] = []
  #listenerDisposer: Disposer | undefined
  #ownedChildren = 0
  #ownedChild: Agent | undefined
  #installationFailed = false
  #disposed = false

  constructor(
    private readonly ctx: Context,
    snapshot: ModelSelectionSnapshot,
    private readonly installSelection: SelectionInstaller = installModelSelection,
  ) {
    this.agentOptions = {
      provider: snapshot.provider,
      model: snapshot.model,
      maxTokens: GENERATION_MAX_TOKENS,
    }
    this.#selection = selectionRef(snapshot)
  }

  readonly setupParent = (agentCtx: Context): void => {
    this.#installOn(agentCtx, this.#parentDisposers, true)
  }

  observeChildren(parent: Agent, onResponse?: (time: number) => void): void {
    if (this.#listenerDisposer) throw new Error('MODEL_SELECTION_PROPAGATION_MISMATCH')
    this.#listenerDisposer = this.ctx.on('agent/created', ({ agent: child }) => {
      if (!this.ctx.agents.isOwnedBy(child.id, parent)) return
      this.#ownedChildren += 1
      this.#ownedChild = child
      try {
        this.#installOn(child.ctx, this.#childDisposers, false)
        if (onResponse) this.#childDisposers.push(child.ctx.on('session/event', (session, event) => {
          if (session.id === child.id && event.type === 'assistant/chunk') onResponse(event.time)
        }))
      } catch {
        this.#installationFailed = true
      }
    })
  }

  assertComplete(): void {
    if (this.#ownedChildren === 0) throw new Error('SPAWN_CHILD_NOT_OWNED')
    if (this.#ownedChildren !== 1 || this.#installationFailed) {
      throw new Error('MODEL_SELECTION_PROPAGATION_MISMATCH')
    }
  }

  get childStopReason(): string | undefined {
    const end = this.#ownedChild?.session.events.findLast(event => event.type === 'turn/end')
    return end?.data.reason.kind
  }

  disposeBoundaries(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#ownedChild = undefined
    const listener = this.#listenerDisposer
    this.#listenerDisposer = undefined
    let firstError: unknown
    try {
      listener?.()
    } catch (error) {
      firstError = error
    }
    try {
      disposeAll(this.#childDisposers)
    } catch (error) {
      firstError ??= error
    }
    try {
      disposeAll(this.#parentDisposers)
    } catch (error) {
      firstError ??= error
    }
    if (firstError) throw firstError
  }

  #installOn(agentCtx: Context, target: Disposer[], throwOnFailure: boolean): void {
    const added: Disposer[] = []
    try {
      added.push(this.installSelection(agentCtx, this.#selection))
      added.push(agentCtx.tools.restrict({ allow: [] }))
      added.push(agentCtx.tools.guard((execution) => (
        execution.name === 'structured_output' ? undefined : GENERATION_TOOL_DENIAL
      )))
      target.push(...added)
    } catch (error) {
      try {
        disposeAll(added)
      } catch {
        // Preserve the setup failure; cleanup is best effort at this boundary.
      }
      if (throwOnFailure) throw error
      throw new Error('MODEL_SELECTION_PROPAGATION_MISMATCH')
    }
  }
}
