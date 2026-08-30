from __future__ import annotations

import json
import os
import signal
import sqlite3
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

import pytest

from nobei_core import service as service_module
from nobei_core.contract import load_candidate_contract
from nobei_core.errors import CoreProblem
from nobei_core.ownership import ALLOWED_ROOT_ENTRIES, CoreLease, initialize_owned_root
from nobei_core.repository import insert_formal_knowledge_point
from nobei_core.service import Phase1Core

from conftest import PYTHON_ROOT


PACKAGE_ROOT = PYTHON_ROOT.parent


@pytest.fixture
def core(database):
    return Phase1Core(database, load_candidate_contract(PACKAGE_ROOT))


def _rpc(process: subprocess.Popen[bytes], request_id: str, method: str, params: dict):
    assert process.stdin is not None
    assert process.stdout is not None
    frame = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
    process.stdin.write((json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
    process.stdin.flush()
    response = json.loads(process.stdout.readline())
    assert response["id"] == request_id
    return response


def _start(root: Path, token: str) -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "nobei_core.main",
            "--data-root",
            os.fspath(root),
            "--ownership-token",
            token,
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def _hello(process: subprocess.Popen[bytes]):
    contract = load_candidate_contract(PACKAGE_ROOT)
    response = _rpc(
        process,
        "hello",
        "system.hello",
        {
            "protocolVersion": 3,
            "schemaVersion": 1,
            "schemaSha256": contract.schema_sha256,
        },
    )
    assert response["result"]["coreVersion"] == "phase1e"


def _stop(process: subprocess.Popen[bytes]) -> tuple[bytes, bytes]:
    if process.stdin is not None:
        process.stdin.close()
        process.stdin = None
    return process.communicate(timeout=5)


def _seed(core: Phase1Core, database, *, candidates: int = 1):
    text = "甲定义。乙过程。丙事实。"
    imported = core.import_text(
        {"filename": "faults.md", "mediaType": "text/markdown", "text": text}
    )
    run_id = str(imported["runId"])
    prepared = core.prepare_generation({
        "runId": run_id,
        "modelSelection": {"provider": "fake", "model": "deterministic"},
    })
    quotes = ("甲定义", "乙过程", "丙事实")
    output = {
        "schemaVersion": 1,
        "candidates": [
            {
                "type": "concept",
                "title": f"候选{index}",
                "statement": f"候选{index}陈述。",
                "evidence": [{"quote": quotes[index], "prefix": "", "suffix": "。"}],
            }
            for index in range(candidates)
        ],
    }
    core.submit_generation(
        {
            "runId": run_id,
            "attemptId": prepared["attemptId"],
            "expectedRevision": prepared["revision"],
            "output": output,
        }
    )
    rows = database.all(
        "SELECT id FROM p1_candidates WHERE job_id=? ORDER BY ordinal", (run_id,)
    )
    return run_id, prepared, [str(row["id"]) for row in rows]


def _state(database):
    tables = (
        "documents",
        "chunks",
        "import_jobs",
        "p1_run_control",
        "p1_generation_attempts",
        "p1_candidates",
        "p1_candidate_evidence",
        "p1_run_events",
        "p1_idempotency",
        "knowledge_points",
        "kp_evidence",
        "kp_confirm_log",
    )
    with database.read_snapshot() as con:
        return {
            table: [tuple(row) for row in con.execute(f"SELECT * FROM {table} ORDER BY rowid")]
            for table in tables
        }


@pytest.mark.parametrize(
    "hook_name",
    [
        "insert_formal_knowledge_point",
        "insert_formal_evidence",
        "insert_confirmation_log",
        "store_idempotency_result",
    ],
)
def test_failure_after_every_review_write_boundary_rolls_back(
    core, database, monkeypatch, hook_name
):
    _run_id, _prepared, candidates = _seed(core, database)
    before = _state(database)
    original = getattr(service_module, hook_name)

    def fail_after_write(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("private injected boundary")

    monkeypatch.setattr(service_module, hook_name, fail_after_write)
    with pytest.raises(CoreProblem) as caught:
        core.review_candidate(
            {
                "candidateId": candidates[0],
                "action": "accept",
                "expectedRevision": 1,
                "idempotencyKey": "idem_" + "a" * 20,
            }
        )
    assert caught.value.public() == {"code": "TRANSACTION_FAILED"}
    assert _state(database) == before


def test_two_real_core_processes_never_overlap_database_ownership(
    owned_root: Path, ownership_token: str
):
    first = _start(owned_root, ownership_token)
    try:
        _hello(first)
        second = _start(owned_root, ownership_token)
        second_stdout, second_stderr = second.communicate(timeout=5)
        assert second.returncode == 73
        assert second_stdout == b""
        assert second_stderr == b"CORE_INSTANCE_CONFLICT\n"
    finally:
        stdout, stderr = _stop(first)
    assert first.returncode == 0
    assert stdout == stderr == b""


def test_forced_kill_releases_lock_and_replacement_recovers_interrupted_state(
    tmp_path: Path, ownership_token: str
):
    root = tmp_path / "killed-owned"
    root.mkdir()
    initialize_owned_root(root, ownership_token)
    first = _start(root, ownership_token)
    _hello(first)
    imported = _rpc(
        first,
        "import",
        "documents.import_text",
        {"filename": "kill.md", "mediaType": "text/markdown", "text": "中断恢复。"},
    )["result"]
    prepared = _rpc(
        first,
        "prepare",
        "runs.prepare_generation",
        {
            "runId": imported["runId"],
            "modelSelection": {"provider": "fake", "model": "deterministic"},
        },
    )["result"]
    first.send_signal(signal.SIGKILL)
    first.communicate(timeout=5)
    assert first.returncode == -signal.SIGKILL

    replacement = _start(root, ownership_token)
    try:
        _hello(replacement)
        recovered = _rpc(
            replacement, "get", "runs.get", {"runId": imported["runId"]}
        )["result"]
        events = _rpc(
            replacement,
            "events",
            "runs.list_events",
            {"runId": imported["runId"], "after": 0},
        )["result"]["events"]
    finally:
        stdout, stderr = _stop(replacement)
    assert recovered["status"] == "failed_retryable"
    assert recovered["error"] == {"code": "GENERATION_PROVIDER_ERROR", "retryable": True}
    assert [event["type"] for event in events].count("generation.interrupted") == 1
    assert prepared["attemptId"] in json.dumps(events)
    assert replacement.returncode == 0
    assert stdout == stderr == b""


def test_pid_text_reuse_is_not_authoritative_without_an_os_lock(
    owned_root: Path, ownership_token: str
):
    lease = CoreLease.acquire(owned_root, ownership_token)
    lease.close()
    (owned_root / ".nobei-core.lock").write_text(
        f"{os.getpid()} reused-diagnostic-nonce\n", encoding="ascii"
    )
    replacement = CoreLease.acquire(owned_root, ownership_token)
    replacement.close()


def test_stale_attempt_and_revision_cannot_mutate(core, database):
    imported = core.import_text(
        {"filename": "stale.md", "mediaType": "text/markdown", "text": "旧结果。"}
    )
    prepared = core.prepare_generation({
        "runId": imported["runId"],
        "modelSelection": {"provider": "fake", "model": "deterministic"},
    })
    before = _state(database)
    base = {
        "runId": imported["runId"],
        "attemptId": prepared["attemptId"],
        "expectedRevision": prepared["revision"],
        "output": {"schemaVersion": 1, "candidates": []},
    }
    with pytest.raises(CoreProblem) as stale_attempt:
        core.submit_generation({**base, "attemptId": "att_" + "f" * 20})
    assert stale_attempt.value.code == "ATTEMPT_MISMATCH"
    assert _state(database) == before
    with pytest.raises(CoreProblem) as stale_revision:
        core.submit_generation({**base, "expectedRevision": int(prepared["revision"]) + 1})
    assert stale_revision.value.code == "RUN_STATE_CONFLICT"
    assert _state(database) == before


@pytest.mark.parametrize(
    "operation",
    ["import", "prepare", "submit", "fail", "retry", "review"],
)
def test_failure_at_each_public_write_transaction_boundary_rolls_back(
    core, database, monkeypatch, operation
):
    command = None
    method = None
    if operation == "import":
        method = core.import_text
        command = {
            "filename": "boundary.md",
            "mediaType": "text/markdown",
            "text": "事务边界。",
        }
    elif operation == "prepare":
        imported = core.import_text(
            {"filename": "boundary.md", "mediaType": "text/markdown", "text": "事务边界。"}
        )
        method = core.prepare_generation
        command = {"runId": imported["runId"]}
    elif operation in {"submit", "fail"}:
        imported = core.import_text(
            {"filename": "boundary.md", "mediaType": "text/markdown", "text": "事务边界。"}
        )
        prepared = core.prepare_generation({
            "runId": imported["runId"],
            "modelSelection": {"provider": "fake", "model": "deterministic"},
        })
        if operation == "submit":
            method = core.submit_generation
            command = {
                "runId": imported["runId"],
                "attemptId": prepared["attemptId"],
                "expectedRevision": prepared["revision"],
                "output": {"schemaVersion": 1, "candidates": []},
            }
        else:
            method = core.fail_generation
            command = {
                "runId": imported["runId"],
                "attemptId": prepared["attemptId"],
                "expectedRevision": prepared["revision"],
                "code": "GENERATION_TIMEOUT",
            }
    elif operation == "retry":
        imported = core.import_text(
            {"filename": "boundary.md", "mediaType": "text/markdown", "text": "事务边界。"}
        )
        prepared = core.prepare_generation({
            "runId": imported["runId"],
            "modelSelection": {"provider": "fake", "model": "deterministic"},
        })
        failed = core.fail_generation(
            {
                "runId": imported["runId"],
                "attemptId": prepared["attemptId"],
                "expectedRevision": prepared["revision"],
                "code": "GENERATION_TIMEOUT",
            }
        )
        method = core.retry
        command = {
            "runId": imported["runId"],
            "expectedRevision": failed["run"]["revision"],
        }
    else:
        _run_id, _prepared, candidates = _seed(core, database)
        method = core.review_candidate
        command = {
            "candidateId": candidates[0],
            "action": "accept",
            "expectedRevision": 1,
            "idempotencyKey": "idem_" + "d" * 20,
        }

    before = _state(database)
    original = database.write_transaction

    @contextmanager
    def fail_before_commit():
        with original() as connection:
            yield connection
            raise RuntimeError("injected transaction boundary")

    monkeypatch.setattr(database, "write_transaction", fail_before_commit)
    with pytest.raises((RuntimeError, CoreProblem)):
        method(command)
    assert _state(database) == before


def test_idempotency_replay_returns_first_result_and_changed_digest_conflicts(core, database):
    _run_id, _prepared, candidates = _seed(core, database)
    request = {
        "candidateId": candidates[0],
        "action": "accept",
        "expectedRevision": 1,
        "idempotencyKey": "idem_" + "b" * 20,
    }
    first = core.review_candidate(request)
    replay = core.review_candidate(request)
    assert json.dumps(replay, ensure_ascii=False, sort_keys=True, separators=(",", ":")) == json.dumps(
        first, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    assert database.scalar("SELECT COUNT(*) FROM knowledge_points") == 1
    with pytest.raises(CoreProblem) as conflict:
        core.review_candidate({**request, "action": "reject"})
    assert conflict.value.code == "IDEMPOTENCY_CONFLICT"
    assert database.scalar("SELECT COUNT(*) FROM knowledge_points") == 1


def test_illegal_existing_v8_enum_is_rejected_before_sql():
    class SqlMustNotRun:
        def execute(self, *_args, **_kwargs):
            raise AssertionError("SQL executed before enum validation")

    with pytest.raises(CoreProblem) as caught:
        insert_formal_knowledge_point(
            SqlMustNotRun(),
            knowledge_point_id="kp_" + "a" * 20,
            document_id="doc_" + "b" * 20,
            chunk_id="ck_" + "c" * 20,
            candidate_type="illegal-enum",
            title="标题",
            statement="陈述",
            extraction_model="fake",
            extraction_prompt_version="l1-v1",
            content_hash="d" * 64,
            created_at="2026-08-26T00:00:00Z",
        )
    assert caught.value.code == "DERIVED_STATE_MISMATCH"


@pytest.mark.parametrize(
    ("sql", "params"),
    [
        ("UPDATE p1_run_control SET status=? WHERE job_id=?", ("illegal",)),
        ("UPDATE p1_run_control SET mode=? WHERE job_id=?", ("illegal",)),
        ("UPDATE p1_candidates SET review_status=? WHERE job_id=?", ("illegal",)),
    ],
)
def test_direct_illegal_p1_values_trigger_database_checks(core, database, sql, params):
    run_id, _prepared, _candidates = _seed(core, database)
    before = _state(database)
    with pytest.raises(sqlite3.IntegrityError):
        with database.write_transaction() as con:
            con.execute(sql, (*params, run_id))
    assert _state(database) == before


def test_all_core_files_remain_below_the_owned_root(
    core, database, owned_root: Path, tmp_path: Path
):
    _seed(core, database)
    assert {entry.name for entry in owned_root.iterdir()} <= ALLOWED_ROOT_ENTRIES
    assert (owned_root / "phase1.db").is_file()
    escaped = [
        path
        for path in tmp_path.rglob("phase1.db*")
        if owned_root not in path.parents
    ]
    assert escaped == []
