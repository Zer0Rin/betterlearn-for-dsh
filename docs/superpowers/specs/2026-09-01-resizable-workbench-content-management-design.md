# BetterLearn 可调小窗、知识点编辑与任务删除设计

**日期：** 2026-09-01
**状态：** 已完成对话设计确认，等待书面规格确认

## 背景

BetterLearn 已经从 DSH 排版流中移出，成为默认收起、点击后展开的右侧悬浮工作台，并增加了全局提取历史。实际验收表明，结果页当前约 `600px` 的固定宽度仍会遮挡过多 DSH 对话空间；不同用户、视口和工作阶段也需要不同的阅读尺寸。

同时，当前人工审查阶段虽然支持“修改后接受”，但任务完成后只能阅读正式知识点，无法继续修订。历史列表也不能删除不再需要的任务，正在提取的任务缺少“终止并删除”入口。

本次升级把工作台完善为真正可调、可记忆的小窗，并补齐正式知识点编辑与任务生命周期删除。

本设计在窗口尺寸和历史展开行为上取代
`2026-09-01-floating-workbench-design.md` 与
`2026-09-01-global-run-history-design.md` 中对应段落；其余已验收行为继续有效。

## 目标

- 允许用户拖动工作台左边缘、下边缘和左下角调整宽高，右边缘与顶部位置保持固定；
- 为每种工作页面分别记忆用户设置的尺寸，并在刷新、重新展开和再次进入页面时恢复；
- 设置明确的最小与最大尺寸，视口变小时把已保存尺寸钳制在可见区域内；
- 默认结果页明显缩窄，减少对 DSH 对话与输入区域的遮挡；
- 小窗口中同步缩小字体、标题、按钮和间距，正常及大窗口中字体不继续放大；
- 允许用户在提取完成后继续修改正式知识点的标题和陈述，并永久写入 SQLite；
- 允许删除待审查、已完成和失败任务及其全部关联数据；
- 允许在正在提取页面先中止真实模型请求，再删除该任务和全部关联数据。

## 非目标

- 不实现拖动整个窗口改变位置，窗口继续固定在右上区域；
- 不实现知识点类型、原文、证据范围或模型元数据编辑；
- 不实现编辑版本历史、撤销、回收站、批量编辑或批量删除；
- 不在历史列表中直接删除正在提取的任务；
- 不保留“已取消”任务记录；
- 不更改 BetterLearn 默认收起行为；
- 不重新生成知识点，也不因编辑、删除或浏览历史产生模型费用。

## 方案选择

### 采用：自定义 Pointer Events 拖拽手柄

工作台实现三个自有拖拽区域，而不是使用浏览器原生 `resize`：

- 左边缘负责宽度；
- 下边缘负责高度；
- 左下角同时负责宽高；
- 拖动期间禁用尺寸过渡并使用 pointer capture；
- 拖动结束后保存最终尺寸。

该方案借鉴余额插件中“固定锚点、尺寸变化后重新钳制到视口、持久化用户尺寸”的思路，但不沿用其大小滑块。原生 CSS `resize` 难以稳定提供左侧手柄与右边锚定；滑块或尺寸档位又不符合普通窗口交互，因此不采用。

## 窗口尺寸模型

### 默认尺寸

没有对应页面的已保存尺寸时，使用第一版基线：

| 页面 | 默认宽度 | 默认高度 | 目的 |
| --- | ---: | ---: | --- |
| 无会话 | 420px | 内容高度 | 简短引导 |
| 导入 | 500px | `min(720px, 100dvh - 32px)` | 保留材料输入空间但减少遮挡 |
| 处理中 | 460px | `min(620px, 100dvh - 32px)` | 紧凑展示进度 |
| 审核 | 900px | `100dvh - 32px` | 审核仍是 BetterLearn 主工作区 |
| 结果 | 460px | `min(720px, 100dvh - 32px)` | 作为 DSH 对话旁的辅助阅读窗 |

这些数值是可验收基线，后续按真实 DSH 页面反馈微调。

### 边界

- 桌面端最小宽度 `360px`，最小高度 `420px`；
- 最大宽度不超过 `min(1080px, 100vw - 32px)`；
- 最大高度不超过 `100dvh - 32px`；
- 工作台保持 `top: 16px`、`right: 16px`；
- 当视口本身不足以满足桌面最小值时，沿用现有窄屏全屏规则；
- 浏览器窗口变化时只钳制当前呈现尺寸，不覆盖原始已保存值。视口恢复后，允许恢复用户原尺寸。

### 分页面记忆

尺寸写入 `localStorage` 的版本化 BetterLearn 专用键，按 `empty`、`import`、`processing`、`review`、`result` 分别保存 `{ width, height }`。

这样用户缩小结果阅读窗后，下一次打开结果页仍保持小窗；审核页则继续使用自己的较宽尺寸。展开/收起状态与历史栏状态不保存，页面加载后 BetterLearn 和历史栏仍默认收起。

### 自动尺寸与手动尺寸

