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


def test_import_accepts_exact_512_kib_utf8_boundary(core: Phase1Core):
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
        "data": {"actualBytes": MAX_DOCUMENT_BYTES + 1, "maxBytes": MAX_DOCUMENT_BYTES},
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
    assert database.scalar("SELECT COUNT(*) FROM run_events WHERE run_id=?", (run_id,)) == 3


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

    def write_split_transaction() -> None:
        try:
            with database.write_transaction() as connection:
                connection.execute(
                    "UPDATE runs SET status=?,stage=?,revision=? WHERE id=?",
                    ("generating", "extract", 2, run_id),
                )
                writer_split.set()
                if not release_writer.wait(2):
                    raise AssertionError("reader test did not release writer")
                if outcome == "rollback":
                    raise RollBackWrite()
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

    writer = threading.Thread(target=write_split_transaction)
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


@pytest.mark.parametrize('filename,media_type', [('lesson.txt', 'text/plain'), ('lesson.md', 'text/markdown')])
def test_import_stores_canonical_document_without_projection(core, database, filename, media_type):
    result = core.import_text({'filename': filename, 'mediaType': media_type, 'text': '😀标题\r\n\r第一段。\r'})
    canonical = '😀标题\n\n第一段。\n'
    assert database.one('SELECT filename,media_type,canonical_text,byte_size,character_count,text_sha256 FROM documents WHERE id=?', (result['documentId'],)) == {
        'filename': filename, 'media_type': media_type, 'canonical_text': canonical,
        'byte_size': len(canonical.encode('utf-8')), 'character_count': len(canonical),
        'text_sha256': hashlib.sha256(canonical.encode('utf-8')).hexdigest(),
    }
    assert database.one('SELECT document_id,status,stage,revision FROM runs WHERE id=?', (result['runId'],)) == {
        'document_id': result['documentId'], 'status': 'awaiting_generation', 'stage': 'extract', 'revision': 1,
    }
    events = core.list_events({'runId': result['runId'], 'after': 0})['events']
    assert [e['seq'] for e in events] == [1, 2, 3]
    assert [e['type'] for e in events] == ['run.created', 'document.ready', 'generation.awaiting']
