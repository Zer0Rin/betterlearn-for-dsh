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
    expect(CLIENT_CSS).toContain('width: var(--betterlearn-user-width)')
    expect(CLIENT_CSS).toContain('height: var(--betterlearn-user-height)')
    expect(CLIENT_CSS).toContain('.betterlearn-resize-handle--left')
    expect(CLIENT_CSS).toContain('cursor: ew-resize')
    expect(CLIENT_CSS).toContain('.betterlearn-resize-handle--bottom')
    expect(CLIENT_CSS).toContain('cursor: ns-resize')
    expect(CLIENT_CSS).toContain('.betterlearn-resize-handle--corner')
    expect(CLIENT_CSS).toContain('cursor: nesw-resize')
    expect(CLIENT_CSS).toContain('left: 0; bottom: 0; width: 18px; height: 18px')
    expect(CLIENT_CSS).not.toContain('left: -7px; bottom: -7px')
    expect(CLIENT_CSS).toContain('@container (max-width: 480px)')
    expect(CLIENT_CSS).toContain('@container (max-width: 400px)')
    expect(CLIENT_CSS).toContain('@container (max-width: 340px)')
    expect(CLIENT_CSS).toContain('font-size: 14px')
    expect(CLIENT_CSS).toContain('font-size: 13px')
    expect(CLIENT_CSS).toContain('.nobei-client__masthead-intro, .nobei-client__active-model, .nobei-client__result-meta { display: none; }')
    expect(CLIENT_CSS).toContain('.betterlearn-floating-panel[data-compact-height="true"] .nobei-client__masthead')
    const compactFontSizes = [...CLIENT_CSS.matchAll(/\.nobei-client \{[^}]*font-size:\s*(\d+)px/g)]
      .map(match => Number(match[1]))
    expect(compactFontSizes.length).toBeGreaterThan(0)
    expect(Math.min(...compactFontSizes)).toBe(13)
    expect(CLIENT_CSS).toContain('--betterlearn-history-width: 260px')
    expect(CLIENT_CSS).toContain('[data-history-open="true"]')
    expect(CLIENT_CSS).not.toContain('calc(var(--betterlearn-panel-width) + var(--betterlearn-history-width))')
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
