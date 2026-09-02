# BetterLearn 数据模型（设计与实现记录）

> 状态：P2 的 11 张提取与审核表已实现并通过实际 DSH 浏览器验收；当前权威基础结构见 `python/nobei_core/sql/001_product.sql`。学习闭环随后通过 `python/nobei_core/sql/002_learning.sql` 增加 5 张表，形成 Schema v2 的 16 张产品自有表。以下旧结构分析保留为 P2 改造前设计记录。

实施补充（2026-09-01）：Schema v1 使用文档正文内联、不可变候选与独立审核、文档绝对证据坐标和写事务计数；Schema v2 增加学习课程、学习单元、题目、作答记录和掌握度状态。空库依次应用 `001_product.sql` 与 `002_learning.sql`，已有合法 v1 库只应用学习扩展，不读取或迁移旧 Nobei 数据。

P3 使用确定性、内存中的物理范围计划，未新增持久 chunks 表。所有证据相对规范化正文计 Unicode 字符，不是 JavaScript UTF-16 code unit。PDF 记录规范化正文和媒体类型，不保存 PDF 文件或版面坐标。

## 1. 背景与目标

BetterLearn 当前只暴露一条闭环：粘贴文本 → 生成候选 → 审核 → 产出知识点。数据层面却背着两层结构：

- **v8 领域表**（冻结在 `vendor/schema-v8/`，`python/nobei_core/sql/v8/*.sql`）：旧 Nobei 学习应用的完整 schema，含课程、文档、chunk、知识点、证据、确认日志，以及 FSRS 复习、题目、用量、FTS 等大量表。
- **`p1_*` 控制层**（`python/nobei_core/sql/phase1_schema.sql`）：当前插件的任务状态机、生成 attempt、候选、候选证据、事件账本、幂等表。

P2 的目标只有一个：**让 `p1_*` 这一层本身成为长期产品模型**，同时把 v8 里真正被用到的少数几张表（文档、知识点、证据、审核审计）以「产品自有、且按产品语义重定义」的形式纳入，其余一律废弃。

## 2. 现状：双层结构的代价

当前 `p1_*` 必须「投影」进 v8 表，产生了一系列本可避免的复杂度（均已核实代码）：

1. **运行状态双重投影**：`p1_run_control.status/stage` 与 `import_jobs.status/stage` 必须逐事务同步，`assert_projection()` 每次读写都校验二者一致。一个 run 本应是头等实体，却被塞进旧 `import_jobs`。
2. **文档正文被塞进 `chunks`**：正文只存在于 `chunks.text`，且每份文档强制恰好 1 个 chunk（`seq=0`、`char_offset=0`、`state='parsed'`）。`p1_run_control` 只存 `document_sha256/byte_size/character_count`，正文反而在另一张表里。
3. **占位课程**：`FIXTURE_COURSE_ID = 'crs_p1_fixture'` 是硬编码的假课程。产品根本没有「课程/合集」概念，`assert_no_foreign_user_data()` 还要专门守卫「不允许出现 fixture 以外的课程」。
4. **证据坐标语义分裂**：`p1_candidate_evidence` 用**文档级绝对偏移**（`text_start/text_end` 相对整篇正文）；而 v8 `kp_evidence` 用**chunk 相对偏移**。现在因为「1 chunk == 整篇文档」两者恰好相等，一旦引入分块就崩。
5. **知识点字段错位**：v8 `knowledge_points` 携带 `exam_qtype/card_role/parent_id/code*/dup_group_id/confidence/page/heading_path` 等旧应用字段，当前产品只用到其中极小一部分，且用 `content` 承载候选的 `statement`，命名与产品词汇不一致。
6. **大量死重**：`memory_items / question_instances / review_logs(FSRS) / kp_blanks / kp_keywords / kp_fts / providers / usage_logs / file_cleanup_queue` 全部被 `_MUST_BE_EMPTY` 强制为空，运行时零使用。
7. **硬编码阶段标识**：`mode='l1'`、`prompt_version='l1-v2'`、`retry_count BETWEEN 0 AND 1`（最多重试 1 次）、`p1_idempotency.scope='candidate_review'` 都是写死的，无法承载 P3 的 L2/L3 路由或更一般的任务形态。

关键事实：因为 `assert_no_foreign_user_data()` 已经把数据库约束为「只允许 fixture 数据」，**当前不存在任何真实用户数据**。这让 P2 可以做一次干净的重建，而无需设计数据迁移。

