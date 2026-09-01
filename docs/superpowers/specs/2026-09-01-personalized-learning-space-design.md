# BetterLearn 个性化学习空间设计

日期：2026-09-01
状态：已完成产品讨论，等待书面规格复核

## 1. 背景

BetterLearn 0.0.5 已经完成“导入资料 → 提取知识点 → 校验证据 → 人工审核 → 保存正式知识点”的闭环。当前正式知识点只有类型、标题、陈述和原文证据，尚不能形成课程路径、学习检测、补救复测、掌握证据或长期复习。

本设计参考 `better-learn-cc` 中对 DeepTutor 的实现拆解，但不复制 DeepTutor 的完整产品或统一 Agent Loop。采用的机制包括：

- Reading 的“定位 → 读取 → 引文验证”证据边界；
- BookEngine 的“路径草案 → 人工确认 → 分单元生成”结构；
- Mastery 的“先登记私有答案 → 等待真实作答 → 判分 → 补救/复测”交易；
- 显式目标、误区、作答、掌握证据与复习调度。

DeepTutor 中仅由提示词维持的教学顺序、同一次调用生成题目和答案、开放题自我判定以及 `READY` 不等于教学质量通过等弱点，不作为 BetterLearn 的产品保证。BetterLearn 把可确定的约束落实到 Python Core 状态机、契约校验、幂等写入与独立评审调用中。

## 2. 目标与范围

### 2.1 本阶段目标

在现有 BetterLearn 插件中增加第一版个性化学习空间：

1. 用户可从一个或多个已确认知识点创建课程；只选择一个时形成单知识点微课。
2. 用户填写学习目标、已有基础和可投入时间，并完成 3–5 道短诊断。
3. 系统结合问卷、诊断和可复用的历史掌握证据生成路径草案。
4. 用户确认或调整路径后，系统冻结一个不可变路径版本。
5. 课程单元按进入顺序生成，不一次生成全部课程。
6. 单元包含讲解、例题、混合题型检测、补救内容和变式复测。
7. 核心目标设置程序化掌握门槛，非核心目标允许跳过。
8. 掌握证据可跨课程继承，并在新课程内通过短测重新校准。
9. 应用内提供“今日复习”队列，不发送系统通知。
10. 学习空间扩展现有悬浮窗，不新增 DSH 页面或独立服务。

### 2.2 本阶段不包含

- 自由形式的长期导师聊天；
- 向量数据库、完整 RAG 或外部网页检索；
- 系统通知、邮件或日历提醒；
- 两个不同知识点之间的自动语义合并；
- 多用户、协作课程或云端同步；
- 扫描 PDF OCR；
- 自动执行模型生成的代码；
- 学习表现触发的静默路径结构改写。

这些能力可在后续阶段分别设计为证据感知导师问答、阅读批注、知识库检索和长期学习记忆，不能扩张本规格的首轮实现范围。

## 3. 已确认的产品决策

- 采用“现有 BetterLearn 架构纵向扩展”，不采用独立学习服务或 DeepTutor 式统一 Agent Loop。
- 课程素材由用户显式选择，可以来自不同提取任务。
- 先生成目标种子和诊断，完成诊断后再生成路径草案。
- 路径必须经过人工确认；确认后结构冻结。
- 单元按需生成，后续单元读取最新掌握状态决定完整、压缩或复核跳过。
- 核心目标必须通过补救和变式复测；非核心目标允许跳过。
- 客观题程序判分，开放题使用结构化 rubric judge。
- 核心结论以所选资料为依据；模型补充背景或类比时必须显式标记为辅助解释。
- 单元经过自动确定性校验和独立模型评审后直接可学，用户保留预览、编辑和重新生成入口。
- 同一学习目标的历史证据可继承，但新课程可以重新校准。
- 长期复习只提供 BetterLearn 内的到期队列。
- 学习模式仍是当前 `document.body` 下的同一悬浮窗。

## 4. 用户体验

### 4.1 悬浮窗双模式

现有浮窗增加两种内部模式：

- `workbench`：保留当前导入、生成、审核、结果和历史界面；
- `learning`：显示课程路径、教学内容、证据/掌握状态和今日复习。

