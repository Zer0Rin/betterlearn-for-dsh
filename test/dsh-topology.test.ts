import { describe, expect, test } from 'vitest'
import {
  CLIENT_SEAM_PACKAGES,
  CRITICAL_PROFILE_PACKAGES,
  assertProfileTopology,
  createWorkspacePolicy,
} from '../scripts/dsh-topology.mjs'
import pinset from '../config/dsh-rc7-pins.json'

const rc7 = '0.1.0-rc.7'

function lock(overrides: {
  wrongVersion?: string
  omit?: string
  duplicate?: string
} = {}): string {
  const packages = CRITICAL_PROFILE_PACKAGES.filter((name) => name !== overrides.omit)
  const dependencies = packages.map((name) => `      '${name}':\n        specifier: ${rc7}\n        version: ${overrides.wrongVersion && name === '@deepseek-ai/dsh-session' ? overrides.wrongVersion : rc7}(peer-a)`).join('\n')
  const packageRows = packages.map((name) => `  '${name}@${name === '@deepseek-ai/dsh-session' && overrides.wrongVersion ? overrides.wrongVersion : rc7}': {}`).join('\n')
  const snapshots = packages.map((name) => `  '${name}@${rc7}(peer-a)': {}`).join('\n')
  const duplicate = overrides.duplicate ? `\n  '${overrides.duplicate}@${rc7}(peer-b)': {}` : ''
  return `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
${dependencies}
packages:
${packageRows}
snapshots:
${snapshots}${duplicate}
`
}

describe('phase1a exact DSH topology', () => {
  test('pins the public web Client seams to the audited rc.7 release', () => {
    expect(CLIENT_SEAM_PACKAGES).toEqual([
      '@deepseek-ai/dsh-client-modules',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-model-selection',
    ])
    const policy = createWorkspacePolicy(pinset)
    for (const name of CLIENT_SEAM_PACKAGES) {
      expect(pinset.packages[name as keyof typeof pinset.packages]).toBe(rc7)
      expect(policy).toContain(`'${name}': '${rc7}'`)
    }
  })

  test('lists every critical public seam package exactly once', () => {
    expect(CRITICAL_PROFILE_PACKAGES).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-agent-loop',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-llm-deepseek',
      '@deepseek-ai/dsh-llm-pi-ai',
      '@deepseek-ai/dsh-agent-default-model',
      '@deepseek-ai/dsh-subagent',
      '@deepseek-ai/dsh-subagent-spawn-in-process',
      '@deepseek-ai/dsh-subprocess',
      '@deepseek-ai/dsh-subprocess-local',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-workflow',
      '@deepseek-ai/dsh-workflow-worker-thread',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-web-app',
    ])
  })

  test('renders the full audited pinset as exact overrides', () => {
    const policy = createWorkspacePolicy({
      release: rc7,
      packages: Object.fromEntries(CRITICAL_PROFILE_PACKAGES.map((name) => [name, rc7])),
    })
    expect(policy).toContain('autoInstallPeers: false')
    for (const name of CRITICAL_PROFILE_PACKAGES) {
      expect(policy).toContain(`'${name}': '${rc7}'`)
    }
  })

  test('accepts one exact direct peer context per critical package', () => {
    expect(assertProfileTopology(lock(), rc7)).toMatchObject({
      expectedVersion: rc7,
      criticalCount: CRITICAL_PROFILE_PACKAGES.length,
      duplicateCriticalContexts: [],
    })
  })

  test('rejects missing, mixed-release and duplicate peer contexts', () => {
    expect(() => assertProfileTopology(lock({ omit: '@deepseek-ai/dsh-tools' }), rc7))
      .toThrow('profile must directly install @deepseek-ai/dsh-tools')
    expect(() => assertProfileTopology(lock({ wrongVersion: '0.1.0-rc.8' }), rc7))
      .toThrow('unexpected DSH release')
    expect(() => assertProfileTopology(lock({ duplicate: '@deepseek-ai/dsh-agent' }), rc7))
      .toThrow('duplicate critical peer context')
  })

  test('rejects a mixed-release Client package even when it is not a critical profile package', () => {
    const mixedClientLock = lock().replace(
      'packages:\n',
      "packages:\n  '@deepseek-ai/dsh-client-runtime@0.1.0-rc.8': {}\n",
    )
    expect(() => assertProfileTopology(mixedClientLock, rc7))
      .toThrow('unexpected DSH release')
  })
})
