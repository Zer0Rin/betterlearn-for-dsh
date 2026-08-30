import { describe, expect, test } from 'vitest'
import { observeEvidenceOutput } from '../scripts/phase1e-evidence-observation.mjs'

const text = '唯一事实。\n甲：重复事实。甲尾\n乙：重复事实。乙尾'

describe('Phase 1E repeated evidence observation', () => {
  test('partitions evidence without retaining source strings', () => {
    const output = { candidates: [{ evidence: [
      { quote: '唯一事实', prefix: '', suffix: '' },
      { quote: '不存在', prefix: '', suffix: '' },
      { quote: '重复事实', prefix: '甲：', suffix: '。甲尾' },
      { quote: '重复事实', prefix: '缺失：', suffix: '' },
    ] }] }
    const observed = observeEvidenceOutput(text, output)
    expect(observed).toEqual({
      schemaValidEvidenceCount: 4,
      uniqueQuoteEvidenceCount: 1,
      repeatedQuoteEvidenceCount: 2,
      absentQuoteEvidenceCount: 1,
      disambiguationAttempted: 2,
      disambiguationSucceeded: 1,
      disambiguationRejected: 1,
      disambiguationObservationStatus: 'observed',
    })
    expect(JSON.stringify(observed)).not.toContain(text)
    for (const evidence of output.candidates[0].evidence) {
      if (evidence.quote) expect(JSON.stringify(observed)).not.toContain(evidence.quote)
      if (evidence.prefix) expect(JSON.stringify(observed)).not.toContain(evidence.prefix)
      if (evidence.suffix) expect(JSON.stringify(observed)).not.toContain(evidence.suffix)
    }
  })

  test('reports not_observed when every quote is unique', () => {
    expect(observeEvidenceOutput('甲。乙。', {
      candidates: [{ evidence: [{ quote: '甲', prefix: '', suffix: '' }] }],
    })).toMatchObject({
      uniqueQuoteEvidenceCount: 1,
      disambiguationAttempted: 0,
      disambiguationObservationStatus: 'not_observed',
    })
  })

  test('counts overlapping occurrences', () => {
    expect(observeEvidenceOutput('aaaa', {
      candidates: [{ evidence: [{ quote: 'aa', prefix: '', suffix: '' }] }],
    })).toMatchObject({
      repeatedQuoteEvidenceCount: 1,
      disambiguationAttempted: 1,
      disambiguationRejected: 1,
    })
  })

  test.each([null, {}, { candidates: [null] }, {
    candidates: [{ evidence: [{ quote: '', prefix: '', suffix: '' }] }],
  }])('rejects malformed input %#', (output) => {
    expect(() => observeEvidenceOutput(text, output))
      .toThrow('PHASE1E_OBSERVATION_INPUT_INVALID')
  })
})
