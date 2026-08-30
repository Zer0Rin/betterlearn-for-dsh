from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from pathlib import Path

import pytest

from nobei_core import database as database_module
from nobei_core.database import Phase1Database
from nobei_core.errors import CoreProblem
from nobei_core.ownership import CoreLease, initialize_owned_root

from conftest import MIGRATIONS_ROOT, PHASE1_SCHEMA_PATH


NOW = "2026-08-26T00:00:00Z"
DIGEST = "a" * 64


def _apply_v8_migrations(database_path: Path, count: int = 8) -> None:
    connection = sqlite3.connect(database_path, isolation_level=None)
    try:
        for migration in sorted(MIGRATIONS_ROOT.glob("[0-9][0-9][0-9]_*.sql"))[:count]:
            connection.executescript(migration.read_text(encoding="utf-8"))
    finally:
        connection.close()


def _open(root: Path, token: str, migrations_root: Path = MIGRATIONS_ROOT) -> Phase1Database:
    return Phase1Database.open(root, token, migrations_root, PHASE1_SCHEMA_PATH)


def _seed_run(connection: sqlite3.Connection) -> None:
    connection.execute(
        "INSERT INTO documents(id,course_id,name,source_type,imported_at) VALUES(?,?,?,?,?)",
        ("doc_" + "1" * 20, "crs_p1_fixture", "fixture.txt", "txt", NOW),
    )
    connection.execute(
        "INSERT INTO import_jobs(id,document_id,stage,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        ("job_" + "2" * 20, "doc_" + "1" * 20, "source", "pending", NOW, NOW),
    )
    connection.execute(
        """
        INSERT INTO p1_run_control(
          job_id,mode,status,stage,revision,schema_version,schema_sha256,prompt_version,
          retry_count,document_sha256,byte_size,character_count,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            "job_" + "2" * 20,
            "l1",
            "created",
            "source",
            1,
            1,
            DIGEST,
            "p1",
            0,
            DIGEST,
            1,
            1,
            NOW,
            NOW,
        ),
    )


def _run_control_values(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "job_id": "job_" + "2" * 20,
        "mode": "l1",
        "status": "created",
        "stage": "source",
        "revision": 1,
        "schema_version": 1,
        "schema_sha256": DIGEST,
        "prompt_version": "p1",
        "retry_count": 0,
        "document_sha256": DIGEST,
        "byte_size": 1,
        "character_count": 1,
        "created_at": NOW,
        "updated_at": NOW,
    }
    values.update(overrides)
    return values


RUN_CONTROL_INSERT = """
INSERT INTO p1_run_control(
  job_id,mode,status,stage,revision,schema_version,schema_sha256,prompt_version,
  retry_count,document_sha256,byte_size,character_count,created_at,updated_at
) VALUES(
  :job_id,:mode,:status,:stage,:revision,:schema_version,:schema_sha256,:prompt_version,
  :retry_count,:document_sha256,:byte_size,:character_count,:created_at,:updated_at
)
"""


def test_bootstrap_applies_exact_v8_pragmas_fixture_and_phase1_schema(database: Phase1Database):
    assert database.schema_version() == 8
    assert database.p1_schema_version() == 1
    assert database.pragma("journal_mode").lower() == "wal"
    assert database.pragma("foreign_keys") == 1
    assert database.pragma("busy_timeout") == 5000
    assert database.pragma("synchronous") == 2
    assert database.one("SELECT id FROM courses") == {"id": "crs_p1_fixture"}
    assert database.one("SELECT active_course_id FROM app_state WHERE id=1") == {
        "active_course_id": "crs_p1_fixture"
    }
    assert database.one("SELECT id FROM courses WHERE id='crs_inbox'") is None


def test_phase1_schema_contains_all_tables_and_required_indexes(database: Phase1Database):
    tables = {
        row["name"]
        for row in database.all("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'p1_%'")
    }
    indexes = {
        row["name"]
        for row in database.all("SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'idx_p1_%'")
    }

    assert tables == {
        "p1_schema_meta",
        "p1_run_control",
        "p1_generation_attempts",
        "p1_candidates",
        "p1_candidate_evidence",
        "p1_run_events",
        "p1_idempotency",
    }
    assert indexes == {
        "idx_p1_run_control_status",
        "idx_p1_generation_attempts_job",
        "idx_p1_candidates_job_status",
        "idx_p1_run_events_job_seq",
    }


def test_bootstrap_reopens_idempotently(owned_root: Path, ownership_token: str):
    first = _open(owned_root, ownership_token)
    first.close()

    second = _open(owned_root, ownership_token)
    try:
        assert second.schema_version() == 8
        assert second.p1_schema_version() == 1
        assert second.one("SELECT count(*) AS count FROM courses") == {"count": 1}
    finally:
        second.close()


@pytest.mark.parametrize("schema_failure", ["missing", "malformed"])
def test_fixture_and_phase1_schema_installation_roll_back_as_one_unit(
    tmp_path: Path,
    ownership_token: str,
    schema_failure: str,
):
    root = tmp_path / "atomic-bootstrap"
    root.mkdir()
    initialize_owned_root(root, ownership_token)
    schema_path = tmp_path / "broken-phase1-schema.sql"
    if schema_failure == "malformed":
        schema_path.write_text(
            "CREATE TABLE p1_partial(id INTEGER);\nTHIS IS NOT VALID SQL;\n",
            encoding="utf-8",
        )

    with pytest.raises(CoreProblem) as caught:
        Phase1Database.open(root, ownership_token, MIGRATIONS_ROOT, schema_path)

    assert caught.value.code == "DATABASE_UNAVAILABLE"
    connection = sqlite3.connect(root / "phase1.db")
    try:
        assert connection.execute("SELECT MAX(version) FROM schema_version").fetchone() == (8,)
        assert connection.execute("SELECT id FROM courses").fetchall() == []
        assert connection.execute("SELECT active_course_id FROM app_state WHERE id=1").fetchone() == (None,)
        assert connection.execute(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'p1_%'"
        ).fetchall() == []
    finally:
        connection.close()
    lease = CoreLease.acquire(root, ownership_token)
    lease.close()


def test_v8_migration_manifest_attests_exact_numbered_bytes(database: Phase1Database):
    manifest = json.loads((MIGRATIONS_ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert [entry["version"] for entry in manifest] == list(range(1, 9))
    assert [entry["name"] for entry in manifest] == [
        "001_init.sql",
        "002_stage_layer.sql",
        "003_kp_source_denorm.sql",
        "004_document_file.sql",
        "005_qi_generator.sql",
        "006_review_idempotency.sql",
        "007_book_library.sql",
        "008_book_usage_cleanup.sql",
    ]
    assert [
        hashlib.sha256((MIGRATIONS_ROOT / entry["name"]).read_bytes()).hexdigest()
        for entry in manifest
    ] == [entry["sha256"] for entry in manifest]


@pytest.mark.parametrize(
    ("column", "illegal"),
    [
        ("status", "pending"),
        ("stage", "chunk"),
        ("retry_count", -1),
        ("retry_count", 2),
    ],
)
def test_run_control_rejects_illegal_status_stage_and_retry(
    database: Phase1Database,
    column: str,
    illegal: object,
):
    with database.write_transaction() as connection:
        connection.execute(
            "INSERT INTO documents(id,course_id,name,source_type,imported_at) VALUES(?,?,?,?,?)",
            ("doc_" + "1" * 20, "crs_p1_fixture", "fixture.txt", "txt", NOW),
        )
        connection.execute(
            "INSERT INTO import_jobs(id,document_id,stage,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            ("job_" + "2" * 20, "doc_" + "1" * 20, "source", "pending", NOW, NOW),
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(RUN_CONTROL_INSERT, _run_control_values(**{column: illegal}))


@pytest.mark.parametrize(
    ("attempt_number", "status"),
    [(0, "started"), (3, "started"), (1, "pending")],
)
def test_generation_attempts_reject_illegal_attempt_numbers_and_statuses(
    database: Phase1Database,
    attempt_number: int,
    status: str,
):
    with database.write_transaction() as connection:
        _seed_run(connection)
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO p1_generation_attempts(
                  id,job_id,attempt_number,request_digest,provider_idempotency_key,status,created_at
                ) VALUES(?,?,?,?,?,?,?)
                """,
                ("att_" + "3" * 20, "job_" + "2" * 20, attempt_number, DIGEST, "provider-key", status, NOW),
            )


