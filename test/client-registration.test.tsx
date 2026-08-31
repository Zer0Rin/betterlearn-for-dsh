import { bindModelSelection } from './helpers/model-selection.js'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, test, vi } from 'vitest'
import { apply } from '../src/client/index.js'

describe('Nobei conversation view registration', () => {
  test('registers the public conversation.view list entry and disposes it', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
        key: () => null,
        get length() { return values.size },
      },
      setTimeout,
      clearTimeout,
    })
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      querySelector: () => null,
      createElement: () => ({ setAttribute() {}, textContent: '' }),
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    })
    const core = new SlotCore()
    const disposeOwner = core.register({
      name: 'root',
      children: {
        'conversation.view': { kind: 'list', scope: 'session' },
        'conversation.input.dock': { kind: 'list', scope: 'session' },
      },
    }, () => null)
    let disposeEntry: (() => void) | undefined
    const slots = {
      inject(key: string, callback: () => (() => void)) {
        expect(['conversation.view', 'conversation.input.dock']).toContain(key)
        const dispose = callback()
        if (key === 'conversation.view') disposeEntry = dispose
        return vi.fn()
      },
      register: core.register.bind(core),
    }

    const modelDirectories = {
      directoryFor: vi.fn(() => ({
        load: vi.fn(async () => ({
          current: { provider: 'provider-a', model: 'model-a' }, routable: true,
        })),
      })),
    }
    apply({
      slots,
      modelDirectories,
      sessions: { subagentAddress: vi.fn(() => undefined) },
    } as unknown as Context)
    const entries = core.entries('conversation.view')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.options).toMatchObject({
      id: 'nobei',
      order: 50,
      label: 'Nobei',
    })
    expect(entries[0]!.inject).toBeTypeOf('function')
    const injected = entries[0]!.inject!('session-1' as never) as any
    expect(injected.hooks.modelDirectory.getSnapshot).toBeTypeOf('function')
    expect(injected).not.toHaveProperty('modelDirectories')
    expect(injected.loadModelSelection).toBeTypeOf('function')

    let renderer: ReturnType<typeof create>
    act(() => {
      renderer = create(createElement(entries[0]!.component, { sessionId: 'session-1', ...bindModelSelection(injected) }))
    })
    expect(renderer!.root.findByProps({ 'data-testid': 'nobei-client-view' })).toBeDefined()
    act(() => renderer!.unmount())

    const docks = core.entries('conversation.input.dock')
    expect(docks).toHaveLength(1)
    expect(docks[0]?.options).toMatchObject({ id: 'nobei-blank-import', order: 5 })
    let dock: ReturnType<typeof create>
    act(() => {
      dock = create(createElement(docks[0]!.component, {
        sessionId: 'session-1',
        session: { blank: true },
        ...bindModelSelection(docks[0]!.inject!('session-1' as never) as any),
      }))
    })
    expect(dock!.root.findByProps({ 'data-testid': 'nobei-client-view' })).toBeDefined()
    act(() => dock!.unmount())

    let nonBlank: ReturnType<typeof create>
    act(() => {
      nonBlank = create(createElement(docks[0]!.component, {
        sessionId: 'session-1',
        session: { blank: false },
        ...bindModelSelection(docks[0]!.inject!('session-1' as never) as any),
      }))
    })
    expect(nonBlank!.toJSON()).toBeNull()
    act(() => nonBlank!.unmount())

    disposeEntry?.()
    expect(core.entries('conversation.view')).toEqual([])
    disposeOwner()
    vi.unstubAllGlobals()
  })
})
