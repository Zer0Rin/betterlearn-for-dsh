# BetterLearn for DSH 架构

## 1. 平台形态

BetterLearn 是 DSH 的 Web 客户端插件。DSH CLI 启动本地服务，`dsh-web-app` 与 BetterLearn HTTP 路由由同一个 `ctx.webServer` 提供，用户界面运行在浏览器中。

客户端通过 `dsh.client.platform: web` 加载，并注入 `conversation.view`。Electron 不是插件侧的另一套实现目标。

`conversation.view`是列表槽；BetterLearn注册`id: nobei`的独立标签页，`order: 50`只控制排序。空会话通过`conversation.input.dock`提供导入入口。选择完整视图是为了容纳导入、原文证据与逐条审核，不是向聊天事件流新增业务行，也不覆盖其他标签。当前共存边界来自bundle patch对专用profile的宿主设置覆盖，详见[安装说明](install.md#专用-profile-的能力范围)；尚未承诺在日常编码profile中与任意其他bundle共用。

## 2. 组件职责

### Client

- 预览文本/PDF及实际提取计划、调用上限，显示任务状态和候选审核界面；
- 从 DSH model directory 读取当前会话的模型选择；
- 只在创建新任务时提交模型选择，不自行保存 DSH 设置；
- 不持有业务数据库。

模型目录服务只在槽位的`inject`组装处使用：`hooks.modelDirectory`由DSH转换为`useModelDirectory`，组件接收快照及加载/读取回调，不直接订阅服务。菜单切换即时更新新任务的模型显示；点击提取时通过回调读取最新快照，避免尚未重绘时提交旧选择。任务恢复与轮询仍只跟随会话/任务，目录更新不重新生成已有任务。

### Host

- 注册 `/nobei/v1/*` 产品路由；
- 管理常驻 Python Core 的启动、握手、超时与回收；
- 调用 DSH workflow / LLM 接缝；
- 将 Core 已冻结的 provider、model、reasoning effort 安装到生成 Agent；
- 不成为第二业务事实源。

Host从包入口导出Schemastery `Config`，Cordis加载和配置更新、直接调用`applyProductPlugin`使用同一份规则，替代原手写校验；有效值与原有拒绝范围不变。`pythonExecutable`、`dataRoot`、`ownershipToken`均由维护CLI提供且必填，没有可跨安装复用的默认路径或token。Schema不等于设置界面，本次没有新增设置卡片或配置项。

### Python Core

- 持有导入任务状态机与幂等规则；
- 保存任务级模型快照和生成 attempt；
- 校验结构化候选、精确定位证据并执行审核写入；
- 独占自己的 SQLite，并通过 stdio JSON-RPC 暴露白名单方法。

### SQLite

- 当前为 BetterLearn 独立数据文件；
- 11 张产品自有表，正文存 documents，没有 import_jobs 双投影或单块 chunks；
- 原候选与审核决策分开，知识点证据统一文档绝对 Unicode 字符坐标；
- 写事务维护计数和追加事件，读快照不重放历史或重新定位；
- 不自动读取或修改旧项目的 `nobei.db`。

## 3. 关键不变量

1. 新任务使用创建当时的 DSH 模型选择；已有任务重试不随设置变化。
2. L1 每 attempt 一次提取；L2/L3 按显式计划串行规划与提取，点击前显示最多调用数；运行时不使用历史 provider-ledger。
3. 模型输出只是候选，只有通过 Schema 与证据定位后才能进入审核。
4. 接受、修改、拒绝均由 Core 的事务和幂等键裁决。
5. Host 崩溃后的恢复以 Core 持久状态为准。
6. 构建、单元测试和 replay 不产生真实模型费用。

模型配置解析与生成是两个步骤：`DshModelSelectionResolver`调用`ctx.llm.resolveCallConfig`解析选择；`StructuredGenerationAdapter`通过`workflowEngine`创建独立子Agent执行规划或提取，而非自行直连provider的流接口。插件提供的prompt、Schema、调用成本与缓存边界见[Model Experience](../README.md#model-experience)。

## 4. 仓库结构

```text
src/                 DSH Host 与 Web Client
python/nobei_core/   Python Core
contracts/           跨语言 JSON Schema
python/nobei_core/sql/ 产品schema（干净重建，不迁移旧v8）
acceptance/          fake provider、验收夹具与空数据 sentinel
scripts/             构建、profile 装配、验证与 replay 工具
test/                TypeScript 测试
python/tests/         Python 测试
```

`@nobei/dsh-phase1` 与 `nobei_core` 是当前兼容标识，不代表仓库仍依赖旧 Nobei 应用。

## 5. P1.1 状态通知

`GET /nobei/v1/runs/:runId/stream` 提供 SSE。连接建立时及 GenerationCoordinator 完成生成收尾后发送 `run.changed`，内容仅为 `{}`。通知不携带快照或事件游标，不读取 Core，也不保存或重放事件；连接时的提示覆盖“生成已结束，浏览器才订阅”的情况。

Client 仍只有一个 pollRun 读取循环：提示打断等待，读取既有 run/events 接口；读取期间收到提示则紧接着再读一次，不并发启动第二个循环。业务状态与事件游标仍取自 Core。后台页面沿用可见性暂停，回到前台再同步。

SSE 不可用或断开时关闭该连接，原有 1→2→4→8 秒轮询继续；不因通知通道故障显示生成失败。重新加载/恢复任务会重新订阅。进入审核、完成或失败状态，以及取消、切换任务、插件卸载时释放连接和监听器。Core 读取失败仍走现有“重新连接”恢复流程，不自动发起模型重试。

0.0.3补充瞬时生成进度：Host在当前GenerationHandle内保存规划/提取/校验阶段、已完成批数、总批数和最近响应时间。L1为1批；L2规划完成后确定总数；L3在所有容器规划完成前总数为null，最终包括边界提取。只有通过格式校验的提取批次计入完成数，规划调用不算提取批次。

最近响应时间仅来自本次owned child的`session/event`中`assistant/chunk`的时间，不通过定时器伪造响应。每个chunk更新内存，首次响应立即通知，连续响应通知最多每秒一次，阶段变化立即通知。`run.progress`与连接时的进度快照通过原SSE发送，不唤醒Core轮询；`GET /runs/:runId/progress`只读同一份内存，为刷新与轮询兜底。迟到的GET不能覆盖更新的SSE，退出当前任务后忽略旧通知；终态清除进度。没有活动生成时返回null，Host重启不恢复这份瞬时显示。该信息不进入SQLite、不改变RunSnapshot，也不增加模型调用或持久事件。

文案约定集中于 `src/client/workspace-copy.ts`：连接失败只说明“暂时无法连接”，不承诺服务正在恢复；“重新连接”读取已有进度并按原幂等键恢复待提交审核，不调用模型；“重新提取”使用任务创建时的模型重跑计划，并显示调用上限；不可重试只陈述任务已终止，不把原因归咎于材料。终态按钮为“返回导入”，不承诺自动回填正文。

## 6. P3 输入与提取

`POST /nobei/v1/documents/preview` 转发只读Core方法。PDF逐页解析规范化文字并返回页的正文范围；文本直接规范化。预览不创建任务或调用模型，正文与调用计划一起供用户确认。扫描件、加密或损坏PDF明确报错。

6000字符以内L1；24000以内L2；更大文档L3。物理块至多4000字符，L2由模型规划连续组，L3使用至多6块的重叠容器并提取边界。详情见 [P3提取契约](p3-extraction-contract.md)。Host只在全部调用完成后提交批次；Core按每个来源范围逐字定位，转换绝对坐标，按同type/title/statement合并证据。单次候选Schema保持不变，汇总最多1000候选、每候选64条不同证据，超限失败，不静默截断。

Client任务恢复只随会话/存储生命周期发生，不随DSH模型目录对象刷新重放旧任务。显示证据时按Unicode字符切片；只滚动原文区域。候选目录与插件面板有各自滚动范围，容器宽度决定审核列布局。

## 7. P4 维护边界

CLI管理专用DSH profile、Python环境和插件安装，不增加后台服务。SQLite在线backup支持运行中一致备份；restore仅在显式维护时校验所选备份并持已有CoreLease，先保存当前库，再恢复。正常业务读写不会因此增加检查。卸载不删除数据库或备份。
