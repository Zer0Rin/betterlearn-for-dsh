CREATE TABLE p1_schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version = 1),
  applied_at TEXT NOT NULL
);

CREATE TABLE p1_run_control (
  job_id TEXT PRIMARY KEY REFERENCES import_jobs(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode = 'l1'),
  status TEXT NOT NULL CHECK (status IN ('created','document_ready','awaiting_generation','generating','validating','review_pending','completed','failed_retryable','failed_terminal')),
  stage TEXT NOT NULL CHECK (stage IN ('source','parse','extract','verify','confirm','done','failed')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  schema_sha256 TEXT NOT NULL CHECK (length(schema_sha256) = 64),
  prompt_version TEXT NOT NULL CHECK (length(prompt_version) > 0),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 1),
  document_sha256 TEXT NOT NULL CHECK (length(document_sha256) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  character_count INTEGER NOT NULL CHECK (character_count >= 0),
  raw_candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (raw_candidate_count >= 0),
  schema_valid_evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (schema_valid_evidence_count >= 0),
  exact_evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (exact_evidence_count >= 0),
  accepted_candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_candidate_count >= 0),
  rejection_counts_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE p1_generation_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES p1_run_control(job_id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number IN (1,2)),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  provider_idempotency_key TEXT NOT NULL UNIQUE,
  model_metadata_json TEXT NOT NULL DEFAULT '{}',
  raw_output_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(job_id, attempt_number)
);

CREATE TABLE p1_candidates (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES p1_run_control(job_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  type TEXT NOT NULL CHECK (type IN ('concept','process','comparison','formula','fact','code')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','accepted','edited_and_accepted','rejected')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  accepted_kp_id TEXT UNIQUE REFERENCES knowledge_points(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  UNIQUE(job_id, ordinal)
);

CREATE TABLE p1_candidate_evidence (
  candidate_id TEXT NOT NULL REFERENCES p1_candidates(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq BETWEEN 0 AND 2),
  quote TEXT NOT NULL CHECK (length(quote) BETWEEN 1 AND 2000),
  text_start INTEGER NOT NULL CHECK (text_start >= 0),
  text_end INTEGER NOT NULL CHECK (text_end > text_start),
  context_before TEXT NOT NULL CHECK (length(context_before) <= 200),
  context_after TEXT NOT NULL CHECK (length(context_after) <= 200),
  PRIMARY KEY(candidate_id, seq)
);

CREATE TABLE p1_run_events (
  job_id TEXT NOT NULL REFERENCES p1_run_control(job_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  type TEXT NOT NULL CHECK (type IN (
    'run.created','document.ready','generation.awaiting','generation.started',
    'generation.validating','generation.failed','generation.interrupted',
    'generation.retry_requested','candidates.ready','candidate.accepted',
    'candidate.edited_and_accepted','candidate.rejected','run.completed'
  )),
  stage TEXT NOT NULL CHECK (stage IN ('source','parse','extract','verify','confirm','done','failed')),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (length(payload_json) <= 8192),
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id, seq)
);

CREATE TABLE p1_idempotency (
  scope TEXT NOT NULL CHECK (scope = 'candidate_review'),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  result_json TEXT NOT NULL CHECK (length(result_json) <= 65536),
  created_at TEXT NOT NULL,
  PRIMARY KEY(scope, idempotency_key)
);

CREATE INDEX idx_p1_run_control_status ON p1_run_control(status);
CREATE INDEX idx_p1_generation_attempts_job ON p1_generation_attempts(job_id);
CREATE INDEX idx_p1_candidates_job_status ON p1_candidates(job_id,review_status);
CREATE INDEX idx_p1_run_events_job_seq ON p1_run_events(job_id,seq);

INSERT INTO p1_schema_meta(id,version,applied_at) VALUES(1,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'));
