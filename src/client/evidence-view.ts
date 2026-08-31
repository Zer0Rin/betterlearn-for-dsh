import type { EvidenceSpan } from './types.js'

export interface TextSegment {
  kind: 'plain' | 'evidence'
  start: number
  end: number
  text: string
}

export function splitEvidence(text: string, span: EvidenceSpan): TextSegment[] {
  // Core offsets count Unicode code points, not JavaScript UTF-16 code units.
  const points = Array.from(text)
  const { textStart, textEnd } = span
  if (
    !Number.isSafeInteger(textStart)
    || !Number.isSafeInteger(textEnd)
    || textStart < 0
    || textEnd < textStart
    || textEnd > points.length
  ) {
    throw new Error('EVIDENCE_SPAN_INVALID')
  }
  if (points.slice(textStart, textEnd).join('') !== span.quote) {
    throw new Error('EVIDENCE_QUOTE_MISMATCH')
  }
  const segments: TextSegment[] = []
  if (textStart > 0) {
    segments.push({ kind: 'plain', start: 0, end: textStart, text: points.slice(0, textStart).join('') })
  }
  segments.push({ kind: 'evidence', start: textStart, end: textEnd, text: span.quote })
  if (textEnd < points.length) {
    segments.push({ kind: 'plain', start: textEnd, end: points.length, text: points.slice(textEnd).join('') })
  }
  return segments
}
