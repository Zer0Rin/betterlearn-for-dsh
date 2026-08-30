from __future__ import annotations

import pytest

from nobei_core import service as service_module
from nobei_core.contract import load_candidate_contract
from nobei_core.errors import CoreProblem
from nobei_core.rpc import RpcDispatcher
from nobei_core.service import Phase1Core

from conftest import PYTHON_ROOT


@pytest.fixture
def core(database):
    return Phase1Core(database, load_candidate_contract(PYTHON_ROOT.parent))


def _request(request_id: str, method: str, params: dict[str, object]):
    return {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}


def _import_params() -> dict[str, object]:
    return {
        "filename": "phase1c.md",
        "mediaType": "text/markdown",
        "text": "Phase 1C performs import and generation preparation atomically.",
        "modelSelection": {
            "provider": "test-provider",
            "model": "test-model",
            "reasoningEffort": "medium",
        },
    }


def _business_state(database) -> dict[str, list[dict[str, object]]]:
    statements = {
        "documents": "SELECT * FROM documents ORDER BY id",
        "chunks": "SELECT * FROM chunks ORDER BY id",
        "jobs": "SELECT * FROM import_jobs ORDER BY id",
        "runs": "SELECT * FROM p1_run_control ORDER BY job_id",
        "attempts": "SELECT * FROM p1_generation_attempts ORDER BY id",
        "events": "SELECT * FROM p1_run_events ORDER BY job_id,seq",
    }
    with database.read_snapshot() as connection:
        return {
            name: [dict(row) for row in connection.execute(sql).fetchall()]
            for name, sql in statements.items()
        }


def _fail_first_attempt(core: Phase1Core) -> tuple[str, dict[str, object]]:
    prepared = core.import_and_prepare_generation(_import_params())
    failed = core.fail_generation(
        {
            "runId": prepared["runId"],
            "attemptId": prepared["attemptId"],
            "expectedRevision": prepared["revision"],
            "code": "GENERATION_TIMEOUT",
        }
    )
    assert failed["run"]["status"] == "failed_retryable"
    return str(prepared["runId"]), failed["run"]


def test_protocol_v3_handshake_is_exact_and_v2_never_unlocks_dispatcher(core):
    hello_params = {
        "protocolVersion": 3,
        "schemaVersion": core._contract.schema_version,
        "schemaSha256": core._contract.schema_sha256,
    }
    assert core.hello(hello_params) == {
        "protocolVersion": 3,
        "coreVersion": "phase1e",
        "databaseKind": "sqlite",
        "capabilities": [
            "l1-text-extraction",
            "atomic-generation-commands",
            "model-selection-snapshot",
        ],
        "schemaVersion": core._contract.schema_version,
        "schemaSha256": core._contract.schema_sha256,
        "dataRootKind": "isolated-phase1",
    }

    dispatcher = RpcDispatcher(core)
    v2 = dispatcher.handle(
        _request("v2", "system.hello", {**hello_params, "protocolVersion": 2})
    )
    assert v2["error"]["data"]["code"] == "PROTOCOL_MISMATCH"
    still_locked = dispatcher.handle(
        _request("locked", "runs.get", {"runId": "job_0123456789abcdefabcd"})
    )
    assert still_locked["error"]["data"]["code"] == "PROTOCOL_MISMATCH"
    assert dispatcher.handle(_request("v3", "system.hello", hello_params))["result"] == core.hello(hello_params)


def test_import_and_prepare_exposes_only_generating_attempt_one(core, database):
    prepared = core.import_and_prepare_generation(_import_params())

    assert prepared["attemptNumber"] == 1
    assert prepared["revision"] == 2
    run = core.get_run({"runId": prepared["runId"]})
    assert run["status"] == "generating"
    assert run["revision"] == 2
    assert database.scalar(
        "SELECT COUNT(*) FROM p1_generation_attempts WHERE job_id=? AND attempt_number=1",
        (prepared["runId"],),
    ) == 1


def test_atomic_import_rolls_back_when_document_phase_fails(
    core, database, monkeypatch
):
    before = _business_state(database)
    original = service_module.append_event

    def fail_after_document_rows(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("injected after document creation")

    monkeypatch.setattr(service_module, "append_event", fail_after_document_rows)
    with pytest.raises(Exception, match="injected|TRANSACTION_FAILED"):
        core.import_and_prepare_generation(_import_params())
    assert _business_state(database) == before


def test_atomic_import_rolls_back_when_attempt_phase_fails(
    core, database, monkeypatch
):
    before = _business_state(database)
    original = service_module.transition_run

    def fail_after_attempt(*args, **kwargs):
        if args[2:4] == ("awaiting_generation", "generating"):
            raise RuntimeError("injected after attempt insertion")
        return original(*args, **kwargs)

    monkeypatch.setattr(service_module, "transition_run", fail_after_attempt)
    with pytest.raises(Exception, match="injected|TRANSACTION_FAILED"):
        core.import_and_prepare_generation(_import_params())
    assert _business_state(database) == before


def test_retry_and_prepare_atomically_starts_attempt_two(core, database):
    run_id, failed_run = _fail_first_attempt(core)

    prepared = core.retry_and_prepare_generation(
        {"runId": run_id, "expectedRevision": failed_run["revision"]}
    )

    assert prepared["attemptNumber"] == 2
    assert prepared["revision"] == failed_run["revision"] + 2
    assert database.one(
        "SELECT status,retry_count,revision FROM p1_run_control WHERE job_id=?",
        (run_id,),
    ) == {"status": "generating", "retry_count": 1, "revision": prepared["revision"]}


@pytest.mark.parametrize("case", ["stale_revision", "wrong_state", "third_attempt"])
def test_retry_and_prepare_rejections_have_no_sql_side_effect(
    core, database, case: str
):
    if case == "wrong_state":
        prepared = core.import_and_prepare_generation(_import_params())
        run_id = str(prepared["runId"])
        expected_revision = int(prepared["revision"])
    else:
        run_id, failed_run = _fail_first_attempt(core)
        expected_revision = int(failed_run["revision"])
        if case == "stale_revision":
            expected_revision -= 1
        else:
            second = core.retry_and_prepare_generation(
                {"runId": run_id, "expectedRevision": expected_revision}
            )
            terminal = core.fail_generation(
                {
                    "runId": run_id,
                    "attemptId": second["attemptId"],
                    "expectedRevision": second["revision"],
                    "code": "GENERATION_TIMEOUT",
                }
            )
            expected_revision = int(terminal["run"]["revision"])

    before = _business_state(database)
    with pytest.raises(CoreProblem, match="RUN_STATE_CONFLICT"):
        core.retry_and_prepare_generation(
            {"runId": run_id, "expectedRevision": expected_revision}
        )
    assert _business_state(database) == before
