# BetterLearn Floating Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-flow BetterLearn conversation tab and input dock with a body-mounted, default-collapsed right-side workbench whose width adapts to the active BetterLearn screen.

**Architecture:** The client plugin mounts one independent React root under `document.body`. A top-level component subscribes to `ctx.sessions.list`, renders a book-spine launcher while collapsed, and reuses the existing `NobeiWorkspace` for the current session while expanded. Existing Host routes, Python Core, persistence, and model selection behavior remain unchanged.

**Tech Stack:** TypeScript 5.9, React 18, ReactDOM 18, DSH client runtime session store, Vitest, react-test-renderer, Playwright acceptance.

## Global Constraints

- Page load always starts collapsed; expanded state is not persisted.
- The floating workbench never participates in DSH layout and never changes DSH column widths.
- Use provisional size tiers: empty 420px, import 560px, processing 520px, review up to 1080px, result 600px.
- Review may cover most of the DSH page; result remains a smaller conversation companion.
- Keep the surface non-modal: no backdrop, no focus trap, and pointer events outside the owned panel pass through.
- Preserve the existing BetterLearn workflow, API, sessionStorage isolation, model routing, and error copy.
- Prioritize the main path. Do not add speculative recovery layers, drag-resize, manual resize, or unrelated refactors.
- Follow test-first red-green-refactor for every production behavior.

---

## File Map

- Create `src/client/floating-workbench.tsx`: body-mounted shell, DSH current-session subscription, model-directory bridge, and mount/dispose function.
- Modify `src/client/index.tsx`: replace slot registrations with `mountFloatingWorkbench(ctx)`.
- Modify `src/client/NobeiClientView.tsx`: expose workspace screen changes and remove obsolete slot-facing wrappers.
- Modify `src/client/styles.ts`: add the launcher/panel shell and adapt existing workspace layout to the floating size tiers.
- Modify `scripts/build-client.mjs`: keep `react-dom/client` external beside React.
- Modify `package.json` and `pnpm-lock.yaml`: declare ReactDOM runtime/type development support.
- Replace `test/client-registration.test.tsx`: assert body mounting and disposal instead of slot registration.
- Create `test/client-floating-workbench.test.tsx`: assert collapsed/expanded behavior, Escape, empty state, screen sizing, and session switching.
- Modify `test/client-view.test.tsx` and `test/helpers/model-selection.tsx`: keep direct workspace tests after removing the obsolete slot view wrapper.
- Modify `test/client-styles.test.ts`: assert fixed overlay, size tiers, pass-through root, mobile full-screen, and reduced motion.
- Modify `scripts/accept-phase1d-client.mjs` and `test/accept-phase1d-client.test.ts`: activate and validate the floating surface.
- Modify `README.md`, `docs/architecture.md`, `docs/p3-client-report.md`, and `docs/validation.md`: describe the new surface and acceptance checks.

---

### Task 1: Mount an independent client root

**Files:**
- Create: `src/client/floating-workbench.tsx`
- Modify: `src/client/index.tsx`
- Modify: `scripts/build-client.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Replace test: `test/client-registration.test.tsx`

**Interfaces:**
- Produces: `mountFloatingWorkbench(ctx: Context): () => void`
- Produces: `BetterLearnFloatingApp(props: BetterLearnFloatingAppProps): JSX.Element`
- Consumes: `ctx.sessions.list`, `ctx.sessions.subagentAddress`, `ctx.modelDirectories`, `createClientApi()`, and `window.sessionStorage`.

- [ ] **Step 1: Replace the registration test with a failing mount/dispose test**

Mock `react-dom/client` and provide a minimal fake document. The test must call client `apply()` with `sessions` and `modelDirectories` only and assert:

```tsx
expect(createRoot).toHaveBeenCalledOnce()
expect(document.body.appendChild).toHaveBeenCalledOnce()
expect(container.attributes['data-betterlearn-floating-root']).toBe('')
expect(dispose).toBeTypeOf('function')
dispose()
expect(root.unmount).toHaveBeenCalledOnce()
expect(container.remove).toHaveBeenCalledOnce()
```

Also assert `inject` equals `['modelDirectories', 'sessions']` and that the fake context does not need `slots`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
corepack pnpm@11.23.0 vitest run test/client-registration.test.tsx
```

