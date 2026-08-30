import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

export interface ModelSelectionSnapshot {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelSelectionPropagationObservation {
  runId: string
  parentId: string
  childId: string
  ownedByParent: boolean
  selectionInstalled: boolean
  requested: ModelSelectionSnapshot
  expectedStream: ModelSelectionSnapshot
  observed: ModelSelectionSnapshot
}

export interface ModelSelectionStreamRecord extends ModelSelectionSnapshot {
  reasoningEffort?: string
}

type ParentAgent = { id: string }
type ChildInstaller = (childCtx: Context, selection: ModelSelectionRef) => void

function copy(snapshot: ModelSelectionSnapshot): ModelSelectionSnapshot {
  return snapshot.reasoningEffort === undefined
    ? { provider: snapshot.provider, model: snapshot.model }
    : { provider: snapshot.provider, model: snapshot.model, reasoningEffort: snapshot.reasoningEffort }
}

function sameSnapshot(left: ModelSelectionSnapshot, right: ModelSelectionSnapshot): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && Object.hasOwn(left, 'reasoningEffort') === Object.hasOwn(right, 'reasoningEffort')
    && left.reasoningEffort === right.reasoningEffort
}

/** The agent factory must not receive a reasoning effort: rc.7 selection owns it. */
export function modelSelectionAgentOptions(snapshot: ModelSelectionSnapshot) {
  return { provider: snapshot.provider, model: snapshot.model, maxTokens: 2_048 }
}

/** Builds the mutable rc.7 selection object exactly once per parent/child lineage. */
export function modelSelectionRef(snapshot: ModelSelectionSnapshot): ModelSelectionRef {
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

/**
 * Attaches one synchronous Host listener. It deliberately records every event;
 * concurrent run listeners must prove their isolation during settlement instead
 * of assuming that a listener only sees its own child.
 */
export function createChildSelectionObserver(
  ctx: Context,
  parent: ParentAgent,
  snapshot: ModelSelectionSnapshot,
  runId: string,
  observations: ModelSelectionPropagationObservation[],
  install: ChildInstaller = installModelSelection,
): () => void {
  const selection = modelSelectionRef(snapshot)
  return ctx.on('agent/created', ({ agent }) => {
    const ownedByParent = ctx.agents.isOwnedBy(agent.id, parent as never)
    const selectionInstalled = ownedByParent
    if (ownedByParent) install(agent.ctx, selection)
    observations.push({
      runId,
      parentId: parent.id,
      childId: agent.id,
      ownedByParent,
      selectionInstalled,
      requested: copy(snapshot),
      expectedStream: copy(snapshot),
      observed: copy(snapshot),
    })
  })
}

/** Throws the hard-stop code for one claimed child observation. */
export function assertModelSelectionPropagation(row: ModelSelectionPropagationObservation): void {
  if (!row.ownedByParent) throw new Error('SPAWN_CHILD_NOT_OWNED')
  if (!row.selectionInstalled || !sameSnapshot(row.requested, row.expectedStream) || !sameSnapshot(row.expectedStream, row.observed)) {
    throw new Error('MODEL_SELECTION_PROPAGATION_MISMATCH')
  }
}

/**
 * Applies the fake stream ledger after a workflow has settled. Listener failures
 * are intentionally not relied upon because rc.7 contains them at dispatch.
 */
export function settleModelSelectionRun(
  observations: ModelSelectionPropagationObservation[],
  streamRecords: readonly ModelSelectionStreamRecord[],
  options: { selectionInstalled: boolean },
): ModelSelectionPropagationObservation {
  const owned = observations.filter((row) => row.ownedByParent)
  if (owned.length !== 1) throw new Error('SPAWN_CHILD_NOT_OWNED')
  if (streamRecords.length !== 1) throw new Error('MODEL_SELECTION_PROPAGATION_MISMATCH')
  const row = owned[0]!
  row.selectionInstalled = options.selectionInstalled
  row.observed = copy(streamRecords[0]!)
  if (options.selectionInstalled) assertModelSelectionPropagation(row)
  else if (!sameSnapshot(row.requested, row.expectedStream) || !sameSnapshot(row.expectedStream, row.observed)) {
    throw new Error('MODEL_SELECTION_PROPAGATION_MISMATCH')
  }
  return row
}
