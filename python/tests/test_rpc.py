from __future__ import annotations

import hashlib
import io
import json
import os
import signal
import subprocess
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

from nobei_core.constants import RPC_LINE_MAX_BYTES, RPC_METHODS
from nobei_core.contract import load_candidate_contract
from nobei_core.database import Phase1Database
from nobei_core.rpc import RpcDispatcher, serve

from conftest import PYTHON_ROOT


PACKAGE_ROOT = PYTHON_ROOT.parent
SCHEMA_SENTINEL = "__RUNTIME_SCHEMA_SHA256__"
MODEL_SELECTION = {
    "provider": "provider-fixture",
    "model": "model-fixture",
    "reasoningEffort": "medium",
}


def _compact(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"
    ).encode("utf-8")


def _request(request_id: str | int, method: str, params: object) -> dict[str, object]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params,
    }


def _error(request_id: str | int | None, numeric: int, code: str, **data: object) -> dict[str, object]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {
            "code": numeric,
            "message": code,
            "data": {"code": code, **data},
        },
    }


def _runtime_fixture(name: str, replacements: dict[str, object]) -> dict[str, object]:
    fixture = json.loads((PACKAGE_ROOT / "contracts" / "rpc" / name).read_text("utf-8"))

    def replace(value: object) -> object:
        if isinstance(value, list):
            return [replace(item) for item in value]
        if isinstance(value, dict):
            return {key: replace(item) for key, item in value.items()}
        return replacements.get(value, value) if isinstance(value, str) else value

    resolved = replace(fixture)
    assert isinstance(resolved, dict)
    return resolved


@contextmanager
def _core_process(
    owned_root: Path,
    ownership_token: str,
    *,
    env: dict[str, str] | None = None,
) -> Iterator[subprocess.Popen[bytes]]:
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "nobei_core.main",
            "--data-root",
            os.fspath(owned_root),
            "--ownership-token",
            ownership_token,
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    try:
        yield process
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=5)


def _send(process: subprocess.Popen[bytes], request: object) -> None:
    assert process.stdin is not None
    process.stdin.write(_compact(request))
    process.stdin.flush()


def _read(process: subprocess.Popen[bytes]) -> tuple[bytes, dict[str, object]]:
    assert process.stdout is not None
    line = process.stdout.readline()
    assert line.endswith(b"\n")
    assert line.count(b"\n") == 1
    decoded = json.loads(line)
    assert isinstance(decoded, dict)
    return line, decoded


def _hello(contract_sha: str, request_id: str | int = "rpc_hello") -> dict[str, object]:
    return _request(
        request_id,
        "system.hello",
        {
            "protocolVersion": 3,
            "schemaVersion": 1,
            "schemaSha256": contract_sha,
        },
    )


def _finish(process: subprocess.Popen[bytes]) -> tuple[bytes, bytes]:
    assert process.stdin is not None
    process.stdin.close()
    process.stdin = None
    stdout, stderr = process.communicate(timeout=5)
    return stdout, stderr


