import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, test, vi } from 'vitest'
import { ImportWorkspace } from '../src/client/components/ImportWorkspace.js'
import type { DocumentPreview, DocumentPreviewRequest } from '../src/client/types.js'

const fixedNow = new Date('2026-08-29T12:00:00+08:00')
const modelSelection = { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' }

function render(
  props: Partial<Parameters<typeof ImportWorkspace>[0]> = {},
  source: 'file' | 'landing' = 'file',
) {
  let renderer!: ReactTestRenderer
  const onSubmit = props.onSubmit ?? vi.fn(async () => true)
  act(() => {
    renderer = create(<ImportWorkspace submitting={false} onSubmit={onSubmit} now={fixedNow}
      conversations={[]} previewDshConversations={vi.fn()} onSubmitDsh={vi.fn(async () => true)}
      modelSelection={modelSelection} modelStatus="ready" ordinarySession {...props} />)
  })
  if (source === 'file') act(() => button(renderer, '上传文件').props.onClick())
  return { renderer, onSubmit }
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType('button').find(node =>
    node.props['aria-label'] === label || node.children.join('') === label)!
}

async function chooseFile(renderer: ReactTestRenderer, file: File) {
  await act(async () => {
    await renderer.root.findByProps({ 'data-testid': 'nobei-file-input' }).props.onChange({
      currentTarget: { files: [file] },
    })
  })
}

describe('phase1d import workspace', () => {
  test('starts with three independent source choices and opens the DSH selector', () => {
    const { renderer } = render({}, 'landing')
    expect(button(renderer, '从 DSH 对话提取')).toBeDefined()
    expect(button(renderer, '上传文件')).toBeDefined()
    expect(button(renderer, '粘贴正文')).toBeDefined()

    act(() => button(renderer, '从 DSH 对话提取').props.onClick())
    expect(JSON.stringify(renderer.toJSON())).toContain('选择 DSH 对话')
    expect(renderer.root.findAllByProps({ 'data-testid': 'nobei-file-input' })).toHaveLength(0)
  })
  test('previews PDF without starting generation and submits canonical text only after click', async () => {
    vi.useFakeTimers()
    const preview: DocumentPreview = { filename: '教材.pdf', mediaType: 'application/pdf', text: '中文原文\n第二页',
      byteSize: 22, characterCount: 8, pages: [{ page: 1, textStart: 0, textEnd: 4 }],
      extractionPlan: { strategy: 'L1', maxCalls: 1 } }
    const previewDocument = vi.fn(async (_input: DocumentPreviewRequest) => preview)
    const { renderer, onSubmit } = render({ previewDocument })
    try {
      await chooseFile(renderer, new File(['%PDF-test'], '教材.pdf', { type: 'application/pdf' }))
      expect(previewDocument.mock.calls[0][0]).toEqual({
        filename: '教材.pdf', mediaType: 'application/pdf', contentBase64: btoa('%PDF-test'),
      })
      expect(onSubmit).not.toHaveBeenCalled()
      expect(button(renderer, '开始提取').props.disabled).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(renderer.root.findByProps({ 'data-testid': 'nobei-file-preview' }).children).toEqual([preview.text])
      expect(button(renderer, '开始提取').props.disabled).toBe(false)
      await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }))
      expect(onSubmit).toHaveBeenCalledWith({ filename: '教材.pdf', mediaType: 'application/pdf', text: preview.text })
    } finally { act(() => renderer.unmount()); vi.useRealTimers() }
  })

  test('requires the current long-text plan, ignores stale previews and reports scan errors', async () => {
    vi.useFakeTimers()
    let finish!: (value: DocumentPreview) => void
    const previewDocument = vi.fn((_input: DocumentPreviewRequest) => new Promise<DocumentPreview>(resolve => { finish = resolve }))
    const { renderer, onSubmit } = render({ previewDocument })
    try {
      act(() => button(renderer, '粘贴文本').props.onClick())
      const setText = (value: string) => act(() => renderer.root.findByProps({ 'data-testid': 'nobei-paste-text' }).props.onChange({ currentTarget: { value } }))
      setText('长'.repeat(8000))
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      const oldFinish = finish
      setText('新'.repeat(9000))
      await act(async () => oldFinish({ filename: 'old.md', mediaType: 'text/markdown', text: 'old', byteSize: 3, characterCount: 3, pages: [], extractionPlan: { strategy: 'L1', maxCalls: 1 } }))
      expect(button(renderer, '开始提取').props.disabled).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      await act(async () => finish({ filename: 'new.md', mediaType: 'text/markdown', text: '新'.repeat(9000), byteSize: 27000, characterCount: 9000, pages: [], extractionPlan: { strategy: 'L2', maxCalls: 5 } }))
      expect(renderer.root.findByProps({ 'data-testid': 'nobei-extraction-plan' }).children.join('')).toContain('L2 · 点击“开始提取”会发起最多 5 次模型调用')
      expect(button(renderer, '开始提取').props.disabled).toBe(false)
      expect(onSubmit).not.toHaveBeenCalled()
      act(() => button(renderer, '选择文件').props.onClick())
      previewDocument.mockRejectedValueOnce(new Error('PDF_NO_TEXT'))
      await chooseFile(renderer, new File(['scan'], '扫描.pdf', { type: 'application/pdf' }))
      expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('OCR')
      expect(button(renderer, '开始提取').props.disabled).toBe(true)
    } finally { act(() => renderer.unmount()); vi.useRealTimers() }
  })

  test('changing files clears the old draft while the new read is pending', async () => {
    const { renderer } = render()
    await chooseFile(renderer, new File(['旧正文'], 'old.txt', { type: 'text/plain' }))
    expect(button(renderer, '开始提取').props.disabled).toBe(false)
    let finish!: (text: string) => void
    const file = { name: 'new.txt', type: 'text/plain', size: 6, text: () => new Promise<string>(resolve => { finish = resolve }) } as File
    await chooseFile(renderer, file)
    expect(button(renderer, '开始提取').props.disabled).toBe(true)
    expect(renderer.root.findAllByProps({ 'data-testid': 'nobei-file-name' })).toHaveLength(0)
    await chooseFile(renderer, new File(['当前正文'], 'current.txt', { type: 'text/plain' }))
    await act(async () => finish('已经过期'))
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-file-preview' }).children).toEqual(['当前正文'])
    act(() => renderer.unmount())
  })

  test('shows the current DSH model and the one-call authorization boundary', () => {
    const { renderer } = render()
    const output = JSON.stringify(renderer.toJSON())
    expect(output).toContain('本次模型：')
    expect(output).toContain('provider-a / model-a · high')
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-model-selection' }).props['data-model-status']).toBe('ready')
    expect(output).toContain('修改 DSH 模型只影响之后创建的任务')
    expect(output).toContain('最多 1 次模型调用')
  })

  test('does not authorize submission while the DSH model directory is still loading', () => {
    const { renderer } = render({ modelSelection: undefined, modelStatus: 'loading' })
    act(() => button(renderer, '粘贴文本').props.onClick())
    act(() => renderer.root.findByProps({ 'data-testid': 'nobei-paste-text' }).props.onChange({
      currentTarget: { value: '正文' },
    }))
    expect(JSON.stringify(renderer.toJSON())).toContain('正在读取 DSH 当前模型')
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-model-selection' }).props['data-model-status']).toBe('loading')
    expect(button(renderer, '开始提取').props.disabled).toBe(true)
  })

  test('retains independent paste and file drafts while switching tabs', async () => {
    const { renderer } = render()
    expect(button(renderer, '选择文件')).toBeDefined()
    expect(button(renderer, '粘贴文本')).toBeDefined()
    act(() => button(renderer, '粘贴文本').props.onClick())
    act(() => {
      renderer.root.findByProps({ 'data-testid': 'nobei-paste-name' }).props.onChange({ currentTarget: { value: '章节.md' } })
      renderer.root.findByProps({ 'data-testid': 'nobei-paste-text' }).props.onChange({ currentTarget: { value: '粘贴正文' } })
    })
    act(() => button(renderer, '选择文件').props.onClick())
    await chooseFile(renderer, new File(['文件正文'], '课件.txt', { type: 'text/plain' }))
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-file-name' }).children).toEqual(['课件.txt'])

    act(() => button(renderer, '粘贴文本').props.onClick())
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-paste-name' }).props.value).toBe('章节.md')
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-paste-text' }).props.value).toBe('粘贴正文')
    act(() => button(renderer, '选择文件').props.onClick())
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-file-name' }).children).toEqual(['课件.txt'])
  })

  test('validates pasted Markdown and submits its exact content once', async () => {
    const onSubmit = vi.fn(async () => true)
    const { renderer } = render({ onSubmit })
    act(() => button(renderer, '粘贴文本').props.onClick())
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-paste-name' }).props.value)
      .toBe('粘贴内容-2026-08-29.md')
    expect(button(renderer, '开始提取').props.disabled).toBe(true)
    act(() => renderer.root.findByProps({ 'data-testid': 'nobei-paste-text' }).props.onChange({
      currentTarget: { value: '# 光合作用' },
    }))
    expect(button(renderer, '开始提取').props.disabled).toBe(false)
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault() {} })
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({
      filename: '粘贴内容-2026-08-29.md', mediaType: 'text/markdown', text: '# 光合作用',
    })
  })

  test('previews a TXT file without exposing a local path', async () => {
    const { renderer, onSubmit } = render()
    await chooseFile(renderer, new File(['中文🙂'], '教材.txt', { type: 'text/plain' }))
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-file-name' }).children).toEqual(['教材.txt'])
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-file-meta' }).children.join('')).toContain('10 字节')
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-file-meta' }).children.join('')).toContain('3 字符')
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-file-preview' }).children).toEqual(['中文🙂'])
    expect(JSON.stringify(renderer.toJSON())).not.toContain('/Users/')
    await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }))
    expect(onSubmit).toHaveBeenCalledWith({ filename: '教材.txt', mediaType: 'text/plain', text: '中文🙂' })
  })

  test('rejects unavailable PDF preview and oversized files before submission', async () => {
    const { renderer, onSubmit } = render()
    await chooseFile(renderer, new File(['pdf'], '教材.pdf', { type: 'application/pdf' }))
    expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('无法预览')
    expect(button(renderer, '开始提取').props.disabled).toBe(true)
    await chooseFile(renderer, new File(['a'.repeat(524_289)], '教材.txt', { type: 'text/plain' }))
    expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('524,288')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('disables tabs and actions while submitting and preserves a rejected draft', () => {
    const { renderer, onSubmit } = render({ submitting: true, error: '暂时无法提交' })
    expect(button(renderer, '选择文件').props.disabled).toBe(true)
    expect(button(renderer, '粘贴文本').props.disabled).toBe(true)
    expect(button(renderer, '正在提交…').props.disabled).toBe(true)
    expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('暂时无法提交')
    act(() => button(renderer, '正在提交…').props.onClick?.())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('keeps pasted text when the import command fails', async () => {
    const onSubmit = vi.fn(async () => false)
    const { renderer } = render({ onSubmit })
    act(() => button(renderer, '粘贴文本').props.onClick())
    act(() => renderer.root.findByProps({ 'data-testid': 'nobei-paste-text' }).props.onChange({
      currentTarget: { value: '不能丢失的正文' },
    }))
    await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }))
    expect(renderer.root.findByProps({ 'data-testid': 'nobei-paste-text' }).props.value)
      .toBe('不能丢失的正文')
  })
})
