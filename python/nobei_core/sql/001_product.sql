-- 产品 schema 版本
CREATE TABLE schema_meta (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  version    INTEGER NOT NULL,
  applied_at TEXT    NOT NULL
);

-- 文档：正文内联，文档级绝对坐标的坐标原点
CREATE TABLE documents (
  id              TEXT PRIMARY KEY,          -- doc_…
  filename        TEXT NOT NULL,
  media_type      TEXT NOT NULL,             -- text/plain | text/markdown | (P3: application/pdf)
  canonical_text  TEXT NOT NULL,             -- 规范化正文（\n 统一、无 \r）
  byte_size       INTEGER NOT NULL CHECK (byte_size >= 0),
  character_count INTEGER NOT NULL CHECK (character_count >= 0),
  text_sha256     TEXT NOT NULL CHECK (length(text_sha256) = 64),
  created_at      TEXT NOT NULL
);

-- 提取任务（run）：头等实体
CREATE TABLE runs (
  id                 TEXT PRIMARY KEY,       -- job_…
  document_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  strategy           TEXT NOT NULL,          -- 'l1'（P3 起可扩展 l2/l3、pdf 等）
  status             TEXT NOT NULL CHECK (status IN (
                       'created','document_ready','awaiting_generation','generating',
                       'validating','review_pending','completed',
                       'failed_retryable','failed_terminal')),
  stage              TEXT NOT NULL CHECK (stage IN (
                       'source','parse','extract','verify','confirm','done','failed')),
  revision           INTEGER NOT NULL CHECK (revision >= 1),
  retry_count        INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 1),
  contract_version   INTEGER NOT NULL,       -- 提取输出契约版本（原 schema_version）
  contract_sha256    TEXT NOT NULL CHECK (length(contract_sha256) = 64),
  prompt_version     TEXT NOT NULL,
  raw_candidate_count          INTEGER NOT NULL DEFAULT 0,
  schema_valid_evidence_count  INTEGER NOT NULL DEFAULT 0,
  exact_evidence_count         INTEGER NOT NULL DEFAULT 0,
  accepted_candidate_count     INTEGER NOT NULL DEFAULT 0,
  valid_candidate_count        INTEGER NOT NULL DEFAULT 0 CHECK (valid_candidate_count >= 0),
  edited_candidate_count       INTEGER NOT NULL DEFAULT 0 CHECK (edited_candidate_count >= 0),
  rejected_candidate_count     INTEGER NOT NULL DEFAULT 0 CHECK (rejected_candidate_count >= 0),
  rejection_counts_json        TEXT NOT NULL DEFAULT '{}',
  error_code         TEXT,
  error_detail       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  completed_at       TEXT
);
CREATE INDEX idx_runs_status ON runs(status);

-- 生成 attempt：一次 provider 调用账本
CREATE TABLE generation_attempts (
  id                      TEXT PRIMARY KEY,  -- att_…
  run_id                  TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt_number          INTEGER NOT NULL CHECK (attempt_number IN (1,2)),
  request_digest          TEXT NOT NULL CHECK (length(request_digest) = 64),
  provider_idempotency_key TEXT NOT NULL UNIQUE,
  model_metadata_json     TEXT NOT NULL DEFAULT '{}',
  raw_output_json         TEXT,
  status                  TEXT NOT NULL CHECK (status IN ('started','succeeded','failed')),
  error_code              TEXT,
  created_at              TEXT NOT NULL,
  completed_at            TEXT,
  UNIQUE(run_id, attempt_number)
);

-- 候选：模型原始提案，生成后不可变
CREATE TABLE candidates (
  id          TEXT PRIMARY KEY,              -- cand_…
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL CHECK (ordinal >= 0),
  type        TEXT NOT NULL CHECK (type IN ('concept','process','comparison','formula','fact','code')),
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  statement   TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  created_at  TEXT NOT NULL,
  UNIQUE(run_id, ordinal)
);
CREATE INDEX idx_candidates_run ON candidates(run_id, ordinal);

