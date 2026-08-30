import { describe, expect, test } from 'vitest'
import {
  defaultPasteFilename,
  MAX_DOCUMENT_BYTES,
  mediaTypeForFile,
  PRODUCT_BODY_LIMIT_BYTES,
  validateImport,
} from '../src/client/import-validation.js'

const valid = { filename: '教材.md', mediaType: 'text/markdown' as const, text: '正文' }

describe('phase1d import validation', () => {
  test('rejects empty text and invalid filenames', () => {
    expect(validateImport({ ...valid, text: '' }).errors).toContain('EMPTY_TEXT')
    for (const filename of ['a/b.md', 'a\\b.md', 'a\0b.md', '.', '..', `${'a'.repeat(253)}.md`, '教材.pdf']) {
      expect(validateImport({ ...valid, filename }).errors, filename).toContain('FILENAME_INVALID')
    }
  })

  test('rejects unsupported media types', () => {
    expect(validateImport({ ...valid, mediaType: 'application/pdf' as never }).errors)
      .toContain('MEDIA_TYPE_INVALID')
  })

  test('accepts exactly 65,536 UTF-8 bytes and rejects one byte more', () => {
    const atLimit = validateImport({ ...valid, text: 'a'.repeat(MAX_DOCUMENT_BYTES) })
    expect(atLimit).toMatchObject({ valid: true, byteSize: MAX_DOCUMENT_BYTES })
    expect(validateImport({ ...valid, text: 'a'.repeat(MAX_DOCUMENT_BYTES + 1) }).errors)
      .toContain('TEXT_TOO_LARGE')
  })

  test('reports Unicode code points separately from UTF-8 bytes', () => {
    expect(validateImport({ ...valid, text: '中文🙂' })).toMatchObject({
      valid: true,
      byteSize: 10,
      characterCount: 3,
    })
  })

  test('keeps the largest legal request below the Host body limit', () => {
    const request = { filename: `${'文'.repeat(252)}.md`, mediaType: 'text/markdown', text: '\u0001'.repeat(MAX_DOCUMENT_BYTES) }
    const validation = validateImport(request)
    const serializedBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength
    expect(validation.valid).toBe(true)
    expect(serializedBytes).toBeLessThan(PRODUCT_BODY_LIMIT_BYTES)
    expect(validation.errors).not.toContain('BODY_TOO_LARGE')
  })

  test('recognizes TXT/Markdown files and provides a dated paste name', () => {
    expect(mediaTypeForFile({ name: 'notes.TXT', type: '' })).toBe('text/plain')
    expect(mediaTypeForFile({ name: 'notes.md', type: '' })).toBe('text/markdown')
    expect(mediaTypeForFile({ name: 'notes.txt', type: 'text/plain' })).toBe('text/plain')
    expect(mediaTypeForFile({ name: 'notes.md', type: 'text/markdown' })).toBe('text/markdown')
    expect(mediaTypeForFile({ name: 'notes.pdf', type: 'application/pdf' })).toBeUndefined()
    expect(defaultPasteFilename(new Date('2026-08-29T12:00:00+08:00'))).toBe('粘贴内容-2026-08-29.md')
  })
})
