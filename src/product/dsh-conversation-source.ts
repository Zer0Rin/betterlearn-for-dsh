import { createHash } from 'node:crypto'
import type { TextBlock } from '@deepseek-ai/dsh-llm'
import {
  deriveEventMessage,
  isAppendSurfaceEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot, SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'

export const DSH_CONVERSATION_MEDIA_TYPE =
  'application/vnd.betterlearn.dsh-conversation+markdown' as const

const MAX_DOCUMENT_BYTES = 512 * 1024
const MAX_CONVERSATIONS = 50

export type DshConversationSourceErrorCode =
  | 'DSH_CONVERSATION_NOT_FOUND'
  | 'DSH_CONVERSATION_NOT_ORDINARY'
  | 'DSH_CONVERSATION_EMPTY'
  | 'DSH_CONVERSATION_TOO_LARGE'
  | 'DSH_CONVERSATION_READ_FAILED'
  | 'DSH_CONVERSATION_CHANGED'

export class DshConversationSourceError extends Error {
  readonly name = 'DshConversationSourceError'

  constructor(
    readonly code: DshConversationSourceErrorCode,
    readonly detail?: Record<string, number>,
  ) {
    super(code)
  }
}

export interface DshConversationDocument {
  sessionIds: string[]
  filename: string
  mediaType: typeof DSH_CONVERSATION_MEDIA_TYPE
  text: string
  contentDigest: string
  conversationCount: number
  messageCount: number
  byteSize: number
  characterCount: number
}

interface ConversationMessage {
  role: '用户' | 'DSH'
  text: string
}

interface Conversation {
  requestIndex: number
  sessionId: string
  header: SessionHeader
  title: string
  messages: ConversationMessage[]
}

interface SessionQueryPort {
  readSession: Pick<SessionQueryEngine, 'readSession'>['readSession']
}

function queryCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function visibleMessages(snapshot: SessionLogSnapshot): ConversationMessage[] {
  const messages: ConversationMessage[] = []
  for (const event of snapshot.events) {
    if (!isAppendSurfaceEvent(event)) continue
    const message = deriveEventMessage(event)
    if (!message) continue
    const role = message.role === 'user' && message.source.kind === 'user'
      ? '用户' as const
      : message.role === 'assistant' && message.source.kind === 'model'
        ? 'DSH' as const
        : undefined
    if (!role) continue
    const text = message.content
      .filter((block): block is TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .replace(/\r\n?/g, '\n')
      .trim()
    if (text) messages.push({ role, text })
  }
  return messages
}

function safeFilenameTitle(value: string): string {
  const normalized = value
    .replace(/[\\/\0]/g, '-')
    .replace(/[\u0001-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (normalized || '未命名对话').slice(0, 180)
}

function filename(conversations: readonly Conversation[]): string {
  const first = safeFilenameTitle(conversations[0]!.title)
  return conversations.length === 1
    ? `DSH对话合集-${first}.md`
    : `DSH对话合集-${first}-等${conversations.length}个.md`
}

function markdown(conversations: readonly Conversation[]): string {
  const sections = conversations.map(conversation => [
    `## 对话：${conversation.title}`,
    ...conversation.messages.flatMap(message => [`### ${message.role}`, message.text]),
  ].join('\n\n'))
  return ['# DSH 对话合集', sections.join('\n\n---\n\n')].join('\n\n')
}

export class DshConversationSource {
  constructor(private readonly query: SessionQueryPort) {}

  async read(sessionIds: readonly string[], signal?: AbortSignal): Promise<DshConversationDocument> {
    if (sessionIds.length < 1 || sessionIds.length > MAX_CONVERSATIONS || new Set(sessionIds).size !== sessionIds.length) {
      throw new DshConversationSourceError('DSH_CONVERSATION_READ_FAILED')
    }
    const conversations: Conversation[] = []
    for (const [requestIndex, sessionId] of sessionIds.entries()) {
      signal?.throwIfAborted()
      let snapshot: SessionLogSnapshot
      try {
        snapshot = await this.query.readSession(sessionId as never)
      } catch (error) {
        if (queryCode(error) === 'SESSION_QUERY_SESSION_NOT_FOUND') {
          throw new DshConversationSourceError('DSH_CONVERSATION_NOT_FOUND')
        }
        throw new DshConversationSourceError('DSH_CONVERSATION_READ_FAILED')
      }
      signal?.throwIfAborted()
      if (snapshot.session.origin === 'subagent' || (snapshot.session.delegationDepth ?? 0) > 0) {
        throw new DshConversationSourceError('DSH_CONVERSATION_NOT_ORDINARY')
      }
      const messages = visibleMessages(snapshot)
      if (messages.length === 0) throw new DshConversationSourceError('DSH_CONVERSATION_EMPTY')
      conversations.push({
        requestIndex,
        sessionId,
        header: snapshot.session,
        title: foldSessionTitle(snapshot.events)?.title ?? `未命名对话${requestIndex + 1}`,
        messages,
      })
    }
    conversations.sort((left, right) =>
      left.header.createdAt - right.header.createdAt || left.requestIndex - right.requestIndex)
    const text = markdown(conversations)
    const byteSize = Buffer.byteLength(text, 'utf8')
    if (byteSize > MAX_DOCUMENT_BYTES) {
      throw new DshConversationSourceError('DSH_CONVERSATION_TOO_LARGE', {
        actualBytes: byteSize,
        maxBytes: MAX_DOCUMENT_BYTES,
      })
    }
    return {
      sessionIds: conversations.map(conversation => conversation.sessionId),
      filename: filename(conversations),
      mediaType: DSH_CONVERSATION_MEDIA_TYPE,
      text,
      contentDigest: createHash('sha256').update(text, 'utf8').digest('hex'),
      conversationCount: conversations.length,
      messageCount: conversations.reduce((count, conversation) => count + conversation.messages.length, 0),
      byteSize,
      characterCount: text.length,
    }
  }
}
