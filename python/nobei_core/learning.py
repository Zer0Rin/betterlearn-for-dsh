"""Source-bound objective learning units and persisted mastery transactions."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from nobei_core.errors import CoreProblem
from nobei_core.ids import new_opaque_id, require_idempotency_key, require_opaque_id


_BOOK_ID = re.compile(r"book-[a-z0-9-]{1,123}\Z")
_MASTERY_COMPLETE = frozenset({"mastered", "mastered_after_remediation"})
_SUPPLEMENT = {
    "concept": "把这个概念拆成定义、成立条件和边界；遇到新例子时逐项核对。",
    "process": "沿步骤检查输入、动作和结果，避免只记住流程名称。",
    "comparison": "先确定比较维度，再判断差异适用于什么条件。",
    "formula": "把符号、适用条件和变量关系一起理解，再代入计算。",
    "fact": "事实结论要和出处一起记忆，避免把相近表述混为同一事实。",
    "code": "把代码的输入、关键语句和输出变化连起来，不只记最终结果。",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _digest(value: object) -> str:
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def _require_text(value: object, *, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= maximum
        or any(0xD800 <= ord(character) <= 0xDFFF for character in value)
    ):
        raise CoreProblem("INVALID_PARAMS", "learning text is invalid")
    return value


def _require_sync(params: object) -> tuple[str, str, list[str]]:
    if not isinstance(params, dict) or frozenset(params) != frozenset(
        {"clientBookId", "title", "knowledgePointIds"}
    ):
        raise CoreProblem("INVALID_PARAMS", "learning course parameters are invalid")
    client_book_id = params["clientBookId"]
    if not isinstance(client_book_id, str) or _BOOK_ID.fullmatch(client_book_id) is None:
        raise CoreProblem("INVALID_PARAMS", "learning book identifier is invalid")
    title = _require_text(params["title"], maximum=160)
    raw_ids = params["knowledgePointIds"]
    if (
        not isinstance(raw_ids, list)
        or not 1 <= len(raw_ids) <= 100
        or len(set(raw_ids)) != len(raw_ids)
    ):
        raise CoreProblem("INVALID_PARAMS", "learning knowledge point selection is invalid")
    point_ids = [require_opaque_id(value, "kp") for value in raw_ids]
    return client_book_id, title, point_ids


def _load_point(connection, knowledge_point_id: str) -> dict[str, Any]:
    row = connection.execute(
        "SELECT id,document_id,type,title,statement FROM knowledge_points "
        "WHERE id=? AND status='confirmed'",
        (knowledge_point_id,),
    ).fetchone()
    if row is None:
        raise CoreProblem("LEARNING_COURSE_NOT_FOUND", "selected knowledge point is unavailable")
    point = dict(row)
    point["evidence"] = [dict(item) for item in connection.execute(
        "SELECT seq,quote,text_start,text_end,context_before,context_after "
        "FROM knowledge_point_evidence WHERE knowledge_point_id=? ORDER BY seq",
        (knowledge_point_id,),
    ).fetchall()]
    return point


def _option_id(assessment_id: str, source: str) -> str:
    value = hashlib.sha256(f"{assessment_id}\0{source}".encode("utf-8")).hexdigest()[:20]
    return f"opt_{value}"


def _stable_order(assessment_id: str, options: list[dict[str, str]]) -> list[dict[str, str]]:
    return sorted(
        options,
        key=lambda option: hashlib.sha256(
            f"{assessment_id}\0{option['optionId']}".encode("utf-8")
        ).hexdigest(),
    )


def _distinct_labels(current_index: int, units: list[dict[str, Any]], field: str) -> list[str]:
    labels: list[str] = []
    for offset in range(1, len(units)):
        candidate = units[(current_index + offset) % len(units)]
        if field == "statement":
            label = str(candidate["statement"])
        else:
            evidence = candidate["evidence"]
            if not evidence:
                continue
            label = str(evidence[0]["quote"])
        if label not in labels:
            labels.append(label)
        if len(labels) == 3:
            break
    return labels


def _assessment_options(
    *, assessment_id: str, correct_label: str, distractors: list[str], fallback: str
) -> tuple[list[dict[str, str]], str]:
    labels = [correct_label]
    for label in distractors:
        if label not in labels:
            labels.append(label)
    if len(labels) == 1:
        labels.append(fallback)
    options = [
        {"optionId": _option_id(assessment_id, label), "label": label}
        for label in labels[:4]
    ]
    correct_id = options[0]["optionId"]
    return _stable_order(assessment_id, options), correct_id


def _insert_assessments(connection, unit: dict[str, Any], units: list[dict[str, Any]], index: int, created_at: str) -> None:
    evidence = unit["evidence"]
    evidence_label = (
        str(evidence[0]["quote"])
        if evidence
        else f"已确认陈述：{unit['statement']}"
    )
    remediation_title = f"重新核对“{unit['title']}”"
    remediation_body = (
        f"先读已确认结论：“{unit['statement']}”再回到原文：“{evidence_label}”。"
        "比较两者描述的对象、关系与成立条件，然后完成证据复测。"
    )
    for kind in ("claim_choice", "evidence_choice"):
        assessment_id = new_opaque_id("asm")
        if kind == "claim_choice":
            prompt = f"以下哪一项准确说明“{unit['title']}”？"
            correct_label = str(unit["statement"])
            distractors = _distinct_labels(index, units, "statement")
            fallback = f"“{unit['title']}”只是一个名称，材料没有给出可核对的陈述。"
        else:
            prompt = f"以下哪段原文最直接支持：{unit['statement']}"
            correct_label = evidence_label
            distractors = _distinct_labels(index, units, "evidence")
            fallback = f"材料没有提供与“{unit['title']}”相关的原文依据。"
        options, correct_id = _assessment_options(
            assessment_id=assessment_id,
            correct_label=correct_label,
            distractors=distractors,
            fallback=fallback,
        )
        connection.execute(
            "INSERT INTO learning_assessments(id,unit_id,kind,prompt,options_json,"
            "correct_option_id,remediation_title,remediation_body,created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (
                assessment_id,
                unit["unit_id"],
                kind,
                prompt,
                _json(options),
                correct_id,
                remediation_title,
                remediation_body,
                created_at,
            ),
        )


def sync_course(connection, params: object) -> str:
    client_book_id, title, point_ids = _require_sync(params)
    source_ids_json = _json(point_ids)
    source_digest = _digest({"title": title, "knowledgePointIds": point_ids})
    existing = connection.execute(
        "SELECT id,title,source_ids_json,source_digest FROM learning_courses WHERE client_book_id=?",
        (client_book_id,),
    ).fetchone()
    if existing is not None:
        if (
            existing["title"] != title
            or existing["source_ids_json"] != source_ids_json
            or existing["source_digest"] != source_digest
        ):
            raise CoreProblem("LEARNING_COURSE_CONFLICT", "learning course source is already frozen")
        return str(existing["id"])

    points = [_load_point(connection, point_id) for point_id in point_ids]
    course_id = new_opaque_id("course")
    created_at = _iso(_now())
    connection.execute(
        "INSERT INTO learning_courses(id,client_book_id,title,source_ids_json,source_digest,status,"
        "created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)",
        (course_id, client_book_id, title, source_ids_json, source_digest, created_at, created_at),
    )
    units: list[dict[str, Any]] = []
    for ordinal, point in enumerate(points):
        unit_id = new_opaque_id("unit")
        unit = {**point, "unit_id": unit_id}
        units.append(unit)
        connection.execute(
            "INSERT INTO learning_units(id,course_id,ordinal,source_knowledge_point_id,"
            "source_document_id,point_type,title,statement,evidence_json,created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (
                unit_id,
                course_id,
                ordinal,
                point["id"],
                point["document_id"],
                point["type"],
                point["title"],
                point["statement"],
                _json(point["evidence"]),
                created_at,
            ),
        )
        connection.execute(
            "INSERT INTO learning_mastery_states(unit_id,course_id,status,strength,updated_at) "
            "VALUES(?,?,'new',0,?)",
            (unit_id, course_id, created_at),
        )
    for index, unit in enumerate(units):
        _insert_assessments(connection, unit, units, index, created_at)
    return course_id


def _latest_attempt(connection, assessment_id: str) -> dict[str, object] | None:
    row = connection.execute(
        "SELECT selected_option_id,correct,created_at FROM learning_attempts "
        "WHERE assessment_id=? ORDER BY rowid DESC LIMIT 1",
        (assessment_id,),
    ).fetchone()
    if row is None:
        return None
    return {
        "selectedOptionId": row["selected_option_id"],
        "correct": bool(row["correct"]),
        "submittedAt": row["created_at"],
    }


def _public_assessment(connection, row: dict[str, Any]) -> dict[str, object]:
    return {
        "assessmentId": row["id"],
        "kind": row["kind"],
        "prompt": row["prompt"],
        "options": json.loads(row["options_json"]),
        "attempt": _latest_attempt(connection, str(row["id"])),
    }


def course_snapshot(connection, course_id: str) -> dict[str, object]:
    course_id = require_opaque_id(course_id, "course")
    course = connection.execute(
        "SELECT * FROM learning_courses WHERE id=?", (course_id,)
    ).fetchone()
    if course is None:
        raise CoreProblem("LEARNING_COURSE_NOT_FOUND", "learning course does not exist")
    units: list[dict[str, object]] = []
    rows = connection.execute(
        "SELECT u.*,m.status AS mastery_status,m.strength,m.due_at "
        "FROM learning_units u JOIN learning_mastery_states m ON m.unit_id=u.id "
        "WHERE u.course_id=? ORDER BY u.ordinal",
        (course_id,),
    ).fetchall()
    for row in rows:
        item = dict(row)
        evidence = json.loads(item["evidence_json"])
        assessments = {
            assessment["kind"]: dict(assessment)
            for assessment in connection.execute(
                "SELECT * FROM learning_assessments WHERE unit_id=?", (item["id"],)
            ).fetchall()
        }
        main = assessments["claim_choice"]
        retest = assessments["evidence_choice"]
        first_evidence = evidence[0] if evidence else None
        units.append(
            {
                "unitId": item["id"],
                "knowledgePointId": item["source_knowledge_point_id"],
                "type": item["point_type"],
                "title": item["title"],
                "objective": f"能够准确解释{item['title']}，并从原文中定位支持证据。",
                "lesson": {
                    "explanation": item["statement"],
                    "workedExample": (
                        f"原文写道：“{first_evidence['quote']}”。把这段原文与结论"
                        f"“{item['statement']}”逐项对应。"
                        if first_evidence
                        else f"当前只保留已确认陈述：“{item['statement']}”。"
                    ),
                    "supplemental": _SUPPLEMENT[str(item["point_type"])],
                },
                "evidence": (
                    {
                        "kind": "quote",
                        "quote": first_evidence["quote"],
                        "contextBefore": first_evidence["context_before"],
                        "contextAfter": first_evidence["context_after"],
                        "textStart": first_evidence["text_start"],
                        "textEnd": first_evidence["text_end"],
                    }
                    if first_evidence
                    else {"kind": "summary", "text": "当前知识点没有可定位的原文引用。"}
                ),
                "mastery": {
                    "status": item["mastery_status"],
                    "strength": item["strength"],
                    "dueAt": item["due_at"],
                },
                "check": {
                    "main": _public_assessment(connection, main),
                    "remediation": {
                        "title": main["remediation_title"],
                        "body": main["remediation_body"],
                    },
                    "retest": _public_assessment(connection, retest),
                },
            }
        )
    completed = sum(1 for unit in units if unit["mastery"]["status"] in _MASTERY_COMPLETE)
    mastery = round(sum(int(unit["mastery"]["strength"]) for unit in units) / len(units)) if units else 0
    return {
        "courseId": course["id"],
        "clientBookId": course["client_book_id"],
        "title": course["title"],
        "status": course["status"],
        "progress": {"completed": completed, "total": len(units), "mastery": mastery},
        "units": units,
    }


def submit_attempt(connection, params: object) -> dict[str, object]:
    if not isinstance(params, dict) or frozenset(params) != frozenset(
        {"assessmentId", "optionId", "idempotencyKey"}
    ):
        raise CoreProblem("INVALID_PARAMS", "learning attempt parameters are invalid")
    assessment_id = require_opaque_id(params["assessmentId"], "asm")
    option_id = _require_text(params["optionId"], maximum=80)
    idempotency_key = require_idempotency_key(params["idempotencyKey"])
    request_digest = _digest({"assessmentId": assessment_id, "optionId": option_id})
    replay = connection.execute(
        "SELECT request_digest,result_json FROM learning_attempts WHERE idempotency_key=?",
        (idempotency_key,),
    ).fetchone()
    if replay is not None:
        if replay["request_digest"] != request_digest:
            raise CoreProblem("IDEMPOTENCY_CONFLICT", "learning attempt key was reused")
        return json.loads(replay["result_json"])

    assessment = connection.execute(
        "SELECT a.*,u.course_id,m.status AS mastery_status "
        "FROM learning_assessments a JOIN learning_units u ON u.id=a.unit_id "
        "JOIN learning_mastery_states m ON m.unit_id=u.id WHERE a.id=?",
        (assessment_id,),
    ).fetchone()
    if assessment is None:
        raise CoreProblem("LEARNING_ASSESSMENT_NOT_FOUND", "learning assessment does not exist")
    options = json.loads(assessment["options_json"])
    if option_id not in {item["optionId"] for item in options}:
        raise CoreProblem("INVALID_PARAMS", "learning option is invalid")
    if assessment["kind"] == "evidence_choice" and assessment["mastery_status"] not in (
        "remediation_required", "learning"
    ):
        raise CoreProblem("LEARNING_STATE_CONFLICT", "retest is not available")
    if assessment["kind"] == "claim_choice" and assessment["mastery_status"] != "new":
        raise CoreProblem("LEARNING_STATE_CONFLICT", "main assessment is already settled")

    correct = option_id == assessment["correct_option_id"]
    now = _now()
    created_at = _iso(now)
    if assessment["kind"] == "claim_choice":
        status = "mastered" if correct else "remediation_required"
        strength = 100 if correct else 20
        due_at = _iso(now + timedelta(days=3)) if correct else None
        counter = "main_attempts"
    else:
        status = "mastered_after_remediation" if correct else "learning"
        strength = 70 if correct else 20
        due_at = _iso(now + timedelta(days=1)) if correct else None
        counter = "retest_attempts"
    connection.execute(
        f"UPDATE learning_mastery_states SET status=?,strength=?,{counter}={counter}+1,"
        "last_correct=?,due_at=?,updated_at=? WHERE unit_id=?",
        (status, strength, int(correct), due_at, created_at, assessment["unit_id"]),
    )
    attempt_id = new_opaque_id("latt")
    connection.execute(
        "INSERT INTO learning_attempts(id,assessment_id,idempotency_key,request_digest,"
        "selected_option_id,correct,result_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
        (
            attempt_id,
            assessment_id,
            idempotency_key,
            request_digest,
            option_id,
            int(correct),
            "{}",
            created_at,
        ),
    )
    result = {
        "attempt": {
            "attemptId": attempt_id,
            "assessmentId": assessment_id,
            "selectedOptionId": option_id,
            "correct": correct,
            "submittedAt": created_at,
        },
        "course": course_snapshot(connection, str(assessment["course_id"])),
    }
    result_json = _json(result)
    connection.execute(
        "UPDATE learning_attempts SET result_json=? WHERE id=?",
        (result_json, attempt_id),
    )
    return json.loads(result_json)
