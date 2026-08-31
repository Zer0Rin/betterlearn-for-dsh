import { describe, expect, test, vi } from 'vitest'
import {
  ModelSelectionPropagation,
  type SelectionInstaller,
} from '../src/product/model-selection-propagation.js'

function agentContext() {
  const restrictions: unknown[] = []
  const guards: Array<(execution: { name: string }) => string | undefined> = []
  const disposers: ReturnType<typeof vi.fn>[] = []
  return {
    ctx: {
      tools: {
        restrict(value: unknown) {
          restrictions.push(value)
          const dispose = vi.fn()
          disposers.push(dispose)
          return dispose
        },
        guard(value: (execution: { name: string }) => string | undefined) {
          guards.push(value)
          const dispose = vi.fn()
          disposers.push(dispose)
          return dispose
        },
      },
    },
    restrictions,
    guards,
    disposers,
  }
}

function hostContext(owners: Record<string, string>) {
  const listeners = new Set<(event: { agent: { id: string; ctx: unknown } }) => void>()
  return {
    ctx: {
      agents: {
        isOwnedBy(childId: string, parent: { id: string }) {
          return owners[childId] === parent.id
        },
      },
      on(name: string, listener: (event: { agent: { id: string; ctx: unknown } }) => void) {
        expect(name).toBe('agent/created')
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    emit(agent: { id: string; ctx: unknown }) {
      for (const listener of [...listeners]) listener({ agent })
    },
    listenerCount: () => listeners.size,
  }
}

describe('ModelSelectionPropagation', () => {
  test('installs the complete selection and independent tool boundaries on parent and exact owned child', () => {
    const host = hostContext({ child_owned: 'parent_a' })
    const parent = agentContext()
    const child = agentContext()
    const unrelated = agentContext()
    const installs: Array<{ ctx: unknown; selection: unknown }> = []
    const install: SelectionInstaller = (ctx, selection) => {
      installs.push({ ctx, selection })
      return vi.fn()
    }
    const propagation = new ModelSelectionPropagation(host.ctx as never, {
      provider: 'provider-a', model: 'model-a', reasoningEffort: 'high',
    }, install)

    expect(propagation.agentOptions).toEqual({
      provider: 'provider-a', model: 'model-a', maxTokens: 32_768,
    })
    expect(propagation.agentOptions).not.toHaveProperty('reasoningEffort')
    propagation.setupParent(parent.ctx as never)
    propagation.observeChildren({ id: 'parent_a' } as never)
    host.emit({ id: 'unrelated', ctx: unrelated.ctx })
    host.emit({ id: 'child_owned', ctx: child.ctx })
    propagation.assertComplete()

    expect(installs).toHaveLength(2)
    expect(installs.map((row) => row.ctx)).toEqual([parent.ctx, child.ctx])
    expect(installs[0]!.selection).toBe(installs[1]!.selection)
    expect(installs[0]!.selection).toEqual({
      current: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
      assembled: undefined,
    })
    expect(parent.restrictions).toEqual([{ allow: [] }])
    expect(child.restrictions).toEqual([{ allow: [] }])
    expect(unrelated.restrictions).toEqual([])
    for (const guard of [...parent.guards, ...child.guards]) {
      expect(guard({ name: 'structured_output' })).toBeUndefined()
      for (const denied of ['run_code', 'bash', 'fs', 'workflow', 'anything_else']) {
        expect(guard({ name: denied })).toBe('NOBEI_GENERATION_TOOL_DENIED')
      }
    }

    propagation.disposeBoundaries()
    propagation.disposeBoundaries()
    expect(host.listenerCount()).toBe(0)
    expect(parent.disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true)
    expect(child.disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true)
  })

  test('two live unscoped listeners see both events but install only on their own child', () => {
    const host = hostContext({ child_a: 'parent_a', child_b: 'parent_b' })
    const installedA: string[] = []
    const installedB: string[] = []
    const propagationA = new ModelSelectionPropagation(host.ctx as never, {
      provider: 'provider-a', model: 'model-a', reasoningEffort: 'low',
    }, ((ctx) => { installedA.push((ctx as { id: string }).id); return vi.fn() }) as SelectionInstaller)
    const propagationB = new ModelSelectionPropagation(host.ctx as never, {
      provider: 'provider-b', model: 'model-b', reasoningEffort: 'high',
    }, ((ctx) => { installedB.push((ctx as { id: string }).id); return vi.fn() }) as SelectionInstaller)
    propagationA.observeChildren({ id: 'parent_a' } as never)
    propagationB.observeChildren({ id: 'parent_b' } as never)

    host.emit({ id: 'child_a', ctx: { id: 'child_a', tools: agentContext().ctx.tools } })
    host.emit({ id: 'child_b', ctx: { id: 'child_b', tools: agentContext().ctx.tools } })

    propagationA.assertComplete()
    propagationB.assertComplete()
    expect(installedA).toEqual(['child_a'])
    expect(installedB).toEqual(['child_b'])
    propagationA.disposeBoundaries()
    propagationB.disposeBoundaries()
  })

  test('fails settlement when no exact owned child was observed', () => {
    const host = hostContext({})
    const propagation = new ModelSelectionPropagation(host.ctx as never, {
      provider: 'provider-a', model: 'model-a',
    }, vi.fn(() => vi.fn()))
    propagation.observeChildren({ id: 'parent_a' } as never)
    host.emit({ id: 'unrelated', ctx: agentContext().ctx })
    expect(() => propagation.assertComplete()).toThrow('SPAWN_CHILD_NOT_OWNED')
    propagation.disposeBoundaries()
  })
})
