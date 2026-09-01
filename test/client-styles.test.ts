import { describe, expect, test, vi } from 'vitest'
import { CLIENT_CSS, ensureClientStyles } from '../src/client/styles.js'

describe('phase1d scoped styles', () => {
  test('installs one plugin-owned style element', () => {
    const nodes: Array<{ attributes: Record<string, string>; textContent: string }> = []
    const doc = {
      querySelector: vi.fn(() => nodes[0] ?? null),
      createElement: vi.fn(() => {
        const node = {
          attributes: {} as Record<string, string>, textContent: '',
          setAttribute(name: string, value: string) { this.attributes[name] = value },
        }
        return node
      }),
      head: { appendChild(node: typeof nodes[number]) { nodes.push(node) } },
    } as unknown as Document
    ensureClientStyles(doc)
    ensureClientStyles(doc)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.attributes['data-plugin-css']).toBe('@nobei/dsh-phase1/client')
    expect(nodes[0]?.textContent).toBe(CLIENT_CSS)
  })

  test('keeps selectors, assets, and visual rules inside the Nobei workbench', () => {
    expect(CLIENT_CSS).toContain('#F6F8FC')
    expect(CLIENT_CSS).toContain('#D99024')
    expect(CLIENT_CSS).toContain('prefers-reduced-motion: reduce')
    expect(CLIENT_CSS).toContain('@media (max-width: 680px)')
    expect(CLIENT_CSS).not.toMatch(/url\(|@import|https?:|linear-gradient|radial-gradient|backdrop-filter/)
    expect(CLIENT_CSS).toContain('.betterlearn-floating-root')
    expect(CLIENT_CSS).toContain('position: fixed')
    expect(CLIENT_CSS).toContain('pointer-events: none')
    expect(CLIENT_CSS).toContain('[data-screen="empty"]')
    expect(CLIENT_CSS).toContain('[data-screen="import"]')
    expect(CLIENT_CSS).toContain('[data-screen="processing"]')
    expect(CLIENT_CSS).toContain('[data-screen="review"]')
    expect(CLIENT_CSS).toContain('[data-screen="result"]')
    expect(CLIENT_CSS).toContain('--betterlearn-panel-width: min(1080px, calc(100vw - 32px))')
    expect(CLIENT_CSS).toContain('--betterlearn-history-width: 300px')
    expect(CLIENT_CSS).toContain('[data-history-open="true"]')
    expect(CLIENT_CSS).toContain('calc(var(--betterlearn-panel-width) + var(--betterlearn-history-width))')
    expect(CLIENT_CSS).toContain('right: 16px')
    expect(CLIENT_CSS).toContain('max-height: calc(100dvh - 32px)')
    expect(CLIENT_CSS).not.toMatch(/(^|[,{]\s*)(body|:root|button|input|textarea|main)(?=[\s,{.:#[])/m)
    expect(CLIENT_CSS).not.toContain('dsh-')
    const selectorBlocks = CLIENT_CSS.split('\n')
      .map(line => line.trim())
      .filter(line => line.endsWith('{') && !line.startsWith('@'))
    for (const block of selectorBlocks) {
      const selectors = block.replace(/\{$/, '').split(',')
      for (const selector of selectors) {
        expect(selector.trim()).toMatch(/^(\.nobei-client|\.nobei-history|\.betterlearn-floating)/)
      }
    }
  })
})
