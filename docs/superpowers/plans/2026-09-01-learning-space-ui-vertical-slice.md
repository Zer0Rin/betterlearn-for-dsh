# Learning Space UI Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable, interactive BetterLearn learning-space UI inside the existing floating workbench so the user can evaluate the real product flow before backend course persistence and model orchestration are added.

**Architecture:** Add a client-only preview model derived from the formal knowledge points already returned by Core. The existing floating React root owns the `workbench | learning` mode and preserves the ordinary workbench size while the learning mode uses the current maximum viewport size. A focused `LearningSpace` component owns path navigation, adaptive sidebars, evidence display, question feedback, remediation, and retest preview state.

**Tech Stack:** React 18, TypeScript 5.9, existing CSS-in-TS bundle, react-test-renderer, Vitest 3.2, esbuild, Playwright.

**Scope relationship:** This is the first independently testable subproject from the approved learning-space specification. It validates the product interaction and floating-window layout. Separate implementation plans will add Core persistence/mastery state and Host model orchestration after the user reviews this runnable slice.

## Global Constraints

- Keep the existing `document.body` floating root; do not add a DSH page or independent service.
- Keep the current maximum workbench width at `1080px`.
- Do not add backend APIs, model calls, SQLite writes, or fake claims of persisted mastery in this vertical slice.
- Mark the UI as an interactive preview and derive all displayed lesson/source content from existing formal knowledge points and evidence.
- Keep public learner content free of hidden answer/rubric fields.
- Preserve existing extraction, review, history, resizing, compact-height, and session-switch behavior.
- Use only existing repository dependencies.

---

### Task 1: Preview Domain Model

**Files:**
- Create: `src/client/learning-preview.ts`
- Test: `test/client-learning-preview.test.ts`

**Interfaces:**
- Consumes: `KnowledgePointSnapshot` from `src/client/types.ts`.
- Produces: `LearningPreviewCourse`, `LearningPreviewUnit`, and `createLearningPreviewCourse(points, sourceText)`.

- [ ] **Step 1: Write the failing tests**

Test that one point creates one unit, multiple points preserve selection order, evidence is copied into the matching unit, the first unit is active, and a missing evidence span produces an explicit source-summary fallback rather than invented quotes.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `corepack pnpm@11.23.0 vitest run test/client-learning-preview.test.ts`

Expected: FAIL because `src/client/learning-preview.ts` does not exist.

- [ ] **Step 3: Implement the preview model**

Define exact types for course progress, unit objective, lesson blocks, evidence, a single-choice check, remediation, and retest. `createLearningPreviewCourse` must use the point title and statement as lesson content, copy the first evidence span when present, use the remaining point titles as path labels, and return stable IDs derived from `knowledgePointId`.

```ts
export interface LearningPreviewCourse {
  courseId: string
  title: string
  units: LearningPreviewUnit[]
}

export function createLearningPreviewCourse(
  points: KnowledgePointSnapshot[], sourceText: string,
): LearningPreviewCourse
```

- [ ] **Step 4: Run the focused test and verify pass**

Run: `corepack pnpm@11.23.0 vitest run test/client-learning-preview.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/learning-preview.ts test/client-learning-preview.test.ts
git commit -m "feat: model learning space preview"
```

### Task 2: Interactive Learning Space

**Files:**
- Create: `src/client/components/LearningSpace.tsx`
- Test: `test/client-learning-space.test.tsx`

**Interfaces:**
- Consumes: `course: LearningPreviewCourse`, `sourceText: string`, `leftOpen`, `rightOpen`, `onLeftOpenChange`, `onRightOpenChange`, and `onExit`.
- Produces: learner-visible course path, lesson view, evidence card, progress summary, question feedback, remediation, and retest interaction.

- [ ] **Step 1: Write the failing component tests**

Cover: rendering the three regions; navigating to another unit; toggling both sidebars; incorrect first answer revealing remediation; retest answer revealing passed feedback; and exit callback.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `corepack pnpm@11.23.0 vitest run test/client-learning-space.test.tsx`

