from __future__ import annotations

import json
import threading
from queue import Queue

import pytest

from nobei_core import service as service_module
from nobei_core.constants import EVENT_AFTER_MAX
from nobei_core.contract import load_candidate_contract
from nobei_core.database import Phase1Database
from nobei_core.errors import CoreProblem
from nobei_core.repository import append_event, read_run_events, recover_interrupted_runs
from nobei_core.service import Phase1Core

from conftest import MIGRATIONS_ROOT, PHASE1_SCHEMA_PATH, PYTHON_ROOT


RUN_FIELDS = {
    "runId",
    "documentId",
    "status",
    "stage",
    "revision",
    "retryCount",
    "lastEventSeq",
    "counts",
    "error",
    "document",
}
COUNT_FIELDS = {
    "rawCandidates",
    "validCandidates",
    "pending",
    "accepted",
    "editedAndAccepted",
    "rejected",
    "knowledgePoints",
}
DOCUMENT_FIELDS = {
    "filename",
    "mediaType",
    "byteSize",
    "characterCount",
    "text",
}
EVIDENCE_FIELDS = {
    "seq",
    "quote",
    "textStart",
    "textEnd",
    "contextBefore",
    "contextAfter",
}
CANDIDATE_FIELDS = {
    "candidateId",
    "type",
    "title",
    "statement",
    "reviewStatus",
    "revision",
    "knowledgePointId",
    "evidence",
}
KNOWLEDGE_POINT_FIELDS = {
    "knowledgePointId",
    "type",
    "title",
    "statement",
    "documentId",
    "evidence",
}
EVENT_FIELDS = {"seq", "type", "stage", "payload"}


@pytest.fixture
def core(database):
    return Phase1Core(database, load_candidate_contract(PYTHON_ROOT.parent))


def _open(owned_root, ownership_token) -> tuple[Phase1Database, Phase1Core]:
    database = Phase1Database.open(
        owned_root, ownership_token, MIGRATIONS_ROOT, PHASE1_SCHEMA_PATH
    )
    return database, Phase1Core(database, load_candidate_contract(PYTHON_ROOT.parent))


def _metadata() -> dict[str, str]:
    return {"provider": "snapshot-provider", "model": "snapshot-model"}


def _prepare_generation(core: Phase1Core, run_id: str) -> dict[str, object]:
    run = core.get_run({"runId": run_id})
    params: dict[str, object] = {"runId": run_id}
    if run["retryCount"] == 0:
        params["modelSelection"] = _metadata()
    return core.prepare_generation(params)


def _import(core: Phase1Core) -> tuple[str, str]:
    imported = core.import_text(
        {
            "filename": "快照.md",
            "mediaType": "text/markdown",
            "text": "甲定义。乙过程。丙比较。丁公式。",
        }
    )
    return str(imported["runId"]), str(imported["documentId"])


def _submit_candidates(core: Phase1Core) -> tuple[str, str]:
    run_id, document_id = _import(core)
    prepared = _prepare_generation(core, run_id)
    output = {
        "schemaVersion": 1,
        "candidates": [
            {
                "type": "concept",
                "title": "甲",
                "statement": "甲是定义。",
                "evidence": [{"quote": "甲定义", "prefix": "", "suffix": "。"}],
            },
            {
                "type": "process",
                "title": "乙",
                "statement": "乙是过程。",
                "evidence": [{"quote": "乙过程", "prefix": "。", "suffix": "。"}],
            },
            {
                "type": "comparison",
                "title": "丙",
                "statement": "丙是比较。",
                "evidence": [{"quote": "丙比较", "prefix": "。", "suffix": "。"}],
            },
            {
                "type": "formula",
                "title": "丁",
                "statement": "丁是公式。",
                "evidence": [{"quote": "丁公式", "prefix": "。", "suffix": "。"}],
            },
            {
                "type": "fact",
                "title": "无效",
                "statement": "该候选没有本文证据。",
                "evidence": [{"quote": "不在本文", "prefix": "", "suffix": ""}],
            },
        ],
    }
    result = core.submit_generation(
        {
            "runId": run_id,
            "attemptId": prepared["attemptId"],
            "expectedRevision": prepared["revision"],
            "output": output,
        }
    )
    assert result["run"]["status"] == "review_pending"
    return run_id, document_id


def _review(
    core: Phase1Core,
    candidate: dict[str, object],
    action: str,
    key_character: str,
    **fields: object,
) -> dict[str, object]:
    return core.review_candidate(
        {
            "candidateId": candidate["candidateId"],
            "action": action,
            "expectedRevision": candidate["revision"],
            "idempotencyKey": "idem_" + key_character * 20,
            **fields,
        }
    )


