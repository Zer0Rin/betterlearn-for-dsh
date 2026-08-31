"""Explicit SQLite backup/restore; never run during ordinary Core reads."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys
import uuid

from nobei_core.database import assert_schema
from nobei_core.errors import CoreProblem
from nobei_core.ownership import CoreLease


class MaintenanceError(Exception):
    pass


def _outside(path: Path, root: Path) -> None:
    if path == root or root in path.parents:
        raise MaintenanceError('Backup must be outside the data directory')


def _readonly(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=10)


def _validate(connection: sqlite3.Connection) -> None:
    """Only explicit maintenance validates schema/readability, not normal reads."""
    assert_schema(connection)
    if connection.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
        raise MaintenanceError('SQLite backup is corrupt')


def _save(connection: sqlite3.Connection, destination: Path) -> None:
    """Reserve a new private file; never overwrite a user-selected destination."""
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    try:
        target = sqlite3.connect(destination)
        try:
            connection.backup(target)
        finally:
            target.close()
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


def backup(data_root: str | Path, destination: str | Path) -> dict[str, str]:
    root, target = Path(data_root).resolve(), Path(destination).resolve()
    _outside(target, root)
    source = _readonly(root / 'phase1.db')
    try:
        assert_schema(source)
        _save(source, target)
    finally:
        source.close()
    return {'backupPath': str(target)}


def restore(data_root: str | Path, ownership_token: str, source_path: str | Path,
            backup_dir: str | Path) -> dict[str, str]:
    root, source_file = Path(data_root).resolve(), Path(source_path).resolve()
    directory = Path(backup_dir).resolve()
    _outside(source_file, root)
    _outside(directory, root)
    source = _readonly(source_file)
    lease = None
    try:
        # A stable read transaction binds validation and the subsequent backup copy.
        source.execute('BEGIN')
        _validate(source)
        lease = CoreLease.acquire(root, ownership_token)
        current = sqlite3.connect((root / 'phase1.db').as_uri() + '?mode=rw', uri=True, timeout=10)
        try:
            directory.mkdir(parents=True, exist_ok=True)
            previous = directory / f'before-restore-{uuid.uuid4().hex}.sqlite'
            _save(current, previous)
            # SQLite's backup transaction replaces the destination coherently,
            # including when its connection uses WAL. No raw copying/deletion.
            source.backup(current)
        finally:
            current.close()
    finally:
        source.close()
        if lease is not None:
            lease.close()
    return {'restoredFrom': str(source_file), 'previousBackup': str(previous)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    save = commands.add_parser('backup')
    save.add_argument('--data-root', required=True)
    save.add_argument('--to', required=True)
    load = commands.add_parser('restore')
    load.add_argument('--data-root', required=True)
    load.add_argument('--ownership-token', required=True)
    load.add_argument('--from', dest='source', required=True)
    load.add_argument('--backup-dir', required=True)
    args = parser.parse_args(argv)
    try:
        result = (backup(args.data_root, args.to) if args.command == 'backup' else
                  restore(args.data_root, args.ownership_token, args.source, args.backup_dir))
    except CoreProblem as error:
        print(f'{error.code}: {error.message}', file=sys.stderr)
        return 1
    except (MaintenanceError, OSError, sqlite3.Error) as error:
        # Fixed message avoids reflecting paths or command-line credentials.
        message = str(error) if isinstance(error, MaintenanceError) else 'Database operation failed; check source, destination and permissions'
        print(f'MAINTENANCE_FAILED: {message}', file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
