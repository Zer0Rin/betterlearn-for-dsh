import { useEffect, useState } from 'react'
import type { ClientApi, DocumentPreview, ImportTextInput } from './types.js'

export function documentPreviewError(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  if (code === 'PDF_ENCRYPTED') return '此 PDF 已加密，请先导出未加密副本。'
  if (code === 'PDF_NO_TEXT') return '未找到可提取的文字；扫描件需要先进行 OCR。'
  if (code === 'REQUEST_TOO_LARGE') return '文件或解析正文超过上限：PDF 5 MiB，正文 512 KiB。'
  if (code === 'PDF_MALFORMED' || code === 'PDF_INVALID' || code === 'INVALID_PDF') return '无法解析此 PDF，请检查文件是否损坏。'
  return '无法预览材料，请检查文件或连接后重新选择。'
}

export function useDocumentPreview(
  input: ImportTextInput | undefined,
  previewDocument: ClientApi['previewDocument'],
) {
  const [revision, setRevision] = useState(0)
  const [resolved, setResolved] = useState<{ input: ImportTextInput; value?: DocumentPreview; error?: string }>()
  useEffect(() => {
    if (!input || !previewDocument) return
    const abort = new AbortController()
    const timer = setTimeout(() => {
      void previewDocument(input, abort.signal).then(value => {
        if (!abort.signal.aborted) setResolved({ input, value })
      }, error => {
        if (!abort.signal.aborted) setResolved({ input, error: documentPreviewError(error) })
      })
    }, 250)
    return () => { clearTimeout(timer); abort.abort() }
  }, [input, previewDocument, revision])
  const current = resolved?.input === input ? resolved : undefined
  return {
    preview: current?.value, error: current?.error, pending: !!(input && previewDocument && !current),
    retry: () => { setResolved(undefined); setRevision(value => value + 1) },
  }
}
