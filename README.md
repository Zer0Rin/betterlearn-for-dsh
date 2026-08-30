# BetterLearn for DSH

BetterLearn for DSH 是一个独立的 DSH Web 插件项目。DSH 通过 CLI 启动本地服务，用户在浏览器 WebUI 中使用 BetterLearn。

当前版本提供一条可运行的文本学习资料提取链路：

- 在 DSH WebUI 中粘贴 TXT / Markdown 文本；
- 使用 DSH 当前会话选择的模型生成知识点候选；
- 新任务会冻结当时的 provider、model 和 reasoning effort，之后修改 DSH 模型只影响新任务；
- Python Core 对候选证据做精确定位，并维护独立 SQLite 状态；
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
corepack pnpm@11.23.0 install --frozen-lockfile
corepack pnpm@11.23.0 build
corepack pnpm@11.23.0 test
corepack pnpm@11.23.0 test:phase1b-python
```

生成安装包：

```bash
corepack pnpm@11.23.0 pack:acceptance
```

验收脚本会自行创建临时 DSH profile。真实模型验收必须先获得明确的调用次数授权；普通构建和测试不会调用真实模型。

## 数据安全边界

- 默认验证目标是仓库内的空 sentinel 目录，不依赖原 Nobei 仓库。
- v8 基础迁移已随仓库固定在 `vendor/schema-v8/`，构建不再读取兄弟目录。
- 正式数据库、真实 provider 响应和历史 evidence 不随仓库分发。
- 当前插件数据库仍与旧 Nobei 正式数据模型隔离；两者是否合并属于后续产品决策。