@pytest.mark.parametrize(
    ("candidate_type", "review_status"),
    [("", "pending"), ("definition", "pending"), ("procedure", "pending"), ("concept", "approved")],
)
def test_candidates_reject_illegal_types_and_statuses(
    database: Phase1Database,
    candidate_type: str,
    review_status: str,
):
    with database.write_transaction() as connection:
        _seed_run(connection)
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO p1_candidates(id,job_id,ordinal,type,title,statement,review_status,created_at)
                VALUES(?,?,?,?,?,?,?,?)
                """,
                (
                    "cand_" + "4" * 20,
                    "job_" + "2" * 20,
                    0,
                    candidate_type,
                    "title",
                    "statement",
                    review_status,
                    NOW,
                ),
            )


@pytest.mark.parametrize("sequence", [-1, 3])
def test_candidate_evidence_rejects_illegal_sequences(database: Phase1Database, sequence: int):
    with database.write_transaction() as connection:
        _seed_run(connection)
        connection.execute(
            """
            INSERT INTO p1_candidates(id,job_id,ordinal,type,title,statement,created_at)
            VALUES(?,?,?,?,?,?,?)
            """,
            ("cand_" + "4" * 20, "job_" + "2" * 20, 0, "concept", "title", "statement", NOW),
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO p1_candidate_evidence(
                  candidate_id,seq,quote,text_start,text_end,context_before,context_after
                ) VALUES(?,?,?,?,?,?,?)
                """,
                ("cand_" + "4" * 20, sequence, "quote", 0, 5, "", ""),
            )