Expected: FAIL because `LearningSpace` does not exist.

- [ ] **Step 3: Implement the component**

Use semantic `nav`, `main`, and `aside` landmarks. Keep answer state local to the selected unit. The preview question must explicitly say it is a UI preview; no answer or score is persisted. Render the original evidence quote and surrounding context only when supplied by the preview model.

```tsx
export interface LearningSpaceProps {
  course: LearningPreviewCourse
  sourceText: string
  leftOpen: boolean
  rightOpen: boolean
  onLeftOpenChange(open: boolean): void
  onRightOpenChange(open: boolean): void
  onExit(): void
}

export declare function LearningSpace(props: LearningSpaceProps): ReactElement
```

- [ ] **Step 4: Run the focused test and verify pass**

Run: `corepack pnpm@11.23.0 vitest run test/client-learning-space.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/components/LearningSpace.tsx test/client-learning-space.test.tsx
git commit -m "feat: add interactive learning space"
```

### Task 3: Floating Workbench Dual Mode

**Files:**
- Create: `src/client/learning-layout.ts`
- Modify: `src/client/floating-workbench.tsx`
- Modify: `src/client/NobeiClientView.tsx`
- Modify: `src/client/components/ResultSummary.tsx`
- Modify: `src/client/workbench-size.ts`
- Test: `test/client-learning-layout.test.ts`
- Test: `test/client-result-summary.test.tsx`
- Test: `test/client-floating-workbench.test.tsx`

**Interfaces:**
- `ResultSummary` adds `onStartLearning(points, sourceText)` and selected-point checkboxes.
- `NobeiWorkspace` forwards `onStartLearning` without owning learning mode.
- `BetterLearnFloatingApp` owns `mode`, preview course snapshot, ordinary size, and sidebar preferences.
- `learning-layout.ts` produces `readLearningLayout(storage)` and `writeLearningLayout(storage, value)` using `betterlearn:learning-layout:v1`.

- [ ] **Step 1: Write failing layout and integration tests**

Assert that formal points are selected by default, the button is disabled with no selection, clicking “进入学习空间” sends only selected points, the floating panel switches to `data-mode="learning"`, uses the viewport-clamped `1080px` width, hides extraction history controls, preserves sidebar preferences, and returns to the previous result size.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `corepack pnpm@11.23.0 vitest run test/client-learning-layout.test.ts test/client-result-summary.test.tsx test/client-floating-workbench.test.tsx`

Expected: FAIL on missing interfaces and behavior.

- [ ] **Step 3: Implement dual-mode wiring**

Keep `WorkbenchScreen` unchanged and do not store learning size in the existing per-screen map. On entry snapshot the current ordinary size, create the course from selected formal points, close history, and set the panel size to `{ width: 1080, height: viewport.height - 32 }` through `clampWorkbenchSize`. On exit restore the snapshot without rewriting the result-size preference.

```tsx
type FloatingMode = 'workbench' | 'learning'

const [mode, setMode] = useState<FloatingMode>('workbench')
const [previewCourse, setPreviewCourse] = useState<LearningPreviewCourse>()
const ordinarySize = useRef<WorkbenchSize>()

function enterLearning(points: KnowledgePointSnapshot[], sourceText: string): void {
  ordinarySize.current = sizeRef.current
  setPreviewCourse(createLearningPreviewCourse(points, sourceText))
  setHistoryOpen(false)
  setSize(clampWorkbenchSize({ width: 1080, height: viewport.height - 32 }, viewport))
  setMode('learning')
}
```

- [ ] **Step 4: Run focused tests and verify pass**