普通模式继续使用现有按工作页面持久化的尺寸。进入学习模式时，浮窗扩展到视口内允许的最大工作尺寸；退出学习模式时恢复进入前的普通尺寸。两个模式仍由同一个 React root 和同一个 Host API 提供，不创建新标签页或新路由宿主。

`workbench` 模式继续跟随当前 DSH 普通会话；课程、掌握状态和今日复习则属于本机 BetterLearn 全局空间，不绑定某个 DSH 会话。用户在 `learning` 模式切换 DSH 会话时，当前课程不被卸载，课程冻结的模型也不改变；返回 `workbench` 模式后再跟随新的 DSH 会话。浏览器只持久化当前打开的课程 ID，这不是业务事实源。

学习模式在空间足够时使用三栏：

```text
课程路径 / 今日复习 | 当前教学单元 | 原文证据 / 掌握状态
```

两侧栏分别有用户开关，并分别持久化。布局规则为：

1. 用户的开关选择优先；
2. 当前宽度不足时，已开启的侧栏降级为覆盖式抽屉；
3. 宽度恢复后，抽屉自动回到固定侧栏；
4. 小屏继续使用现有全屏浮层边界；
5. 历史抽屉与课程路径栏是不同功能，不共用开关状态。

第一版保持现有 `1080px` 最大宽度并在该边界内实现三栏，不改变 DSH 页面布局。空间不足时必须使用抽屉降级，不以提高最大宽度规避响应式设计。

### 4.2 课程创建

结果页和全局知识点选择器提供“创建课程路径”。用户可以选择当前任务的一个或多个知识点，也可以从全局已确认知识点列表跨任务选择。

创建表单只收集以下稳定输入：

- 学习目标；
- 自评基础；
- 每日可投入分钟数；
- 可选课程名称。

提交后 Core 冻结课程素材快照，Host 生成目标种子和 3–5 道诊断题。诊断至多包含一道开放题，以保持首次使用成本和调用上限可预期。诊断结束后才生成个性化路径草案。

### 4.3 路径确认

路径草案显示：

- 单元顺序；
- 每个单元的学习目标；
- 目标对应的知识点和证据；
- 前置依赖；
- 核心/非核心标记；
- 根据诊断建议的完整学习、压缩学习或复核跳过。

用户可以重排单元、调整核心标记和课程名称。确认前 Core 重新校验依赖拓扑、素材覆盖和目标锚点。破坏前置顺序或移除全部核心覆盖的草案不能确认。

确认产生不可变路径版本。以后增加、删除或重排目标时创建新草案和新版本，并再次要求人工确认。学习表现只能改变单元的交付策略，不能静默改写已确认路径。

### 4.4 单元学习

第一次进入尚未生成的单元时，系统显示调用上限并启动生成。通过质量门槛后，学习者看到：

1. 前置知识激活；
2. 简洁讲解；
3. 与资料绑定的例题；
4. 必要的辅助解释标记；
5. 检测题；
6. 失败后才展开的定向补救；
7. 不重复原题表面的变式复测。

核心目标通过后才能进入下一必修核心单元。非核心目标允许跳过，并记录用户跳过事件，不把跳过误记为掌握。

用户编辑已发布单元时创建新的 `draft` 内容版本，不原地覆盖当前 `READY` 版本。编辑界面把学习者可见内容与私有评分材料分区展示。保存时 Core 重新执行结构、目标覆盖、证据锚点和私有材料泄漏校验；用户显式发布后，新版本标记为 `human_edited` 并成为当前版本。人工编辑与发布本身不调用模型；若用户选择“重新生成”，才进入正常 writer/reviewer 流程并产生新的调用账本。

## 5. 总体架构

```text
DSH WebUI
└─ BetterLearn Floating Root
   ├─ workbench 模式
   └─ learning 模式
        ├─ Course Builder
        ├─ Learning Player
        ├─ Evidence / Mastery Panel
        └─ Today Review
             │ /nobei/v1/*
             ▼
BetterLearn Host
├─ 现有提取编排
└─ Learning Generation Coordinator
   ├─ diagnostic seed
   ├─ path planner / repair
   ├─ unit writer / reviewer / repair
   └─ open-answer rubric judge
             │ stdio JSON-RPC
             ▼
Python Core
├─ 现有导入与审核状态机
├─ Course Service
├─ Assessment Service
├─ Mastery Policy
├─ Review Scheduler
└─ 单一 SQLite
```

