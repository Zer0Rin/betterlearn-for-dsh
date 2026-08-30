-- noBEI schema v1  (M1)
-- 单文件 SQLite。业务表 + FTS5；向量表(kp_vec/embedding_jobs)留到 M4。
-- 依据：软件总体架构 v1.0 §3、Schema v2 设计、计划书 v1.3。
-- 约定：所有 id 为带前缀文本主键（crs_/doc_/ck_/kp_/mi_/qi_/rv_/job_/…）；
--      时间统一 ISO8601 文本（应用层写入，含时区）。

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ── 迁移版本 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER NOT NULL,
    applied_at  TEXT    NOT NULL
);

-- ── 课程 ─────────────────────────────────────────────────
CREATE TABLE courses (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    exam_date     TEXT,                 -- 供题型策略"考期临近度"与组卷
    daily_new     INTEGER NOT NULL DEFAULT 20,
    review_cap    INTEGER,              -- NULL=不限（默认行为：欠账全堆给用户）
    teacher_notes TEXT,                 -- 老师强调事项（供 M6 组卷）
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

-- ── 文档 ─────────────────────────────────────────────────
CREATE TABLE documents (
    id           TEXT PRIMARY KEY,
    course_id    TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    source_type  TEXT NOT NULL,         -- raw_pdf|markdown|txt|notebooklm_export|manual… 中性，不评判来源(补遗-3)
    page_count   INTEGER,
    imported_at  TEXT NOT NULL
);
CREATE INDEX idx_documents_course ON documents(course_id);

-- ── 导入任务（进度/用量/费用，可恢复流水线的账本）────────────
CREATE TABLE import_jobs (
    id            TEXT PRIMARY KEY,
    document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    stage         TEXT NOT NULL,        -- source|parse|chunk|extract|verify|dedup|confirm|export|compile|done|failed
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending|running|paused|done|failed
    total_chunks  INTEGER DEFAULT 0,
    done_chunks   INTEGER DEFAULT 0,
    tokens_in     INTEGER DEFAULT 0,
    tokens_out    INTEGER DEFAULT 0,
    cost_cny      REAL    DEFAULT 0,
    est_cost_cny  REAL,                 -- 开跑前的费用预估（用户确认用）
    error         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX idx_jobs_document ON import_jobs(document_id);

-- ── 片段（chunk 级状态机，幂等可恢复）─────────────────────
CREATE TABLE chunks (
    id            TEXT PRIMARY KEY,
    document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,     -- 文档内顺序
    page          INTEGER,
    page_end      INTEGER,
    heading_path  TEXT,
    has_code      INTEGER NOT NULL DEFAULT 0,
    page_hash     TEXT,
    char_offset   INTEGER,              -- chunk 文本在整份文档文本中的起始偏移（供文档级代码切片）
    text          TEXT NOT NULL,
    context_prefix TEXT,                -- 上一块尾部，仅供提取上下文，禁作 quote 来源
    state         TEXT NOT NULL DEFAULT 'pending', -- pending|parsed|extracted|verified|failed
    created_at    TEXT NOT NULL
);
CREATE INDEX idx_chunks_document ON chunks(document_id, seq);
CREATE INDEX idx_chunks_state ON chunks(state);

-- ── 知识点（Schema v2 全字段）────────────────────────────
CREATE TABLE knowledge_points (
    id            TEXT PRIMARY KEY,
    course_id     TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_id      TEXT REFERENCES chunks(id) ON DELETE SET NULL,

    type          TEXT NOT NULL,        -- concept|process|comparison|formula|fact|code
    exam_qtype    TEXT NOT NULL DEFAULT '', -- 填空题|代码题|代码阅读题|简答题|论述题|计算题|辨析题|图例题|''
    card_role     TEXT NOT NULL DEFAULT 'standalone', -- parent|child|standalone
    parent_id     TEXT REFERENCES knowledge_points(id) ON DELETE SET NULL,

    title         TEXT NOT NULL,
    content       TEXT NOT NULL,

    -- 代码三表示（code 类专用；LLM 只给锚点，程序逐字切片）
    code          TEXT,                 -- 挖空/骨架态（填空题）或完整函数（代码题）
    code_full     TEXT,                 -- 完整答案态
    code_full_scope TEXT,               -- full_function|snippet|pseudocode
    code_status   TEXT,                 -- verbatim|anchor_failed
    code_locator  TEXT,                 -- JSON: {start_anchor,end_anchor}

    origin        TEXT NOT NULL DEFAULT 'extracted', -- extracted|user_created|ai_supplemented
    status        TEXT NOT NULL DEFAULT 'pending',   -- pending|confirmed|archived
    confidence    REAL DEFAULT 0.5,
    dup_group_id  TEXT,                 -- 去重合并段(§2⑥)：疑似重复聚为一组

    extraction_model          TEXT,
    extraction_prompt_version TEXT,
    content_hash  TEXT,                 -- 精确去重与幂等
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX idx_kp_course_status ON knowledge_points(course_id, status);
CREATE INDEX idx_kp_parent ON knowledge_points(parent_id);
CREATE INDEX idx_kp_dupgroup ON knowledge_points(dup_group_id);
CREATE INDEX idx_kp_chunk ON knowledge_points(chunk_id);

-- 关键词（多值，供 FTS 检索专用文本与展示）
CREATE TABLE kp_keywords (
    kp_id   TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
    keyword TEXT NOT NULL,
    PRIMARY KEY (kp_id, keyword)
);

-- 证据引用（evidence_quotes 数组 + 对齐结果 evidence_spans，一条知识点多条）
CREATE TABLE kp_evidence (
    id            TEXT PRIMARY KEY,
    kp_id         TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,     -- content 中论断顺序
    quote         TEXT NOT NULL,        -- 逐字引用
    chunk_id      TEXT REFERENCES chunks(id) ON DELETE SET NULL,
    page          INTEGER,
    align_method  TEXT,                 -- exact|normalized|fuzzy|failed
    locator_confidence REAL,
    text_start    INTEGER,              -- 相对所属 chunk 文本
    text_end      INTEGER,
    context_before TEXT,
    context_after  TEXT
);
CREATE INDEX idx_evidence_kp ON kp_evidence(kp_id, seq);

-- 填空答案（blank_answers 结构化，一条填空知识点多个空）
CREATE TABLE kp_blanks (
    kp_id   TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
    blank   INTEGER NOT NULL,
    answer  TEXT NOT NULL,
    reason  TEXT,
    PRIMARY KEY (kp_id, blank)
);

-- 确认审计日志（含 rejected/merged——它们不入卡组，只留档）
CREATE TABLE kp_confirm_log (
    id            TEXT PRIMARY KEY,
    kp_id         TEXT NOT NULL,        -- 不设外键：被拒条目可能不落 knowledge_points 正表
    support_label TEXT,                 -- supported|overgeneralized|unsupported
    action        TEXT,                 -- accepted_without_edit|accepted_with_edit|rejected|merged_duplicate|unsupported_evidence|granularity_bad
    edited_fields TEXT,                 -- JSON 数组
    merged_into   TEXT,
    granularity   TEXT,                 -- f|c
    elapsed_sec   REAL,
    confirmed_at  TEXT NOT NULL
);
CREATE INDEX idx_confirmlog_kp ON kp_confirm_log(kp_id);

-- ── 记忆项（FSRS 唯一绑定对象；一知识点可派生多 facet，v1 默认单一）──
CREATE TABLE memory_items (
    id          TEXT PRIMARY KEY,
    kp_id       TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
    facet       TEXT NOT NULL DEFAULT 'default',
    stability   REAL,
    difficulty  REAL,
    due_at      TEXT,
    state       TEXT NOT NULL DEFAULT 'new', -- new|learning|review|relearning
    reps        INTEGER NOT NULL DEFAULT 0,
    lapses      INTEGER NOT NULL DEFAULT 0,
    last_review TEXT,
    created_at  TEXT NOT NULL,
    UNIQUE (kp_id, facet)
);
CREATE INDEX idx_mi_due ON memory_items(due_at);
CREATE INDEX idx_mi_kp ON memory_items(kp_id);

-- ── 题目实例（记忆项的一次考察形式；解释出题时预生成缓存）──
CREATE TABLE question_instances (
    id             TEXT PRIMARY KEY,
    memory_item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
    qtype          TEXT NOT NULL,       -- mcq|cloze|recall
    difficulty_tier INTEGER,            -- 1|2|3 题型策略档位
    stem           TEXT NOT NULL,
    options        TEXT,                -- JSON 数组（mcq）
    answer_index   INTEGER,             -- mcq
    answer         TEXT,                -- cloze/recall
    explanation    TEXT,                -- 预生成缓存，复习期零模型调用
    machine_check  TEXT,                -- JSON：机检问题清单，空=通过
    created_at     TEXT NOT NULL
);
CREATE INDEX idx_qi_mi ON question_instances(memory_item_id);

-- ── 复习记录（评分回流 FSRS）──────────────────────────────
CREATE TABLE review_logs (
    id                   TEXT PRIMARY KEY,
    memory_item_id       TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
    question_instance_id TEXT REFERENCES question_instances(id) ON DELETE SET NULL,
    grade                INTEGER NOT NULL, -- 1忘记 2困难 3一般 4简单（用户自评）
    elapsed_ms           INTEGER,
    reviewed_at          TEXT NOT NULL
);
CREATE INDEX idx_rv_mi ON review_logs(memory_item_id, reviewed_at);

-- ── 模型接入 & 用量（provider 中立；key 应用层加密，不明文入库）──
CREATE TABLE providers (
    role       TEXT PRIMARY KEY,        -- chat|embedding
    base_url   TEXT,
    model      TEXT,
    key_cipher TEXT,                    -- 加密后的 key（OS keychain 优先，退化本地）
    updated_at TEXT
);

CREATE TABLE usage_logs (
    id          TEXT PRIMARY KEY,
    job_id      TEXT,
    step        TEXT,                   -- extract|questions|…
    model       TEXT,
    tokens_in   INTEGER DEFAULT 0,
    tokens_out  INTEGER DEFAULT 0,
    cost_cny    REAL DEFAULT 0,
    created_at  TEXT NOT NULL
);
CREATE INDEX idx_usage_job ON usage_logs(job_id);

-- ── 全文检索（FTS5，检索专用文本；M4 接入分词与融合，建表先行）──
-- content='' 外部内容模式：body 存 jieba 预分词 + 标识符拆分 + keywords 拼接文本
CREATE VIRTUAL TABLE kp_fts USING fts5(
    kp_id UNINDEXED,
    body,
    tokenize = 'unicode61'
);

-- 组卷（M6，建表后置；此处仅登记占位注释，不建空表）
-- exam_blueprints / exams / exam_questions 于 M6 迁移脚本追加。

INSERT INTO schema_version(version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ','now'));
