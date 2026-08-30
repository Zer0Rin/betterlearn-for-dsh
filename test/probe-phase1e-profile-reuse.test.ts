import { describe, expect, test } from 'vitest'
import * as profileReuseProbe from '../scripts/probe-phase1e-profile-reuse.mjs'
import {
  diffProfileSnapshots,
  evaluateProfileReuseProbe,
  markerOwnedProfilePath,
} from '../scripts/probe-phase1e-profile-reuse.mjs'

const profileName = 'nobei-phase1e-probe-test'
const marker = `profiles/${profileName}/.nobei-phase1e-probe-marker`
const routed = { status: 'READY', provider: 'provider-a', model: 'model-a', reasoningEffort: 'high', routable: true } as const
const adapters = {
  '@deepseek-ai/dsh-llm-deepseek': '0.1.0-rc.7',
  '@deepseek-ai/dsh-llm-pi-ai': '0.1.0-rc.7',
}

type PickerLocator = {
  click: () => Promise<void>
  fill: (value: string) => Promise<void>
  isVisible: () => Promise<boolean>
  press: (key: string) => Promise<void>
  waitFor: (options: { state: 'visible' }) => Promise<void>
  getByRole: (role: string, options: { name: string, exact: true }) => PickerLocator
}

function workspacePickerPage({ existingWorkspace }: { existingWorkspace: boolean }) {
  const actions: string[] = []
  let pickerVisible = false
  const picker: PickerLocator = {
    async click() { actions.push('picker.click') },
    async fill(value) { actions.push(`picker.fill:${value}`) },
    async isVisible() { return pickerVisible },
    async press(key) { actions.push(`picker.press:${key}`) },
    async waitFor() {
      if (!pickerVisible) throw new Error('picker unavailable')
    },
    getByRole(_role, { name }) {
      if (name === 'Edit path') return {
        ...picker,
        async click() { actions.push('edit-path.click') },
      }
      if (name === 'Open') return {
        ...picker,
        async click() { actions.push('open.click') },
      }
      return picker
    },
  }
  const page = {
    getByRole(_role: string, { name }: { name: string, exact: true }) {
      if (name === 'Choose workspace') return {
        ...picker,
        async click() {
          actions.push('choose-workspace.click')
          if (!existingWorkspace) pickerVisible = true
        },
      }
      if (name === 'Add workspace') return {
        ...picker,
        async click() {
          actions.push('add-workspace.click')
          pickerVisible = true
        },
        async isVisible() { return existingWorkspace },
      }
      if (name === 'Select Workspace Directory') return picker
      throw new Error(`unexpected role lookup: ${name}`)
    },
  }
  return { actions, page }
}

