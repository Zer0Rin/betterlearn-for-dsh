-- 008: 让模型用量可追溯到书籍，并持久化永久删除后的文件清理任务。
ALTER TABLE usage_logs
ADD COLUMN course_id TEXT REFERENCES courses(id) ON DELETE CASCADE;

UPDATE usage_logs
SET course_id = (
    SELECT d.course_id
    FROM import_jobs j
    JOIN documents d ON d.id = j.document_id
    WHERE j.id = usage_logs.job_id
)
WHERE job_id IS NOT NULL;

CREATE INDEX idx_usage_course ON usage_logs(course_id);

CREATE TABLE file_cleanup_queue (
    id              TEXT PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    created_at      TEXT NOT NULL,
    last_error_type TEXT
);

INSERT INTO schema_version(version, applied_at)
VALUES (8, strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now'));