- 对某页面从未手动调整时，继续使用该页面默认尺寸；
- 用户首次拖动后，该页面改用已保存尺寸；
- 切换页面时恢复目标页面自己的尺寸；
- 拖动期间不触发 screen 默认尺寸过渡；
- 不新增“重置尺寸”按钮，首版保持交互简单。

## 小窗口内容缩放

工作台主内容使用容器宽度断点，而不是按整个浏览器宽度判断：

- 正常宽度使用当前字体与控件尺寸，缩放上限为 `1`；
- 内容区低于约 `480px` 时，正文、标题、按钮、输入框和间距进入紧凑档；
- 内容区低于约 `400px` 时进一步缩小，但保持可点击与可编辑；
- 知识点陈述正常换行，纵向溢出由工作台内部滚动承接；
- 字体不会随窗口放大而超过当前正常字号，大窗口只增加排版空间。

实现使用容器查询和 CSS 自定义变量分别控制字号、间距和控件尺寸，不对整个 DOM 使用 `transform: scale()`，以免产生模糊文字、错误点击坐标或滚动尺寸。

## 历史栏与可调窗口

- 历史栏继续默认收起；
- 历史展开不再强制给整个窗口额外增加固定宽度；
- 在默认窄结果窗中，历史作为窗口内部抽屉覆盖主内容，选择任务或主动收起后返回内容；
- 用户把窗口拉宽到足够容纳双栏时，历史可以与主内容并排；
- 历史栏宽度设置合理上限，不能把主内容压缩到最小可读宽度以下；
- 手动尺寸记录的是整个工作台尺寸，不因历史临时展开而改变。

这使默认结果页保持窄小，也保留类似 Codex / ChatGPT 的可收缩历史入口。

## 完成后编辑知识点

### 客户端交互

结果页每个知识点卡片增加“修改”按钮：

1. 点击后在原卡片内把标题与陈述切换为输入控件；
2. 显示“保存”和“取消”；
3. 标题限制 `1..120` 字符，陈述限制 `1..2000` 字符，沿用现有审查编辑边界；
4. 保存期间只禁用当前卡片操作；
5. 成功后用 Core 返回值替换当前知识点与任务统计；
6. 失败时保留用户输入并显示卡片内错误；
7. 取消恢复保存前内容。

知识点类型和证据继续只读。

### Client / Host API

`ClientApi` 新增：

```ts
updateKnowledgePoint(
  knowledgePointId: string,
  input: { title: string; statement: string },
  signal?: AbortSignal,
): Promise<{ knowledgePoint: KnowledgePointSnapshot; run: RunSnapshot }>
```

Host 新增：

```text
PATCH /nobei/v1/knowledge-points/:knowledgePointId
```

请求体只接受 `title` 和 `statement`，成功返回更新后的知识点与任务快照。

### Core RPC 与事务

Core 新增闭合 RPC `knowledge_points.update`。在单一写事务中：

1. 验证知识点存在并找到对应 candidate、review 与 run；
2. 只允许编辑已形成正式知识点的已完成任务；
3. 更新 `knowledge_points.title`、`statement`、`content_hash` 和 `updated_at`；
4. 同步更新 `candidate_reviews.final_title`、`final_statement`；
5. 原 review 为 `accept` 时改成 `edited_and_accept`，`runs.edited_candidate_count` 增加一；
6. 原 review 已是 `edited_and_accept` 时只替换最终文本，不重复增加计数；
7. 更新 run 的 `revision` 与 `updated_at`；
8. 返回重新读取的知识点与 run 快照。

`accepted_candidate_count` 表示正式知识点总数，保持不变。结果页现有“已接受”值由总接受数减去已修改数得到，因此首次完成后编辑会自然从“已接受”转为“已修改”。原始 candidate 内容保持不可变，继续代表模型最初提案。

## 删除任务

### 历史列表交互

- `review_pending`、`completed`、`failed_retryable`、`failed_terminal` 条目提供删除入口；
- `created`、`document_ready`、`awaiting_generation`、`generating`、`validating` 条目不在历史列表显示删除入口；
- 点击删除后显示一次明确确认，确认文案包含材料名称；
- 删除成功后立即刷新历史；
- 若删除当前任务，清除当前 DSH 会话的 run 指针并进入新建提取页；
- 删除失败时保留条目和当前工作区，并显示错误。

### 正在提取页面

处理中页面增加“终止并删除”：

1. 用户确认；
2. Host 找到该 run 对应的活跃生成 flight；
3. 标记 flight 不再进入正常 finalize，取消 AbortSignal 与 provider handle，清理流和计时器；
4. 等待该 flight 结束其资源清理；
5. 调用 Core 删除任务；
6. 客户端收到成功结果后清空本会话 run 指针并回到导入页。

终止成功后不调用 `runs.fail_generation`，也不保留失败或取消状态记录。若 flight 已经进入 finalize，Host 先等待 finalize 结束，再删除，避免 Core 写入与删除并发。

### Client / Host API

`ClientApi` 新增：

```ts
deleteRun(runId: string, signal?: AbortSignal): Promise<{ runId: string; deleted: true }>
```

Host 新增：

```text
DELETE /nobei/v1/runs/:runId
```

