-- 007: 书籍优先知识库；唯一应用书由 app_state 表达，旧收件箱不再存在。
ALTER TABLE courses ADD COLUMN frozen_at TEXT;

UPDATE courses
SET frozen_at = strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now')
WHERE id <> 'crs_inbox';

INSERT INTO courses(
    id, name, exam_date, daily_new, review_cap, teacher_notes,
    created_at, updated_at, frozen_at
)
SELECT
    'crs_legacy_unclassified', '未分类资料', NULL, 20, NULL, NULL,
    strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now'),
    strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now'),
    strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now')
WHERE EXISTS (
    SELECT 1 FROM documents WHERE course_id = 'crs_inbox'
)
OR EXISTS (
    SELECT 1 FROM knowledge_points WHERE course_id = 'crs_inbox'
);

UPDATE documents
SET course_id = 'crs_legacy_unclassified'
WHERE course_id = 'crs_inbox';

UPDATE knowledge_points
SET course_id = 'crs_legacy_unclassified'
WHERE course_id = 'crs_inbox';

DELETE FROM courses WHERE id = 'crs_inbox';

CREATE TABLE app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    active_course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL
);

INSERT INTO app_state(id, active_course_id, updated_at)
VALUES (
    1, NULL, strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now')
);

INSERT INTO schema_version(version, applied_at)
VALUES (7, strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now'));
