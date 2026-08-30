from __future__ import annotations

import hashlib
import json
import re
import threading
from queue import Queue

import pytest

from nobei_core import repository as repository_module
from nobei_core.constants import MAX_DOCUMENT_BYTES
from nobei_core.contract import load_candidate_contract
from nobei_core.errors import CoreProblem
from nobei_core.repository import append_event, insert_generation_attempt, transition_run
from nobei_core.service import Phase1Core

from conftest import PYTHON_ROOT


@pytest.fixture
def core(database):
    return Phase1Core(database, load_candidate_contract(PYTHON_ROOT.parent))


def test_import_normalizes_text_and_commits_one_run_command(core: Phase1Core, database):
    result = core.import_text(
        {
            "filename": "chapter-1.md",
            "mediaType": "text/markdown",
            "text": "# 标题\r\n\r定义。\r",
        }
    )

    assert result.keys() == {"documentId", "runId", "revision"}
    assert re.fullmatch(r"doc_[0-9a-f]{20}", result["documentId"])
    assert re.fullmatch(r"job_[0-9a-f]{20}", result["runId"])
    assert result["revision"] == 1

    run = core.get_run({"runId": result["runId"]})
    assert run["status"] == "awaiting_generation"
    assert run["stage"] == "extract"
    assert run["revision"] == 1
    assert run["document"]["text"] == "# 标题\n\n定义。\n"
    assert database.scalar(
        "SELECT COUNT(*) FROM chunks WHERE document_id=?", (result["documentId"],)
    ) == 1
    assert database.scalar(
        "SELECT char_offset FROM chunks WHERE document_id=?", (result["documentId"],)
    ) == 0

    canonical = "# 标题\n\n定义。\n"
    control = database.one(
        "SELECT document_sha256,byte_size,character_count FROM p1_run_control WHERE job_id=?",
        (result["runId"],),
    )
    assert control == {
        "document_sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        "byte_size": len(canonical.encode("utf-8")),
        "character_count": len(canonical),
    }

    events = core.list_events({"runId": result["runId"], "after": 0})["events"]
    assert [event["seq"] for event in events] == [1, 2, 3]
    assert [event["type"] for event in events] == [
        "run.created",
        "document.ready",
        "generation.awaiting",
    ]
    assert [event["stage"] for event in events] == ["source", "parse", "extract"]
    assert events[0]["payload"] == {"runId": result["runId"]}
    assert events[1]["payload"] == {"documentId": result["documentId"]}
    assert events[2]["payload"] == {"retryCount": 0}
    assert all(
        forbidden not in json.dumps(event["payload"])
        for event in events
        for forbidden in (canonical, "chapter-1.md", "file_path", "model")
    )


def test_plain_text_import_uses_txt_source_type(core: Phase1Core, database):
    result = core.import_text(
        {"filename": "chapter.txt", "mediaType": "text/plain", "text": "plain text"}
    )

    assert database.scalar(
        "SELECT source_type FROM documents WHERE id=?", (result["documentId"],)
    ) == "txt"
    assert database.one(
        "SELECT page_count,file_path FROM documents WHERE id=?", (result["documentId"],)
    ) == {"page_count": None, "file_path": None}
    assert database.one(
        "SELECT seq,char_offset,text,state FROM chunks WHERE document_id=?",
        (result["documentId"],),
    ) == {"seq": 0, "char_offset": 0, "text": "plain text", "state": "parsed"}


def test_import_accepts_exact_64_kib_utf8_boundary(core: Phase1Core):
    text = "a" * MAX_DOCUMENT_BYTES

    result = core.import_text(
        {"filename": "boundary.txt", "mediaType": "text/plain", "text": text}
    )

    assert core.get_run({"runId": result["runId"]})["document"]["text"] == text


def test_import_rejects_one_byte_over_limit_with_exact_public_data(core: Phase1Core):
    with pytest.raises(CoreProblem) as caught:
        core.import_text(
            {
                "filename": "too-large.txt",
                "mediaType": "text/plain",
                "text": "a" * (MAX_DOCUMENT_BYTES + 1),
            }
        )

    assert caught.value.code == "REQUEST_TOO_LARGE"
    assert caught.value.public() == {
        "code": "REQUEST_TOO_LARGE",
        "data": {"actualBytes": 65_537, "maxBytes": 65_536},
    }


@pytest.mark.parametrize("text", ["", "contains\x00nul", "bell\x07", "\ud800"])
def test_import_rejects_empty_binary_control_or_surrogate_text(core: Phase1Core, text: str):
    with pytest.raises(CoreProblem) as caught:
        core.import_text({"filename": "bad.txt", "mediaType": "text/plain", "text": text})

    assert caught.value.code == "INVALID_DOCUMENT"