@pytest.mark.parametrize(
    ("sequence", "event_type", "stage"),
    [(1, "run.unknown", "source"), (1, "run.created", "chunk"), (0, "run.created", "source")],
)
def test_run_events_reject_illegal_sequence_type_and_stage(
    database: Phase1Database,
    sequence: int,
    event_type: str,
    stage: str,
):
    with database.write_transaction() as connection:
        _seed_run(connection)
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO p1_run_events(job_id,seq,type,stage,created_at) VALUES(?,?,?,?,?)",
                ("job_" + "2" * 20, sequence, event_type, stage, NOW),
            )


def test_write_transaction_rolls_back_and_never_nests(database: Phase1Database):
    with pytest.raises(RuntimeError, match="abort"):
        with database.write_transaction() as connection:
            connection.execute(
                "INSERT INTO courses(id,name,created_at,updated_at) VALUES(?,?,?,?)",
                ("crs_rollback", "rollback", NOW, NOW),
            )
            raise RuntimeError("abort")
    assert database.one("SELECT id FROM courses WHERE id='crs_rollback'") is None

    with database.write_transaction():
        with pytest.raises(CoreProblem) as caught:
            with database.write_transaction():
                pass
        assert caught.value.code == "TRANSACTION_FAILED"


def test_write_transaction_rolls_back_keyboard_interrupt_and_remains_usable(database: Phase1Database):
    interrupted_connection: sqlite3.Connection | None = None

    with pytest.raises(KeyboardInterrupt, match="stop write"):
        with database.write_transaction() as connection:
            interrupted_connection = connection
            connection.execute(
                "INSERT INTO courses(id,name,created_at,updated_at) VALUES(?,?,?,?)",
                ("crs_interrupted", "interrupted", NOW, NOW),
            )
            raise KeyboardInterrupt("stop write")

    assert interrupted_connection is not None
    assert interrupted_connection.in_transaction is False
    assert database.one("SELECT id FROM courses WHERE id='crs_interrupted'") is None

    with database.write_transaction() as connection:
        connection.execute(
            "INSERT INTO courses(id,name,created_at,updated_at) VALUES(?,?,?,?)",
            ("crs_after_interrupt", "after interrupt", NOW, NOW),
        )
    assert database.one("SELECT id FROM courses WHERE id='crs_after_interrupt'") == {
        "id": "crs_after_interrupt"
    }


