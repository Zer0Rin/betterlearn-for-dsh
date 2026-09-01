from __future__ import annotations

import pytest

from nobei_core import service as service_module
from nobei_core.contract import load_candidate_contract
from nobei_core.errors import CoreProblem
from nobei_core.service import Phase1Core

from conftest import PYTHON_ROOT


MODEL_SELECTION = {"provider": "test-provider", "model": "test-model"}


@pytest.fixture
def core(database):
    return Phase1Core(database, load_candidate_contract(PYTHON_ROOT.parent))


def _completed(core: Phase1Core, *, suffix: str):
    text = f"定义：知识{suffix}。"
    imported = core.import_text(
        {"filename": f"delete-{suffix}.md", "mediaType": "text/markdown", "text": text}
    )
    prepared = core.prepare_generation(
        {"runId": imported["runId"], "modelSelection": MODEL_SELECTION}
    )
    core.submit_generation(
        {
            "runId": imported["runId"],
            "attemptId": prepared["attemptId"],
            "expectedRevision": prepared["revision"],
            "output": {
                "schemaVersion": 1,
                "candidates": [{
                    "type": "concept",
                    "title": f"知识{suffix}",
                    "statement": f"知识{suffix}的陈述。",
                    "evidence": [{"quote": f"知识{suffix}", "prefix": "定义：", "suffix": "。"}],
                }],
            },
        }
    )
    candidate = core.list_candidates({"runId": imported["runId"]})["candidates"][0]
    key = "idem_" + suffix * 20
    reviewed = core.review_candidate(
        {
            "candidateId": candidate["candidateId"],
            "action": "accept",
            "expectedRevision": 1,
            "idempotencyKey": key,
        }
    )
    return {
        "runId": imported["runId"],
        "documentId": imported["documentId"],
        "candidateId": candidate["candidateId"],
        "knowledgePointId": reviewed["knowledgePoint"]["knowledgePointId"],
        "idempotencyKey": key,
    }


def _all_state(database):
    tables = (
        "documents", "runs", "generation_attempts", "candidates",
        "candidate_evidence", "candidate_reviews", "knowledge_points",
        "knowledge_point_evidence", "run_events", "idempotency_records",
    )
    return {table: database.all(f"SELECT * FROM {table} ORDER BY rowid") for table in tables}


def test_delete_run_removes_the_owned_graph_and_exact_idempotency(core, database):
    deleted = _completed(core, suffix="a")
    kept = _completed(core, suffix="b")

    assert core.delete_run({"runId": deleted["runId"]}) == {
        "runId": deleted["runId"], "deleted": True,
    }
    for table, column, value in (
        ("documents", "id", deleted["documentId"]),
        ("runs", "id", deleted["runId"]),
        ("generation_attempts", "run_id", deleted["runId"]),
        ("candidates", "run_id", deleted["runId"]),
        ("candidate_evidence", "candidate_id", deleted["candidateId"]),
        ("candidate_reviews", "candidate_id", deleted["candidateId"]),
        ("knowledge_points", "id", deleted["knowledgePointId"]),
        ("knowledge_point_evidence", "knowledge_point_id", deleted["knowledgePointId"]),
        ("run_events", "run_id", deleted["runId"]),
        ("idempotency_records", "idempotency_key", deleted["idempotencyKey"]),
    ):
        assert database.scalar(f"SELECT COUNT(*) FROM {table} WHERE {column}=?", (value,)) == 0

    assert core.get_run({"runId": kept["runId"]})["runId"] == kept["runId"]
    assert database.scalar(
        "SELECT COUNT(*) FROM idempotency_records WHERE idempotency_key=?",
        (kept["idempotencyKey"],),
    ) == 1


def test_delete_accepts_an_active_run_graph(core, database):
    imported = core.import_text(
        {"filename": "active.md", "mediaType": "text/markdown", "text": "正在提取"}
    )
    core.prepare_generation({"runId": imported["runId"], "modelSelection": MODEL_SELECTION})
    assert core.delete_run({"runId": imported["runId"]})["deleted"] is True
    assert database.scalar("SELECT COUNT(*) FROM documents WHERE id=?", (imported["documentId"],)) == 0


@pytest.mark.parametrize("params", [
    {},
    {"runId": "not-an-id"},
    {"runId": "job_0123456789abcdefabcd", "extra": True},
])
def test_delete_rejects_invalid_or_open_params(core, params):
    with pytest.raises(CoreProblem):
        core.delete_run(params)


def test_delete_rolls_back_the_entire_graph_on_failure(core, database, monkeypatch):
    target = _completed(core, suffix="c")
    before = _all_state(database)
    original = service_module.delete_run_graph

    def fail_after_delete(con, run_id):
        original(con, run_id)
        raise CoreProblem("TRANSACTION_FAILED", "injected delete failure")

    monkeypatch.setattr(service_module, "delete_run_graph", fail_after_delete)
    with pytest.raises(CoreProblem, match="TRANSACTION_FAILED"):
        core.delete_run({"runId": target["runId"]})
    assert _all_state(database) == before
