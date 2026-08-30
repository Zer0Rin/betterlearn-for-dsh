-- 002: 双层调度（补遗-4）——memory_items 增加表层"闯关进度"字段。
-- 里层 FSRS 状态(stability/difficulty/due_at/state)已在 001 建好；此处补表层 stage。
ALTER TABLE memory_items ADD COLUMN stage INTEGER NOT NULL DEFAULT 0;      -- 0选择/1填空/2默写
ALTER TABLE memory_items ADD COLUMN graduated INTEGER NOT NULL DEFAULT 0;  -- 1=三关毕业，转FSRS纯复习轨

INSERT INTO schema_version(version, applied_at)
VALUES (2, strftime('%Y-%m-%dT%H:%M:%SZ','now'));
