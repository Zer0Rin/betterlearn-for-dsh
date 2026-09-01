import { describe, expect, test, vi } from 'vitest'
import { selectableDshConversations } from '../src/client/dsh-conversation-sessions.js'

describe('selectable DSH conversation projection', () => {
  test('keeps DSH list order while excluding blank, subagent, and addressed rows', () => {
    const state = {
      ids: ['ordinary-new', 'blank', 'origin-subagent', 'addressed', 'ordinary-fork'],
      byId: {
        'ordinary-new': {
          id: 'ordinary-new', displayTitle: '新版复习', blank: false, updatedAt: 50,
        },
        blank: {
          id: 'blank', displayTitle: '新对话', blank: true, updatedAt: 40,
        },
        'origin-subagent': {
          id: 'origin-subagent', displayTitle: '内部子任务', blank: false,
          origin: 'subagent', parentId: 'ordinary-new', updatedAt: 30,
        },
        addressed: {
          id: 'addressed', displayTitle: '地址化子任务', blank: false, updatedAt: 20,
        },
        'ordinary-fork': {
          id: 'ordinary-fork', displayTitle: '普通分叉', blank: false,
          parentId: 'ordinary-new', updatedAt: 10,
        },
      },
    }
    const subagentAddress = vi.fn((id: string) => id === 'addressed'
      ? { parentSessionId: 'ordinary-new', childSessionId: id }
      : undefined)

    const result = selectableDshConversations(state as never, subagentAddress as never)

    expect(result).toEqual([
      { sessionId: 'ordinary-new', title: '新版复习', updatedAt: 50 },
      { sessionId: 'ordinary-fork', title: '普通分叉', updatedAt: 10 },
    ])
    expect(subagentAddress).toHaveBeenCalledWith('ordinary-new')
    expect(subagentAddress).toHaveBeenCalledWith('addressed')
  })

  test('skips missing rows and returns detached summary objects', () => {
    const row = {
      id: 'ordinary', displayTitle: '原始标题', blank: false, updatedAt: 7,
    }
    const state = { ids: ['missing', 'ordinary'], byId: { ordinary: row } }

    const result = selectableDshConversations(state as never, () => undefined)
    result[0]!.title = '客户端修改'

    expect(row.displayTitle).toBe('原始标题')
    expect(result).toEqual([
      { sessionId: 'ordinary', title: '客户端修改', updatedAt: 7 },
    ])
  })
})