def test_write_transactions_from_two_threads_wait_and_commit_in_order(database: Phase1Database):
    first_entered = threading.Event()
    second_waiting = threading.Event()
    second_acquired = threading.Event()
    release_first = threading.Event()
    entered_order: list[str] = []
    errors: list[BaseException] = []

    class ObservedLock:
        def __init__(self) -> None:
            self._lock = threading.Lock()

        def __enter__(self) -> "ObservedLock":
            is_second = threading.current_thread().name == "second-writer"
            if is_second:
                second_waiting.set()
            self._lock.acquire()
            if is_second:
                second_acquired.set()
            return self

        def __exit__(self, *_args: object) -> None:
            self._lock.release()

    database._write_lock = ObservedLock()  # type: ignore[assignment]

    def first_writer() -> None:
        try:
            with database.write_transaction() as connection:
                entered_order.append("first")
                connection.execute(
                    "INSERT INTO courses(id,name,created_at,updated_at) VALUES(?,?,?,?)",
                    ("crs_thread_first", "first", NOW, NOW),
                )
                first_entered.set()
                if not release_first.wait(timeout=2):
                    raise AssertionError("first writer was not released")
        except BaseException as exc:
            errors.append(exc)

    def second_writer() -> None:
        try:
            if not first_entered.wait(timeout=2):
                raise AssertionError("first writer did not enter")
            with database.write_transaction() as connection:
                entered_order.append("second")
                connection.execute(
                    "INSERT INTO courses(id,name,created_at,updated_at) VALUES(?,?,?,?)",
                    ("crs_thread_second", "second", NOW, NOW),
                )
        except BaseException as exc:
            errors.append(exc)

    first = threading.Thread(target=first_writer, name="first-writer")
    second = threading.Thread(target=second_writer, name="second-writer")
    first.start()
    second.start()
    try:
        assert first_entered.wait(timeout=2)
        assert second_waiting.wait(timeout=2)
        assert not second_acquired.is_set()
        assert entered_order == ["first"]
    finally:
        release_first.set()
        first.join(timeout=2)
        second.join(timeout=2)

    assert not first.is_alive()
    assert not second.is_alive()
    assert errors == []
    assert entered_order == ["first", "second"]
    assert database.all(
        "SELECT id FROM courses WHERE id LIKE 'crs_thread_%' ORDER BY id"
    ) == [{"id": "crs_thread_first"}, {"id": "crs_thread_second"}]


def test_database_close_attempts_lease_close_and_preserves_connection_error():
    close_calls: list[str] = []

    class FailingConnection:
        def close(self) -> None:
            close_calls.append("connection")
            raise OSError("connection close failed")

    class FailingLease:
        def close(self) -> None:
            close_calls.append("lease")
            raise OSError("lease close failed")

    database = Phase1Database(FailingConnection(), FailingLease())  # type: ignore[arg-type]

    with pytest.raises(OSError, match="connection close failed"):
        database.close()

    assert close_calls == ["connection", "lease"]


def test_failed_open_attempts_all_cleanup_and_preserves_bootstrap_error(
    monkeypatch: pytest.MonkeyPatch,
):
    close_calls: list[str] = []

    class FailingConnection:
        row_factory: object | None = None

        def close(self) -> None:
            close_calls.append("connection")
            raise OSError("connection close failed")

    class FailingLease:
        def close(self) -> None:
            close_calls.append("lease")
            raise OSError("lease close failed")

    connection = FailingConnection()
    lease = FailingLease()

    def fail_bootstrap(_connection: object) -> None:
        raise CoreProblem("DATABASE_UNAVAILABLE", "primary bootstrap failure")

    monkeypatch.setattr(database_module.CoreLease, "acquire", lambda *_args: lease)
    monkeypatch.setattr(database_module, "_prepare_database_file", lambda _lease: (1, 1))
    monkeypatch.setattr(database_module.sqlite3, "connect", lambda *_args, **_kwargs: connection)
    monkeypatch.setattr(database_module, "_assert_same_database_file", lambda *_args: None)
    monkeypatch.setattr(database_module, "configure_pragmas", fail_bootstrap)

    with pytest.raises(CoreProblem) as caught:
        Phase1Database.open("unused", "token", "unused", "unused")

    assert caught.value.code == "DATABASE_UNAVAILABLE"
    assert caught.value.message == "primary bootstrap failure"
    assert close_calls == ["connection", "lease"]


