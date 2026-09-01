# BetterLearn DSH 历史对话导入设计

**日期：** 2026-09-01
**状态：** 已获用户确认，进入实施

## 背景

BetterLearn 当前只接受 TXT、Markdown、PDF 或粘贴文本。用户在 DSH 普通对话中已经围绕某一主题进行过长篇问答，复习时希望主动选择一个或多个相关对话，把其中真正可见的问答合并成一个 BetterLearn 提取任务。

DSH 的会话日志还包含 system prompt、reasoning、工具调用、工具结果、插件注入上下文、统计和内部 Agent 事件。它们可能在 DSH 的详情界面中可见，但不是用户要复习的问答正文，不能进入提取材料。

## 已确认的产品决策

- 用户选择完整的 DSH 普通对话，不选择单条消息或消息区间；
- 可以多选，所选对话被合并为一个提取任务并统一去重、审核；
- 只导入真人用户消息和 DSH 模型回答中的可见文本；
- 排除 system prompt、reasoning、工具调用与结果、插件注入内容、上下文、统计、事件和子 Agent 内容；
- 保留现有单任务 512 KiB UTF-8 上限，超限时要求减少选择，不截断；
- 采用独立的对话选择步骤，而不是把长列表塞进现有文件/粘贴页签；
- 提取前必须展示完整合并预览；
- 使用 DSH 官方 Host 侧 `ctx.sessionQuery` 读取历史，不解析 DSH SQLite/JSONL，也不切换当前 DSH 会话；
- 首版以可运行结果为主，不增加消息级选择、编辑、标签、收藏或高级筛选。

## 用户流程

1. BetterLearn 导入首页显示“从 DSH 对话提取”入口，并继续保留文件和粘贴入口。
2. 用户进入独立选择页，从 DSH 当前可见的普通对话列表中按标题搜索并多选。
3. 点击“查看合并预览”后，Host 只读加载所选会话，执行来源与内容块白名单过滤。
4. 客户端展示完整规范文本、对话数、消息数、字符数、UTF-8 字节数和现有提取计划。
5. 用户确认后点击“开始提取”。Host 重新读取相同会话并校验预览指纹。
6. 指纹一致时读取当前 DSH 模型配置，创建一个 BetterLearn 提取任务。
7. 后续继续复用现有进度、候选审核、证据定位、正式知识点和全局历史。

模型调用只发生在第 6 步。选择、读取、过滤和预览不调用模型。

## 会话选择范围

客户端以 DSH `ctx.sessions.list` 为列表事实源：

- 包含当前会话和 DSH 列表中可见的历史普通对话；
- 只显示 `blank === false` 的会话；
- 排除 `origin === 'subagent'` 的会话；
- 排除能被 `subagentAddress(id)` 解析为子 Agent 的会话；
- 不主动打开、切换或恢复任何被选择的会话；
- 标题搜索只在客户端对 `displayTitle` 做大小写不敏感的字面包含匹配；
- 列表按 DSH 已提供的顺序展示，每行显示标题和更新时间；首版不为了轮数或摘要加载完整日志。

请求允许 1–50 个互不重复的 session id。Host 仍以读取到的 `SessionHeader.origin` 做普通会话校验，不能只信任客户端筛选。

## Host 读取与白名单规范化

新增单一职责模块 `src/product/dsh-conversation-source.ts`。它依赖 `SessionQueryEngine`，负责读取、校验、规范化和生成内容指纹，不依赖 HTTP、React、Core RPC 或生成协调器。

### 会话读取

对每个 session id 调用 `ctx.sessionQuery.readSession(sessionId)`。该 API 返回经过 DSH 回放校验的完整脱离日志，不使会话进入 live store，也不改变当前会话。

多选会话按 `SessionHeader.createdAt` 从旧到新合并；创建时间相同则按请求中的选择顺序稳定排序。每个会话内部严格保持原始 event seq 顺序。

标题使用日志中最后一个 `session/title`；缺少标题时使用“未命名对话 N”。标题只用于结构与显示，不参与消息来源判定。

### 唯一允许进入材料的消息

逐个检查原始事件，只接受 `isAppendSurfaceEvent(event)` 为真的 append-origin surface 事件。这样既保留用户实际看过的历史，又不会把 compaction replacement 当成第二份新对话。

对 `deriveEventMessage(event)` 的结果应用闭合白名单：

1. 用户消息必须同时满足 `message.role === 'user'` 和 `message.source.kind === 'user'`；
2. DSH 回答必须同时满足 `message.role === 'assistant'` 和 `message.source.kind === 'model'`；
3. 两类消息都只读取 `content` 中 `type === 'text'` 的块；
4. 多个 text block 按原顺序以换行连接；统一 CRLF/CR 为 LF，去掉整条消息首尾空白；
5. 过滤后为空的消息不进入材料。

因此以下内容无论是否能在 DSH 详情界面看到，都不会进入材料：

- `request/header` 中的 system prompt、工具 schema 和模型配置；
- `reasoning`、`tool-call`、`tool-result`、图片及未知 content block；
- `message.source.kind === 'plugin'` 的 AGENTS、skill、文件通知、定时任务等注入内容；
- tool source 的用户角色消息；
- raw chunks、turn/step 边界、todo、usage、错误和其它日志事件；
- surface replacement 事件；
- 子 Agent 会话的全部内容。

