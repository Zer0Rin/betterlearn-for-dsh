# BetterLearn for DSH

BetterLearn for DSH 是一个独立的 DSH Web 插件项目。DSH 通过 CLI 启动本地服务，用户在浏览器 WebUI 中使用 BetterLearn。

当前版本提供一条可运行的文本学习资料提取链路：

- 在 DSH WebUI 中粘贴 TXT / Markdown，或导入有文字层的 PDF；
- 使用 DSH 当前会话选择的模型生成知识点候选；
- 新任务会冻结当时的 provider、model 和 reasoning effort，之后修改 DSH 模型只影响新任务；
- 短文直接提取，长文按 L2/L3 规划与分批提取，点击前显示调用上限；
- Python Core 对多条候选证据做逐字定位，统一文档绝对坐标，并维护独立 SQLite 状态；
- 用户可以审核、修改、接受或拒绝候选；
- Host 负责 DSH 集成和 Core 生命周期，业务事实仍由 Core 持有。

## 项目边界

这个仓库只保留当前 DSH 插件主线所需的代码、契约、测试、确定性夹具和验收工具，不包含：

- 原 Nobei 书架、学习与 FSRS 应用；
- 已废弃的 Claude Code sidecar 路线；
- 企业产品化旧批次计划；
- 历史运行 evidence、真实模型原始响应或旧数据库；
- `node_modules`、虚拟环境和构建产物。

内部 npm 包名与 Python 模块名暂时保留 `@nobei/dsh-phase1` / `nobei_core`，用于避免一次与功能无关的大范围重命名。独立产品与仓库名称是 `betterlearn-for-dsh`。

## 架构

```text
DSH CLI
  └─ DSH WebUI（conversation.view）
       └─ BetterLearn Client
            └─ /nobei/v1/*
                 └─ BetterLearn Host
                      └─ stdio JSON-RPC
                           └─ Python Core
                                └─ 独立 SQLite
```

详细边界见 [架构说明](docs/architecture.md)，当前验证范围见 [验证说明](docs/validation.md)，后续工作见 [路线图](docs/roadmap.md)。

## 开发

当前依赖基线为 DSH `0.1.0-rc.7`、Node.js 24、pnpm 11.23 和 Python 3.12。

```bash
CI=true corepack pnpm@11.23.0 install --frozen-lockfile
corepack pnpm@11.23.0 build
corepack pnpm@11.23.0 test
corepack pnpm@11.23.0 test:phase1b-python
```