def test_schema_v7_is_refused_before_fixture_or_phase1_schema(tmp_path: Path, ownership_token: str):
    root = tmp_path / "v7"
    root.mkdir()
    initialize_owned_root(root, ownership_token)
    _apply_v8_migrations(root / "phase1.db", count=7)

    with pytest.raises(CoreProblem) as caught:
        _open(root, ownership_token)

    assert caught.value.code == "DATABASE_UNAVAILABLE"
    connection = sqlite3.connect(root / "phase1.db")
    try:
        assert connection.execute("SELECT id FROM courses WHERE id='crs_p1_fixture'").fetchone() is None
        assert connection.execute(
            "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='p1_schema_meta'"
        ).fetchone() is None
    finally:
        connection.close()
    lease = CoreLease.acquire(root, ownership_token)
    lease.close()


def test_foreign_v8_data_is_refused_before_fixture_or_phase1_schema(tmp_path: Path, ownership_token: str):
    root = tmp_path / "foreign"
    root.mkdir()
    initialize_owned_root(root, ownership_token)
    _apply_v8_migrations(root / "phase1.db")
    connection = sqlite3.connect(root / "phase1.db")
    connection.execute(
        "INSERT INTO courses(id,name,created_at,updated_at) VALUES(?,?,?,?)",
        ("crs_user_data", "user data", NOW, NOW),
    )
    connection.commit()
    connection.close()

    with pytest.raises(CoreProblem) as caught:
        _open(root, ownership_token)

    assert caught.value.code == "DATABASE_UNAVAILABLE"
    connection = sqlite3.connect(root / "phase1.db")
    try:
        assert connection.execute("SELECT id FROM courses ORDER BY id").fetchall() == [("crs_user_data",)]
        assert connection.execute(
            "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='p1_schema_meta'"
        ).fetchone() is None
    finally:
        connection.close()
    lease = CoreLease.acquire(root, ownership_token)
    lease.close()


def test_null_course_id_is_refused_before_fixture_or_phase1_schema(tmp_path: Path, ownership_token: str):
    root = tmp_path / "null-course"
    root.mkdir()
    initialize_owned_root(root, ownership_token)
    _apply_v8_migrations(root / "phase1.db")
    connection = sqlite3.connect(root / "phase1.db")
    connection.execute(
        "INSERT INTO courses(id,name,created_at,updated_at) VALUES(NULL,?,?,?)",
        ("null course", NOW, NOW),
    )
    connection.commit()
    connection.close()

    with pytest.raises(CoreProblem) as caught:
        _open(root, ownership_token)

    assert caught.value.code == "DATABASE_UNAVAILABLE"
    connection = sqlite3.connect(root / "phase1.db")
    try:
        assert connection.execute("SELECT count(*) FROM courses WHERE id IS NULL").fetchone() == (1,)
        assert connection.execute("SELECT id FROM courses WHERE id='crs_p1_fixture'").fetchone() is None
        assert connection.execute(
            "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='p1_schema_meta'"
        ).fetchone() is None
    finally:
        connection.close()


def test_existing_phase1_rows_must_have_fixture_lineage(owned_root: Path, ownership_token: str):
    database = _open(owned_root, ownership_token)
    with database.write_transaction() as connection:
        _seed_run(connection)
    database.close()

    raw = sqlite3.connect(owned_root / "phase1.db")
    raw.execute("PRAGMA foreign_keys=OFF")
    raw.execute(
        "UPDATE import_jobs SET document_id=? WHERE id=?",
        ("doc_" + "f" * 20, "job_" + "2" * 20),
    )
    raw.commit()
    raw.close()

    with pytest.raises(CoreProblem) as caught:
        _open(owned_root, ownership_token)

    assert caught.value.code == "DATABASE_UNAVAILABLE"