这是结构化白名单，不使用“system prompt”等关键词猜测或删除正文。

### 规范文本

每个会话至少有一条合格消息，否则整个预览以 `DSH_CONVERSATION_EMPTY` 失败，不静默忽略。格式为：

```markdown
# DSH 对话合集

## 对话：BetterLearn 架构复盘

### 用户

历史对话如何接入？

### DSH

可以通过 sessionQuery 读取……
```

每条消息都带角色标题，相邻会话用一个 Markdown 分隔线区分。正文随后由现有 Core 再做统一换行规范化，证据坐标以最终保存的规范文本为准。

## 预览一致性

Host 对规范文本的 UTF-8 字节计算 SHA-256，作为 `contentDigest`。预览响应返回完整文本和 digest，但正式导入请求不回传文本，只提交原 session id 列表、`expectedDigest` 和当前模型选择。

导入时 Host 使用同一模块重新读取并规范化：

- digest 相同：把这次重新读取到的规范文本交给现有生成协调器；
- digest 不同：返回 `409 DSH_CONVERSATION_CHANGED`，客户端保留选择并要求重新预览；
- 读取完成后即使用已构建的不可变文本创建任务，之后发生的新消息不进入本次任务。

这避免客户端篡改文本，也避免用户确认的预览与实际提取材料不一致。

## 来源持久化

DSH 对话合集仍进入现有 `documents → runs → candidates → knowledge_points` 图，不新增数据库表或迁移。

为在现有 `documents.media_type` 字段中持久区分来源，新增内部媒体类型：

```text
application/vnd.betterlearn.dsh-conversation+markdown
```

约束如下：

- 只允许 Host 对话导入操作构造；现有公开文件/粘贴导入接口不接受该媒体类型；
- Core 的文档规范化、预览和生成路径把它作为 Markdown 文本处理；
- 文件名为 `DSH对话合集-<首个标题>-等N个.md`，单个对话省略“等N个”，并经过既有文件名限制所需的替换与截断；
- `runs.list` 对该媒体类型返回 `sourceType: 'dsh_conversation'`，其他材料继续返回 `sourceType: 'document'`；
- 历史列表沿用 `sourceLabel` 展示生成的合集名称。

首版不单独保存源 session id，也不提供从 BetterLearn 历史反向打开 DSH 对话的链接。最终规范文本、标题分节和证据足以支撑本次复习与审查目标。

## HTTP 与客户端契约

### 预览

```text
POST /nobei/v1/dsh-conversations/preview
```

请求：

```ts
interface DshConversationSelectionRequest {
  sessionIds: string[] // 1–50，非空且互不重复
}
```

响应：

```ts
interface DshConversationPreview {
  sessionIds: string[]
  filename: string
  mediaType: 'application/vnd.betterlearn.dsh-conversation+markdown'
  text: string
  contentDigest: string
  conversationCount: number
  messageCount: number
  byteSize: number
  characterCount: number
  extractionPlan: {
    strategy: 'L1' | 'L2' | 'L3'
    maxCalls: number
  }
}
```

Host 规范化后调用既有 Core `documents.preview` 取得提取计划，再组合闭合响应。文本超过 512 KiB 时不返回截断预览，而是返回容量错误。

### 导入

```text
POST /nobei/v1/dsh-conversations/imports
```

请求：

```ts
interface DshConversationImportRequest {
  sessionIds: string[]
  expectedDigest: string // 64 位小写十六进制 SHA-256
  modelSelection: ModelSelectionSnapshot
}
```

成功继续返回现有 `GenerationLaunch` 和 HTTP 202。模型选择校验、并发限制、生成失败、重试和取消语义全部复用现有导入路径。

两个新接口继续使用既有 loopback、Origin、Host 与 Fetch Metadata 请求安全规则、JSON 大小限制和 `cache-control: no-store`。

## 客户端组件

### `ImportWorkspace`

导入首页增加三个来源入口：

- 从 DSH 对话提取；
- 上传文件；
- 粘贴正文。

文件与粘贴的既有行为保持不变。选择 DSH 对话时进入独立组件，不在当前窄输入面板中内嵌完整历史列表。

### `DshConversationSelector`

职责：

- 显示普通非空会话；
- 标题搜索；
- 多选与已选数量；
- 空状态；
- 提交预览请求；
- 读取失败后保留选择并允许重试。

当当前 DSH 会话切换或会话列表刷新时，仍存在的选择保留，消失的 id 从选择中移除。选择器不调用 `sessions.open()`。

### `DshConversationPreview`

职责：

- 以只读 `<pre>`/等价安全文本容器展示完整规范文本；
- 显示对话数、消息数、字符数、字节数、512 KiB 上限和提取计划；
- 提供“返回修改选择”和“开始提取”；
- 内容变化冲突后禁用旧预览的提交，提示重新预览；
- 提交期间防重复点击。

React 以文本节点渲染内容，不注入 HTML。

### 工作区协调

