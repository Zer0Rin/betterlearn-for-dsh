import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, test, vi } from 'vitest'
import { ProductApiError } from '../src/client/client-api.js'
import { DshConversationImport } from '../src/client/components/DshConversationImport.js'
import type { DshConversationPreview } from '../src/client/types.js'

const conversations = [
  { sessionId: 'session-a', title: 'React 状态复习', updatedAt: 30 },
  { sessionId: 'session-b', title: 'TypeScript 类型系统', updatedAt: 20 },
  { sessionId: 'session-c', title: '数据库索引', updatedAt: 10 },
]

const preview: DshConversationPreview = {
  sessionIds: ['session-a', 'session-b'],
  filename: 'DSH对话合集-React 状态复习-等2个.md',
  mediaType: 'application/vnd.betterlearn.dsh-conversation+markdown',
  text: '# DSH 对话合集\n\n## 对话：React 状态复习\n\n### 用户\n<img src=x onerror=alert(1)>\n\n### DSH\n这是文本。',
  contentDigest: 'd'.repeat(64),
  conversationCount: 2,
  messageCount: 4,
  byteSize: 128,
  characterCount: 96,
  extractionPlan: { strategy: 'L2', maxCalls: 3 },
}

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType('button').find(node => node.children.join('') === label)!
}

function render(overrides: Partial<Parameters<typeof DshConversationImport>[0]> = {}) {
  const previewDshConversations = overrides.previewDshConversations
    ?? vi.fn(async () => preview)
  const onSubmit = overrides.onSubmit ?? vi.fn(async () => true)
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(<DshConversationImport
      conversations={conversations}
      submitting={false}
      ordinarySession
      modelSelection={{ provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' }}
      modelStatus="ready"
      previewDshConversations={previewDshConversations}
      onSubmit={onSubmit}
      onBack={vi.fn()}
      {...overrides}
    />)
  })
  return { renderer, previewDshConversations, onSubmit }
}

function checkbox(renderer: ReactTestRenderer, sessionId: string) {
  return renderer.root.findByProps({ 'data-session-id': sessionId })
}

