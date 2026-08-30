"""Owned-root validation and the single-Core process lease."""

from __future__ import annotations

import errno
import fcntl
import json
import os
import secrets
import stat
from collections.abc import Callable
from pathlib import Path

from nobei_core.errors import CoreProblem


MARKER_NAME = ".nobei-phase1-owned.json"
LOCK_NAME = ".nobei-core.lock"
DATABASE_FAMILY = frozenset({"phase1.db", "phase1.db-wal", "phase1.db-shm"})
ALLOWED_ROOT_ENTRIES = frozenset({MARKER_NAME, LOCK_NAME, *DATABASE_FAMILY})
_NOFOLLOW = os.O_NOFOLLOW
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)


def _unavailable(message: str) -> CoreProblem:
    return CoreProblem("DATABASE_UNAVAILABLE", message)


def _open_directory(data_root: Path) -> int:
    try:
        descriptor = os.open(
            os.fspath(data_root),
            os.O_RDONLY | os.O_DIRECTORY | _NOFOLLOW | _CLOEXEC,
        )
    except OSError as exc:
        raise _unavailable("owned data root is unavailable") from exc
    try:
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            raise _unavailable("owned data root is not a directory")
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _require_regular_entry(directory_fd: int, name: str) -> None:
    try:
        metadata = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except OSError as exc:
        raise _unavailable("owned data root entry is unavailable") from exc
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise _unavailable("owned data root entry is not a private regular file")


def _read_marker(directory_fd: int, ownership_token: str) -> None:
    try:
        descriptor = os.open(
            MARKER_NAME,
            os.O_RDONLY | _NOFOLLOW | _CLOEXEC,
            dir_fd=directory_fd,
        )
    except OSError as exc:
        raise _unavailable("ownership marker is unavailable") from exc
    try:
        marker_metadata = os.fstat(descriptor)
        if not stat.S_ISREG(marker_metadata.st_mode) or marker_metadata.st_nlink != 1:
            raise _unavailable("ownership marker is not a private regular file")
        chunks: list[bytes] = []
        remaining = 4097
        while remaining:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        if remaining == 0:
            raise _unavailable("ownership marker is too large")
        try:
            marker = json.loads(b"".join(chunks).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise _unavailable("ownership marker is invalid") from exc
        expected = {
            "kind": "phase1-isolated",
            "version": 1,
            "ownershipToken": ownership_token,
        }
        if marker != expected:
            raise _unavailable("ownership marker does not match")
    finally:
        os.close(descriptor)


def _release_lease_descriptors(lock_fd: int | None, directory_fd: int | None) -> None:
    primary_error: BaseException | None = None

    def attempt(operation: Callable[..., object], *args: object) -> None:
        nonlocal primary_error
        try:
            operation(*args)
        except BaseException as exc:
            if primary_error is None:
                primary_error = exc

    if lock_fd is not None:
        attempt(fcntl.flock, lock_fd, fcntl.LOCK_UN)
        attempt(os.close, lock_fd)
    if directory_fd is not None:
        attempt(os.close, directory_fd)
    if primary_error is not None:
        raise primary_error


def initialize_owned_root(data_root: str | os.PathLike[str], ownership_token: str) -> None:
    """Mark an empty, pre-created directory as an isolated Phase 1 root."""
    if not isinstance(ownership_token, str) or not ownership_token:
        raise _unavailable("ownership token is invalid")
    root = Path(data_root)
    directory_fd = _open_directory(root)
    descriptor: int | None = None
    try:
        try:
            entries = os.listdir(directory_fd)
        except OSError as exc:
            raise _unavailable("owned data root cannot be inspected") from exc
        if entries:
            raise _unavailable("owned data root is not empty")

        marker = {
            "kind": "phase1-isolated",
            "version": 1,
            "ownershipToken": ownership_token,
        }
        encoded = (json.dumps(marker, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
        try:
            descriptor = os.open(
                MARKER_NAME,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW | _CLOEXEC,
                0o600,
                dir_fd=directory_fd,
            )
            marker_metadata = os.fstat(descriptor)
            if not stat.S_ISREG(marker_metadata.st_mode) or marker_metadata.st_nlink != 1:
                raise _unavailable("ownership marker is not a private regular file")
            view = memoryview(encoded)
            while view:
                written = os.write(descriptor, view)
                view = view[written:]
            os.fsync(descriptor)
            os.fsync(directory_fd)
        except CoreProblem:
            raise
        except OSError as exc:
            raise _unavailable("ownership marker cannot be created") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(directory_fd)


class CoreLease:
    """An advisory, process-scoped exclusive lease for one owned root."""

    def __init__(self, directory_fd: int, lock_fd: int, data_root: Path) -> None:
        self._directory_fd: int | None = directory_fd
        self._lock_fd: int | None = lock_fd
        self.data_root = data_root

    @classmethod
    def acquire(cls, data_root: str | os.PathLike[str], ownership_token: str) -> "CoreLease":
        if not isinstance(ownership_token, str) or not ownership_token:
            raise _unavailable("ownership token is invalid")
        root = Path(data_root)
        directory_fd = _open_directory(root)
        lock_fd: int | None = None
        try:
            try:
                entries = set(os.listdir(directory_fd))
            except OSError as exc:
                raise _unavailable("owned data root cannot be inspected") from exc
            if MARKER_NAME not in entries or not entries <= ALLOWED_ROOT_ENTRIES:
                raise _unavailable("owned data root contents are invalid")
            for name in entries:
                _require_regular_entry(directory_fd, name)
            _read_marker(directory_fd, ownership_token)

            try:
                lock_fd = os.open(
                    LOCK_NAME,
                    os.O_RDWR | os.O_CREAT | _NOFOLLOW | _CLOEXEC,
                    0o600,
                    dir_fd=directory_fd,
                )
                lock_metadata = os.fstat(lock_fd)
                if not stat.S_ISREG(lock_metadata.st_mode) or lock_metadata.st_nlink != 1:
                    raise _unavailable("Core lock is not a private regular file")
            except CoreProblem:
                raise
            except OSError as exc:
                raise _unavailable("Core lock cannot be opened") from exc

            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                if exc.errno in (errno.EACCES, errno.EAGAIN):
                    raise CoreProblem("CORE_INSTANCE_CONFLICT", "another Core owns the data root") from exc
                raise _unavailable("Core lock cannot be acquired") from exc

            lease_record = f"{os.getpid()} {secrets.token_hex(16)}\n".encode("ascii")
            try:
                os.ftruncate(lock_fd, 0)
                os.lseek(lock_fd, 0, os.SEEK_SET)
                view = memoryview(lease_record)
                while view:
                    written = os.write(lock_fd, view)
                    view = view[written:]
                os.fsync(lock_fd)
            except OSError as exc:
                raise _unavailable("Core lock record cannot be written") from exc
            return cls(directory_fd, lock_fd, root)
        except BaseException:
            try:
                _release_lease_descriptors(lock_fd, directory_fd)
            except BaseException:
                pass
            raise

    @property
    def directory_fd(self) -> int:
        if self._directory_fd is None:
            raise _unavailable("Core lease is closed")
        return self._directory_fd

    def close(self) -> None:
        lock_fd, self._lock_fd = self._lock_fd, None
        directory_fd, self._directory_fd = self._directory_fd, None
        _release_lease_descriptors(lock_fd, directory_fd)
