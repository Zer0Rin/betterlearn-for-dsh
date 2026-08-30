import { describe, expect, test, vi } from 'vitest'
import { OwnedSpikeWork } from '../src/index.js'

describe('phase1a Bundle lifecycle', () => {
  test('aborts in-flight probes and waits for all owned cleanup', async () => {
    const work = new OwnedSpikeWork()
    const observed: AbortSignal[] = []
    const cleaned: string[] = []
    const subprocess = work.track(async (signal) => {
      observed.push(signal)
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => {
        queueMicrotask(() => { cleaned.push('subprocess-tree-joined'); resolve() })
      }, { once: true }))
    })
    const provider = work.track(async (signal) => {
      observed.push(signal)
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => {
        queueMicrotask(() => { cleaned.push('workflow-and-parent-disposed'); resolve() })
      }, { once: true }))
    })

    let disposed = false
    const disposal = work.dispose().then(() => { disposed = true })
    expect(disposed).toBe(false)
    await disposal
    await Promise.all([subprocess, provider])
    expect(observed).toHaveLength(2)
    expect(observed.every((signal) => signal.aborted)).toBe(true)
    expect(cleaned.sort()).toEqual(['subprocess-tree-joined', 'workflow-and-parent-disposed'])
    expect(disposed).toBe(true)
  })

  test('refuses new work after disposal begins', async () => {
    const work = new OwnedSpikeWork()
    await work.dispose()
    const task = vi.fn(async () => undefined)
    await expect(work.track(task)).rejects.toThrow('SPIKE_PLUGIN_DISPOSING')
    expect(task).not.toHaveBeenCalled()
  })
})
