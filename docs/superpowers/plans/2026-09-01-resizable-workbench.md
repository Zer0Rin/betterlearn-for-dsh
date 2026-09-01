# BetterLearn Resizable Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the right-side BetterLearn result window into a smaller, per-screen resizable and persistent auxiliary window whose typography compacts only at small widths.

**Architecture:** A focused `workbench-size` module owns defaults, bounds, persistence, and pointer geometry. `BetterLearnFloatingApp` applies that model to an anchored panel and renders three resize handles. CSS container queries compact the existing interface, while history becomes an internal drawer at narrow widths and a column only when sufficient panel space exists.

**Tech Stack:** React 18, TypeScript 5.9, Pointer Events, CSS container queries, Vitest 3, react-test-renderer, Playwright acceptance script.

## Global Constraints

- BetterLearn remains collapsed on page load and never changes DSH layout width.
- The panel stays anchored at `top: 16px` and `right: 16px`; it is not movable.
- Resize directions are left edge, bottom edge, and bottom-left corner only.
- Desktop bounds are `360px × 420px` minimum, `min(1080px, 100vw - 32px)` maximum width, and `100dvh - 32px` maximum height.
- Result default is `460px × min(720px, 100dvh - 32px)`; review default is `900px × (100dvh - 32px)`.
- Store sizes separately for `empty`, `import`, `processing`, `review`, and `result` in `localStorage`.
- Font and control sizes shrink below compact content-width breakpoints and never grow above the current normal size.
- History remains collapsed by default and must not force a narrow result panel wider.
- Do not add window movement, size presets, a reset button, or speculative recovery machinery.

---

## File Map

- Create `src/client/workbench-size.ts`: pure defaults, viewport clamping, persisted-size parsing/writing, and pointer delta geometry.
- Modify `src/client/floating-workbench.tsx`: size state, viewport subscription, pointer lifecycle, panel styles, and three handles.
- Modify `src/client/NobeiClientView.tsx`: expose history-open state only; retain existing workspace flow.
- Modify `src/client/styles.ts`: fixed dimensions, handle hit areas, compact container styles, and narrow-history drawer behavior.
- Create `test/client-workbench-size.test.ts`: pure size model and storage tests.
- Modify `test/client-floating-workbench.test.tsx`: pointer interaction, per-screen restoration, and collapse behavior.
- Modify `test/client-styles.test.ts`: selector and responsive-rule contract.
- Modify `scripts/accept-phase1d-client.mjs`: zero-provider browser measurements for default/result/manual sizes.
- Modify `test/accept-phase1d-client.test.ts`: acceptance-result validation.
- Modify `docs/architecture.md` and `README.md`: user-visible resize and persistence behavior.

### Task 1: Pure size model and persistence

**Files:**
- Create: `src/client/workbench-size.ts`
- Create: `test/client-workbench-size.test.ts`

**Interfaces:**
- Consumes: `WorkbenchScreen` from `src/client/floating-workbench.tsx` only as a structural union; avoid a runtime import cycle by declaring/exporting the screen type from this new module and importing it into the shell.
- Produces:

```ts
export type WorkbenchScreen = 'empty' | 'import' | 'processing' | 'review' | 'result'
export interface WorkbenchSize { width: number; height: number }
export interface ViewportSize { width: number; height: number }
export type ResizeAxis = 'width' | 'height' | 'both'
export const WORKBENCH_SIZE_STORAGE_KEY = 'betterlearn:floating-size:v1'
export function defaultWorkbenchSize(screen: WorkbenchScreen, viewport: ViewportSize): WorkbenchSize
export function clampWorkbenchSize(size: WorkbenchSize, viewport: ViewportSize): WorkbenchSize
export function resizeFromPointer(start: WorkbenchSize, axis: ResizeAxis, deltaX: number, deltaY: number, viewport: ViewportSize): WorkbenchSize
export function readWorkbenchSize(storage: Storage, screen: WorkbenchScreen): WorkbenchSize | undefined
export function writeWorkbenchSize(storage: Storage, screen: WorkbenchScreen, size: WorkbenchSize): void
```

- [ ] **Step 1: Write failing size-model tests**

