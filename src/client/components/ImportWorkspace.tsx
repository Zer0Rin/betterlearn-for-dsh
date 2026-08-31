import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  defaultPasteFilename,
  MAX_DOCUMENT_BYTES,
  mediaTypeForFile,
  validateImport,
} from '../import-validation.js'
import type { ClientApi, ImportTextInput } from '../types.js'
import { documentPreviewError, useDocumentPreview } from '../use-document-preview.js'
import type { ModelSelectionSnapshot } from '../types.js'
import type { ModelDirectoryStatus } from '../use-nobei-workspace.js'
import { modelSelectionLabel } from '../model-directory-bridge.js'

export interface ImportWorkspaceProps {
  submitting: boolean
  error?: string
  modelSelection?: ModelSelectionSnapshot
  modelStatus: ModelDirectoryStatus
  ordinarySession: boolean
  onSubmit(input: ImportTextInput): Promise<boolean>
  previewDocument?: ClientApi['previewDocument']
  now?: Date
}

type InputMode = 'file' | 'paste'

interface FileDraft {
  input: ImportTextInput
  byteSize: number
  characterCount: number
}

function validationMessage(input: ImportTextInput | undefined): string | undefined {
  if (input === undefined) return undefined
  const validation = validateImport(input)
  if (validation.errors.includes('TEXT_TOO_LARGE')) return '正文不能超过 524,288 字节（512 KiB）。'
  if (validation.errors.includes('FILENAME_INVALID')) return '文件名必须是有效的 .txt、.md 或 .pdf 名称。'
  if (validation.errors.includes('MEDIA_TYPE_INVALID')) return '仅支持 TXT、Markdown 或 PDF。'
  if (validation.errors.includes('BODY_TOO_LARGE')) return '请求内容过大，请缩短正文。'
  return undefined
}

