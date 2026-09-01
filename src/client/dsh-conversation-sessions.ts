import type {
  ISessions,
  SessionId,
  SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'

export interface DshConversationSummary {
  sessionId: string
  title: string
  updatedAt: number
}

export function selectableDshConversations(
  state: Pick<SessionListState, 'ids' | 'byId'>,
  subagentAddress: Pick<ISessions, 'subagentAddress'>['subagentAddress'],
): DshConversationSummary[] {
  const summaries: DshConversationSummary[] = []
  for (const sessionId of state.ids) {
    const row = state.byId[sessionId]
    if (
      !row
      || row.blank
      || row.origin === 'subagent'
      || subagentAddress(sessionId as SessionId) !== undefined
    ) continue
    summaries.push({
      sessionId: String(sessionId),
      title: row.displayTitle,
      updatedAt: row.updatedAt,
    })
  }
  return summaries
}
