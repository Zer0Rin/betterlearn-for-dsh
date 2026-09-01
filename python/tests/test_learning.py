from __future__ import annotations

import json

import pytest

from nobei_core.contract import load_candidate_contract
from nobei_core.errors import CoreProblem
from nobei_core.service import Phase1Core

from conftest import PYTHON_ROOT


def _core(database) -> Phase1Core:
    return Phase1Core(database, load_candidate_contract(PYTHON_ROOT.parent))


def _seed_points(database) -> tuple[str, str]:
    first = "kp_" + "1" * 20
    second = "kp_" + "2" * 20
    with database.write_transaction() as con:
        con.execute(
            "INSERT INTO documents(id,filename,media_type,canonical_text,byte_size,"
            "character_count,text_sha256,created_at) VALUES(?,?,?,?,?,?,?,?)",
            (
                "doc_" + "1" * 20,
                "nist.md",
                "text/markdown",
                "按需自助服务允许用户自动配置资源。资源池通过多租户模型共享资源。",
                96,
                34,
                "a" * 64,
                "2026-09-01T00:00:00Z",
            ),
        )
        for point_id, title, statement, content_hash in (
            (first, "按需自助服务", "用户无需人工交互即可自动配置计算资源。", "b" * 64),
            (second, "资源池化", "计算资源通过多租户模型形成共享资源池。", "c" * 64),
        ):
            con.execute(
                "INSERT INTO knowledge_points(id,document_id,type,title,statement,origin,status,"
                "extraction_model,extraction_prompt_version,content_hash,created_at,updated_at) "
                "VALUES(?,?,?,?,?,'extracted','confirmed','fixture','fixture',?,?,?)",
                (
                    point_id,
                    "doc_" + "1" * 20,
                    "concept",
                    title,
                    statement,
                    content_hash,
                    "2026-09-01T00:00:00Z",
                    "2026-09-01T00:00:00Z",
                ),
            )
        con.execute(
            "INSERT INTO knowledge_point_evidence(id,knowledge_point_id,seq,quote,text_start,text_end,"
            "context_before,context_after) VALUES(?,?,?,?,?,?,?,?)",
            ("ev_" + "1" * 20, first, 0, "按需自助服务允许用户自动配置资源", 0, 16, "", "。"),
        )
        con.execute(
            "INSERT INTO knowledge_point_evidence(id,knowledge_point_id,seq,quote,text_start,text_end,"
            "context_before,context_after) VALUES(?,?,?,?,?,?,?,?)",
            ("ev_" + "2" * 20, second, 0, "资源池通过多租户模型共享资源", 17, 31, "。", "。"),
        )
    return first, second


def _sync(core: Phase1Core, point_ids: tuple[str, str]) -> dict[str, object]:
    return core.sync_learning_course(
        {
            "clientBookId": "book-nist-five-features",
            "title": "NIST 云计算基本特征",
            "knowledgePointIds": list(point_ids),
        }
    )


def _find_assessment(course: dict[str, object], unit_index: int, key: str) -> dict[str, object]:
    units = course["units"]
    assert isinstance(units, list)
    unit = units[unit_index]
    assert isinstance(unit, dict)
    check = unit["check"]
    assert isinstance(check, dict)
    assessment = check[key]
    assert isinstance(assessment, dict)
    return assessment


def test_course_freezes_real_statements_and_exposes_no_answer_key(database):
    core = _core(database)
    point_ids = _seed_points(database)

    course = _sync(core, point_ids)

    assert course["clientBookId"] == "book-nist-five-features"
    assert course["progress"] == {"completed": 0, "total": 2, "mastery": 0}
    main = _find_assessment(course, 0, "main")
    retest = _find_assessment(course, 0, "retest")
    assert main["prompt"] == "以下哪一项准确说明“按需自助服务”？"
    assert {option["label"] for option in main["options"]} == {
        "用户无需人工交互即可自动配置计算资源。",
        "计算资源通过多租户模型形成共享资源池。",
    }
    assert retest["prompt"] == "以下哪段原文最直接支持：用户无需人工交互即可自动配置计算资源。"
    assert "correctOptionId" not in json.dumps(course, ensure_ascii=False)
    assert "correct_option_id" not in json.dumps(course, ensure_ascii=False)

    stored = database.one(
        "SELECT correct_option_id FROM learning_assessments WHERE id=?",
        (main["assessmentId"],),
    )
    assert stored is not None
    assert stored["correct_option_id"]


def test_course_sync_is_idempotent_and_rejects_changed_frozen_input(database):
    core = _core(database)
    point_ids = _seed_points(database)

    first = _sync(core, point_ids)
    second = _sync(core, point_ids)

    assert second == first
    assert database.scalar("SELECT COUNT(*) FROM learning_courses") == 1
    with pytest.raises(CoreProblem, match="LEARNING_COURSE_CONFLICT"):
        core.sync_learning_course(
            {
                "clientBookId": "book-nist-five-features",
                "title": "被静默修改的标题",
                "knowledgePointIds": list(reversed(point_ids)),
            }
        )