```ts
import { describe, expect, test } from 'vitest'
import {
  WORKBENCH_SIZE_STORAGE_KEY, clampWorkbenchSize, defaultWorkbenchSize,
  readWorkbenchSize, resizeFromPointer, writeWorkbenchSize,
} from '../src/client/workbench-size.js'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe('workbench size model', () => {
  test('uses a narrow result default and a wide review default', () => {
    expect(defaultWorkbenchSize('result', { width: 1440, height: 900 })).toEqual({ width: 460, height: 720 })
    expect(defaultWorkbenchSize('review', { width: 1440, height: 900 })).toEqual({ width: 900, height: 868 })
  })

  test('left-edge movement changes width in the opposite x direction', () => {
    expect(resizeFromPointer({ width: 460, height: 600 }, 'width', -80, 0,
      { width: 1440, height: 900 })).toEqual({ width: 540, height: 600 })
  })

  test('clamps both axes to desktop bounds', () => {
    expect(clampWorkbenchSize({ width: 10, height: 9 }, { width: 800, height: 600 }))
      .toEqual({ width: 360, height: 420 })
    expect(clampWorkbenchSize({ width: 5000, height: 5000 }, { width: 800, height: 600 }))
      .toEqual({ width: 768, height: 568 })
  })

  test('stores independent sizes by screen and ignores malformed storage', () => {
    const storage = memoryStorage()
    writeWorkbenchSize(storage, 'result', { width: 430, height: 650 })
    writeWorkbenchSize(storage, 'review', { width: 820, height: 700 })
    expect(readWorkbenchSize(storage, 'result')).toEqual({ width: 430, height: 650 })
    expect(readWorkbenchSize(storage, 'review')).toEqual({ width: 820, height: 700 })
    storage.setItem(WORKBENCH_SIZE_STORAGE_KEY, '{')
    expect(readWorkbenchSize(storage, 'result')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the new test and verify failure**

Run: `corepack pnpm@11.23.0 vitest run test/client-workbench-size.test.ts`

Expected: FAIL because `src/client/workbench-size.ts` does not exist.

- [ ] **Step 3: Implement the pure model**

Create the module with these exact rules:

```ts
export type WorkbenchScreen = 'empty' | 'import' | 'processing' | 'review' | 'result'
export interface WorkbenchSize { width: number; height: number }
export interface ViewportSize { width: number; height: number }
export type ResizeAxis = 'width' | 'height' | 'both'
export const WORKBENCH_SIZE_STORAGE_KEY = 'betterlearn:floating-size:v1'

const DEFAULTS: Record<WorkbenchScreen, WorkbenchSize> = {
  empty: { width: 420, height: 420 },
  import: { width: 500, height: 720 },
  processing: { width: 460, height: 620 },
  review: { width: 900, height: Number.POSITIVE_INFINITY },
  result: { width: 460, height: 720 },
}

export function clampWorkbenchSize(size: WorkbenchSize, viewport: ViewportSize): WorkbenchSize {
  const maxWidth = Math.max(0, Math.min(1080, viewport.width - 32))
  const maxHeight = Math.max(0, viewport.height - 32)
  return {
    width: Math.min(maxWidth, Math.max(Math.min(360, maxWidth), Math.round(size.width))),
    height: Math.min(maxHeight, Math.max(Math.min(420, maxHeight), Math.round(size.height))),
  }
}

export function defaultWorkbenchSize(screen: WorkbenchScreen, viewport: ViewportSize): WorkbenchSize {
  return clampWorkbenchSize(DEFAULTS[screen], viewport)
}

export function resizeFromPointer(start: WorkbenchSize, axis: ResizeAxis,
  deltaX: number, deltaY: number, viewport: ViewportSize): WorkbenchSize {
  return clampWorkbenchSize({
    width: axis === 'height' ? start.width : start.width - deltaX,
    height: axis === 'width' ? start.height : start.height + deltaY,
  }, viewport)
}
```

For persistence, parse only a plain object whose optional screen entries contain finite positive numeric `width` and `height`. On write, preserve valid entries for other screens, replace the current entry, and catch storage access errors without changing UI state.

- [ ] **Step 4: Run size-model tests**

Run: `corepack pnpm@11.23.0 vitest run test/client-workbench-size.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the model**

```bash
git add src/client/workbench-size.ts test/client-workbench-size.test.ts
git commit -m "feat: model persistent workbench sizes"
```

### Task 2: Anchored React resize interaction

**Files:**
- Modify: `src/client/floating-workbench.tsx`
- Modify: `test/client-floating-workbench.test.tsx`

**Interfaces:**
- Consumes: all exports from Task 1.
- Produces: a panel with inline `--betterlearn-user-width` and `--betterlearn-user-height`, `data-resizing`, and handles `betterlearn-resize-left`, `betterlearn-resize-bottom`, `betterlearn-resize-corner`.

- [ ] **Step 1: Add failing shell tests**

Extend the existing injected-storage harness so local size storage is passed separately from session storage. Assert:

```ts
const panel = renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' })
expect(panel.props.style).toMatchObject({
  '--betterlearn-user-width': '460px',
  '--betterlearn-user-height': '720px',
})
expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-resize-left' })).toBeDefined()
expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-resize-bottom' })).toBeDefined()
expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-resize-corner' })).toBeDefined()
```

