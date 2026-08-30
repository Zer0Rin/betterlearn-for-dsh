function occurrences(text, needle) {
  if (typeof needle !== 'string' || needle.length === 0) return 0
  let count = 0
  let cursor = 0
  while (true) {
    const found = text.indexOf(needle, cursor)
    if (found < 0) return count
    count += 1
    cursor = found + 1
  }
}

export function observeEvidenceOutput(canonicalText, rawOutput) {
  if (typeof canonicalText !== 'string' || rawOutput === null || typeof rawOutput !== 'object'
    || !Array.isArray(rawOutput.candidates)) {
    throw new Error('PHASE1E_OBSERVATION_INPUT_INVALID')
  }
  const metrics = {
    schemaValidEvidenceCount: 0,
    uniqueQuoteEvidenceCount: 0,
    repeatedQuoteEvidenceCount: 0,
    absentQuoteEvidenceCount: 0,
    disambiguationAttempted: 0,
    disambiguationSucceeded: 0,
    disambiguationRejected: 0,
    disambiguationObservationStatus: 'not_observed',
  }
  for (const candidate of rawOutput.candidates) {
    if (candidate === null || typeof candidate !== 'object' || !Array.isArray(candidate.evidence)) {
      throw new Error('PHASE1E_OBSERVATION_INPUT_INVALID')
    }
    for (const evidence of candidate.evidence) {
      if (evidence === null || typeof evidence !== 'object'
        || typeof evidence.quote !== 'string' || evidence.quote.length === 0
        || typeof evidence.prefix !== 'string' || typeof evidence.suffix !== 'string') {
        throw new Error('PHASE1E_OBSERVATION_INPUT_INVALID')
      }
      metrics.schemaValidEvidenceCount += 1
      const quoteCount = occurrences(canonicalText, evidence.quote)
      if (quoteCount === 0) {
        metrics.absentQuoteEvidenceCount += 1
      } else if (quoteCount === 1) {
        metrics.uniqueQuoteEvidenceCount += 1
      } else {
        metrics.repeatedQuoteEvidenceCount += 1
        metrics.disambiguationAttempted += 1
        const windowCount = occurrences(
          canonicalText,
          evidence.prefix + evidence.quote + evidence.suffix,
        )
        if (windowCount === 1) metrics.disambiguationSucceeded += 1
        else metrics.disambiguationRejected += 1
      }
    }
  }
  metrics.disambiguationObservationStatus = metrics.disambiguationAttempted > 0
    ? 'observed'
    : 'not_observed'
  return metrics
}
