import type { EvidenceSpan } from './types.js'

export interface TextSegment {
  kind: 'plain' | 'evidence'
  start: number
  end: number
  text: string
}

export function splitEvidence(text: string, span: EvidenceSpan): TextSegment[] {
  const { textStart, textEnd } = span
  if (
    !Number.isSafeInteger(textStart)
    || !Number.isSafeInteger(textEnd)
    || textStart < 0
    || textEnd < textStart
    || textEnd > text.length
  ) {
    throw new Error('EVIDENCE_SPAN_INVALID')
  }
  if (text.slice(textStart, textEnd) !== span.quote) {
    throw new Error('EVIDENCE_QUOTE_MISMATCH')
  }
  const segments: TextSegment[] = []
  if (textStart > 0) {
    segments.push({ kind: 'plain', start: 0, end: textStart, text: text.slice(0, textStart) })
  }
  segments.push({ kind: 'evidence', start: textStart, end: textEnd, text: span.quote })
  if (textEnd < text.length) {
    segments.push({ kind: 'plain', start: textEnd, end: text.length, text: text.slice(textEnd) })
  }
  return segments
}
