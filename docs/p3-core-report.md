# P3 Core 验收记录

2026-08-31。零真实模型调用；不包含 Host/Client 或 P4 验收结论。

- `documents.preview` 支持 TXT/Markdown/PDF 规范化正文、PDF base64，只读返回 `filename/mediaType/text/byteSize/characterCount/pages/extractionPlan`。pypdf 固定 6.16.2；5 MiB PDF、512 KiB 解析正文。逐页文本以两个换行连接，页坐标为 Unicode code point；不保存原 PDF。错误明确为 `PDF_MALFORMED`、`PDF_ENCRYPTED`、`PDF_NO_TEXT`。
- 物理块最大 4000 字符，优先段落和标题边界；L1 ≤6000，L2 ≤24000，L3 每容器至多 6 块、步长 5 块，边界取接缝前块、重叠块和后块。所有块连续覆盖全文，包括尾段。maxCalls 是容器规划次数 + 所有容器块数 + 边界数的保守上限；L1 固定 1。长文 prepared 附计划，短文保持旧 prepared 结构。
- 批量 `{batches:[{textStart,textEnd,output}]}`：每个 output 先整体校验旧 schema，数量受 maxCalls 约束，原始汇总受 8 MiB 限制。提交时仅在对应原文范围内精确定位，再转绝对坐标；相同 type/title/statement 合并，按 quote/start/end 去重。最多1000个保存候选、64条证据；超限整个 attempt 明确 `GENERATION_SCHEMA_INVALID`，不截断、不部分提交。规划语义组连续完整覆盖由 Host 校验。
- SQL 和 repository 的证据序号、统计/事件计数已同步扩大。审核回执16 MiB，RPC32 MiB。候选提案不变，审核幂等、模型首次快照、持久统计保留；读取不重新定位或重放原输出。单次候选 schema 仍20候选/3证据。
- 新 fixture `python/tests/fixtures/chinese-two-pages.pdf` 为本地 ReportLab 生成的两页中文文本层 PDF；运行时只需要 pypdf。新15项定向测试覆盖 PDF页偏移与只读性、损坏/加密/扫描件、L1/L2/L3阈值与Unicode全文覆盖、超过64KiB的非首段重复引文绝对坐标与合并、后续批次无效的原子失败、1000/1001候选、64/65证据、512KiB全文64证据审核与幂等。
- 验证：15项 P3 定向测试通过；受影响 Python 全集运行一次，326通过、2项旧常量期望失败；将两个期望更新为新PDF错误码与512KiB限制后，定向重跑2项全部通过。共328项有通过结果。已有6项最大文档接受/修改/拒绝与幂等测试也在全集中通过。
- 干净建库范围内修改 `001_product.sql`，不提供旧库迁移；最终安装验收需使用新库。PDF OCR/布局坐标、实际模型质量不在本次实现范围。
