from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from nobei_core import ownership as ownership_module
from nobei_core import database as database_module
from nobei_core.database import Phase1Database
from nobei_core.errors import CoreProblem
from nobei_core.ownership import CoreLease, initialize_owned_root



def _digest_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _database_family_digests(root: Path) -> dict[str, str]:
    return {
        path.name: _digest_file(path)
        for path in sorted(root.glob("phase1.db*"))
        if path.is_file() and not path.is_symlink()
    }


def _open(root: Path, token: str) -> Phase1Database:
    return Phase1Database.open(root, token)


def test_initialize_owned_root_writes_exact_marker_to_empty_directory(tmp_path: Path, ownership_token: str):
    root = tmp_path / "root"
    root.mkdir()

    initialize_owned_root(root, ownership_token)

    marker = root / ".nobei-phase1-owned.json"
    assert stat.S_ISREG(marker.lstat().st_mode)
    assert json.loads(marker.read_text(encoding="utf-8")) == {
        "kind": "phase1-isolated",
        "version": 1,
        "ownershipToken": ownership_token,
    }


@pytest.mark.parametrize("shape", ["missing", "nonempty", "already_marked", "symlink"])
def test_initialize_owned_root_rejects_anything_except_empty_existing_directory(
    tmp_path: Path,
    ownership_token: str,
    shape: str,
):
    root = tmp_path / "root"
    if shape == "missing":
        pass
    elif shape == "nonempty":
        root.mkdir()
        (root / "foreign.txt").write_text("foreign", encoding="utf-8")
    elif shape == "already_marked":
        root.mkdir()
        initialize_owned_root(root, ownership_token)
    else:
        target = tmp_path / "target"
        target.mkdir()
        root.symlink_to(target, target_is_directory=True)

    with pytest.raises(CoreProblem) as caught:
        initialize_owned_root(root, ownership_token)

    assert caught.value.code == "DATABASE_UNAVAILABLE"


def test_core_lease_rejects_wrong_token_without_creating_lock(owned_root: Path):
    with pytest.raises(CoreProblem) as caught:
        CoreLease.acquire(owned_root, "wrong-token")

    assert caught.value.code == "DATABASE_UNAVAILABLE"
    assert not (owned_root / ".nobei-core.lock").exists()


def test_core_lease_rejects_unexpected_root_entry_before_writing_lock(owned_root: Path, ownership_token: str):
    (owned_root / "unexpected").write_text("foreign", encoding="utf-8")

    with pytest.raises(CoreProblem) as caught:
        CoreLease.acquire(owned_root, ownership_token)

    assert caught.value.code == "DATABASE_UNAVAILABLE"
    assert not (owned_root / ".nobei-core.lock").exists()


def test_second_process_lock_conflict_is_stable_and_does_not_touch_database(
    database: Phase1Database,
    owned_root: Path,
    ownership_token: str,
):
    before = _database_family_digests(owned_root)
    script = """
import sys
from pathlib import Path
from nobei_core.errors import CoreProblem
from nobei_core.ownership import CoreLease

try:
    lease = CoreLease.acquire(Path(sys.argv[1]), sys.argv[2])
except CoreProblem as problem:
    print(problem.code, file=sys.stderr)
    raise SystemExit(73)
else:
    lease.close()
    raise SystemExit(0)
"""

    launched = subprocess.run(
        [sys.executable, "-c", script, str(owned_root), ownership_token],
        check=False,
        capture_output=True,
        text=True,
    )

    assert launched.returncode == 73
    assert launched.stdout == ""
    assert launched.stderr.splitlines() == ["CORE_INSTANCE_CONFLICT"]
    assert _database_family_digests(owned_root) == before


def test_close_releases_process_lock(owned_root: Path, ownership_token: str):
    first = CoreLease.acquire(owned_root, ownership_token)
    first.close()
    first.close()

    second = CoreLease.acquire(owned_root, ownership_token)
    second.close()


def test_lease_close_attempts_directory_close_and_preserves_lock_close_error(monkeypatch: pytest.MonkeyPatch):
    close_calls: list[int] = []

    def failing_close(descriptor: int) -> None:
        close_calls.append(descriptor)
        if descriptor == 202:
            raise OSError("lock close failed")
        raise OSError("directory close failed")

    monkeypatch.setattr(ownership_module.fcntl, "flock", lambda *_args: None)
    monkeypatch.setattr(ownership_module.os, "close", failing_close)
    lease = CoreLease(directory_fd=101, lock_fd=202, data_root=Path("unused"))

    with pytest.raises(OSError, match="lock close failed"):
        lease.close()

    assert close_calls == [202, 101]


