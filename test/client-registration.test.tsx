import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { apply, inject } from '../src/client/index.js'

const reactRoot = vi.hoisted(() => ({ render: vi.fn(), unmount: vi.fn() }))
const createRoot = vi.hoisted(() => vi.fn(() => reactRoot))

vi.mock('react-dom/client', () => ({ createRoot }))

describe('BetterLearn floating client registration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    createRoot.mockClear()
    reactRoot.render.mockClear()
    reactRoot.unmount.mockClear()
  })

  test('mounts one body-owned React root and disposes it without slot registration', () => {
    const attributes: Record<string, string> = {}
    const container = {
      attributes,
      setAttribute(name: string, value: string) { attributes[name] = value },
      remove: vi.fn(),
    }
    const appended: unknown[] = []
    const document = {
      visibilityState: 'visible',
      querySelector: vi.fn(() => null),
      createElement: vi.fn((tag: string) => tag === 'style'
        ? { setAttribute() {}, textContent: '' }
        : container),
      head: { appendChild(node: unknown) { appended.push(node) } },
      body: { appendChild: vi.fn((node: unknown) => appended.push(node)) },
      addEventListener() {},
      removeEventListener() {},
    }
    const storage = {
      length: 0,
      clear() {}, getItem: () => null, key: () => null, removeItem() {}, setItem() {},
    }
    vi.stubGlobal('document', document)
    vi.stubGlobal('window', { sessionStorage: storage, setTimeout, clearTimeout })

    const sessions = {
      list: {
        getSnapshot: () => ({ ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }),
        subscribe: () => () => undefined,
      },
      subagentAddress: () => undefined,
    }
    const dispose = apply({ sessions, modelDirectories: {} } as unknown as Context)

    expect(inject).toEqual(['modelDirectories', 'sessions'])
    expect(createRoot).toHaveBeenCalledOnce()
    expect(document.body.appendChild).toHaveBeenCalledWith(container)
    expect(container.attributes['data-betterlearn-floating-root']).toBe('')
    expect(reactRoot.render).toHaveBeenCalledOnce()
    expect(dispose).toBeTypeOf('function')

    dispose()
    expect(reactRoot.unmount).toHaveBeenCalledOnce()
    expect(container.remove).toHaveBeenCalledOnce()
  })
})
