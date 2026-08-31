# P3 提取接缝

实施前约定，P2 通过后启用。旧 Nobei 的应用、RAG、课程、复习和企业验证机制不纳入本插件。

## 输入

- TXT/Markdown 正文上限 512 KiB（UTF-8），PDF 文件上限 5 MiB，解析后正文仍受 512 KiB 限制。
- 新只读 RPC `documents.preview`：`{filename, mediaType:'application/pdf', contentBase64}`，返回 `{filename, mediaType, text, byteSize, characterCount, pages}`。`pages` 为 `{page,textStart,textEnd}` 数组，页码从 1 开始。
- PDF 文本层按页提取，换行规范化，页间用两个换行连接。后续文档与证据引用该规范化正文；不保存原始 PDF，不声称 PDF 版面坐标。扫描件、损坏、加密文件返回明确错误，不静默生成空任务。客户端先预览解析正文再明确提交。
- 原导入接口增加 `application/pdf` mediaType（text 为已预览正文），所有公开快照字段维持原结构，仅媒体类型扩展。不上传用户本地文件路径。

## 路由

- L1：小文档全文一次提取，不预切为知识点。
- L2：全文在输入预算内而输出需分批时，模型先规划原文 block ID 的连续语义组，再逐组提取。程序生成的是物理段落块，不替模型断言知识点边界。
- L3：全文超过输入预算时，按标题/段落组成带原文重叠的有界上下文容器；容器内规划与提取，另对相邻容器边界联合提取；最后按相同 type/title/statement 合并证据，语义不同者留给人工审核。
- 采用可解释的固定保守输入预算，不伪装成按任意 provider 精确推算 token。准确阈值、最大调用次数及输出上限由实现与测试记录。所有容器覆盖全文，包括尾段；规划输出不得引用不存在的 block 或遗漏原文覆盖。规划无效导致本 attempt 明确失败，不静默丢段。
- PreparedGeneration 新增可选 `extractionPlan`（短文旧结构可保持不变）；其中含 strategy、物理 blocks（编号与文档绝对起止）、容器范围及最大调用次数。计划随 attempt 生成，模型快照仍冻结在 run 的第一次 attempt。
- Host 串行执行有界计划，逐次使用 DSH workflow/LLM。L1 原提取输出不变；长文提交 `{batches:[{textStart,textEnd,output}]}` 到原 submitGeneration 的 output 字段。每个 output 独立符合 l1-candidate.schema.json。
- Core 只在提交时按原文范围定位每条 quote，转换为文档绝对坐标，再合并相同候选的不同证据。不得拼接 quote 或默默截断候选/证据。实际输出过大应报告明确错误。
- 一个 run attempt 可能含多次模型调用；不扩建旧 provider-ledger，为正常分段调用建立新的授权账本。用户点击开始提取前看到调用上限；重试是新 attempt，会重新执行计划且有同样的明确费用提示。自动重连不触发重试。

## 验收

短文兼容、L2 规划与分组提取实际发生、L3 容器与边界任务实际发生；模型错误/无效规划无部分候选落库。中文和 supplementary Unicode 下每条保存证据逐字相等；首块之外坐标正确；跨块相同知识点合并多条证据；同 quote 在两个范围内各保留正确定位；超过旧 64 KiB 的文档尾段可提取。用 fake provider 在真实 DSH 运行及浏览器验证，零真实模型调用。

## 实现共享接口（2026-08-31）

- `documents.preview` 同时接受 `{filename,mediaType,text}` 文本，或 PDF 的 contentBase64。返回上述正文元信息 + `extractionPlan`。HTTP `POST /nobei/v1/documents/preview`，只读，不建 run、不调用模型。
- extractionPlan = `{strategy: 'L1'|'L2'|'L3', blocks:[{id,textStart,textEnd}], containers:[{blockIds:string[],textStart,textEnd}], boundaries:[{textStart,textEnd}], maxCalls:number}`。坐标均 Python Unicode code point。
- 物理块最长 4000 字符（优先段落/标题边界）；L1 <=6000 字符；L2 <=24000 字符；L3 每容器最多 6 块，相邻容器重叠 1 块，boundary 联合相邻块。每容器模型规划 groups = `[{blockIds:string[]}]`，组连续、不重叠、按顺序覆盖该容器所有块，每组最多 3 块。最多组数 = 容器块数；maxCalls = 容器数 + 所有容器块数之和 + boundary 数（L1固定1）。
- Host 根据模型 groups 连续范围逐组提取，然后执行 boundaries；不需要持久逐调用进度，处理页说明规划与分批运行，完成后SSE即时进入审核。失败原子：整 attempt 无部分候选。客户端显示完整来源提取计划和调用上限后才能开始；自动预览不产生费用。
- 大小限制同步：正文512KiB、PDF5MiB、HTTP8MiB、RPC32MiB、原始汇总输出8MiB、审核回执16MiB；单次输出旧schema上限不变，汇总最多1000候选、每候选最多64条去重证据，超限明确失败。这里的上限仅用于支持合法新输入，非新增数据审查。