Expected: FAIL because `apply()` still calls `ctx.slots.inject` and no body mount exists.

- [ ] **Step 3: Add ReactDOM declarations and build external**

Update `package.json` with:

```json
"peerDependencies": {
  "react": "^18.2.0",
  "react-dom": "^18.2.0"
}
```

Preserve all existing peer dependencies, add `react-dom: "18.3.1"` and `@types/react-dom: "18.3.0"` to `devDependencies`, then run:

```bash
corepack pnpm@11.23.0 install --lockfile-only
```

In `scripts/build-client.mjs`, extend the external list to:

```js
external: ['react', 'react/jsx-runtime', 'react-dom/client', '@deepseek-ai/*'],
```

- [ ] **Step 4: Implement the minimal body mount**

Create `src/client/floating-workbench.tsx` with the mount boundary:

```tsx
import type { Context } from '@deepseek-ai/cordis'
import { createRoot } from 'react-dom/client'
import { ensureClientStyles } from './styles.js'

export function mountFloatingWorkbench(ctx: Context): () => void {
  ensureClientStyles(document)
  const container = document.createElement('div')
  container.setAttribute('data-betterlearn-floating-root', '')
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(<BetterLearnFloatingApp sessions={ctx.sessions} modelDirectories={ctx.modelDirectories as never}
    storage={window.sessionStorage} />)
  return () => {
    root.unmount()
    container.remove()
  }
}
```

Initially define `BetterLearnFloatingApp` as a launcher-only component so the mount test can pass. Change `src/client/index.tsx` to:

```tsx
export const name = 'nobei-phase1d-client'
export const inject = ['modelDirectories', 'sessions'] as const

export function apply(ctx: Context): () => void {
  return mountFloatingWorkbench(ctx)
}
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
corepack pnpm@11.23.0 vitest run test/client-registration.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add package.json pnpm-lock.yaml scripts/build-client.mjs src/client/index.tsx src/client/floating-workbench.tsx test/client-registration.test.tsx
git commit -m "feat: mount BetterLearn outside the DSH layout"
```

---

### Task 2: Build the collapsed shell and current-session bridge

**Files:**
- Modify: `src/client/floating-workbench.tsx`
- Modify: `src/client/NobeiClientView.tsx`
- Create: `test/client-floating-workbench.test.tsx`
- Modify: `test/client-view.test.tsx`
- Modify: `test/helpers/model-selection.tsx`

**Interfaces:**
- Produces: `type WorkbenchScreen = 'empty' | 'import' | 'processing' | 'review' | 'result'`
- Produces: `NobeiWorkspaceProps.onScreenChange?: (screen: WorkspaceScreen) => void`
- Consumes: `sessions.list.getSnapshot()/subscribe()`, `sessions.subagentAddress(sessionId)`, and `modelSelectionInjection()`.

- [ ] **Step 1: Write failing shell interaction tests**

Create `test/client-floating-workbench.test.tsx` with a mutable session source and render `BetterLearnFloatingApp` through `react-test-renderer`. Cover these separate tests:

```tsx
test('starts collapsed and opens from the BetterLearn launcher', () => {
  expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' }).props['aria-expanded']).toBe(false)
  act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' }).props.onClick())
  expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' })).toBeDefined()
})

test('collapses an open panel on Escape', () => {
  act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' }).props.onClick())
  act(() => keydown?.({ key: 'Escape' }))
  expect(renderer.root.findAllByProps({ 'data-testid': 'betterlearn-floating-panel' })).toHaveLength(0)
  expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' })).toBeDefined()
})

test('shows guidance without a current DSH session', () => {
  act(() => renderer.root.findByProps({ 'data-testid': 'betterlearn-launcher' }).props.onClick())
  expect(JSON.stringify(renderer.toJSON())).toContain('先在 DSH 创建或选择普通会话')
})
```