### 5.1 Client

Client 只持有视图态和临时编辑态。课程、作答、掌握度和复习队列都从 Core 快照恢复。Client 不读取私有答案或 rubric，不自行决定核心目标是否通过。

### 5.2 Host

Host 负责 DSH 模型配置解析、工作流调用、调用账本转发和进度通知。它不保存第二份课程状态，不在内存中累计不可恢复的教学事实。

每门课程冻结创建时的 provider、model 和 reasoning effort。之后切换 DSH 模型只影响新课程；已有课程的路径修复、单元生成、评审和判分都继续使用课程快照。需要换模型时创建新的课程版本或新课程，不能在重试时静默切换。

### 5.3 Python Core

Core 是课程、路径、单元、题目、作答、掌握证据和复习计划的唯一事实源。以下约束必须由程序实现：

- 路径必须是无环依赖图；
- 每个所选知识点至少映射到一个学习目标；
- 每个核心目标至少有讲解、例题、检测、补救和变式复测；
- 每个资料性核心结论引用有效的课程证据锚点；
- 学习者可见 DTO 不含私有答案或 rubric；
- 已展示题目不能在同一作答交易中被替换；
- 核心目标未通过时不能直接标记完成；
- 重复提交、重连和重试保持幂等。

### 5.4 SQLite

继续使用产品自有的同一 SQLite，不引入向量库、第二数据库或外部服务。发布升级必须通过新的 Schema 迁移保留现有 0.0.5 数据；不能要求用户干净重建。

## 6. 课程与学习数据流

### 6.1 创建路径

```text
选择知识点 + 目标问卷
→ Core 冻结知识点/证据/模型快照
→ Host 生成目标种子与诊断
→ Core 校验并登记私有评分材料
→ 学习者真实作答
→ Core 客观判分 / Host 开放题 rubric judge
→ Core 形成诊断基线
→ Host 生成路径草案
→ Core 校验 DAG、目标覆盖与证据锚点
→ 用户调整并确认
→ Core 冻结 CONFIRMED 路径版本
```

### 6.2 生成单元

```text
进入未生成单元
→ Core 创建 generation job 和输入快照
→ Host 独立调用生成教学包
→ Core 契约与锚点校验
→ Host 在隔离上下文中调用独立 reviewer
→ reviewer 通过：Core 发布 READY 版本
→ reviewer 拒绝：一次 repair → 再次 reviewer
→ 再次拒绝：job 失败，不发布半成品
```

“独立 reviewer”表示单独的模型调用和隔离上下文，不表示使用不同 provider 或不同模型。它提升语义检查强度，但不被描述为事实正确性的程序证明。确定性校验负责可证明的结构、锚点、覆盖与泄漏边界。

### 6.3 作答交易

```text
Core 登记 assessment + private key
→ Client 只获取 learner-safe question
→ 学习者提交真实答案
→ Core 原子保存 answer
→ objective: Core 确定性判分
→ open: Host 获取内部 rubric 后调用结构化 judge
→ Core 校验 grade 并追加 mastery evidence
→ passed: 更新掌握与复习时间
→ failed core: 定向补救 → 变式复测
→ failed optional: 允许补救、重试或跳过
```

开放题结构化结果至少包含：

```yaml
concepts_hit: []
reasoning_strengths: []
missing_steps: []
incorrect_claims: []
evidence_errors: []
passed: false
remediation_target: ""
```

## 7. 教学内容契约

### 7.1 学习者可见内容

```yaml
unit_id: stable-id
source_anchors: []
prerequisite_activation: []
learning_objectives: []
misconceptions: []
explanation_blocks: []
worked_examples: []
checks:
  - assessment_id: stable-id
    objective_id: stable-id
    question_type: single_choice | multiple_choice | true_false | short_answer | explanation | application
    learner_prompt: ""
    options: []
remediation_branches: []
retests: []
supplemental_explanations: []
```

`supplemental_explanations` 必须显式标记为模型辅助解释，不能伪装为所选资料中的原始结论。

### 7.2 私有评分内容

