# 验证说明

## 当前可证明的能力

- Host、Client、Core、契约与固定 v8 迁移可以从本仓库独立构建。
- TypeScript 测试覆盖路由、生命周期、模型快照、生成边界、客户端交互与验收器。
- Python 测试覆盖数据库所有权、状态机、证据定位、幂等审核、恢复和 JSON-RPC。
- 打包产物包含运行时 Core 与固定迁移，不需要原 Nobei checkout。
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