def test_hello_fixture_resolves_runtime_schema_and_returns_exact_closed_result(
    owned_root: Path, ownership_token: str
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    fixture = _runtime_fixture("hello-v3.json", {SCHEMA_SENTINEL: contract.schema_sha256})
    fixture_bytes = (PACKAGE_ROOT / "contracts" / "rpc" / "hello-v3.json").read_bytes()
    assert SCHEMA_SENTINEL.encode("ascii") in fixture_bytes
    assert contract.schema_sha256.encode("ascii") not in fixture_bytes

    with _core_process(owned_root, ownership_token) as process:
        _send(process, fixture["request"])
        raw, response = _read(process)
        assert response == fixture["response"]
        assert raw == _compact(fixture["response"])
        trailing_stdout, stderr = _finish(process)

    assert process.returncode == 0
    assert trailing_stdout == b""
    assert stderr == b""
    assert SCHEMA_SENTINEL.encode("ascii") not in raw


def test_handshake_is_mandatory_and_exact_but_errors_do_not_poison_session(
    owned_root: Path, ownership_token: str
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    before_hello = _request("before", "runs.get", {"runId": "job_0123456789abcdefabcd"})
    wrong_protocol = _hello(contract.schema_sha256, "wrong-protocol")
    wrong_protocol["params"] = {
        "protocolVersion": 1,
        "schemaVersion": 1,
        "schemaSha256": contract.schema_sha256,
    }
    wrong_schema = _hello("0" * 64, "wrong-schema")
    sentinel = _hello(SCHEMA_SENTINEL, "sentinel")

    with _core_process(owned_root, ownership_token) as process:
        for request in (before_hello, wrong_protocol, wrong_schema, sentinel):
            _send(process, request)
            assert _read(process)[1] == _error(request["id"], -32000, "PROTOCOL_MISMATCH")
        _send(process, _hello(contract.schema_sha256, 17))
        assert _read(process)[1]["id"] == 17
        stdout, stderr = _finish(process)

    assert process.returncode == 0
    assert stdout == stderr == b""


def test_dispatcher_returns_exact_numeric_error_families_and_preserves_ids(
    owned_root: Path, ownership_token: str
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    cases = (
        (_request("unknown", "core.__dict__", {}), _error("unknown", -32601, "METHOD_NOT_FOUND")),
        (_request("params", "runs.get", []), _error("params", -32602, "INVALID_PARAMS")),
        (
            {"jsonrpc": "2.0", "id": 23, "method": "runs.get", "params": {}, "extra": True},
            _error(23, -32600, "INVALID_REQUEST"),
        ),
        (
            _request("domain", "documents.import_text", {"filename": "../secret", "mediaType": "text/plain", "text": "never-echo-this-document"}),
            _error("domain", -32000, "INVALID_DOCUMENT"),
        ),
    )

    with _core_process(owned_root, ownership_token) as process:
        _send(process, _hello(contract.schema_sha256))
        _read(process)
        for request, expected in cases:
            _send(process, request)
            raw, response = _read(process)
            assert response == expected
            assert b"never-echo-this-document" not in raw
        stdout, stderr = _finish(process)

    assert process.returncode == 0
    assert stdout == stderr == b""


def test_public_error_data_is_flattened_and_bounded(
    owned_root: Path, ownership_token: str
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    request = _request(
        "too-large-document",
        "documents.import_text",
        {"filename": "chapter.txt", "mediaType": "text/plain", "text": "x" * 524_289},
    )
    with _core_process(owned_root, ownership_token) as process:
        _send(process, _hello(contract.schema_sha256))
        _read(process)
        _send(process, request)
        response = _read(process)[1]
        stdout, stderr = _finish(process)

    assert response == _error(
        "too-large-document",
        -32000,
        "REQUEST_TOO_LARGE",
        actualBytes=524_289,
        maxBytes=524_288,
    )
    assert process.returncode == 0
    assert stdout == stderr == b""


def test_syntactically_invalid_json_gets_parse_response_then_session_continues(
    owned_root: Path, ownership_token: str
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    payload = b'{"jsonrpc":\n' + _compact(_hello(contract.schema_sha256, "after-parse"))
    with _core_process(owned_root, ownership_token) as process:
        stdout, stderr = process.communicate(payload, timeout=5)

    lines = stdout.splitlines(keepends=True)
    assert len(lines) == 2
    assert all(line.endswith(b"\n") and line.count(b"\n") == 1 for line in lines)
    assert json.loads(lines[0]) == _error(None, -32700, "INVALID_REQUEST")
    assert json.loads(lines[1])["id"] == "after-parse"
    assert process.returncode == 0
    assert stderr == b""


def test_json_integer_over_runtime_conversion_limit_is_a_recoverable_parse_error(
    owned_root: Path, ownership_token: str
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    oversized_integer = b'{"jsonrpc":"2.0","id":' + (b"9" * 5_000) + b',"method":"system.hello","params":{}}\n'
    payload = oversized_integer + _compact(_hello(contract.schema_sha256, "after-integer"))
    with _core_process(owned_root, ownership_token) as process:
        stdout, stderr = process.communicate(payload, timeout=5)

    lines = stdout.splitlines()
    assert [json.loads(line) for line in lines] == [
        _error(None, -32700, "INVALID_REQUEST"),
        {
            "jsonrpc": "2.0",
            "id": "after-integer",
            "result": {
                    "protocolVersion": 3,
                    "coreVersion": "phase1e",
                "databaseKind": "sqlite",
                    "capabilities": [
                        "l1-text-extraction",
                        "atomic-generation-commands",
                        "model-selection-snapshot",
                    ],
                "schemaVersion": 1,
                "schemaSha256": contract.schema_sha256,
                "dataRootKind": "isolated-phase1",
            },
        },
    ]
    assert process.returncode == 0
    assert stderr == b""


def test_duplicate_members_at_any_depth_are_parse_errors_and_cannot_complete_hello(
    owned_root: Path, ownership_token: str
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    duplicate_method = (
        '{"jsonrpc":"2.0","id":"duplicate-method",'
        '"method":"runs.get","method":"system.hello",'
        f'"params":{{"protocolVersion":1,"schemaVersion":1,"schemaSha256":"{contract.schema_sha256}"}}}}\n'
    ).encode("utf-8")
    duplicate_schema_sha = (
        '{"jsonrpc":"2.0","id":"duplicate-schema","method":"system.hello",'
        f'"params":{{"protocolVersion":1,"schemaVersion":1,"schemaSha256":"0",'
        f'"schemaSha256":"{contract.schema_sha256}"}}}}\n'
    ).encode("utf-8")
    business = _compact(
        _request("still-gated", "runs.get", {"runId": "job_0123456789abcdefabcd"})
    )

    with _core_process(owned_root, ownership_token) as process:
        stdout, stderr = process.communicate(
            duplicate_method + duplicate_schema_sha + business,
            timeout=5,
        )

    assert [json.loads(line) for line in stdout.splitlines()] == [
        _error(None, -32700, "INVALID_REQUEST"),
        _error(None, -32700, "INVALID_REQUEST"),
        _error("still-gated", -32000, "PROTOCOL_MISMATCH"),
    ]
    assert process.returncode == 0
    assert stderr == b""


def test_nonstandard_constants_deep_json_and_huge_integer_recover_before_hello(
    owned_root: Path, ownership_token: str
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    constant_frames = b"".join(
        b'{"jsonrpc":"2.0","id":"constant","method":"system.hello","params":{"value":'
        + value
        + b"}}\n"
        for value in (b"NaN", b"Infinity", b"-Infinity")
    )
    deep_frame = b"[" * 1_500 + b"0" + b"]" * 1_500 + b"\n"
    huge_integer = b'{"jsonrpc":"2.0","id":' + b"9" * 5_000 + b',"method":"system.hello","params":{}}\n'
    with _core_process(owned_root, ownership_token) as process:
        stdout, stderr = process.communicate(
            constant_frames
            + deep_frame
            + huge_integer
            + _compact(_hello(contract.schema_sha256, "after-adversarial-json")),
            timeout=5,
        )

    responses = [json.loads(line) for line in stdout.splitlines()]
    assert responses[:3] == [_error(None, -32700, "INVALID_REQUEST")] * 3
    assert responses[3] == _error(None, -32600, "INVALID_REQUEST")
    assert responses[4] == _error(None, -32700, "INVALID_REQUEST")
    assert responses[5]["id"] == "after-adversarial-json"
    assert process.returncode == 0
    assert stderr == b""


def test_request_id_types_and_utf8_are_closed_under_ascii_python_io_encoding(
    owned_root: Path, ownership_token: str
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    invalid_ids = (True, None, [], {}, 1.5)
    invalid_frames = b"".join(
        _compact({"jsonrpc": "2.0", "id": value, "method": "system.hello", "params": {}})
        for value in invalid_ids
    )
    surrogate_frame = (
        b'{"jsonrpc":"2.0","id":"\\ud800","method":"system.hello",'
        + f'"params":{{"protocolVersion":1,"schemaVersion":1,"schemaSha256":"{contract.schema_sha256}"}}}}\n'.encode()
    )
    child_env = dict(os.environ)
    child_env["PYTHONIOENCODING"] = "ascii"
    with _core_process(owned_root, ownership_token, env=child_env) as process:
        stdout, stderr = process.communicate(
            invalid_frames
            + surrogate_frame
            + _compact(_hello(contract.schema_sha256, "请求-编号")),
            timeout=5,
        )

    responses = [json.loads(line) for line in stdout.splitlines()]
    assert responses[:6] == [_error(None, -32600, "INVALID_REQUEST")] * 6
    assert responses[6]["id"] == "请求-编号"
    assert "请求-编号".encode("utf-8") in stdout
    assert process.returncode == 0
    assert stderr == b""


def _request_line_of_size(size: int) -> bytes:
    request = _request("boundary", "unknown.boundary", {"padding": ""})
    empty = _compact(request)
    padding_size = size - len(empty)
    assert padding_size >= 0
    request["params"] = {"padding": "x" * padding_size}
    encoded = _compact(request)
    assert len(encoded) == size
    return encoded


def test_input_limit_accepts_exactly_2_mib_and_rejects_the_next_byte_without_dispatch(
    owned_root: Path, ownership_token: str
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    with _core_process(owned_root, ownership_token) as exact:
        stdout, stderr = exact.communicate(
            _request_line_of_size(RPC_LINE_MAX_BYTES), timeout=5
        )
    assert json.loads(stdout) == _error("boundary", -32601, "METHOD_NOT_FOUND")
    assert exact.returncode == 0
    assert stderr == b""

    with _core_process(owned_root, ownership_token) as over:
        stdout, stderr = over.communicate(
            _request_line_of_size(RPC_LINE_MAX_BYTES + 1)
            + _compact(_hello(contract.schema_sha256, "must-not-open")),
            timeout=5,
        )
    assert over.returncode == 65
    assert stdout == b""
    assert stderr == b"RPC_MESSAGE_TOO_LARGE\n"


@pytest.mark.parametrize(
    ("bad_frame", "diagnostic"),
    (
        (b"x" * RPC_LINE_MAX_BYTES + b"\n", b"RPC_MESSAGE_TOO_LARGE\n"),
        (b"\xff\n", b"INVALID_REQUEST\n"),
    ),
    ids=("overlong", "invalid-utf8"),
)
def test_fatal_framing_stops_before_a_following_valid_request(
    owned_root: Path,
    ownership_token: str,
    bad_frame: bytes,
    diagnostic: bytes,
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    second = _compact(_request("must-not-open", "documents.import_text", {
        "filename": "not-opened.txt",
        "mediaType": "text/plain",
        "text": "must-not-be-persisted",
    }))
    with _core_process(owned_root, ownership_token) as process:
        stdout, stderr = process.communicate(bad_frame + second, timeout=5)

    assert process.returncode == 65
    assert stdout == b""
    assert stderr == diagnostic
    assert b"Traceback" not in stderr
    opened = Phase1Database.open(owned_root, ownership_token)
    try:
        assert opened.scalar("SELECT COUNT(*) FROM runs") == 0
    finally:
        opened.close()


def test_unterminated_frame_is_fatal_and_bounded(
    owned_root: Path, ownership_token: str
) -> None:
    with _core_process(owned_root, ownership_token) as process:
        stdout, stderr = process.communicate(b"{}", timeout=5)

    assert process.returncode == 65
    assert stdout == b""
    assert stderr == b"INVALID_REQUEST\n"


def test_lock_conflict_exits_73_without_protocol_output_and_eof_releases_lock(
    owned_root: Path, ownership_token: str
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    with _core_process(owned_root, ownership_token) as first:
        _send(first, _hello(contract.schema_sha256, "lock-owner"))
        assert _read(first)[1]["id"] == "lock-owner"
        with _core_process(owned_root, ownership_token) as second:
            second_stdout, second_stderr = second.communicate(timeout=5)
        assert second.returncode == 73
        assert second_stdout == b""
        assert second_stderr == b"CORE_INSTANCE_CONFLICT\n"
        first_stdout, first_stderr = _finish(first)
    assert first.returncode == 0
    assert first_stdout == first_stderr == b""

    with _core_process(owned_root, ownership_token) as reopened:
        _send(reopened, _hello(contract.schema_sha256, "after-eof"))
        assert _read(reopened)[1]["id"] == "after-eof"
        stdout, stderr = _finish(reopened)
    assert reopened.returncode == 0
    assert stdout == stderr == b""


@pytest.mark.parametrize(
    ("sent_signal", "expected_status"),
    ((signal.SIGINT, 130), (signal.SIGTERM, 143)),
    ids=("sigint", "sigterm"),
)
def test_signals_exit_quietly_and_release_the_real_process_lock(
    owned_root: Path,
    ownership_token: str,
    sent_signal: signal.Signals,
    expected_status: int,
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    with _core_process(owned_root, ownership_token) as process:
        _send(process, _hello(contract.schema_sha256, "signal-owner"))
        _read(process)
        process.send_signal(sent_signal)
        stdout, stderr = process.communicate(timeout=5)
    assert process.returncode == expected_status
    assert stdout == b""
    assert stderr == b""
    assert b"Traceback" not in stderr
    assert ownership_token.encode() not in stderr
    assert os.path.expanduser("~").encode() not in stderr

    with _core_process(owned_root, ownership_token) as reopened:
        _send(reopened, _hello(contract.schema_sha256, "after-signal"))
        assert _read(reopened)[1]["id"] == "after-signal"
        trailing, reopened_stderr = _finish(reopened)
    assert reopened.returncode == 0
    assert trailing == reopened_stderr == b""


def test_keyboard_interrupt_during_cleanup_is_contained(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    import nobei_core.main as core_main

    class InterruptingDatabase:
        closed = False

        def close(self) -> None:
            self.closed = True
            raise KeyboardInterrupt

    database = InterruptingDatabase()
    monkeypatch.setattr(core_main, "load_candidate_contract", lambda _root: object())
    monkeypatch.setattr(core_main.Phase1Database, "open", lambda *_args: database)
    monkeypatch.setattr(core_main, "Phase1Core", lambda *_args: object())
    monkeypatch.setattr(core_main, "RpcDispatcher", lambda _core: object())
    monkeypatch.setattr(core_main, "serve", lambda _dispatcher: 0)

    status = core_main.main(
        ["--data-root", os.fspath(tmp_path), "--ownership-token", "private-token"]
    )

    assert status == 130
    assert database.closed is True
    assert capsys.readouterr() == ("", "")


def test_signal_during_cleanup_cannot_interrupt_lease_close(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    import nobei_core.main as core_main

    class SignalledDatabase:
        closed = False

        def close(self) -> None:
            os.kill(os.getpid(), signal.SIGINT)
            self.closed = True

    database = SignalledDatabase()
    monkeypatch.setattr(core_main, "load_candidate_contract", lambda _root: object())
    monkeypatch.setattr(core_main.Phase1Database, "open", lambda *_args: database)
    monkeypatch.setattr(core_main, "Phase1Core", lambda *_args: object())
    monkeypatch.setattr(core_main, "RpcDispatcher", lambda _core: object())
    monkeypatch.setattr(core_main, "serve", lambda _dispatcher: 0)

    status = core_main.main(
        ["--data-root", os.fspath(tmp_path), "--ownership-token", "private-token"]
    )

    assert status == 0
    assert database.closed is True
    assert capsys.readouterr() == ("", "")


def test_signal_policy_is_installed_before_runtime_path_resolution(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    import nobei_core.main as core_main

    class UncontainedSignal(BaseException):
        pass

    previous = {signum: signal.getsignal(signum) for signum in (signal.SIGINT, signal.SIGTERM)}
    real_resolve = core_main.Path.resolve
    signalled = False

    def interrupting_resolve(path: Path, *args: object, **kwargs: object) -> Path:
        nonlocal signalled
        if not signalled:
            signalled = True
            os.kill(os.getpid(), signal.SIGTERM)
        return real_resolve(path, *args, **kwargs)

    monkeypatch.setattr(core_main.Path, "resolve", interrupting_resolve)
    signal.signal(signal.SIGTERM, lambda _signum, _frame: (_ for _ in ()).throw(UncontainedSignal()))
    try:
        status = core_main.main(
            ["--data-root", os.fspath(tmp_path), "--ownership-token", "private-token"]
        )
    finally:
        signal.signal(signal.SIGTERM, previous[signal.SIGTERM])

    assert status == 143
    assert signalled is True
    assert capsys.readouterr() == ("", "")
    assert {
        signum: signal.getsignal(signum) for signum in (signal.SIGINT, signal.SIGTERM)
    } == previous


def test_partial_signal_install_failure_restores_every_recorded_handler(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    import nobei_core.main as core_main

    originals = {signal.SIGINT: object(), signal.SIGTERM: object()}
    installed: dict[signal.Signals, object] = dict(originals)
    calls: list[tuple[signal.Signals, object]] = []

    monkeypatch.setattr(core_main.signal, "getsignal", lambda signum: installed[signum])

    def partial_signal(signum: signal.Signals, handler: object) -> object:
        calls.append((signum, handler))
        if signum == signal.SIGTERM and len(calls) == 2:
            raise OSError("install failed")
        previous = installed[signum]
        installed[signum] = handler
        return previous

    monkeypatch.setattr(core_main.signal, "signal", partial_signal)
    assert core_main.main([]) == 70
    assert installed == originals
    assert calls[-2:] == [
        (signal.SIGINT, originals[signal.SIGINT]),
        (signal.SIGTERM, originals[signal.SIGTERM]),
    ]
    assert capsys.readouterr() == ("", "DATABASE_UNAVAILABLE\n")


@pytest.mark.parametrize(
    ("interruption", "expected_status"),
    ((KeyboardInterrupt(), 130), ("signal-exit", 143)),
    ids=("keyboard-interrupt", "signal-exit"),
)
def test_signal_restore_interruption_is_quiet_and_retries_pending_handlers(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    interruption: object,
    expected_status: int,
) -> None:
    import nobei_core.main as core_main

    originals = {signal.SIGINT: object(), signal.SIGTERM: object()}
    installed: dict[signal.Signals, object] = dict(originals)
    calls: list[tuple[signal.Signals, object]] = []
    restore_interrupted = False
    monkeypatch.setattr(core_main.signal, "getsignal", lambda signum: installed[signum])

    def interrupting_signal(signum: signal.Signals, handler: object) -> object:
        nonlocal restore_interrupted
        calls.append((signum, handler))
        if handler is originals[signal.SIGINT] and not restore_interrupted:
            restore_interrupted = True
            if interruption == "signal-exit":
                raise core_main._SignalExit(143)
            raise interruption
        previous = installed[signum]
        installed[signum] = handler
        return previous

    monkeypatch.setattr(core_main.signal, "signal", interrupting_signal)
    assert core_main.main([]) == expected_status
    assert installed == originals
    assert sum(
        signum == signal.SIGINT and handler is originals[signal.SIGINT]
        for signum, handler in calls
    ) == 2
    assert capsys.readouterr() == ("", "")


def test_signal_restore_oserror_is_an_observable_software_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    import nobei_core.main as core_main

    originals = {signal.SIGINT: object(), signal.SIGTERM: object()}
    installed: dict[signal.Signals, object] = dict(originals)
    restore_calls: list[signal.Signals] = []
    monkeypatch.setattr(core_main.signal, "getsignal", lambda signum: installed[signum])

    def failing_restore(signum: signal.Signals, handler: object) -> object:
        if handler is originals[signum]:
            restore_calls.append(signum)
            if signum == signal.SIGINT:
                raise ValueError("restore failed")
        previous = installed[signum]
        installed[signum] = handler
        return previous

    monkeypatch.setattr(core_main.signal, "signal", failing_restore)
    assert core_main.main([]) == 70
    assert restore_calls == [signal.SIGINT, signal.SIGTERM]
    assert installed[signal.SIGTERM] is originals[signal.SIGTERM]
    assert capsys.readouterr() == ("", "DATABASE_UNAVAILABLE\n")


@pytest.mark.parametrize("fatal", (SystemExit(9), GeneratorExit(), BaseException("fatal")))
def test_arbitrary_fatal_restore_exceptions_propagate(
    monkeypatch: pytest.MonkeyPatch,
    fatal: BaseException,
) -> None:
    import nobei_core.main as core_main

    originals = {signal.SIGINT: object(), signal.SIGTERM: object()}
    installed: dict[signal.Signals, object] = dict(originals)
    monkeypatch.setattr(core_main.signal, "getsignal", lambda signum: installed[signum])

    def fatal_restore(signum: signal.Signals, handler: object) -> object:
        if handler is originals[signum]:
            raise fatal
        previous = installed[signum]
        installed[signum] = handler
        return previous

    monkeypatch.setattr(core_main.signal, "signal", fatal_restore)
    with pytest.raises(type(fatal)):
        core_main.main([])


def test_real_handlers_are_equal_before_and_after_every_normal_main_return(
    capsys: pytest.CaptureFixture[str],
) -> None:
    import nobei_core.main as core_main

    previous = {signum: signal.getsignal(signum) for signum in (signal.SIGINT, signal.SIGTERM)}
    assert core_main.main([]) == 64
    assert {
        signum: signal.getsignal(signum) for signum in (signal.SIGINT, signal.SIGTERM)
    } == previous
    assert capsys.readouterr() == ("", "INVALID_PARAMS\n")


@pytest.mark.parametrize("stage", ("parse", "install"))
def test_keyboard_interrupt_before_database_open_is_quiet(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
    stage: str,
) -> None:
    import nobei_core.main as core_main

    if stage == "parse":
        monkeypatch.setattr(
            core_main,
            "_parse_args",
            lambda _argv: (_ for _ in ()).throw(KeyboardInterrupt()),
        )
    else:
        monkeypatch.setattr(
            core_main._SignalPolicy,
            "install",
            lambda _self: (_ for _ in ()).throw(KeyboardInterrupt()),
        )

    arguments = (
        []
        if stage == "parse"
        else [
            "--data-root",
            os.fspath(tmp_path),
            "--ownership-token",
            "private-token",
        ]
    )
    assert core_main.main(arguments) == 130
    assert capsys.readouterr() == ("", "")


def test_real_entrypoint_startup_recovers_without_replaying_generation(
    owned_root: Path, ownership_token: str
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    with _core_process(owned_root, ownership_token) as first:
        _send(first, _hello(contract.schema_sha256))
        _read(first)
        _send(first, _request("import", "documents.import_text", {
            "filename": "recovery.txt",
            "mediaType": "text/plain",
            "text": "Recovery keeps one durable generation attempt.",
        }))
        imported = _read(first)[1]["result"]
        assert isinstance(imported, dict)
        run_id = imported["runId"]
        _send(first, _request("prepare", "runs.prepare_generation", {
            "runId": run_id,
            "modelSelection": MODEL_SELECTION,
        }))
        prepared = _read(first)[1]["result"]
        assert isinstance(prepared, dict)
        attempt_id = prepared["attemptId"]
        stdout, stderr = _finish(first)
    assert first.returncode == 0
    assert stdout == stderr == b""

    with _core_process(owned_root, ownership_token) as recovered:
        _send(recovered, _hello(contract.schema_sha256))
        _read(recovered)
        _send(recovered, _request("get", "runs.get", {"runId": run_id}))
        run = _read(recovered)[1]["result"]
        stdout, stderr = _finish(recovered)
    assert recovered.returncode == 0
    assert stdout == stderr == b""
    assert isinstance(run, dict)
    assert run["status"] == "failed_retryable"
    assert run["error"] == {"code": "GENERATION_PROVIDER_ERROR", "retryable": True}

    opened = Phase1Database.open(owned_root, ownership_token)
    try:
        assert opened.scalar("SELECT COUNT(*) FROM generation_attempts") == 1
        assert opened.scalar("SELECT id FROM generation_attempts") == attempt_id
    finally:
        opened.close()


def test_entrypoint_rejects_relative_root_with_one_secret_free_diagnostic(
    ownership_token: str,
) -> None:
    secret = "token-value-that-must-stay-private"
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "nobei_core.main",
            "--data-root",
            "relative-root",
            "--ownership-token",
            secret,
        ],
        capture_output=True,
        check=False,
        timeout=5,
    )
    assert completed.returncode == 64
    assert completed.stdout == b""
    assert completed.stderr == b"INVALID_PARAMS\n"
    assert secret.encode() not in completed.stderr
    assert os.path.expanduser("~").encode() not in completed.stderr


class _MappedCore:
    def __init__(self, schema_sha256: str, payload_size: int = 0) -> None:
        self.schema_sha256 = schema_sha256
        self.payload_size = payload_size
        self.called: list[tuple[str, object]] = []

    def hello(self, params: object) -> dict[str, object]:
        self.called.append(("hello", params))
        return {"ok": True}

    def get_run(self, params: object) -> dict[str, object]:
        self.called.append(("get_run", params))
        return {"value": "x" * self.payload_size}

    def dangerous(self, params: object) -> dict[str, object]:
        raise AssertionError("arbitrary getattr was called")


def test_dispatcher_uses_only_rpc_methods_getattr_mapping() -> None:
    core = _MappedCore("a" * 64)
    dispatcher = RpcDispatcher(core)
    hello = dispatcher.handle(_hello("a" * 64))
    assert hello == {"jsonrpc": "2.0", "id": "rpc_hello", "result": {"ok": True}}
    assert dispatcher.handle(_request("bad", "dangerous", {})) == _error(
        "bad", -32601, "METHOD_NOT_FOUND"
    )
    assert core.called == [("hello", _hello("a" * 64)["params"])]
    assert RPC_METHODS["runs.get"] == "get_run"


def test_response_limit_counts_the_trailing_newline() -> None:
    hello_request = _hello("a" * 64)
    get_request = _request("size", "runs.get", {"runId": "job_0123456789abcdefabcd"})
    empty_response = _compact({"jsonrpc": "2.0", "id": "size", "result": {"value": ""}})
    exact_payload_size = RPC_LINE_MAX_BYTES - len(empty_response)

    exact_core = _MappedCore("a" * 64, exact_payload_size)
    exact_stdout = io.BytesIO()
    exact_stderr = io.StringIO()
    assert serve(
        RpcDispatcher(exact_core),
        stdin=io.BytesIO(_compact(hello_request) + _compact(get_request)),
        stdout=exact_stdout,
        stderr=exact_stderr,
    ) == 0
    assert len(exact_stdout.getvalue().splitlines(keepends=True)[1]) == RPC_LINE_MAX_BYTES
    assert exact_stderr.getvalue() == ""

    over_core = _MappedCore("a" * 64, exact_payload_size + 1)
    over_stdout = io.BytesIO()
    over_stderr = io.StringIO()
    assert serve(
        RpcDispatcher(over_core),
        stdin=io.BytesIO(_compact(hello_request) + _compact(get_request)),
        stdout=over_stdout,
        stderr=over_stderr,
    ) == 70
    assert len(over_stdout.getvalue().splitlines()) == 1
    assert over_stderr.getvalue() == "RPC_MESSAGE_TOO_LARGE\n"


class _SequenceCore(_MappedCore):
    def __init__(self, schema_sha256: str, payload_sizes: list[int]) -> None:
        super().__init__(schema_sha256)
        self.payload_sizes = payload_sizes
        self.get_calls = 0

    def get_run(self, params: object) -> dict[str, object]:
        size = self.payload_sizes[self.get_calls]
        self.get_calls += 1
        return {"value": "x" * size}


def test_oversized_response_terminates_without_processing_the_following_request() -> None:
    hello_request = _hello("a" * 64)
    get_request = _request("size", "runs.get", {"runId": "job_0123456789abcdefabcd"})
    empty_response = _compact({"jsonrpc": "2.0", "id": "size", "result": {"value": ""}})
    core = _SequenceCore(
        "a" * 64,
        [RPC_LINE_MAX_BYTES - len(empty_response) + 1, 0],
    )
    stdout = io.BytesIO()
    stderr = io.StringIO()
    status = serve(
        RpcDispatcher(core),
        stdin=io.BytesIO(
            _compact(hello_request) + _compact(get_request) + _compact(get_request)
        ),
        stdout=stdout,
        stderr=stderr,
    )

    assert status == 70
    assert len(stdout.getvalue().splitlines()) == 1
    assert stderr.getvalue() == "RPC_MESSAGE_TOO_LARGE\n"
    assert core.get_calls == 1


class _BrokenPipeOutput:
    def write(self, _value: bytes) -> int:
        raise BrokenPipeError

    def flush(self) -> None:
        raise AssertionError("flush must not follow failed write")


class _BrokenFlushOutput:
    def write(self, value: bytes) -> int:
        return len(value)

    def flush(self) -> None:
        raise BrokenPipeError


class _ShortOutput:
    def __init__(self) -> None:
        self.chunks: list[bytes] = []

    def write(self, value: bytes | memoryview) -> int:
        count = min(7, len(value))
        self.chunks.append(bytes(value[:count]))
        return count

    def flush(self) -> None:
        pass


def test_short_writes_are_retried_until_one_complete_frame_is_emitted() -> None:
    output = _ShortOutput()
    request = _hello("a" * 64, "short-write")
    expected = _compact(
        RpcDispatcher(_MappedCore("a" * 64)).handle(request)
    )

    status = serve(
        RpcDispatcher(_MappedCore("a" * 64)),
        stdin=io.BytesIO(_compact(request)),
        stdout=output,
        stderr=io.StringIO(),
    )

    assert status == 0
    assert b"".join(output.chunks) == expected
    assert len(output.chunks) > 1


@pytest.mark.parametrize("invalid_count", (0, None, -1, 10_000))
def test_invalid_binary_write_counts_are_failures(invalid_count: object) -> None:
    class InvalidCountOutput:
        def write(self, _value: bytes | memoryview) -> object:
            return invalid_count

        def flush(self) -> None:
            raise AssertionError("flush must not follow an invalid write count")

    stderr = io.StringIO()
    assert serve(
        RpcDispatcher(_MappedCore("a" * 64)),
        stdin=io.BytesIO(_compact(_hello("a" * 64))),
        stdout=InvalidCountOutput(),
        stderr=stderr,
    ) == 70
    assert stderr.getvalue() == "TRANSACTION_FAILED\n"


def test_default_output_is_unbuffered_fd1_and_retries_os_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nobei_core.rpc as rpc

    chunks: list[bytes] = []
    descriptors: list[int] = []

    def short_os_write(descriptor: int, value: bytes | memoryview) -> int:
        descriptors.append(descriptor)
        count = min(11, len(value))
        chunks.append(bytes(value[:count]))
        return count

    monkeypatch.setattr(rpc.os, "write", short_os_write)
    request = _hello("a" * 64, "raw-fd")
    expected = _compact(RpcDispatcher(_MappedCore("a" * 64)).handle(request))
    assert serve(
        RpcDispatcher(_MappedCore("a" * 64)),
        stdin=io.BytesIO(_compact(request)),
        stderr=io.StringIO(),
    ) == 0
    assert b"".join(chunks) == expected
    assert descriptors and set(descriptors) == {1}


def test_broken_custom_output_does_not_replace_its_file_descriptor() -> None:
    duplicated_stdout = os.dup(1)
    before = os.fstat(duplicated_stdout)

    class BrokenOutputWithDescriptor(_BrokenPipeOutput):
        def fileno(self) -> int:
            return duplicated_stdout

    try:
        stderr = io.StringIO()
        assert serve(
            RpcDispatcher(_MappedCore("a" * 64)),
            stdin=io.BytesIO(_compact(_hello("a" * 64))),
            stdout=BrokenOutputWithDescriptor(),
            stderr=stderr,
        ) == 70
        after = os.fstat(duplicated_stdout)
    finally:
        os.close(duplicated_stdout)

    assert (after.st_dev, after.st_ino, after.st_mode, after.st_rdev) == (
        before.st_dev,
        before.st_ino,
        before.st_mode,
        before.st_rdev,
    )
    assert stderr.getvalue() == "TRANSACTION_FAILED\n"


@pytest.mark.parametrize(
    "output",
    (_BrokenPipeOutput(), _BrokenFlushOutput()),
    ids=("write", "flush"),
)
def test_broken_pipe_is_contained_with_a_defined_status(output: object) -> None:
    stderr = io.StringIO()
    status = serve(
        RpcDispatcher(_MappedCore("a" * 64)),
        stdin=io.BytesIO(_compact(_hello("a" * 64))),
        stdout=output,
        stderr=stderr,
    )

    assert status == 70
    assert stderr.getvalue() == "TRANSACTION_FAILED\n"


def test_real_broken_stdout_pipe_has_no_shutdown_traceback(
    owned_root: Path, ownership_token: str
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "nobei_core.main",
            "--data-root",
            os.fspath(owned_root),
            "--ownership-token",
            ownership_token,
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stdout is not None
    assert process.stdin is not None
    assert process.stderr is not None
    process.stdout.close()
    process.stdin.write(_compact(_hello(contract.schema_sha256, "broken-pipe")))
    process.stdin.flush()
    process.stdin.close()
    process.stdin = None
    stderr = process.stderr.read()
    process.wait(timeout=5)

    assert process.returncode == 70
    assert stderr == b"TRANSACTION_FAILED\n"
    assert b"Traceback" not in stderr
    assert b"Exception ignored" not in stderr


def test_real_entrypoint_with_fd1_closed_exits_without_shutdown_diagnostics(
    owned_root: Path, ownership_token: str
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "nobei_core.main",
            "--data-root",
            os.fspath(owned_root),
            "--ownership-token",
            ownership_token,
        ],
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
        preexec_fn=lambda: os.close(1),
    )
    _, stderr = process.communicate(
        _compact(_hello(contract.schema_sha256, "closed-fd1")), timeout=5
    )

    assert process.returncode == 70
    assert stderr == b"TRANSACTION_FAILED\n"
    assert b"Traceback" not in stderr
    assert b"Exception ignored" not in stderr


def test_import_fixture_matches_runtime_generated_identifiers_and_leaks_nothing(
    owned_root: Path, ownership_token: str
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    fixture = _runtime_fixture("import-text.json", {})
    request = fixture["request"]
    assert isinstance(request, dict)
    document_text = str(request["params"]["text"])

    with _core_process(owned_root, ownership_token) as process:
        _send(process, _hello(contract.schema_sha256))
        hello_raw, _ = _read(process)
        _send(process, request)
        import_raw, response = _read(process)
        result = response["result"]
        assert isinstance(result, dict)
        expected = _runtime_fixture(
            "import-text.json",
            {
                "__RUNTIME_DOCUMENT_ID__": result["documentId"],
                "__RUNTIME_RUN_ID__": result["runId"],
            },
        )
        assert response == expected["response"]
        stdout, stderr = _finish(process)

    transcript = hello_raw + import_raw + stdout + stderr
    assert process.returncode == 0
    assert document_text.encode("utf-8") not in transcript
    assert ownership_token.encode("utf-8") not in transcript
    assert os.path.expanduser("~").encode("utf-8") not in transcript
    assert stderr == b""


def test_review_conflict_fixture_matches_the_real_subprocess_domain_lifecycle(
    owned_root: Path, ownership_token: str
) -> None:
    contract = load_candidate_contract(PACKAGE_ROOT)
    with _core_process(owned_root, ownership_token) as process:
        _send(process, _hello(contract.schema_sha256))
        _read(process)
        _send(process, _request("import", "documents.import_text", {
            "filename": "photosynthesis.md",
            "mediaType": "text/markdown",
            "text": "Plants convert light energy into chemical energy.",
        }))
        imported = _read(process)[1]["result"]
        assert isinstance(imported, dict)
        _send(process, _request("prepare", "runs.prepare_generation", {
            "runId": imported["runId"],
            "modelSelection": MODEL_SELECTION,
        }))
        prepared = _read(process)[1]["result"]
        assert isinstance(prepared, dict)
        _send(process, _request("submit", "runs.submit_generation", {
            "runId": imported["runId"],
            "attemptId": prepared["attemptId"],
            "expectedRevision": prepared["revision"],
            "output": {
                "schemaVersion": 1,
                "candidates": [{
                    "type": "concept",
                    "title": "Photosynthesis",
                    "statement": "Plants convert light energy into chemical energy.",
                    "evidence": [{
                        "quote": "Plants convert light energy into chemical energy.",
                        "prefix": "",
                        "suffix": "",
                    }],
                }],
            },
        }))
        submitted = _read(process)[1]
        assert "result" in submitted
        _send(process, _request("list", "candidates.list", {
            "runId": imported["runId"],
        }))
        listed = _read(process)[1]["result"]
        assert isinstance(listed, dict)
        candidates = listed["candidates"]
        assert isinstance(candidates, list) and len(candidates) == 1
        candidate_id = candidates[0]["candidateId"]
        fixture = _runtime_fixture(
            "review-conflict.json",
            {"__RUNTIME_CANDIDATE_ID__": candidate_id},
        )
        _send(process, fixture["request"])
        response = _read(process)[1]
        stdout, stderr = _finish(process)

    assert response == fixture["response"]
    assert process.returncode == 0
    assert stdout == stderr == b""


def test_fixture_schema_digest_is_the_resource_bytes() -> None:
    schema = (PACKAGE_ROOT / "contracts" / "l1-candidate.schema.json").read_bytes()
    contract = load_candidate_contract(PACKAGE_ROOT)
    assert contract.schema_sha256 == hashlib.sha256(schema).hexdigest()