```yaml
assessment_id: stable-id
grading_mode: deterministic | rubric_judge
expected_answer: null
normalization_rules: []
rubric: null
distractor_misconceptions: {}
remediation_target: stable-id
retest_assessment_id: stable-id
```

公开与私有内容使用不同存储表、内部类型和 API DTO。禁止依赖前端隐藏字段或 CSS 保护答案。

## 8. 数据模型

新增实体按职责分组如下。实施计划可以补充时间戳、修订号和索引，但不得改变这些实体边界或把它们合并成一个课程 JSON。

### 8.1 课程与素材

- `course_projects`：课程名称、生命周期状态、问卷快照、模型快照、当前路径版本；
- `course_sources`：所选知识点的标题、陈述、类型、内容哈希和来源身份快照；
- `course_source_evidence`：课程级引用片段、上下文、文档哈希和原坐标；
- `diagnostic_sessions`：诊断状态、完成时间和基线结果。

课程素材是冻结副本。后续编辑原知识点不改变现有课程；删除原提取任务后，课程仍能展示冻结引用片段，但不能打开已删除的完整原文。

### 8.2 路径与单元

- `course_path_versions`：版本号、`draft | confirmed | superseded`、确认时间；
- `course_units`：路径版本、顺序、标题、交付策略和单元状态；
- `learning_targets`：来源身份、知识点内容哈希、目标文本、目标指纹、核心标记；
- `target_prerequisites`：目标间有向边；
- `unit_content_versions`：公开教学内容、评审结果、版本状态和发布时间。

全局继承键由“知识点来源身份 + 知识点内容哈希 + 目标指纹”组成。不同知识点即使文字相似也不自动合并；知识点内容被修改后视为新版本，需要重新校准。

### 8.3 测评与掌握

- `assessments`：题面、类型、所属目标、用途（诊断/检测/复测/复习）和公开选项；
- `assessment_private_keys`：期望答案、规范化规则、rubric、误区映射；
- `learning_attempts`：真实答案、状态、结构化评分和错误标签；
- `mastery_evidence`：追加式掌握事件，关联目标、课程、题目和作答；
- `mastery_states`：目标的当前强度、复习阶梯、最近证据和到期时间。

“今日复习”不是第二份队列表，而是对 `mastery_states.due_at` 和状态的查询投影。

### 8.4 生成账本

- `learning_generation_jobs`：`diagnostic | path | path_repair | unit | unit_review | unit_repair | open_grade` 的业务作业；
- `learning_generation_attempts`：请求摘要、provider 幂等键、模型元数据、状态、错误和原始结构化输出。

现有 `generation_attempts` 保持提取任务专用，不强行泛化它的 `run_id` 和两次尝试约束。

## 9. 状态机

### 9.1 课程

```text
DRAFT
→ DIAGNOSTIC_READY
→ DIAGNOSING
→ PATH_REVIEW
→ ACTIVE
→ COMPLETED
→ ARCHIVED
```

具体生成失败记录在 `learning_generation_jobs`，不把一个单元的失败扩大成整个课程失败。已可用的课程和单元继续可读。

### 9.2 单元

```text
UNGENERATED
→ GENERATING
→ REVIEWING
→ READY
→ IN_PROGRESS
→ REMEDIATION
→ MASTERED
```

历史掌握证据经新课程复核通过后，单元可以进入 `CALIBRATED_SKIP`。用户跳过非核心目标时记录 `SKIPPED`，它不等于 `MASTERED`。

### 9.3 作答

```text
PRIVATE_READY
→ PRESENTED
→ ANSWERED
→ GRADING
→ GRADED
```

技术性判分失败保留在 `ANSWERED` 或显式 `GRADING_FAILED`，不产生掌握证据。用户可重试判分，不重新提交答案。

## 10. 掌握与复习策略

第一版采用版本化、确定性的复习阶梯：

```text
首次掌握 → 1 天 → 3 天 → 7 天 → 14 天 → 30 天
```

- 到期复习通过：进入下一阶；
- 到期复习失败：进入补救和变式复测，通过后回到 1 天阶；
- 超过 `due_at`：显示 `REVIEW_DUE`；
- 超过当前间隔的两倍仍未复习：显示 `LAPSED`，新课程不得直接跳过；
- 非核心跳过不创建通过证据；
- 课程完成条件为全部核心目标处于 `MASTERED` 或 `CALIBRATED_SKIP`。

