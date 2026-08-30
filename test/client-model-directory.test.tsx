import { describe, expect, test, vi } from 'vitest'
import {
  ModelDirectoryBridgeError,
  selectionForNewRun,
  type ModelDirectoryResolverPort,
} from '../src/client/model-directory-bridge.js'

function resolver(load: () => Promise<unknown>) {
  const directory = { load: vi.fn(load) }
  const directories = { directoryFor: vi.fn(() => directory) }
  return { directories, directory }
}

describe('DSH model directory bridge', () => {
  test('loads and detaches the current routable selection for a new run', async () => {
    const current = { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' }
    const { directories, directory } = resolver(async () => ({ current, routable: true }))
    const selected = await selectionForNewRun(directories as never, 'session-a', true)
    expect(directories.directoryFor).toHaveBeenCalledWith('session-a')
    expect(directory.load).toHaveBeenCalledOnce()
    expect(selected).toEqual(current)
    expect(selected).not.toBe(current)
  })

  test('distinguishes a fresh unroutable result from unavailable directory failures', async () => {
    const unroutable = resolver(async () => ({
      current: { provider: 'provider-a', model: 'model-a' }, routable: false,
    }))
    await expect(selectionForNewRun(unroutable.directories as never, 'session-a', true))
      .rejects.toMatchObject({ code: 'MODEL_NOT_ROUTABLE' })

    const syncFailure: ModelDirectoryResolverPort = {
      directoryFor: vi.fn(() => { throw new Error('resolved no scope') }),
    }
    await expect(selectionForNewRun(syncFailure, 'missing-session', true))
      .rejects.toMatchObject({ code: 'MODEL_SELECTION_UNAVAILABLE' })

    const asyncFailure = resolver(async () => { throw new Error('host failed') })
    await expect(selectionForNewRun(asyncFailure.directories as never, 'session-a', true))
      .rejects.toBeInstanceOf(ModelDirectoryBridgeError)
    await expect(selectionForNewRun(asyncFailure.directories as never, 'session-a', true))
      .rejects.toMatchObject({ code: 'MODEL_SELECTION_UNAVAILABLE' })
  })

  test('rejects an addressed subagent before resolving or loading a directory', async () => {
    const directoryFor = vi.fn()
    await expect(selectionForNewRun({ directoryFor }, 'child-session', false))
      .rejects.toMatchObject({ code: 'MODEL_SELECTION_UNAVAILABLE' })
    expect(directoryFor).not.toHaveBeenCalled()
  })

  test('treats a malformed runtime current value as a contract failure, not an empty state', async () => {
    const malformed = resolver(async () => ({ current: null, routable: true }))
    await expect(selectionForNewRun(malformed.directories as never, 'session-a', true))
      .rejects.toMatchObject({ code: 'MODEL_SELECTION_UNAVAILABLE' })
  })
})
