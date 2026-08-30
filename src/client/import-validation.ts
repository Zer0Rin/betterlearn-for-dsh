import type { ImportTextInput } from './types.js'

export const MAX_DOCUMENT_BYTES = 65_536
export const PRODUCT_BODY_LIMIT_BYTES = 512 * 1024

export type ImportValidationError =
  | 'EMPTY_TEXT'
  | 'TEXT_TOO_LARGE'
  | 'FILENAME_INVALID'
  | 'MEDIA_TYPE_INVALID'
  | 'BODY_TOO_LARGE'

export interface ImportValidation {
  valid: boolean
  byteSize: number
  characterCount: number
  errors: ImportValidationError[]
}

const encoder = new TextEncoder()

function validFilename(filename: string): boolean {
  return filename.length >= 1
    && filename.length <= 255
    && filename !== '.'
    && filename !== '..'
    && !/[\\/\0]/.test(filename)
    && /\.(?:txt|md)$/i.test(filename)
}

export function validateImport(input: ImportTextInput): ImportValidation {
  const errors: ImportValidationError[] = []
  const byteSize = encoder.encode(input.text).byteLength
  const characterCount = Array.from(input.text).length
  if (input.text.length === 0) errors.push('EMPTY_TEXT')
  if (byteSize > MAX_DOCUMENT_BYTES) errors.push('TEXT_TOO_LARGE')
  if (!validFilename(input.filename)) errors.push('FILENAME_INVALID')
  if (input.mediaType !== 'text/plain' && input.mediaType !== 'text/markdown') {
    errors.push('MEDIA_TYPE_INVALID')
  }
  if (encoder.encode(JSON.stringify(input)).byteLength > PRODUCT_BODY_LIMIT_BYTES) {
    errors.push('BODY_TOO_LARGE')
  }
  return { valid: errors.length === 0, byteSize, characterCount, errors }
}

export function mediaTypeForFile(file: Pick<File, 'name' | 'type'>): ImportTextInput['mediaType'] | undefined {
  const extension = file.name.toLowerCase().match(/\.(txt|md)$/)?.[1]
  if (file.type === '') {
    if (extension === 'txt') return 'text/plain'
    if (extension === 'md') return 'text/markdown'
    return undefined
  }
  if (file.type === 'text/plain' && extension === 'txt') return 'text/plain'
  if (file.type === 'text/markdown' && extension === 'md') return 'text/markdown'
  return undefined
}

export function defaultPasteFilename(now: Date): string {
  const year = String(now.getFullYear()).padStart(4, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `粘贴内容-${year}-${month}-${day}.md`
}