@pytest.mark.parametrize("mutation", ["extra", "tamper"])
def test_tampered_or_extra_migration_is_rejected_before_schema_application(
    tmp_path: Path,
    ownership_token: str,
    mutation: str,
):
    root = tmp_path / "root"
    root.mkdir()
    initialize_owned_root(root, ownership_token)
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    for source in MIGRATIONS_ROOT.iterdir():
        if source.is_file():
            (migrations / source.name).write_bytes(source.read_bytes())
    if mutation == "extra":
        (migrations / "009_foreign.sql").write_text("SELECT 1;", encoding="utf-8")
    else:
        with (migrations / "001_init.sql").open("ab") as migration:
            migration.write(b"\n-- tampered\n")

    with pytest.raises(CoreProblem) as caught:
        _open(root, ownership_token, migrations)

    assert caught.value.code == "DATABASE_UNAVAILABLE"
    connection = sqlite3.connect(root / "phase1.db")
    try:
        assert connection.execute(
            "SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1"
        ).fetchone() is None
    finally:
        connection.close()


@pytest.mark.parametrize(
    ("table", "insert_sql", "parameters"),
    [
        ("providers", "INSERT INTO providers(role) VALUES(?)", ("chat",)),
        (
            "memory_items",
            "INSERT INTO memory_items(id,kp_id,created_at) VALUES(?,?,?)",
            ("mi_foreign", "kp_guard", NOW),
        ),
        (
            "question_instances",
            "INSERT INTO question_instances(id,memory_item_id,qtype,stem,created_at) VALUES(?,?,?,?,?)",
            ("qi_foreign", "mi_guard", "recall", "stem", NOW),
        ),
        (
            "review_logs",
            "INSERT INTO review_logs(id,memory_item_id,grade,reviewed_at) VALUES(?,?,?,?)",
            ("rv_foreign", "mi_guard", 3, NOW),
        ),
        ("usage_logs", "INSERT INTO usage_logs(id,created_at) VALUES(?,?)", ("usage_foreign", NOW)),
        (
            "file_cleanup_queue",
            "INSERT INTO file_cleanup_queue(id,path,created_at) VALUES(?,?,?)",
            ("cfl_foreign", "/tmp/foreign", NOW),
        ),
        ("kp_keywords", "INSERT INTO kp_keywords(kp_id,keyword) VALUES(?,?)", ("kp_guard", "foreign")),
        ("kp_blanks", "INSERT INTO kp_blanks(kp_id,blank,answer) VALUES(?,?,?)", ("kp_guard", 1, "foreign")),
        ("kp_fts", "INSERT INTO kp_fts(kp_id,body) VALUES(?,?)", ("kp_guard", "foreign")),
    ],
)
def test_disallowed_v8_tables_must_remain_empty(
    owned_root: Path,
    ownership_token: str,
    table: str,
    insert_sql: str,
    parameters: tuple[object, ...],
):
    database = _open(owned_root, ownership_token)
    database.close()
    raw = sqlite3.connect(owned_root / "phase1.db")
    try:
        raw.execute(
            "INSERT INTO documents(id,course_id,name,source_type,imported_at) VALUES(?,?,?,?,?)",
            ("doc_guard", "crs_p1_fixture", "guard.txt", "txt", NOW),
        )
        raw.execute(
            """
            INSERT INTO knowledge_points(
              id,course_id,document_id,type,title,content,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?)
            """,
            ("kp_guard", "crs_p1_fixture", "doc_guard", "concept", "guard", "guard", NOW, NOW),
        )
        if table in {"question_instances", "review_logs"}:
            raw.execute(
                "INSERT INTO memory_items(id,kp_id,created_at) VALUES(?,?,?)",
                ("mi_guard", "kp_guard", NOW),
            )
        raw.execute(insert_sql, parameters)
        raw.commit()
    finally:
        raw.close()

    with pytest.raises(CoreProblem) as caught:
        _open(owned_root, ownership_token)

    assert caught.value.code == "DATABASE_UNAVAILABLE"