def test_import_allows_tab_and_lf_controls(core: Phase1Core):
    result = core.import_text(
        {"filename": "tabs.txt", "mediaType": "text/plain", "text": "a\tb\nc"}
    )

    assert core.get_run({"runId": result["runId"]})["document"]["text"] == "a\tb\nc"


@pytest.mark.parametrize("media_type", ["application/json", "text/plain; charset=utf-8", "TEXT/PLAIN"])
def test_import_rejects_unsupported_media_type(core: Phase1Core, media_type: str):
    with pytest.raises(CoreProblem) as caught:
        core.import_text({"filename": "bad.txt", "mediaType": media_type, "text": "valid"})

    assert caught.value.code == "UNSUPPORTED_MEDIA_TYPE"


@pytest.mark.parametrize(
    "filename",
    [
        "",
        ".",
        "..",
        "nested/file.txt",
        "nested\\file.txt",
        "nul\x00.txt",
        "\ud800.txt",
        "a" * 256,
    ],
)
def test_import_rejects_invalid_or_path_like_filename(core: Phase1Core, filename: str):
    with pytest.raises(CoreProblem) as caught:
        core.import_text({"filename": filename, "mediaType": "text/plain", "text": "valid"})

    assert caught.value.code == "INVALID_DOCUMENT"


def test_repeated_identical_content_creates_distinct_documents_and_runs(core: Phase1Core):
    command = {"filename": "same.txt", "mediaType": "text/plain", "text": "same"}

    first = core.import_text(command)
    second = core.import_text(command)

    assert first["documentId"] != second["documentId"]
    assert first["runId"] != second["runId"]


@pytest.mark.parametrize("column,drift", [("stage", "verify"), ("status", "running")])
@pytest.mark.parametrize("reader", ["get_run", "list_events"])
def test_reads_reject_projection_drift_without_repair(
    core: Phase1Core,
    database,
    column: str,
    drift: str,
    reader: str,
):
    result = core.import_text(
        {"filename": "drift.txt", "mediaType": "text/plain", "text": "valid"}
    )
    run_id = result["runId"]
    with database.write_transaction() as connection:
        statement = {
            "stage": "UPDATE import_jobs SET stage=? WHERE id=?",
            "status": "UPDATE import_jobs SET status=? WHERE id=?",
        }[column]
        connection.execute(statement, (drift, run_id))

    with pytest.raises(CoreProblem) as caught:
        if reader == "get_run":
            core.get_run({"runId": run_id})
        else:
            core.list_events({"runId": run_id, "after": 0})

    assert caught.value.code == "DERIVED_STATE_MISMATCH"
    query = {
        "stage": "SELECT stage FROM import_jobs WHERE id=?",
        "status": "SELECT status FROM import_jobs WHERE id=?",
    }[column]
    assert database.scalar(query, (run_id,)) == drift


def test_transition_run_changes_revision_projection_and_event_once(core: Phase1Core, database):
    result = core.import_text(
        {"filename": "transition.txt", "mediaType": "text/plain", "text": "valid"}
    )
    run_id = result["runId"]

    with database.write_transaction() as connection:
        row = transition_run(
            connection,
            run_id,
            "awaiting_generation",
            "generating",
            "generation.started",
            {"attemptId": "att_" + "a" * 20, "attemptNumber": 1},
        )

    assert row["revision"] == 2
    assert database.one("SELECT stage,status FROM import_jobs WHERE id=?", (run_id,)) == {
        "stage": "extract",
        "status": "running",
    }
    assert database.scalar("SELECT COUNT(*) FROM p1_run_events WHERE job_id=?", (run_id,)) == 4


def test_append_event_rejects_non_closed_payload_before_sql(core: Phase1Core, database):
    result = core.import_text(
        {"filename": "events.txt", "mediaType": "text/plain", "text": "valid"}
    )
    run_id = result["runId"]

    with pytest.raises(CoreProblem) as caught:
        with database.write_transaction() as connection:
            append_event(
                connection,
                run_id,
                "generation.awaiting",
                "extract",
                {"retryCount": 0, "documentText": "forbidden"},
            )

    assert caught.value.code == "INVALID_PARAMS"
    assert database.scalar("SELECT COUNT(*) FROM p1_run_events WHERE job_id=?", (run_id,)) == 3


def test_append_event_enforces_utf8_byte_limit_before_any_sql(monkeypatch):
    class SqlMustNotRun:
        def execute(self, *_args, **_kwargs):
            pytest.fail("event payload byte limit must be enforced before SQL")

    monkeypatch.setattr(repository_module, "MAX_EVENT_PAYLOAD_BYTES", 1)

    with pytest.raises(CoreProblem) as caught:
        append_event(
            SqlMustNotRun(),  # type: ignore[arg-type]
            "job_" + "a" * 20,
            "generation.awaiting",
            "extract",
            {"retryCount": 0},
        )

    assert caught.value.public() == {
        "code": "REQUEST_TOO_LARGE",
        "data": {"actualBytes": 16, "maxBytes": 1},
    }


