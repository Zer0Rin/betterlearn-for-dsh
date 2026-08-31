# 验证说明

## 当前可证明的能力

- Host、Client、Core、契约与产品自有schema可以从本仓库独立构建。
- TypeScript 测试覆盖路由、生命周期、模型快照、生成边界、客户端交互与验收器。
- Python 测试覆盖数据库所有权、状态机、证据定位、幂等审核、恢复和 JSON-RPC。
- 打包产物包含运行时Core、产品SQL、维护CLI与安装说明，不需要原Nobei checkout。
- 默认路径隔离检查使用仓库内空 sentinel，不访问旧正式数据库。

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

所有本轮模型调用均由fake provider完成，真实模型调用为0。L2实际4次（上限6），L3实际23次（上限36）；预览、审核、刷新与恢复不产生模型调用。历史付费结果继续封存，不能据此宣称新规划prompt对任意真实材料的语义质量已验证。

支持边界：仅单机单用户macOS/Linux插件；PDF必须有文字层，不提供OCR；TXT/Markdown及解析正文512KiB、PDF文件5MiB；同最终产品schema内升级，不迁移v8或开发期fixture库。依赖安装失败可能需要重试；恢复前必须能成功备份现库，严重损坏到无法读取的现库需人工处理。未做npm发布或远程推送。

复现实跑入口：`scripts/accept-p3.mjs <prepare阶段manifest.json>`；`scripts/accept-p4.mjs <真实DSH rc.8 runtime目录>`。普通用户操作见 [安装说明](install.md)。
