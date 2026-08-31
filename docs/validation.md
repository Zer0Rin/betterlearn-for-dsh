# 验证说明

## 当前可证明的能力

- Host、Client、Core、契约与产品自有schema可以从本仓库独立构建。
- TypeScript 测试覆盖路由、生命周期、模型快照、生成边界、客户端交互与验收器。
- Python 测试覆盖数据库所有权、状态机、证据定位、幂等审核、恢复和 JSON-RPC。
- 打包产物包含运行时Core、产品SQL、维护CLI与安装说明，不需要原Nobei checkout。
- 默认路径隔离检查使用仓库内空 sentinel，不访问旧正式数据库。

## 开发环境准备与首次运行

首次 checkout 或拉取依赖声明有变化的提交后，先同步依赖，再执行所需验证：

```sh
CI=true corepack pnpm@11.23.0 install --frozen-lockfile
```

`CI=true`仅用于这次安装，允许无交互终端重建过期的`node_modules`；`--frozen-lockfile`禁止安装时改写锁文件。如果提示锁文件与声明不一致，应核对提交内容，不要去掉此参数绕过。依赖已同步时不需要反复重装。

pnpm 11会在运行脚本前检查依赖并可能自动安装，见[官方配置说明](https://pnpm.io/settings#verifydepsbeforerun)。交付后的独立复核曾遇到旧`node_modules`未同步，直接`pnpm test`在依赖准备阶段报`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`，测试尚未开始。复核者报告使用`CI=true`重新执行后完成依赖同步、全量测试通过且锁文件未变。原交付记录漏记了这一环境准备问题；它不是每次首次运行必然失败，也不是测试断言失败。

同步后按需运行`corepack pnpm@11.23.0 test`或`corepack pnpm@11.23.0 test:phase1b-python`。这仅涉及源码开发环境；交付包用户仍按[安装说明](install.md)操作。

## 已完成的真实模型验证

拆分前的 Phase 1E 验证曾在明确授权下使用 DSH 官方 DeepSeek provider 与 `deepseek-v4-flash` 完成 20 次运行：

- 20/20 首轮完成，未使用 retry；
- 总 provider stream 调用 20 次；
- 每轮均产生可审核候选；
- 修订后的 quote-first locator 对同批 133 条冻结输出只读 replay 为 133/133 精确定位。

原始响应、数据库副本与历史 evidence 不进入本仓库。上述结果说明当前闭环已经跑通过，不等于对任意文档、任意模型或生产规模的承诺。

## 重新验收原则

- 普通测试必须使用 fake provider 或冻结输出，真实调用数为零。
- 真实模型批次必须在运行前展示 provider、model、reasoning effort 和最大调用数，并取得明确授权。
- 修改 prompt、Schema、模型或夹具会形成新的验收身份，不能借用旧批次冒充新结果。
- replay 只能证明后处理逻辑在冻结输出上的变化，不能替代新的模型行为验证。

## P1.1 定向验证（2026-08-31）

- `pnpm build` 通过。
- 下列 9 个测试文件共 134/134 通过，真实模型调用为零。

```sh
pnpm exec vitest run \
  test/client-api.test.ts test/client-poll-run.test.ts \
  test/client-workspace-lifecycle.test.tsx test/client-view.test.tsx \
  test/client-run-progress.test.tsx test/client-review-workspace.test.tsx \
  test/generation-coordinator.test.ts test/product-routes.test.ts \
  test/product-plugin.test.ts
```

覆盖：生成成功/失败后的按 run 通知、本地 HTTP SSE 首次连接提示与后续推送、断连及插件卸载清理、等待中唤醒、读取期间提示不丢失且不启动并发轮询、无提示时的原有退避、取消订阅，以及收到通知后进入审核。审核失败页的“重新连接”验证了原幂等键复用且不调用 retryRun。

本次没有重跑 TS/Python 全量测试、DSH 浏览器完整验收或真实模型批次；Python Core、证据定位、审核事务及数据库结构未改动。既有 617/617、463/463 与端到端 GO 属于此前已验证基线，不当作此次新增 SSE 的验收结果。

## P2–P4 最终交付验收（2026-08-31）

上述P1.1记录是当时的单步范围；随后按用户指令完成到P4。达标标准是下表全部必需行为通过、实际失败修复后复验、无未处理功能阻塞。单测数量或旧GO不能单独证明达标。

| 阶段 | 必须通过的行为 | 本次结果 |
| --- | --- | --- |
| P2 | 新11表、原候选不变、三种审核与幂等、精确坐标、读取不重放；实际Host/Client闭环 | GO：真实DSH导入→生成→接受/修改/拒绝→2知识点→刷新恢复 |
| P3 | PDF文字预览、实际L2/L3调用、全文和尾段覆盖、多证据逐字定位、失败原子性和显式重试 | GO：PDF/L2/L3分别2/5/23知识点；80,006字符文档尾段保留；32条保存证据逐字一致；零page error |
| P4 | 新包安装、运行中一致备份与拒绝恢复、重启、恢复全部表、升级保留数据、卸载保留数据 | GO：真实rc.8；全部产品表恢复前后逐项相等；保留含新增知识点的恢复前副本；升级到0.0.1-p4-acceptance后仍可提取；卸载注册消失且数据不变 |

本地原始证据（git忽略，不随安装包分发）：

- P2：`evidence/client/20260831T050008Z/final-result.json`
- P3：`evidence/p3/2026-08-31T05-26-31-713Z/final-result.json`，以及L1/L2/L3截图。
- P4：`evidence/p4/2026-08-31T05-38-01-206Z/final-result.json`，以及命令输出、在线备份和恢复前副本。

最终TS验证执行623项：622项直接通过，1项仍要求运行peer只能rc.7的旧测试更新为历史开发基线后定向通过。Python P3阶段328项覆盖通过（2项旧常量期望更新后定向复验），P4另6项维护测试通过，共334项。未反复重跑已验证的全部基线；修复针对失败路径复验。具体实现、退役测试与复核记录见 `p2-*-report.md`、`p3-*-report.md`、`p4-maintenance-report.md` 和 `final-review.md`。

### 交付后的独立复核

用户转述的DeepSeek独立复核报告确认：交付提交`f6c0672` / `dafde22`的TypeScript全量623/623（57文件、exit 0）、Python全量334/334（exit 0）。这些是复核者重新执行的结果，区别于上面的原始交付执行记录；本次文档补充没有重跑全量测试。复核者检查了P2/P3/P4的GO证据，但没有重新执行P3/P4完整验收，因此不能记作第二次独立端到端GO。

Python测试从463变为334，净减少129项。P2移除了v8双重投影、每次读取的全量重放和foreign-data守卫，相应内部行为测试退役或改写；同时新增了最大正文审核、P3提取和P4维护测试。净差值不等于删除测试总数。证据逐字定位、幂等审核、恢复及所有权等产品行为仍有覆盖，具体取舍见[测试调整记录](p2-tests-report.md)。验收标准按行为判断，不要求为已删除的实现维持旧测试条数。

所有本轮模型调用均由fake provider完成，真实模型调用为0。L2实际4次（上限6），L3实际23次（上限36）；预览、审核、刷新与恢复不产生模型调用。历史付费结果继续封存，不能据此宣称新规划prompt对任意真实材料的语义质量已验证。

支持边界：仅单机单用户macOS/Linux插件；PDF必须有文字层，不提供OCR；TXT/Markdown及解析正文512KiB、PDF文件5MiB；同最终产品schema内升级，不迁移v8或开发期fixture库。依赖安装失败可能需要重试；恢复前必须能成功备份现库，严重损坏到无法读取的现库需人工处理。未做npm发布或远程推送。

复现实跑入口：`scripts/accept-p3.mjs <prepare阶段manifest.json>`；`scripts/accept-p4.mjs <真实DSH rc.8 runtime目录>`。普通用户操作见 [安装说明](install.md)。

## 首次真实试用修复：推理占满输出上限（0.0.1）

2026-08-31，用户手动发起的L2任务使用DeepSeek-V4-Flash / High。只读检查其已有DSH日志确认：规划调用成功；第一批提取的请求上限为8,192 token，返回`outputTokens=8192`、`reasoningTokens=8192`、`finish=max-tokens`，没有结构化答案。DSH workflow仍返回`completed/null`，旧Host将其记录为`GENERATION_NO_OUTPUT`。这是产品沿用短文阶段输出预算的问题，不是原文丢失或API Key错误。

0.0.1将每次请求的输出上限提高到32,768 token（推理与答案共用），保留选定的模型和推理档位，不自动续写或重试。结算时读取本次子任务最后的`turn/end`，将明确的截断记录为`GENERATION_OUTPUT_LIMIT`；界面显示失败原因及“提取已停止”。旧任务的错误码不追溯改写。调用上限增加会提高潜在费用，仍需用户点击提取或重试。

验证：先观察新增回归失败，再修复；TS定向9文件89项、Python状态机与契约54项通过，构建通过。另在隔离的真实rc.8中用fake provider验证了截断失败落库、仅显式重试、第二次失败不可再试、普通提取进入审核；3次fake请求的实际`request/header`均为`maxTokens=32768`。该fake route不提供High档位，模型/High冻结由定向测试覆盖，不能将它算作新预算下的真实High质量验证。

隔离复验记录：`evidence/first-trial-output-limit/final-result.json`。本次修复没有重跑用户的真实请求，也没有调用真实模型。提高上限针对已观察到的截断原因，不保证任意材料在新上限内都能完成；完成质量仍以接下来的实际试用为准。

本机试用安装已通过维护CLI自动备份并升级至0.0.1，随后重启。升级前后全部产品表的内容摘要相同，原任务仍为`failed_retryable`且`retryCount=0`；DSH已有模型请求数保持2次。对照记录为同目录的`before-upgrade.json` / `after-upgrade.json`。没有消耗用户剩余的重试机会。