策略以 `mastery_policy_version` 记录。以后调整间隔不能静默改写历史事件。

## 11. API 边界

在现有 `/nobei/v1` 下增加以下资源式路由：

- `GET /nobei/v1/knowledge-points`：分页读取全局已确认知识点；
- `POST /nobei/v1/courses`、`GET /nobei/v1/courses`：创建和列出课程；
- `GET /nobei/v1/courses/:courseId`、`DELETE /nobei/v1/courses/:courseId`：读取和永久删除课程；
- `POST /nobei/v1/courses/:courseId/archive`、`POST /nobei/v1/courses/:courseId/unarchive`：归档和恢复课程；
- `POST /nobei/v1/courses/:courseId/diagnostic/prepare`、`GET /nobei/v1/courses/:courseId/diagnostic`：准备和读取诊断；
- `POST /nobei/v1/assessments/:assessmentId/answers`：幂等提交真实答案；
- `POST /nobei/v1/attempts/:attemptId/retry-grading`：只重试已保存答案的技术性判分；
- `POST /nobei/v1/courses/:courseId/path/generate`：在诊断完成后生成路径草案；
- `PATCH /nobei/v1/path-versions/:pathVersionId`、`POST /nobei/v1/path-versions/:pathVersionId/confirm`：编辑和确认路径；
- `POST /nobei/v1/units/:unitId/generate`、`GET /nobei/v1/units/:unitId`：生成和读取单元；
- `PATCH /nobei/v1/unit-content-versions/:contentVersionId`、`POST /nobei/v1/unit-content-versions/:contentVersionId/publish`：人工编辑和发布新内容版本；
- `GET /nobei/v1/reviews/today`：读取今日复习投影；
- `GET /nobei/v1/mastery/targets/:targetId`：读取目标掌握状态和公开证据摘要。

所有写请求继续使用严格对象解析、资源 ID 格式、幂等键和 `expectedRevision`。Client API 永远不返回 `assessment_private_keys`。Host 获取私有评分材料时使用内部白名单 RPC，不提供对应 Web GET 路由。

## 12. 模型调用与成本边界

### 12.1 课程创建

- 目标种子与诊断：最多 1 次；
- 诊断开放题判分：最多 1 次；
- 路径草案：最多 1 次；
- 无效路径结构修复：最多 1 次。

因此首次路径创建最多 4 次模型调用。若诊断没有开放题或路径无需修复，实际调用更少。

### 12.2 单元生成

- 初稿：1 次；
- 独立评审：1 次；
- 必要修复：最多 1 次；
- 修复后复审：最多 1 次。

每个单元最多 4 次模型调用。预先生成的补救和变式复测不在学习失败时新增模型调用。

### 12.3 作答

- 客观题：0 次模型调用；
- 开放题：每个显式提交最多 1 次 judge 调用；
- 技术失败后的重试是新的、可见的调用，不由刷新或重连自动触发。

路径预览、阅读、证据切换、查看掌握度、今日复习查询、页面刷新和 SSE 重连都不调用模型。每个生成阶段启动前必须显示本阶段最大调用次数；模型已经返回但输出无效时仍可能计费。

## 13. 失败、恢复与删除

- 所有变更以事务写入，并用幂等键和预期版本防止重复提交；
- SSE 只发送变化提示和进度，轮询仍是恢复兜底，不保存第二状态副本；
- 路径修复失败时保留已完成的诊断，允许单独重试路径生成；
- 单元初稿、评审或修复失败时不发布半成品，之前的 `READY` 版本继续可读；
- 两轮评审仍拒绝时，作业进入 `failed_retryable`，由用户显式重试；
- 开放题判分失败时保留真实答案，不更新掌握状态；
- 删除原提取任务时提示哪些课程将失去完整原文入口，但课程素材快照继续存在；
- 课程默认归档；永久删除需要确认，并删除该课程的路径、单元、作答和掌握证据，再从剩余证据事务性重算受影响的 `mastery_states`；
- 第一版没有回收站。

## 14. 安全与隐私

