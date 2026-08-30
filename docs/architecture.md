# BetterLearn for DSH 架构

## 1. 平台形态

BetterLearn 是 DSH 的 Web 客户端插件。DSH CLI 启动本地服务，`dsh-web-app` 与 BetterLearn HTTP 路由由同一个 `ctx.webServer` 提供，用户界面运行在浏览器中。

客户端通过 `dsh.client.platform: web` 加载，并注入 `conversation.view`。Electron 不是插件侧的另一套实现目标。

## 2. 组件职责

### Client

- 显示粘贴导入、任务状态和候选审核界面；
- 从 DSH model directory 读取当前会话的模型选择；
- 只在创建新任务时提交模型选择，不自行保存 DSH 设置；
- 不持有业务数据库。

### Host

- 注册 `/nobei/v1/*` 产品路由；
- 管理常驻 Python Core 的启动、握手、超时与回收；
- 调用 DSH workflow / LLM 接缝；
- 将 Core 已冻结的 provider、model、reasoning effort 安装到生成 Agent；
- 不成为第二业务事实源。

### Python Core

- 持有导入任务状态机与幂等规则；
- 保存任务级模型快照和生成 attempt；
- 校验结构化候选、精确定位证据并执行审核写入；
- 独占自己的 SQLite，并通过 stdio JSON-RPC 暴露白名单方法。

### SQLite

- 当前为 BetterLearn 独立数据文件；
- v8 领域表来自仓库内 `vendor/schema-v8/` 的固定迁移；
- `p1_*` 表承载当前插件的控制状态和生成记录；
- 不自动读取或修改旧项目的 `nobei.db`。

## 3. 关键不变量

1. 新任务使用创建当时的 DSH 模型选择；已有任务重试不随设置变化。
2. 每个生成 attempt 最多进入一次 provider stream；额外调用由 ledger 拒绝。
3. 模型输出只是候选，只有通过 Schema 与证据定位后才能进入审核。
4. 接受、修改、拒绝均由 Core 的事务和幂等键裁决。
5. Host 崩溃后的恢复以 Core 持久状态为准。
6. 构建、单元测试和 replay 不产生真实模型费用。

## 4. 仓库结构

```text
src/                 DSH Host 与 Web Client
python/nobei_core/   Python Core
contracts/           跨语言 JSON Schema
vendor/schema-v8/    独立构建所需的固定基础迁移
acceptance/          fake provider、验收夹具与空数据 sentinel
scripts/             构建、profile 装配、验证与 replay 工具
test/                TypeScript 测试
python/tests/         Python 测试
```

`@nobei/dsh-phase1` 与 `nobei_core` 是当前兼容标识，不代表仓库仍依赖旧 Nobei 应用。
