# P3 Host 实施记录（2026-08-31）

Host 接受 `POST /nobei/v1/documents/preview`，固定转发只读 `documents.preview`。文本、PDF base64、PDF已解析正文均支持；不创建任务、不启动模型。PDF_MALFORMED / PDF_ENCRYPTED / PDF_NO_TEXT 保留为 HTTP400公开错误。正文512KiB、PDF5MiB（Core验证decoded大小）、HTTP8MiB、RPC32MiB。

`StructuredGenerationAdapter` 对旧L1保持一次候选提取和原输出。L2/L3执行 Core extractionPlan：每容器先调用workflow语义规划，验证groups逐个按顺序完整覆盖且每组1–3blocks；随后逐组独立提取。L3最后提取所有boundary。任何无效规划/提取/取消都不返回partial batches，不调用Core部分提交。最终 output={batches:[{textStart,textEnd,output}]}。

所有正文切片使用Array.from的Unicode codepoint坐标。模型selection在start时复制冻结，各调用独立创建parent、安装相同selection、观察唯一owned child、安装工具拒绝规则、清理父子边界。各workflow串行；每调用maxTotalAgents=1；总调用数量受plan.maxCalls约束；attempt总超时为maxCalls×120秒（L1=120秒）。运行时ProviderLedger及installProviderLedger全部从plugin/adapter移除，无分批digest或新授权账本。历史source/tests保留为归档。

fake-provider保留fixture:one/three；语义规划读取BLOCKS_JSON并把连续block两两分组；fixture:p3-invalid-plan返回不存在ID。每条独立`P3事实：内容`行生成fact，title/statement为内容，quote为整行，Unicode安全的前后40字符作为context；因此相同事实可跨batch合并且重复quote可消歧。验收fixture事实内容应不超过旧schema的title/candidate/evidence上限。

验证：149项相关定向测试通过（adapter21、coordinator12、routes70、RPC11、request16、plugin7、fake12）；host tsc和fake-provider build通过。测试涵盖实际L2/L3调用次序、Unicode切片、模型冻结、各种无效group、取消、超时预算、预览转发和PDF错误。未调用真实模型；真实DSH与浏览器整体验收由主任务继续执行，以上单测不替代整体验收。