def _canonical_bytes(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _assert_closed_run(run: dict[str, object]) -> None:
    expected = RUN_FIELDS | ({"modelSelection"} if run["revision"] >= 2 else set())
    assert set(run) == expected
    assert set(run["counts"]) == COUNT_FIELDS
    assert set(run["document"]) == DOCUMENT_FIELDS
    if run["error"] is not None:
        assert set(run["error"]) == {"code", "retryable"}


def test_imported_run_snapshot_has_exact_document_metadata_and_zero_counts(
    core: Phase1Core,
):
    run_id, document_id = _import(core)

    run = core.get_run({"runId": run_id})

    _assert_closed_run(run)
    assert run == {
        "runId": run_id,
        "documentId": document_id,
        "status": "awaiting_generation",
        "stage": "extract",
        "revision": 1,
        "retryCount": 0,
        "lastEventSeq": 3,
        "counts": {
            "rawCandidates": 0,
            "validCandidates": 0,
            "pending": 0,
            "accepted": 0,
            "editedAndAccepted": 0,
            "rejected": 0,
            "knowledgePoints": 0,
        },
        "error": None,
        "document": {
            "filename": "快照.md",
            "mediaType": "text/markdown",
            "byteSize": len("甲定义。乙过程。丙比较。丁公式。".encode("utf-8")),
            "characterCount": len("甲定义。乙过程。丙比较。丁公式。"),
            "text": "甲定义。乙过程。丙比较。丁公式。",
        },
    }
    assert core.list_candidates({"runId": run_id}) == {"candidates": []}
    assert core.list_knowledge_points({"runId": run_id}) == {
        "knowledgePoints": []
    }


def test_run_error_retryability_is_derived_from_code_and_retry_count(core: Phase1Core):
    run_id, _ = _import(core)
    first = _prepare_generation(core, run_id)
    failed_first = core.fail_generation(
        {
            "runId": run_id,
            "attemptId": first["attemptId"],
            "expectedRevision": first["revision"],
            "code": "GENERATION_TIMEOUT",
        }
    )
    assert failed_first["run"]["error"] == {
        "code": "GENERATION_TIMEOUT",
        "retryable": True,
    }

    retried = core.retry(
        {"runId": run_id, "expectedRevision": failed_first["run"]["revision"]}
    )
    assert retried["retryCount"] == 1
    assert retried["error"] is None
    second = _prepare_generation(core, run_id)
    failed_second = core.fail_generation(
        {
            "runId": run_id,
            "attemptId": second["attemptId"],
            "expectedRevision": second["revision"],
            "code": "GENERATION_TIMEOUT",
        }
    )
    assert failed_second["run"]["error"] == {
        "code": "GENERATION_TIMEOUT",
        "retryable": False,
    }
    assert core.get_run({"runId": run_id}) == failed_second["run"]


def test_candidate_and_knowledge_point_snapshots_are_closed_ordered_and_exact(
    core: Phase1Core, database
):
    run_id, document_id = _submit_candidates(core)
    candidates = core.list_candidates({"runId": run_id})["candidates"]
    original_evidence = [list(candidate["evidence"]) for candidate in candidates]

    accepted = _review(core, candidates[0], "accept", "a")
    edited = _review(
        core,
        candidates[1],
        "edited_and_accept",
        "b",
        title="乙（定稿）",
        statement="乙过程的最终陈述。",
    )
    _review(core, candidates[2], "reject", "c")

    listed = core.list_candidates({"runId": run_id})
    knowledge = core.list_knowledge_points({"runId": run_id})
    run = core.get_run({"runId": run_id})

    assert set(listed) == {"candidates"}
    assert set(knowledge) == {"knowledgePoints"}
    assert [candidate["candidateId"] for candidate in listed["candidates"]] == [
        candidate["candidateId"] for candidate in candidates
    ]
    assert all(set(candidate) == CANDIDATE_FIELDS for candidate in listed["candidates"])
    assert all(
        set(evidence) == EVIDENCE_FIELDS
        for candidate in listed["candidates"]
        for evidence in candidate["evidence"]
    )
    assert [candidate["evidence"] for candidate in listed["candidates"]] == original_evidence
    assert listed["candidates"][1]["title"] == "乙（定稿）"
    assert listed["candidates"][1]["statement"] == "乙过程的最终陈述。"
    assert [candidate["reviewStatus"] for candidate in listed["candidates"]] == [
        "accepted",
        "edited_and_accepted",
        "rejected",
        "pending",
    ]

    assert all(set(point) == KNOWLEDGE_POINT_FIELDS for point in knowledge["knowledgePoints"])
    assert all(
        set(evidence) == EVIDENCE_FIELDS
        for point in knowledge["knowledgePoints"]
        for evidence in point["evidence"]
    )
    assert knowledge["knowledgePoints"] == [
        accepted["knowledgePoint"],
        edited["knowledgePoint"],
    ]
    assert knowledge["knowledgePoints"][1]["title"] == "乙（定稿）"
    assert all(point["documentId"] == document_id for point in knowledge["knowledgePoints"])
    assert run["counts"] == {
        "rawCandidates": 5,
        "validCandidates": 4,
        "pending": 1,
        "accepted": 1,
        "editedAndAccepted": 1,
        "rejected": 1,
        "knowledgePoints": 2,
    }
    assert run["lastEventSeq"] == 9
    assert database.scalar(
        "SELECT accepted_candidate_count FROM p1_run_control WHERE job_id=?", (run_id,)
    ) == 2

    completed = _review(core, listed["candidates"][3], "reject", "d")
    assert completed["run"]["status"] == "completed"
    assert completed["run"]["stage"] == "done"
    assert completed["run"]["counts"] == {
        **run["counts"],
        "pending": 0,
        "rejected": 2,
    }
    assert completed["run"]["lastEventSeq"] == 11


def test_future_database_columns_and_raw_generation_output_are_never_exposed(
    core: Phase1Core, database
):
    run_id, _ = _submit_candidates(core)
    first_candidate = core.list_candidates({"runId": run_id})["candidates"][0]
    _review(core, first_candidate, "accept", "e")
    with database.write_transaction() as connection:
        connection.execute("ALTER TABLE p1_run_control ADD COLUMN future_run_secret TEXT")
        connection.execute("ALTER TABLE documents ADD COLUMN future_document_secret TEXT")
        connection.execute("ALTER TABLE p1_candidates ADD COLUMN future_candidate_secret TEXT")
        connection.execute("ALTER TABLE p1_run_events ADD COLUMN future_event_secret TEXT")
        connection.execute("ALTER TABLE knowledge_points ADD COLUMN future_kp_secret TEXT")
        connection.execute(
            "UPDATE p1_run_control SET future_run_secret='RUN_SECRET' WHERE job_id=?",
            (run_id,),
        )
        connection.execute(
            "UPDATE documents SET future_document_secret='DOCUMENT_SECRET'"
        )
        connection.execute(
            "UPDATE p1_candidates SET future_candidate_secret='CANDIDATE_SECRET'"
        )
        connection.execute(
            "UPDATE p1_run_events SET future_event_secret='EVENT_SECRET'"
        )
        connection.execute(
            "UPDATE knowledge_points SET future_kp_secret='KP_SECRET'"
        )

    public = {
        "run": core.get_run({"runId": run_id}),
        "events": core.list_events({"runId": run_id, "after": 0}),
        "candidates": core.list_candidates({"runId": run_id}),
        "knowledgePoints": core.list_knowledge_points({"runId": run_id}),
    }
    encoded = _canonical_bytes(public)

    _assert_closed_run(public["run"])
    assert public["run"]["modelSelection"] == _metadata()
    assert all(set(event) == EVENT_FIELDS for event in public["events"]["events"])
    assert all(
        secret not in encoded
        for secret in (
            b"RUN_SECRET",
            b"DOCUMENT_SECRET",
            b"CANDIDATE_SECRET",
            b"EVENT_SECRET",
            b"KP_SECRET",
            b"raw_output_json",
        )
    )


@pytest.mark.parametrize(
    "mutation",
    ["byte_size", "character_count", "document_sha256", "text"],
)
def test_run_snapshot_rejects_document_fact_drift(
    core: Phase1Core, database, mutation: str
):
    run_id, _ = _import(core)
    with database.write_transaction() as connection:
        if mutation == "text":
            connection.execute(
                "UPDATE chunks SET text=text || '漂移' WHERE document_id="
                "(SELECT document_id FROM import_jobs WHERE id=?)",
                (run_id,),
            )
        elif mutation == "document_sha256":
            connection.execute(
                "UPDATE p1_run_control SET document_sha256=? WHERE job_id=?",
                ("f" * 64, run_id),
            )
        else:
            connection.execute(
                f"UPDATE p1_run_control SET {mutation}={mutation}+1 WHERE job_id=?",
                (run_id,),
            )

    with pytest.raises(CoreProblem) as caught:
        core.get_run({"runId": run_id})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"


def test_candidate_and_knowledge_point_queries_reject_nonexact_stored_evidence(
    core: Phase1Core, database
):
    run_id, _ = _submit_candidates(core)
    candidate = core.list_candidates({"runId": run_id})["candidates"][0]
    accepted = _review(core, candidate, "accept", "f")
    knowledge_point_id = accepted["knowledgePoint"]["knowledgePointId"]
    with database.write_transaction() as connection:
        connection.execute(
            "UPDATE p1_candidate_evidence SET quote='ZZ' WHERE candidate_id=?",
            (candidate["candidateId"],),
        )
        connection.execute(
            "UPDATE kp_evidence SET quote='ZZ' WHERE kp_id=?",
            (knowledge_point_id,),
        )

    with pytest.raises(CoreProblem) as candidate_error:
        core.list_candidates({"runId": run_id})
    with pytest.raises(CoreProblem) as point_error:
        core.list_knowledge_points({"runId": run_id})

    assert candidate_error.value.code == "DERIVED_STATE_MISMATCH"
    assert point_error.value.code == "DERIVED_STATE_MISMATCH"


@pytest.mark.parametrize("mutation", ["quote", "offset", "context"])
def test_idempotent_review_replay_rejects_nonexact_closed_evidence(
    core: Phase1Core, database, mutation: str
):
    run_id, _ = _submit_candidates(core)
    candidate = core.list_candidates({"runId": run_id})["candidates"][0]
    command = {
        "candidateId": candidate["candidateId"],
        "action": "accept",
        "expectedRevision": candidate["revision"],
        "idempotencyKey": "idem_" + "6" * 20,
    }
    core.review_candidate(command)
    stored = database.scalar(
        "SELECT result_json FROM p1_idempotency WHERE idempotency_key=?",
        (command["idempotencyKey"],),
    )
    corrupted = json.loads(stored)
    for owner in ("candidate", "knowledgePoint"):
        evidence = corrupted[owner]["evidence"][0]
        if mutation == "quote":
            evidence["quote"] = "ZZ"
        elif mutation == "offset":
            evidence["textStart"] += 1
        else:
            evidence["contextBefore"] = "ZZ"
    with database.write_transaction() as connection:
        connection.execute(
            "UPDATE p1_idempotency SET result_json=? WHERE idempotency_key=?",
            (
                json.dumps(
                    corrupted,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                command["idempotencyKey"],
            ),
        )

    with pytest.raises(CoreProblem) as caught:
        core.review_candidate(command)

    assert caught.value.code == "TRANSACTION_FAILED"


def test_event_query_rejects_cross_run_resource_payloads(core: Phase1Core, database):
    first_run, _ = _submit_candidates(core)
    second_run, second_document = _submit_candidates(core)
    first_candidate = core.list_candidates({"runId": first_run})["candidates"][0]
    second_candidate = core.list_candidates({"runId": second_run})["candidates"][0]
    _review(core, first_candidate, "accept", "1")
    _review(core, second_candidate, "accept", "2")
    second_attempt = database.one(
        "SELECT id,attempt_number FROM p1_generation_attempts WHERE job_id=?",
        (second_run,),
    )
    assert second_attempt is not None
    mutations = [
        (1, {"runId": second_run}),
        (2, {"documentId": second_document}),
        (
            4,
            {
                "attemptId": second_attempt["id"],
                "attemptNumber": second_attempt["attempt_number"],
            },
        ),
        (5, {"attemptId": second_attempt["id"]}),
        (7, {"candidateId": second_candidate["candidateId"]}),
    ]
    for seq, payload in mutations:
        original = database.scalar(
            "SELECT payload_json FROM p1_run_events WHERE job_id=? AND seq=?",
            (first_run, seq),
        )
        with database.write_transaction() as connection:
            connection.execute(
                "UPDATE p1_run_events SET payload_json=? WHERE job_id=? AND seq=?",
                (
                    json.dumps(
                        payload,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                    first_run,
                    seq,
                ),
            )
        with pytest.raises(CoreProblem) as caught:
            core.list_events({"runId": first_run, "after": seq - 1})
        assert caught.value.code == "DERIVED_STATE_MISMATCH"
        with database.write_transaction() as connection:
            connection.execute(
                "UPDATE p1_run_events SET payload_json=? WHERE job_id=? AND seq=?",
                (original, first_run, seq),
            )


def test_event_cursor_pages_a_valid_real_ledger_with_stable_next_after(
    core: Phase1Core, monkeypatch
):
    run_id, _ = _submit_candidates(core)
    candidates = core.list_candidates({"runId": run_id})["candidates"]
    for index, candidate in enumerate(candidates):
        _review(core, candidate, "reject", str(index))
    monkeypatch.setattr(service_module, "_EVENT_PAGE_LIMIT", 2)

    first = core.list_events({"runId": run_id, "after": 0})
    second = core.list_events({"runId": run_id, "after": first["nextAfter"]})
    cursor = second["nextAfter"]
    pages = [first, second]
    while pages[-1]["events"]:
        pages.append(core.list_events({"runId": run_id, "after": pages[-1]["nextAfter"]}))
    beyond = core.list_events({"runId": run_id, "after": EVENT_AFTER_MAX})

    assert set(first) == {"events", "nextAfter"}
    assert [event["seq"] for event in first["events"]] == [1, 2]
    assert first["nextAfter"] == 2
    assert [event["seq"] for event in second["events"]] == [3, 4]
    assert cursor == 4
    assert all(len(page["events"]) <= 2 for page in pages)
    assert pages[-1] == {"events": [], "nextAfter": 11}
    assert beyond == {"events": [], "nextAfter": EVENT_AFTER_MAX}

    for invalid in (True, False, -1, EVENT_AFTER_MAX + 1, 1.0, "1", None):
        with pytest.raises(CoreProblem) as caught:
            core.list_events({"runId": run_id, "after": invalid})
        assert caught.value.code == "INVALID_PARAMS"


def test_production_event_limit_is_200_at_repository_boundary(
    core: Phase1Core, database
):
    assert service_module._EVENT_PAGE_LIMIT == 200
    run_id, _ = _import(core)
    with database.write_transaction() as connection:
        for _ in range(202):
            append_event(
                connection,
                run_id,
                "generation.awaiting",
                "extract",
                {"retryCount": 0},
            )
        rows = read_run_events(connection, run_id, 0, service_module._EVENT_PAGE_LIMIT)

    assert len(rows) == 200
    assert [row["seq"] for row in rows] == list(range(1, 201))


@pytest.mark.parametrize(
    "method,params",
    [
        ("get_run", {}),
        ("list_events", {"after": 0}),
        ("list_candidates", {}),
        ("list_knowledge_points", {}),
    ],
)
@pytest.mark.parametrize("run_id", ["not-a-run", "job_" + "f" * 20])
def test_snapshot_queries_reject_malformed_or_unowned_run_ids(
    core: Phase1Core, method: str, params: dict[str, object], run_id: str
):
    with pytest.raises(CoreProblem) as caught:
        getattr(core, method)({"runId": run_id, **params})

    assert caught.value.code == "INVALID_IDENTIFIER"
    assert caught.value.public() == {"code": "INVALID_IDENTIFIER"}


def test_clean_reopen_preserves_all_snapshot_bytes_without_appending_events(
    owned_root, ownership_token
):
    database, core = _open(owned_root, ownership_token)
    run_id, _ = _submit_candidates(core)
    candidates = core.list_candidates({"runId": run_id})["candidates"]
    _review(core, candidates[0], "accept", "3")
    _review(
        core,
        candidates[1],
        "edited_and_accept",
        "4",
        title="重启后的定稿",
        statement="重启必须保留最终文本。",
    )
    _review(core, candidates[2], "reject", "5")
    before = {
        "run": core.get_run({"runId": run_id}),
        "events": core.list_events({"runId": run_id, "after": 0}),
        "candidates": core.list_candidates({"runId": run_id}),
        "knowledgePoints": core.list_knowledge_points({"runId": run_id}),
    }
    before_bytes = _canonical_bytes(before)
    database.close()

    reopened_database, reopened_core = _open(owned_root, ownership_token)
    try:
        after = {
            "run": reopened_core.get_run({"runId": run_id}),
            "events": reopened_core.list_events({"runId": run_id, "after": 0}),
            "candidates": reopened_core.list_candidates({"runId": run_id}),
            "knowledgePoints": reopened_core.list_knowledge_points({"runId": run_id}),
        }
        assert _canonical_bytes(after) == before_bytes
    finally:
        reopened_database.close()


def test_recovery_changes_one_snapshot_then_second_reopen_is_byte_stable(
    owned_root, ownership_token
):
    database, core = _open(owned_root, ownership_token)
    run_id, _ = _import(core)
    _prepare_generation(core, run_id)
    before = core.get_run({"runId": run_id})
    database.close()

    recovered_database, recovered_core = _open(owned_root, ownership_token)
    recovered = {
        "run": recovered_core.get_run({"runId": run_id}),
        "events": recovered_core.list_events({"runId": run_id, "after": 0}),
    }
    assert recovered["run"]["status"] == "failed_retryable"
    assert recovered["run"]["revision"] == before["revision"] + 1
    assert recovered["run"]["lastEventSeq"] == before["lastEventSeq"] + 1
    assert recovered["run"]["error"] == {
        "code": "GENERATION_PROVIDER_ERROR",
        "retryable": True,
    }
    assert recovered["events"]["events"][-1]["type"] == "generation.interrupted"
    recovered_bytes = _canonical_bytes(recovered)
    recovered_database.close()

    reopened_database, reopened_core = _open(owned_root, ownership_token)
    try:
        reopened = {
            "run": reopened_core.get_run({"runId": run_id}),
            "events": reopened_core.list_events({"runId": run_id, "after": 0}),
        }
        assert _canonical_bytes(reopened) == recovered_bytes
    finally:
        reopened_database.close()


def test_review_replay_binds_stored_document_and_evidence_to_persisted_run(
    core: Phase1Core, database
):
    run_id, _ = _submit_candidates(core)
    candidate = core.list_candidates({"runId": run_id})["candidates"][0]
    command = {
        "candidateId": candidate["candidateId"],
        "action": "accept",
        "expectedRevision": candidate["revision"],
        "idempotencyKey": "idem_" + "7" * 20,
    }
    core.review_candidate(command)
    stored = json.loads(
        database.scalar(
            "SELECT result_json FROM p1_idempotency WHERE idempotency_key=?",
            (command["idempotencyKey"],),
        )
    )
    stored["run"]["document"] = {
        **stored["run"]["document"],
        "byteSize": 2,
        "characterCount": 2,
        "text": "ZZ",
    }
    fake_evidence = [{
        "seq": 0,
        "quote": "ZZ",
        "textStart": 0,
        "textEnd": 2,
        "contextBefore": "",
        "contextAfter": "",
    }]
    stored["candidate"]["evidence"] = fake_evidence
    stored["knowledgePoint"]["evidence"] = fake_evidence
    with database.write_transaction() as connection:
        connection.execute(
            "UPDATE p1_idempotency SET result_json=? WHERE idempotency_key=?",
            (_canonical_bytes(stored).decode("utf-8"), command["idempotencyKey"]),
        )

    with pytest.raises(CoreProblem) as caught:
        core.review_candidate(command)

    assert caught.value.code == "TRANSACTION_FAILED"


def test_historical_review_replay_ignores_later_mutable_run_snapshot_fields(
    core: Phase1Core,
):
    run_id, _ = _submit_candidates(core)
    candidates = core.list_candidates({"runId": run_id})["candidates"]
    first = _review(core, candidates[0], "accept", "7")
    _review(core, candidates[1], "accept", "8")

    replayed = _review(core, candidates[0], "accept", "7")

    assert _canonical_bytes(replayed) == _canonical_bytes(first)


@pytest.mark.parametrize(
    "seq,column,value",
    [
        (1, "stage", "parse"),
        (2, "stage", "source"),
        (3, "stage", "verify"),
        (3, "payload_json", '{"retryCount":1}'),
        (4, "stage", "verify"),
        (5, "stage", "extract"),
        (6, "stage", "extract"),
        (6, "payload_json", '{"rawCandidateCount":4,"validCandidateCount":4}'),
        (7, "type", "candidate.rejected"),
        (11, "payload_json", '{"reason":"zero_valid_candidates"}'),
    ],
)
def test_event_query_reconciles_stage_and_payload_with_durable_facts(
    core: Phase1Core, database, seq: int, column: str, value: str
):
    run_id, _ = _submit_candidates(core)
    candidates = core.list_candidates({"runId": run_id})["candidates"]
    _review(core, candidates[0], "accept", "a")
    _review(core, candidates[1], "edited_and_accept", "b", title="乙定稿", statement="乙定稿。")
    _review(core, candidates[2], "reject", "c")
    _review(core, candidates[3], "reject", "d")
    with database.write_transaction() as connection:
        connection.execute(
            f"UPDATE p1_run_events SET {column}=? WHERE job_id=? AND seq=?",
            (value, run_id, seq),
        )

    with pytest.raises(CoreProblem) as caught:
        core.list_events({"runId": run_id, "after": 0})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"


@pytest.mark.parametrize(
    "mutation",
    ["event_code", "event_retryable", "attempt_status", "attempt_error"],
)
def test_failed_event_reconciles_historical_attempt_and_retry_policy(
    core: Phase1Core, database, mutation: str
):
    run_id, _ = _import(core)
    prepared = _prepare_generation(core, run_id)
    core.fail_generation({
        "runId": run_id,
        "attemptId": prepared["attemptId"],
        "expectedRevision": prepared["revision"],
        "code": "GENERATION_TIMEOUT",
    })
    with database.write_transaction() as connection:
        if mutation == "event_code":
            connection.execute(
                "UPDATE p1_run_events SET payload_json=? WHERE job_id=? AND seq=5",
                ('{"attemptId":"%s","code":"GENERATION_PROVIDER_ERROR","retryable":true}' % prepared["attemptId"], run_id),
            )
        elif mutation == "event_retryable":
            connection.execute(
                "UPDATE p1_run_events SET payload_json=? WHERE job_id=? AND seq=5",
                ('{"attemptId":"%s","code":"GENERATION_TIMEOUT","retryable":false}' % prepared["attemptId"], run_id),
            )
        elif mutation == "attempt_status":
            connection.execute(
                "UPDATE p1_generation_attempts SET status='succeeded' WHERE id=?",
                (prepared["attemptId"],),
            )
        else:
            connection.execute(
                "UPDATE p1_generation_attempts SET error_code='GENERATION_PROVIDER_ERROR' WHERE id=?",
                (prepared["attemptId"],),
            )

    with pytest.raises(CoreProblem) as caught:
        core.list_events({"runId": run_id, "after": 0})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"


def test_candidate_list_rejects_cross_run_accepted_knowledge_point(
    core: Phase1Core, database
):
    first_run, _ = _submit_candidates(core)
    second_run, _ = _submit_candidates(core)
    first_candidate = core.list_candidates({"runId": first_run})["candidates"][0]
    second_candidate = core.list_candidates({"runId": second_run})["candidates"][0]
    first = _review(core, first_candidate, "accept", "1")
    second = _review(core, second_candidate, "accept", "2")
    with database.write_transaction() as connection:
        connection.execute(
            "UPDATE p1_candidates SET accepted_kp_id=NULL WHERE id=?",
            (second_candidate["candidateId"],),
        )
        connection.execute(
            "UPDATE p1_candidates SET accepted_kp_id=? WHERE id=?",
            (second["knowledgePoint"]["knowledgePointId"], first_candidate["candidateId"]),
        )

    with pytest.raises(CoreProblem) as caught:
        core.list_candidates({"runId": first_run})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"
    assert first["knowledgePoint"] is not None


def test_candidate_list_rejects_knowledge_point_outside_fixture_course(
    core: Phase1Core, database
):
    run_id, _ = _submit_candidates(core)
    candidate = core.list_candidates({"runId": run_id})["candidates"][0]
    accepted = _review(core, candidate, "accept", "3")
    point_id = accepted["knowledgePoint"]["knowledgePointId"]
    with database.write_transaction() as connection:
        connection.execute(
            "INSERT INTO courses(id,name,created_at,updated_at,frozen_at) "
            "VALUES('crs_foreign','Foreign','2026-01-01','2026-01-01',NULL)"
        )
        connection.execute(
            "UPDATE knowledge_points SET course_id='crs_foreign' WHERE id=?",
            (point_id,),
        )

    with pytest.raises(CoreProblem) as caught:
        core.list_candidates({"runId": run_id})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"


@pytest.mark.parametrize("mutation", ["ordinal", "type", "title", "evidence"])
def test_run_snapshot_reconciles_retained_candidates_with_successful_output(
    core: Phase1Core, database, mutation: str
):
    run_id, _ = _submit_candidates(core)
    candidate_id = core.list_candidates({"runId": run_id})["candidates"][0][
        "candidateId"
    ]
    with database.write_transaction() as connection:
        if mutation == "ordinal":
            connection.execute(
                "UPDATE p1_candidates SET ordinal=19 WHERE id=?", (candidate_id,)
            )
        elif mutation == "type":
            connection.execute(
                "UPDATE p1_candidates SET type='fact' WHERE id=?", (candidate_id,)
            )
        elif mutation == "title":
            connection.execute(
                "UPDATE p1_candidates SET title='漂移标题' WHERE id=?", (candidate_id,)
            )
        else:
            connection.execute(
                "UPDATE p1_candidate_evidence SET quote='ZZ' WHERE candidate_id=?",
                (candidate_id,),
            )

    with pytest.raises(CoreProblem) as caught:
        core.get_run({"runId": run_id})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"


def test_run_snapshot_rejects_stored_contract_identity_drift(
    core: Phase1Core, database
):
    run_id, _ = _submit_candidates(core)
    with database.write_transaction() as connection:
        connection.execute(
            "UPDATE p1_run_control SET schema_sha256=? WHERE job_id=?",
            ("f" * 64, run_id),
        )

    with pytest.raises(CoreProblem) as caught:
        core.get_run({"runId": run_id})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"


@pytest.mark.parametrize(
    "mutation",
    ["raw_count", "schema_count", "exact_count", "rejections", "raw_output"],
)
def test_run_snapshot_reconciles_success_statistics_with_contract_and_evidence(
    core: Phase1Core, database, mutation: str
):
    run_id, _ = _submit_candidates(core)
    with database.write_transaction() as connection:
        if mutation == "raw_count":
            connection.execute(
                "UPDATE p1_run_control SET raw_candidate_count=raw_candidate_count+1 WHERE job_id=?",
                (run_id,),
            )
        elif mutation == "schema_count":
            connection.execute(
                "UPDATE p1_run_control SET schema_valid_evidence_count=schema_valid_evidence_count+1 WHERE job_id=?",
                (run_id,),
            )
        elif mutation == "exact_count":
            connection.execute(
                "UPDATE p1_run_control SET exact_evidence_count=exact_evidence_count+1 WHERE job_id=?",
                (run_id,),
            )
        elif mutation == "rejections":
            connection.execute(
                "UPDATE p1_run_control SET rejection_counts_json='{}' WHERE job_id=?",
                (run_id,),
            )
        else:
            connection.execute(
                "UPDATE p1_generation_attempts SET raw_output_json='{}' WHERE job_id=?",
                (run_id,),
            )

    with pytest.raises(CoreProblem) as caught:
        core.get_run({"runId": run_id})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"


@pytest.mark.parametrize(
    "mutation",
    ["run_error", "attempt_error", "attempt_status", "attempt_number"],
)
def test_failed_run_snapshot_reconciles_current_failed_attempt(
    core: Phase1Core, database, mutation: str
):
    run_id, _ = _import(core)
    prepared = _prepare_generation(core, run_id)
    core.fail_generation({
        "runId": run_id,
        "attemptId": prepared["attemptId"],
        "expectedRevision": prepared["revision"],
        "code": "GENERATION_TIMEOUT",
    })
    with database.write_transaction() as connection:
        if mutation == "run_error":
            connection.execute(
                "UPDATE p1_run_control SET error_code='GENERATION_PROVIDER_ERROR' WHERE job_id=?",
                (run_id,),
            )
        elif mutation == "attempt_error":
            connection.execute(
                "UPDATE p1_generation_attempts SET error_code='GENERATION_PROVIDER_ERROR' WHERE id=?",
                (prepared["attemptId"],),
            )
        elif mutation == "attempt_status":
            connection.execute(
                "UPDATE p1_generation_attempts SET status='succeeded' WHERE id=?",
                (prepared["attemptId"],),
            )
        else:
            connection.execute(
                "UPDATE p1_generation_attempts SET attempt_number=2 WHERE id=?",
                (prepared["attemptId"],),
            )

    with pytest.raises(CoreProblem) as caught:
        core.get_run({"runId": run_id})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"


@pytest.mark.parametrize("state", ["awaiting", "failed"])
def test_non_successful_run_snapshot_requires_zero_generation_statistics(
    core: Phase1Core, database, state: str
):
    run_id, _ = _import(core)
    if state == "failed":
        prepared = _prepare_generation(core, run_id)
        core.fail_generation({
            "runId": run_id,
            "attemptId": prepared["attemptId"],
            "expectedRevision": prepared["revision"],
            "code": "GENERATION_TIMEOUT",
        })
    with database.write_transaction() as connection:
        connection.execute(
            "UPDATE p1_run_control SET raw_candidate_count=1 WHERE job_id=?",
            (run_id,),
        )

    with pytest.raises(CoreProblem) as caught:
        core.get_run({"runId": run_id})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"


def test_schema_failed_run_rejects_retained_contract_valid_output(
    core: Phase1Core, database
):
    run_id, _ = _import(core)
    prepared = _prepare_generation(core, run_id)
    core.submit_generation({
        "runId": run_id,
        "attemptId": prepared["attemptId"],
        "expectedRevision": prepared["revision"],
        "output": {},
    })
    with database.write_transaction() as connection:
        connection.execute(
            "UPDATE p1_generation_attempts SET raw_output_json=? WHERE id=?",
            ('{"candidates":[],"schemaVersion":1}', prepared["attemptId"]),
        )

    with pytest.raises(CoreProblem) as caught:
        core.get_run({"runId": run_id})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"


@pytest.mark.parametrize(
    "target,assignment",
    [
        ("documents", "name='../escaped.md'"),
        ("documents", "source_type='manual'"),
        ("documents", "page_count=1"),
        ("documents", "file_path='/tmp/escaped'"),
        ("chunks", "seq=1"),
        ("chunks", "char_offset=1"),
        ("chunks", "state='extracted'"),
    ],
)
def test_run_snapshot_rejects_noncanonical_import_projection(
    core: Phase1Core, database, target: str, assignment: str
):
    run_id, document_id = _import(core)
    with database.write_transaction() as connection:
        if target == "documents":
            connection.execute(
                f"UPDATE documents SET {assignment} WHERE id=?", (document_id,)
            )
        else:
            connection.execute(
                f"UPDATE chunks SET {assignment} WHERE document_id=?", (document_id,)
            )

    with pytest.raises(CoreProblem) as caught:
        core.get_run({"runId": run_id})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"


@pytest.mark.parametrize("filename", ["", ".", "..", "bad/name", "bad\\name", "bad\x00name", "x" * 256])
def test_run_snapshot_rechecks_exact_filename_import_constraints(
    core: Phase1Core, database, filename: str
):
    run_id, document_id = _import(core)
    with database.write_transaction() as connection:
        connection.execute(
            "UPDATE documents SET name=? WHERE id=?", (filename, document_id)
        )

    with pytest.raises(CoreProblem) as caught:
        core.get_run({"runId": run_id})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"


def test_run_snapshot_rejects_document_outside_fixture_course(
    core: Phase1Core, database
):
    run_id, document_id = _import(core)
    with database.write_transaction() as connection:
        connection.execute(
            "INSERT INTO courses(id,name,created_at,updated_at,frozen_at) "
            "VALUES('crs_foreign','Foreign','2026-01-01','2026-01-01',NULL)"
        )
        connection.execute(
            "UPDATE documents SET course_id='crs_foreign' WHERE id=?", (document_id,)
        )

    with pytest.raises(CoreProblem) as caught:
        core.get_run({"runId": run_id})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"


@pytest.mark.parametrize("outcome", ["commit", "rollback"])
def test_candidate_and_knowledge_reads_wait_for_real_review_transaction(
    core: Phase1Core, database, monkeypatch, outcome: str
):
    run_id, _ = _submit_candidates(core)
    candidate = core.list_candidates({"runId": run_id})["candidates"][0]
    writer_split = threading.Event()
    release_writer = threading.Event()
    writer_done = threading.Event()
    candidate_done = threading.Event()
    point_done = threading.Event()
    results: Queue[tuple[str, object]] = Queue()
    original_store = service_module.store_idempotency_result

    def split_store(*args, **kwargs):
        original_store(*args, **kwargs)
        writer_split.set()
        assert release_writer.wait(2)
        if outcome == "rollback":
            raise RuntimeError("force review rollback")

    monkeypatch.setattr(service_module, "store_idempotency_result", split_store)

    def write_review() -> None:
        try:
            results.put(("writer", _review(core, candidate, "accept", "9")))
        except BaseException as exc:
            results.put(("writer", exc))
        finally:
            writer_done.set()

    def read_candidates() -> None:
        try:
            results.put(("candidates", core.list_candidates({"runId": run_id})))
        except BaseException as exc:
            results.put(("candidates", exc))
        finally:
            candidate_done.set()

    def read_points() -> None:
        try:
            results.put(("points", core.list_knowledge_points({"runId": run_id})))
        except BaseException as exc:
            results.put(("points", exc))
        finally:
            point_done.set()

    writer = threading.Thread(target=write_review)
    writer.start()
    assert writer_split.wait(2)
    candidate_reader = threading.Thread(target=read_candidates)
    point_reader = threading.Thread(target=read_points)
    candidate_reader.start()
    point_reader.start()
    assert not candidate_done.wait(0.1)
    assert not point_done.wait(0.1)
    release_writer.set()
    for thread in (writer, candidate_reader, point_reader):
        thread.join(2)
        assert not thread.is_alive()
    assert writer_done.is_set()
    observed = dict(results.get_nowait() for _ in range(3))
    assert not isinstance(observed["candidates"], BaseException)
    assert not isinstance(observed["points"], BaseException)
    listed_candidate = observed["candidates"]["candidates"][0]
    if outcome == "commit":
        assert not isinstance(observed["writer"], BaseException)
        assert listed_candidate["reviewStatus"] == "accepted"
        assert len(observed["points"]["knowledgePoints"]) == 1
    else:
        assert isinstance(observed["writer"], CoreProblem)
        assert observed["writer"].code == "TRANSACTION_FAILED"
        assert listed_candidate["reviewStatus"] == "pending"
        assert observed["points"] == {"knowledgePoints": []}


def _submit_empty_generation(core: Phase1Core, run_id: str) -> dict[str, object]:
    prepared = _prepare_generation(core, run_id)
    return core.submit_generation({
        "runId": run_id,
        "attemptId": prepared["attemptId"],
        "expectedRevision": prepared["revision"],
        "output": {"schemaVersion": 1, "candidates": []},
    })


def test_review_replay_rejects_alternate_exact_formal_evidence_span(
    core: Phase1Core, database
):
    imported = core.import_text({
        "filename": "repeated.md",
        "mediaType": "text/markdown",
        "text": "甲定义。甲定义。",
    })
    run_id = imported["runId"]
    prepared = _prepare_generation(core, run_id)
    core.submit_generation({
        "runId": run_id,
        "attemptId": prepared["attemptId"],
        "expectedRevision": prepared["revision"],
        "output": {
            "schemaVersion": 1,
            "candidates": [{
                "type": "concept",
                "title": "甲",
                "statement": "甲是定义。",
                "evidence": [{"quote": "甲定义", "prefix": "", "suffix": "。甲"}],
            }],
        },
    })
    candidate = core.list_candidates({"runId": run_id})["candidates"][0]
    command = {
        "candidateId": candidate["candidateId"],
        "action": "accept",
        "expectedRevision": candidate["revision"],
        "idempotencyKey": "idem_" + "e" * 20,
    }
    reviewed = core.review_candidate(command)
    point_id = reviewed["knowledgePoint"]["knowledgePointId"]
    stored = json.loads(database.scalar(
        "SELECT result_json FROM p1_idempotency WHERE idempotency_key=?",
        (command["idempotencyKey"],),
    ))
    alternate = [{
        "seq": 0,
        "quote": "甲定义",
        "textStart": 4,
        "textEnd": 7,
        "contextBefore": "甲定义。",
        "contextAfter": "。",
    }]
    stored["candidate"]["evidence"] = alternate
    stored["knowledgePoint"]["evidence"] = alternate
    with database.write_transaction() as connection:
        connection.execute(
            "UPDATE kp_evidence SET text_start=4,text_end=7,"
            "context_before='甲定义。',context_after='。' WHERE kp_id=?",
            (point_id,),
        )
        connection.execute(
            "UPDATE p1_idempotency SET result_json=? WHERE idempotency_key=?",
            (_canonical_bytes(stored).decode("utf-8"), command["idempotencyKey"]),
        )

    with pytest.raises(CoreProblem) as caught:
        core.review_candidate(command)

    assert caught.value.code == "TRANSACTION_FAILED"


def test_provider_failure_and_interruption_share_the_same_durable_error_facts(
    core: Phase1Core, database
):
    reported_run_id, _ = _import(core)
    reported = _prepare_generation(core, reported_run_id)
    core.fail_generation({
        "runId": reported_run_id,
        "attemptId": reported["attemptId"],
        "expectedRevision": reported["revision"],
        "code": "GENERATION_PROVIDER_ERROR",
    })
    interrupted_run_id, _ = _import(core)
    _prepare_generation(core, interrupted_run_id)
    assert recover_interrupted_runs(database) == 1

    assert core.get_run({"runId": reported_run_id})["error"] == core.get_run(
        {"runId": interrupted_run_id}
    )["error"] == {
        "code": "GENERATION_PROVIDER_ERROR",
        "retryable": True,
    }
    assert core.list_events({"runId": reported_run_id, "after": 0})["events"][-1][
        "type"
    ] == "generation.failed"
    assert core.list_events({"runId": interrupted_run_id, "after": 0})["events"][-1][
        "type"
    ] == "generation.interrupted"


def test_attempt_two_validating_event_cannot_reference_attempt_one(
    core: Phase1Core, database
):
    run_id, _ = _import(core)
    first = _prepare_generation(core, run_id)
    failed = core.fail_generation({
        "runId": run_id,
        "attemptId": first["attemptId"],
        "expectedRevision": first["revision"],
        "code": "GENERATION_TIMEOUT",
    })
    core.retry({"runId": run_id, "expectedRevision": failed["run"]["revision"]})
    _submit_empty_generation(core, run_id)
    assert core.list_events({"runId": run_id, "after": 0})["nextAfter"] == 10
    with database.write_transaction() as connection:
        connection.execute(
            "UPDATE p1_run_events SET payload_json=? WHERE job_id=? "
            "AND type='generation.validating'",
            ('{"attemptId":"%s"}' % first["attemptId"], run_id),
        )

    with pytest.raises(CoreProblem) as caught:
        core.list_events({"runId": run_id, "after": 0})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"


def test_historical_schema_failed_output_remains_contract_invalid_after_retry(
    core: Phase1Core, database
):
    run_id, _ = _import(core)
    first = _prepare_generation(core, run_id)
    failed = core.submit_generation({
        "runId": run_id,
        "attemptId": first["attemptId"],
        "expectedRevision": first["revision"],
        "output": {},
    })
    core.retry({"runId": run_id, "expectedRevision": failed["run"]["revision"]})
    _submit_empty_generation(core, run_id)
    with database.write_transaction() as connection:
        connection.execute(
            "UPDATE p1_generation_attempts SET raw_output_json=? WHERE id=?",
            ('{"candidates":[],"schemaVersion":1}', first["attemptId"]),
        )

    with pytest.raises(CoreProblem) as caught:
        core.list_events({"runId": run_id, "after": 0})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"


@pytest.mark.parametrize(
    "state",
    [
        "pending_revision",
        "terminal_revision",
        "missing_event",
        "missing_log",
        "wrong_log",
        "wrong_fields",
    ],
)
def test_candidate_list_reconciles_review_revision_event_and_confirmation_log(
    core: Phase1Core, database, state: str
):
    run_id, _ = _submit_candidates(core)
    candidate = core.list_candidates({"runId": run_id})["candidates"][0]
    if state == "pending_revision":
        with database.write_transaction() as connection:
            connection.execute(
                "UPDATE p1_candidates SET revision=2 WHERE id=?",
                (candidate["candidateId"],),
            )
    else:
        reviewed = _review(core, candidate, "accept", "f")
        point_id = reviewed["knowledgePoint"]["knowledgePointId"]
        with database.write_transaction() as connection:
            if state == "terminal_revision":
                connection.execute(
                    "UPDATE p1_candidates SET revision=3 WHERE id=?",
                    (candidate["candidateId"],),
                )
            elif state == "missing_event":
                connection.execute(
                    "DELETE FROM p1_run_events WHERE job_id=? "
                    "AND type='candidate.accepted'",
                    (run_id,),
                )
            elif state == "missing_log":
                connection.execute("DELETE FROM kp_confirm_log WHERE kp_id=?", (point_id,))
            elif state == "wrong_log":
                connection.execute(
                    "UPDATE kp_confirm_log SET action='accepted_with_edit',"
                    "edited_fields='[""title"",""content""]' WHERE kp_id=?",
                    (point_id,),
                )
            else:
                connection.execute(
                    "UPDATE kp_confirm_log SET edited_fields='[""title""]' "
                    "WHERE kp_id=?",
                    (point_id,),
                )

    with pytest.raises(CoreProblem) as caught:
        core.list_candidates({"runId": run_id})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"


def test_candidate_and_point_matching_text_mutation_fails_content_hash(
    core: Phase1Core, database
):
    run_id, _ = _submit_candidates(core)
    candidate = core.list_candidates({"runId": run_id})["candidates"][0]
    reviewed = _review(
        core,
        candidate,
        "edited_and_accept",
        "0",
        title="初次定稿",
        statement="初次定稿陈述。",
    )
    point_id = reviewed["knowledgePoint"]["knowledgePointId"]
    with database.write_transaction() as connection:
        connection.execute(
            "UPDATE p1_candidates SET title='再次漂移',statement='再次漂移陈述。' WHERE id=?",
            (candidate["candidateId"],),
        )
        connection.execute(
            "UPDATE knowledge_points SET title='再次漂移',content='再次漂移陈述。' WHERE id=?",
            (point_id,),
        )

    with pytest.raises(CoreProblem) as candidate_error:
        core.list_candidates({"runId": run_id})
    with pytest.raises(CoreProblem) as point_error:
        core.list_knowledge_points({"runId": run_id})

    assert candidate_error.value.code == "DERIVED_STATE_MISMATCH"
    assert point_error.value.code == "DERIVED_STATE_MISMATCH"


@pytest.mark.parametrize("run_state", ["generating", "validating"])
@pytest.mark.parametrize(
    "attempt_field,attempt_value",
    [
        ("raw_output_json", "{}"),
        ("model_metadata_json", '{"model":"x","provider":"y"}'),
        ("completed_at", "2026-01-01T00:00:00Z"),
        ("error_code", "GENERATION_PROVIDER_ERROR"),
    ],
)
def test_active_attempt_requires_exact_unwritten_defaults(
    core: Phase1Core,
    database,
    run_state: str,
    attempt_field: str,
    attempt_value: str,
):
    run_id, _ = _import(core)
    prepared = _prepare_generation(core, run_id)
    if run_state == "validating":
        with database.write_transaction() as connection:
            connection.execute(
                "UPDATE p1_run_control SET status='validating',stage='verify',"
                "revision=revision+1 WHERE job_id=?",
                (run_id,),
            )
            connection.execute(
                "UPDATE import_jobs SET stage='verify',status='running' WHERE id=?",
                (run_id,),
            )
            append_event(
                connection,
                run_id,
                "generation.validating",
                "verify",
                {"attemptId": prepared["attemptId"]},
            )
    with database.write_transaction() as connection:
        connection.execute(
            f"UPDATE p1_generation_attempts SET {attempt_field}=? WHERE id=?",
            (attempt_value, prepared["attemptId"]),
        )

    with pytest.raises(CoreProblem) as run_error:
        core.get_run({"runId": run_id})
    with pytest.raises(CoreProblem) as event_error:
        core.list_events({"runId": run_id, "after": 0})

    assert run_error.value.code == "DERIVED_STATE_MISMATCH"
    assert event_error.value.code == "DERIVED_STATE_MISMATCH"


@pytest.mark.parametrize(
    "mutation",
    [
        "support_label",
        "merged_into",
        "granularity",
        "elapsed_sec",
        "confirmed_at",
        "kp_created_at",
        "kp_updated_at",
    ],
)
def test_terminal_candidate_reconciles_full_confirmation_and_kp_timestamps(
    core: Phase1Core, database, mutation: str
):
    run_id, _ = _submit_candidates(core)
    candidate = core.list_candidates({"runId": run_id})["candidates"][0]
    reviewed = _review(core, candidate, "accept", "a")
    point_id = reviewed["knowledgePoint"]["knowledgePointId"]
    with database.write_transaction() as connection:
        if mutation in {
            "support_label",
            "merged_into",
            "granularity",
            "elapsed_sec",
            "confirmed_at",
        }:
            values = {
                "support_label": "supported",
                "merged_into": "kp_" + "f" * 20,
                "granularity": "f",
                "elapsed_sec": 1.0,
                "confirmed_at": "2026-01-01T00:00:00Z",
            }
            connection.execute(
                f"UPDATE kp_confirm_log SET {mutation}=? WHERE kp_id=?",
                (values[mutation], point_id),
            )
        else:
            column = mutation.removeprefix("kp_")
            connection.execute(
                f"UPDATE knowledge_points SET {column}=? WHERE id=?",
                ("2026-01-01T00:00:00Z", point_id),
            )

    with pytest.raises(CoreProblem) as candidate_error:
        core.list_candidates({"runId": run_id})
    with pytest.raises(CoreProblem) as point_error:
        core.list_knowledge_points({"runId": run_id})

    assert candidate_error.value.code == "DERIVED_STATE_MISMATCH"
    assert point_error.value.code == "DERIVED_STATE_MISMATCH"
