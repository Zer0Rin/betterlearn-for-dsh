# 生成进度小步实现与验收

用户已同意补充批次进度与最近响应时间，并要求自主完成、避免过度工程化。本计划按 writing-plans 在当前任务执行，不再增加确认轮次。

目标：长文等待时能区分规划、逐批提取、结果校验；显示已完成/总批数，以及真实模型数据最近到达时间。L3尚未完成所有规划时总批数为null，显示“总批数规划中”，包括边界提取，不把调用上限冒充实际批数。无响应不自动断言卡死或重试。

方案：GenerationHandle保存一份内存进度，adapter在规划/提取边界更新计数，只观察本次owned child的session/event assistant/chunk更新响应时间，通知最多每秒一次。coordinator已有watchRun传递可选进度，原无参数通知仍表示Core状态变化。新增GET /runs/:id/progress只读内存；SSE增加run.progress及连接时快照。Client用现有pollRun兜底补读，进度消息不唤醒Core轮询。终态、切换任务、重试时清除进度。RunSnapshot、Python、SQLite、prompt、调用预算均不改。

- [x] 在generation-adapter/model-selection-propagation测试中覆盖L1、L2、L3含边界计数；只统计owned child真实chunk，释放监听，节流与无响应时间不伪造。
- [x] 在coordinator/routes/client-api/poll-run测试中覆盖内存快照、SSE首连及推送、断开轮询恢复、迟到进度不得覆盖新任务或终态，不新增模型调用。
- [x] 在RunProgress和workspace测试中覆盖规划中/第N批/最后响应/无数据/终态清除；实现最小界面，保留现有失败和恢复行为。
- [x] 构建与定向测试206项通过；真实rc.8延迟fake以1规划+3提取产生6候选，浏览器刷新恢复并自动进入审核。兜底用不建立SSE的实际Client pollRun与HTTP接口验证，未做浏览器网络断线注入。真实模型调用0次。
- [x] 打包0.0.3；无活动提取时备份升级重启，53候选/审核决定/知识点及全部11表不变，请求数12→12。验收记录随实现提交，未跟踪vendor目录不触碰。

达标不是测试条数：真实流数据更新时间、正确批次、刷新/断流可恢复、成功自动转审核、失败不再显示进行中、相同输入调用数不变，全部通过才交付。本次只改展示元数据，不增加账本、持久事件或历史扫描。
