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

from conftest import MIGRATIONS_ROOT, PHASE1_SCHEMA_PATH, PYTHON_ROOT


MODEL_SELECTION = {"provider": "test-provider", "model": "test-model"}


class _IndependentDatabase:
    def __init__(self, database_path):
        self.connection = sqlite3.connect(
            database_path, isolation_level=None, check_same_thread=False
        )
        self.connection.row_factory = sqlite3.Row
        configure_pragmas(self.connection)

    @contextmanager
    def write_transaction(self):
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            yield self.connection
            self.connection.execute("COMMIT")
        except BaseException:
            if self.connection.in_transaction:
                self.connection.execute("ROLLBACK")
            raise

    @contextmanager
    def read_snapshot(self):
        yield self.connection

    def close(self):
        self.connection.close()


@pytest.fixture
def core(database):
    return Phase1Core(database, load_candidate_contract(PYTHON_ROOT.parent))


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def test_review_vocabulary_has_one_domain_source():
    assert constants_module.CANDIDATE_TYPES == frozenset(
        {"concept", "process", "comparison", "formula", "fact", "code"}
    )
    assert constants_module.REVIEW_ACTIONS == frozenset(
        {"accept", "edited_and_accept", "reject"}
    )
    assert constants_module.CANDIDATE_REVIEW_STATUSES == frozenset(
        {"pending", "accepted", "edited_and_accepted", "rejected"}
    )
    assert constants_module.CONFIRMATION_ACTIONS == frozenset(
        {"accepted_without_edit", "accepted_with_edit", "rejected"}
    )
    assert dict(constants_module.REVIEW_ACTION_MAPPING) == {
        "accept": ("accepted", "accepted_without_edit", "candidate.accepted"),
        "edited_and_accept": (
            "edited_and_accepted",
            "accepted_with_edit",
            "candidate.edited_and_accepted",
        ),
        "reject": ("rejected", "rejected", "candidate.rejected"),
    }


def _seed_candidates(
    core: Phase1Core,
    database,
    *,
    text: str = "定义：能量守恒。过程：先输入，再输出。",
    candidates: list[dict[str, object]] | None = None,
) -> tuple[str, str, str]:
    imported = core.import_text(
        {"filename": "review.md", "mediaType": "text/markdown", "text": text}
    )
    run_id = str(imported["runId"])
    prepared = core.prepare_generation(
        {"runId": run_id, "modelSelection": MODEL_SELECTION}
    )
    output = {
        "schemaVersion": 1,
        "candidates": candidates
        or [
            {
                "type": "concept",
                "title": "能量守恒",
                "statement": "能量在转换过程中总量保持不变。",
                "evidence": [
                    {"quote": "能量守恒", "prefix": "定义：", "suffix": "。"},
                    {
                        "quote": "先输入，再输出",
                        "prefix": "过程：",
                        "suffix": "。",
                    },
                ],
            }
        ],
    }
    submitted = core.submit_generation(
        {
            "runId": run_id,
            "attemptId": prepared["attemptId"],
            "expectedRevision": prepared["revision"],
            "output": output,
        }
    )
    assert submitted["run"]["status"] == "review_pending"
    candidate = database.one(
        "SELECT id FROM p1_candidates WHERE job_id=? ORDER BY ordinal LIMIT 1",
        (run_id,),
    )
    document = database.one(
        "SELECT j.document_id,c.id AS chunk_id FROM import_jobs j "
        "JOIN chunks c ON c.document_id=j.document_id WHERE j.id=?",
        (run_id,),
    )
    assert candidate is not None
    assert document is not None
    return run_id, str(candidate["id"]), str(document["document_id"])


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


def _business_state(database) -> dict[str, list[dict[str, object]]]:
    queries = {
        "runs": "SELECT * FROM p1_run_control ORDER BY job_id",
        "jobs": "SELECT * FROM import_jobs ORDER BY id",
        "candidates": "SELECT * FROM p1_candidates ORDER BY id",
        "candidate_evidence": (
            "SELECT * FROM p1_candidate_evidence ORDER BY candidate_id,seq"
        ),
        "knowledge_points": "SELECT * FROM knowledge_points ORDER BY id",
        "kp_evidence": "SELECT * FROM kp_evidence ORDER BY kp_id,seq,id",
        "confirmations": "SELECT * FROM kp_confirm_log ORDER BY id",
        "events": "SELECT * FROM p1_run_events ORDER BY job_id,seq",
        "idempotency": (
            "SELECT * FROM p1_idempotency ORDER BY scope,idempotency_key"
        ),
    }
    with database.read_snapshot() as connection:
        return {
            name: [dict(row) for row in connection.execute(query).fetchall()]
            for name, query in queries.items()
        }