## 3. 设计原则

1. **产品自有 schema**：新表用产品语义命名，不再有 `p1_` 前缀，也不再投影进任何旧表。
2. **保留 p1_* 中被验证过的机制**：`revision` 乐观并发、append-only 事件账本（seq 有序且校验）、生成 attempt 账本、幂等表、以及「先在事务外校验、再原子落库」的两阶段提交。
3. **文档级绝对坐标**：所有证据偏移一律相对整篇文档正文；分块（P3）只作为附加索引层，不改证据坐标语义。
4. **提案与决策分离**：候选保留模型原始提案（不可变）；审核结果（接受/修改/拒绝、定稿文本）单独记录，不再覆盖候选。
5. **提取契约与数据库 schema 解耦**：run 上的 `schema_version/schema_sha256` 是**候选输出 JSON 契约**的版本（`contracts/l1-candidate.schema.json`），与数据库 schema 版本是两回事，命名上要分清。
6. **只建当前需要的表**：不预先建「合集/分块/复习」等尚无产品语义的表；需要时按 P3/P4 增量加入。

## 4. 目标模型

### 4.1 表清单

| 目标表 | 来源 | 变化 |
|---|---|---|
| `schema_meta` | `p1_schema_meta` + v8 `schema_version` | 合并为单一产品 schema 版本 |
| `documents` | v8 `documents` + v8 `chunks` | 正文内联，不再走 chunk |
| `runs` | `p1_run_control` + v8 `import_jobs` | 头等实体，去掉投影 |
| `generation_attempts` | `p1_generation_attempts` | 仅改名 |
| `candidates` | `p1_candidates` | 保留原始提案，不再被审核覆盖 |
| `candidate_evidence` | `p1_candidate_evidence` | 仅改名，保持文档级偏移 |
| `candidate_reviews` | v8 `kp_confirm_log` | 记录决策与定稿文本 |
| `knowledge_points` | v8 `knowledge_points` | 瘦身为产品语义字段 |
| `knowledge_point_evidence` | v8 `kp_evidence` | 改为文档级偏移 |
| `run_events` | `p1_run_events` | 仅改名 |
| `idempotency_records` | `p1_idempotency` | 仅改名，scope 泛化 |

### 4.2 Schema v2 学习扩展

| 学习表 | 作用 |
|---|---|
| `learning_courses` | 冻结课程版本、标题、进度与课程状态 |
| `learning_units` | 保存课程中的知识点快照与顺序 |
| `learning_assessments` | 保存与真实陈述和原文证据绑定的客观题及 Core 私有答案 |
| `learning_attempts` | 保存幂等作答、判分结果与补救阶段 |
| `learning_mastery_states` | 保存掌握度、复测计数与下一次复习时间 |

学习扩展只引用已经审核确认的知识点快照，不改变原候选、审核决策或证据坐标语义。

### 4.3 DDL 草案

```sql
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
  seq            INTEGER NOT NULL CHECK (seq BETWEEN 0 AND 2),
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
  seq              INTEGER NOT NULL CHECK (seq BETWEEN 0 AND 2),
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
  result_json     TEXT NOT NULL CHECK (length(result_json) <= 65536),
  created_at      TEXT NOT NULL,
  PRIMARY KEY(scope, idempotency_key)
);
```

### 4.4 废弃清单（来自 v8，运行时零使用）

`courses`、`app_state`、`import_jobs`、`chunks`、`kp_keywords`、`kp_blanks`、`kp_confirm_log`、`memory_items`、`question_instances`、`review_logs`(FSRS)、`providers`、`usage_logs`、`kp_fts`（及其 shadow 表）、`file_cleanup_queue`。

连同 `FIXTURE_COURSE_ID`、`_MUST_BE_EMPTY` 守卫、`_CANONICAL_V8_MIGRATIONS`、`vendor/schema-v8/` 一起移除。

## 5. 关键结构变化