首次checkout或依赖声明变化后先执行安装。`CI=true`仅作用于安装命令，允许无交互终端同步旧`node_modules`；锁文件仍由`--frozen-lockfile`保持不变。否则直接测试可能在依赖准备阶段遇到`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`，详见[首次运行说明](docs/validation.md#开发环境准备与首次运行)。

生成安装包：

```bash
corepack pnpm@11.23.0 pack:acceptance
```

验收脚本会自行创建临时 DSH profile。历史真实模型验证已封存；当前交付验收只使用 fake provider，普通构建和测试不会调用真实模型。

## 数据安全边界

- 默认验证目标是仓库内的空 sentinel 目录，不依赖原 Nobei 仓库。
- 仅使用产品自有的 11 张表；新库使用 `python/nobei_core/sql/001_product.sql`，不继承或迁移旧 v8 数据。
- 正式数据库、真实 provider 响应和历史 evidence 不随仓库分发。
- 当前插件数据库与旧 Nobei 数据始终隔离；不设计合并或自动删除旧数据。

## 使用与交付

安装、启动、升级、备份恢复及保留数据卸载见 [安装说明](docs/install.md)。当前为单机单用户本地插件；PDF只解析文字层，不提供OCR，保存规范化正文而不是原PDF。TXT/Markdown与PDF解析正文上限512KiB，PDF文件上限5MiB。

验收要求与分阶段结果见 [交付验收](docs/delivery-plan.md)。P2/P3开发期的旧fixture库不作为升级源；首次交付从最终产品schema的空目录开始，之后同schema升级保留数据。

## 许可证

BetterLearn for DSH 采用 [MIT License](LICENSE) 开源。当前发布渠道仍是维护CLI安装预构建tarball；公开Git仓库用于查看、审计和协作，不承诺通过Git源码或npm registry直接安装。

## Model Experience

### 规划与候选提取

#### What the model sees

用户开始提取时，Host通过DSH的`ctx.llm.resolveCallConfig`解析模型配置，由Core冻结provider、model与reasoning effort。实际生成由`workflowEngine`执行`agent(prompt, { schema })`，每次规划或提取创建独立的父/子Agent；配置解析本身不是一次候选生成。切换DSH模型只影响新任务，已有任务重试仍沿用冻结的选择。

插件显式提供两类输入：规划请求包含当前容器各块的ID和正文，要求按顺序完整分组；提取请求包含当前正文范围、逐字引用证据的规则，以及`structured_output`候选Schema。L1直接提供全文，L2/L3逐组提供正文，L3另有边界范围提取。PDF先在本地解析为规范化文字，不把原PDF或页面图像交给模型。插件不主动拼接其他批次的回答或用户聊天记录；最终请求仍由DSH组装其系统上下文和工具说明。

当前新任务的`l1-v3`提示词要求选择主要且不重复的知识点、遵守字段数量和长度限制，并原样复制quote。兼容DSH所需的Schema转换会把其不支持的数量/长度关键字写进字段description；返回后仍由完整契约校验。提取Agent只允许`structured_output`，不能执行bash、读写文件或其他工具。具体请求构造见 [generation-adapter.ts](src/product/generation-adapter.ts)，字段约束见 [候选契约](contracts/l1-candidate.schema.json)。

#### Token effect

L1每次提取最多1次模型调用；L2/L3包含规划和分批提取，界面预览的`maxCalls`是整个计划的上限，不是已发起次数或最终提取批数。实际分组决定调用数量，失败时可能提前停止。规划与提取会重复发送相应正文，L3重叠容器和边界也会产生重复输入；字符分块预算不是精确token估算。路由与上限计算见 [P3提取契约](docs/p3-extraction-contract.md)。

每次生成请求设置`maxTokens=32768`，推理与结构化答案共用该输出预算；这不是承诺用满的数量，也不是费用上限。材料长度、批次、模型和推理档位都会影响实际用量。模型已返回但格式或证据未通过校验时，已发生的调用仍可能收费。格式错误或无效规划导致整个attempt失败时，不保存此前批次的候选；证据定位阶段则决定哪些候选及证据可以进入审核。仅用户显式“重新提取”才重跑整个计划，不续接此前成功批次。正文预览、审核、SSE进度、轮询、页面刷新及重新连接不发起提取调用。

#### KV Cache effect

各次规划/提取是独立请求，插件不维护或复用跨批次的模型KV缓存，不把前批上下文累计到下一批。相同提示词和工具定义可能形成可复用的请求前缀，但正文、任务提示词版本、Schema说明或宿主上下文变化会改变请求内容；规划和提取也不是同一份前缀。缓存是否命中、可复用长度以及计费由DSH实际组装的请求和provider决定，不能承诺缓存命中或固定节省比例。

## Known Limitations and Deferred Work

- 当前只支持单机单用户macOS/Linux上的DSH Web插件，安装需维护CLI完成Python与数据目录初始化；预构建tarball是当前交付渠道，不承诺npm包名或Git源码直接安装。公开仓库采用MIT许可证，但源码公开不改变已经验收的安装路径。
- `conversation.view`注册的是独立标签页，不覆盖其他视图；但随包的patch会修改专用profile中的工具、重试和workflow设置。不要把它直接叠加到日常编码profile；具体影响见 [专用profile限制](docs/install.md#专用-profile-的能力范围)。
- PDF只支持文字层，无OCR；证据定位针对保存的规范化正文，不保证原PDF版面坐标。正文上限512KiB、PDF文件上限5MiB；不保存原PDF。
- 每次提取调用最多20条候选，长文按多批汇总；精确quote匹配不等于知识点语义正确或覆盖完整，仍需人工审核。fake验收和有限真实试用不代表任意模型、任意材料的质量保证，已验证范围见 [验证说明](docs/validation.md)。
- 配置由维护CLI提供，Host导出Schemastery `Config`供Cordis加载与更新时校验。Python路径、数据目录与ownership token均属于本机安装，保持必填，不生成通用默认值。客户端通过`inject.hooks`订阅模型目录；尚未提供插件设置卡片。
