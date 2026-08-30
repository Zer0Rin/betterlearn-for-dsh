"""Guarded SQLite bootstrap for the isolated Phase 1 Core."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import stat
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from nobei_core.constants import FIXTURE_COURSE_ID
from nobei_core.errors import CoreProblem
from nobei_core.ownership import CoreLease
from nobei_core.repository import recover_interrupted_runs


_CANONICAL_V8_MIGRATIONS = (
    ("001_init.sql", "28242410c0e07254c4c0e86014f4b58a155cc9007885e568f42fbb2ffa28ee8b"),
    ("002_stage_layer.sql", "572a6a3f42d8c3e094a9ce0f8457cce6468cdf6ef6743545c460f3c7f894af69"),
    ("003_kp_source_denorm.sql", "22cf59c97b746cfa538c0957d589ec99c048c3b0b95b87bae04e0938cbe577b9"),
    ("004_document_file.sql", "d7a3ff2839143841b694378da63e4466f250f7a20bce486e382fc8bcbafcba10"),
    ("005_qi_generator.sql", "ccb46a93b90808e5d70846ff591d7a45678f655cb0fd4b9889faa589b66fc6cf"),
    ("006_review_idempotency.sql", "e8bb8a5a5627176c90939cca687d4337d46710bea5e3d4cc1c475fd2b2212c06"),
    ("007_book_library.sql", "a79c38865a7f38bbaf886fa6bd6660115852634dbc2d44d2f7a2f7de071ac6f4"),
    ("008_book_usage_cleanup.sql", "079b8a1c0f265f44b5ea2afe9f5a08debd4ae77fc2dd51eb16e3bc18d82215a2"),
)
_BASE_TABLES = frozenset(
    {
        "schema_version",
        "courses",
        "documents",
        "import_jobs",
        "chunks",
        "knowledge_points",
        "kp_keywords",
        "kp_evidence",
        "kp_blanks",
        "kp_confirm_log",
        "memory_items",
        "question_instances",
        "review_logs",
        "providers",
        "usage_logs",
        "kp_fts",
        "kp_fts_data",
        "kp_fts_idx",
        "kp_fts_content",
        "kp_fts_docsize",
        "kp_fts_config",
        "app_state",
        "file_cleanup_queue",
    }
)
_P1_TABLES = frozenset(
    {
        "p1_schema_meta",
        "p1_run_control",
        "p1_generation_attempts",
        "p1_candidates",
        "p1_candidate_evidence",
        "p1_run_events",
        "p1_idempotency",
    }
)
_MUST_BE_EMPTY = (
    "providers",
    "memory_items",
    "question_instances",
    "review_logs",
    "usage_logs",
    "file_cleanup_queue",
    "kp_keywords",
    "kp_blanks",
    "kp_fts",
)
_PRAGMA_NAME = re.compile(r"[a-z_]+\Z")
_NOFOLLOW = os.O_NOFOLLOW
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)


def _unavailable(message: str) -> CoreProblem:
    return CoreProblem("DATABASE_UNAVAILABLE", message)


def _close_database_resources(
    connection: sqlite3.Connection | None,
    lease: CoreLease | None,
) -> None:
    primary_error: BaseException | None = None
    for resource in (connection, lease):
        if resource is None:
            continue
        try:
            resource.close()
        except BaseException as exc:
            if primary_error is None:
                primary_error = exc
    if primary_error is not None:
        raise primary_error


def _cleanup_after_primary_error(
    connection: sqlite3.Connection | None,
    lease: CoreLease | None,
) -> None:
    try:
        _close_database_resources(connection, lease)
    except BaseException:
        pass


def _prepare_database_file(lease: CoreLease) -> tuple[int, int]:
    try:
        descriptor = os.open(
            "phase1.db",
            os.O_RDWR | os.O_CREAT | _NOFOLLOW | _CLOEXEC,
            0o600,
            dir_fd=lease.directory_fd,
        )
    except OSError as exc:
        raise _unavailable("Phase 1 database cannot be opened safely") from exc
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise _unavailable("Phase 1 database is not a private regular file")
        return metadata.st_dev, metadata.st_ino
    finally:
        os.close(descriptor)


def _assert_same_database_file(path: Path, identity: tuple[int, int]) -> None:
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise _unavailable("Phase 1 database disappeared during open") from exc
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or (metadata.st_dev, metadata.st_ino) != identity
    ):
        raise _unavailable("Phase 1 database changed during open")


def configure_pragmas(connection: sqlite3.Connection) -> None:
    journal_mode = connection.execute("PRAGMA journal_mode=WAL").fetchone()[0]
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute("PRAGMA synchronous=FULL")
    if str(journal_mode).lower() != "wal":
        raise _unavailable("SQLite WAL mode is unavailable")
    expected = {"foreign_keys": 1, "busy_timeout": 5000, "synchronous": 2}
    for name, value in expected.items():
        if connection.execute(f"PRAGMA {name}").fetchone()[0] != value:
            raise _unavailable("SQLite pragma configuration failed")


def _load_v8_migrations(migrations_root: Path) -> list[str]:
    expected_names = {name for name, _ in _CANONICAL_V8_MIGRATIONS} | {"manifest.json"}
    try:
        if migrations_root.is_symlink() or not migrations_root.is_dir():
            raise _unavailable("v8 migration root is invalid")
        entries = {entry.name for entry in migrations_root.iterdir()}
        if entries != expected_names:
            raise _unavailable("v8 migration set is invalid")
        manifest_path = migrations_root / "manifest.json"
        if manifest_path.is_symlink() or not stat.S_ISREG(manifest_path.lstat().st_mode):
            raise _unavailable("v8 migration manifest is invalid")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except CoreProblem:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _unavailable("v8 migrations cannot be read") from exc

    expected_manifest = [
        {"version": index, "name": name, "sha256": digest}
        for index, (name, digest) in enumerate(_CANONICAL_V8_MIGRATIONS, start=1)
    ]
    if manifest != expected_manifest:
        raise _unavailable("v8 migration manifest does not attest canonical bytes")

    scripts: list[str] = []
    for name, expected_digest in _CANONICAL_V8_MIGRATIONS:
        path = migrations_root / name
        try:
            if path.is_symlink() or not stat.S_ISREG(path.lstat().st_mode):
                raise _unavailable("v8 migration is not a regular file")
            payload = path.read_bytes()
            script = payload.decode("utf-8")
        except CoreProblem:
            raise
        except (OSError, UnicodeDecodeError) as exc:
            raise _unavailable("v8 migration cannot be read") from exc
        if hashlib.sha256(payload).hexdigest() != expected_digest:
            raise _unavailable("v8 migration digest mismatch")
        scripts.append(script)
    return scripts


def apply_v8_if_empty(connection: sqlite3.Connection, migrations_root: Path) -> None:
    has_user_schema = connection.execute(
        "SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1"
    ).fetchone()
    if has_user_schema is not None:
        return
    scripts = _load_v8_migrations(migrations_root)
    try:
        connection.executescript("BEGIN IMMEDIATE;\n" + "\n".join(scripts) + "\nCOMMIT;")
    except sqlite3.Error as exc:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise _unavailable("canonical v8 migrations failed") from exc


def assert_schema_v8(connection: sqlite3.Connection) -> None:
    try:
        versions = [row[0] for row in connection.execute("SELECT version FROM schema_version ORDER BY rowid")]
    except sqlite3.Error as exc:
        raise _unavailable("database is not schema v8") from exc
    if versions != list(range(1, 9)):
        raise _unavailable("database is not schema v8")


def _has_row(connection: sqlite3.Connection, sql: str, parameters: tuple[Any, ...] = ()) -> bool:
    return connection.execute(sql, parameters).fetchone() is not None


def assert_no_foreign_user_data(connection: sqlite3.Connection) -> None:
    try:
        table_names = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        p1_tables = table_names & _P1_TABLES
        if not table_names <= (_BASE_TABLES | _P1_TABLES) or not _BASE_TABLES <= table_names:
            raise _unavailable("database contains unexpected user tables")
        if p1_tables and p1_tables != _P1_TABLES:
            raise _unavailable("database contains a partial Phase 1 schema")
        if _has_row(connection, "SELECT 1 FROM sqlite_schema WHERE type IN ('trigger','view') LIMIT 1"):
            raise _unavailable("database contains unexpected executable schema")
        if _has_row(connection, "PRAGMA foreign_key_check"):
            raise _unavailable("database contains orphaned rows")
        if _has_row(
            connection,
            "SELECT 1 FROM courses WHERE id IS NULL OR id <> ? LIMIT 1",
            (FIXTURE_COURSE_ID,),
        ):
            raise _unavailable("database contains a foreign course")
        if _has_row(
            connection,
            "SELECT 1 FROM app_state WHERE id <> 1 OR (active_course_id IS NOT NULL AND active_course_id <> ?) LIMIT 1",
            (FIXTURE_COURSE_ID,),
        ):
            raise _unavailable("database contains foreign application state")
        if _has_row(
            connection,
            """
            SELECT 1 FROM documents d
            LEFT JOIN courses c ON c.id=d.course_id
            WHERE d.course_id <> ? OR c.id IS NULL LIMIT 1
            """,
            (FIXTURE_COURSE_ID,),
        ):
            raise _unavailable("database contains a foreign document")
        if _has_row(
            connection,
            """
            SELECT 1 FROM chunks c
            LEFT JOIN documents d ON d.id=c.document_id
            WHERE d.id IS NULL OR d.course_id <> ? LIMIT 1
            """,
            (FIXTURE_COURSE_ID,),
        ):
            raise _unavailable("database contains a foreign chunk")
        if _has_row(
            connection,
            """
            SELECT 1 FROM import_jobs j
            LEFT JOIN documents d ON d.id=j.document_id
            WHERE d.id IS NULL OR d.course_id <> ? LIMIT 1
            """,
            (FIXTURE_COURSE_ID,),
        ):
            raise _unavailable("database contains a foreign import job")
        if _has_row(
            connection,
            """
            SELECT 1 FROM knowledge_points k
            LEFT JOIN documents d ON d.id=k.document_id
            LEFT JOIN chunks c ON c.id=k.chunk_id
            WHERE k.course_id <> ? OR d.id IS NULL OR d.course_id <> ?
              OR (k.chunk_id IS NOT NULL AND (c.id IS NULL OR c.document_id <> k.document_id))
            LIMIT 1
            """,
            (FIXTURE_COURSE_ID, FIXTURE_COURSE_ID),
        ):
            raise _unavailable("database contains a foreign knowledge point")
        if _has_row(
            connection,
            """
            SELECT 1 FROM kp_evidence e
            LEFT JOIN knowledge_points k ON k.id=e.kp_id
            WHERE k.id IS NULL OR k.course_id <> ? LIMIT 1
            """,
            (FIXTURE_COURSE_ID,),
        ):
            raise _unavailable("database contains foreign evidence")

        confirmation_sql = """
            SELECT 1 FROM kp_confirm_log c
            WHERE NOT EXISTS (SELECT 1 FROM knowledge_points k WHERE k.id=c.kp_id)
        """
        if p1_tables:
            confirmation_sql += " AND NOT EXISTS (SELECT 1 FROM p1_candidates p WHERE p.id=c.kp_id)"
        confirmation_sql += " LIMIT 1"
        if _has_row(connection, confirmation_sql):
            raise _unavailable("database contains a foreign confirmation")

        for table in _MUST_BE_EMPTY:
            if _has_row(connection, f"SELECT 1 FROM {table} LIMIT 1"):
                raise _unavailable("database contains disallowed user data")

        if p1_tables:
            if [tuple(row) for row in connection.execute(
                "SELECT id,version FROM p1_schema_meta ORDER BY id"
            ).fetchall()] != [(1, 1)]:
                raise _unavailable("Phase 1 schema version is invalid")
            if _has_row(
                connection,
                """
                SELECT 1 FROM p1_run_control r
                LEFT JOIN import_jobs j ON j.id=r.job_id
                LEFT JOIN documents d ON d.id=j.document_id
                WHERE j.id IS NULL OR d.id IS NULL OR d.course_id <> ? LIMIT 1
                """,
                (FIXTURE_COURSE_ID,),
            ):
                raise _unavailable("Phase 1 run lineage is foreign")
            if _has_row(
                connection,
                """
                SELECT 1 FROM p1_candidates c
                LEFT JOIN p1_run_control r ON r.job_id=c.job_id
                LEFT JOIN knowledge_points k ON k.id=c.accepted_kp_id
                WHERE r.job_id IS NULL
                   OR (c.accepted_kp_id IS NOT NULL AND (k.id IS NULL OR k.course_id <> ?))
                LIMIT 1
                """,
                (FIXTURE_COURSE_ID,),
            ):
                raise _unavailable("Phase 1 candidate lineage is foreign")
            for table in ("p1_generation_attempts", "p1_run_events"):
                if _has_row(
                    connection,
                    f"""
                    SELECT 1 FROM {table} child
                    LEFT JOIN p1_run_control r ON r.job_id=child.job_id
                    WHERE r.job_id IS NULL LIMIT 1
                    """,
                ):
                    raise _unavailable("Phase 1 child lineage is foreign")
            if _has_row(
                connection,
                """
                SELECT 1 FROM p1_candidate_evidence e
                LEFT JOIN p1_candidates c ON c.id=e.candidate_id
                WHERE c.id IS NULL LIMIT 1
                """,
            ):
                raise _unavailable("Phase 1 evidence lineage is foreign")
    except CoreProblem:
        raise
    except sqlite3.Error as exc:
        raise _unavailable("database user-data guard failed") from exc


def _ensure_fixture_course(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        INSERT INTO courses(id,name,created_at,updated_at,frozen_at)
        VALUES(?, 'Phase 1 Fixture', strftime('%Y-%m-%dT%H:%M:%SZ','now'),
               strftime('%Y-%m-%dT%H:%M:%SZ','now'), NULL)
        ON CONFLICT(id) DO UPDATE SET frozen_at=NULL
        """,
        (FIXTURE_COURSE_ID,),
    )
    connection.execute(
        """
        UPDATE app_state
        SET active_course_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id=1
        """,
        (FIXTURE_COURSE_ID,),
    )
    if connection.execute("SELECT changes()").fetchone()[0] != 1:
        raise _unavailable("schema v8 application state is invalid")