1. **运行是头等实体**：`runs.document_id` 直接外键到 `documents`，删除 `import_jobs` 投影与 `assert_projection()`。run 状态机、事件账本、attempt 账本完全由 `runs/generation_attempts/run_events` 自洽表达。
2. **正文内联到 `documents`**：`canonical_text` 直接落库，`text_sha256` 用于请求幂等与内容一致性。P3 引入 PDF/长文档时，再加 `chunks`（文档级 `char_offset`）作为**附加索引**，证据仍用文档级偏移，不改变坐标语义。
3. **提案与决策分离**：`candidates` 生成后不可变；`candidate_reviews` 记录 `action + final_* + knowledge_point_id`。修复了当前 `edited_and_accept` 覆盖候选标题/陈述、丢失「修改前」的问题。
4. **正式知识点可修改**：完成后的 `knowledge_points.title/statement` 可继续编辑；同一事务同步 `candidate_reviews.final_*`、内容哈希、运行计数和 revision，但不覆盖原始候选。当前不保存知识点版本历史。
5. **任务删除按所有权级联**：删除 run 对应的 document 会级联删除 attempts、candidates、evidence、knowledge points 与 events；删除前先解除 review 对知识点的限制引用，并只清除结果指向该 run 候选的审核幂等记录。当前没有回收站。
6. **候选不再需要 `revision` 乐观并发**：候选不可变 + `candidate_reviews` 以 `candidate_id` 为主键，重复审核由 UNIQUE/状态检查天然拒绝（对应现有 `CANDIDATE_ALREADY_REVIEWED`），比现有 `revision 1→2` 更简单。
7. **证据坐标统一为文档级**：`candidate_evidence` 与 `knowledge_point_evidence` 都存文档绝对偏移，消灭 v8 `kp_evidence` 的 chunk 相对语义。
8. **契约与库版本分离命名**：`runs.contract_version/contract_sha256`（原 `schema_version/schema_sha256`）只标识候选输出契约；数据库 schema 版本由 `schema_meta` 单独管理。避免「schema」一词双关。
9. **`strategy` 取代硬编码 `mode`**：`runs.strategy` 当前固定 `'l1'`，为 P3 的 L2/L3 路由、PDF、分块策略预留扩展位，`retry_count` 上限后续按策略放宽。

## 6. 迁移路径与决策点

**已执行决策：P2以当时仅有fixture数据为前提，采用干净重建，不写数据迁移。最终产品库现在可保存用户材料；未知旧库不会被删除或迁移。**

- 新建 `python/nobei_core/sql/` 下的产品迁移（单一 `001_product.sql` 起步），替代 `vendor/schema-v8/` + `phase1_schema.sql`。
- `Phase1Database.open()` 的引导顺序改为：`apply_product_schema()` → `assert_schema()` → `recover_interrupted_runs()`，删除 v8 校验与 foreign-data 守卫。
- 若未来发现「已有用户本地存在真实知识点」，则必须在发布前补一条一次性前向迁移：把旧 `documents/chunks → documents`、`p1_run_control/import_jobs → runs`、`p1_candidates → candidates+candidate_reviews`、v8 `knowledge_points/kp_evidence/kp_confirm_log → knowledge_points/knowledge_point_evidence/candidate_reviews` 做一次受控复制。**这条迁移现在不写，但必须作为发布门槛记录在案。**

## 7. 影响面

- **Python Core**：`database.py`（引导与守卫）、`repository.py`（全部 SQL 与投影校验）、`service.py`（`_require_run_document`、`_validate_run_document`、`assert_projection`、`insert_formal_*`、`close_candidate_review` 等）、`constants.py`（删 `FIXTURE_COURSE_ID`、`JOB_PROJECTION` 等）。
- **契约 / RPC**：对外 `RunSnapshot/CandidateSnapshot/KnowledgePointSnapshot` 结构不变（仍是 `runId/documentId/status/stage/revision/…`），因此 Host、Client、契约测试、验收器的**对外协议无需改动**。这是本设计的价值所在：数据模型自洽化不破坏已经跑通的端到端闭环。
- **测试**：Python 侧 `test_database_bootstrap / test_ownership / test_evidence / test_generation_state / …` 需跟随表名与投影语义重写；TypeScript 侧基本不动。

## 8. 待决策项

1. 干净重建 vs 保留一次性迁移（见 §6）：默认选干净重建。
2. 表名是否现在就去掉 `p1_` 前缀（本设计默认去掉）；若倾向「先保留前缀、仅消除投影」以降低改动量，可作为 P2 的第一小步。
3. `candidate_reviews` 的 `knowledge_point_id UNIQUE`：一个知识点只对应一个候选（当前约束），未来若支持「多证据知识点合并」需放开。
4. 是否在本阶段就引入最简 `collections`（取代 fixture 课程）——默认否，文档即顶层单位，合集留到 P3/P4 与库浏览一起做。