def test_accept_maps_original_candidate_and_all_exact_evidence(
    core: Phase1Core, database
):
    run_id, candidate_id, document_id = _seed_candidates(core, database)
    original_candidate = database.one(
        "SELECT type,title,statement FROM p1_candidates WHERE id=?", (candidate_id,)
    )
    original_evidence = database.all(
        "SELECT seq,quote,text_start,text_end,context_before,context_after "
        "FROM p1_candidate_evidence WHERE candidate_id=? ORDER BY seq",
        (candidate_id,),
    )

    result = _review(core, candidate_id, "accept", "a")

    assert result.keys() == {"candidate", "run", "knowledgePoint"}
    assert result["candidate"] == {
        "candidateId": candidate_id,
        "type": "concept",
        "title": "能量守恒",
        "statement": "能量在转换过程中总量保持不变。",
        "reviewStatus": "accepted",
        "revision": 2,
        "knowledgePointId": result["knowledgePoint"]["knowledgePointId"],
        "evidence": [
            {
                "seq": item["seq"],
                "quote": item["quote"],
                "textStart": item["text_start"],
                "textEnd": item["text_end"],
                "contextBefore": item["context_before"],
                "contextAfter": item["context_after"],
            }
            for item in original_evidence
        ],
    }
    assert result["run"]["runId"] == run_id
    assert result["run"]["status"] == "completed"
    assert result["knowledgePoint"] == {
        "knowledgePointId": result["knowledgePoint"]["knowledgePointId"],
        "type": "concept",
        "title": "能量守恒",
        "statement": "能量在转换过程中总量保持不变。",
        "documentId": document_id,
        "evidence": result["candidate"]["evidence"],
    }
    knowledge_point_id = str(result["knowledgePoint"]["knowledgePointId"])
    assert database.one(
        "SELECT course_id,document_id,chunk_id,type,exam_qtype,card_role,parent_id,"
        "title,content,code,code_full,code_full_scope,code_status,code_locator,"
        "origin,status,confidence,dup_group_id,extraction_model,"
        "extraction_prompt_version,content_hash,page,heading_path "
        "FROM knowledge_points WHERE id=?",
        (knowledge_point_id,),
    ) == {
        "course_id": "crs_p1_fixture",
        "document_id": document_id,
        "chunk_id": database.scalar(
            "SELECT c.id FROM chunks c JOIN import_jobs j ON j.document_id=c.document_id "
            "WHERE j.id=?",
            (run_id,),
        ),
        "type": original_candidate["type"],
        "exam_qtype": "",
        "card_role": "standalone",
        "parent_id": None,
        "title": original_candidate["title"],
        "content": original_candidate["statement"],
        "code": None,
        "code_full": None,
        "code_full_scope": None,
        "code_status": None,
        "code_locator": None,
        "origin": "extracted",
        "status": "confirmed",
        "confidence": 1.0,
        "dup_group_id": None,
        "extraction_model": "test-model",
        "extraction_prompt_version": "l1-v2",
        "content_hash": database.scalar(
            "SELECT content_hash FROM knowledge_points WHERE id=?",
            (knowledge_point_id,),
        ),
        "page": None,
        "heading_path": "",
    }
    hash_payload = {
        "type": "concept",
        "title": "能量守恒",
        "statement": "能量在转换过程中总量保持不变。",
        "documentId": document_id,
        "evidence": result["candidate"]["evidence"],
    }
    assert database.scalar(
        "SELECT content_hash FROM knowledge_points WHERE id=?", (knowledge_point_id,)
    ) == hashlib.sha256(_canonical_json(hash_payload).encode("utf-8")).hexdigest()
    assert database.all(
        "SELECT seq,quote,chunk_id,page,align_method,locator_confidence,text_start,"
        "text_end,context_before,context_after FROM kp_evidence WHERE kp_id=? ORDER BY seq",
        (knowledge_point_id,),
    ) == [
        {
            "seq": item["seq"],
            "quote": item["quote"],
            "chunk_id": database.scalar(
                "SELECT chunk_id FROM knowledge_points WHERE id=?", (knowledge_point_id,)
            ),
            "page": None,
            "align_method": "exact",
            "locator_confidence": 1.0,
            "text_start": item["text_start"],
            "text_end": item["text_end"],
            "context_before": item["context_before"],
            "context_after": item["context_after"],
        }
        for item in original_evidence
    ]
    assert database.one(
        "SELECT kp_id,support_label,action,edited_fields,merged_into,granularity,"
        "elapsed_sec FROM kp_confirm_log"
    ) == {
        "kp_id": knowledge_point_id,
        "support_label": None,
        "action": "accepted_without_edit",
        "edited_fields": "[]",
        "merged_into": None,
        "granularity": None,
        "elapsed_sec": None,
    }
    assert database.one(
        "SELECT review_status,revision,accepted_kp_id,reviewed_at IS NOT NULL AS reviewed "
        "FROM p1_candidates WHERE id=?",
        (candidate_id,),
    ) == {
        "review_status": "accepted",
        "revision": 2,
        "accepted_kp_id": knowledge_point_id,
        "reviewed": 1,
    }
    assert database.one(
        "SELECT status,stage,revision,accepted_candidate_count,completed_at IS NOT NULL AS completed "
        "FROM p1_run_control WHERE job_id=?",
        (run_id,),
    ) == {
        "status": "completed",
        "stage": "done",
        "revision": 5,
        "accepted_candidate_count": 1,
        "completed": 1,
    }