describe('Phase 1E DSH_HOME reuse probe', () => {
  test('uses the pnpm executable compatible with DSH-created profile node_modules', () => {
    expect((profileReuseProbe as Record<string, unknown>).PROFILE_PNPM).toBe('/usr/local/bin/pnpm')
  })

  test('uses rc.7 remote-launch fact so headless Chromium can drive the workspace picker', () => {
    const createProbeEnvironment = (profileReuseProbe as Record<string, unknown>).createProbeEnvironment
    expect(createProbeEnvironment).toBeTypeOf('function')
    if (typeof createProbeEnvironment !== 'function') return
    expect(createProbeEnvironment({ KEEP: 'yes' }, '/tmp/dsh-home', 'test-ledger-token')).toMatchObject({
      KEEP: 'yes',
      DSH_HOME: '/tmp/dsh-home',
      DSH_TELEMETRY_MODE: 'DISABLED',
      NOBEI_PHASE1E_OBSERVER_LEDGER_TOKEN: 'test-ledger-token',
      SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 1',
    })
  })

  test('opens the directory picker directly when no existing workspace is available', async () => {
    const openWorkspaceDirectoryPicker = (profileReuseProbe as Record<string, unknown>).openWorkspaceDirectoryPicker
    expect(openWorkspaceDirectoryPicker).toBeTypeOf('function')
    const { actions, page } = workspacePickerPage({ existingWorkspace: false })
    await (openWorkspaceDirectoryPicker as (page: unknown, workspaceRoot: string) => Promise<void>)(page, '/tmp/nobei-workspace')
    expect(actions).toEqual([
      'choose-workspace.click',
      'edit-path.click',
      'picker.fill:/tmp/nobei-workspace',
      'picker.press:Enter',
      'open.click',
    ])
  })

  test('opens the directory picker through Add workspace when a workspace menu is already populated', async () => {
    const openWorkspaceDirectoryPicker = (profileReuseProbe as Record<string, unknown>).openWorkspaceDirectoryPicker
    expect(openWorkspaceDirectoryPicker).toBeTypeOf('function')
    const { actions, page } = workspacePickerPage({ existingWorkspace: true })
    await (openWorkspaceDirectoryPicker as (page: unknown, workspaceRoot: string) => Promise<void>)(page, '/tmp/nobei-workspace')
    expect(actions).toEqual([
      'choose-workspace.click',
      'add-workspace.click',
      'edit-path.click',
      'picker.fill:/tmp/nobei-workspace',
      'picker.press:Enter',
      'open.click',
    ])
  })

  test('does not require a conversation view tab or submit a prompt to observe a blank session', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) =>
      readFile('scripts/probe-phase1e-profile-reuse.mjs', 'utf8'))
    expect(source).not.toContain("getByRole('tab', { name: 'Phase 1E Observer'")
    expect(source).not.toContain('.prompt(')
    expect(source).not.toContain('Phase 1D WebUI activation')
    expect(source).toContain("getByTestId('nobei-phase1e-real-model-observer')")
    expect(source).toContain("waitFor({ state: 'attached'")
  })

  test('diffs metadata only and accepts a recorded shared node_modules symlink fallback change', () => {
    const diff = diffProfileSnapshots(
      [{ path: 'profiles/web/package.json', type: 'file', size: 10, mtimeMs: 1 }],
      [
        { path: 'profiles/web/package.json', type: 'file', size: 10, mtimeMs: 1 },
        { path: 'profiles/node_modules/@deepseek-ai/dsh', type: 'symlink', target: '../../store/dsh', size: 0, mtimeMs: 2 },
      ],
    )
    expect(evaluateProfileReuseProbe({ diff, profileName, marker, selection: routed, llmStreamCalls: 0, adapters }))
      .toMatchObject({ status: 'PROFILE_REUSE_PROBE_GO', sharedChanges: ['profiles/node_modules/@deepseek-ai/dsh'] })
  })

  test('blocks a write outside the marker-owned profile and shared fallback', () => {
    const diff = diffProfileSnapshots([], [{ path: 'profiles/other/settings.json', type: 'file', size: 1, mtimeMs: 1 }])
    expect(evaluateProfileReuseProbe({ diff, profileName, marker, selection: routed, llmStreamCalls: 0, adapters }))
      .toMatchObject({ status: 'BLOCKED_PROVIDER_CONFIG', reason: 'PROFILE_REUSE_WRITE_OUTSIDE_PROFILE' })
  })

  test.each([
    ['unroutable model', { ...routed, routable: false }, 'MODEL_NOT_ROUTABLE'],
    ['model directory unavailable', { status: 'MODEL_SELECTION_UNAVAILABLE' }, 'MODEL_SELECTION_UNAVAILABLE'],
    ['nonzero observer stream count', routed, 'OBSERVER_STREAM_CALLS_NONZERO', 1],
  ] as const)('blocks %s without claiming GO', (_label, selection, reason, llmStreamCalls = 0) => {
    expect(evaluateProfileReuseProbe({ diff: [], profileName, marker, selection, llmStreamCalls, adapters }))
      .toMatchObject({ status: 'BLOCKED_PROVIDER_CONFIG', reason })
  })

  test('rejects cleanup targets that are not the uniquely marker-owned profile', () => {
    expect(markerOwnedProfilePath('/tmp/dsh', profileName, marker)).toBe(`/tmp/dsh/profiles/${profileName}`)
    expect(() => markerOwnedProfilePath('/tmp/dsh', 'other-profile', marker)).toThrow('PROFILE_MARKER_OWNERSHIP_INVALID')
  })
})
