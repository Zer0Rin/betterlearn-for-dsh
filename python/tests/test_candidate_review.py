from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import pytest

from nobei_core import repository as repository_module
from nobei_core import service as service_module
from nobei_core import constants as constants_module
from nobei_core.contract import load_candidate_contract
from nobei_core.database import Phase1Database, configure_pragmas
from nobei_core.errors import CoreProblem
from nobei_core.service import Phase1Core

from conftest import PYTHON_ROOT


MODEL_SELECTION = {"provider": "test-provider", "model": "test-model"}


@pytest.fixture
def core(database):
    return Phase1Core(database, load_candidate_contract(PYTHON_ROOT.parent))


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _review(
    core: Phase1Core,
    candidate_id: str,
    action: str,
    key_hex: str,
    **fields: object,
) -> dict[str, object]:
    return core.review_candidate(
        {
            "candidateId": candidate_id,
            "action": action,
            "expectedRevision": 1,
            "idempotencyKey": "idem_" + key_hex * 20,
            **fields,
        }
    )


@pytest.mark.parametrize(
    "command",
    [
        {
            "candidateId": "cand_" + "1" * 20,
            "action": "accept",
            "expectedRevision": 1,
            "idempotencyKey": "idem_" + "1" * 20,
            "title": "not allowed",
        },
        {
            "candidateId": "cand_" + "1" * 20,
            "action": "reject",
            "expectedRevision": 1,
            "idempotencyKey": "idem_" + "1" * 20,
            "statement": "not allowed",
        },
        {
            "candidateId": "cand_" + "1" * 20,
            "action": "edited_and_accept",
            "expectedRevision": 1,
            "idempotencyKey": "idem_" + "1" * 20,
            "title": "missing statement",
        },
        {
            "candidateId": "cand_" + "1" * 20,
            "action": "edited_and_accept",
            "expectedRevision": 1,
            "idempotencyKey": "idem_" + "1" * 20,
            "statement": "missing title",
        },
        {
            "candidateId": "cand_" + "1" * 20,
            "action": "edited_and_accept",
            "expectedRevision": 1,
            "idempotencyKey": "idem_" + "1" * 20,
            "title": "",
            "statement": "valid",
        },
        {
            "candidateId": "cand_" + "1" * 20,
            "action": "edited_and_accept",
            "expectedRevision": 1,
            "idempotencyKey": "idem_" + "1" * 20,
            "title": "x" * 121,
            "statement": "valid",
        },
        {
            "candidateId": "cand_" + "1" * 20,
            "action": "edited_and_accept",
            "expectedRevision": 1,
            "idempotencyKey": "idem_" + "1" * 20,
            "title": "valid",
            "statement": "",
        },
        {
            "candidateId": "cand_" + "1" * 20,
            "action": "edited_and_accept",
            "expectedRevision": 1,
            "idempotencyKey": "idem_" + "1" * 20,
            "title": "valid",
            "statement": "x" * 2001,
        },
        {
            "candidateId": "cand_" + "1" * 20,
            "action": "edited_and_accept",
            "expectedRevision": 1,
            "idempotencyKey": "idem_" + "1" * 20,
            "title": "valid",
            "statement": "\ud800",
        },
        {
            "candidateId": "cand_" + "1" * 20,
            "action": "merge",
            "expectedRevision": 1,
            "idempotencyKey": "idem_" + "1" * 20,
        },
        {
            "candidateId": "cand_" + "1" * 20,
            "action": "accept",
            "expectedRevision": True,
            "idempotencyKey": "idem_" + "1" * 20,
        },
        {
            "candidateId": "cand_" + "1" * 20,
            "action": "accept",
            "expectedRevision": 0,
            "idempotencyKey": "idem_" + "1" * 20,
        },
        {
            "candidateId": "cand_" + "1" * 20,
            "action": "accept",
            "expectedRevision": 1,
            "idempotencyKey": "idem_" + "G" * 20,
        },
        {
            "candidateId": "cand_" + "1" * 20,
            "action": "accept",
            "expectedRevision": 1,
            "idempotencyKey": "idem_" + "1" * 20,
            "unexpected": True,
        },
    ],
)
def test_review_rejects_non_closed_or_out_of_bounds_params_before_sql(
    core: Phase1Core, database, command: dict[str, object]
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    command = {**command, "candidateId": candidate_id}
    before = _business_state(database)

    with pytest.raises(CoreProblem) as caught:
        core.review_candidate(command)

    assert caught.value.code in {"INVALID_PARAMS", "INVALID_IDENTIFIER"}
    assert _business_state(database) == before


def test_edited_bounds_accept_exact_schema_limits(core: Phase1Core, database):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)

    result = _review(
        core,
        candidate_id,
        "edited_and_accept",
        "d",
        title="题" * 120,
        statement="述" * 2000,
    )

    assert result["knowledgePoint"]["title"] == "题" * 120
    assert result["knowledgePoint"]["statement"] == "述" * 2000


