from __future__ import annotations

import hashlib
import inspect
import json
import re

import pytest

from nobei_core.constants import GENERATION_RETRYABILITY
from nobei_core.contract import load_candidate_contract
from nobei_core.errors import CoreProblem
from nobei_core.repository import append_event
from nobei_core.service import Phase1Core

from conftest import PYTHON_ROOT


APPROVED_GENERATION_CODES = tuple(GENERATION_RETRYABILITY)
MODEL = {
    "provider": "provider-fixture",
    "model": "model-fixture",
    "reasoningEffort": "medium",
}


@pytest.fixture
def core(database):
    return Phase1Core(database, load_candidate_contract(PYTHON_ROOT.parent))


def _import(core: Phase1Core, text: str = "定义：能量守恒。") -> dict[str, object]:
    return core.import_text(
        {"filename": "generation.md", "mediaType": "text/markdown", "text": text}
    )


def _atomic_import_params(model: dict[str, object] | None = None) -> dict[str, object]:
    return {
        "filename": "generation.md",
        "mediaType": "text/markdown",
        "text": "定义：能量守恒。",
        "modelSelection": MODEL if model is None else model,
    }


def _prepare_first(core: Phase1Core, run_id: str) -> dict[str, object]:
    return core.prepare_generation({"runId": run_id, "modelSelection": MODEL})


def _sql_state(database) -> dict[str, list[dict[str, object]]]:
    queries = {
        "runs": "SELECT * FROM runs ORDER BY rowid",
        "generation_attempts": "SELECT * FROM generation_attempts ORDER BY rowid",
        "run_events": "SELECT * FROM run_events ORDER BY rowid",
    }
    with database.read_snapshot() as connection:
        return {
            table: [dict(row) for row in connection.execute(query).fetchall()]
            for table, query in queries.items()
        }


def _fail(
    core: Phase1Core,
    run_id: str,
    attempt_id: str,
    revision: int,
    code: str = "GENERATION_TIMEOUT",
) -> dict[str, object]:
    return core.fail_generation(
        {
            "runId": run_id,
            "attemptId": attempt_id,
            "expectedRevision": revision,
            "code": code,
        }
    )


def test_atomic_prepare_persists_and_returns_closed_model_selection(
    core: Phase1Core, database
):
    prepared = core.import_and_prepare_generation(_atomic_import_params())
    stored = database.scalar(
        "SELECT model_metadata_json FROM generation_attempts WHERE id=?",
        (prepared["attemptId"],),
    )

    assert prepared["modelSelection"] == MODEL
    assert json.loads(stored) == MODEL
    assert core.get_run({"runId": prepared["runId"]})["modelSelection"] == MODEL


def test_output_limit_is_saved_and_requires_explicit_retry(core: Phase1Core, database):
    prepared = core.import_and_prepare_generation(_atomic_import_params())
    failed = _fail(core, prepared["runId"], prepared["attemptId"], prepared["revision"], "GENERATION_OUTPUT_LIMIT")
    assert failed["run"]["error"] == {"code": "GENERATION_OUTPUT_LIMIT", "retryable": True}
    assert core.get_run({"runId": prepared["runId"]})["error"] == failed["run"]["error"]
    assert database.scalar("SELECT count(*) FROM generation_attempts") == 1
    retry = core.retry_and_prepare_generation({"runId": prepared["runId"], "expectedRevision": failed["run"]["revision"]})
    assert retry["modelSelection"] == MODEL
    terminal = _fail(core, retry["runId"], retry["attemptId"], retry["revision"], "GENERATION_OUTPUT_LIMIT")
    assert terminal["run"]["error"] == {"code": "GENERATION_OUTPUT_LIMIT", "retryable": False}


def test_model_selection_changes_request_digest_and_optional_effort_may_be_absent(
    core: Phase1Core,
):
    selections = (
        {"provider": "provider-a", "model": "model-a"},
        {"provider": "provider-b", "model": "model-a"},
        {"provider": "provider-a", "model": "model-b"},
        {"provider": "provider-a", "model": "model-a", "reasoningEffort": "high"},
    )
    prepared = [
        core.import_and_prepare_generation(_atomic_import_params(selection))
        for selection in selections
    ]

    assert len({result["requestDigest"] for result in prepared}) == len(selections)
    assert prepared[0]["modelSelection"] == selections[0]


