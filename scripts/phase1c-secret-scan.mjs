import { createHash } from 'node:crypto'

const RULES = [
  { ruleId: 'BEARER_CREDENTIAL', pattern: /Bearer\s+[^\s"']+/gi },
  { ruleId: 'PROVIDER_KEY_ASSIGNMENT', pattern: /(?:DEEPSEEK_API_KEY|NOBEI_(?:SPIKE_TOKEN|PHASE1C_OWNERSHIP_TOKEN))\s*[=:]\s*[^\s"']+/gi },
  { ruleId: 'PROVIDER_KEY_SHAPE', pattern: /(?<![a-z0-9])sk-[a-z0-9_-]{12,}/gi },
]

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function scanField(field, values) {
  const findings = []
  for (const value of values) {
    const source = String(value)
    for (const rule of RULES) {
      for (const match of source.matchAll(rule.pattern)) {
        findings.push({
          ruleId: rule.ruleId,
          field,
          segmentSha256: digest(match[0]),
        })
      }
    }
  }
  return findings
}

export function scanRawCommand({ argv, stdout, stderr }) {
  return [
    ...scanField('argv', Array.isArray(argv) ? argv : []),
    ...scanField('stdout', [stdout ?? '']),
    ...scanField('stderr', [stderr ?? '']),
  ]
}
