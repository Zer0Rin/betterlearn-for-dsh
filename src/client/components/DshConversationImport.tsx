import { useEffect, useMemo, useRef, useState } from 'react'
import { ProductApiError } from '../client-api.js'
import type { DshConversationSummary } from '../dsh-conversation-sessions.js'
import { modelSelectionLabel } from '../model-directory-bridge.js'
import type {
  ClientApi,
  DshConversationPreview,
  ModelSelectionSnapshot,
} from '../types.js'
import type { ModelDirectoryStatus } from '../use-nobei-workspace.js'

export type ConversationImportState =
  | { step: 'select'; selected: string[]; query: string }
  | { step: 'previewing'; selected: string[]; query: string }
  | { step: 'preview'; selected: string[]; query: string; preview: DshConversationPreview }

export interface DshConversationImportProps {
  conversations: DshConversationSummary[]
  submitting: boolean
  error?: string
  modelSelection?: ModelSelectionSnapshot
  modelStatus: ModelDirectoryStatus
  ordinarySession: boolean
  previewDshConversations: ClientApi['previewDshConversations']
  onSubmit(input: { sessionIds: string[]; expectedDigest: string }): Promise<boolean>
  onBack(): void
}

function previewErrorMessage(error: unknown): string {
  const code = error instanceof ProductApiError ? error.code : error instanceof Error ? error.message : ''
  if (code === 'DSH_CONVERSATION_TOO_LARGE') return '合并后的对话超过 512 KiB，请减少选择。'
  if (code === 'DSH_CONVERSATION_NOT_FOUND') return '有对话已不存在，请刷新列表后重试。'
  if (code === 'DSH_CONVERSATION_NOT_ORDINARY') return '选择中包含子 Agent 对话，已停止预览。'
  if (code === 'DSH_CONVERSATION_EMPTY') return '所选对话没有可提取的用户与 DSH 问答文本。'
  if (code === 'DSH_CONVERSATION_READ_FAILED') return '读取 DSH 对话失败，请稍后重试。'
  return '无法预览所选对话，请检查连接后重试。'
}