def test_pending_candidate_revision_conflict_has_no_sql_effect(
    core: Phase1Core, database
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    before = _business_state(database)

    with pytest.raises(CoreProblem) as caught:
        core.review_candidate(
            {
                "candidateId": candidate_id,
                "action": "reject",
                "expectedRevision": 2,
                "idempotencyKey": "idem_" + "3" * 20,
            }
        )

    assert caught.value.code == "REVISION_CONFLICT"
    assert _business_state(database) == before


def test_intermediate_review_updates_count_and_event_without_completing_run(
    core: Phase1Core, database
):
    candidates = [
        {
            "type": "fact",
            "title": "甲",
            "statement": "甲事实。",
            "evidence": [{"quote": "甲证据", "prefix": "", "suffix": "。"}],
        },
        {
            "type": "fact",
            "title": "乙",
            "statement": "乙事实。",
            "evidence": [{"quote": "乙证据", "prefix": "。", "suffix": "。"}],
        },
    ]
    run_id, first_id, _document_id = _seed_candidates(
        core, database, text="甲证据。乙证据。", candidates=candidates
    )
    second_id = str(
        database.scalar(
            "SELECT id FROM candidates WHERE run_id=? ORDER BY ordinal LIMIT 1 OFFSET 1",
            (run_id,),
        )
    )

    first = _review(core, first_id, "accept", "4")

    assert first["run"]["status"] == "review_pending"
    assert first["run"]["revision"] == 5
    assert database.one(
        "SELECT accepted_candidate_count,completed_at FROM runs WHERE id=?",
        (run_id,),
    ) == {"accepted_candidate_count": 1, "completed_at": None}
    assert core.list_events({"runId": run_id, "after": 6})["events"] == [
        {
            "seq": 7,
            "type": "candidate.accepted",
            "stage": "confirm",
            "payload": {"candidateId": first_id},
        }
    ]

    second = _review(core, second_id, "reject", "5")

    assert second["run"]["status"] == "completed"
    assert second["run"]["revision"] == 6
    assert core.list_events({"runId": run_id, "after": 7})["events"] == [
        {
            "seq": 8,
            "type": "candidate.rejected",
            "stage": "confirm",
            "payload": {"candidateId": second_id},
        },
        {
            "seq": 9,
            "type": "run.completed",
            "stage": "done",
            "payload": {"reason": "reviewed_all"},
        },
    ]


def _resize_result_json(
    template: dict[str, object], target_bytes: int
) -> tuple[dict[str, object], str]:
    resized = json.loads(_canonical_json(template))
    original_text = resized["run"]["document"]["text"]
    current_bytes = len(_canonical_json(resized).encode("utf-8"))
    remaining = target_bytes - current_bytes
    assert remaining >= 3
    resized["run"]["document"]["text"] = (
        original_text + "界" + "a" * (remaining - 3)
    )
    encoded = _canonical_json(resized)
    assert len(encoded.encode("utf-8")) == target_bytes
    return resized, encoded


@pytest.mark.parametrize("same_key", [True, False])
def test_concurrent_review_is_one_write_with_stable_replay_or_conflict(
    core: Phase1Core, database, same_key: bool
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    start = threading.Barrier(2)

    def worker(key_hex: str):
        start.wait(timeout=5)
        try:
            return "success", _review(core, candidate_id, "accept", key_hex)
        except CoreProblem as problem:
            return "error", problem.code

    keys = ("9", "9") if same_key else ("a", "b")
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(worker, key) for key in keys]
        outcomes = [future.result(timeout=5) for future in futures]

    successes = [payload for kind, payload in outcomes if kind == "success"]
    failures = [payload for kind, payload in outcomes if kind == "error"]
    if same_key:
        assert len(successes) == 2
        assert failures == []
        assert successes[0] == successes[1]
        assert _canonical_json(successes[0]) == _canonical_json(successes[1])
        assert database.scalar("SELECT COUNT(*) FROM idempotency_records") == 1
    else:
        assert len(successes) == 1
        assert failures == ["CANDIDATE_ALREADY_REVIEWED"]
        assert database.scalar("SELECT COUNT(*) FROM idempotency_records") == 1
    assert database.scalar("SELECT COUNT(*) FROM knowledge_points") == 1
    assert database.scalar("SELECT COUNT(*) FROM candidate_reviews") == 1


def _seed_candidates(core, database, *, text="定义：能量守恒。过程：先输入，再输出。", candidates=None):
    imported = core.import_text({"filename": "review.md", "mediaType": "text/markdown", "text": text})
    prepared = core.prepare_generation({"runId": imported["runId"], "modelSelection": MODEL_SELECTION})
    if candidates is None:
        candidates = [{"type": "concept", "title": "能量守恒", "statement": "能量在转换过程中总量保持不变。",
            "evidence": [{"quote": "能量守恒", "prefix": "定义：", "suffix": "。"},
                         {"quote": "先输入，再输出", "prefix": "过程：", "suffix": "。"}]}]
    core.submit_generation({"runId": imported["runId"], "attemptId": prepared["attemptId"],
        "expectedRevision": prepared["revision"], "output": {"schemaVersion": 1, "candidates": candidates}})
    candidate = core.list_candidates({"runId": imported["runId"]})["candidates"][0]
    return imported["runId"], candidate["candidateId"], imported["documentId"]


def _business_state(database):
    tables = ("documents", "runs", "generation_attempts", "candidates", "candidate_evidence",
              "candidate_reviews", "knowledge_points", "knowledge_point_evidence", "run_events", "idempotency_records")
    return {table: database.all(f"SELECT * FROM {table} ORDER BY rowid") for table in tables}


@pytest.mark.parametrize("action,status", [("accept", "accepted"), ("edited_and_accept", "edited_and_accepted"), ("reject", "rejected")])
def test_product_review_keeps_proposal_immutable_and_replays_stored_result_first(core, database, action, status):
    run_id, candidate_id, document_id = _seed_candidates(core, database)
    original = database.one("SELECT * FROM candidates WHERE id=?", (candidate_id,))
    evidence = database.all("SELECT * FROM candidate_evidence WHERE candidate_id=? ORDER BY seq", (candidate_id,))
    command = {"candidateId": candidate_id, "action": action, "expectedRevision": 1, "idempotencyKey": "idem_" + "f" * 20}
    if action == "edited_and_accept":
        command.update(title="改后的标题😀", statement="修改后的知识陈述。")
    first = core.review_candidate(command)
    assert first["candidate"]["reviewStatus"] == status
    assert first["candidate"]["revision"] == 2
    assert first["run"]["status"] == "completed"
    assert database.one("SELECT * FROM candidates WHERE id=?", (candidate_id,)) == original
    assert database.all("SELECT * FROM candidate_evidence WHERE candidate_id=? ORDER BY seq", (candidate_id,)) == evidence
    decision = database.one("SELECT * FROM candidate_reviews WHERE candidate_id=?", (candidate_id,))
    assert decision["action"] == action
    if action == "reject":
        assert first["knowledgePoint"] is None
        assert decision["knowledge_point_id"] is None
        assert database.scalar("SELECT COUNT(*) FROM knowledge_points") == 0
    else:
        kp = first["knowledgePoint"]
        assert kp["documentId"] == document_id
        assert kp["evidence"] == first["candidate"]["evidence"]
        assert kp["title"] == command.get("title", original["title"])
        assert kp["statement"] == command.get("statement", original["statement"])
        assert first["candidate"]["title"] == kp["title"]
        assert decision["knowledge_point_id"] == kp["knowledgePointId"]
        assert decision["final_title"] == command.get("title")
        assert decision["final_statement"] == command.get("statement")
        point = database.one("SELECT * FROM knowledge_points WHERE id=?", (kp["knowledgePointId"],))
        assert point["extraction_model"] == MODEL_SELECTION["model"]
    stored = database.scalar("SELECT result_json FROM idempotency_records")
    assert json.loads(stored) == first
    state = _business_state(database)
    assert core.review_candidate(command) == first
    assert _business_state(database) == state
    with pytest.raises(CoreProblem, match="IDEMPOTENCY_CONFLICT"):
        core.review_candidate({**command, "expectedRevision": 2})
    with pytest.raises(CoreProblem, match="CANDIDATE_ALREADY_REVIEWED"):
        core.review_candidate({**command, "idempotencyKey": "idem_" + "e" * 20})
    # Saved response is the authoritative replay, even if the original candidate is removed.
    with database.write_transaction() as con:
        con.execute("DELETE FROM candidates WHERE id=?", (candidate_id,))
    after_delete = _business_state(database)
    assert core.review_candidate(command) == first
    assert _business_state(database) == after_delete


def test_unicode_absolute_evidence_survives_accept(core, database):
    text = "😀开头\r\n第一段。\r\n第二段：𝄞量子😀守恒。"
    quote = "𝄞量子😀守恒"
    candidate = {"type": "fact", "title": "Unicode", "statement": "量子守恒。",
                 "evidence": [{"quote": quote, "prefix": "第二段：", "suffix": "。"}]}
    run_id, candidate_id, document_id = _seed_candidates(core, database, text=text, candidates=[candidate])
    result = _review(core, candidate_id, "accept", "a")
    canonical = database.scalar("SELECT canonical_text FROM documents WHERE id=?", (document_id,))
    span = result["knowledgePoint"]["evidence"][0]
    assert span["textStart"] == canonical.index(quote)
    assert canonical[span["textStart"]:span["textEnd"]] == quote
    assert span["textStart"] != len(canonical[:span["textStart"]].encode("utf-8"))
    persisted = database.one("SELECT quote,text_start,text_end FROM knowledge_point_evidence")
    assert canonical[persisted["text_start"]:persisted["text_end"]] == quote


@pytest.mark.parametrize('action,hook', [
    (action, hook)
    for action in ('accept', 'edited_and_accept', 'reject')
    for hook in ('close_candidate_review', 'append_event', 'update_run_after_review', 'store_idempotency_result')
] + [(action, hook) for action in ('accept', 'edited_and_accept')
     for hook in ('insert_formal_knowledge_point', 'insert_formal_evidence')])
def test_review_write_boundaries_roll_back_all_product_rows(core, database, monkeypatch, action, hook):
    _, candidate_id, _ = _seed_candidates(core, database)
    before = _business_state(database)
    original = getattr(service_module, hook)
    calls = []

    def fail_after_write(*args, **kwargs):
        original(*args, **kwargs)
        calls.append(hook)
        raise RuntimeError('injected product review boundary')

    monkeypatch.setattr(service_module, hook, fail_after_write)
    fields = {'title': 'edited title', 'statement': 'edited statement'} if action == 'edited_and_accept' else {}
    with pytest.raises(CoreProblem, match='TRANSACTION_FAILED'):
        _review(core, candidate_id, action, 'b', **fields)
    assert calls == [hook]
    assert _business_state(database) == before
    assert database.all('PRAGMA foreign_key_check') == []


def test_review_idempotency_survives_reopen(owned_root, ownership_token):
    db = Phase1Database.open(owned_root, ownership_token)
    core = Phase1Core(db, load_candidate_contract(PYTHON_ROOT.parent))
    _, candidate_id, _ = _seed_candidates(core, db)
    first = _review(core, candidate_id, 'edited_and_accept', 'c', title='新标题', statement='新陈述')
    db.close()
    db = Phase1Database.open(owned_root, ownership_token)
    try:
        reopened = Phase1Core(db, load_candidate_contract(PYTHON_ROOT.parent))
        assert _review(reopened, candidate_id, 'edited_and_accept', 'c', title='新标题', statement='新陈述') == first
        assert db.scalar('SELECT COUNT(*) FROM candidate_reviews') == 1
        assert db.scalar('SELECT COUNT(*) FROM knowledge_points') == 1
    finally:
        db.close()