The test setup declares `let keydown: ((event: { key: string }) => void) | undefined` and stubs `document.addEventListener`/`removeEventListener` to capture and release the `keydown` callback.

- [ ] **Step 2: Run the shell tests and verify RED**

Run:

```bash
corepack pnpm@11.23.0 vitest run test/client-floating-workbench.test.tsx
```

Expected: FAIL because the launcher-only placeholder has no panel or Escape behavior.

- [ ] **Step 3: Implement the shell state and empty surface**

In `BetterLearnFloatingApp`:

```tsx
const sessionState = useSyncExternalStore(
  listener => sessions.list.subscribe(listener),
  () => sessions.list.getSnapshot(),
  () => sessions.list.getSnapshot(),
)
const sessionId = sessionState.current === undefined ? undefined : String(sessionState.current)
const [expanded, setExpanded] = useState(false)
const [screen, setScreen] = useState<WorkbenchScreen>(sessionId ? 'import' : 'empty')
```

Render a launcher with `aria-expanded`, or an `aside` with `data-screen={screen}` and a collapse button. Register the Escape listener only while expanded and remove it in the effect cleanup. Render the no-session copy exactly as “先在 DSH 创建或选择普通会话，再使用 BetterLearn。”

- [ ] **Step 4: Run the shell tests and verify GREEN**

Run the same focused command. Expected: PASS.

- [ ] **Step 5: Write failing current-session and screen propagation tests**

Add tests that:

- start with `current: 'session-a'`, expand, and observe access to `nobei:phase1d:session:session-a`;
- update the session source to `current: 'session-b'`, notify subscribers, and observe access to the `session-b` key;
- render `NobeiWorkspace` for `undefined`, `generating`, `review_pending`, and `completed` runs and assert `onScreenChange` receives `import`, `processing`, `review`, and `result` respectively.

- [ ] **Step 6: Run the new tests and verify RED**

Run:

```bash
corepack pnpm@11.23.0 vitest run test/client-floating-workbench.test.tsx test/client-view.test.tsx
```

Expected: FAIL because the shell does not render the workspace and `NobeiWorkspace` has no screen callback.

- [ ] **Step 7: Connect the current session to the existing workspace**

Add `onScreenChange` to `NobeiWorkspaceProps` and notify it from an effect:

```tsx
useEffect(() => onScreenChange?.(workspace.screen), [onScreenChange, workspace.screen])
```

In `floating-workbench.tsx`, add a small `FloatingSessionWorkspace` component that memoizes `modelSelectionInjection(modelDirectories, sessionId, ordinarySession)`, subscribes to its model-directory source with `useSyncExternalStore`, and renders:

```tsx
<NobeiWorkspace key={sessionId} sessionId={sessionId} api={api} storage={storage}
  ordinarySession={ordinarySession}
  modelDirectoryState={modelDirectoryState}
  loadModelSelection={face.loadModelSelection}
  readModelDirectory={face.readModelDirectory}
  onScreenChange={onScreenChange} />
```

Derive `ordinarySession` from `sessions.subagentAddress(sessionId) === undefined`. Remove the obsolete `NobeiClientView`, `NobeiBlankSessionDock`, slot-specific types, and the corresponding `ViewWithDirectory` test helper while preserving direct `NobeiWorkspace` tests.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
corepack pnpm@11.23.0 vitest run test/client-floating-workbench.test.tsx test/client-view.test.tsx test/client-model-directory.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit Task 2**