describe('DSH conversation import', () => {
  test('searches and multi-selects ordinary conversations before a mandatory preview', async () => {
    const { renderer, previewDshConversations, onSubmit } = render()
    expect(JSON.stringify(renderer.toJSON())).toContain('选择 DSH 对话')
    expect(JSON.stringify(renderer.toJSON())).toContain('已选择 0 个')
    expect(findButton(renderer, '预览合并内容').props.disabled).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()

    act(() => renderer.root.findByProps({ 'data-testid': 'dsh-conversation-search' }).props.onChange({
      currentTarget: { value: 'type' },
    }))
    expect(renderer.root.findAllByProps({ 'data-testid': 'dsh-conversation-row' })).toHaveLength(1)
    act(() => checkbox(renderer, 'session-b').props.onChange({ currentTarget: { checked: true } }))
    act(() => renderer.root.findByProps({ 'data-testid': 'dsh-conversation-search' }).props.onChange({
      currentTarget: { value: '' },
    }))
    act(() => checkbox(renderer, 'session-a').props.onChange({ currentTarget: { checked: true } }))
    expect(JSON.stringify(renderer.toJSON())).toContain('已选择 2 个')

    await act(async () => findButton(renderer, '预览合并内容').props.onClick())
    expect(previewDshConversations).toHaveBeenCalledWith(
      ['session-a', 'session-b'], expect.any(AbortSignal),
    )
    expect(onSubmit).not.toHaveBeenCalled()
    const pre = renderer.root.findByProps({ 'data-testid': 'dsh-conversation-preview-text' })
    expect(pre.children).toEqual([preview.text])
    expect(pre.props.dangerouslySetInnerHTML).toBeUndefined()
    const output = JSON.stringify(renderer.toJSON())
    expect(output).toContain('2 个对话')
    expect(output).toContain('4 条消息')
    expect(output).toContain('L2 · 最多 3 次模型调用')

    act(() => findButton(renderer, '返回修改选择').props.onClick())
    expect(checkbox(renderer, 'session-a').props.checked).toBe(true)
    expect(checkbox(renderer, 'session-b').props.checked).toBe(true)
  })

  test('keeps selection across preview errors and supports an explicit retry', async () => {
    const previewDshConversations = vi.fn()
      .mockRejectedValueOnce(new ProductApiError(400, 'DSH_CONVERSATION_TOO_LARGE'))
      .mockResolvedValueOnce(preview)
    const { renderer } = render({ previewDshConversations })
    act(() => checkbox(renderer, 'session-a').props.onChange({ currentTarget: { checked: true } }))

    await act(async () => findButton(renderer, '预览合并内容').props.onClick())
    expect(JSON.stringify(renderer.toJSON())).toContain('超过 512 KiB')
    expect(checkbox(renderer, 'session-a').props.checked).toBe(true)

    await act(async () => findButton(renderer, '重新预览').props.onClick())
    expect(previewDshConversations).toHaveBeenCalledTimes(2)
    expect(renderer.root.findByProps({ 'data-testid': 'dsh-conversation-preview-text' })).toBeDefined()
  })

  test('invalidates a stale preview after a 409 and requires preview again', async () => {
    const onSubmit = vi.fn(async () => {
      throw new ProductApiError(409, 'DSH_CONVERSATION_CHANGED')
    })
    const { renderer, previewDshConversations } = render({ onSubmit })
    act(() => checkbox(renderer, 'session-a').props.onChange({ currentTarget: { checked: true } }))
    await act(async () => findButton(renderer, '预览合并内容').props.onClick())

    await act(async () => findButton(renderer, '开始提取').props.onClick())
    expect(onSubmit).toHaveBeenCalledWith({
      sessionIds: preview.sessionIds,
      expectedDigest: preview.contentDigest,
    })
    expect(JSON.stringify(renderer.toJSON())).toContain('内容在预览后发生了变化')
    expect(findButton(renderer, '开始提取').props.disabled).toBe(true)

    await act(async () => findButton(renderer, '重新预览').props.onClick())
    expect(previewDshConversations).toHaveBeenCalledTimes(2)
    expect(findButton(renderer, '开始提取').props.disabled).toBe(false)
  })

  test('shows an empty state and prunes selections only when sessions disappear', () => {
    const { renderer } = render()
    act(() => checkbox(renderer, 'session-a').props.onChange({ currentTarget: { checked: true } }))
    act(() => checkbox(renderer, 'session-b').props.onChange({ currentTarget: { checked: true } }))

    act(() => renderer.update(<DshConversationImport
      conversations={[conversations[1]!]}
      submitting={false}
      ordinarySession
      modelSelection={{ provider: 'provider-a', model: 'model-a' }}
      modelStatus="ready"
      previewDshConversations={vi.fn(async () => preview)}
      onSubmit={vi.fn(async () => true)}
      onBack={vi.fn()}
    />))
    expect(JSON.stringify(renderer.toJSON())).toContain('已选择 1 个')
    expect(checkbox(renderer, 'session-b').props.checked).toBe(true)

    act(() => renderer.update(<DshConversationImport
      conversations={[]}
      submitting={false}
      ordinarySession
      modelSelection={{ provider: 'provider-a', model: 'model-a' }}
      modelStatus="ready"
      previewDshConversations={vi.fn(async () => preview)}
      onSubmit={vi.fn(async () => true)}
      onBack={vi.fn()}
    />))
    expect(JSON.stringify(renderer.toJSON())).toContain('没有可选择的普通 DSH 对话')
    expect(JSON.stringify(renderer.toJSON())).toContain('已选择 0 个')
  })

  test('disables selection and duplicate submission while busy', async () => {
    const { renderer } = render({ submitting: true })
    expect(checkbox(renderer, 'session-a').props.disabled).toBe(true)
    expect(findButton(renderer, '预览合并内容').props.disabled).toBe(true)
  })
})