@pytest.mark.parametrize(
    "invalid_ids",
    ([{}], [[]], [True], ["kp_" + "1" * 20, {}]),
)
def test_course_sync_rejects_non_string_point_ids_as_invalid_params(database, invalid_ids):
    core = _core(database)

    with pytest.raises(CoreProblem) as caught:
        core.sync_learning_course(
            {
                "clientBookId": "book-invalid-selection",
                "title": "无效学习书",
                "knowledgePointIds": invalid_ids,
            }
        )

    assert caught.value.code == "INVALID_PARAMS"


def test_course_sync_rejects_a_point_without_a_real_evidence_quote(database):
    core = _core(database)
    point_ids = _seed_points(database)
    with database.write_transaction() as con:
        con.execute(
            "DELETE FROM knowledge_point_evidence WHERE knowledge_point_id=?",
            (point_ids[0],),
        )

    with pytest.raises(CoreProblem) as caught:
        _sync(core, point_ids)

    assert caught.value.code == "EVIDENCE_NOT_FOUND"
    assert database.scalar("SELECT COUNT(*) FROM learning_courses") == 0


def test_course_delete_cascades_learning_graph_and_is_idempotent(database):
    core = _core(database)
    point_ids = _seed_points(database)
    course = _sync(core, point_ids)
    main = _find_assessment(course, 0, "main")
    option = main["options"][0]
    core.submit_learning_attempt(
        {
            "assessmentId": main["assessmentId"],
            "optionId": option["optionId"],
            "idempotencyKey": "idem_" + "d" * 20,
        }
    )

    expected = {"courseId": course["courseId"], "deleted": True}
    assert core.delete_learning_course({"courseId": course["courseId"]}) == expected
    assert core.delete_learning_course({"courseId": course["courseId"]}) == expected
    for table in (
        "learning_courses",
        "learning_units",
        "learning_assessments",
        "learning_attempts",
        "learning_mastery_states",
    ):
        assert database.scalar(f"SELECT COUNT(*) FROM {table}") == 0


@pytest.mark.parametrize(
    ("params", "expected_code"),
    (
        ({"courseId": "course_" + "a" * 20, "extra": True}, "INVALID_PARAMS"),
        ({"courseId": "course_bad"}, "INVALID_IDENTIFIER"),
    ),
)
def test_course_delete_rejects_invalid_params(database, params, expected_code):
    core = _core(database)

    with pytest.raises(CoreProblem) as caught:
        core.delete_learning_course(params)

    assert caught.value.code == expected_code


def test_real_attempt_drives_remediation_retest_mastery_and_is_idempotent(database):
    core = _core(database)
    point_ids = _seed_points(database)
    course = _sync(core, point_ids)
    main = _find_assessment(course, 0, "main")
    main_options = main["options"]
    assert isinstance(main_options, list)
    wrong = next(option for option in main_options if option["label"].startswith("计算资源"))

    failed = core.submit_learning_attempt(
        {
            "assessmentId": main["assessmentId"],
            "optionId": wrong["optionId"],
            "idempotencyKey": "idem_" + "a" * 20,
        }
    )
    assert failed["attempt"]["correct"] is False
    assert failed["course"]["units"][0]["check"]["main"]["attempt"] == {
        "selectedOptionId": wrong["optionId"],
        "correct": False,
        "submittedAt": failed["attempt"]["submittedAt"],
    }
    assert failed["course"]["units"][0]["mastery"] == {
        "status": "remediation_required",
        "strength": 20,
        "dueAt": None,
    }

    repeated = core.submit_learning_attempt(
        {
            "assessmentId": main["assessmentId"],
            "optionId": wrong["optionId"],
            "idempotencyKey": "idem_" + "a" * 20,
        }
    )
    assert repeated == failed
    assert database.scalar("SELECT COUNT(*) FROM learning_attempts") == 1

    correct_main = database.one(
        "SELECT correct_option_id FROM learning_assessments WHERE id=?",
        (main["assessmentId"],),
    )["correct_option_id"]
    with pytest.raises(CoreProblem, match="LEARNING_STATE_CONFLICT"):
        core.submit_learning_attempt(
            {
                "assessmentId": main["assessmentId"],
                "optionId": correct_main,
                "idempotencyKey": "idem_" + "d" * 20,
            }
        )

    retest = _find_assessment(failed["course"], 0, "retest")
    private_key = database.one(
        "SELECT correct_option_id FROM learning_assessments WHERE id=?",
        (retest["assessmentId"],),
    )["correct_option_id"]
    passed = core.submit_learning_attempt(
        {
            "assessmentId": retest["assessmentId"],
            "optionId": private_key,
            "idempotencyKey": "idem_" + "b" * 20,
        }
    )

    assert passed["attempt"]["correct"] is True
    mastery = passed["course"]["units"][0]["mastery"]
    assert mastery["status"] == "mastered_after_remediation"
    assert mastery["strength"] == 70
    assert mastery["dueAt"] is not None
    assert passed["course"]["progress"] == {"completed": 1, "total": 2, "mastery": 35}


def test_retest_is_rejected_until_main_assessment_has_failed(database):
    core = _core(database)
    point_ids = _seed_points(database)
    course = _sync(core, point_ids)
    retest = _find_assessment(course, 0, "retest")
    option = retest["options"][0]

    with pytest.raises(CoreProblem, match="LEARNING_STATE_CONFLICT"):
        core.submit_learning_attempt(
            {
                "assessmentId": retest["assessmentId"],
                "optionId": option["optionId"],
                "idempotencyKey": "idem_" + "c" * 20,
            }
        )
