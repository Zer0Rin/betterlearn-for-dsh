# BetterLearn Compact Workbench Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the BetterLearn side window shrink to `300 × 340px` while keeping text at least `13px` and replacing secondary information with a readable summary layout.

**Architecture:** The existing pure size model continues to own all pointer and viewport clamping, with only its desktop lower bounds changing. The React markup exposes stable classes for secondary metadata, and CSS container queries at `340px` switch the interface into summary mode without changing the font below `13px`.

**Tech Stack:** React 18, TypeScript 5.9, CSS container queries, Vitest 3, react-test-renderer.

## Global Constraints

- Desktop minimum size is `300 × 340px`.
- Base text stops shrinking at `13px`.
- Default sizes and maximum sizes remain unchanged.
- Summary mode hides only duplicated or explanatory metadata; primary input, progress, review, editing, termination, errors, and navigation remain available.
- BetterLearn remains collapsed by default and anchored at the upper-right.

---

## File Map

- Modify `src/client/workbench-size.ts`: lower the desktop width and height clamps.
- Modify `test/client-workbench-size.test.ts`: assert the new bounds and unchanged viewport behavior.
- Modify `src/client/NobeiClientView.tsx`: mark shared heading and model metadata for summary-mode hiding.
- Modify `src/client/components/ResultSummary.tsx`: mark duplicated result metadata for summary-mode hiding.
- Modify `test/client-result-summary.test.tsx`: assert core knowledge content remains separate from secondary metadata.
- Modify `src/client/floating-workbench.tsx`: expose a compact-height state from the actual user size.
- Modify `test/client-floating-workbench.test.tsx`: assert compact-height state follows resizing.
- Modify `src/client/styles.ts`: add the `340px` summary-mode container query and compact vertical spacing.
- Modify `test/client-styles.test.ts`: assert font floor and summary selectors.

### Task 1: Lower the Workbench Size Boundary

**Files:**
- Modify: `test/client-workbench-size.test.ts`
- Modify: `src/client/workbench-size.ts`

**Interfaces:**
- Consumes: `clampWorkbenchSize(size: WorkbenchSize, viewport: ViewportSize): WorkbenchSize`.
- Produces: the same API with desktop minimums `300px` wide and `340px` high.

- [ ] **Step 1: Change the size test to require the new lower bound**

