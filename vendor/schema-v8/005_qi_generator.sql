-- 005 (M2): question_instances 增加 generator 列，区分 LLM 生成与确定性兜底。
-- 取题策略：同 (记忆项, 题型) 优先 LLM 版；无则确定性版立即可用（学习不等待）。
ALTER TABLE question_instances ADD COLUMN generator TEXT NOT NULL DEFAULT 'deterministic';
INSERT INTO schema_version(version, applied_at) VALUES (5, strftime('%Y-%m-%dT%H:%M:%SZ','now'));