同一接口服务历史删除和处理中“终止并删除”。是否需要取消 provider 由 Host 的 GenerationCoordinator 根据真实活跃 flight 判断，不能由客户端声明。

### Core RPC 与 SQLite 事务

Core 新增闭合 RPC `runs.delete`。事务中：

1. 验证 run 存在；
2. 读取其 `document_id` 和关联 candidate / knowledge point；
3. 从现有 `candidate_review` 幂等结果中识别并删除属于这些 candidate 的记录，避免删除任务后残留其序列化内容；
4. 删除引用知识点的 `candidate_reviews`，解除现有 `ON DELETE RESTRICT`；
5. 删除该 document，由既有外键级联清除 run、attempt、candidate、candidate evidence、knowledge point、knowledge point evidence 与 run event；
6. 返回 `{ runId, deleted: true }`。

现有 `idempotency_records` 没有 `run_id` 外键。删除逻辑在同一事务中读取闭合的 review result JSON，以其中的 `candidateId` 与本任务 candidate 集合精确匹配，不修改 Schema，也不触碰其他任务的幂等记录。

当前产品每次导入创建独立 document 与单一 run，因此删除任务同时删除原文符合用户确认的语义。本次不为假设中的多 run 共用 document 增加额外分支。

## 状态同步

- 知识点编辑成功后更新当前 `run`、`knowledgePoints` 与历史刷新触发值；
- 删除成功后清理当前任务的轮询、SSE、事件、候选、知识点和 sessionStorage 指针；
- 删除非当前历史任务时保持当前工作区不变，只移除历史条目；
- “终止并删除”期间按钮显示忙碌状态，避免重复提交；
- 所有操作继续使用 Core SQLite 作为真相源，客户端不做只存在内存中的假编辑或假删除。

## 错误处理

- 非法知识点内容：Host 返回 `400 REQUEST_INPUT_INVALID`；
- 知识点或任务不存在：沿用 `INVALID_IDENTIFIER` 映射；
- 非完成任务尝试编辑知识点：返回状态冲突；
- 删除时 Core 不可用：不移除客户端数据，允许用户重试；
- provider 取消失败但资源清理已完成：GenerationCoordinator 仍以自身 flight 生命周期为准，不能在后台继续 finalize；
- 用户切换任务或收起窗口不会自动删除或取消任务。

不增加编辑版本恢复、软删除、后台重试队列等防御性机制。

## 测试策略

### Python Core

- 首次编辑 accepted 知识点会更新正文、hash、review 最终文本、run revision 与“已修改”计数；
- 再次编辑同一知识点不会重复增加“已修改”计数；
- 编辑非完成任务、无效 id 或越界内容失败且事务不产生部分写入；
- 删除每种允许展示的任务后，document、run、attempt、candidate、review、知识点、证据、事件和对应幂等结果均消失；
- 删除不存在任务返回闭合错误；
- 故障注入验证知识点编辑和任务删除原子回滚。

### TypeScript Host

- PATCH / DELETE 路由、输入验证和 Core 错误映射；
- Core RPC Client 发出精确的 `knowledge_points.update` 与 `runs.delete` 请求；
- GenerationCoordinator 取消 active flight 后不 submit、不 fail，并只清理一次；
- finalize 已开始时删除等待其结束；
- 删除非活跃任务不触碰 provider。

### React Client

- 三个拖拽手柄调整正确轴，保持 top/right 锚点；
- 最小、最大钳制和按 screen 的 localStorage 恢复；
- 小窗口进入紧凑字体档，大窗口字体不超过正常档；
- 默认结果页使用窄尺寸，审核页保持宽尺寸；
- 默认窄窗的历史以内层抽屉展示，宽窗使用双栏；
- 完成知识点的修改、保存、取消、校验、忙碌和错误状态；
- 历史条目的删除可见性、确认、成功刷新和当前任务重置；
- 处理中“终止并删除”成功后返回导入页。

### 浏览器验收

在不调用模型的前提下使用现有 SQLite 任务：

- 截图对比默认结果窗与 DSH 可交互区域；
- 实际拖动三个手柄并刷新页面验证尺寸恢复；
- 验证小窗字体缩小、正常宽度停止放大；
- 修改一条已有知识点，重新打开任务确认持久化；
- 创建测试副本或使用专用 fixture 验证删除，不破坏用户现有材料；
- 活跃任务终止行为使用 fake provider 自动化验证，不为浏览器验收产生模型费用。

## 完成标准

- BetterLearn 仍默认收起，展开不改变 DSH 原布局；
- 结果页默认明显比当前截图更窄，用户仍可拉大阅读；
- 三个指定方向可稳定调整尺寸，限制与分页面记忆有效；
- 小窗口内容同步缩小且可读，大窗口字体不膨胀；
- 已完成知识点可编辑并在数据库中持久保存，统计语义一致；
- 非活跃历史任务可以完整删除；
- 正在提取的任务只能从处理页终止并删除，provider 不再产生结果；
- TypeScript、Python、客户端构建和相关浏览器验收全部通过；
- 用户可以在真实 DSH 页面继续给出尺寸细节反馈。