Run the same focused Vitest command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/learning-layout.ts src/client/floating-workbench.tsx src/client/NobeiClientView.tsx src/client/components/ResultSummary.tsx src/client/workbench-size.ts test/client-learning-layout.test.ts test/client-result-summary.test.tsx test/client-floating-workbench.test.tsx
git commit -m "feat: expand floating workbench for learning"
```

### Task 4: Responsive Visual System

**Files:**
- Modify: `src/client/styles.ts`
- Modify: `test/client-styles.test.ts`

**Interfaces:**
- CSS consumes `data-mode`, `data-left-open`, and `data-right-open` attributes from the floating panel and learning-space root.
- At wide sizes, enabled sidebars are fixed columns; below the course thresholds they become overlay drawers.

- [ ] **Step 1: Add failing style contract assertions**

Assert named selectors for the learning shell, path navigation, lesson card, evidence panel, progress rail, responsive drawer container queries, dark mode, and reduced motion.

- [ ] **Step 2: Run the focused style test and verify failure**

Run: `corepack pnpm@11.23.0 vitest run test/client-styles.test.ts`

Expected: FAIL because the learning selectors are absent.

- [ ] **Step 3: Implement the learning visual system**

Reuse the existing BetterLearn blue, evidence amber, accepted green, paper/surface tokens, serif headings, and system body font. Use restrained borders and tonal surfaces; do not introduce gradients, oversized hero copy, or ornamental cards unrelated to learning hierarchy.

```css
.betterlearn-learning { display: grid; grid-template-columns: 230px minmax(0, 1fr) 260px; }
.betterlearn-learning[data-left-open="false"] { grid-template-columns: minmax(0, 1fr) 260px; }
.betterlearn-learning[data-right-open="false"] { grid-template-columns: 230px minmax(0, 1fr); }
@container (max-width: 760px) {
  .betterlearn-learning { grid-template-columns: minmax(0, 1fr); }
  .betterlearn-learning__path, .betterlearn-learning__evidence { position: absolute; }
}
```

- [ ] **Step 4: Run style and client tests**

Run: `corepack pnpm@11.23.0 vitest run test/client-styles.test.ts test/client-learning-space.test.tsx test/client-floating-workbench.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/styles.ts test/client-styles.test.ts
git commit -m "feat: style responsive learning workspace"
```

### Task 5: Runnable Preview and Visual Verification

**Files:**
- Create: `preview/learning-space.tsx`
- Create: `preview/learning-space.html`
- Create: `scripts/build-learning-preview.mjs`
- Modify: `package.json`
- Test: `test/learning-preview-build.test.ts`

**Interfaces:**
- `preview/learning-space.tsx` mounts the production `LearningSpace` with realistic formal knowledge-point fixtures.
- `scripts/build-learning-preview.mjs` bundles the preview to `dist/learning-preview/` using the existing esbuild dependency.
- `package.json` adds `preview:learning:build`.

- [ ] **Step 1: Write the failing build test**

Verify that the package script exists, the preview imports the production component, and the build emits HTML plus JavaScript without changing source files.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `corepack pnpm@11.23.0 vitest run test/learning-preview-build.test.ts`

Expected: FAIL because the preview assets and script do not exist.

- [ ] **Step 3: Implement the preview entry and build**

Use the actual `LearningSpace` component and production CSS. The fixture course must include three units, one exact evidence quote, progress state, an incorrect-answer remediation branch, and a retest interaction. Add a visible “交互预览 · 数据不会保存” label.

```js
await build({
  entryPoints: [join(root, 'preview/learning-space.tsx')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  outfile: join(output, 'learning-space.js'),
})
```

- [ ] **Step 4: Build, serve, and visually inspect**

Run: `corepack pnpm@11.23.0 preview:learning:build`

Expected: `dist/learning-preview/index.html` and bundled JavaScript exist.

Serve the directory on loopback, open it in the Codex browser, capture wide and narrow screenshots with Playwright, and inspect both images for overflow, clipping, inaccessible controls, and drawer behavior.

- [ ] **Step 5: Run repository verification**

Run:

```bash
corepack pnpm@11.23.0 build
corepack pnpm@11.23.0 test
```

Expected: both commands exit 0 and no test makes a real model call.

- [ ] **Step 6: Commit**

```bash
git add preview/learning-space.tsx preview/learning-space.html scripts/build-learning-preview.mjs package.json test/learning-preview-build.test.ts
git commit -m "feat: add runnable learning space preview"
```
