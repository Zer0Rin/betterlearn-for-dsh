import { readFile } from 'node:fs/promises'
import { createElement } from 'react'
import { create } from 'react-test-renderer'
import { describe, expect, test } from 'vitest'
import { ObserverClientView, apply, readModelDirectory } from '../acceptance/real-model-observer/src/client.js'
import { inject, resolveObservedSelection } from '../acceptance/real-model-observer/src/index.js'

describe('Phase 1E real-model observer', () => {
  test('uses only the llm and web server Host seams and never registers an adapter', async () => {
    expect(inject).toEqual(['llm', 'webServer'])
    const source = await readFile('acceptance/real-model-observer/src/index.ts', 'utf8')
    expect(source).not.toContain('registerAdapter')
    expect(source).not.toContain('settings.yaml')
    expect(source).not.toContain('.credentials.yaml')
  })

  test('exports package.json so the rc.7 client-module registry can discover dsh.client', async () => {
    const manifest = JSON.parse(await readFile('acceptance/real-model-observer/package.json', 'utf8'))
    expect(manifest.exports['./package.json']).toBe('./package.json')
  })

  test('loads an ordinary session through the public model directory and detaches selection fields', async () => {
    const result = await readModelDirectory({
      sessionId: 'ordinary' as never,
      subagentAddress: () => undefined,
      directoryFor: () => ({ load: async () => ({
        current: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
        routable: true,
      }) }),
    })
    expect(result).toEqual({
      status: 'READY', provider: 'provider-a', model: 'model-a', reasoningEffort: 'high', routable: true,
    })
  })

  test.each([
    ['addressed subagent', {
      subagentAddress: () => ({ parentSessionId: 'parent', childSessionId: 'child' }),
      directoryFor: () => { throw new Error('must not resolve') },
    }],
    ['synchronous directory scope failure', {
      subagentAddress: () => undefined,
      directoryFor: () => { throw new Error('missing scope') },
    }],
    ['asynchronous load failure', {
      subagentAddress: () => undefined,
      directoryFor: () => ({ load: async () => { throw new Error('load failed') } }),
    }],
  ] as const)('maps %s to MODEL_SELECTION_UNAVAILABLE', async (_label, source) => {
    await expect(readModelDirectory({ sessionId: 'session' as never, ...source }))
      .resolves.toEqual({ status: 'MODEL_SELECTION_UNAVAILABLE' })
  })

  test('renders only detached non-sensitive selection values as test attributes', () => {
    const tree = create(createElement(ObserverClientView, {
      result: { status: 'READY', provider: 'provider-a', model: 'model-a', reasoningEffort: 'high', routable: true },
    })).toJSON()
    expect(tree).toMatchObject({
      props: {
        'data-testid': 'nobei-phase1e-real-model-observer',
        'data-provider': 'provider-a',
        'data-model': 'model-a',
        'data-reasoning-effort': 'high',
        'data-routable': 'true',
      },
    })
  })

  test('registers the zero-call observer in the blank-session input dock', () => {
    const registrations: Array<{ name: string, id?: string }> = []
    const ctx = {
      slots: {
        inject(name: string, setup: () => void) {
          expect(name).toBe('conversation.input.dock')
          setup()
        },
        register(descriptor: { name: string, id?: string }) {
          registrations.push(descriptor)
          return () => undefined
        },
      },
    }
    apply(ctx as never)
    expect(registrations).toEqual([{
      name: 'conversation.input.dock',
      id: 'phase1e-real-model-observer',
      order: 99,
    }])
  })

  test('materializes the selected route through the public Host resolver without streaming', async () => {
    const resolveCallConfig = async (value: unknown) => ({
      ...(value as Record<string, unknown>),
      reasoningEffort: 'medium',
    })
    await expect(resolveObservedSelection({ llm: { resolveCallConfig } } as never, {
      provider: 'provider-a', model: 'model-a',
    })).resolves.toEqual({ provider: 'provider-a', model: 'model-a', reasoningEffort: 'medium' })
  })
})
