-- 003: 知识点出处反规范化——page 与 heading_path 直挂 kp，简化 reveal 组装。
ALTER TABLE knowledge_points ADD COLUMN page INTEGER;
ALTER TABLE knowledge_points ADD COLUMN heading_path TEXT DEFAULT '';
INSERT INTO schema_version(version, applied_at) VALUES (3, strftime('%Y-%m-%dT%H:%M:%SZ','now'));
