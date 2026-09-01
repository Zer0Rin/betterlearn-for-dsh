# BetterLearn 右侧悬浮工作台设计

**日期：** 2026-09-01  
**状态：** 已完成对话设计确认，等待书面规格确认

## 目标

将 BetterLearn 从 DSH 的 `conversation.view` 和 `conversation.input.dock` 排版流中移出，升级为直接挂载到 `document.body` 的右侧悬浮工作台。

升级后必须满足：

- 页面每次加载时默认收起，只显示右侧 BetterLearn 启动按钮；
- 展开与收起不改变 DSH 的栏宽，不推动或挤压 DSH 内容；
- 工作台按当前流程内容自动选择合适尺寸；
- 审核阶段可以向左覆盖大半个 DSH 页面，因为此时 BetterLearn 是用户的主要工作区；
- 整理完成后工作台恢复为较小的辅助窗，允许用户一边查看知识点，一边继续使用 DSH 对话；
- 保留现有导入、生成、证据审核、结果展示、模型选择、重连和会话状态语义。

## 非目标

- 不实现操作系统级独立窗口；
- 不增加拖拽移动或用户自由缩放；
- 不修改 Host API、Python Core、SQLite Schema、模型调用或计费边界；
- 不把悬浮窗做成模态对话框，不加入遮罩或焦点陷阱；
- 不记忆页面刷新前的展开状态，每次加载都从收起态开始。

## 实施取舍

- 优先完成默认收起、点击展开、内容分档尺寸和不挤压 DSH 的主路径；
- 不为没有现实证据的重复挂载、异常 DOM 所有权或浏览器边缘行为增加复杂抽象；
- 首版尺寸是可验收基线，不视为最终视觉定稿；用户实际验收后再依据具体反馈微调宽高和间距；
- 保持文件和组件边界清楚，但不做与悬浮工作台无关的重构。

## 架构

客户端插件启动时调用 `mountFloatingWorkbench(ctx)`：

1. 在 `document.body` 下创建唯一的 `[data-betterlearn-floating-root]` 容器；
2. 使用独立 React root 渲染 `BetterLearnFloatingApp`；
3. 从 `ctx.sessions.list` 订阅 DSH 会话列表与当前选择；
4. 将当前普通会话 id、模型目录服务和会话类型传给现有 BetterLearn 工作台；
5. 插件 dispose 时取消订阅、卸载 React root，并移除容器。

独立 root 使用 DSH 页面已有的 React 18 / ReactDOM 18 运行时。包声明 `react-dom` 对等依赖和开发依赖，客户端构建将 `react-dom/client` 保持为外部模块，避免把第二份 ReactDOM 打入插件 bundle。

客户端不再注册 `conversation.view` 或 `conversation.input.dock`。悬浮根节点完全脱离 DSH 排版流，因此不会占据对话页、输入 dock 或详情栏的空间。

独立 React root 继续复用当前 React 组件和 `useNobeiWorkspace` 状态机，不把界面改写成字符串脚本或两套实现。

## 组件边界

### `mountFloatingWorkbench(ctx)`

- 保证同一页面只有一个 BetterLearn 根节点；
- 创建 React root 并注入客户端依赖；
- 返回幂等清理函数；
- 清理顺序为 React unmount，再删除 DOM 容器；
- 在 `window` 上保存插件自有的 dispose handle；再次挂载前先调用旧 handle，随后创建全新的 owned 容器；
- 不修改 DSH 自有 DOM、body 布局样式或全局鼠标行为。

### `BetterLearnFloatingApp`

- 使用 `useSyncExternalStore` 订阅 `ctx.sessions.list`；
- 读取 `SessionListState.current` 作为当前 BetterLearn 会话；
- 页面初始 `expanded=false`；
- 当前会话切换时，工作台切换到新会话对应的状态；
- 没有当前会话时仍显示启动按钮，展开后显示选择或创建普通会话的说明；
- 子 Agent 会话沿用现有禁止创建 BetterLearn 任务的规则。

### `FloatingWorkbenchShell`

- 收起时渲染固定在视口右侧中央的书脊式按钮；
- 展开时渲染无背景遮罩的非模态面板；
- 标题栏包含产品名、当前材料摘要和收起按钮；
- 点击启动按钮展开，点击收起按钮或按 `Escape` 收起；
- 不拦截面板范围之外的指针事件；
- 根据工作台当前 screen 输出尺寸状态：`empty`、`import`、`processing`、`review` 或 `result`。

### `NobeiWorkspace`

- 保持现有业务状态机和四个主界面；
- 将当前 screen 暴露给悬浮 Shell，用于选择尺寸；
- 继续按 DSH `sessionId` 使用现有 `sessionStorage` 隔离；
- 继续使用相同 Client API、轮询/SSE、模型目录和错误恢复逻辑。

## 尺寸和响应式行为

### 收起态

- 固定在视口右侧中央；
- 目标尺寸约为 `44px × 132px`；
- 使用纵向 BetterLearn 文案和状态提示点；
- 只有按钮自身接收指针事件，其余区域完全穿透。

### 展开态

面板与视口右侧、顶部和底部保持 `16px` 安全距离。宽度按内容分档：

