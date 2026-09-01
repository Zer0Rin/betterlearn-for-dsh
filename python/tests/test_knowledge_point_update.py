from __future__ import annotations

import hashlib

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


def _seed(core: Phase1Core, *, two_candidates: bool = False):
    text = "定义：能量守恒。过程：先输入，再输出。"
    imported = core.import_text(
        {"filename": "edit.md", "mediaType": "text/markdown", "text": text}
    )
    prepared = core.prepare_generation(
        {"runId": imported["runId"], "modelSelection": MODEL_SELECTION}
    )
    candidates = [
        {
            "type": "concept",
            "title": "能量守恒",
            "statement": "能量在转换过程中总量保持不变。",
            "evidence": [
                {"quote": "能量守恒", "prefix": "定义：", "suffix": "。"}
            ],
        }
    ]
    if two_candidates:
        candidates.append(
            {
                "type": "process",
                "title": "输入输出",
                "statement": "先输入，再输出。",
                "evidence": [
                    {"quote": "先输入，再输出", "prefix": "过程：", "suffix": "。"}
                ],
            }
        )
    core.submit_generation(
        {
            "runId": imported["runId"],
            "attemptId": prepared["attemptId"],
            "expectedRevision": prepared["revision"],
            "output": {"schemaVersion": 1, "candidates": candidates},
        }
    )
    listed = core.list_candidates({"runId": imported["runId"]})["candidates"]
    reviewed = core.review_candidate(
        {
            "candidateId": listed[0]["candidateId"],
            "action": "accept",
            "expectedRevision": 1,
            "idempotencyKey": "idem_" + "a" * 20,
        }
    )
    return imported, listed, reviewed


def _business_state(database):
    return {
        table: database.all(f"SELECT * FROM {table} ORDER BY rowid")
        for table in (
            "runs",
            "candidates",
            "candidate_reviews",
            "knowledge_points",
            "knowledge_point_evidence",
        )
    }


def test_update_completed_knowledge_point_persists_and_reclassifies(core, database):
    imported, candidates, reviewed = _seed(core)
    point = reviewed["knowledgePoint"]
    before_hash = database.scalar(
        "SELECT content_hash FROM knowledge_points WHERE id=?",
        (point["knowledgePointId"],),
    )

    result = core.update_knowledge_point(
        {
            "knowledgePointId": point["knowledgePointId"],
            "title": "修改后的标题",
            "statement": "修改后的知识陈述。",
        }
    )

    assert result["knowledgePoint"]["title"] == "修改后的标题"
    assert result["knowledgePoint"]["statement"] == "修改后的知识陈述。"
    assert result["run"]["runId"] == imported["runId"]
    assert result["run"]["counts"]["accepted"] == 0
    assert result["run"]["counts"]["editedAndAccepted"] == 1
    assert result["run"]["revision"] == reviewed["run"]["revision"] + 1
    stored = core.list_knowledge_points({"runId": imported["runId"]})[
        "knowledgePoints"
    ][0]
    assert stored == result["knowledgePoint"]
    decision = database.one(
        "SELECT action,final_title,final_statement FROM candidate_reviews "
        "WHERE candidate_id=?",
        (candidates[0]["candidateId"],),
    )
    assert decision == {
        "action": "edited_and_accept",
        "final_title": "修改后的标题",
        "final_statement": "修改后的知识陈述。",
    }
    after_hash = database.scalar(
        "SELECT content_hash FROM knowledge_points WHERE id=?",
        (point["knowledgePointId"],),
    )
    assert after_hash != before_hash
    assert len(after_hash) == hashlib.sha256().digest_size * 2
    assert database.one(
        "SELECT title,statement FROM candidates WHERE id=?",
        (candidates[0]["candidateId"],),
    ) == {"title": "能量守恒", "statement": "能量在转换过程中总量保持不变。"}


def test_second_update_does_not_increment_edited_count(core):
    _imported, _candidates, reviewed = _seed(core)
    point_id = reviewed["knowledgePoint"]["knowledgePointId"]
    first = core.update_knowledge_point(
        {"knowledgePointId": point_id, "title": "第一次", "statement": "第一次修改"}
    )
    second = core.update_knowledge_point(
        {"knowledgePointId": point_id, "title": "第二次", "statement": "第二次修改"}
    )
    assert first["run"]["counts"]["editedAndAccepted"] == 1
    assert second["run"]["counts"]["editedAndAccepted"] == 1
    assert second["run"]["revision"] == first["run"]["revision"] + 1


@pytest.mark.parametrize(
    "command",
    [
        {"knowledgePointId": "kp_0123456789abcdefabcd", "title": "", "statement": "有效"},
        {"knowledgePointId": "kp_0123456789abcdefabcd", "title": "题" * 121, "statement": "有效"},
        {"knowledgePointId": "kp_0123456789abcdefabcd", "title": "有效", "statement": ""},
        {"knowledgePointId": "kp_0123456789abcdefabcd", "title": "有效", "statement": "述" * 2001},
        {"knowledgePointId": "kp_0123456789abcdefabcd", "title": "有效", "statement": "有效", "extra": True},
    ],
)
def test_update_rejects_non_closed_or_out_of_bounds_params(core, database, command):
    _imported, _candidates, reviewed = _seed(core)
    before = _business_state(database)
    command = {**command, "knowledgePointId": reviewed["knowledgePoint"]["knowledgePointId"]}
    with pytest.raises(CoreProblem, match="INVALID_PARAMS"):
        core.update_knowledge_point(command)
    assert _business_state(database) == before


def test_update_rejects_unknown_point(core):
    with pytest.raises(CoreProblem) as caught:
        core.update_knowledge_point(
            {
                "knowledgePointId": "kp_0123456789abcdefabcd",
                "title": "标题",
                "statement": "陈述",
            }
        )
    assert caught.value.code == "INVALID_IDENTIFIER"


def test_update_rejects_point_before_run_completion(core, database):
    _imported, _candidates, reviewed = _seed(core, two_candidates=True)
    before = _business_state(database)
    with pytest.raises(CoreProblem) as caught:
        core.update_knowledge_point(
            {
                "knowledgePointId": reviewed["knowledgePoint"]["knowledgePointId"],
                "title": "标题",
                "statement": "陈述",
            }
        )
    assert caught.value.code == "RUN_STATE_CONFLICT"
    assert _business_state(database) == before


def test_update_rolls_back_when_review_reclassification_fails(core, database, monkeypatch):
    _imported, _candidates, reviewed = _seed(core)
    before = _business_state(database)

    def fail(*_args, **_kwargs):
        raise CoreProblem("TRANSACTION_FAILED", "injected update failure")

    monkeypatch.setattr(service_module, "reclassify_review_after_point_edit", fail)
    with pytest.raises(CoreProblem, match="TRANSACTION_FAILED"):
        core.update_knowledge_point(
            {
                "knowledgePointId": reviewed["knowledgePoint"]["knowledgePointId"],
                "title": "不会保存",
                "statement": "不会保存",
            }
        )
    assert _business_state(database) == before
