"""Closed JSON-RPC 2.0 dispatcher and bounded newline framing."""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Sequence
from typing import BinaryIO, Protocol, TextIO

from nobei_core.constants import RPC_LINE_MAX_BYTES, RPC_METHODS
from nobei_core.errors import CoreProblem


_REQUEST_KEYS = frozenset({"jsonrpc", "id", "method", "params"})


class _DuplicateMember(ValueError):
    pass


class _CoreMethods(Protocol):
    def hello(self, params: object) -> dict[str, object]: ...


def _valid_request_id(value: object) -> bool:
    if type(value) is int:
        return True
    if not isinstance(value, str):
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _response_id(request: object) -> str | int | None:
    if isinstance(request, dict):
        value = request.get("id")
        if _valid_request_id(value):
            return value
    return None


def _error_response(
    request_id: str | int | None,
    numeric_code: int,
    public_code: str,
    public_data: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {
            "code": numeric_code,
            "message": public_code,
            "data": {"code": public_code, **(public_data or {})},
        },
    }


def _problem_response(request_id: str | int, problem: CoreProblem) -> dict[str, object]:
    numeric_code = -32602 if problem.code == "INVALID_PARAMS" else -32000
    return _error_response(
        request_id,
        numeric_code,
        problem.code,
        dict(problem.data) if problem.data is not None else None,
    )


class RpcDispatcher:
    """Dispatch only the immutable public method table after an exact hello."""

    def __init__(self, core: _CoreMethods) -> None:
        self._core = core
        self._hello_complete = False

    def handle(self, request: object) -> dict[str, object]:
        request_id = _response_id(request)
        if (
            not isinstance(request, dict)
            or frozenset(request) != _REQUEST_KEYS
            or request.get("jsonrpc") != "2.0"
            or request_id is None
            or not isinstance(request.get("method"), str)
        ):
            return _error_response(request_id, -32600, "INVALID_REQUEST")

        method = request["method"]
        params = request["params"]
        if not isinstance(params, dict):
            return _error_response(request_id, -32602, "INVALID_PARAMS")
        if method not in RPC_METHODS:
            return _error_response(request_id, -32601, "METHOD_NOT_FOUND")
        if not self._hello_complete and method != "system.hello":
            return _error_response(request_id, -32000, "PROTOCOL_MISMATCH")

        try:
            target = getattr(self._core, RPC_METHODS[method])
            result = target(params)
            if not isinstance(result, dict):
                raise CoreProblem("TRANSACTION_FAILED", "Core result is not an object")
        except CoreProblem as problem:
            return _problem_response(request_id, problem)
        except Exception:
            return _error_response(request_id, -32000, "TRANSACTION_FAILED")

        if method == "system.hello":
            self._hello_complete = True
        return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _reject_json_constant(value: str) -> None:
    raise json.JSONDecodeError("invalid JSON constant", value, 0)


def _unique_object(pairs: Sequence[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateMember("duplicate JSON object member")
        result[key] = value
    return result


def _parse_request(decoded: str) -> object:
    return json.loads(
        decoded,
        object_pairs_hook=_unique_object,
        parse_constant=_reject_json_constant,
    )


def _diagnose(code: str, error_stream: TextIO) -> None:
    try:
        error_stream.write(code + "\n")
        error_stream.flush()
    except (OSError, ValueError):
        pass


class _RawFdOutput:
    """Unbuffered process stdout that never owns or mutates file descriptor 1."""

    def write(self, value: bytes | memoryview) -> int:
        return os.write(1, value)

    def flush(self) -> None:
        pass


def _write_frame(
    frame: bytes,
    output_stream: BinaryIO,
    error_stream: TextIO,
) -> int | None:
    try:
        remaining = memoryview(frame)
        while remaining:
            written = output_stream.write(remaining)
            if type(written) is not int or written <= 0 or written > len(remaining):
                raise OSError("invalid protocol write count")
            remaining = remaining[written:]
        output_stream.flush()
    except (OSError, TypeError, ValueError):
        _diagnose("TRANSACTION_FAILED", error_stream)
        return 70
    return None


def serve(
    dispatcher: RpcDispatcher,
    *,
    stdin: BinaryIO | None = None,
    stdout: BinaryIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    """Serve one bounded UTF-8 JSON object per line until EOF or a fatal frame."""
    input_stream = stdin if stdin is not None else sys.stdin.buffer
    output_stream = stdout if stdout is not None else _RawFdOutput()
    error_stream = stderr if stderr is not None else sys.stderr

    while True:
        line = input_stream.readline(RPC_LINE_MAX_BYTES + 1)
        if line == b"":
            return 0
        if len(line) > RPC_LINE_MAX_BYTES:
            _diagnose("RPC_MESSAGE_TOO_LARGE", error_stream)
            return 65
        if not line.endswith(b"\n"):
            _diagnose("INVALID_REQUEST", error_stream)
            return 65
        try:
            decoded = line.decode("utf-8")
        except UnicodeDecodeError:
            _diagnose("INVALID_REQUEST", error_stream)
            return 65

        try:
            request = _parse_request(decoded)
        except (ValueError, RecursionError):
            response = _error_response(None, -32700, "INVALID_REQUEST")
        else:
            response = dispatcher.handle(request)

        try:
            encoded = json.dumps(
                response,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            )
            frame = encoded.encode("utf-8") + b"\n"
        except (TypeError, ValueError, UnicodeError, RecursionError):
            _diagnose("TRANSACTION_FAILED", error_stream)
            return 70
        if len(frame) > RPC_LINE_MAX_BYTES:
            _diagnose("RPC_MESSAGE_TOO_LARGE", error_stream)
            return 70
        write_status = _write_frame(frame, output_stream, error_stream)
        if write_status is not None:
            return write_status


__all__ = ["RpcDispatcher", "serve"]
