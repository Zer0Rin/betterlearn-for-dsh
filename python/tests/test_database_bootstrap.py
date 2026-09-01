from pathlib import Path
import sqlite3
import threading
import time
import pytest
from nobei_core.database import Phase1Database
from nobei_core.errors import CoreProblem
NOW = "2026-08-31T00:00:00Z"
PYTHON_ROOT = Path(__file__).resolve().parents[1]


def test_write_transaction_rolls_back_and_never_nests(database: Phase1Database):
    with pytest.raises(RuntimeError, match="abort"):
        with database.write_transaction() as connection:
            connection.execute(
                "INSERT INTO documents(id,filename,created_at,media_type,canonical_text,byte_size,character_count,text_sha256) VALUES(?,?,?,?,'text',4,4,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')",
                ("crs_rollback", "rollback", NOW, "text/plain"),
            )
            raise RuntimeError("abort")
    assert database.one("SELECT id FROM documents WHERE id='crs_rollback'") is None

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
                "INSERT INTO documents(id,filename,created_at,media_type,canonical_text,byte_size,character_count,text_sha256) VALUES(?,?,?,?,'text',4,4,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')",
                ("crs_interrupted", "interrupted", NOW, "text/plain"),
            )
            raise KeyboardInterrupt("stop write")

    assert interrupted_connection is not None
    assert interrupted_connection.in_transaction is False
    assert database.one("SELECT id FROM documents WHERE id='crs_interrupted'") is None

    with database.write_transaction() as connection:
        connection.execute(
            "INSERT INTO documents(id,filename,created_at,media_type,canonical_text,byte_size,character_count,text_sha256) VALUES(?,?,?,?,'text',4,4,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')",
            ("crs_after_interrupt", "after interrupt", NOW, "text/plain"),
        )
    assert database.one("SELECT id FROM documents WHERE id='crs_after_interrupt'") == {
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
                    "INSERT INTO documents(id,filename,created_at,media_type,canonical_text,byte_size,character_count,text_sha256) VALUES(?,?,?,?,'text',4,4,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')",
                    ("crs_thread_first", "first", NOW, "text/plain"),
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
                    "INSERT INTO documents(id,filename,created_at,media_type,canonical_text,byte_size,character_count,text_sha256) VALUES(?,?,?,?,'text',4,4,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')",
                    ("crs_thread_second", "second", NOW, "text/plain"),
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
        "SELECT id FROM documents WHERE id LIKE 'crs_thread_%' ORDER BY id"
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


def test_product_bootstrap_has_only_product_tables_and_pragmas(database):
    assert {row['name'] for row in database.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")} == {
        'schema_meta', 'documents', 'runs', 'generation_attempts', 'candidates',
        'candidate_evidence', 'candidate_reviews', 'knowledge_points',
        'knowledge_point_evidence', 'run_events', 'idempotency_records',
        'learning_courses', 'learning_units', 'learning_assessments',
        'learning_attempts', 'learning_mastery_states',
    }
    assert database.scalar('PRAGMA foreign_keys') == 1
    assert database.scalar('PRAGMA journal_mode') == 'wal'
    assert database.all('PRAGMA foreign_key_check') == []
    assert database.scalar('SELECT COUNT(*) FROM schema_meta') == 1
    assert database.schema_version() == 2


def test_version_one_database_migrates_in_place_without_losing_product_data(
    owned_root, ownership_token
):
    path = owned_root / 'phase1.db'
    schema = (PYTHON_ROOT / 'nobei_core' / 'sql' / '001_product.sql').read_text('utf-8')
    con = sqlite3.connect(path)
    con.executescript(schema)
    con.execute(
        "INSERT INTO documents(id,filename,media_type,canonical_text,byte_size,"
        "character_count,text_sha256,created_at) VALUES(?,?,?,?,?,?,?,?)",
        ('doc_' + 'd' * 20, 'kept.md', 'text/markdown', '保留', 6, 2, 'e' * 64,
         '2026-09-01T00:00:00Z'),
    )
    con.commit()
    con.close()

    db = Phase1Database.open(owned_root, ownership_token)
    try:
        assert db.schema_version() == 2
        assert db.scalar("SELECT filename FROM documents WHERE id=?", ('doc_' + 'd' * 20,)) == 'kept.md'
        assert db.scalar("SELECT COUNT(*) FROM learning_courses") == 0
    finally:
        db.close()


def test_product_reopen_keeps_schema_and_data(owned_root, ownership_token):
    db = Phase1Database.open(owned_root, ownership_token)
    before = db.all('SELECT * FROM schema_meta')
    db.close()
    db = Phase1Database.open(owned_root, ownership_token)
    try:
        assert db.all('SELECT * FROM schema_meta') == before
    finally:
        db.close()


def test_unknown_database_is_refused_without_deleting_data(owned_root, ownership_token):
    path = owned_root / 'phase1.db'
    con = sqlite3.connect(path)
    con.execute('CREATE TABLE unknown_user_data (text TEXT)')
    con.execute("INSERT INTO unknown_user_data VALUES ('keep me')")
    con.commit()
    con.close()
    with pytest.raises(CoreProblem):
        Phase1Database.open(owned_root, ownership_token)
    con = sqlite3.connect(path)
    try:
        assert con.execute('SELECT text FROM unknown_user_data').fetchall() == [('keep me',)]
        assert con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == [('unknown_user_data',)]
    finally:
        con.close()