```ts
test('clamps both axes to compact desktop bounds', () => {
  expect(clampWorkbenchSize({ width: 10, height: 9 }, { width: 800, height: 600 }))
    .toEqual({ width: 300, height: 340 })
  expect(clampWorkbenchSize({ width: 5000, height: 5000 }, { width: 800, height: 600 }))
    .toEqual({ width: 768, height: 568 })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `corepack pnpm@11.23.0 vitest run test/client-workbench-size.test.ts`

Expected: FAIL because the implementation still returns `360 × 420px`.

- [ ] **Step 3: Implement the new lower bound**

```ts
return {
  width: Math.min(maxWidth, Math.max(Math.min(300, maxWidth), Math.round(size.width))),
  height: Math.min(maxHeight, Math.max(Math.min(340, maxHeight), Math.round(size.height))),
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `corepack pnpm@11.23.0 vitest run test/client-workbench-size.test.ts`

Expected: all tests PASS.

### Task 2: Expose Summary-Mode Content Layers

**Files:**
- Modify: `test/client-result-summary.test.tsx`
- Modify: `src/client/NobeiClientView.tsx`
- Modify: `src/client/components/ResultSummary.tsx`

**Interfaces:**
- Consumes: existing `NobeiWorkspace` and `ResultSummary` markup.
- Produces: `.nobei-client__masthead-intro`, `.nobei-client__active-model`, and `.nobei-client__result-meta` hooks; knowledge-point cards and editor markup remain unchanged.

- [ ] **Step 1: Add a failing markup contract test**

Add to the first result-summary test:

```ts
expect(renderer.root.findByProps({ 'data-testid': 'nobei-result-meta' })).toBeDefined()
expect(renderer.root.findByProps({ 'data-testid': 'nobei-knowledge-list' })).toBeDefined()
```

- [ ] **Step 2: Run the result test and verify RED**

Run: `corepack pnpm@11.23.0 vitest run test/client-result-summary.test.tsx`

Expected: FAIL because those test IDs do not exist.

- [ ] **Step 3: Mark the secondary and primary regions**

Wrap the result header and counts in the stable secondary hook while keeping the knowledge list outside it:

```tsx
<div className="nobei-client__result-meta" data-testid="nobei-result-meta">
  <header>{/* existing result heading */}</header>
  {!zeroCandidates && <dl className="nobei-client__result-counts">{/* existing counts */}</dl>}
</div>
<div className="nobei-client__knowledge-list" data-testid="nobei-knowledge-list">
```

On the shared header, add `.nobei-client__masthead-intro` to the brand/title container and `.nobei-client__active-model` to the active-model paragraph. Keep `.nobei-client__source-identity` visible.

- [ ] **Step 4: Run the result test and verify GREEN**

Run: `corepack pnpm@11.23.0 vitest run test/client-result-summary.test.tsx test/client-view.test.tsx`

Expected: all tests PASS.

### Task 3: Expose Compact Height and Add the Extreme-Compact CSS Mode

**Files:**
- Modify: `test/client-floating-workbench.test.tsx`
- Modify: `src/client/floating-workbench.tsx`
- Modify: `test/client-styles.test.ts`
- Modify: `src/client/styles.ts`

**Interfaces:**
- Consumes: the Task 2 CSS hooks and existing `@container (max-width: 400px)` rule.
- Produces: `data-compact-height="true"` at `420px` or shorter and an `@container (max-width: 340px)` summary rule that never lowers `.nobei-client` below `13px`.

- [ ] **Step 1: Add failing CSS contract assertions**

```ts
expect(renderer.root.findByProps({ 'data-testid': 'betterlearn-floating-panel' })
  .props['data-compact-height']).toBe('true')
expect(CLIENT_CSS).toContain('@container (max-width: 340px)')
expect(CLIENT_CSS).toContain('.nobei-client__masthead-intro, .nobei-client__active-model, .nobei-client__result-meta { display: none; }')
expect(CLIENT_CSS).toContain('.betterlearn-floating-panel[data-compact-height="true"] .nobei-client__masthead')
expect(CLIENT_CSS.match(/\.nobei-client \{[^}]*font-size: (\d+)px/g)?.every(rule => !/font-size: (?:[0-9]|1[0-2])px/.test(rule))).toBe(true)
```

- [ ] **Step 2: Run the style test and verify RED**

Run: `corepack pnpm@11.23.0 vitest run test/client-styles.test.ts`

Expected: FAIL because the compact-height attribute, `340px` rule, and visibility hooks are absent.

- [ ] **Step 3: Implement summary-mode CSS**

Expose the actual height on the panel:

```tsx
data-compact-height={size.height <= 420 ? 'true' : 'false'}
```

Add:

```css
@container (max-width: 340px) {
  .nobei-client { padding: 9px; font-size: 13px; line-height: 1.5; }
  .nobei-client__masthead { margin-block-end: 10px; padding-block-end: 9px; }
  .nobei-client__masthead-intro, .nobei-client__active-model, .nobei-client__result-meta { display: none; }
  .nobei-client__source-identity { font-size: 0.75rem; }
  .nobei-client__import, .nobei-client__progress, .nobei-client__result { padding: 11px 9px; }
  .nobei-client__knowledge-list { gap: 7px; }
  .nobei-client__knowledge-list article { padding: 10px 9px; }
  .nobei-client__knowledge-heading { gap: 7px; }
  .nobei-client__knowledge-heading button { padding: 5px 7px; }
}
.betterlearn-floating-panel[data-compact-height="true"] .nobei-client__masthead {
  margin-block-end: 10px;
  padding-block-end: 9px;
}
.betterlearn-floating-panel[data-compact-height="true"] .nobei-client__import,
.betterlearn-floating-panel[data-compact-height="true"] .nobei-client__progress,
.betterlearn-floating-panel[data-compact-height="true"] .nobei-client__result { padding-block: 11px; }
```

Retain the existing `400px` rule at `13px`; do not add any smaller font declaration.

- [ ] **Step 4: Run the focused client tests and verify GREEN**

Run: `corepack pnpm@11.23.0 vitest run test/client-workbench-size.test.ts test/client-result-summary.test.tsx test/client-view.test.tsx test/client-styles.test.ts test/client-floating-workbench.test.tsx`

Expected: all tests PASS.

### Task 4: Verify the Integrated Build

**Files:**
- No production file changes expected.

**Interfaces:**
- Consumes: the completed compact size model and responsive markup/CSS.
- Produces: evidence that the client build and regression suite remain healthy.

- [ ] **Step 1: Run TypeScript and client build**

Run: `corepack pnpm@11.23.0 build`

Expected: exit code `0`.

- [ ] **Step 2: Run the complete TypeScript suite**

Run: `corepack pnpm@11.23.0 vitest run`

Expected: all tests PASS.

- [ ] **Step 3: Inspect the diff**

Run: `git diff --check && git diff --stat && git status --short`

Expected: no whitespace errors; only planned files plus pre-existing `.superpowers/` are present.

- [ ] **Step 4: Commit the implementation**

```bash
git add src/client/workbench-size.ts src/client/NobeiClientView.tsx \
  src/client/components/ResultSummary.tsx src/client/floating-workbench.tsx src/client/styles.ts \
  test/client-workbench-size.test.ts test/client-result-summary.test.tsx \
  test/client-floating-workbench.test.tsx test/client-styles.test.ts \
  docs/superpowers/plans/2026-09-01-compact-workbench-summary.md
git commit -m "feat: add compact BetterLearn summary mode"
```