Call the left handle's `onPointerDown` with `{ clientX: 600, clientY: 100, currentTarget: { setPointerCapture() {} }, pointerId: 1 }`, then call its document-level move path at `clientX: 520`. Assert width becomes `540px`; call pointer-up and assert the result entry is persisted. Change `data-screen` to review and assert its independent default or stored review size is used. Collapse/reopen and assert the result size is retained.

- [ ] **Step 2: Run the shell test and verify failure**

Run: `corepack pnpm@11.23.0 vitest run test/client-floating-workbench.test.tsx`

Expected: FAIL because the panel has no user-size styles or handles.

- [ ] **Step 3: Integrate size state into the shell**

Update props to accept an injectable persistent store:

```ts
export interface BetterLearnFloatingAppProps {
  sessions: Pick<ISessions, 'list' | 'subagentAddress'>
  modelDirectories: ModelDirectoryResolverPort
  storage: Storage
  sizeStorage?: Storage
  api?: ClientApi
}
```

Use `const persistentSizeStorage = sizeStorage ?? window.localStorage`, a viewport state initialized from `{ width: window.innerWidth, height: window.innerHeight }`, and a `resize` listener. On `screen` or viewport changes, choose `readWorkbenchSize(persistentSizeStorage, screen) ?? defaultWorkbenchSize(screen, viewport)`, then call `clampWorkbenchSize(selected, viewport)` for presentation.

Use a single pointer-start helper:

```ts
function beginResize(axis: ResizeAxis, event: React.PointerEvent<HTMLDivElement>) {
  event.preventDefault()
  event.currentTarget.setPointerCapture(event.pointerId)
  resizeRef.current = { axis, pointerId: event.pointerId, x: event.clientX, y: event.clientY, size }
  setResizing(true)
}
```

Register `pointermove`, `pointerup`, and `pointercancel` on `window` only while resizing. Move derives the next size with `resizeFromPointer`; finish writes that screen's final size and clears the gesture. Render:

```tsx
<aside style={{
  '--betterlearn-user-width': `${size.width}px`,
  '--betterlearn-user-height': `${size.height}px`,
} as React.CSSProperties} data-resizing={resizing ? 'true' : 'false'}>
  <div className="betterlearn-resize-handle betterlearn-resize-handle--left"
    data-testid="betterlearn-resize-left" onPointerDown={event => beginResize('width', event)} />
  <div className="betterlearn-resize-handle betterlearn-resize-handle--bottom"
    data-testid="betterlearn-resize-bottom" onPointerDown={event => beginResize('height', event)} />
  <div className="betterlearn-resize-handle betterlearn-resize-handle--corner"
    data-testid="betterlearn-resize-corner" onPointerDown={event => beginResize('both', event)} />
  {/* existing header and workspace */}
</aside>
```

At mount, pass `sizeStorage={window.localStorage}` while preserving current `sessionStorage` for run pointers.

- [ ] **Step 4: Run focused React tests**

Run: `corepack pnpm@11.23.0 vitest run test/client-workbench-size.test.ts test/client-floating-workbench.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the interaction**

```bash
git add src/client/floating-workbench.tsx test/client-floating-workbench.test.tsx
git commit -m "feat: resize the floating workbench"
```

### Task 3: Compact typography and internal history drawer

**Files:**
- Modify: `src/client/styles.ts`
- Modify: `test/client-styles.test.ts`

**Interfaces:**
- Consumes: panel variables and data attributes from Task 2.
- Produces: fixed user dimensions, visible cursor hit zones, compact container queries, and history drawer/column layout.

- [ ] **Step 1: Add failing CSS contract assertions**

```ts
expect(CLIENT_CSS).toContain('width: var(--betterlearn-user-width)')
expect(CLIENT_CSS).toContain('height: var(--betterlearn-user-height)')
expect(CLIENT_CSS).toContain('.betterlearn-resize-handle--left')
expect(CLIENT_CSS).toContain('cursor: ew-resize')
expect(CLIENT_CSS).toContain('.betterlearn-resize-handle--bottom')
expect(CLIENT_CSS).toContain('cursor: ns-resize')
expect(CLIENT_CSS).toContain('.betterlearn-resize-handle--corner')
expect(CLIENT_CSS).toContain('cursor: nesw-resize')
expect(CLIENT_CSS).toContain('@container (max-width: 480px)')
expect(CLIENT_CSS).toContain('@container (max-width: 400px)')
expect(CLIENT_CSS).toContain('data-history-open="true"')
```

Remove assertions that require history to add `300px` to panel width or result to default to `600px`.

- [ ] **Step 2: Run CSS tests and verify failure**

Run: `corepack pnpm@11.23.0 vitest run test/client-styles.test.ts`

Expected: FAIL on user dimensions, handles, and compact breakpoints.

- [ ] **Step 3: Implement the visual rules**

Replace screen width variables with user dimensions:

```css
.betterlearn-floating-panel {
  position: absolute;
  top: 16px;
  right: 16px;
  width: var(--betterlearn-user-width);
  height: var(--betterlearn-user-height);
  max-width: calc(100vw - 32px);
  max-height: calc(100dvh - 32px);
}
.betterlearn-floating-panel[data-resizing="true"] { transition: none; user-select: none; }
.betterlearn-resize-handle { position: absolute; z-index: 5; touch-action: none; }
.betterlearn-resize-handle--left { inset: 12px auto 12px -5px; width: 10px; cursor: ew-resize; }
.betterlearn-resize-handle--bottom { inset: auto 12px -5px 12px; height: 10px; cursor: ns-resize; }
.betterlearn-resize-handle--corner { left: -7px; bottom: -7px; width: 18px; height: 18px; cursor: nesw-resize; }
```

Make `.nobei-client-layout` fill the panel width and history overlay by default. At a panel/container threshold wide enough for `260px + 360px`, switch to a two-column grid without changing outer width. Preserve mobile full-screen rules and hide desktop handles at `max-width: 680px`.

At `@container (max-width: 480px)` reduce base font size to `14px`, masthead title, panel padding, card padding, gaps, and button/input padding. At `400px`, use `13px` and a smaller title while retaining minimum interactive heights. Do not define any scale above `1`.

- [ ] **Step 4: Run all focused client tests**

Run: `corepack pnpm@11.23.0 vitest run test/client-styles.test.ts test/client-floating-workbench.test.tsx test/client-view.test.tsx test/client-history-sidebar.test.tsx test/client-result-summary.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit responsive styles**