@pytest.mark.parametrize("outcome", ["commit", "rollback"])
def test_reads_wait_for_whole_write_transaction_and_observe_one_snapshot(
    core: Phase1Core,
    database,
    outcome: str,
):
    imported = core.import_text(
        {"filename": "concurrent.txt", "mediaType": "text/plain", "text": "valid"}
    )
    run_id = imported["runId"]
    model_selection = {"provider": "fixture", "model": "fixture-model"}
    digest_input = {
        "runId": run_id,
        "attemptNumber": 1,
        "documentSha256": hashlib.sha256(b"valid").hexdigest(),
        "schemaVersion": core._contract.schema_version,
        "schemaSha256": core._contract.schema_sha256,
        "promptVersion": "l1-v2",
        "modelSelection": model_selection,
    }
    request_digest = hashlib.sha256(
        json.dumps(
            digest_input, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()
    writer_split = threading.Event()
    release_writer = threading.Event()
    writer_done = threading.Event()
    reader_gate = threading.Barrier(3)
    run_done = threading.Event()
    events_done = threading.Event()
    writer_failures: Queue[BaseException] = Queue()
    read_results: Queue[tuple[str, object]] = Queue()

    class RollBackWrite(Exception):
        pass

    def write_split_projection() -> None:
        try:
            with database.write_transaction() as connection:
                connection.execute(
                    "UPDATE p1_run_control SET status=?,stage=?,revision=? WHERE job_id=?",
                    ("generating", "extract", 2, run_id),
                )
                writer_split.set()
                if not release_writer.wait(2):
                    raise AssertionError("reader test did not release writer")
                if outcome == "rollback":
                    raise RollBackWrite()
                connection.execute(
                    "UPDATE import_jobs SET stage=?,status=? WHERE id=?",
                    ("extract", "running", run_id),
                )
                insert_generation_attempt(
                    connection,
                    attempt_id="att_" + "b" * 20,
                    run_id=run_id,
                    attempt_number=1,
                    request_digest=request_digest,
                    provider_idempotency_key="nobei:" + request_digest,
                    model_metadata_json=json.dumps(
                        model_selection,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                )
                append_event(
                    connection,
                    run_id,
                    "generation.started",
                    "extract",
                    {"attemptId": "att_" + "b" * 20, "attemptNumber": 1},
                )
        except RollBackWrite:
            pass
        except BaseException as exc:
            writer_failures.put(exc)
        finally:
            writer_done.set()

    def read_run() -> None:
        try:
            reader_gate.wait(2)
            read_results.put(("run", core.get_run({"runId": run_id})))
        except BaseException as exc:
            read_results.put(("run", exc))
        finally:
            run_done.set()

    def read_events() -> None:
        try:
            reader_gate.wait(2)
            read_results.put(
                ("events", core.list_events({"runId": run_id, "after": 0}))
            )
        except BaseException as exc:
            read_results.put(("events", exc))
        finally:
            events_done.set()

    writer = threading.Thread(target=write_split_projection)
    run_reader = threading.Thread(target=read_run)
    events_reader = threading.Thread(target=read_events)
    writer.start()
    assert writer_split.wait(2)
    run_reader.start()
    events_reader.start()
    reader_gate.wait(2)
    try:
        assert run_done.wait(0.1) is False
        assert events_done.wait(0.1) is False
    finally:
        release_writer.set()

    for thread in (writer, run_reader, events_reader):
        thread.join(2)
        assert thread.is_alive() is False
    assert writer_done.is_set()
    failures = [] if writer_failures.empty() else [writer_failures.get_nowait()]
    assert failures == []
    snapshots = dict(read_results.get_nowait() for _ in range(2))
    assert not isinstance(snapshots["run"], BaseException)
    assert not isinstance(snapshots["events"], BaseException)

    if outcome == "commit":
        assert snapshots["run"]["status"] == "generating"
        assert snapshots["run"]["revision"] == 2
        assert [event["seq"] for event in snapshots["events"]["events"]] == [1, 2, 3, 4]
    else:
        assert snapshots["run"]["status"] == "awaiting_generation"
        assert snapshots["run"]["revision"] == 1
        assert [event["seq"] for event in snapshots["events"]["events"]] == [1, 2, 3]


def test_service_reads_inside_same_thread_write_transaction_do_not_deadlock(
    core: Phase1Core,
    database,
):
    imported = core.import_text(
        {"filename": "same-thread.txt", "mediaType": "text/plain", "text": "valid"}
    )

    with database.write_transaction():
        assert core.get_run({"runId": imported["runId"]})["revision"] == 1
        assert [
            event["seq"]
            for event in core.list_events({"runId": imported["runId"], "after": 0})["events"]
        ] == [1, 2, 3]
