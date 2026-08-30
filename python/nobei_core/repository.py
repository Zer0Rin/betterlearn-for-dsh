"""Parameterized persistence helpers for Phase 1 run state and events."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any, ContextManager, Protocol

from nobei_core.constants import (
    ALLOWED_TRANSITIONS,
    CANDIDATE_MAX_COUNT,
    CANDIDATE_REVIEW_STATUSES,
    CANDIDATE_TYPES,
    COMPLETION_REASONS,
    CONFIRMATION_ACTIONS,
    EVENT_TYPES,
    FIXTURE_COURSE_ID,
    GENERATION_RETRYABILITY,
    JOB_PROJECTION,
    MAX_EVENT_PAYLOAD_BYTES,
)
from nobei_core.errors import CoreProblem
from nobei_core.ids import new_opaque_id, require_opaque_id


_EVENT_PAYLOAD_FIELDS = {
    "run.created": frozenset({"runId"}),
    "document.ready": frozenset({"documentId"}),
    "generation.awaiting": frozenset({"retryCount"}),
    "generation.started": frozenset({"attemptId", "attemptNumber"}),
    "generation.validating": frozenset({"attemptId"}),
    "generation.failed": frozenset({"attemptId", "code", "retryable"}),
    "generation.interrupted": frozenset({"reason"}),
    "generation.retry_requested": frozenset({"retryCount"}),
    "candidates.ready": frozenset({"rawCandidateCount", "validCandidateCount"}),
    "candidate.accepted": frozenset({"candidateId"}),
    "candidate.edited_and_accepted": frozenset({"candidateId"}),
    "candidate.rejected": frozenset({"candidateId"}),
    "run.completed": frozenset({"reason"}),
}
_JOB_STAGES = frozenset(stage for stage, _ in JOB_PROJECTION.values())


class _SingleRowReader(Protocol):
    def one(self, sql: str, parameters: tuple[Any, ...] = ()) -> dict[str, Any] | None: ...


class _TransactionalDatabase(Protocol):
    def write_transaction(self) -> ContextManager[sqlite3.Connection]: ...


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _one(
    source: sqlite3.Connection | _SingleRowReader,
    sql: str,
    parameters: tuple[Any, ...],
) -> dict[str, Any] | None:
    if isinstance(source, sqlite3.Connection):
        row = source.execute(sql, parameters).fetchone()
        return dict(row) if row is not None else None
    return source.one(sql, parameters)


def require_run(source: sqlite3.Connection | _SingleRowReader, run_id: str) -> dict[str, Any]:
    require_opaque_id(run_id, "job")
    row = _one(source, "SELECT * FROM p1_run_control WHERE job_id=?", (run_id,))
    if row is None:
        raise CoreProblem("INVALID_IDENTIFIER", "run does not exist")
    return row


def assert_projection(source: sqlite3.Connection | _SingleRowReader, row: dict[str, Any]) -> None:
    expected = JOB_PROJECTION.get(row["status"])
    projection = _one(source, "SELECT stage,status FROM import_jobs WHERE id=?", (row["job_id"],))
    if (
        expected is None
        or row["stage"] != expected[0]
        or projection is None
        or projection["stage"] != expected[0]
        or projection["status"] != expected[1]
    ):
        raise CoreProblem("DERIVED_STATE_MISMATCH", "run projection does not match control state")


def _validate_event_payload(event_type: str, payload: dict[str, Any]) -> None:
    if event_type not in EVENT_TYPES or event_type not in _EVENT_PAYLOAD_FIELDS:
        raise CoreProblem("INVALID_PARAMS", "event type has no payload serializer")
    if not isinstance(payload, dict) or frozenset(payload) != _EVENT_PAYLOAD_FIELDS[event_type]:
        raise CoreProblem("INVALID_PARAMS", "event payload fields are invalid")

    if event_type == "run.created":
        require_opaque_id(payload["runId"], "job")
    elif event_type == "document.ready":
        require_opaque_id(payload["documentId"], "doc")
    elif event_type == "generation.awaiting":
        if type(payload["retryCount"]) is not int or payload["retryCount"] not in (0, 1):
            raise CoreProblem("INVALID_PARAMS", "retry count is invalid")
    elif event_type == "generation.started":
        require_opaque_id(payload["attemptId"], "att")
        if type(payload["attemptNumber"]) is not int or payload["attemptNumber"] not in (1, 2):
            raise CoreProblem("INVALID_PARAMS", "attempt number is invalid")
    elif event_type == "generation.validating":
        require_opaque_id(payload["attemptId"], "att")
    elif event_type == "generation.failed":
        require_opaque_id(payload["attemptId"], "att")
        if (
            not isinstance(payload["code"], str)
            or payload["code"] not in GENERATION_RETRYABILITY
            or type(payload["retryable"]) is not bool
        ):
            raise CoreProblem("INVALID_PARAMS", "generation failure payload is invalid")
    elif event_type == "generation.interrupted":
        if payload["reason"] != "core_interrupted":
            raise CoreProblem("INVALID_PARAMS", "interruption reason is invalid")
    elif event_type == "generation.retry_requested":
        if type(payload["retryCount"]) is not int or payload["retryCount"] != 1:
            raise CoreProblem("INVALID_PARAMS", "retry count is invalid")
    elif event_type == "candidates.ready":
        raw_count = payload["rawCandidateCount"]
        valid_count = payload["validCandidateCount"]
        if (
            type(raw_count) is not int
            or type(valid_count) is not int
            or not 0 <= valid_count <= raw_count <= CANDIDATE_MAX_COUNT
        ):
            raise CoreProblem("INVALID_PARAMS", "candidate counts are invalid")
    elif event_type in (
        "candidate.accepted",
        "candidate.edited_and_accepted",
        "candidate.rejected",
    ):
        require_opaque_id(payload["candidateId"], "cand")
    elif event_type == "run.completed":
        if payload["reason"] not in COMPLETION_REASONS:
            raise CoreProblem("INVALID_PARAMS", "completion reason is invalid")


def _encode_event_payload(event_type: str, payload: dict[str, Any]) -> str:
    _validate_event_payload(event_type, payload)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    actual_bytes = len(encoded.encode("utf-8"))
    if actual_bytes > MAX_EVENT_PAYLOAD_BYTES:
        raise CoreProblem(
            "REQUEST_TOO_LARGE",
            "event payload exceeds byte limit",
            {"actualBytes": actual_bytes, "maxBytes": MAX_EVENT_PAYLOAD_BYTES},
        )
    return encoded


def append_event(
    con: sqlite3.Connection,
    run_id: str,
    event_type: str,
    stage: str,
    payload: dict[str, Any],
    *,
    created_at: str | None = None,
) -> dict[str, Any]:
    if stage not in _JOB_STAGES:
        raise CoreProblem("INVALID_PARAMS", "event stage is invalid")
    payload_json = _encode_event_payload(event_type, payload)
    require_run(con, run_id)
    row = con.execute(
        "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM p1_run_events WHERE job_id=?",
        (run_id,),
    ).fetchone()
    seq = int(row["seq"])
    event_created_at = now_iso() if created_at is None else created_at
    con.execute(
        "INSERT INTO p1_run_events(job_id,seq,type,stage,payload_json,created_at) "
        "VALUES(?,?,?,?,?,?)",
        (run_id, seq, event_type, stage, payload_json, event_created_at),
    )
    return {
        "seq": seq,
        "type": event_type,
        "stage": stage,
        "payload": dict(payload),
        "created_at": event_created_at,
    }


def transition_run(
    con: sqlite3.Connection,
    run_id: str,
    expected: str,
    target: str,
    event_type: str,
    payload: dict[str, Any],
    *,
    transitioned_at: str | None = None,
) -> dict[str, Any]:
    if expected not in ALLOWED_TRANSITIONS or target not in ALLOWED_TRANSITIONS[expected]:
        raise CoreProblem("RUN_STATE_CONFLICT", "invalid run transition")
    row = require_run(con, run_id)
    if row["status"] != expected:
        raise CoreProblem("RUN_STATE_CONFLICT", "run state changed")
    assert_projection(con, row)
    stage, job_status = JOB_PROJECTION[target]
    revision = row["revision"] + 1
    transition_time = now_iso() if transitioned_at is None else transitioned_at
    changed = con.execute(
        "UPDATE p1_run_control SET status=?,stage=?,revision=?,updated_at=? "
        "WHERE job_id=? AND status=? AND revision=?",
        (target, stage, revision, transition_time, run_id, expected, row["revision"]),
    ).rowcount
    if changed != 1:
        raise CoreProblem("RUN_STATE_CONFLICT", "run state changed")
    projected = con.execute(
        "UPDATE import_jobs SET stage=?,status=?,updated_at=? WHERE id=?",
        (stage, job_status, transition_time, run_id),
    ).rowcount
    if projected != 1:
        raise CoreProblem("DERIVED_STATE_MISMATCH", "run projection is missing")
    append_event(con, run_id, event_type, stage, payload, created_at=transition_time)
    return require_run(con, run_id)


def insert_generation_attempt(
    con: sqlite3.Connection,
    *,
    attempt_id: str,
    run_id: str,
    attempt_number: int,
    request_digest: str,
    provider_idempotency_key: str,
    model_metadata_json: str,
) -> None:
    con.execute(
        "INSERT INTO p1_generation_attempts("
        "id,job_id,attempt_number,request_digest,provider_idempotency_key,"
        "model_metadata_json,status,created_at"
        ") VALUES(?,?,?,?,?,?,'started',?)",
        (
            attempt_id,
            run_id,
            attempt_number,
            request_digest,
            provider_idempotency_key,
            model_metadata_json,
            now_iso(),
        ),
    )


def require_current_attempt(con: sqlite3.Connection, run_id: str) -> dict[str, Any]:
    row = con.execute(
        "SELECT * FROM p1_generation_attempts WHERE job_id=? "
        "ORDER BY attempt_number DESC LIMIT 1",
        (run_id,),
    ).fetchone()
    if row is None:
        raise CoreProblem("ATTEMPT_MISMATCH", "run has no current generation attempt")
    return dict(row)


def mark_attempt_failed(
    con: sqlite3.Connection,
    *,
    attempt_id: str,
    run_id: str,
    error_code: str,
    raw_output_json: str | None = None,
) -> None:
    if raw_output_json is None:
        changed = con.execute(
            "UPDATE p1_generation_attempts "
            "SET status='failed',error_code=?,completed_at=? "
            "WHERE id=? AND job_id=? AND status='started'",
            (error_code, now_iso(), attempt_id, run_id),
        ).rowcount
    else:
        changed = con.execute(
            "UPDATE p1_generation_attempts "
            "SET status='failed',error_code=?,raw_output_json=?,"
            "completed_at=? "
            "WHERE id=? AND job_id=? AND status='started'",
            (
                error_code,
                raw_output_json,
                now_iso(),
                attempt_id,
                run_id,
            ),
        ).rowcount
    if changed != 1:
        raise CoreProblem("ATTEMPT_MISMATCH", "generation attempt is not current")


def mark_attempt_succeeded(
    con: sqlite3.Connection,
    *,
    attempt_id: str,
    run_id: str,
    raw_output_json: str,
) -> None:
    changed = con.execute(
        "UPDATE p1_generation_attempts "
        "SET status='succeeded',error_code=NULL,raw_output_json=?,"
        "completed_at=? WHERE id=? AND job_id=? AND status='started'",
        (raw_output_json, now_iso(), attempt_id, run_id),
    ).rowcount
    if changed != 1:
        raise CoreProblem("ATTEMPT_MISMATCH", "generation attempt is not current")


def update_generation_statistics(
    con: sqlite3.Connection,
    *,
    run_id: str,
    expected_revision: int,
    raw_candidate_count: int,
    schema_valid_evidence_count: int,
    exact_evidence_count: int,
    valid_candidate_count: int,
    rejection_counts: dict[str, int],
) -> None:
    counts = (
        raw_candidate_count,
        schema_valid_evidence_count,
        exact_evidence_count,
        valid_candidate_count,
    )
    if (
        any(type(count) is not int or count < 0 for count in counts)
        or raw_candidate_count > CANDIDATE_MAX_COUNT
        or valid_candidate_count > raw_candidate_count
        or exact_evidence_count > schema_valid_evidence_count
        or not isinstance(rejection_counts, dict)
        or any(
            code not in ("EVIDENCE_NOT_FOUND", "EVIDENCE_AMBIGUOUS")
            or type(count) is not int
            or count <= 0
            for code, count in rejection_counts.items()
        )
        or sum(rejection_counts.values())
        != schema_valid_evidence_count - exact_evidence_count
    ):
        raise CoreProblem("TRANSACTION_FAILED", "generation statistics are invalid")
    rejection_counts_json = json.dumps(
        rejection_counts, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    completed_at = now_iso() if valid_candidate_count == 0 else None
    changed = con.execute(
        "UPDATE p1_run_control SET raw_candidate_count=?,schema_valid_evidence_count=?,"
        "exact_evidence_count=?,rejection_counts_json=?,completed_at=?,updated_at=? "
        "WHERE job_id=? AND status='validating' AND revision=?",
        (
            raw_candidate_count,
            schema_valid_evidence_count,
            exact_evidence_count,
            rejection_counts_json,
            completed_at,
            now_iso(),
            run_id,
            expected_revision,
        ),
    ).rowcount
    if changed != 1:
        raise CoreProblem("RUN_STATE_CONFLICT", "run state changed")


def insert_candidate(
    con: sqlite3.Connection,
    *,
    candidate_id: str,
    run_id: str,
    ordinal: int,
    candidate_type: str,
    title: str,
    statement: str,
    evidence: list[dict[str, object]],
) -> None:
    require_opaque_id(candidate_id, "cand")
    require_opaque_id(run_id, "job")
    created_at = now_iso()
    con.execute(
        "INSERT INTO p1_candidates(id,job_id,ordinal,type,title,statement,created_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (candidate_id, run_id, ordinal, candidate_type, title, statement, created_at),
    )
    for item in evidence:
        con.execute(
            "INSERT INTO p1_candidate_evidence("
            "candidate_id,seq,quote,text_start,text_end,context_before,context_after"
            ") VALUES(?,?,?,?,?,?,?)",
            (
                candidate_id,
                item["seq"],
                item["quote"],
                item["text_start"],
                item["text_end"],
                item["context_before"],
                item["context_after"],
            ),
        )


def require_candidate(con: sqlite3.Connection, candidate_id: str) -> dict[str, Any]:
    require_opaque_id(candidate_id, "cand")
    stored = con.execute(
        "SELECT id,job_id,ordinal,type,title,statement,review_status,revision,"
        "accepted_kp_id,created_at,reviewed_at FROM p1_candidates WHERE id=?",
        (candidate_id,),
    ).fetchone()
    if stored is None:
        raise CoreProblem("INVALID_IDENTIFIER", "candidate does not exist")
    return dict(stored)


def candidate_evidence(
    con: sqlite3.Connection, candidate_id: str
) -> list[dict[str, Any]]:
    require_opaque_id(candidate_id, "cand")
    rows = con.execute(
        "SELECT seq,quote,text_start,text_end,context_before,context_after "
        "FROM p1_candidate_evidence WHERE candidate_id=? ORDER BY seq",
        (candidate_id,),
    ).fetchall()
    if not 1 <= len(rows) <= 3:
        raise CoreProblem("DERIVED_STATE_MISMATCH", "candidate evidence is invalid")
    evidence = [dict(row) for row in rows]
    sequences = [item["seq"] for item in evidence]
    if any(type(seq) is not int or not 0 <= seq <= 2 for seq in sequences):
        raise CoreProblem("DERIVED_STATE_MISMATCH", "candidate evidence order is invalid")
    return evidence


def run_snapshot_counts(con: sqlite3.Connection, run_id: str) -> dict[str, int]:
    """Read the authoritative candidate and formal-KP counts for one owned run."""
    require_opaque_id(run_id, "job")
    row = con.execute(
        "SELECT COUNT(c.id) AS valid_candidates,"
        "COALESCE(SUM(CASE WHEN c.review_status='pending' THEN 1 ELSE 0 END),0) "
        "AS pending,"
        "COALESCE(SUM(CASE WHEN c.review_status='accepted' THEN 1 ELSE 0 END),0) "
        "AS accepted,"
        "COALESCE(SUM(CASE WHEN c.review_status='edited_and_accepted' "
        "THEN 1 ELSE 0 END),0) AS edited_and_accepted,"
        "COALESCE(SUM(CASE WHEN c.review_status='rejected' THEN 1 ELSE 0 END),0) "
        "AS rejected,COUNT(k.id) AS knowledge_points "
        "FROM p1_run_control r "
        "LEFT JOIN p1_candidates c ON c.job_id=r.job_id "
        "LEFT JOIN knowledge_points k ON k.id=c.accepted_kp_id "
        "WHERE r.job_id=?",
        (run_id,),
    ).fetchone()
    if row is None:
        raise CoreProblem("INVALID_IDENTIFIER", "run does not exist")
    return {
        "valid_candidates": int(row["valid_candidates"]),
        "pending": int(row["pending"]),
        "accepted": int(row["accepted"]),
        "edited_and_accepted": int(row["edited_and_accepted"]),
        "rejected": int(row["rejected"]),
        "knowledge_points": int(row["knowledge_points"]),
    }


def run_last_event_seq(con: sqlite3.Connection, run_id: str) -> int:
    require_opaque_id(run_id, "job")
    row = con.execute(
        "SELECT COALESCE(MAX(seq),0) AS last_event_seq FROM p1_run_events WHERE job_id=?",
        (run_id,),
    ).fetchone()
    if row is None:
        raise CoreProblem("DERIVED_STATE_MISMATCH", "run event sequence is invalid")
    return int(row["last_event_seq"])


def read_run_events(
    con: sqlite3.Connection, run_id: str, after: int, limit: int
) -> list[dict[str, Any]]:
    require_opaque_id(run_id, "job")
    rows = con.execute(
        "SELECT seq,type,stage,payload_json FROM p1_run_events "
        "WHERE job_id=? AND seq>? ORDER BY seq ASC LIMIT ?",
        (run_id, after, limit),
    ).fetchall()
    return [
        {
            "seq": row["seq"],
            "type": row["type"],
            "stage": row["stage"],
            "payload_json": row["payload_json"],
        }
        for row in rows
    ]


def read_run_event_ledger(
    con: sqlite3.Connection, run_id: str
) -> list[dict[str, Any]]:
    require_opaque_id(run_id, "job")
    rows = con.execute(
        "SELECT seq,type,stage,payload_json FROM p1_run_events "
        "WHERE job_id=? ORDER BY seq ASC",
        (run_id,),
    ).fetchall()
    return [
        {
            "seq": row["seq"],
            "type": row["type"],
            "stage": row["stage"],
            "payload_json": row["payload_json"],
        }
        for row in rows
    ]


def run_attempt_identity(
    con: sqlite3.Connection, run_id: str, attempt_id: str
) -> dict[str, Any] | None:
    require_opaque_id(run_id, "job")
    require_opaque_id(attempt_id, "att")
    row = con.execute(
        "SELECT attempt_number,status,error_code FROM p1_generation_attempts "
        "WHERE id=? AND job_id=?",
        (attempt_id, run_id),
    ).fetchone()
    if row is None:
        return None
    return {
        "attempt_number": int(row["attempt_number"]),
        "status": row["status"],
        "error_code": row["error_code"],
    }


def latest_run_attempt(
    con: sqlite3.Connection, run_id: str
) -> dict[str, Any] | None:
    require_opaque_id(run_id, "job")
    row = con.execute(
        "SELECT id,attempt_number,status,error_code,request_digest,"
        "provider_idempotency_key,model_metadata_json,"
        "raw_output_json,completed_at "
        "FROM p1_generation_attempts WHERE job_id=? "
        "ORDER BY attempt_number DESC LIMIT 1",
        (run_id,),
    ).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "attempt_number": row["attempt_number"],
        "status": row["status"],
        "error_code": row["error_code"],
        "request_digest": row["request_digest"],
        "provider_idempotency_key": row["provider_idempotency_key"],
        "model_metadata_json": row["model_metadata_json"],
        "raw_output_json": row["raw_output_json"],
        "completed_at": row["completed_at"],
    }


def run_attempt_count(con: sqlite3.Connection, run_id: str) -> int:
    require_opaque_id(run_id, "job")
    row = con.execute(
        "SELECT COUNT(*) AS attempt_count FROM p1_generation_attempts WHERE job_id=?",
        (run_id,),
    ).fetchone()
    if row is None:
        raise CoreProblem("DERIVED_STATE_MISMATCH", "run attempt count is invalid")
    return int(row["attempt_count"])


def run_candidate_evidence_count(con: sqlite3.Connection, run_id: str) -> int:
    require_opaque_id(run_id, "job")
    row = con.execute(
        "SELECT COUNT(e.candidate_id) AS evidence_count FROM p1_candidates c "
        "LEFT JOIN p1_candidate_evidence e ON e.candidate_id=c.id WHERE c.job_id=?",
        (run_id,),
    ).fetchone()
    if row is None:
        raise CoreProblem("DERIVED_STATE_MISMATCH", "run evidence count is invalid")
    return int(row["evidence_count"])


def candidate_run_status(
    con: sqlite3.Connection, run_id: str, candidate_id: str
) -> str | None:
    require_opaque_id(run_id, "job")
    require_opaque_id(candidate_id, "cand")
    row = con.execute(
        "SELECT review_status FROM p1_candidates WHERE id=? AND job_id=?",
        (candidate_id, run_id),
    ).fetchone()
    return str(row["review_status"]) if row is not None else None


def read_run_attempts(
    con: sqlite3.Connection, run_id: str
) -> list[dict[str, Any]]:
    require_opaque_id(run_id, "job")
    rows = con.execute(
        "SELECT id,attempt_number,status,error_code,model_metadata_json,raw_output_json,"
        "completed_at "
        "FROM p1_generation_attempts WHERE job_id=? ORDER BY attempt_number ASC",
        (run_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "attempt_number": row["attempt_number"],
            "status": row["status"],
            "error_code": row["error_code"],
            "model_metadata_json": row["model_metadata_json"],
            "raw_output_json": row["raw_output_json"],
            "completed_at": row["completed_at"],
        }
        for row in rows
    ]


def read_candidate_confirmation_logs(
    con: sqlite3.Connection, candidate_id: str, knowledge_point_id: str | None
) -> list[dict[str, Any]]:
    require_opaque_id(candidate_id, "cand")
    if knowledge_point_id is not None:
        require_opaque_id(knowledge_point_id, "kp")
    subjects = (candidate_id,) if knowledge_point_id is None else (
        candidate_id,
        knowledge_point_id,
    )
    placeholders = ",".join("?" for _item in subjects)
    rows = con.execute(
        "SELECT id,kp_id,support_label,action,edited_fields,merged_into,granularity,"
        "elapsed_sec,confirmed_at FROM kp_confirm_log "
        f"WHERE kp_id IN ({placeholders}) ORDER BY id",
        subjects,
    ).fetchall()
    return [
        {
            "id": row["id"],
            "subject_id": row["kp_id"],
            "support_label": row["support_label"],
            "action": row["action"],
            "edited_fields": row["edited_fields"],
            "merged_into": row["merged_into"],
            "granularity": row["granularity"],
            "elapsed_sec": row["elapsed_sec"],
            "confirmed_at": row["confirmed_at"],
        }
        for row in rows
    ]


def read_candidate_review_events(
    con: sqlite3.Connection, run_id: str, candidate_id: str
) -> list[str]:
    require_opaque_id(run_id, "job")
    require_opaque_id(candidate_id, "cand")
    rows = con.execute(
        "SELECT type,payload_json FROM p1_run_events WHERE job_id=? "
        "AND type IN ('candidate.accepted','candidate.edited_and_accepted',"
        "'candidate.rejected') ORDER BY seq",
        (run_id,),
    ).fetchall()
    matched: list[str] = []
    for row in rows:
        payload = decode_event_payload(str(row["type"]), str(row["payload_json"]))
        if payload["candidateId"] == candidate_id:
            matched.append(str(row["type"]))
    return matched


def decode_event_payload(event_type: str, payload_json: str) -> dict[str, Any]:
    try:
        payload = json.loads(payload_json)
    except (TypeError, json.JSONDecodeError) as exc:
        raise CoreProblem("DERIVED_STATE_MISMATCH", "run event payload is invalid") from exc
    try:
        _validate_event_payload(event_type, payload)
    except CoreProblem as exc:
        raise CoreProblem("DERIVED_STATE_MISMATCH", "run event payload is invalid") from exc
    return {
        field: payload[field]
        for field in sorted(_EVENT_PAYLOAD_FIELDS[event_type])
    }


def read_run_candidates(
    con: sqlite3.Connection, run_id: str
) -> list[dict[str, Any]]:
    require_opaque_id(run_id, "job")
    rows = con.execute(
        "SELECT id,job_id,ordinal,type,title,statement,review_status,revision,"
        "accepted_kp_id,reviewed_at "
        "FROM p1_candidates WHERE job_id=? ORDER BY ordinal ASC,id ASC",
        (run_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "job_id": row["job_id"],
            "ordinal": row["ordinal"],
            "type": row["type"],
            "title": row["title"],
            "statement": row["statement"],
            "review_status": row["review_status"],
            "revision": row["revision"],
            "accepted_kp_id": row["accepted_kp_id"],
            "reviewed_at": row["reviewed_at"],
        }
        for row in rows
    ]


def read_run_knowledge_points(
    con: sqlite3.Connection, run_id: str
) -> list[dict[str, Any]]:
    require_opaque_id(run_id, "job")
    rows = con.execute(
        "SELECT c.ordinal,c.id AS candidate_id,c.type AS candidate_type,"
        "c.title AS candidate_title,c.statement AS candidate_statement,"
        "c.review_status,c.accepted_kp_id,c.reviewed_at AS candidate_reviewed_at,"
        "k.id,k.course_id,k.type,k.title,k.content,k.document_id,k.chunk_id,k.origin,"
        "k.status,k.content_hash,k.created_at,k.updated_at "
        "FROM p1_candidates c "
        "JOIN knowledge_points k ON k.id=c.accepted_kp_id "
        "WHERE c.job_id=? ORDER BY c.ordinal ASC,c.id ASC",
        (run_id,),
    ).fetchall()
    return [
        {
            "ordinal": row["ordinal"],
            "candidate_id": row["candidate_id"],
            "candidate_type": row["candidate_type"],
            "candidate_title": row["candidate_title"],
            "candidate_statement": row["candidate_statement"],
            "review_status": row["review_status"],
            "accepted_kp_id": row["accepted_kp_id"],
            "candidate_reviewed_at": row["candidate_reviewed_at"],
            "id": row["id"],
            "course_id": row["course_id"],
            "type": row["type"],
            "title": row["title"],
            "content": row["content"],
            "document_id": row["document_id"],
            "chunk_id": row["chunk_id"],
            "origin": row["origin"],
            "status": row["status"],
            "content_hash": row["content_hash"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        for row in rows
    ]


def knowledge_point_evidence(
    con: sqlite3.Connection, knowledge_point_id: str
) -> list[dict[str, Any]]:
    require_opaque_id(knowledge_point_id, "kp")
    rows = con.execute(
        "SELECT seq,quote,chunk_id,align_method,locator_confidence,text_start,text_end,"
        "context_before,context_after FROM kp_evidence WHERE kp_id=? ORDER BY seq ASC,id ASC",
        (knowledge_point_id,),
    ).fetchall()
    return [
        {
            "seq": row["seq"],
            "quote": row["quote"],
            "chunk_id": row["chunk_id"],
            "align_method": row["align_method"],
            "locator_confidence": row["locator_confidence"],
            "text_start": row["text_start"],
            "text_end": row["text_end"],
            "context_before": row["context_before"],
            "context_after": row["context_after"],
        }
        for row in rows
    ]


def read_formal_knowledge_point(
    con: sqlite3.Connection, knowledge_point_id: str
) -> dict[str, Any] | None:
    require_opaque_id(knowledge_point_id, "kp")
    row = con.execute(
        "SELECT id,course_id,document_id,chunk_id,type,title,content,origin,status,"
        "content_hash,created_at,updated_at FROM knowledge_points WHERE id=?",
        (knowledge_point_id,),
    ).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "course_id": row["course_id"],
        "document_id": row["document_id"],
        "chunk_id": row["chunk_id"],
        "type": row["type"],
        "title": row["title"],
        "content": row["content"],
        "origin": row["origin"],
        "status": row["status"],
        "content_hash": row["content_hash"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def latest_extraction_model(con: sqlite3.Connection, run_id: str) -> str:
    require_opaque_id(run_id, "job")
    row = con.execute(
        "SELECT model_metadata_json FROM p1_generation_attempts "
        "WHERE job_id=? AND status='succeeded' ORDER BY attempt_number DESC LIMIT 1",
        (run_id,),
    ).fetchone()
    if row is None:
        raise CoreProblem("DERIVED_STATE_MISMATCH", "successful extraction attempt is missing")
    try:
        metadata = json.loads(row["model_metadata_json"])
    except (TypeError, json.JSONDecodeError) as exc:
        raise CoreProblem(
            "DERIVED_STATE_MISMATCH", "extraction metadata is invalid"
        ) from exc
    if (
        not isinstance(metadata, dict)
        or frozenset(metadata) not in (
            frozenset({"provider", "model"}),
            frozenset({"provider", "model", "reasoningEffort"}),
        )
        or not isinstance(metadata["provider"], str)
        or not metadata["provider"]
        or not isinstance(metadata["model"], str)
        or not metadata["model"]
        or (
            "reasoningEffort" in metadata
            and (
                not isinstance(metadata["reasoningEffort"], str)
                or not metadata["reasoningEffort"]
            )
        )
    ):
        raise CoreProblem("DERIVED_STATE_MISMATCH", "extraction metadata is invalid")
    return metadata["model"]


def find_idempotency_result(
    con: sqlite3.Connection, idempotency_key: str
) -> dict[str, str] | None:
    row = con.execute(
        "SELECT request_digest,result_json FROM p1_idempotency "
        "WHERE scope='candidate_review' AND idempotency_key=?",
        (idempotency_key,),
    ).fetchone()
    return dict(row) if row is not None else None


def insert_formal_knowledge_point(
    con: sqlite3.Connection,
    *,
    knowledge_point_id: str,
    document_id: str,
    chunk_id: str,
    candidate_type: str,
    title: str,
    statement: str,
    extraction_model: str,
    extraction_prompt_version: str,
    content_hash: str,
    created_at: str,
) -> None:
    require_opaque_id(knowledge_point_id, "kp")
    require_opaque_id(document_id, "doc")
    require_opaque_id(chunk_id, "ck")
    if candidate_type not in CANDIDATE_TYPES:
        raise CoreProblem("DERIVED_STATE_MISMATCH", "candidate type is invalid")
    if (
        not isinstance(title, str)
        or not 1 <= len(title) <= 120
        or not isinstance(statement, str)
        or not 1 <= len(statement) <= 2000
        or not isinstance(extraction_model, str)
        or not extraction_model
        or not isinstance(extraction_prompt_version, str)
        or not extraction_prompt_version
        or not isinstance(content_hash, str)
        or len(content_hash) != 64
    ):
        raise CoreProblem("DERIVED_STATE_MISMATCH", "formal knowledge point is invalid")
    con.execute(
        "INSERT INTO knowledge_points("
        "id,course_id,document_id,chunk_id,type,exam_qtype,card_role,parent_id,"
        "title,content,code,code_full,code_full_scope,code_status,code_locator,"
        "origin,status,confidence,dup_group_id,extraction_model,"
        "extraction_prompt_version,content_hash,created_at,updated_at,page,heading_path"
        ") VALUES(?,?,?,?,?,'','standalone',NULL,?,?,NULL,NULL,NULL,NULL,NULL,"
        "'extracted','confirmed',1.0,NULL,?,?,?,?,?,NULL,'')",
        (
            knowledge_point_id,
            FIXTURE_COURSE_ID,
            document_id,
            chunk_id,
            candidate_type,
            title,
            statement,
            extraction_model,
            extraction_prompt_version,
            content_hash,
            created_at,
            created_at,
        ),
    )


def insert_formal_evidence(
    con: sqlite3.Connection,
    *,
    knowledge_point_id: str,
    chunk_id: str,
    evidence: list[dict[str, Any]],
) -> None:
    require_opaque_id(knowledge_point_id, "kp")
    require_opaque_id(chunk_id, "ck")
    if not 1 <= len(evidence) <= 3:
        raise CoreProblem("DERIVED_STATE_MISMATCH", "formal evidence is invalid")
    previous_seq = -1
    for item in evidence:
        if (
            type(item["seq"]) is not int
            or not 0 <= item["seq"] <= 2
            or item["seq"] <= previous_seq
        ):
            raise CoreProblem("DERIVED_STATE_MISMATCH", "formal evidence order is invalid")
        previous_seq = item["seq"]
        con.execute(
            "INSERT INTO kp_evidence("
            "id,kp_id,seq,quote,chunk_id,page,align_method,locator_confidence,"
            "text_start,text_end,context_before,context_after"
            ") VALUES(?,?,?,?,?,NULL,'exact',1.0,?,?,?,?)",
            (
                new_opaque_id("ev"),
                knowledge_point_id,
                item["seq"],
                item["quote"],
                chunk_id,
                item["text_start"],
                item["text_end"],
                item["context_before"],
                item["context_after"],
            ),
        )


def insert_confirmation_log(
    con: sqlite3.Connection,
    *,
    subject_id: str,
    action: str,
    edited_fields_json: str,
    confirmed_at: str,
) -> None:
    if action not in CONFIRMATION_ACTIONS:
        raise CoreProblem("DERIVED_STATE_MISMATCH", "confirmation action is invalid")
    expected_fields = '["title","content"]' if action == "accepted_with_edit" else "[]"
    if edited_fields_json != expected_fields:
        raise CoreProblem("DERIVED_STATE_MISMATCH", "confirmation edit fields are invalid")
    if action == "rejected":
        require_opaque_id(subject_id, "cand")
    else:
        require_opaque_id(subject_id, "kp")
    con.execute(
        "INSERT INTO kp_confirm_log("
        "id,kp_id,support_label,action,edited_fields,merged_into,granularity,elapsed_sec,"
        "confirmed_at) VALUES(?,?,NULL,?,?,NULL,NULL,NULL,?)",
        (
            new_opaque_id("cfl"),
            subject_id,
            action,
            edited_fields_json,
            confirmed_at,
        ),
    )


def close_candidate_review(
    con: sqlite3.Connection,
    *,
    candidate_id: str,
    expected_revision: int,
    review_status: str,
    final_title: str,
    final_statement: str,
    knowledge_point_id: str | None,
    accepted_increment: int,
    reviewed_at: str,
) -> None:
    if review_status not in CANDIDATE_REVIEW_STATUSES - {"pending"}:
        raise CoreProblem("DERIVED_STATE_MISMATCH", "candidate review state is invalid")
    if accepted_increment not in (0, 1) or (knowledge_point_id is None) != (
        review_status == "rejected"
    ):
        raise CoreProblem("DERIVED_STATE_MISMATCH", "candidate review mapping is invalid")
    changed = con.execute(
        "UPDATE p1_candidates SET title=?,statement=?,review_status=?,revision=revision+1,"
        "accepted_kp_id=?,reviewed_at=? "
        "WHERE id=? AND review_status='pending' AND revision=?",
        (
            final_title,
            final_statement,
            review_status,
            knowledge_point_id,
            reviewed_at,
            candidate_id,
            expected_revision,
        ),
    ).rowcount
    if changed != 1:
        raise CoreProblem("CANDIDATE_ALREADY_REVIEWED", "candidate review state changed")


def update_run_after_review(
    con: sqlite3.Connection,
    *,
    run_id: str,
    expected_revision: int,
    accepted_increment: int,
    complete: bool,
    reviewed_at: str,
) -> dict[str, Any]:
    if accepted_increment not in (0, 1) or type(complete) is not bool:
        raise CoreProblem("DERIVED_STATE_MISMATCH", "candidate review mapping is invalid")
    if complete:
        changed = con.execute(
            "UPDATE p1_run_control SET accepted_candidate_count="
            "accepted_candidate_count+?,updated_at=? "
            "WHERE job_id=? AND status='review_pending' AND revision=?",
            (accepted_increment, reviewed_at, run_id, expected_revision),
        ).rowcount
        if changed != 1:
            raise CoreProblem("RUN_STATE_CONFLICT", "run is not awaiting review")
        transition_run(
            con,
            run_id,
            "review_pending",
            "completed",
            "run.completed",
            {"reason": "reviewed_all"},
            transitioned_at=reviewed_at,
        )
        completed = con.execute(
            "UPDATE p1_run_control SET completed_at=? "
            "WHERE job_id=? AND status='completed' AND revision=?",
            (reviewed_at, run_id, expected_revision + 1),
        ).rowcount
        if completed != 1:
            raise CoreProblem("RUN_STATE_CONFLICT", "run completion state changed")
    else:
        changed = con.execute(
            "UPDATE p1_run_control SET accepted_candidate_count="
            "accepted_candidate_count+?,revision=revision+1,updated_at=? "
            "WHERE job_id=? AND status='review_pending' AND revision=?",
            (accepted_increment, reviewed_at, run_id, expected_revision),
        ).rowcount
        if changed != 1:
            raise CoreProblem("RUN_STATE_CONFLICT", "run is not awaiting review")
    updated = require_run(con, run_id)
    assert_projection(con, updated)
    return updated


def store_idempotency_result(
    con: sqlite3.Connection,
    *,
    idempotency_key: str,
    request_digest: str,
    result_json: str,
    created_at: str,
) -> None:
    con.execute(
        "INSERT INTO p1_idempotency("
        "scope,idempotency_key,request_digest,result_json,created_at"
        ") VALUES('candidate_review',?,?,?,?)",
        (idempotency_key, request_digest, result_json, created_at),
    )


def set_run_error(
    con: sqlite3.Connection,
    *,
    run_id: str,
    expected_status: str,
    expected_revision: int,
    error_code: str,
) -> None:
    changed = con.execute(
        "UPDATE p1_run_control SET error_code=?,error_detail=NULL,updated_at=? "
        "WHERE job_id=? AND status=? AND revision=?",
        (error_code, now_iso(), run_id, expected_status, expected_revision),
    ).rowcount
    if changed != 1:
        raise CoreProblem("RUN_STATE_CONFLICT", "run state changed")


def request_retry(
    con: sqlite3.Connection,
    *,
    run_id: str,
    expected_revision: int,
) -> None:
    changed = con.execute(
        "UPDATE p1_run_control "
        "SET retry_count=1,error_code=NULL,error_detail=NULL,updated_at=? "
        "WHERE job_id=? AND status='failed_retryable' AND revision=? AND retry_count=0",
        (now_iso(), run_id, expected_revision),
    ).rowcount
    if changed != 1:
        raise CoreProblem("RUN_STATE_CONFLICT", "run cannot be retried")


def recover_interrupted_runs(database: _TransactionalDatabase) -> int:
    """Atomically fail every current non-terminal generation attempt after startup."""
    recovered = 0
    with database.write_transaction() as con:
        interrupted = con.execute(
            "SELECT r.job_id,r.status,r.revision,r.retry_count,a.id AS attempt_id "
            "FROM p1_run_control r "
            "JOIN p1_generation_attempts a ON a.job_id=r.job_id "
            "WHERE r.status IN ('generating','validating') AND a.status='started' "
            "AND a.attempt_number=("
            "SELECT MAX(current.attempt_number) FROM p1_generation_attempts current "
            "WHERE current.job_id=r.job_id"
            ") ORDER BY r.job_id"
        ).fetchall()
        for stored in interrupted:
            item = dict(stored)
            row = require_run(con, item["job_id"])
            assert_projection(con, row)
            target = "failed_retryable" if item["retry_count"] == 0 else "failed_terminal"
            mark_attempt_failed(
                con,
                attempt_id=item["attempt_id"],
                run_id=item["job_id"],
                error_code="GENERATION_PROVIDER_ERROR",
            )
            set_run_error(
                con,
                run_id=item["job_id"],
                expected_status=item["status"],
                expected_revision=item["revision"],
                error_code="GENERATION_PROVIDER_ERROR",
            )
            transition_run(
                con,
                item["job_id"],
                item["status"],
                target,
                "generation.interrupted",
                {"reason": "core_interrupted"},
            )
            recovered += 1
    return recovered
