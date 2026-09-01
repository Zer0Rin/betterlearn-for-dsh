CREATE TABLE learning_courses (
  id              TEXT PRIMARY KEY,
  client_book_id  TEXT NOT NULL UNIQUE CHECK (length(client_book_id) BETWEEN 1 AND 128),
  title           TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  source_ids_json TEXT NOT NULL CHECK (length(source_ids_json) BETWEEN 2 AND 16384),
  source_digest   TEXT NOT NULL CHECK (length(source_digest) = 64),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE learning_units (
  id                        TEXT PRIMARY KEY,
  course_id                 TEXT NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
  ordinal                   INTEGER NOT NULL CHECK (ordinal >= 0),
  source_knowledge_point_id TEXT NOT NULL,
  source_document_id        TEXT NOT NULL,
  point_type                TEXT NOT NULL CHECK (point_type IN ('concept','process','comparison','formula','fact','code')),
  title                     TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  statement                 TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  evidence_json             TEXT NOT NULL CHECK (length(evidence_json) BETWEEN 2 AND 262144),
  created_at                TEXT NOT NULL,
  UNIQUE(course_id, ordinal),
  UNIQUE(course_id, source_knowledge_point_id)
);
CREATE INDEX idx_learning_units_course ON learning_units(course_id, ordinal);

CREATE TABLE learning_assessments (
  id                TEXT PRIMARY KEY,
  unit_id           TEXT NOT NULL REFERENCES learning_units(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('claim_choice','evidence_choice')),
  prompt            TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 4000),
  options_json      TEXT NOT NULL CHECK (length(options_json) BETWEEN 2 AND 262144),
  correct_option_id TEXT NOT NULL CHECK (length(correct_option_id) BETWEEN 1 AND 80),
  remediation_title TEXT NOT NULL CHECK (length(remediation_title) BETWEEN 1 AND 240),
  remediation_body  TEXT NOT NULL CHECK (length(remediation_body) BETWEEN 1 AND 8000),
  created_at        TEXT NOT NULL,
  UNIQUE(unit_id, kind)
);
CREATE INDEX idx_learning_assessments_unit ON learning_assessments(unit_id, kind);

CREATE TABLE learning_attempts (
  id                TEXT PRIMARY KEY,
  assessment_id     TEXT NOT NULL REFERENCES learning_assessments(id) ON DELETE CASCADE,
  idempotency_key   TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest    TEXT NOT NULL CHECK (length(request_digest) = 64),
  selected_option_id TEXT NOT NULL CHECK (length(selected_option_id) BETWEEN 1 AND 80),
  correct           INTEGER NOT NULL CHECK (correct IN (0,1)),
  result_json       TEXT NOT NULL CHECK (length(result_json) BETWEEN 2 AND 16777216),
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_learning_attempts_assessment ON learning_attempts(assessment_id, created_at);

CREATE TABLE learning_mastery_states (
  unit_id          TEXT PRIMARY KEY REFERENCES learning_units(id) ON DELETE CASCADE,
  course_id        TEXT NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
  status           TEXT NOT NULL CHECK (status IN (
                     'new','remediation_required','learning',
                     'mastered','mastered_after_remediation')),
  strength         INTEGER NOT NULL CHECK (strength BETWEEN 0 AND 100),
  main_attempts    INTEGER NOT NULL DEFAULT 0 CHECK (main_attempts >= 0),
  retest_attempts  INTEGER NOT NULL DEFAULT 0 CHECK (retest_attempts >= 0),
  last_correct     INTEGER CHECK (last_correct IN (0,1)),
  due_at           TEXT,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_learning_mastery_due ON learning_mastery_states(status, due_at);

UPDATE schema_meta
SET version=2, applied_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
WHERE id=1 AND version=1;