- 资料正文、知识点内容和模型输出均视为不可信输入；
- 生成 Agent 只允许结构化输出，不获得 Bash、文件读写或任意工具权限；
- 模型生成 Markdown 使用安全渲染，不允许任意 HTML/脚本执行；
- 私有答案和 rubric 使用独立存储、内部类型与内部 RPC；
- 日志、错误和 SSE payload 不包含私有答案；
- reviewer 可以读取私有评分材料用于发布前校验，但学习者 Client 不可读取；
- 产品仍保持单机单用户、本地 SQLite 的既有边界。

## 15. 测试与验收

### 15.1 Core 与数据库

- 从当前 Schema 迁移到新版本并保留现有文档、任务和知识点；
- 课程素材快照、删除原任务后的课程可用性；
- DAG 环路、错误前置顺序、缺失目标覆盖和无效锚点拒绝；
- 路径版本不可变和新版本确认；
- 题目公开/私有分离与零泄漏扫描；
- 客观题规范化判分；
- 开放题结构化结果校验；
- 核心门槛、补救、变式复测和非核心跳过；
- 掌握继承键、课程内校准、复习阶梯和确定性时钟；
- 幂等、并发修订冲突和事务回滚；
- 归档、永久删除和掌握状态重算。

### 15.2 Host

- fake provider 覆盖路径、修复、单元、评审、复审和开放题判分调用序列；
- 每个阶段的模型快照和最大调用上限；
- 无效 Schema、错误答案、无证据结论、超时、进程中断和 reviewer 拒绝；
- 判分失败后只重试判分，不重复提交；
- SSE 断开、轮询恢复和插件卸载清理；
- 私有材料不出现在公开路由、日志和事件中。

### 15.3 Client

- 单知识点微课与跨任务多知识点课程创建；
- 问卷、诊断、路径编辑和确认；
- 普通/学习模式切换及普通尺寸恢复；
- 左右侧栏独立开关、尺寸持久化和窄窗抽屉降级；
- 单元生成进度、失败重试和现有 READY 版本回退；
- 客观题、开放题、补救、复测和跳过交互；
- 今日复习与到期状态；
- 刷新、重连和会话切换后的恢复。

### 15.4 端到端验收

至少包含以下固定场景：

1. 一个知识点创建微课并完成核心目标；
2. 从两个不同任务选择知识点，生成无环路径并人工调整；
3. 历史掌握证据触发复核，通过后压缩或跳过单元；
4. 客观题失败进入补救并通过变式复测；
5. 开放题 judge 失败后恢复判分；
6. 单元 reviewer 拒绝、修复、复审后发布；
7. 生成中刷新页面，不产生额外调用；
8. 删除原提取任务后课程仍显示冻结引用；
9. 到期复习失败后重置复习阶梯；
10. 所有公开响应和前端快照都不含私有答案。

普通构建和测试只使用 fake provider。真实模型验收继续保持显式授权、独立调用账本和可封存 evidence，不纳入默认测试命令。

## 16. 发布与迁移

该能力应作为多个可验证实施批次交付，而不是一次性大改：

1. 数据库迁移、领域契约和 Core 状态机；
2. Host 生成/评审/判分编排与 fake provider；
3. 课程创建、诊断和路径确认 UI；
4. 悬浮窗学习模式、单元播放器和响应式侧栏；
5. 掌握度、今日复习、删除/恢复和完整验收；
6. 真实模型受控验收与交付文档更新。

每个批次必须保持现有知识提取闭环可用。安装升级在迁移前继续执行在线备份，迁移失败不得覆盖原数据库。

## 17. 完成标准

当且仅当以下条件同时满足，本阶段才可称为完成：

- 单个或多个知识点都能生成并确认课程路径；
- 单元按需生成且通过确定性校验与隔离 reviewer；
- 学习者提交前无法从任何公开接口获得答案或 rubric；
- 核心目标的失败、补救和变式复测由状态机硬约束；
- 历史掌握证据能够安全继承并在新课程内重新校准；
- 今日复习按照版本化策略稳定产生；
- 普通/学习双模式和两侧栏在现有浮窗内工作；
- 刷新、断线、重复请求和模型失败不会产生重复事实或半成品；
- 现有 0.0.5 数据可迁移且原提取能力无回归；
- 默认自动化测试不发生真实模型调用。