def test_edited_and_accept_changes_only_final_text_and_preserves_evidence(
    core: Phase1Core, database
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    before_evidence = database.all(
        "SELECT * FROM p1_candidate_evidence WHERE candidate_id=? ORDER BY seq",
        (candidate_id,),
    )

    result = _review(
        core,
        candidate_id,
        "edited_and_accept",
        "b",
        title="修改后的标题",
        statement="修改后的知识陈述",
    )

    assert result["candidate"]["title"] == "修改后的标题"
    assert result["candidate"]["statement"] == "修改后的知识陈述"
    assert result["candidate"]["reviewStatus"] == "edited_and_accepted"
    assert result["knowledgePoint"]["title"] == "修改后的标题"
    assert result["knowledgePoint"]["statement"] == "修改后的知识陈述"
    knowledge_point_id = str(result["knowledgePoint"]["knowledgePointId"])
    assert database.one(
        "SELECT title,content FROM knowledge_points WHERE id=?", (knowledge_point_id,)
    ) == {"title": "修改后的标题", "content": "修改后的知识陈述"}
    assert database.all(
        "SELECT * FROM p1_candidate_evidence WHERE candidate_id=? ORDER BY seq",
        (candidate_id,),
    ) == before_evidence
    assert database.one(
        "SELECT kp_id,action,edited_fields FROM kp_confirm_log"
    ) == {
        "kp_id": knowledge_point_id,
        "action": "accepted_with_edit",
        "edited_fields": '["title","content"]',
    }


def test_reject_creates_no_knowledge_point_and_logs_candidate_id(
    core: Phase1Core, database
):
    run_id, candidate_id, _document_id = _seed_candidates(core, database)

    result = _review(core, candidate_id, "reject", "c")

    assert result.keys() == {"candidate", "run", "knowledgePoint"}
    assert result["candidate"]["reviewStatus"] == "rejected"
    assert result["candidate"]["revision"] == 2
    assert result["candidate"]["knowledgePointId"] is None
    assert result["run"]["status"] == "completed"
    assert result["knowledgePoint"] is None
    assert database.scalar("SELECT COUNT(*) FROM knowledge_points") == 0
    assert database.scalar("SELECT COUNT(*) FROM kp_evidence") == 0
    assert database.one(
        "SELECT kp_id,action,edited_fields FROM kp_confirm_log"
    ) == {"kp_id": candidate_id, "action": "rejected", "edited_fields": "[]"}
    assert database.one(
        "SELECT review_status,revision,accepted_kp_id FROM p1_candidates WHERE id=?",
        (candidate_id,),
    ) == {
        "review_status": "rejected",
        "revision": 2,
        "accepted_kp_id": None,
    }
    assert database.one(
        "SELECT status,accepted_candidate_count FROM p1_run_control WHERE job_id=?",
        (run_id,),
    ) == {"status": "completed", "accepted_candidate_count": 0}


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


def test_idempotent_replay_uses_stored_bytes_before_state_and_revision_checks(
    core: Phase1Core, database
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    command = {
        "candidateId": candidate_id,
        "action": "accept",
        "expectedRevision": 1,
        "idempotencyKey": "idem_" + "e" * 20,
    }

    first = core.review_candidate(command)
    stored = database.one(
        "SELECT request_digest,result_json FROM p1_idempotency "
        "WHERE scope='candidate_review' AND idempotency_key=?",
        (command["idempotencyKey"],),
    )
    assert stored is not None
    expected_digest_payload = {
        "candidateId": candidate_id,
        "action": "accept",
        "title": "能量守恒",
        "statement": "能量在转换过程中总量保持不变。",
        "expectedRevision": 1,
    }
    assert stored["request_digest"] == hashlib.sha256(
        _canonical_json(expected_digest_payload).encode("utf-8")
    ).hexdigest()
    assert stored["result_json"] == _canonical_json(first)
    assert json.dumps(first, ensure_ascii=False, separators=(",", ":")) == stored[
        "result_json"
    ]
    terminal_state = _business_state(database)

    replay = core.review_candidate(command)

    assert replay == first
    assert json.dumps(replay, ensure_ascii=False, separators=(",", ":")) == stored[
        "result_json"
    ]
    assert _business_state(database) == terminal_state


def test_same_key_with_different_digest_conflicts_before_terminal_state_check(
    core: Phase1Core, database
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    command = {
        "candidateId": candidate_id,
        "action": "accept",
        "expectedRevision": 1,
        "idempotencyKey": "idem_" + "f" * 20,
    }
    core.review_candidate(command)
    before = _business_state(database)

    with pytest.raises(CoreProblem) as caught:
        core.review_candidate({**command, "expectedRevision": 2})

    assert caught.value.code == "IDEMPOTENCY_CONFLICT"
    assert _business_state(database) == before


def test_exact_replay_does_not_depend_on_candidate_current_state_or_existence(
    core: Phase1Core, database
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    command = {
        "candidateId": candidate_id,
        "action": "accept",
        "expectedRevision": 1,
        "idempotencyKey": "idem_" + "0" * 20,
    }
    first = core.review_candidate(command)
    expected_bytes = json.dumps(first, ensure_ascii=False, separators=(",", ":"))
    with database.write_transaction() as connection:
        connection.execute("DELETE FROM p1_candidates WHERE id=?", (candidate_id,))
    before = _business_state(database)

    replay = core.review_candidate(command)

    assert json.dumps(replay, ensure_ascii=False, separators=(",", ":")) == expected_bytes
    assert _business_state(database) == before


@pytest.mark.parametrize(
    "change",
    [
        {"candidateId": "cand_" + "f" * 20},
        {"action": "reject"},
        {"expectedRevision": 2},
        {
            "action": "edited_and_accept",
            "title": "不同标题",
            "statement": "不同陈述",
        },
    ],
)
def test_used_key_with_missing_candidate_still_reports_digest_conflict(
    core: Phase1Core, database, change: dict[str, object]
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    command = {
        "candidateId": candidate_id,
        "action": "accept",
        "expectedRevision": 1,
        "idempotencyKey": "idem_" + "1" * 20,
    }
    core.review_candidate(command)
    with database.write_transaction() as connection:
        connection.execute("DELETE FROM p1_candidates WHERE id=?", (candidate_id,))
    conflicting = {**command, **change}
    if conflicting["action"] != "edited_and_accept":
        conflicting.pop("title", None)
        conflicting.pop("statement", None)
    before = _business_state(database)

    with pytest.raises(CoreProblem) as caught:
        core.review_candidate(conflicting)

    assert caught.value.code == "IDEMPOTENCY_CONFLICT"
    assert _business_state(database) == before


def test_replay_survives_close_reopen_and_deleted_candidate(
    owned_root, ownership_token
):
    database = Phase1Database.open(
        owned_root, ownership_token, MIGRATIONS_ROOT, PHASE1_SCHEMA_PATH
    )
    contract = load_candidate_contract(PYTHON_ROOT.parent)
    core = Phase1Core(database, contract)
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    command = {
        "candidateId": candidate_id,
        "action": "edited_and_accept",
        "title": "持久标题",
        "statement": "持久陈述",
        "expectedRevision": 1,
        "idempotencyKey": "idem_" + "2" * 20,
    }
    first = core.review_candidate(command)
    first_bytes = json.dumps(first, ensure_ascii=False, separators=(",", ":"))
    database.close()

    reopened = Phase1Database.open(
        owned_root, ownership_token, MIGRATIONS_ROOT, PHASE1_SCHEMA_PATH
    )
    try:
        reopened_core = Phase1Core(reopened, contract)
        with reopened.write_transaction() as connection:
            connection.execute("DELETE FROM p1_candidates WHERE id=?", (candidate_id,))
        reopened.close()
        reopened = Phase1Database.open(
            owned_root, ownership_token, MIGRATIONS_ROOT, PHASE1_SCHEMA_PATH
        )
        replay = Phase1Core(reopened, contract).review_candidate(command)
        assert json.dumps(
            replay, ensure_ascii=False, separators=(",", ":")
        ) == first_bytes
    finally:
        reopened.close()


def test_noncanonical_or_nonclosed_stored_result_is_never_replayed(
    core: Phase1Core, database
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    command = {
        "candidateId": candidate_id,
        "action": "reject",
        "expectedRevision": 1,
        "idempotencyKey": "idem_" + "3" * 20,
    }
    core.review_candidate(command)
    stored = database.scalar(
        "SELECT result_json FROM p1_idempotency WHERE idempotency_key=?",
        (command["idempotencyKey"],),
    )
    corrupted = json.loads(stored)
    corrupted["candidate"]["unexpected"] = True
    with database.write_transaction() as connection:
        connection.execute(
            "UPDATE p1_idempotency SET result_json=? WHERE idempotency_key=?",
            (_canonical_json(corrupted), command["idempotencyKey"]),
        )
    before = _business_state(database)

    with pytest.raises(CoreProblem) as caught:
        core.review_candidate(command)

    assert caught.value.code == "TRANSACTION_FAILED"
    assert _business_state(database) == before


@pytest.mark.parametrize(
    "relation",
    ["candidate_id", "review_status", "revision", "edited_title", "edited_statement"],
)
def test_structurally_valid_replay_semantic_corruption_fails_closed(
    core: Phase1Core, database, relation: str
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    edited = relation.startswith("edited_")
    command = {
        "candidateId": candidate_id,
        "action": "edited_and_accept" if edited else "accept",
        "expectedRevision": 1,
        "idempotencyKey": "idem_" + "4" * 20,
        **(
            {"title": "审核标题", "statement": "审核陈述。"}
            if edited
            else {}
        ),
    }
    core.review_candidate(command)
    stored = database.scalar(
        "SELECT result_json FROM p1_idempotency WHERE idempotency_key=?",
        (command["idempotencyKey"],),
    )
    corrupted = json.loads(stored)
    if relation == "candidate_id":
        corrupted["candidate"]["candidateId"] = "cand_" + "f" * 20
    elif relation == "review_status":
        corrupted["candidate"]["reviewStatus"] = "edited_and_accepted"
    elif relation == "revision":
        corrupted["candidate"]["revision"] = 3
    elif relation == "edited_title":
        corrupted["candidate"]["title"] = "被篡改标题"
        corrupted["knowledgePoint"]["title"] = "被篡改标题"
    else:
        corrupted["candidate"]["statement"] = "被篡改陈述。"
        corrupted["knowledgePoint"]["statement"] = "被篡改陈述。"
    with database.write_transaction() as connection:
        connection.execute(
            "UPDATE p1_idempotency SET result_json=? WHERE idempotency_key=?",
            (_canonical_json(corrupted), command["idempotencyKey"]),
        )
    before = _business_state(database)

    with pytest.raises(CoreProblem) as caught:
        core.review_candidate(command)

    assert caught.value.code == "TRANSACTION_FAILED"
    assert _business_state(database) == before


def test_replay_digest_mismatch_precedes_semantic_binding(
    core: Phase1Core, database
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    command = {
        "candidateId": candidate_id,
        "action": "accept",
        "expectedRevision": 1,
        "idempotencyKey": "idem_" + "5" * 20,
    }
    core.review_candidate(command)
    stored = database.scalar(
        "SELECT result_json FROM p1_idempotency WHERE idempotency_key=?",
        (command["idempotencyKey"],),
    )
    corrupted = json.loads(stored)
    corrupted["candidate"]["revision"] = 3
    with database.write_transaction() as connection:
        connection.execute(
            "UPDATE p1_idempotency SET result_json=? WHERE idempotency_key=?",
            (_canonical_json(corrupted), command["idempotencyKey"]),
        )
    before = _business_state(database)

    with pytest.raises(CoreProblem) as caught:
        core.review_candidate({**command, "expectedRevision": 2})

    assert caught.value.code == "IDEMPOTENCY_CONFLICT"
    assert _business_state(database) == before


def test_different_key_after_success_is_stable_already_reviewed_conflict(
    core: Phase1Core, database
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    _review(core, candidate_id, "accept", "1")
    before = _business_state(database)

    with pytest.raises(CoreProblem) as caught:
        _review(core, candidate_id, "accept", "2")

    assert caught.value.code == "CANDIDATE_ALREADY_REVIEWED"
    assert _business_state(database) == before


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
            "SELECT id FROM p1_candidates WHERE job_id=? ORDER BY ordinal LIMIT 1 OFFSET 1",
            (run_id,),
        )
    )

    first = _review(core, first_id, "accept", "4")

    assert first["run"]["status"] == "review_pending"
    assert first["run"]["revision"] == 5
    assert database.one(
        "SELECT accepted_candidate_count,completed_at FROM p1_run_control WHERE job_id=?",
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


def test_each_review_command_increments_run_revision_exactly_once(
    core: Phase1Core, database
):
    candidates = [
        {
            "type": "fact",
            "title": label,
            "statement": f"{label}事实。",
            "evidence": [
                {"quote": f"{label}证据", "prefix": "", "suffix": "。"}
            ],
        }
        for label in ("甲", "乙", "丙")
    ]
    run_id, _first_id, _document_id = _seed_candidates(
        core, database, text="甲证据。乙证据。丙证据。", candidates=candidates
    )
    candidate_ids = [
        row["id"]
        for row in database.all(
            "SELECT id FROM p1_candidates WHERE job_id=? ORDER BY ordinal", (run_id,)
        )
    ]

    first = _review(core, candidate_ids[0], "accept", "8")
    second = _review(
        core,
        candidate_ids[1],
        "edited_and_accept",
        "9",
        title="乙编辑",
        statement="乙编辑事实。",
    )
    third = _review(core, candidate_ids[2], "reject", "a")

    assert [
        first["run"]["revision"],
        second["run"]["revision"],
        third["run"]["revision"],
    ] == [5, 6, 7]
    assert [
        first["run"]["status"],
        second["run"]["status"],
        third["run"]["status"],
    ] == ["review_pending", "review_pending", "completed"]
    assert database.one(
        "SELECT revision,accepted_candidate_count FROM p1_run_control WHERE job_id=?",
        (run_id,),
    ) == {"revision": 7, "accepted_candidate_count": 2}


def test_final_review_uses_canonical_transition(
    core: Phase1Core, database, monkeypatch
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    before = _business_state(database)
    monkeypatch.setattr(
        repository_module,
        "ALLOWED_TRANSITIONS",
        {
            **repository_module.ALLOWED_TRANSITIONS,
            "review_pending": frozenset(),
        },
    )

    with pytest.raises(CoreProblem, match="RUN_STATE_CONFLICT"):
        _review(core, candidate_id, "accept", "e")

    assert _business_state(database) == before


@pytest.mark.parametrize(
    "hook_name",
    [
        "insert_formal_knowledge_point",
        "insert_formal_evidence",
        "insert_confirmation_log",
        "store_idempotency_result",
    ],
)
def test_injected_failure_after_each_write_point_rolls_back_everything(
    core: Phase1Core, database, monkeypatch, hook_name: str
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    before = _business_state(database)
    original = getattr(service_module, hook_name)

    def fail_after_write(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("injected review failure must remain private")

    monkeypatch.setattr(service_module, hook_name, fail_after_write)
    with pytest.raises(CoreProblem) as caught:
        _review(core, candidate_id, "accept", "6")

    assert caught.value.code == "TRANSACTION_FAILED"
    assert caught.value.public() == {"code": "TRANSACTION_FAILED"}
    assert "injected review failure" not in str(caught.value)
    assert _business_state(database) == before


@pytest.mark.parametrize(
    "hook_name", ["insert_confirmation_log", "store_idempotency_result"]
)
def test_reject_failure_after_confirmation_or_idempotency_rolls_back_everything(
    core: Phase1Core, database, monkeypatch, hook_name: str
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    before = _business_state(database)
    original = getattr(service_module, hook_name)

    def fail_after_write(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("reject rollback injection")

    monkeypatch.setattr(service_module, hook_name, fail_after_write)
    with pytest.raises(CoreProblem) as caught:
        _review(core, candidate_id, "reject", "f")

    assert caught.value.code == "TRANSACTION_FAILED"
    assert _business_state(database) == before


@pytest.mark.parametrize("kind", ["domain", "interrupt"])
def test_review_preserves_domain_and_process_control_flow_exceptions(
    core: Phase1Core, database, monkeypatch, kind: str
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    before = _business_state(database)
    original = service_module.store_idempotency_result
    marker: BaseException
    if kind == "domain":
        marker = CoreProblem("RUN_STATE_CONFLICT", "preserve domain control flow")
    else:
        marker = KeyboardInterrupt("preserve process control flow")

    def interrupt_after_idempotency(*args, **kwargs):
        original(*args, **kwargs)
        raise marker

    monkeypatch.setattr(
        service_module, "store_idempotency_result", interrupt_after_idempotency
    )
    with pytest.raises(type(marker)) as caught:
        _review(core, candidate_id, "accept", "6")

    assert caught.value is marker
    assert _business_state(database) == before


def test_idempotency_result_byte_cap_rolls_back_before_commit(
    core: Phase1Core, database, monkeypatch
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    before = _business_state(database)
    monkeypatch.setattr(service_module, "MAX_IDEMPOTENCY_RESULT_BYTES", 1)

    with pytest.raises(CoreProblem) as caught:
        _review(core, candidate_id, "accept", "7")

    assert caught.value.code == "REQUEST_TOO_LARGE"
    assert caught.value.data == {"actualBytes": caught.value.data["actualBytes"], "maxBytes": 1}
    assert caught.value.data["actualBytes"] > 1
    assert _business_state(database) == before


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


def test_idempotency_result_uses_exact_utf8_byte_boundaries(
    core: Phase1Core, database
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    template = _review(core, candidate_id, "reject", "4")
    exact, exact_json = _resize_result_json(template, 65_536)
    over, _over_json = _resize_result_json(template, 65_537)

    assert service_module._encode_review_result(exact) == exact_json
    with pytest.raises(CoreProblem) as caught:
        service_module._encode_review_result(over)

    assert caught.value.code == "REQUEST_TOO_LARGE"
    assert caught.value.data == {"actualBytes": 65_537, "maxBytes": 65_536}


def test_accepted_kp_reference_restricts_delete_and_foreign_keys_remain_clean(
    core: Phase1Core, database
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    result = _review(core, candidate_id, "accept", "5")
    knowledge_point_id = result["knowledgePoint"]["knowledgePointId"]

    with pytest.raises(sqlite3.IntegrityError):
        with database.write_transaction() as connection:
            connection.execute(
                "DELETE FROM knowledge_points WHERE id=?", (knowledge_point_id,)
            )

    assert database.scalar(
        "SELECT accepted_kp_id FROM p1_candidates WHERE id=?", (candidate_id,)
    ) == knowledge_point_id
    assert database.all("PRAGMA foreign_key_check") == []


def test_review_commit_uses_one_timestamp_for_all_related_rows_and_events(
    core: Phase1Core, database, monkeypatch
):
    run_id, candidate_id, _document_id = _seed_candidates(core, database)
    reviewed_at = "2026-08-26T12:34:56Z"
    later_times = iter(
        [
            "2026-08-26T12:34:57Z",
            "2026-08-26T12:34:58Z",
            "2026-08-26T12:34:59Z",
            "2026-08-26T12:35:00Z",
        ]
    )
    monkeypatch.setattr(service_module, "now_iso", lambda: reviewed_at)
    monkeypatch.setattr(repository_module, "now_iso", lambda: next(later_times))

    result = _review(core, candidate_id, "accept", "6")
    knowledge_point_id = result["knowledgePoint"]["knowledgePointId"]

    assert database.one(
        "SELECT reviewed_at FROM p1_candidates WHERE id=?", (candidate_id,)
    ) == {"reviewed_at": reviewed_at}
    assert database.one(
        "SELECT created_at,updated_at FROM knowledge_points WHERE id=?",
        (knowledge_point_id,),
    ) == {"created_at": reviewed_at, "updated_at": reviewed_at}
    assert database.one(
        "SELECT confirmed_at FROM kp_confirm_log WHERE kp_id=?",
        (knowledge_point_id,),
    ) == {"confirmed_at": reviewed_at}
    assert database.one(
        "SELECT created_at FROM p1_idempotency WHERE idempotency_key=?",
        ("idem_" + "6" * 20,),
    ) == {"created_at": reviewed_at}
    assert database.one(
        "SELECT updated_at,completed_at FROM p1_run_control WHERE job_id=?",
        (run_id,),
    ) == {"updated_at": reviewed_at, "completed_at": reviewed_at}
    assert database.all(
        "SELECT created_at FROM p1_run_events WHERE job_id=? AND seq>6 ORDER BY seq",
        (run_id,),
    ) == [{"created_at": reviewed_at}, {"created_at": reviewed_at}]


def test_review_does_not_touch_provider_usage_or_process_capabilities(
    core: Phase1Core, database, monkeypatch
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    before = {
        "providers": database.all("SELECT * FROM providers ORDER BY role"),
        "usage": database.all("SELECT * FROM usage_logs ORDER BY id"),
    }

    def forbidden_capability(*_args, **_kwargs):
        pytest.fail("review reached an external provider or process capability")

    monkeypatch.setattr(subprocess, "run", forbidden_capability)
    monkeypatch.setattr(subprocess, "Popen", forbidden_capability)
    monkeypatch.setattr(os, "system", forbidden_capability)
    monkeypatch.setattr(os, "popen", forbidden_capability)

    _review(core, candidate_id, "accept", "7")

    assert database.all("SELECT * FROM providers ORDER BY role") == before["providers"]
    assert database.all("SELECT * FROM usage_logs ORDER BY id") == before["usage"]


def test_reverse_unordered_selects_cannot_change_evidence_order_or_hash(
    core: Phase1Core, database
):
    _run_id, candidate_id, document_id = _seed_candidates(core, database)
    with database.read_snapshot() as connection:
        connection.execute("PRAGMA reverse_unordered_selects=ON")

    result = _review(core, candidate_id, "accept", "8")

    evidence = result["knowledgePoint"]["evidence"]
    assert [item["seq"] for item in evidence] == [0, 1]
    hash_payload = {
        "type": result["knowledgePoint"]["type"],
        "title": result["knowledgePoint"]["title"],
        "statement": result["knowledgePoint"]["statement"],
        "documentId": document_id,
        "evidence": evidence,
    }
    assert database.scalar(
        "SELECT content_hash FROM knowledge_points WHERE id=?",
        (result["knowledgePoint"]["knowledgePointId"],),
    ) == hashlib.sha256(_canonical_json(hash_payload).encode("utf-8")).hexdigest()


def test_review_preserves_noncontiguous_exact_evidence_sequence(
    core: Phase1Core, database
):
    candidates = [
        {
            "type": "fact",
            "title": "仅第二条证据有效",
            "statement": "审核必须保留原始稳定证据序号。",
            "evidence": [
                {"quote": "不存在", "prefix": "", "suffix": ""},
                {"quote": "有效证据", "prefix": "正文：", "suffix": "。"},
            ],
        }
    ]
    _run_id, candidate_id, _document_id = _seed_candidates(
        core, database, text="正文：有效证据。", candidates=candidates
    )
    assert database.all(
        "SELECT seq FROM p1_candidate_evidence WHERE candidate_id=? ORDER BY seq",
        (candidate_id,),
    ) == [{"seq": 1}]

    result = _review(core, candidate_id, "accept", "c")

    assert [item["seq"] for item in result["candidate"]["evidence"]] == [1]
    assert database.all(
        "SELECT seq FROM kp_evidence WHERE kp_id=? ORDER BY seq",
        (result["knowledgePoint"]["knowledgePointId"],),
    ) == [{"seq": 1}]


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
        assert database.scalar("SELECT COUNT(*) FROM p1_idempotency") == 1
    else:
        assert len(successes) == 1
        assert failures == ["CANDIDATE_ALREADY_REVIEWED"]
        assert database.scalar("SELECT COUNT(*) FROM p1_idempotency") == 1
    assert database.scalar("SELECT COUNT(*) FROM knowledge_points") == 1
    assert database.scalar("SELECT COUNT(*) FROM kp_confirm_log") == 1


@pytest.mark.parametrize("same_key", [True, False])
def test_two_sqlite_connections_serialize_review_replay_or_conflict(
    core: Phase1Core, database, owned_root, same_key: bool
):
    _run_id, candidate_id, _document_id = _seed_candidates(core, database)
    first_database = _IndependentDatabase(owned_root / "phase1.db")
    second_database = _IndependentDatabase(owned_root / "phase1.db")
    contract = load_candidate_contract(PYTHON_ROOT.parent)
    first_core = Phase1Core(first_database, contract)
    second_core = Phase1Core(second_database, contract)
    start = threading.Barrier(2)

    def worker(worker_core: Phase1Core, key_hex: str):
        start.wait(timeout=5)
        try:
            return "success", _review(worker_core, candidate_id, "accept", key_hex)
        except CoreProblem as problem:
            return "error", problem.code

    keys = ("d", "d") if same_key else ("d", "e")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(worker, first_core, keys[0]),
                executor.submit(worker, second_core, keys[1]),
            ]
            outcomes = [future.result(timeout=10) for future in futures]
    finally:
        first_database.close()
        second_database.close()

    successes = [payload for kind, payload in outcomes if kind == "success"]
    failures = [payload for kind, payload in outcomes if kind == "error"]
    if same_key:
        assert len(successes) == 2
        assert failures == []
        assert successes[0] == successes[1]
    else:
        assert len(successes) == 1
        assert failures == ["CANDIDATE_ALREADY_REVIEWED"]
    assert database.scalar("SELECT COUNT(*) FROM knowledge_points") == 1
    assert database.scalar("SELECT COUNT(*) FROM kp_evidence") == 2
    assert database.scalar("SELECT COUNT(*) FROM kp_confirm_log") == 1
    assert database.scalar("SELECT COUNT(*) FROM p1_idempotency") == 1
