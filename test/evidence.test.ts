import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { EvidenceRecorder, summarizeHttpResponse } from '../scripts/evidence.mjs'

describe('phase1a evidence recorder', () => {
  test('records only argv, cwd label, env names and redacted output files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nobei-phase1a-evidence-'))
    const disposableHome = '/tmp/nobei-private-home-123'
    const apiKey = 'local-private-value'
    const spikeToken = 'token-private-value'
    const recorder = new EvidenceRecorder({ root, redactions: [disposableHome, apiKey, spikeToken] })
    await recorder.run({
      slug: 'redaction-probe',
      argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(`${apiKey} ${spikeToken} ${disposableHome}`)})`],
      cwd: process.cwd(),
      cwdLabel: 'package-root',
      env: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: apiKey, NOBEI_SPIKE_TOKEN: spikeToken },
    })

    const metadata = await readFile(join(root, 'commands.ndjson'), 'utf8')
    const record = JSON.parse(metadata.trim())
    expect(record.cwd).toBe('package-root')
    expect(record.envNames).toEqual([
      'PATH',
      '[REDACTED_PROVIDER_CREDENTIAL_NAME]',
      '[REDACTED_SPIKE_TOKEN_NAME]',
    ])
    expect(record).not.toHaveProperty('env')
    expect(record.stdoutFile).toMatch(/^commands\//)
    expect(record.stderrFile).toMatch(/^commands\//)
    const all = metadata + await readFile(join(root, record.stdoutFile), 'utf8')
    expect(all).not.toContain(apiKey)
    expect(all).not.toContain(spikeToken)
    expect(all).not.toContain(disposableHome)
  })

  test('summarizes HTTP responses without retaining response bodies', () => {
    const summary = summarizeHttpResponse({
      status: 200,
      body: '{"quote":"full private model response"}',
    })
    expect(summary).toMatchObject({ status: 200, byteLength: 39 })
    expect(summary.bodySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(summary)).not.toContain('private model response')
    expect(summary).not.toHaveProperty('body')
  })
})
