import { createHash } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import {
  Session,
  SessionId,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import {
  createAssistantMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import {
  DSH_CONVERSATION_MEDIA_TYPE,
  DshConversationSource,
  DshConversationSourceError,
} from '../src/product/dsh-conversation-source.js'

function header(id: string, createdAt: number, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: 0, id: SessionId(id), createdAt, ...extra }
}

function snapshot(session: Session): SessionLogSnapshot {
  return { session: structuredClone(session.header), events: structuredClone(session.events) }
}

function ordinarySession(id: string, createdAt: number, title?: string): Session {
  const session = Session.create(SessionId(id), [], header(id, createdAt))
  if (title) session.append('session/title', {
    title,
    messageSeqs: [],
    source: { kind: 'user' },
  })
  return session
}

function human(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function model(session: Session, content: unknown[]): void {
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: content as never,
      source: { provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
}

function sourceFrom(snapshots: Record<string, SessionLogSnapshot>) {
  const readSession = vi.fn(async (id: string) => {
    const found = snapshots[id]
    if (!found) throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    return structuredClone(found)
  })
  return { source: new DshConversationSource({ readSession } as never), readSession }
}

describe('DSH conversation source', () => {
  test('merges ordinary sessions oldest first and keeps only append-origin human/model text', async () => {
    const newer = ordinarySession('session-new', 200, '新/主题')
    newer.append('request/header', {
      header: { config: { provider: 'fixture', model: 'fixture' }, system: 'SYSTEM_SECRET' },
      reason: 'initial',
    })
    newer.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'PLUGIN_SECRET' }],
      source: { kind: 'plugin', plugin: 'fixture' },
    }), { surfaceOp: 'append' })
    human(newer, ' 新问题\r\n第二行 ')
    model(newer, [
      { type: 'reasoning', text: 'REASONING_SECRET' },
      { type: 'text', text: '公开' },
      { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"secret":true}' },
      { type: 'text', text: '回答' },
      { type: 'future-block', text: 'FUTURE_SECRET' },
    ])
    const original = newer.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')!
    newer.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'REPLACEMENT_SECRET' }],
      source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', start: original.seq, end: original.seq }, sourceEventSeqs: [original.seq] })

    const older = ordinarySession('session-old', 100, '旧主题')
    human(older, '旧问题')
    model(older, [{ type: 'text', text: '旧回答' }])

    const { source, readSession } = sourceFrom({
      'session-new': snapshot(newer),
      'session-old': snapshot(older),
    })

    const result = await source.read(['session-new', 'session-old'])

    expect(readSession.mock.calls.map(call => call[0])).toEqual(['session-new', 'session-old'])
    expect(result).toMatchObject({
      sessionIds: ['session-old', 'session-new'],
      filename: 'DSH对话合集-旧主题-等2个.md',
      mediaType: DSH_CONVERSATION_MEDIA_TYPE,
      conversationCount: 2,
      messageCount: 4,
      characterCount: result.text.length,
      byteSize: Buffer.byteLength(result.text, 'utf8'),
    })
    expect(result.text).toBe([
      '# DSH 对话合集',
      '',
      '## 对话：旧主题',
      '',
      '### 用户',
      '',
      '旧问题',
      '',
      '### DSH',
      '',
      '旧回答',
      '',
      '---',
      '',
      '## 对话：新/主题',
      '',
      '### 用户',
      '',
      '新问题\n第二行',
      '',
      '### DSH',
      '',
      '公开\n回答',
    ].join('\n'))
    expect(result.text).not.toMatch(/SECRET/)
    expect(result.contentDigest).toBe(createHash('sha256').update(result.text, 'utf8').digest('hex'))
  })

  test('uses a stable fallback title and rejects subagents or empty ordinary sessions', async () => {
    const untitled = ordinarySession('session-untitled', 1)
    human(untitled, '问题')
    const child = Session.create(
      SessionId('session-child'),
      [],
      header('session-child', 2, { origin: 'subagent', delegationDepth: 1 }),
    )
    human(child, '内部问题')
    const empty = ordinarySession('session-empty', 3, '空对话')
    empty.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '上下文' }],
      source: { kind: 'plugin', plugin: 'fixture' },
    }), { surfaceOp: 'append' })
    const { source } = sourceFrom({
      'session-untitled': snapshot(untitled),
      'session-child': snapshot(child),
      'session-empty': snapshot(empty),
    })

    await expect(source.read(['session-untitled'])).resolves.toMatchObject({
      filename: 'DSH对话合集-未命名对话1.md',
    })
    await expect(source.read(['session-child'])).rejects.toMatchObject({
      code: 'DSH_CONVERSATION_NOT_ORDINARY',
    })
    await expect(source.read(['session-empty'])).rejects.toMatchObject({
      code: 'DSH_CONVERSATION_EMPTY',
    })
  })

  test('fails the whole batch for a missing or unreadable session', async () => {
    const valid = ordinarySession('session-valid', 1, '有效')
    human(valid, '问题')
    const missing = sourceFrom({ 'session-valid': snapshot(valid) }).source
    await expect(missing.read(['session-valid', 'session-missing'])).rejects.toMatchObject({
      code: 'DSH_CONVERSATION_NOT_FOUND',
    })

    const readSession = vi.fn(async () => { throw new Error('private storage path') })
    const broken = new DshConversationSource({ readSession } as never)
    await expect(broken.read(['session-broken'])).rejects.toEqual(expect.objectContaining({
      code: 'DSH_CONVERSATION_READ_FAILED',
      message: 'DSH_CONVERSATION_READ_FAILED',
    }))
  })

  test('rejects content over 512 KiB and honors pre-aborted reads', async () => {
    const large = ordinarySession('session-large', 1, '大对话')
    human(large, 'x'.repeat(512 * 1024))
    const { source, readSession } = sourceFrom({ 'session-large': snapshot(large) })
    await expect(source.read(['session-large'])).rejects.toEqual(expect.objectContaining({
      code: 'DSH_CONVERSATION_TOO_LARGE',
      detail: expect.objectContaining({ maxBytes: 512 * 1024 }),
    }))

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(source.read(['session-large'], controller.signal)).rejects.toThrow('cancelled')
    expect(readSession).toHaveBeenCalledOnce()
  })

  test('exports a closed typed source failure', () => {
    const error = new DshConversationSourceError('DSH_CONVERSATION_EMPTY')
    expect(error).toMatchObject({ name: 'DshConversationSourceError', message: 'DSH_CONVERSATION_EMPTY' })
  })
})
