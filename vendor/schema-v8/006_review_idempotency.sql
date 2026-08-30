-- 006: 评分幂等与乐观并发；旧记录保持 NULL，旧记忆项从 revision 0 开始。
ALTER TABLE memory_items ADD COLUMN memory_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_logs ADD COLUMN client_review_id TEXT;
ALTER TABLE review_logs ADD COLUMN request_hash TEXT;
ALTER TABLE review_logs ADD COLUMN result_json TEXT;
ALTER TABLE review_logs ADD COLUMN memory_revision INTEGER;

CREATE UNIQUE INDEX idx_review_logs_client_review_id
ON review_logs(client_review_id)
WHERE client_review_id IS NOT NULL;

INSERT INTO schema_version(version, applied_at)
VALUES (6, strftime('%Y-%m-%dT%H:%M:%SZ','now'));