export function ImportWorkspace({
  submitting, error, modelSelection, modelStatus, ordinarySession, onSubmit, previewDocument, now = new Date(),
}: ImportWorkspaceProps) {
  const [mode, setMode] = useState<InputMode>('file')
  const [pasteName, setPasteName] = useState(() => defaultPasteFilename(now))
  const [pasteText, setPasteText] = useState('')
  const [fileDraft, setFileDraft] = useState<FileDraft>()
  const [fileError, setFileError] = useState<string>()
  const [readingFile, setReadingFile] = useState(false)
  const selection = useRef(0)
  useEffect(() => () => { selection.current += 1 }, [])

  const pasteInput = useMemo<ImportTextInput>(() => ({
    filename: pasteName,
    mediaType: pasteName.toLowerCase().endsWith('.txt') ? 'text/plain' : 'text/markdown',
    text: pasteText,
  }), [pasteName, pasteText])
  const activeInput = mode === 'file' ? fileDraft?.input : pasteInput
  const validation = activeInput === undefined ? undefined : validateImport(activeInput)
  const documentPreview = useDocumentPreview(validation?.valid ? activeInput : undefined, previewDocument)
  const invalidMessage = (mode === 'file' ? fileError ?? validationMessage(activeInput) : validationMessage(activeInput))
    ?? documentPreview.error
  const canSubmit = !submitting
    && !readingFile && !documentPreview.pending && !documentPreview.error
    && ordinarySession
    && modelStatus === 'ready'
    && modelSelection !== undefined
    && activeInput !== undefined
    && validation?.valid === true

  async function selectFile(file: File | undefined): Promise<void> {
    const currentSelection = ++selection.current
    setFileDraft(undefined)
    setFileError(undefined)
    setReadingFile(false)
    if (file === undefined) {
      setFileDraft(undefined)
      setFileError(undefined)
      return
    }
    const mediaType = mediaTypeForFile(file)
    if (mediaType === undefined) {
      setFileDraft(undefined)
      setFileError('仅支持 TXT、Markdown 或 PDF 文件。')
      return
    }
    const limit = mediaType === 'application/pdf' ? 5 * 1024 * 1024 : MAX_DOCUMENT_BYTES
    if (file.size > limit) {
      setFileError(mediaType === 'application/pdf' ? 'PDF 不能超过 5 MiB。' : '正文不能超过 524,288 字节（512 KiB）。')
      return
    }
    setReadingFile(true)
    try {
      let text: string
      if (mediaType === 'application/pdf') {
        if (!previewDocument) throw new Error('PREVIEW_UNAVAILABLE')
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 8192) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
        }
        const preview = await previewDocument({ filename: file.name, mediaType, contentBase64: btoa(binary) })
        text = preview.text
      } else text = await file.text()
      if (currentSelection !== selection.current) return
      const input: ImportTextInput = { filename: file.name, mediaType, text }
      const checked = validateImport(input)
      if (!checked.valid) {
        setFileError(validationMessage(input))
        return
      }
      setFileDraft({ input, byteSize: checked.byteSize, characterCount: checked.characterCount })
    } catch (error) {
      if (currentSelection === selection.current) setFileError(documentPreviewError(error))
    } finally {
      if (currentSelection === selection.current) setReadingFile(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!canSubmit || activeInput === undefined) return
    const succeeded = await onSubmit(documentPreview.preview
      ? { filename: activeInput.filename, mediaType: activeInput.mediaType, text: documentPreview.preview.text }
      : activeInput)
    if (!succeeded) return
    if (mode === 'file') {
      selection.current += 1
      setFileDraft(undefined)
    } else {
      setPasteText('')
    }
  }

  return (
    <section className="nobei-client__import" aria-labelledby="nobei-import-title">
      <header>
        <p className="nobei-client__eyebrow">新建学习材料</p>
        <h2 id="nobei-import-title">从一段原文开始</h2>
        <p>导入 TXT、Markdown、有文字层的 PDF，或直接粘贴文本。Nobei 会先定位证据，再交给你审核。</p>
      </header>

      <div className="nobei-client__tabs" role="tablist" aria-label="导入方式">
        <button type="button" role="tab" aria-selected={mode === 'file'} disabled={submitting}
          onClick={() => setMode('file')}>选择文件</button>
        <button type="button" role="tab" aria-selected={mode === 'paste'} disabled={submitting}
          onClick={() => setMode('paste')}>粘贴文本</button>
      </div>

      <form onSubmit={submit} aria-busy={submitting}>
        <div className="nobei-client__notice" data-testid="nobei-model-selection" data-model-status={modelStatus}>
          {modelSelection
            ? <strong>本次模型：{modelSelectionLabel(modelSelection)}</strong>
            : <strong>{modelStatus === 'loading' ? '正在读取 DSH 当前模型…' : '尚未读取到可用模型'}</strong>}
          <p>修改 DSH 模型只影响之后创建的任务。</p>
          <p data-testid="nobei-extraction-plan">{documentPreview.pending
            ? '正在预览提取计划（不调用模型）…'
            : documentPreview.preview
              ? `${documentPreview.preview.extractionPlan.strategy} · 点击“开始提取”会发起最多 ${documentPreview.preview.extractionPlan.maxCalls} 次模型调用。`
              : '短文点击“开始提取”会发起最多 1 次模型调用；长文预览后显示调用上限。'}</p>
          <p>长文会先规划，再分批提取；整批完成后统一审核。正文上限 512 KiB。</p>
          {ordinarySession && modelStatus === 'unroutable' && <p>当前 DSH 模型不可用，请先在 DSH 设置中选择可用模型。</p>}
          {ordinarySession && modelStatus === 'unavailable' && <p>无法读取 DSH 当前模型，请稍后重试。</p>}
          {!ordinarySession && <p>当前是子 Agent 会话，请在普通会话中使用 Nobei。</p>}
        </div>
        {mode === 'file' ? (
          <div className="nobei-client__input-panel" role="tabpanel">
            <label htmlFor="nobei-file-input">选择 TXT、Markdown 或 PDF 文件</label>
            <input id="nobei-file-input" data-testid="nobei-file-input" type="file"
              accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf" disabled={submitting}
              onChange={event => { void selectFile(event.currentTarget.files?.[0]) }} />
            {readingFile && <p role="status">正在读取和解析文件，不会调用模型…</p>}
            <p>PDF 上限 5 MiB，仅提取文字层；不支持扫描件 OCR，不保存原 PDF 或版面坐标。</p>
            {fileDraft && (
              <div className="nobei-client__file-preview">
                <strong data-testid="nobei-file-name">{fileDraft.input.filename}</strong>
                <output data-testid="nobei-file-meta">
                  {fileDraft.byteSize.toLocaleString('zh-CN')} 字节 · {fileDraft.characterCount.toLocaleString('zh-CN')} 字符
                </output>
                <pre data-testid="nobei-file-preview">{fileDraft.input.text.slice(0, 800)}</pre>
              </div>
            )}
          </div>
        ) : (
          <div className="nobei-client__input-panel" role="tabpanel">
            <label htmlFor="nobei-paste-name">材料名称</label>
            <input id="nobei-paste-name" data-testid="nobei-paste-name" value={pasteName}
              disabled={submitting} onChange={event => setPasteName(event.currentTarget.value)} />
            <label htmlFor="nobei-paste-text">正文</label>
            <textarea id="nobei-paste-text" data-testid="nobei-paste-text" value={pasteText}
              disabled={submitting} onChange={event => setPasteText(event.currentTarget.value)} />
            <output>{validation?.byteSize.toLocaleString('zh-CN') ?? 0} / {MAX_DOCUMENT_BYTES.toLocaleString('zh-CN')} 字节</output>
          </div>
        )}

        {(error ?? invalidMessage) && <p className="nobei-client__error" role="alert">{error ?? invalidMessage}</p>}
        {documentPreview.error && <button type="button" onClick={documentPreview.retry}>重新读取提取计划</button>}
        <button className="nobei-client__primary" type="submit" disabled={!canSubmit}>
          {submitting ? '正在提交…' : '开始提取'}
        </button>
      </form>
    </section>
  )
}
