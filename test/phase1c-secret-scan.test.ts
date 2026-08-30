import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { EvidenceRecorder } from '../scripts/evidence.mjs'
import { scanRawCommand } from '../scripts/phase1c-secret-scan.mjs'

describe('Phase 1C secret detection before redaction', () => {
  test.each([
    ['argv', { argv: ['node', '-e', '', 'Bearer secret-canary'], stdout: '', stderr: '' }],
    ['stdout', { argv: ['node'], stdout: 'DEEPSEEK_API_KEY=secret-canary', stderr: '' }],
    ['stderr', { argv: ['node'], stdout: '', stderr: 'sk-secret-canary-1234567890' }],
  ])('reports only rule, %s field and offending segment digest', (_name, input) => {
    const findings = scanRawCommand(input)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toEqual({
      ruleId: expect.any(String),
      field: _name,
      segmentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(JSON.stringify(findings)).not.toContain('secret-canary')
  })

  test('detects a Bearer canary even when the exact value is configured for redaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nobei-phase1c-secret-scan-'))
    const canary = 'Bearer secret-canary'
    const recorder = new EvidenceRecorder({ root, redactions: [canary, 'secret-canary'] })
    const error = await recorder.run({
      slug: 'raw-secret-canary',
      argv: [process.execPath, '-e', '', canary],
      cwd: process.cwd(),
      cwdLabel: 'package-root',
      env: { PATH: process.env.PATH ?? '' },
    }).catch((reason) => reason)
    expect(error).toMatchObject({
      message: 'EVIDENCE_SECRET_DETECTED',
      findings: [expect.objectContaining({ field: 'argv' })],
    })
    expect(JSON.stringify(error.findings)).not.toContain('secret-canary')
    await expect(access(join(root, 'commands.ndjson'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(root, 'commands', '001-raw-secret-canary.stdout.log'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('does not mistake a task package path for an sk-prefixed credential', () => {
    expect(scanRawCommand({
      argv: ['/tmp/node_modules/@deepseek-ai/dsh-client-ui/task-question-row.d.ts'],
      stdout: '',
      stderr: '',
    })).toEqual([])
  })

  test('detects child output before writing a redacted clean-looking record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nobei-phase1c-output-scan-'))
    const encoded = Buffer.from('Bearer secret-canary').toString('base64')
    const recorder = new EvidenceRecorder({ root, redactions: ['secret-canary'] })
    const error = await recorder.run({
      slug: 'output-secret-canary',
      argv: [process.execPath, '-e', `process.stdout.write(Buffer.from('${encoded}','base64'))`],
      cwd: process.cwd(),
      cwdLabel: 'package-root',
      env: { PATH: process.env.PATH ?? '' },
    }).catch((reason) => reason)
    expect(error).toMatchObject({ message: 'EVIDENCE_SECRET_DETECTED' })
    expect(error.findings.some((finding: { field: string }) => finding.field === 'stdout')).toBe(true)
    await expect(access(join(root, 'commands.ndjson'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