```bash
git add src/client/floating-workbench.tsx src/client/NobeiClientView.tsx test/client-floating-workbench.test.tsx test/client-view.test.tsx test/helpers/model-selection.tsx
git commit -m "feat: add collapsible session-aware workbench"
```

---

### Task 3: Add adaptive panel sizing and compact layouts

**Files:**
- Modify: `src/client/styles.ts`
- Modify: `test/client-styles.test.ts`

**Interfaces:**
- Consumes: floating shell `data-screen` and existing `.nobei-client__workspace[data-workspace-screen]`.
- Produces: fixed, pointer-pass-through root; interactive launcher/panel; size tiers; mobile full-screen behavior.

- [ ] **Step 1: Write failing style assertions**

Extend `test/client-styles.test.ts` to require these semantic rules:

```ts
expect(CLIENT_CSS).toContain('.betterlearn-floating-root')
expect(CLIENT_CSS).toContain('position:fixed')
expect(CLIENT_CSS).toContain('pointer-events:none')
expect(CLIENT_CSS).toContain('[data-screen="review"]')
expect(CLIENT_CSS).toContain('--betterlearn-panel-width: min(1080px, calc(100vw - 32px))')
expect(CLIENT_CSS).toContain('max-height:calc(100dvh - 32px)')
expect(CLIENT_CSS).toContain('@media (max-width: 680px)')
```

Retain the assertions that forbid remote assets, gradients, backdrop filters, and unscoped element selectors.

- [ ] **Step 2: Run the style test and verify RED**

Run:

```bash
corepack pnpm@11.23.0 vitest run test/client-styles.test.ts
```

Expected: FAIL because floating shell selectors and size tiers do not exist.

- [ ] **Step 3: Implement the floating visual system**

Add CSS scoped under `.betterlearn-floating-root`:

```css
.betterlearn-floating-root {
  position: fixed;
  inset: 0;
  z-index: 12000;
  pointer-events: none;
}
.betterlearn-floating-launcher {
  position: absolute;
  right: 0;
  top: 50%;
  width: 44px;
  min-height: 132px;
  transform: translateY(-50%);
  pointer-events: auto;
}
.betterlearn-floating-panel {
  --betterlearn-panel-width: 560px;
  position: absolute;
  top: 16px;
  right: 16px;
  width: min(var(--betterlearn-panel-width), calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  overflow: hidden;
  pointer-events: auto;
}
```

Define `empty=420px`, `import=560px`, `processing=520px`, `review=min(1080px, calc(100vw - 32px))`, and `result=600px`. Make the panel body the only vertical scroll owner. Add a sticky quiet title bar, the book-spine launcher, dark-mode-compatible tokens, focus-visible states, and mobile `inset: 0; width: 100%; max-height: 100dvh; border-radius: 0`.

Adjust the existing `.nobei-client` root to use panel-local spacing and no viewport-derived max-height. Keep the review grid three-column at the large review tier and let existing container queries collapse it inside narrower panels.

- [ ] **Step 4: Run style and component tests and verify GREEN**

Run:

```bash
corepack pnpm@11.23.0 vitest run test/client-styles.test.ts test/client-floating-workbench.test.tsx test/client-view.test.tsx test/client-review-workspace.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run a client build to catch CSS/ReactDOM integration issues**

Run:

```bash
corepack pnpm@11.23.0 build
```

Expected: exit 0 and `lib/client.js` contains the floating workbench module registration without bundling a second ReactDOM implementation.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/client/styles.ts test/client-styles.test.ts
git commit -m "feat: size BetterLearn around its active workflow"
```

---

### Task 4: Update browser acceptance and user documentation

**Files:**
- Modify: `scripts/accept-phase1d-client.mjs`
- Modify: `test/accept-phase1d-client.test.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/p3-client-report.md`
- Modify: `docs/validation.md`

**Interfaces:**
- Produces acceptance result `clientEntry.surface: 'floating'`.
- Produces geometry evidence: collapsed launcher visible, panel screen tier, and unchanged DSH conversation width between collapsed and expanded states.

