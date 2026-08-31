from __future__ import annotations

import json

import pytest

from nobei_core import repository as repository_module
from nobei_core.contract import load_candidate_contract
from nobei_core.database import Phase1Database
from nobei_core.errors import CoreProblem
from nobei_core.service import Phase1Core

from conftest import PYTHON_ROOT


MODEL = {
    "provider": "provider-fixture",
    "model": "model-fixture",
    "reasoningEffort": "medium",
}


def _open(owned_root, ownership_token) -> tuple[Phase1Database, Phase1Core]:
    database = Phase1Database.open(
        owned_root, ownership_token
    )
    return database, Phase1Core(database, load_candidate_contract(PYTHON_ROOT.parent))


def _import_and_prepare(core: Phase1Core) -> tuple[str, dict[str, object]]:
    prepared = core.import_and_prepare_generation(
        {
            "filename": "recovery.txt",
            "mediaType": "text/plain",
            "text": "recover me",
            "modelSelection": MODEL,
        }
    )
    return str(prepared["runId"]), prepared


@pytest.mark.parametrize("interrupted_status", ["generating", "validating"])
def test_database_startup_recovers_interrupted_attempt_once(
    owned_root, ownership_token, interrupted_status: str
):
    database, core = _open(owned_root, ownership_token)
    run_id, prepared = _import_and_prepare(core)
    expected_revision = 3
    if interrupted_status == "validating":
        with database.write_transaction() as connection:
            connection.execute(
                "UPDATE runs SET status='validating',stage='verify',revision=3 "
                "WHERE id=?",
                (run_id,),
            )
        expected_revision = 4
    database.close()

    recovered_database, recovered_core = _open(owned_root, ownership_token)
    try:
        recovered = recovered_core.get_run({"runId": run_id})
        assert recovered["modelSelection"] == MODEL
        assert recovered["status"] == "failed_retryable"
        assert recovered["stage"] == "failed"
        assert recovered["revision"] == expected_revision
        assert recovered_database.one(
            "SELECT status,error_code,completed_at FROM generation_attempts WHERE id=?",
            (prepared["attemptId"],),
        ) == {
            "status": "failed",
            "error_code": "GENERATION_PROVIDER_ERROR",
            "completed_at": recovered_database.scalar(
                "SELECT completed_at FROM generation_attempts WHERE id=?",
                (prepared["attemptId"],),
            ),
        }
        assert recovered_database.scalar(
            "SELECT completed_at IS NOT NULL FROM generation_attempts WHERE id=?",
            (prepared["attemptId"],),
        ) == 1
        assert recovered_database.one(
            "SELECT retry_count,error_code,error_detail FROM runs WHERE id=?",
            (run_id,),
        ) == {
            "retry_count": 0,
            "error_code": "GENERATION_PROVIDER_ERROR",
            "error_detail": None,
        }
        events = recovered_core.list_events({"runId": run_id, "after": 4})["events"]
        assert events == [
            {
                "seq": 5,
                "type": "generation.interrupted",
                "stage": "failed",
                "payload": {"reason": "core_interrupted"},
            }
        ]
    finally:
        recovered_database.close()

    reopened_database, reopened_core = _open(owned_root, ownership_token)
    try:
        assert reopened_core.list_events({"runId": run_id, "after": 4})["events"] == events
        assert reopened_database.scalar(
            "SELECT COUNT(*) FROM run_events WHERE run_id=? AND type='generation.interrupted'",
            (run_id,),
        ) == 1
    finally:
        reopened_database.close()


def test_startup_recovery_spends_no_retry_and_attempt_two_becomes_terminal(
    owned_root, ownership_token
):
    database, core = _open(owned_root, ownership_token)
    run_id, first = _import_and_prepare(core)
    failed = core.fail_generation(
        {
            "runId": run_id,
            "attemptId": first["attemptId"],
            "expectedRevision": first["revision"],
            "code": "GENERATION_PROVIDER_ERROR",
        }
    )
    retried = core.retry(
        {"runId": run_id, "expectedRevision": failed["run"]["revision"]}
    )
    second = core.prepare_generation({"runId": run_id})
    assert retried["status"] == "awaiting_generation"
    assert second["attemptNumber"] == 2
    database.close()

    recovered_database, recovered_core = _open(owned_root, ownership_token)
    try:
        recovered = recovered_core.get_run({"runId": run_id})
        assert recovered["status"] == "failed_terminal"
        assert recovered["revision"] == 6
        assert recovered_database.scalar(
            "SELECT retry_count FROM runs WHERE id=?", (run_id,)
        ) == 1
        assert recovered_database.one(
            "SELECT status,error_code FROM generation_attempts WHERE id=?",
            (second["attemptId"],),
        ) == {
            "status": "failed",
            "error_code": "GENERATION_PROVIDER_ERROR",
        }
        event = recovered_core.list_events({"runId": run_id, "after": 7})["events"]
        assert event == [
            {
                "seq": 8,
                "type": "generation.interrupted",
                "stage": "failed",
                "payload": {"reason": "core_interrupted"},
            }
        ]
    finally:
        recovered_database.close()


def test_recovery_rolls_back_every_interrupted_run_when_one_event_write_fails(
    database, monkeypatch
):
    core = Phase1Core(database, load_candidate_contract(PYTHON_ROOT.parent))
    first_run, first_attempt = _import_and_prepare(core)
    second_run, second_attempt = _import_and_prepare(core)
    run_ids = (first_run, second_run)

    with database.read_snapshot() as connection:
        before = {
            "runs": [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM runs WHERE id IN (?,?) ORDER BY id",
                    run_ids,
                ).fetchall()
            ],
            "attempts": [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM generation_attempts WHERE id IN (?,?) ORDER BY id",
                    (first_attempt["attemptId"], second_attempt["attemptId"]),
                ).fetchall()
            ],
            "events": [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM run_events WHERE run_id IN (?,?) ORDER BY run_id,seq",
                    run_ids,
                ).fetchall()
            ],
        }

    original_append = repository_module.append_event
    calls = 0

    def fail_second_event(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise CoreProblem("TRANSACTION_FAILED", "injected recovery event failure")
        return original_append(*args, **kwargs)

    monkeypatch.setattr(repository_module, "append_event", fail_second_event)
    with pytest.raises(CoreProblem) as caught:
        repository_module.recover_interrupted_runs(database)
    assert caught.value.code == "TRANSACTION_FAILED"

    with database.read_snapshot() as connection:
        assert connection.in_transaction is False
        after = {
            "runs": [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM runs WHERE id IN (?,?) ORDER BY id",
                    run_ids,
                ).fetchall()
            ],
            "attempts": [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM generation_attempts WHERE id IN (?,?) ORDER BY id",
                    (first_attempt["attemptId"], second_attempt["attemptId"]),
                ).fetchall()
            ],
            "events": [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM run_events WHERE run_id IN (?,?) ORDER BY run_id,seq",
                    run_ids,
                ).fetchall()
            ],
        }
    assert after == before


def test_interruption_payload_is_closed_before_sql(monkeypatch):
    class SqlMustNotRun:
        def execute(self, *_args, **_kwargs):
            pytest.fail("closed interruption payload must be validated before SQL")

    with pytest.raises(CoreProblem) as caught:
        repository_module.append_event(
            SqlMustNotRun(),  # type: ignore[arg-type]
            "job_" + "a" * 20,
            "generation.interrupted",
            "failed",
            {"reason": "core_interrupted", "detail": json.dumps({"secret": "no"})},
        )
    assert caught.value.code == "INVALID_PARAMS"
