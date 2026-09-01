"""Guarded SQLite bootstrap for the isolated Phase 1 Core."""

from __future__ import annotations

import os
import re
import sqlite3
import stat
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from nobei_core.errors import CoreProblem
from nobei_core.ownership import CoreLease
from nobei_core.repository import recover_interrupted_runs


_PRAGMA_NAME = re.compile(r"[a-z_]+\Z")
_NOFOLLOW = os.O_NOFOLLOW
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
PRODUCT_TABLES_V1 = frozenset({"schema_meta", "documents", "runs", "generation_attempts", "candidates", "candidate_evidence", "candidate_reviews", "knowledge_points", "knowledge_point_evidence", "run_events", "idempotency_records"})
PRODUCT_TABLES = PRODUCT_TABLES_V1 | frozenset({
    "learning_courses", "learning_units", "learning_assessments",
    "learning_attempts", "learning_mastery_states",
})


def assert_schema(connection: sqlite3.Connection) -> None:
    tables = {r[0] for r in connection.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    if tables != PRODUCT_TABLES:
        raise _unavailable("Unsupported database schema. Back up existing data and choose a new empty data directory; automatic migration or deletion is not supported.")
    try:
        version = connection.execute("SELECT id,version FROM schema_meta").fetchall()
        if [tuple(r) for r in version] != [(1, 2)]:
            raise _unavailable("Unsupported BetterLearn product schema version")
    except sqlite3.Error as exc:
        raise _unavailable("Unsupported BetterLearn product schema") from exc


def _schema_version(connection: sqlite3.Connection) -> int | None:
    try:
        rows = connection.execute("SELECT id,version FROM schema_meta").fetchall()
    except sqlite3.Error:
        return None
    if len(rows) != 1 or tuple(rows[0]) not in ((1, 1), (1, 2)):
        return None
    return int(rows[0][1])


def _apply_script(connection: sqlite3.Connection, script_path: Path) -> None:
    try:
        connection.executescript(
            "BEGIN IMMEDIATE;\n" + script_path.read_text(encoding="utf-8") + "\nCOMMIT;"
        )
    except BaseException:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise


def apply_product_schema(connection: sqlite3.Connection, schema_path: Path) -> None:
    existing = connection.execute("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").fetchone()
    if existing is None:
        _apply_script(connection, schema_path)
    tables = {r[0] for r in connection.execute(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )}
    version = _schema_version(connection)
    if tables == PRODUCT_TABLES_V1 and version == 1:
        _apply_script(connection, schema_path.with_name("002_learning.sql"))
    assert_schema(connection)


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
        migrations_root: str | os.PathLike[str] | None = None,
        schema_path: str | os.PathLike[str] | None = None,
    ) -> "Phase1Database":
        """Open product storage; migrations_root is retained only for caller compatibility."""
        lease = CoreLease.acquire(data_root, ownership_token)
        connection: sqlite3.Connection | None = None
        try:
            database_path = Path(data_root) / "phase1.db"
            identity = _prepare_database_file(lease)
            connection = sqlite3.connect(database_path, isolation_level=None, check_same_thread=False)
            _assert_same_database_file(database_path, identity)
            connection.row_factory = sqlite3.Row
            configure_pragmas(connection)
            apply_product_schema(connection, Path(schema_path) if schema_path else Path(__file__).parent / "sql" / "001_product.sql")
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
        row = self._require_connection().execute("SELECT version FROM schema_meta WHERE id=1").fetchone()
        return int(row[0])

    def p1_schema_version(self) -> int:
        row = self._require_connection().execute(
            "SELECT version FROM schema_meta WHERE id=1"
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
