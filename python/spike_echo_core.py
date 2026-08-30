#!/usr/bin/env python3
"""Disposable JSONL-RPC Core used only by the Phase 1A public-seam spike."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
from typing import Any


MAX_LINE_BYTES = 64 * 1024
PROTOCOL_VERSION = 1
_children: list[subprocess.Popen[bytes]] = []
_last_request_id = 0


def _encode(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def _write(value: dict[str, Any]) -> None:
    payload = _encode(value)
    if len(payload) > MAX_LINE_BYTES:
        request_id = value.get("id")
        payload = _encode(_error(request_id, -32603, "response exceeds 64 KiB"))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def _error(request_id: int | None, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }


def _result(request_id: int, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _cleanup_children() -> None:
    while _children:
        child = _children.pop()
        if child.poll() is not None:
            continue
        child.terminate()
        try:
            child.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=1.0)


def _handle_signal(signum: int, _frame: Any) -> None:
    _cleanup_children()
    raise SystemExit(128 + signum)


def _validate_request(value: Any) -> tuple[int, str, dict[str, Any]] | None:
    global _last_request_id
    if not isinstance(value, dict):
        return None
    request_id = value.get("id")
    method = value.get("method")
    params = value.get("params", {})
    if (
        value.get("jsonrpc") != "2.0"
        or not isinstance(request_id, int)
        or isinstance(request_id, bool)
        or request_id <= _last_request_id
        or not isinstance(method, str)
        or not isinstance(params, dict)
    ):
        return None
    _last_request_id = request_id
    return request_id, method, params


def _dispatch(request_id: int, method: str, params: dict[str, Any]) -> bool:
    if method == "echo":
        _write(_result(request_id, {"value": params.get("value")}))
    elif method == "env_probe":
        _write(_result(request_id, {
            "deepseekApiKeyPresent": "DEEPSEEK_API_KEY" in os.environ,
            "dshHomePresent": "DSH_HOME" in os.environ,
            "dshToolsModePresent": "DSH_TOOLS_MODE" in os.environ,
            "dshTelemetryModePresent": "DSH_TELEMETRY_MODE" in os.environ,
        }))
    elif method == "spawn_child":
        child = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(300)"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        _children.append(child)
        _write(_result(request_id, {"childPid": child.pid}))
    elif method == "shutdown":
        _write(_result(request_id, {"ok": True}))
        return False
    elif method == "crash":
        os._exit(17)
    else:
        _write(_error(request_id, -32601, "method not found"))
    return True


def main() -> int:
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)
    _write({
        "jsonrpc": "2.0",
        "method": "core.ready",
        "params": {"protocolVersion": PROTOCOL_VERSION, "pid": os.getpid()},
    })
    print("nobei-phase1a-core ready", file=sys.stderr, flush=True)

    keep_running = True
    while keep_running:
        raw = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
        if not raw:
            break
        if len(raw) > MAX_LINE_BYTES or not raw.endswith(b"\n"):
            if not raw.endswith(b"\n"):
                while raw and not raw.endswith(b"\n"):
                    raw = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
            _write(_error(None, -32600, "request exceeds 64 KiB"))
            continue
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            _write(_error(None, -32700, "parse error"))
            continue

        request = _validate_request(value)
        if request is None:
            request_id = value.get("id") if isinstance(value, dict) and isinstance(value.get("id"), int) else None
            _write(_error(request_id, -32600, "invalid request"))
            continue
        keep_running = _dispatch(*request)

    _cleanup_children()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
