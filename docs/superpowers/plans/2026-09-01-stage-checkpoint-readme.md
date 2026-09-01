# Stage Checkpoint README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the current BetterLearn learning-space milestone in the repository README and publish the documentation to GitHub.

**Architecture:** Keep the change documentation-only. Add one concise milestone section near the README introduction, then extend the existing capability, usage, and verification lists so the new learning-book flow is described where readers already look for product behavior.

**Tech Stack:** Markdown, Git, pnpm repository validation

## Global Constraints

- Keep package version `0.0.5` unchanged.
- Do not create a Git tag or GitHub Release.
- Do not modify functional source code, the actual database, or local installation data.
- Preserve the existing untracked `.superpowers/` directory.
- Push the documentation commit to the existing `origin/main` branch.

---

### Task 1: Record the current learning milestone

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the current implemented learning-book behavior on `main`
- Produces: a README that accurately describes the current stage, user flow, data behavior, and verification totals

- [ ] **Step 1: Add the milestone summary after the introduction**

Insert this section before `## 它能做什么`:

```markdown
## 当前阶段版本

BetterLearn 已完成从“资料提取”到“持续学习”的第一版闭环。产品现在提供两个主要入口：在“知识点”中提取和整理内容，在“学习空间”中通过学习书进入具体学习。

当前阶段已经支持：默认全选审核通过的知识点并整理为新学习书；从学习书继续学习并保存课程进度、答题记录和掌握度；在管理模式中修改或删除学习书。尚未开始的学习书可直接修改，已经开始学习的书会保存为新版本，以保留原书和原进度。删除操作需要二次确认，并同时清理对应课程、答题记录和掌握度。

该阶段仍使用包版本 `0.0.5`，作为阶段性完成记录，不代表正式稳定版发布。当前仓库全量验证结果为 TypeScript 790 项、Python 393 项通过。
```

- [ ] **Step 2: Extend the capability list**

Add these bullets after the existing candidate-review capability:

```markdown
- 默认全选审核通过的知识点，也允许用户自行取消或重新选择，再整理为新的学习书；
- 通过“学习空间”管理学习书、进入具体课程，并持续保存进度、答题记录和掌握度；
- 修改尚未开始的学习书，或为已经开始的学习书保存一个不影响原进度的新版本；
- 二次确认后删除学习书及其课程、答题记录和掌握度；
```

- [ ] **Step 3: Extend the first-use flow**

Insert these steps after the current knowledge-point editing step and renumber later steps:

```markdown
7. 默认选中全部知识点；按需取消不想加入的内容，然后点击“整理为学习书”并填写学习书名称。
8. 从“学习空间”打开学习书进入具体学习；需要整理书架时点击“管理”，可修改或删除学习书。
```

- [ ] **Step 4: Extend installation verification**

Add these checks before the existing refresh/reconnection check:

```markdown
- 审核完成的知识点默认全部勾选，也可以逐项调整后创建一本文字标题可编辑的新学习书；
- 学习空间可打开学习书继续课程，并显示进度与掌握度；
- 管理模式可修改和删除学习书；修改已开始的书会生成新版本，删除前会明确提示相关学习记录也会被清理；
```

- [ ] **Step 5: Validate the Markdown change**

Run:

```bash
git diff --check
rg -n "当前阶段版本|整理为学习书|管理模式|790|393" README.md
pnpm build
```

Expected: `git diff --check` prints nothing, all five concepts are found in `README.md`, and `pnpm build` exits with code 0.

- [ ] **Step 6: Commit the README update**

```bash
git add README.md docs/superpowers/plans/2026-09-01-stage-checkpoint-readme.md
git commit -m "docs: record current learning milestone"
```

Expected: one documentation commit is created without adding `.superpowers/`.

### Task 2: Publish the checkpoint to GitHub

**Files:**
- Modify: none

**Interfaces:**
- Consumes: the committed README milestone on local `main`
- Produces: the same commit available on `origin/main`

- [ ] **Step 1: Check local and remote branch state**

```bash
git status --short
git branch --show-current
git fetch origin main
git rev-list --left-right --count origin/main...main
```

Expected: only the pre-existing `.superpowers/` path is untracked, the branch is `main`, and the divergence check shows no unreviewed remote-only commit.

- [ ] **Step 2: Push the documentation commits**

```bash
git push origin main
```

Expected: Git reports that `main` was updated on `https://github.com/Zer0Rin/betterlearn-for-dsh.git`.

- [ ] **Step 3: Verify the remote commit**

```bash
git rev-parse HEAD
git ls-remote origin refs/heads/main
```

Expected: the two commit hashes are identical.