@pytest.mark.parametrize(
    "selection",
    [
        {"provider": "", "model": "model-fixture"},
        {"provider": "provider-fixture", "model": ""},
        {"provider": "provider-fixture", "model": "model-fixture", "extra": "x"},
        {"provider": "provider-fixture", "model": "model-fixture", "reasoningEffort": None},
        {"provider": "provider-fixture", "model": "model-fixture", "reasoningEffort": ""},
    ],
)
def test_atomic_prepare_rejects_invalid_model_selection_before_sql(
    core: Phase1Core, database, selection: dict[str, object]
):
    before = _sql_state(database)
    with pytest.raises(CoreProblem) as caught:
        core.import_and_prepare_generation(_atomic_import_params(selection))
    assert caught.value.code == "INVALID_PARAMS"
    assert _sql_state(database) == before


def test_retry_copies_attempt_one_model_and_finalize_cannot_rewrite_it(
    core: Phase1Core, database
):
    first = core.import_and_prepare_generation(_atomic_import_params())
    failed = core.fail_generation(
        {
            "runId": first["runId"],
            "attemptId": first["attemptId"],
            "expectedRevision": first["revision"],
            "code": "GENERATION_TIMEOUT",
        }
    )
    second = core.retry_and_prepare_generation(
        {"runId": first["runId"], "expectedRevision": failed["run"]["revision"]}
    )
    assert second["modelSelection"] == MODEL
    assert json.loads(database.scalar(
        "SELECT model_metadata_json FROM generation_attempts WHERE id=?",
        (second["attemptId"],),
    )) == MODEL

    before = _sql_state(database)
    with pytest.raises(CoreProblem) as caught:
        core.fail_generation(
            {
                "runId": second["runId"],
                "attemptId": second["attemptId"],
                "expectedRevision": second["revision"],
                "code": "GENERATION_TIMEOUT",
                "modelMetadata": {"provider": "other", "model": "other"},
            }
        )
    assert caught.value.code == "INVALID_PARAMS"
    assert _sql_state(database) == before


def test_submit_cannot_rewrite_model_and_completed_snapshot_retains_it(
    core: Phase1Core, database
):
    prepared = core.import_and_prepare_generation(_atomic_import_params())
    before = _sql_state(database)
    with pytest.raises(CoreProblem) as caught:
        core.submit_generation(
            {
                "runId": prepared["runId"],
                "attemptId": prepared["attemptId"],
                "expectedRevision": prepared["revision"],
                "output": {"schemaVersion": 1, "candidates": []},
                "modelMetadata": {"provider": "other", "model": "other"},
            }
        )
    assert caught.value.code == "INVALID_PARAMS"
    assert _sql_state(database) == before

    completed = core.submit_generation(
        {
            "runId": prepared["runId"],
            "attemptId": prepared["attemptId"],
            "expectedRevision": prepared["revision"],
            "output": {"schemaVersion": 1, "candidates": []},
        }
    )
    assert completed["run"]["status"] == "completed"
    assert completed["run"]["modelSelection"] == MODEL