def test_unmarked_root_is_refused_without_mutation(tmp_path: Path, ownership_token: str):
    root = tmp_path / "unmarked"
    root.mkdir()

    with pytest.raises(CoreProblem) as caught:
        _open(root, ownership_token)

    assert caught.value.code == "DATABASE_UNAVAILABLE"
    assert list(root.iterdir()) == []


def test_symlinked_root_is_refused_before_target_changes(tmp_path: Path, ownership_token: str):
    target = tmp_path / "target"
    target.mkdir()
    initialize_owned_root(target, ownership_token)
    before = {path.name: _digest_file(path) for path in target.iterdir() if path.is_file()}
    alias = tmp_path / "alias"
    alias.symlink_to(target, target_is_directory=True)

    with pytest.raises(CoreProblem) as caught:
        _open(alias, ownership_token)

    assert caught.value.code == "DATABASE_UNAVAILABLE"
    assert {path.name: _digest_file(path) for path in target.iterdir() if path.is_file()} == before


def test_symlinked_marker_is_refused_before_target_changes(tmp_path: Path, ownership_token: str):
    root = tmp_path / "root"
    root.mkdir()
    target = tmp_path / "marker-target"
    target.write_text(
        json.dumps({"kind": "phase1-isolated", "version": 1, "ownershipToken": ownership_token}),
        encoding="utf-8",
    )
    before = _digest_file(target)
    (root / ".nobei-phase1-owned.json").symlink_to(target)

    with pytest.raises(CoreProblem) as caught:
        _open(root, ownership_token)

    assert caught.value.code == "DATABASE_UNAVAILABLE"
    assert _digest_file(target) == before

def test_symlinked_lock_is_refused_before_target_changes(tmp_path: Path, ownership_token: str):
    root = tmp_path / "root"
    root.mkdir()
    initialize_owned_root(root, ownership_token)
    target = tmp_path / "lock-target"
    target.write_bytes(b"do not overwrite")
    before = _digest_file(target)
    (root / ".nobei-core.lock").symlink_to(target)

    with pytest.raises(CoreProblem) as caught:
        _open(root, ownership_token)

    assert caught.value.code == "DATABASE_UNAVAILABLE"
    assert _digest_file(target) == before


@pytest.mark.parametrize("family_name", ["phase1.db", "phase1.db-wal", "phase1.db-shm"])
def test_symlinked_database_family_is_refused_before_target_changes(
    tmp_path: Path,
    ownership_token: str,
    family_name: str,
):
    root = tmp_path / "root"
    root.mkdir()
    initialize_owned_root(root, ownership_token)
    target = tmp_path / "database-target"
    target.write_bytes(b"do not open or overwrite")
    before = _digest_file(target)
    (root / family_name).symlink_to(target)

    with pytest.raises(CoreProblem) as caught:
        _open(root, ownership_token)

    assert caught.value.code == "DATABASE_UNAVAILABLE"
    assert _digest_file(target) == before


@pytest.mark.parametrize("family_name", ["phase1.db", "phase1.db-wal", "phase1.db-shm"])
def test_hardlinked_database_family_is_refused_before_sqlite_open(
    tmp_path: Path,
    ownership_token: str,
    family_name: str,
    monkeypatch: pytest.MonkeyPatch,
):
    root = tmp_path / "root"
    root.mkdir()
    initialize_owned_root(root, ownership_token)
    outside = tmp_path / "outside-database-file"
    outside.write_bytes(b"")
    before = outside.stat()
    os.link(outside, root / family_name)
    sqlite_opened = False

    def forbidden_connect(*_args: object, **_kwargs: object):
        nonlocal sqlite_opened
        sqlite_opened = True
        raise AssertionError("SQLite must not open a hard-linked database-family file")

    monkeypatch.setattr(database_module.sqlite3, "connect", forbidden_connect)

    with pytest.raises(CoreProblem) as caught:
        _open(root, ownership_token)

    after = outside.stat()
    assert caught.value.code == "DATABASE_UNAVAILABLE"
    assert sqlite_opened is False
    assert (after.st_dev, after.st_ino, after.st_size) == (
        before.st_dev,
        before.st_ino,
        before.st_size,
    )
