import { describe, expect, test } from 'vitest'
import { splitEvidence } from '../src/client/evidence-view.js'

const base = { seq: 0, contextBefore: '甲', contextAfter: '丁' }

describe('phase1d evidence segmentation', () => {
  test('preserves exact text around a half-open evidence span', () => {
    const segments = splitEvidence('甲乙丙丁', {
      ...base, quote: '乙丙', textStart: 1, textEnd: 3,
    })
    expect(segments).toEqual([
      { kind: 'plain', start: 0, end: 1, text: '甲' },
      { kind: 'evidence', start: 1, end: 3, text: '乙丙' },
      { kind: 'plain', start: 3, end: 4, text: '丁' },
    ])
    expect(segments.map(segment => segment.text).join('')).toBe('甲乙丙丁')
  })

  test('rejects invalid, reversed and out-of-range spans', () => {
    for (const [textStart, textEnd] of [[-1, 1], [3, 2], [1, 5], [1.2, 2]]) {
      expect(() => splitEvidence('甲乙丙丁', {
        ...base, quote: '乙', textStart, textEnd,
      })).toThrow('EVIDENCE_SPAN_INVALID')
    }
  })

  test('rejects evidence whose quote differs from the exact source slice', () => {
    expect(() => splitEvidence('甲乙丙丁', {
      ...base, quote: '乙丁', textStart: 1, textEnd: 3,
    })).toThrow('EVIDENCE_QUOTE_MISMATCH')
  })
})