| 状态 | 目标宽度 | 目的 |
| --- | ---: | --- |
| 无会话 | 420px | 只显示引导信息 |
| 导入 | 560px | 容纳文件、粘贴文本和模型说明 |
| 处理 | 520px | 保持进度信息紧凑 |
| 审核 | `min(1080px, 100vw - 32px)` | 容纳候选目录、编辑区和原文证据三栏 |
| 结果 | 600px | 作为 DSH 对话旁的知识点辅助窗 |

- 内容较少时高度跟随内容；
- 最大高度为 `calc(100dvh - 32px)`；
- 达到最大高度后，只允许 BetterLearn 面板内部滚动；
- 审核态扩展时固定右边界，面板向左增长；
- 小于等于 680px 的视口中，面板使用 `inset: 0` 全屏显示；
- 面板尺寸变化使用短促的宽度/高度过渡；`prefers-reduced-motion: reduce` 时禁用可见动画。

## 视觉方向

沿用现有 BetterLearn 的学习工作台语义：

- 纸张：`#F6F8FC`；
- 表面：`#FFFFFF`；
- 墨色：`#172033`；
- 行动蓝：`#315EFB`；
- 证据金：`#D99024`；
- 接受绿：`#2F8F6B`；
- 拒绝红：`#B94A48`。

标题继续使用中文宋体/衬线字体，正文使用系统无衬线字体，数据与状态标签使用等宽字体。新的识别元素是右侧“书脊式”启动按钮；除此之外保持克制，不增加渐变、毛玻璃或装饰性背景。

## 数据流与会话切换

1. `ctx.sessions.list` 提供当前 DSH 会话 id；
2. 当前 id 传入 `NobeiWorkspace`；
3. 工作台继续使用 `sessionKey(sessionId)` 读写该会话的 BetterLearn run；
4. 切换 DSH 会话后，React 以新 `sessionId` 重新绑定工作台；
5. 原会话数据留在其独立 `sessionStorage` 键中，切回时恢复；
6. 当前会话的模型目录继续通过 `ctx.modelDirectories.directoryFor(sessionId)` 获取；
7. Host API 和 Python Core 不感知悬浮窗升级。

展开状态属于页面级 UI 状态，不属于业务任务：切换会话时保持当前展开/收起状态，刷新页面时重置为收起。

## 错误和空状态

- 无当前会话：提示“先在 DSH 创建或选择普通会话”，不发起 BetterLearn 请求；
- 子 Agent 会话：沿用“请在普通会话中使用 BetterLearn”的限制；
- 模型目录加载中、不可路由或不可用：继续使用现有导入页提示和提交禁用规则；
- Core 不可用、导入失败、审核失败：继续在面板内部显示现有可重试信息；
- React 挂载前发现旧 dispose handle：先完整清理旧实例，再创建新实例，不能生成两个启动按钮；
- 插件 dispose：即使 React unmount 抛错，也必须尝试移除 owned DOM 容器。

## 可访问性和交互

- 启动按钮提供明确的 `aria-label` 和 `aria-expanded`；
- 展开面板使用命名清晰的非模态 `aside`；
- 收起按钮可键盘操作；
- `Escape` 仅在面板展开时收起，不阻止 DSH 处理其他按键；
- 不设置焦点陷阱，用户可以在 BetterLearn 与 DSH 之间自由切换；
- 面板外没有遮罩，未覆盖区域继续正常接收 DSH 指针事件；
- 所有现有 `focus-visible` 和深色模式规则继续生效。

## 测试策略

遵循测试先行，覆盖以下行为：

1. 客户端 `apply` 创建一个 body 根节点，不再注册 `conversation.view` 或 `conversation.input.dock`；
2. dispose 会 unmount React root、取消会话订阅并删除根节点；
3. 重复挂载会先 dispose 旧实例，页面始终只有一个启动按钮；
4. `BetterLearnFloatingApp` 默认收起，点击启动按钮展开，按 `Escape` 收起；
5. 空会话展开后显示引导，不调用产品 API；
6. 当前 DSH 会话切换后，组件使用新的 `sessionId` 与 storage key；
7. `import`、`processing`、`review`、`result` 输出对应的尺寸状态；
8. 样式包含 fixed 定位、右侧安全距离、内部滚动、审核大窗、移动端全屏和 reduced-motion；
9. 既有导入、处理、审核、结果和模型目录单测继续通过；
10. 浏览器验收将入口类型从旧 dock/view 更新为 floating，验证收起不改变 DSH 中栏宽、展开覆盖而不挤压、审核自动扩展、结果自动缩小，并生成宽屏与窄屏截图；
11. 完整执行 TypeScript 构建、Vitest、Python 测试和仓库现有验收脚本中与客户端升级相关的检查。

## 完成标准

- 打开 DSH 后只出现右侧收起按钮，DSH 原布局宽度不变；
- 点击按钮可完成现有 BetterLearn 全流程；
- 审核时面板自动扩展，结果时自动缩小；
- 面板外 DSH 可以正常点击、滚动和对话；
- 切换会话不会串用 BetterLearn 任务；
- 刷新页面后重新回到收起态，但各会话任务仍可恢复；
- 插件卸载或热更新后不遗留悬浮 DOM、监听器或订阅；
- 构建、相关单测和浏览器验收通过。
