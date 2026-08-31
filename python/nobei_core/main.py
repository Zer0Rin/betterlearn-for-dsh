"""Executable stdio entrypoint for the isolated Phase 1B Core."""

from __future__ import annotations

import signal
import sys
from pathlib import Path
from typing import TextIO

from nobei_core.contract import load_candidate_contract
from nobei_core.database import Phase1Database
from nobei_core.errors import CoreProblem
from nobei_core.rpc import RpcDispatcher, serve
from nobei_core.service import Phase1Core


_USAGE_EXIT = 64
_SOFTWARE_EXIT = 70
_INSTANCE_CONFLICT_EXIT = 73
_SIGINT_EXIT = 130
_SIGTERM_EXIT = 143


class _SignalExit(BaseException):
    def __init__(self, status: int) -> None:
        super().__init__(status)
        self.status = status


class _SignalRestoreError(Exception):
    pass


class _SignalPolicy:
    def __init__(self) -> None:
        self._cleaning_up = False
        self._previous: dict[signal.Signals, signal.Handlers] = {}

    def install(self) -> None:
        for signum in (signal.SIGINT, signal.SIGTERM):
            self._previous[signum] = signal.getsignal(signum)
            signal.signal(signum, self._handle)

    def _handle(self, signum: int, _frame: object) -> None:
        if self._cleaning_up:
            return
        self._cleaning_up = True
        status = _SIGINT_EXIT if signum == signal.SIGINT else _SIGTERM_EXIT
        raise _SignalExit(status)

    def begin_cleanup(self) -> None:
        self._cleaning_up = True

    @property
    def restore_pending(self) -> bool:
        return bool(self._previous)

    def restore(self) -> None:
        first_error: OSError | ValueError | None = None
        for signum in tuple(self._previous):
            previous = self._previous[signum]
            try:
                signal.signal(signum, previous)
            except (OSError, ValueError) as exc:
                if first_error is None:
                    first_error = exc
            else:
                del self._previous[signum]
        if first_error is not None:
            raise _SignalRestoreError from first_error


def _parse_args(argv: list[str]) -> tuple[Path, str] | None:
    if len(argv) != 4:
        return None
    options: dict[str, str] = {}
    for index in (0, 2):
        option = argv[index]
        value = argv[index + 1]
        if option not in ("--data-root", "--ownership-token") or option in options or not value:
            return None
        options[option] = value
    if frozenset(options) != frozenset({"--data-root", "--ownership-token"}):
        return None
    try:
        data_root = Path(options["--data-root"])
    except (TypeError, ValueError, OSError):
        return None
    if not data_root.is_absolute():
        return None
    return data_root, options["--ownership-token"]


def _diagnose(code: str, stderr: TextIO) -> None:
    try:
        stderr.write(code + "\n")
        stderr.flush()
    except (OSError, ValueError, KeyboardInterrupt):
        pass


def main(argv: list[str] | None = None) -> int:
    database: Phase1Database | None = None
    signal_policy = _SignalPolicy()
    status = _SOFTWARE_EXIT
    diagnostic: str | None = None
    try:
        try:
            signal_policy.install()
            arguments = list(sys.argv[1:] if argv is None else argv)
            parsed = _parse_args(arguments)
            if parsed is None:
                status = _USAGE_EXIT
                diagnostic = "INVALID_PARAMS"
            else:
                data_root, ownership_token = parsed
                package_root = Path(__file__).resolve().parents[2]
                contract = load_candidate_contract(package_root)
                database = Phase1Database.open(
                    data_root,
                    ownership_token,
                )
                status = serve(RpcDispatcher(Phase1Core(database, contract)))
        except _SignalExit as requested:
            diagnostic = None
            status = requested.status
        except KeyboardInterrupt:
            diagnostic = None
            status = _SIGINT_EXIT
        except CoreProblem as problem:
            diagnostic = problem.code
            status = (
                _INSTANCE_CONFLICT_EXIT
                if problem.code == "CORE_INSTANCE_CONFLICT"
                else _SOFTWARE_EXIT
            )
        except Exception:
            diagnostic = "DATABASE_UNAVAILABLE"
            status = _SOFTWARE_EXIT
    finally:
        signal_policy.begin_cleanup()
        try:
            if database is not None:
                try:
                    database.close()
                except _SignalExit as requested:
                    diagnostic = None
                    status = requested.status
                except KeyboardInterrupt:
                    diagnostic = None
                    status = _SIGINT_EXIT
                except Exception:
                    if status == 0:
                        diagnostic = "DATABASE_UNAVAILABLE"
                        status = _SOFTWARE_EXIT
        finally:
            while signal_policy.restore_pending:
                try:
                    signal_policy.restore()
                except _SignalExit as requested:
                    diagnostic = None
                    status = requested.status
                    continue
                except KeyboardInterrupt:
                    diagnostic = None
                    status = _SIGINT_EXIT
                    continue
                except _SignalRestoreError:
                    diagnostic = "DATABASE_UNAVAILABLE"
                    status = _SOFTWARE_EXIT
                    break

    if diagnostic is not None:
        _diagnose(diagnostic, sys.stderr)
    return status


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(_SIGINT_EXIT) from None
