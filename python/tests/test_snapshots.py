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

from conftest import PYTHON_ROOT


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
        owned_root, ownership_token
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
        "SELECT accepted_candidate_count FROM runs WHERE id=?", (run_id,)
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
        connection.execute("ALTER TABLE runs ADD COLUMN future_run_secret TEXT")
        connection.execute("ALTER TABLE documents ADD COLUMN future_document_secret TEXT")
        connection.execute("ALTER TABLE candidates ADD COLUMN future_candidate_secret TEXT")
        connection.execute("ALTER TABLE run_events ADD COLUMN future_event_secret TEXT")
        connection.execute("ALTER TABLE knowledge_points ADD COLUMN future_kp_secret TEXT")
        connection.execute(
            "UPDATE runs SET future_run_secret='RUN_SECRET' WHERE id=?",
            (run_id,),
        )
        connection.execute(
            "UPDATE documents SET future_document_secret='DOCUMENT_SECRET'"
        )
        connection.execute(
            "UPDATE candidates SET future_candidate_secret='CANDIDATE_SECRET'"
        )
        connection.execute(
            "UPDATE run_events SET future_event_secret='EVENT_SECRET'"
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


def test_historical_review_replay_ignores_later_mutable_run_snapshot_fields(
    core: Phase1Core,
):
    run_id, _ = _submit_candidates(core)
    candidates = core.list_candidates({"runId": run_id})["candidates"]
    first = _review(core, candidates[0], "accept", "7")
    _review(core, candidates[1], "accept", "8")

    replayed = _review(core, candidates[0], "accept", "7")

    assert _canonical_bytes(replayed) == _canonical_bytes(first)


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


def test_repeated_snapshots_do_not_reparse_output_relocate_or_replay_events(core, database, monkeypatch):
    from nobei_core import evidence, repository
    from nobei_core.contract import CandidateContract
    run_id, _ = _submit_candidates(core)
    candidate = core.list_candidates({'runId': run_id})['candidates'][0]
    _review(core, candidate, 'accept', 'a')
    raw_output = database.scalar('SELECT raw_output_json FROM generation_attempts WHERE run_id=?', (run_id,))

    def snapshots():
        return {
            'run': core.get_run({'runId': run_id}),
            'candidates': core.list_candidates({'runId': run_id}),
            'points': core.list_knowledge_points({'runId': run_id}),
        }

    expected = snapshots()
    events = core.list_events({'runId': run_id, 'after': 0})
    original_loads = json.loads

    def no_raw_output_parse(value, *args, **kwargs):
        assert value != raw_output, 'snapshot reparsed saved provider output'
        return original_loads(value, *args, **kwargs)

    def forbidden(*args, **kwargs):
        pytest.fail('snapshot reran contract validation, evidence location, or event history')

    monkeypatch.setattr(CandidateContract, 'validate', forbidden)
    monkeypatch.setattr(evidence, 'locate_evidence', forbidden)
    monkeypatch.setattr(service_module, 'locate_evidence', forbidden)
    monkeypatch.setattr(json, 'loads', no_raw_output_parse)
    for _ in range(3):
        # Listing events is allowed to read and serialize them, without parsing model output.
        assert core.list_events({'runId': run_id, 'after': 0}) == events
        with monkeypatch.context() as scoped:
            scoped.setattr(repository, 'read_run_events', forbidden)
            scoped.setattr(service_module, 'read_run_events', forbidden)
            assert snapshots() == expected
