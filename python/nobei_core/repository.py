"""Parameterized persistence helpers for Phase 1 run state and events."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any, ContextManager, Protocol

from nobei_core.constants import (
    ALLOWED_TRANSITIONS,
    COMPLETION_REASONS,
    EVENT_TYPES,
    GENERATION_RETRYABILITY,
    RUN_STAGES,
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
_JOB_STAGES = frozenset(RUN_STAGES.values())


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
            or not 0 <= valid_count <= min(raw_count, 1000)
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
        "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM run_events WHERE run_id=?",
        (run_id,),
    ).fetchone()
    seq = int(row["seq"])
    event_created_at = now_iso() if created_at is None else created_at
    con.execute(
        "INSERT INTO run_events(run_id,seq,type,stage,payload_json,created_at) "
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
    stage = RUN_STAGES[target]
    revision = row["revision"] + 1
    transition_time = now_iso() if transitioned_at is None else transitioned_at
    changed = con.execute(
        "UPDATE runs SET status=?,stage=?,revision=?,updated_at=? "
        "WHERE id=? AND status=? AND revision=?",
        (target, stage, revision, transition_time, run_id, expected, row["revision"]),
    ).rowcount
    if changed != 1:
        raise CoreProblem("RUN_STATE_CONFLICT", "run state changed")
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
        "INSERT INTO generation_attempts("
        "id,run_id,attempt_number,request_digest,provider_idempotency_key,"
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
        "SELECT * FROM generation_attempts WHERE run_id=? "
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
            "UPDATE generation_attempts "
            "SET status='failed',error_code=?,completed_at=? "
            "WHERE id=? AND run_id=? AND status='started'",
            (error_code, now_iso(), attempt_id, run_id),
        ).rowcount
    else:
        changed = con.execute(
            "UPDATE generation_attempts "
            "SET status='failed',error_code=?,raw_output_json=?,"
            "completed_at=? "
            "WHERE id=? AND run_id=? AND status='started'",
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
        "UPDATE generation_attempts "
        "SET status='succeeded',error_code=NULL,raw_output_json=?,"
        "completed_at=? WHERE id=? AND run_id=? AND status='started'",
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
        or valid_candidate_count > 1000
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
        "UPDATE runs SET valid_candidate_count=?,raw_candidate_count=?,schema_valid_evidence_count=?,"
        "exact_evidence_count=?,rejection_counts_json=?,completed_at=?,updated_at=? "
        "WHERE id=? AND status='validating' AND revision=?",
        (
            valid_candidate_count,
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
        "INSERT INTO candidates(id,run_id,ordinal,type,title,statement,created_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (candidate_id, run_id, ordinal, candidate_type, title, statement, created_at),
    )
    for item in evidence:
        con.execute(
            "INSERT INTO candidate_evidence("
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


def candidate_evidence(
    con: sqlite3.Connection, candidate_id: str
) -> list[dict[str, Any]]:
    require_opaque_id(candidate_id, "cand")
    rows = con.execute(
        "SELECT seq,quote,text_start,text_end,context_before,context_after "
        "FROM candidate_evidence WHERE candidate_id=? ORDER BY seq",
        (candidate_id,),
    ).fetchall()
    if not 1 <= len(rows) <= 64:
        raise CoreProblem("DERIVED_STATE_MISMATCH", "candidate evidence is invalid")
    evidence = [dict(row) for row in rows]
    sequences = [item["seq"] for item in evidence]
    if any(type(seq) is not int or not 0 <= seq <= 63 for seq in sequences):
        raise CoreProblem("DERIVED_STATE_MISMATCH", "candidate evidence order is invalid")
    return evidence


def run_last_event_seq(con: sqlite3.Connection, run_id: str) -> int:
    require_opaque_id(run_id, "job")
    row = con.execute(
        "SELECT COALESCE(MAX(seq),0) AS last_event_seq FROM run_events WHERE run_id=?",
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
        "SELECT seq,type,stage,payload_json FROM run_events "
        "WHERE run_id=? AND seq>? ORDER BY seq ASC LIMIT ?",
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


def latest_run_attempt(
    con: sqlite3.Connection, run_id: str
) -> dict[str, Any] | None:
    require_opaque_id(run_id, "job")
    row = con.execute(
        "SELECT id,attempt_number,status,error_code,request_digest,"
        "provider_idempotency_key,model_metadata_json,"
        "completed_at "
        "FROM generation_attempts WHERE run_id=? "
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
        "completed_at": row["completed_at"],
    }


def latest_extraction_model(con: sqlite3.Connection, run_id: str) -> str:
    require_opaque_id(run_id, "job")
    row = con.execute(
        "SELECT model_metadata_json FROM generation_attempts "
        "WHERE run_id=? AND status='succeeded' ORDER BY attempt_number DESC LIMIT 1",
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
        "SELECT request_digest,result_json FROM idempotency_records "
        "WHERE scope='candidate_review' AND idempotency_key=?",
        (idempotency_key,),
    ).fetchone()
    return dict(row) if row is not None else None


def update_run_after_review(
    con: sqlite3.Connection,
    *,
    run_id: str,
    expected_revision: int,
    accepted_increment: int,
    review_status: str,
    complete: bool,
    reviewed_at: str,
) -> dict[str, Any]:
    """Advance counters once in the transaction that records the review."""
    changed = con.execute(
        "UPDATE runs SET accepted_candidate_count=accepted_candidate_count+?,"
        "edited_candidate_count=edited_candidate_count+?,"
        "rejected_candidate_count=rejected_candidate_count+?,updated_at=? "
        "WHERE id=? AND status='review_pending' AND revision=?",
        (accepted_increment, int(review_status == 'edited_and_accepted'),
         int(review_status == 'rejected'), reviewed_at, run_id, expected_revision),
    ).rowcount
    if changed != 1:
        raise CoreProblem("RUN_STATE_CONFLICT", "run is not awaiting review")
    if complete:
        transition_run(con, run_id, "review_pending", "completed", "run.completed",
                       {"reason": "reviewed_all"}, transitioned_at=reviewed_at)
        con.execute("UPDATE runs SET completed_at=? WHERE id=?", (reviewed_at, run_id))
    else:
        con.execute("UPDATE runs SET revision=revision+1 WHERE id=?", (run_id,))
    return require_run(con, run_id)


def store_idempotency_result(
    con: sqlite3.Connection,
    *,
    idempotency_key: str,
    request_digest: str,
    result_json: str,
    created_at: str,
) -> None:
    con.execute(
        "INSERT INTO idempotency_records("
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
        "UPDATE runs SET error_code=?,error_detail=NULL,updated_at=? "
        "WHERE id=? AND status=? AND revision=?",
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
        "UPDATE runs "
        "SET retry_count=1,error_code=NULL,error_detail=NULL,updated_at=? "
        "WHERE id=? AND status='failed_retryable' AND revision=? AND retry_count=0",
        (now_iso(), run_id, expected_revision),
    ).rowcount
    if changed != 1:
        raise CoreProblem("RUN_STATE_CONFLICT", "run cannot be retried")


def recover_interrupted_runs(database: _TransactionalDatabase) -> int:
    """Atomically fail every current non-terminal generation attempt after startup."""
    recovered = 0
    with database.write_transaction() as con:
        interrupted = con.execute(
            "SELECT r.id AS run_id,r.status,r.revision,r.retry_count,a.id AS attempt_id "
            "FROM runs r "
            "JOIN generation_attempts a ON a.run_id=r.id "
            "WHERE r.status IN ('generating','validating') AND a.status='started' "
            "AND a.attempt_number=("
            "SELECT MAX(current.attempt_number) FROM generation_attempts current "
            "WHERE current.run_id=r.id"
            ") ORDER BY r.id"
        ).fetchall()
        for stored in interrupted:
            item = dict(stored)
            row = require_run(con, item["run_id"])
            target = "failed_retryable" if item["retry_count"] == 0 else "failed_terminal"
            mark_attempt_failed(
                con,
                attempt_id=item["attempt_id"],
                run_id=item["run_id"],
                error_code="GENERATION_PROVIDER_ERROR",
            )
            set_run_error(
                con,
                run_id=item["run_id"],
                expected_status=item["status"],
                expected_revision=item["revision"],
                error_code="GENERATION_PROVIDER_ERROR",
            )
            transition_run(
                con,
                item["run_id"],
                item["status"],
                target,
                "generation.interrupted",
                {"reason": "core_interrupted"},
            )
            recovered += 1
    return recovered



def require_run(source, run_id):
    require_opaque_id(run_id, 'job')
    row = _one(source, 'SELECT r.*, r.id AS run_id, d.text_sha256 AS document_sha256 '
               'FROM runs r JOIN documents d ON d.id=r.document_id WHERE r.id=?', (run_id,))
    if row is None:
        raise CoreProblem('INVALID_IDENTIFIER', 'run does not exist')
    return row


_CANDIDATE_SELECT = """SELECT c.id,c.run_id,c.ordinal,c.type,
COALESCE(v.final_title,c.title) AS title,COALESCE(v.final_statement,c.statement) AS statement,
CASE v.action WHEN 'accept' THEN 'accepted' WHEN 'edited_and_accept' THEN 'edited_and_accepted'
WHEN 'reject' THEN 'rejected' ELSE 'pending' END AS review_status,
CASE WHEN v.candidate_id IS NULL THEN 1 ELSE 2 END AS revision,
v.knowledge_point_id AS accepted_kp_id,v.reviewed_at
FROM candidates c LEFT JOIN candidate_reviews v ON v.candidate_id=c.id """


def require_candidate(con, candidate_id):
    row = con.execute(_CANDIDATE_SELECT + 'WHERE c.id=?', (candidate_id,)).fetchone()
    if row is None:
        raise CoreProblem('INVALID_IDENTIFIER', 'candidate does not exist')
    return dict(row)


def read_run_candidates(con, run_id):
    return [dict(r) for r in con.execute(_CANDIDATE_SELECT + 'WHERE c.run_id=? ORDER BY c.ordinal', (run_id,))]


def run_snapshot_counts(con: sqlite3.Connection, run_id: str) -> dict[str, int]:
    """Read transaction-maintained counters; never scan candidates or reviews."""
    row = con.execute(
        "SELECT valid_candidate_count,accepted_candidate_count,"
        "edited_candidate_count,rejected_candidate_count FROM runs WHERE id=?", (run_id,)
    ).fetchone()
    if row is None:
        raise CoreProblem("INVALID_IDENTIFIER", "run does not exist")
    return {
        "valid_candidates": row["valid_candidate_count"],
        "pending": row["valid_candidate_count"] - row["accepted_candidate_count"] - row["rejected_candidate_count"],
        "accepted": row["accepted_candidate_count"] - row["edited_candidate_count"],
        "edited_and_accepted": row["edited_candidate_count"],
        "rejected": row["rejected_candidate_count"],
        "knowledge_points": row["accepted_candidate_count"],
    }


def read_run_knowledge_points(con, run_id):
    return [dict(r) for r in con.execute('SELECT k.* FROM candidates c JOIN candidate_reviews v '
        'ON v.candidate_id=c.id JOIN knowledge_points k ON k.id=v.knowledge_point_id '
        'WHERE c.run_id=? ORDER BY c.ordinal', (run_id,))]


def knowledge_point_evidence(con, knowledge_point_id):
    return [dict(r) for r in con.execute('SELECT * FROM knowledge_point_evidence WHERE knowledge_point_id=? ORDER BY seq', (knowledge_point_id,))]


def insert_formal_knowledge_point(con, *, knowledge_point_id, document_id, candidate_type,
        title, statement, extraction_model, extraction_prompt_version, content_hash, created_at):
    con.execute('INSERT INTO knowledge_points(id,document_id,type,title,statement,extraction_model,'
        'extraction_prompt_version,content_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        (knowledge_point_id,document_id,candidate_type,title,statement,extraction_model,
         extraction_prompt_version,content_hash,created_at,created_at))


def insert_formal_evidence(con, *, knowledge_point_id, evidence):
    for item in evidence:
        con.execute('INSERT INTO knowledge_point_evidence(id,knowledge_point_id,seq,quote,text_start,text_end,context_before,context_after) VALUES(?,?,?,?,?,?,?,?)',
            (new_opaque_id('ev'),knowledge_point_id,item['seq'],item['quote'],item['text_start'],item['text_end'],item['context_before'],item['context_after']))


def close_candidate_review(con, *, candidate_id, expected_revision, review_status, final_title,
        final_statement, knowledge_point_id, accepted_increment, reviewed_at):
    action = {'accepted':'accept','edited_and_accepted':'edited_and_accept','rejected':'reject'}[review_status]
    edited = action == 'edited_and_accept'
    con.execute('INSERT INTO candidate_reviews(candidate_id,action,final_title,final_statement,knowledge_point_id,reviewed_at) VALUES(?,?,?,?,?,?)',
        (candidate_id,action,final_title if edited else None,final_statement if edited else None,knowledge_point_id,reviewed_at))