`useNobeiWorkspace` 新增对话导入命令，继续复用当前模型目录读取、pending import 去重、run 指针持久化和轮询启动逻辑。成功后和普通文本导入一样进入 `processing`。

## 错误处理

| 条件 | HTTP / 错误码 | 客户端行为 |
| --- | --- | --- |
| session id 数量、重复、格式或 digest 非法 | 400 `REQUEST_INPUT_INVALID` | 保留选择，提示输入无效 |
| 目标不存在 | 404 `DSH_CONVERSATION_NOT_FOUND` | 标出列表已变化并刷新 |
| 目标是子 Agent | 400 `DSH_CONVERSATION_NOT_ORDINARY` | 不导入并刷新列表 |
| 没有合格的问答文本 | 400 `DSH_CONVERSATION_EMPTY` | 提示该对话没有可提取问答 |
| 合并文本超过 512 KiB | 400 `DSH_CONVERSATION_TOO_LARGE` | 显示实际大小并要求减少选择 |
| 任一会话损坏或读取失败 | 503 `DSH_CONVERSATION_READ_FAILED` | 整批失败、可重试，不静默漏会话 |
| 预览后内容变化 | 409 `DSH_CONVERSATION_CHANGED` | 保留选择并强制重新预览 |
| sessionQuery 未挂载 | 插件不启动 | DSH 明确报告依赖缺失，不降级解析存储 |
| Core 不可用或模型不可路由 | 复用现有错误 | 复用现有服务/模型提示 |

请求取消不产生任务；已经成功返回 `GenerationLaunch` 的导入沿用现有后台生成语义。

## 依赖与兼容性

- Host 插件新增必需注入 `sessionQuery`；
- 新增对 `@deepseek-ai/dsh-session-query`、`@deepseek-ai/dsh-session-title` 和消息/表层辅助 API 所属 DSH 包的对等依赖与开发依赖；
- 继续支持项目当前声明的 DSH `0.1.0-rc.7 || 0.1.0-rc.8`，实现只使用两版共同的公开 API；
- 默认 DSH Web App 已挂载 `session-query-sqlite`，BetterLearn 不安装或配置另一套会话持久化；
- 不读取 DSH 原始数据库路径、JSONL 或私有浏览器 DOM。

## 测试策略

### Host 规范化单元测试

- 多个会话按创建时间和 event seq 稳定合并；
- 只保留 user source 的用户消息和 model source 的 assistant 文本；
- 排除 system header、reasoning、tool call、tool result、plugin 注入、图片、unknown block、replacement 和子 Agent；
- 多 text block 顺序、换行规范化、空文本、Unicode 与 Markdown 原文保持正确；
- digest、文件名、消息数、字节数和 512 KiB 边界正确；
- 任一会话失败时整批失败。

### Route 与插件测试

- 新路由严格匹配 method、path、闭合 JSON、数量、唯一性和 digest；
- 预览不调用模型，只调用 sessionQuery 与 Core preview；
- 导入重读并在 digest 相同后只启动一次生成；
- digest 变化返回 409 且零模型调用；
- `sessionQuery` 是必需注入，默认插件操作正确接线；
- 请求安全和错误公开映射保持闭合。

### 客户端测试

- 只列普通非空会话，不显示子 Agent；
- 搜索、多选、会话列表刷新和独立选择页；
- 必经预览、完整安全文本渲染、容量/计划展示；
- 返回修改、失败重试、变化冲突、忙碌状态；
- 成功导入后进入现有 processing，并刷新 BetterLearn 历史；
- 文件和粘贴导入不回归。

### 全量验证

- TypeScript Host 与 Client 构建；
- Vitest 全套测试；
- Python Core 全套测试；
- 打包检查确认新增 DSH 依赖与客户端 bundle 边界；
- 真实 DSH 浏览器验收：选择两个普通历史对话，确认预览没有 system prompt/reasoning/tool 内容，完成一次提取并检查证据标题分节。

普通自动化测试不调用真实模型；真实模型调用只在用户明确进行浏览器验收时发生。

## 验收标准

- 用户能在 BetterLearn 中搜索并多选 DSH 普通对话；
- 选择器不会切换 DSH 当前会话；
- 预览完整展示最终材料，并明确显示容量与调用计划；
- system prompt、reasoning、工具及插件注入内容不会进入预览、数据库或模型请求；
- 多个相关对话只创建一个 BetterLearn run；
- 超过 512 KiB 时不截断、不创建任务；
- 预览后变化必须重新确认；
- 候选、证据、审核、正式知识点、历史、编辑和删除继续复用现有行为；
- 文件上传与粘贴流程保持兼容。

## 非目标

- 单条消息、轮次或时间范围选择；
- 在预览中编辑、删除或重排消息；
- 导入图片、system prompt、reasoning、工具输入输出或子 Agent；
- 自动同步后来新增的消息；
- 保存源 session id、反向打开 DSH 会话或增量重新导入；
- 对话标签、收藏、向量搜索、语义搜索或自动推荐；
- 绕过 512 KiB 上限或把超限内容自动拆成多个任务；
- 解析 DSH 私有数据库、JSONL 或页面 DOM。