def _phase1_tables(connection: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'p1_%'"
        )
    }


def _assert_phase1_schema(connection: sqlite3.Connection) -> None:
    if _phase1_tables(connection) != _P1_TABLES:
        raise _unavailable("Phase 1 schema is incomplete")
    if [tuple(row) for row in connection.execute(
        "SELECT id,version FROM p1_schema_meta ORDER BY id"
    ).fetchall()] != [(1, 1)]:
        raise _unavailable("Phase 1 schema version is invalid")


def _read_phase1_schema(schema_path: Path) -> str:
    try:
        if schema_path.is_symlink() or not stat.S_ISREG(schema_path.lstat().st_mode):
            raise _unavailable("Phase 1 schema file is invalid")
        return schema_path.read_text(encoding="utf-8")
    except CoreProblem:
        raise
    except (OSError, UnicodeDecodeError) as exc:
        raise _unavailable("Phase 1 schema cannot be read") from exc


def _execute_sql_statements(connection: sqlite3.Connection, script: str) -> None:
    pending = ""
    for line in script.splitlines(keepends=True):
        pending += line
        if sqlite3.complete_statement(pending):
            connection.execute(pending)
            pending = ""
    if pending.strip():
        raise _unavailable("Phase 1 schema contains an incomplete statement")


def apply_phase1_bootstrap(connection: sqlite3.Connection, schema_path: Path) -> None:
    existing = _phase1_tables(connection)
    if existing:
        _assert_phase1_schema(connection)
        script: str | None = None
    else:
        script = _read_phase1_schema(schema_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        _ensure_fixture_course(connection)
        if script is not None:
            _execute_sql_statements(connection, script)
        _assert_phase1_schema(connection)
        connection.execute("COMMIT")
    except BaseException:
        if connection.in_transaction:
            try:
                connection.execute("ROLLBACK")
            except BaseException:
                pass
        raise


class Phase1Database:
    """One guarded SQLite connection held under a process lease."""

    def __init__(self, connection: sqlite3.Connection, lease: CoreLease) -> None:
        self._connection: sqlite3.Connection | None = connection
        self._lease: CoreLease | None = lease
        self._write_lock = threading.Lock()
        self._write_context = threading.local()

    @classmethod
    def open(
        cls,
        data_root: str | os.PathLike[str],
        ownership_token: str,
        migrations_root: str | os.PathLike[str],
        schema_path: str | os.PathLike[str],
    ) -> "Phase1Database":
        lease = CoreLease.acquire(data_root, ownership_token)
        connection: sqlite3.Connection | None = None
        try:
            database_path = Path(data_root) / "phase1.db"
            identity = _prepare_database_file(lease)
            connection = sqlite3.connect(database_path, isolation_level=None, check_same_thread=False)
            _assert_same_database_file(database_path, identity)
            connection.row_factory = sqlite3.Row
            configure_pragmas(connection)
            apply_v8_if_empty(connection, Path(migrations_root))
            assert_schema_v8(connection)
            assert_no_foreign_user_data(connection)
            apply_phase1_bootstrap(connection, Path(schema_path))
            database = cls(connection, lease)
            recover_interrupted_runs(database)
            return database
        except CoreProblem:
            _cleanup_after_primary_error(connection, lease)
            raise
        except (OSError, sqlite3.Error) as exc:
            _cleanup_after_primary_error(connection, lease)
            raise _unavailable("Phase 1 database bootstrap failed") from exc
        except BaseException:
            _cleanup_after_primary_error(connection, lease)
            raise

    def _require_connection(self) -> sqlite3.Connection:
        if self._connection is None:
            raise _unavailable("Phase 1 database is closed")
        return self._connection

    def schema_version(self) -> int:
        row = self._require_connection().execute("SELECT MAX(version) FROM schema_version").fetchone()
        return int(row[0])

    def p1_schema_version(self) -> int:
        row = self._require_connection().execute(
            "SELECT version FROM p1_schema_meta WHERE id=1"
        ).fetchone()
        return int(row[0])

    def pragma(self, name: str) -> Any:
        if not isinstance(name, str) or _PRAGMA_NAME.fullmatch(name) is None:
            raise ValueError("invalid pragma name")
        return self._require_connection().execute(f"PRAGMA {name}").fetchone()[0]

    def one(self, sql: str, parameters: tuple[Any, ...] = ()) -> dict[str, Any] | None:
        row = self._require_connection().execute(sql, parameters).fetchone()
        return dict(row) if row is not None else None

    def all(self, sql: str, parameters: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        return [dict(row) for row in self._require_connection().execute(sql, parameters).fetchall()]

    def scalar(self, sql: str, parameters: tuple[Any, ...] = ()) -> Any:
        row = self._require_connection().execute(sql, parameters).fetchone()
        return row[0] if row is not None else None

    @contextmanager
    def read_snapshot(self) -> Iterator[sqlite3.Connection]:
        """Hold the single-connection access lock across a complete logical read."""
        if getattr(self._write_context, "active", False):
            yield self._require_connection()
            return
        depth = getattr(self._write_context, "read_depth", 0)
        if depth:
            self._write_context.read_depth = depth + 1
            try:
                yield self._require_connection()
            finally:
                self._write_context.read_depth = depth
            return
        with self._write_lock:
            self._write_context.read_depth = 1
            try:
                yield self._require_connection()
            finally:
                self._write_context.read_depth = 0

    @contextmanager
    def write_transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self._require_connection()
        if getattr(self._write_context, "active", False) or getattr(
            self._write_context, "read_depth", 0
        ):
            raise CoreProblem("TRANSACTION_FAILED", "nested write transactions are forbidden")
        with self._write_lock:
            if connection.in_transaction:
                raise CoreProblem("TRANSACTION_FAILED", "nested write transactions are forbidden")
            self._write_context.active = True
            try:
                connection.execute("BEGIN IMMEDIATE")
                yield connection
                connection.execute("COMMIT")
            except BaseException:
                if connection.in_transaction:
                    try:
                        connection.execute("ROLLBACK")
                    except BaseException:
                        pass
                raise
            finally:
                self._write_context.active = False

    def close(self) -> None:
        connection, self._connection = self._connection, None
        lease, self._lease = self._lease, None
        _close_database_resources(connection, lease)