export function DshConversationImport({
  conversations,
  submitting,
  error,
  modelSelection,
  modelStatus,
  ordinarySession,
  previewDshConversations,
  onSubmit,
  onBack,
}: DshConversationImportProps) {
  const [state, setState] = useState<ConversationImportState>({ step: 'select', selected: [], query: '' })
  const [previewError, setPreviewError] = useState<string>()
  const [stale, setStale] = useState(false)
  const previewController = useRef<AbortController>()

  useEffect(() => () => previewController.current?.abort(), [])
  useEffect(() => {
    const available = new Set(conversations.map(conversation => conversation.sessionId))
    const selected = state.selected.filter(sessionId => available.has(sessionId))
    if (selected.length === state.selected.length) return
    setState({ step: 'select', selected, query: state.query })
    setStale(false)
    setPreviewError(undefined)
  }, [conversations, state])

  const filtered = useMemo(() => {
    const query = state.query.trim().toLocaleLowerCase('zh-CN')
    return query === '' ? conversations : conversations.filter(conversation =>
      conversation.title.toLocaleLowerCase('zh-CN').includes(query))
  }, [conversations, state.query])

  function updateQuery(query: string): void {
    setState(current => ({ step: 'select', selected: current.selected, query }))
    setStale(false)
  }

  function toggle(sessionId: string, checked: boolean): void {
    setState(current => {
      const next = new Set(current.selected)
      if (checked) next.add(sessionId)
      else next.delete(sessionId)
      const selected = conversations
        .map(conversation => conversation.sessionId)
        .filter(id => next.has(id))
      return { step: 'select', selected, query: current.query }
    })
    setPreviewError(undefined)
    setStale(false)
  }

  async function loadPreview(): Promise<void> {
    if (state.selected.length === 0 || state.step === 'previewing' || !ordinarySession) return
    previewController.current?.abort()
    const controller = new AbortController()
    previewController.current = controller
    const selected = [...state.selected]
    const query = state.query
    setPreviewError(undefined)
    setStale(false)
    setState({ step: 'previewing', selected, query })
    try {
      const preview = await previewDshConversations(selected, controller.signal)
      if (!controller.signal.aborted && previewController.current === controller) {
        setState({ step: 'preview', selected, query, preview })
      }
    } catch (caught) {
      if (!controller.signal.aborted && previewController.current === controller) {
        setPreviewError(previewErrorMessage(caught))
        setState({ step: 'select', selected, query })
      }
    }
  }

  async function submitPreview(): Promise<void> {
    if (state.step !== 'preview' || stale || submitting || modelStatus !== 'ready' || !modelSelection) return
    try {
      await onSubmit({
        sessionIds: [...state.preview.sessionIds],
        expectedDigest: state.preview.contentDigest,
      })
    } catch (caught) {
      if (caught instanceof ProductApiError && caught.code === 'DSH_CONVERSATION_CHANGED') {
        setStale(true)
        return
      }
      setPreviewError('提交失败，所选对话和预览仍已保留。')
    }
  }

  if (state.step === 'preview') {
    return <section className="nobei-client__import nobei-client__conversation-import" aria-labelledby="nobei-dsh-preview-title">
      <header>
        <p className="nobei-client__eyebrow">DSH 对话预览</p>
        <h2 id="nobei-dsh-preview-title">确认将要提取的完整内容</h2>
        <p>这里只包含用户问题和 DSH 的可见文字回答；系统提示、推理、工具与子 Agent 内容不在其中。</p>
      </header>
      <dl className="nobei-client__conversation-stats">
        <div><dt>对话</dt><dd>{`${state.preview.conversationCount} 个对话`}</dd></div>
        <div><dt>消息</dt><dd>{`${state.preview.messageCount} 条消息`}</dd></div>
        <div><dt>字符</dt><dd>{state.preview.characterCount.toLocaleString('zh-CN')}</dd></div>
        <div><dt>大小</dt><dd>{state.preview.byteSize.toLocaleString('zh-CN')} / 524,288 字节</dd></div>
      </dl>
      <p className="nobei-client__conversation-plan">
        {`${state.preview.extractionPlan.strategy} · 最多 ${state.preview.extractionPlan.maxCalls} 次模型调用`}
      </p>
      <pre className="nobei-client__conversation-preview" data-testid="dsh-conversation-preview-text">{state.preview.text}</pre>
      {modelSelection && <p className="nobei-client__conversation-model">本次模型：{modelSelectionLabel(modelSelection)}</p>}
      {stale && <p className="nobei-client__error" role="alert">内容在预览后发生了变化，必须重新预览后才能提取。</p>}
      {(error ?? previewError) && !stale && <p className="nobei-client__error" role="alert">{error ?? previewError}</p>}
      <div className="nobei-client__conversation-actions">
        <button type="button" disabled={submitting} onClick={() => {
          setState({ step: 'select', selected: state.selected, query: state.query })
          setStale(false)
        }}>返回修改选择</button>
        {stale && <button type="button" disabled={submitting} onClick={() => { void loadPreview() }}>重新预览</button>}
        <button className="nobei-client__primary" type="button"
          disabled={submitting || stale || !ordinarySession || modelStatus !== 'ready' || !modelSelection}
          onClick={() => { void submitPreview() }}>
          {submitting ? '正在提交…' : '开始提取'}
        </button>
      </div>
    </section>
  }

  return <section className="nobei-client__import nobei-client__conversation-import" aria-labelledby="nobei-dsh-select-title">
    <header>
      <p className="nobei-client__eyebrow">从 DSH 对话提取</p>
      <h2 id="nobei-dsh-select-title">选择 DSH 对话</h2>
      <p>可以选择多个相关对话；它们会合并为一个知识点提取任务。</p>
    </header>
    <button className="nobei-client__back" type="button" disabled={submitting} onClick={onBack}>返回选择来源</button>
    <label className="nobei-client__conversation-search">
      <span>搜索标题</span>
      <input data-testid="dsh-conversation-search" type="search" value={state.query}
        disabled={submitting || state.step === 'previewing'}
        onChange={event => updateQuery(event.currentTarget.value)} />
    </label>
    <div className="nobei-client__conversation-selection-meta">
      <strong>{`已选择 ${state.selected.length} 个`}</strong>
      <span>最多 50 个 · 合并上限 512 KiB</span>
    </div>
    <div className="nobei-client__conversation-list" role="group" aria-label="普通 DSH 对话">
      {conversations.length === 0
        ? <p className="nobei-client__conversation-empty">没有可选择的普通 DSH 对话。</p>
        : filtered.length === 0
          ? <p className="nobei-client__conversation-empty">没有标题匹配的对话。</p>
          : filtered.map(conversation => <label key={conversation.sessionId}
            className="nobei-client__conversation-row" data-testid="dsh-conversation-row">
            <input type="checkbox" data-session-id={conversation.sessionId}
              checked={state.selected.includes(conversation.sessionId)}
              disabled={submitting || state.step === 'previewing'}
              onChange={event => toggle(conversation.sessionId, event.currentTarget.checked)} />
            <span><strong>{conversation.title}</strong>
              <time>{new Date(conversation.updatedAt).toLocaleString('zh-CN')}</time></span>
          </label>)}
    </div>
    {!ordinarySession && <p className="nobei-client__error" role="alert">当前是子 Agent 会话，请在普通会话中使用 BetterLearn。</p>}
    {previewError && <p className="nobei-client__error" role="alert">{previewError}</p>}
    {error && <p className="nobei-client__error" role="alert">{error}</p>}
    <div className="nobei-client__conversation-actions">
      {previewError && <button type="button" disabled={submitting} onClick={() => { void loadPreview() }}>重新预览</button>}
      <button className="nobei-client__primary" type="button"
        disabled={submitting || state.step === 'previewing' || state.selected.length === 0 || !ordinarySession}
        onClick={() => { void loadPreview() }}>
        {state.step === 'previewing' ? '正在生成预览…' : '预览合并内容'}
      </button>
    </div>
  </section>
}
