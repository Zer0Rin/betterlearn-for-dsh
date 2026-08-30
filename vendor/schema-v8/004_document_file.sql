-- 004: documents 增加 file_path（上传原件存储位置，供流水线读取与将来出处回跳原文件）
ALTER TABLE documents ADD COLUMN file_path TEXT;
INSERT INTO schema_version(version, applied_at) VALUES (4, strftime('%Y-%m-%dT%H:%M:%SZ','now'));