```bash
git add src/client/styles.ts test/client-styles.test.ts
git commit -m "feat: compact the resizable workbench"
```

### Task 4: Browser acceptance and documentation

**Files:**
- Modify: `scripts/accept-phase1d-client.mjs`
- Modify: `test/accept-phase1d-client.test.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: rendered handle test ids, panel inline size, and localStorage key from Tasks 1–3.
- Produces: acceptance JSON fields `resultDefaultWidth`, `resultDefaultHeight`, `resizedWidth`, `resizedHeight`, `restoredWidth`, `restoredHeight`, `hostWidthBefore`, `hostWidthAfter`.

- [ ] **Step 1: Extend acceptance-result unit tests**

Add a passing fixture where result default width is below the old `600px`, resize grows both dimensions, reload restores them, and DSH host width remains unchanged. Add failing fixtures for missing restore and host movement.

```ts
expect(() => assertPhase1dBrowserResult({
  ...valid,
  resultDefaultWidth: 460,
  resultDefaultHeight: 720,
  resizedWidth: 620,
  resizedHeight: 800,
  restoredWidth: 620,
  restoredHeight: 800,
  hostWidthBefore: 1160,
  hostWidthAfter: 1160,
})).not.toThrow()
```

- [ ] **Step 2: Run acceptance unit tests and verify failure**

Run: `corepack pnpm@11.23.0 vitest run test/accept-phase1d-client.test.ts`

Expected: FAIL because the result contract does not include resize fields.

- [ ] **Step 3: Update the browser script**

Use a completed fixture run already present in SQLite; do not import or call a provider. The script must:

1. clear only `betterlearn:floating-size:v1` before the default measurement;
2. open BetterLearn and a completed result;
3. record DSH host width and default panel rect;
4. drag the bottom-left handle approximately `160px` left and `80px` down;
5. record the enlarged rect;
6. reload the page, reopen BetterLearn, and record the restored rect;
7. assert host width never changes;
8. save before/after screenshots under the existing acceptance output directory.

- [ ] **Step 4: Update user documentation**

Document that the result view defaults to a narrow `460px` auxiliary window, the left/bottom/corner resize areas, per-screen size memory, compact small-window typography, and internal narrow-history drawer. Remove statements that history always widens the outer panel and result is fixed at `600px`.

- [ ] **Step 5: Run workbench verification**

Run:

```bash
corepack pnpm@11.23.0 vitest run test/client-workbench-size.test.ts test/client-floating-workbench.test.tsx test/client-styles.test.ts test/client-view.test.tsx test/client-history-sidebar.test.tsx test/accept-phase1d-client.test.ts
corepack pnpm@11.23.0 build
```

Expected: all focused tests pass and the client/host builds complete without TypeScript errors.

- [ ] **Step 6: Commit acceptance and docs**

```bash
git add scripts/accept-phase1d-client.mjs test/accept-phase1d-client.test.ts README.md docs/architecture.md
git commit -m "test: accept resizable BetterLearn window"
```