- [ ] **Step 1: Write failing acceptance-result assertions**

Change the passing fixture to:

```ts
clientEntry: {
  surface: 'floating',
  visible: true,
  collapsedOnLoad: true,
  hostWidthBefore: 900,
  hostWidthAfter: 900,
  reviewWidth: 1080,
  resultWidth: 600,
}
```

Update `assertPhase1dBrowserResult()` to require `surface === 'floating'`, collapsed-on-load, equal host widths, `reviewWidth > resultWidth`, and both widths greater than zero.

- [ ] **Step 2: Run the acceptance unit test and verify RED**

Run:

```bash
corepack pnpm@11.23.0 vitest run test/accept-phase1d-client.test.ts
```

Expected: FAIL because the result validator still accepts only dock/tab and has no geometry checks.

- [ ] **Step 3: Update the Playwright activation and geometry capture**

Replace `openNobeiView()` with floating activation:

1. Wait for `[data-testid="betterlearn-launcher"]`.
2. Record the DSH conversation column width.
3. Assert the launcher reports `aria-expanded="false"`.
4. Click it and wait for `[data-testid="betterlearn-floating-panel"]`.
5. Return `{ activationStarted: false, surface: 'floating', collapsedOnLoad: true, hostWidthBefore }`.

During review and result screens, record the panel bounding-box widths. After expansion, record the conversation width again and require it to equal the collapsed width within a one-pixel tolerance. Keep the existing end-to-end import, processing, review, result, reload, request-ledger, and screenshot checks.

- [ ] **Step 4: Run the acceptance unit test and verify GREEN**

Run the same focused test. Expected: PASS.

- [ ] **Step 5: Update documentation**

Change user-facing descriptions from “BetterLearn tab/dock” to “right-side BetterLearn button and floating workbench.” Update the architecture diagram to show `document.body → BetterLearn Floating Client`, document that the panel starts collapsed and does not resize DSH, and note that exact size tiers are a first-pass baseline subject to visual acceptance feedback.

- [ ] **Step 6: Run documentation and package checks**

Run:

```bash
corepack pnpm@11.23.0 vitest run test/package.test.ts test/product-patch.test.ts test/accept-phase1d-client.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add scripts/accept-phase1d-client.mjs test/accept-phase1d-client.test.ts README.md docs/architecture.md docs/p3-client-report.md docs/validation.md
git commit -m "docs: describe the floating BetterLearn workflow"
```

---

### Task 5: Full verification and visual review

**Files:**
- Modify only if a verification failure identifies an in-scope regression.

- [ ] **Step 1: Run the complete TypeScript/Vitest suite**

```bash
corepack pnpm@11.23.0 test
```

Expected: all Vitest files pass with zero failures.

- [ ] **Step 2: Run the Python suite**

```bash
corepack pnpm@11.23.0 test:phase1b-python
```

Expected: all Python tests pass with zero failures.

- [ ] **Step 3: Run the client acceptance flow when the prepared runtime is available**

```bash
corepack pnpm@11.23.0 accept:phase1d:prepare
corepack pnpm@11.23.0 accept:phase1d:execute
```

Expected: the floating entry is found, the end-to-end screen flow completes, host width is unchanged, review is wider than result, and screenshot paths are recorded. If local prerequisites are unavailable, report the exact preparation or runtime blocker rather than claiming acceptance passed.

- [ ] **Step 4: Inspect wide review, wide result, and narrow import screenshots**

Confirm visually:

- collapsed state is a right-edge book spine;
- expanded import/result panels do not feel cramped;
- review grows leftward and preserves all three information regions;
- DSH remains visible and interactive outside the panel;
- narrow viewport uses the full screen without horizontal overflow.

- [ ] **Step 5: Run final repository checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; status contains only intentional implementation changes, or is clean after task commits.