def test_prepare_generation_returns_exact_deterministic_request(core: Phase1Core, database):
    canonical_text = "定义：能量守恒。"
    imported = _import(core, canonical_text)
    run_id = str(imported["runId"])
    contract = load_candidate_contract(PYTHON_ROOT.parent)
    document_sha = hashlib.sha256(canonical_text.encode("utf-8")).hexdigest()

    prepared = _prepare_first(core, run_id)

    assert prepared.keys() == {
        "runId",
        "attemptId",
        "attemptNumber",
        "revision",
        "schemaVersion",
        "schemaSha256",
        "promptVersion",
        "document",
        "modelSelection",
        "requestDigest",
        "providerIdempotencyKey",
    }
    assert prepared["runId"] == run_id
    assert prepared["attemptNumber"] == 1
    assert prepared["revision"] == 2
    assert prepared["schemaVersion"] == 1
    assert prepared["schemaSha256"] == contract.schema_sha256
    assert prepared["promptVersion"] == "l1-v3"
    assert prepared["document"] == {"text": canonical_text, "sha256": document_sha}
    assert prepared["modelSelection"] == MODEL
    assert re.fullmatch(r"att_[0-9a-f]{20}", str(prepared["attemptId"]))

    digest_input = {
        "runId": run_id,
        "attemptNumber": 1,
        "documentSha256": document_sha,
        "schemaVersion": 1,
        "schemaSha256": contract.schema_sha256,
        "promptVersion": "l1-v3",
        "modelSelection": MODEL,
    }
    expected_digest = hashlib.sha256(
        json.dumps(
            digest_input, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()
    assert prepared["requestDigest"] == expected_digest
    assert re.fullmatch(r"[0-9a-f]{64}", str(prepared["requestDigest"]))
    assert prepared["providerIdempotencyKey"] == "nobei:" + expected_digest
    assert database.one(
        "SELECT run_id,attempt_number,request_digest,provider_idempotency_key,"
        "model_metadata_json,status,error_code,completed_at "
        "FROM generation_attempts WHERE id=?",
        (prepared["attemptId"],),
    ) == {
        "run_id": run_id,
        "attempt_number": 1,
        "request_digest": expected_digest,
        "provider_idempotency_key": "nobei:" + expected_digest,
        "model_metadata_json": json.dumps(
            MODEL, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ),
        "status": "started",
        "error_code": None,
        "completed_at": None,
    }
    assert core.list_events({"runId": run_id, "after": 3})["events"] == [
        {
            "seq": 4,
            "type": "generation.started",
            "stage": "extract",
            "payload": {"attemptId": prepared["attemptId"], "attemptNumber": 1},
        }
    ]


def test_prepare_generation_rejects_second_prepare_without_sql_mutation(
    core: Phase1Core, database
):
    run_id = str(_import(core)["runId"])
    _prepare_first(core, run_id)
    before = _sql_state(database)

    with pytest.raises(CoreProblem) as caught:
        core.prepare_generation({"runId": run_id})

    assert caught.value.code == "RUN_STATE_CONFLICT"
    assert _sql_state(database) == before


@pytest.mark.parametrize("code", APPROVED_GENERATION_CODES)
def test_first_attempt_failure_accepts_each_closed_code_as_retryable(
    core: Phase1Core, database, code: str
):
    run_id = str(_import(core)["runId"])
    prepared = _prepare_first(core, run_id)

    result = _fail(
        core,
        run_id,
        str(prepared["attemptId"]),
        int(prepared["revision"]),
        code,
    )

    assert result.keys() == {"run", "error"}
    assert result["run"]["status"] == "failed_retryable"
    assert result["run"]["revision"] == 3
    assert result["error"] == {"code": code, "retryable": True}
    attempt = database.one(
        "SELECT status,error_code,model_metadata_json,completed_at "
        "FROM generation_attempts WHERE id=?",
        (prepared["attemptId"],),
    )
    assert attempt == {
        "status": "failed",
        "error_code": code,
        "model_metadata_json": json.dumps(
            MODEL, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ),
        "completed_at": attempt["completed_at"],
    }
    assert attempt["completed_at"] is not None
    assert database.one(
        "SELECT retry_count,error_code,error_detail FROM runs WHERE id=?",
        (run_id,),
    ) == {"retry_count": 0, "error_code": code, "error_detail": None}
    assert core.list_events({"runId": run_id, "after": 4})["events"] == [
        {
            "seq": 5,
            "type": "generation.failed",
            "stage": "failed",
            "payload": {
                "attemptId": prepared["attemptId"],
                "code": code,
                "retryable": True,
            },
        }
    ]


def test_retry_budget_is_explicit_and_attempt_two_failure_is_terminal(
    core: Phase1Core, database
):
    run_id = str(_import(core)["runId"])
    first = _prepare_first(core, run_id)
    failed_first = _fail(core, run_id, str(first["attemptId"]), int(first["revision"]))
    assert database.scalar(
        "SELECT retry_count FROM runs WHERE id=?", (run_id,)
    ) == 0

    retried = core.retry(
        {"runId": run_id, "expectedRevision": failed_first["run"]["revision"]}
    )

    assert retried["status"] == "awaiting_generation"
    assert retried["revision"] == 4
    assert database.scalar(
        "SELECT retry_count FROM runs WHERE id=?", (run_id,)
    ) == 1
    assert core.list_events({"runId": run_id, "after": 5})["events"] == [
        {
            "seq": 6,
            "type": "generation.retry_requested",
            "stage": "extract",
            "payload": {"retryCount": 1},
        }
    ]

    second = core.prepare_generation({"runId": run_id})
    assert second["attemptNumber"] == 2
    assert second["revision"] == 5
    failed_second = _fail(
        core,
        run_id,
        str(second["attemptId"]),
        int(second["revision"]),
        "GENERATION_PROVIDER_ERROR",
    )
    assert failed_second["run"]["status"] == "failed_terminal"
    assert failed_second["run"]["revision"] == 6
    assert failed_second["error"] == {
        "code": "GENERATION_PROVIDER_ERROR",
        "retryable": False,
    }
    assert database.scalar(
        "SELECT retry_count FROM runs WHERE id=?", (run_id,)
    ) == 1

    before = _sql_state(database)
    with pytest.raises(CoreProblem) as caught:
        core.retry({"runId": run_id, "expectedRevision": 6})
    assert caught.value.code == "RUN_STATE_CONFLICT"
    assert _sql_state(database) == before


def test_generation_commands_have_no_provider_dependency_or_retry_flag(core: Phase1Core):
    assert tuple(inspect.signature(Phase1Core.__init__).parameters) == (
        "self",
        "database",
        "contract",
    )
    run_id = str(_import(core)["runId"])
    prepared = _prepare_first(core, run_id)

    with pytest.raises(CoreProblem) as caught:
        core.fail_generation(
            {
                "runId": run_id,
                "attemptId": prepared["attemptId"],
                "expectedRevision": prepared["revision"],
                "code": "GENERATION_TIMEOUT",
                "retryable": True,
            }
        )

    assert caught.value.code == "INVALID_PARAMS"


@pytest.mark.parametrize(
    "patch",
    [
        {"code": "UNKNOWN_GENERATION_ERROR"},
        {"expectedRevision": True},
        {"modelMetadata": {"provider": "test-provider", "model": "test-model"}},
        {"unexpected": True},
    ],
)
def test_fail_generation_rejects_invalid_closed_params_before_sql(
    core: Phase1Core, database, patch: dict[str, object]
):
    run_id = str(_import(core)["runId"])
    prepared = _prepare_first(core, run_id)
    command = {
        "runId": run_id,
        "attemptId": prepared["attemptId"],
        "expectedRevision": prepared["revision"],
        "code": "GENERATION_TIMEOUT",
        **patch,
    }
    before = _sql_state(database)

    with pytest.raises(CoreProblem) as caught:
        core.fail_generation(command)

    assert caught.value.code == "INVALID_PARAMS"
    assert _sql_state(database) == before


def test_fail_generation_conflicts_never_mutate_sql(core: Phase1Core, database):
    run_a = str(_import(core, "run a")["runId"])
    run_b = str(_import(core, "run b")["runId"])
    first_a = _prepare_first(core, run_a)
    first_b = _prepare_first(core, run_b)

    conflict_commands = [
        (
            {
                "runId": run_a,
                "attemptId": first_b["attemptId"],
                "expectedRevision": first_a["revision"],
                "code": "GENERATION_TIMEOUT",
            },
            "ATTEMPT_MISMATCH",
        ),
        (
            {
                "runId": run_a,
                "attemptId": first_a["attemptId"],
                "expectedRevision": int(first_a["revision"]) + 1,
                "code": "GENERATION_TIMEOUT",
            },
            "RUN_STATE_CONFLICT",
        ),
    ]
    for command, expected_code in conflict_commands:
        before = _sql_state(database)
        with pytest.raises(CoreProblem) as caught:
            core.fail_generation(command)
        assert caught.value.code == expected_code
        assert _sql_state(database) == before

    first_failure = _fail(
        core, run_a, str(first_a["attemptId"]), int(first_a["revision"])
    )
    core.retry(
        {"runId": run_a, "expectedRevision": first_failure["run"]["revision"]}
    )
    second_a = core.prepare_generation({"runId": run_a})
    before_old_attempt = _sql_state(database)
    with pytest.raises(CoreProblem) as caught_old:
        _fail(core, run_a, str(first_a["attemptId"]), int(second_a["revision"]))
    assert caught_old.value.code == "ATTEMPT_MISMATCH"
    assert _sql_state(database) == before_old_attempt

    with database.write_transaction() as connection:
        connection.execute(
            "UPDATE runs SET status='completed',stage='done',revision=revision+1 "
            "WHERE id=?",
            (run_a,),
        )
    completed_revision = int(
        database.scalar("SELECT revision FROM runs WHERE id=?", (run_a,))
    )
    before_terminal = _sql_state(database)
    with pytest.raises(CoreProblem) as caught_terminal:
        _fail(core, run_a, str(second_a["attemptId"]), completed_revision)
    assert caught_terminal.value.code == "RUN_STATE_CONFLICT"
    assert _sql_state(database) == before_terminal


def test_generation_failure_event_rejects_non_string_code_before_sql():
    class SqlMustNotRun:
        def execute(self, *_args, **_kwargs):
            pytest.fail("failure payload validation must precede SQL")

    with pytest.raises(CoreProblem) as caught:
        append_event(
            SqlMustNotRun(),  # type: ignore[arg-type]
            "job_" + "a" * 20,
            "generation.failed",
            "failed",
            {
                "attemptId": "att_" + "b" * 20,
                "code": [],
                "retryable": True,
            },
        )

    assert caught.value.code == "INVALID_PARAMS"