-- 候选证据：提案时定位到的原文片段（文档级绝对坐标）
CREATE TABLE candidate_evidence (
  candidate_id   TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL CHECK (seq BETWEEN 0 AND 63),
  quote          TEXT NOT NULL CHECK (length(quote) BETWEEN 1 AND 2000),
  text_start     INTEGER NOT NULL CHECK (text_start >= 0),
  text_end       INTEGER NOT NULL CHECK (text_end > text_start),
  context_before TEXT NOT NULL CHECK (length(context_before) <= 200),
  context_after  TEXT NOT NULL CHECK (length(context_after) <= 200),
  PRIMARY KEY(candidate_id, seq)
);

-- 审核决策：每个候选最多一条；保留定稿文本，不覆盖候选
CREATE TABLE candidate_reviews (
  candidate_id      TEXT PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
  action            TEXT NOT NULL CHECK (action IN ('accept','edited_and_accept','reject')),
  final_title       TEXT,                    -- edited_and_accept 时非空
  final_statement   TEXT,
  knowledge_point_id TEXT UNIQUE REFERENCES knowledge_points(id) ON DELETE RESTRICT,
  reviewed_at       TEXT NOT NULL,
  CHECK (
    (action = 'reject' AND knowledge_point_id IS NULL AND final_title IS NULL AND final_statement IS NULL)
    OR (action = 'accept' AND knowledge_point_id IS NOT NULL AND final_title IS NULL AND final_statement IS NULL)
    OR (action = 'edited_and_accept' AND knowledge_point_id IS NOT NULL AND final_title IS NOT NULL AND final_statement IS NOT NULL)
  )
);

-- 知识点：审核通过后的持久产品产物
CREATE TABLE knowledge_points (
  id                        TEXT PRIMARY KEY,  -- kp_…
  document_id               TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  type                      TEXT NOT NULL CHECK (type IN ('concept','process','comparison','formula','fact','code')),
  title                     TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  statement                 TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  origin                    TEXT NOT NULL DEFAULT 'extracted',
  status                    TEXT NOT NULL DEFAULT 'confirmed',
  extraction_model          TEXT NOT NULL,
  extraction_prompt_version TEXT NOT NULL,
  content_hash              TEXT NOT NULL CHECK (length(content_hash) = 64),
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);
CREATE INDEX idx_kp_document ON knowledge_points(document_id);

-- 知识点证据：持久产物引用的原文片段（文档级绝对坐标）
CREATE TABLE knowledge_point_evidence (
  id               TEXT PRIMARY KEY,         -- ev_…
  knowledge_point_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL CHECK (seq BETWEEN 0 AND 63),
  quote            TEXT NOT NULL,
  text_start       INTEGER NOT NULL CHECK (text_start >= 0),
  text_end         INTEGER NOT NULL CHECK (text_end > text_start),
  context_before   TEXT NOT NULL,
  context_after    TEXT NOT NULL,
  UNIQUE(knowledge_point_id, seq)
);

-- 运行事件账本：append-only、seq 有序
CREATE TABLE run_events (
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL CHECK (seq > 0),
  type         TEXT NOT NULL CHECK (type IN (
                 'run.created','document.ready','generation.awaiting','generation.started',
                 'generation.validating','generation.failed','generation.interrupted',
                 'generation.retry_requested','candidates.ready','candidate.accepted',
                 'candidate.edited_and_accepted','candidate.rejected','run.completed')),
  stage        TEXT NOT NULL CHECK (stage IN ('source','parse','extract','verify','confirm','done','failed')),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (length(payload_json) <= 8192),
  created_at   TEXT NOT NULL,
  PRIMARY KEY(run_id, seq)
);

-- 幂等：scope 泛化，供审核及其它写命令复用
CREATE TABLE idempotency_records (
  scope           TEXT NOT NULL,             -- 如 'candidate_review'
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest  TEXT NOT NULL CHECK (length(request_digest) = 64),
  result_json     TEXT NOT NULL CHECK (length(result_json) <= 16777216),
  created_at      TEXT NOT NULL,
  PRIMARY KEY(scope, idempotency_key)
);

INSERT INTO schema_meta VALUES(1,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'));
