"""Application service for transactional Phase 1 text imports."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from typing import Any

from nobei_core.constants import (
    CANDIDATE_STATEMENT_MAX_CHARS,
    CANDIDATE_TITLE_MAX_CHARS,
    CANDIDATE_REVIEW_STATUSES,
    CANDIDATE_TYPES,
    EVIDENCE_CONTEXT_MAX_CHARS,
    EVENT_AFTER_MAX,
    FILENAME_MAX_CHARS,
    FILENAME_MIN_CHARS,
    FIXTURE_COURSE_ID,
    GENERATION_RETRYABILITY,
    JOB_PROJECTION,
    MAX_DOCUMENT_BYTES,
    MAX_IDEMPOTENCY_RESULT_BYTES,
    MAX_RAW_GENERATION_OUTPUT_BYTES,
    MODEL_NAME_MAX_CHARS,
    MODEL_NAME_MIN_CHARS,
    MODEL_PROVIDER_MAX_CHARS,
    MODEL_PROVIDER_MIN_CHARS,
    REVIEW_ACTION_MAPPING,
    REVIEW_ACTIONS,
)
from nobei_core.contract import CandidateContract
from nobei_core.database import Phase1Database
from nobei_core.errors import CoreProblem
from nobei_core.evidence import locate_evidence
from nobei_core.ids import (
    new_opaque_id,
    require_idempotency_key,
    require_opaque_id,
)
from nobei_core.repository import (
    append_event,
    assert_projection,
    candidate_run_status,
    candidate_evidence,
    close_candidate_review,
    decode_event_payload,
    find_idempotency_result,
    insert_confirmation_log,
    insert_formal_evidence,
    insert_formal_knowledge_point,
    insert_generation_attempt,
    insert_candidate,
    latest_extraction_model,
    mark_attempt_succeeded,
    mark_attempt_failed,
    knowledge_point_evidence,
    latest_run_attempt,
    now_iso,
    read_run_candidates,
    read_candidate_confirmation_logs,
    read_candidate_review_events,
    read_formal_knowledge_point,
    read_run_attempts,
    read_run_event_ledger,
    read_run_events,
    read_run_knowledge_points,
    request_retry,
    require_candidate,
    require_current_attempt,
    require_run,
    run_last_event_seq,
    run_attempt_identity,
    run_attempt_count,
    run_candidate_evidence_count,
    run_snapshot_counts,
    set_run_error,
    store_idempotency_result,
    transition_run,
    update_run_after_review,
    update_generation_statistics,
)


_MEDIA_SOURCE_TYPES = {"text/plain": "txt", "text/markdown": "markdown"}
_SOURCE_MEDIA_TYPES = {source: media for media, source in _MEDIA_SOURCE_TYPES.items()}
_EVENT_PAGE_LIMIT = 200
_EVENT_STAGES = {
    "run.created": "source",
    "document.ready": "parse",
    "generation.awaiting": "extract",
    "generation.started": "extract",
    "generation.validating": "verify",
    "generation.failed": "failed",
    "generation.interrupted": "failed",
    "generation.retry_requested": "extract",
    "candidate.accepted": "confirm",
    "candidate.edited_and_accepted": "confirm",
    "candidate.rejected": "confirm",
    "run.completed": "done",
}
_PROMPT_VERSION = "l1-v2"
_REVIEW_FIELDS = frozenset(
    {"candidateId", "action", "expectedRevision", "idempotencyKey"}
)
_REVIEW_EDIT_FIELDS = _REVIEW_FIELDS | {"title", "statement"}


def _require_params(params: object, fields: frozenset[str]) -> dict[str, Any]:
    if not isinstance(params, dict) or frozenset(params) != fields:
        raise CoreProblem("INVALID_PARAMS", "command parameters are invalid")
    return params


def _normalize_document(params: object) -> tuple[str, str, str, bytes]:
    command = _require_params(params, frozenset({"filename", "mediaType", "text"}))
    filename = command["filename"]
    media_type = command["mediaType"]
    text = command["text"]

    if not isinstance(media_type, str) or media_type not in _MEDIA_SOURCE_TYPES:
        raise CoreProblem("UNSUPPORTED_MEDIA_TYPE", "unsupported text media type")
    if (
        not isinstance(filename, str)
        or not FILENAME_MIN_CHARS <= len(filename) <= FILENAME_MAX_CHARS
        or filename in (".", "..")
        or "/" in filename
        or "\\" in filename
        or "\x00" in filename
        or any(0xD800 <= ord(character) <= 0xDFFF for character in filename)
    ):
        raise CoreProblem("INVALID_DOCUMENT", "invalid filename")
    if not isinstance(text, str):
        raise CoreProblem("INVALID_DOCUMENT", "document text must be Unicode")

    canonical = text.replace("\r\n", "\n").replace("\r", "\n")
    if not canonical or any(
        0xD800 <= ord(character) <= 0xDFFF
        or (ord(character) < 0x20 and character not in ("\t", "\n"))
        for character in canonical
    ):
        raise CoreProblem("INVALID_DOCUMENT", "document text is not canonical text")
    encoded = canonical.encode("utf-8")
    if len(encoded) > MAX_DOCUMENT_BYTES:
        raise CoreProblem(
            "REQUEST_TOO_LARGE",
            "document exceeds byte limit",
            {"actualBytes": len(encoded), "maxBytes": MAX_DOCUMENT_BYTES},
        )
    return filename, media_type, canonical, encoded


def _advance_import_milestone(
    con: sqlite3.Connection,
    run_id: str,
    expected: str,
    target: str,
) -> None:
    stage, job_status = JOB_PROJECTION[target]
    changed = con.execute(
        "UPDATE p1_run_control SET status=?,stage=?,updated_at=? "
        "WHERE job_id=? AND status=? AND revision=?",
        (target, stage, now_iso(), run_id, expected, 1),
    ).rowcount
    projected = con.execute(
        "UPDATE import_jobs SET stage=?,status=?,updated_at=? WHERE id=?",
        (stage, job_status, now_iso(), run_id),
    ).rowcount
    if changed != 1 or projected != 1:
        raise CoreProblem("TRANSACTION_FAILED", "initial run projection could not advance")


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _require_expected_revision(value: object) -> int:
    if type(value) is not int or value < 1:
        raise CoreProblem("INVALID_PARAMS", "expected revision is invalid")
    return value


def _require_review_text(value: object, *, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= maximum
        or any(0xD800 <= ord(character) <= 0xDFFF for character in value)
    ):
        raise CoreProblem("INVALID_PARAMS", "review text is invalid")
    return value


def _require_review_command(
    params: object,
) -> tuple[dict[str, Any], str, int, str]:
    if not isinstance(params, dict):
        raise CoreProblem("INVALID_PARAMS", "command parameters are invalid")
    action = params.get("action")
    if not isinstance(action, str) or action not in REVIEW_ACTIONS:
        raise CoreProblem("INVALID_PARAMS", "review action is invalid")
    expected_fields = (
        _REVIEW_EDIT_FIELDS if action == "edited_and_accept" else _REVIEW_FIELDS
    )
    command = _require_params(params, expected_fields)
    candidate_id = require_opaque_id(command["candidateId"], "cand")
    expected_revision = _require_expected_revision(command["expectedRevision"])
    idempotency_key = require_idempotency_key(command["idempotencyKey"])
    if action == "edited_and_accept":
        _require_review_text(command["title"], maximum=CANDIDATE_TITLE_MAX_CHARS)
        _require_review_text(
            command["statement"], maximum=CANDIDATE_STATEMENT_MAX_CHARS
        )
    return command, candidate_id, expected_revision, idempotency_key


def _public_evidence(evidence: list[dict[str, Any]]) -> list[dict[str, object]]:
    return [
        {
            "seq": item["seq"],
            "quote": item["quote"],
            "textStart": item["text_start"],
            "textEnd": item["text_end"],
            "contextBefore": item["context_before"],
            "contextAfter": item["context_after"],
        }
        for item in evidence
    ]


def _review_candidate_snapshot(
    row: dict[str, Any],
    evidence: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "candidateId": row["id"],
        "type": row["type"],
        "title": row["title"],
        "statement": row["statement"],
        "reviewStatus": row["review_status"],
        "revision": row["revision"],
        "knowledgePointId": row["accepted_kp_id"],
        "evidence": evidence,
    }


def _review_knowledge_point_snapshot(
    *,
    knowledge_point_id: str,
    candidate_type: str,
    title: str,
    statement: str,
    document_id: str,
    evidence: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "knowledgePointId": knowledge_point_id,
        "type": candidate_type,
        "title": title,
        "statement": statement,
        "documentId": document_id,
        "evidence": evidence,
    }


def _encode_review_result(result: dict[str, object]) -> str:
    encoded = _canonical_json(result)
    actual_bytes = len(encoded.encode("utf-8"))
    if actual_bytes > MAX_IDEMPOTENCY_RESULT_BYTES:
        raise CoreProblem(
            "REQUEST_TOO_LARGE",
            "idempotency result exceeds byte limit",
            {"actualBytes": actual_bytes, "maxBytes": MAX_IDEMPOTENCY_RESULT_BYTES},
        )
    return encoded


def _stored_result_invalid() -> CoreProblem:
    return CoreProblem("TRANSACTION_FAILED", "stored idempotency result is invalid")


def _valid_stored_text(value: object, maximum: int) -> bool:
    return (
        isinstance(value, str)
        and 1 <= len(value) <= maximum
        and not any(0xD800 <= ord(character) <= 0xDFFF for character in value)
    )


def _valid_stored_id(value: object, prefix: str) -> bool:
    try:
        require_opaque_id(value, prefix)
    except CoreProblem:
        return False
    return True


def _valid_stored_evidence(value: object) -> bool:
    if not isinstance(value, list) or not 1 <= len(value) <= 3:
        return False
    previous_seq = -1
    expected_fields = {
        "seq", "quote", "textStart", "textEnd", "contextBefore", "contextAfter"
    }
    for item in value:
        if not isinstance(item, dict) or frozenset(item) != expected_fields:
            return False
        seq = item["seq"]
        start = item["textStart"]
        end = item["textEnd"]
        if (
            type(seq) is not int
            or not 0 <= seq <= 2
            or seq <= previous_seq
            or type(start) is not int
            or type(end) is not int
            or start < 0
            or end <= start
            or not _valid_stored_text(item["quote"], 2_000)
            or not isinstance(item["contextBefore"], str)
            or len(item["contextBefore"]) > 200
            or not isinstance(item["contextAfter"], str)
            or len(item["contextAfter"]) > 200
        ):
            return False
        previous_seq = seq
    return True


def _valid_stored_run(value: object) -> bool:
    if (
        not isinstance(value, dict)
        or frozenset(value)
        != {
            "runId", "documentId", "status", "stage", "revision", "retryCount",
            "lastEventSeq", "counts", "error", "document", "modelSelection",
        }
        or not _valid_stored_id(value["runId"], "job")
        or not _valid_stored_id(value["documentId"], "doc")
        or value["status"] not in {"review_pending", "completed"}
        or value["stage"] != JOB_PROJECTION[value["status"]][0]
        or type(value["revision"]) is not int
        or value["revision"] < 1
        or type(value["retryCount"]) is not int
        or value["retryCount"] not in (0, 1)
        or type(value["lastEventSeq"]) is not int
        or value["lastEventSeq"] < 1
        or value["error"] is not None
    ):
        return False
    counts = value["counts"]
    if (
        not isinstance(counts, dict)
        or frozenset(counts)
        != {
            "rawCandidates", "validCandidates", "pending", "accepted",
            "editedAndAccepted", "rejected", "knowledgePoints",
        }
        or any(type(count) is not int or count < 0 for count in counts.values())
        or counts["rawCandidates"] < counts["validCandidates"]
        or counts["validCandidates"]
        != counts["pending"]
        + counts["accepted"]
        + counts["editedAndAccepted"]
        + counts["rejected"]
        or counts["knowledgePoints"]
        != counts["accepted"] + counts["editedAndAccepted"]
    ):
        return False
    document = value["document"]
    if (
        not isinstance(document, dict)
        or frozenset(document)
        != {"filename", "mediaType", "byteSize", "characterCount", "text"}
        or not isinstance(document["filename"], str)
        or not 1 <= len(document["filename"]) <= FILENAME_MAX_CHARS
        or document["mediaType"] not in _MEDIA_SOURCE_TYPES
        or type(document["byteSize"]) is not int
        or type(document["characterCount"]) is not int
        or not isinstance(document["text"], str)
        or document["byteSize"] != len(document["text"].encode("utf-8"))
        or document["characterCount"] != len(document["text"])
    ):
        return False
    try:
        if _require_model_metadata(value["modelSelection"]) != value["modelSelection"]:
            return False
    except CoreProblem:
        return False
    return True


def _decode_review_result(result_json: str) -> dict[str, object]:
    try:
        restored = json.loads(result_json)
    except (TypeError, json.JSONDecodeError) as exc:
        raise _stored_result_invalid() from exc
    if (
        not isinstance(restored, dict)
        or frozenset(restored) != {"candidate", "run", "knowledgePoint"}
        or _canonical_json(restored) != result_json
        or len(result_json.encode("utf-8")) > MAX_IDEMPOTENCY_RESULT_BYTES
    ):
        raise _stored_result_invalid()
    candidate = restored["candidate"]
    run = restored["run"]
    knowledge_point = restored["knowledgePoint"]
    if (
        not isinstance(candidate, dict)
        or frozenset(candidate)
        != {
            "candidateId", "type", "title", "statement", "reviewStatus",
            "revision", "knowledgePointId", "evidence",
        }
        or not _valid_stored_id(candidate["candidateId"], "cand")
        or candidate["type"] not in CANDIDATE_TYPES
        or not _valid_stored_text(candidate["title"], CANDIDATE_TITLE_MAX_CHARS)
        or not _valid_stored_text(
            candidate["statement"], CANDIDATE_STATEMENT_MAX_CHARS
        )
        or candidate["reviewStatus"] not in CANDIDATE_REVIEW_STATUSES - {"pending"}
        or type(candidate["revision"]) is not int
        or candidate["revision"] < 2
        or not _valid_stored_evidence(candidate["evidence"])
    ):
        raise _stored_result_invalid()
    if not _valid_stored_run(run):
        raise _stored_result_invalid()
    try:
        _validate_exact_evidence(candidate["evidence"], run["document"]["text"])
    except CoreProblem as exc:
        raise _stored_result_invalid() from exc
    rejected = candidate["reviewStatus"] == "rejected"
    if rejected:
        if candidate["knowledgePointId"] is not None or knowledge_point is not None:
            raise _stored_result_invalid()
    elif (
        not _valid_stored_id(candidate["knowledgePointId"], "kp")
        or not isinstance(knowledge_point, dict)
        or frozenset(knowledge_point)
        != {"knowledgePointId", "type", "title", "statement", "documentId", "evidence"}
        or knowledge_point["knowledgePointId"] != candidate["knowledgePointId"]
        or knowledge_point["type"] != candidate["type"]
        or knowledge_point["title"] != candidate["title"]
        or knowledge_point["statement"] != candidate["statement"]
        or knowledge_point["documentId"] != run["documentId"]
        or knowledge_point["evidence"] != candidate["evidence"]
    ):
        raise _stored_result_invalid()
    return restored


def _review_request_digest(
    *, candidate_id: str, action: str, title: str, statement: str,
    expected_revision: int,
) -> str:
    return hashlib.sha256(
        _canonical_json(
            {
                "candidateId": candidate_id,
                "action": action,
                "title": title,
                "statement": statement,
                "expectedRevision": expected_revision,
            }
        ).encode("utf-8")
    ).hexdigest()


def _validate_replay_semantics(
    restored: dict[str, object],
    *,
    command: dict[str, Any],
    candidate_id: str,
    action: str,
    expected_revision: int,
) -> None:
    candidate = restored["candidate"]
    if not isinstance(candidate, dict):
        raise _stored_result_invalid()
    valid = (
        candidate["candidateId"] == candidate_id
        and candidate["reviewStatus"] == REVIEW_ACTION_MAPPING[action][0]
        and candidate["revision"] == expected_revision + 1
    )
    if action == "edited_and_accept":
        knowledge_point = restored["knowledgePoint"]
        valid = (
            valid
            and isinstance(knowledge_point, dict)
            and candidate["title"] == command["title"]
            and candidate["statement"] == command["statement"]
            and knowledge_point["title"] == command["title"]
            and knowledge_point["statement"] == command["statement"]
        )
    if not valid:
        raise _stored_result_invalid()


def _validate_replay_persistence(
    con: sqlite3.Connection, restored: dict[str, object]
) -> None:
    stored_run = restored["run"]
    candidate = restored["candidate"]
    knowledge_point = restored["knowledgePoint"]
    if not isinstance(stored_run, dict) or not isinstance(candidate, dict):
        raise _stored_result_invalid()
    try:
        persisted_run = require_run(con, str(stored_run["runId"]))
        assert_projection(con, persisted_run)
        document = _require_run_document(con, str(stored_run["runId"]))
        _validate_run_document(persisted_run, document)
        canonical_text = str(document["text"])
        expected_document = {
            "filename": document["filename"],
            "mediaType": _SOURCE_MEDIA_TYPES[str(document["source_type"])],
            "byteSize": persisted_run["byte_size"],
            "characterCount": persisted_run["character_count"],
            "text": canonical_text,
        }
        if (
            stored_run["documentId"] != document["document_id"]
            or stored_run["document"] != expected_document
        ):
            raise _stored_result_invalid()
        _validate_exact_evidence(candidate["evidence"], canonical_text)
        if isinstance(knowledge_point, dict):
            _validate_exact_evidence(knowledge_point["evidence"], canonical_text)
            formal = read_formal_knowledge_point(
                con, str(knowledge_point["knowledgePointId"])
            )
            if formal is None:
                raise _stored_result_invalid()
            _validate_formal_point(
                con,
                formal,
                document_id=str(document["document_id"]),
                chunk_id=str(document["chunk_id"]),
                candidate_type=str(knowledge_point["type"]),
                title=str(knowledge_point["title"]),
                statement=str(knowledge_point["statement"]),
                evidence=knowledge_point["evidence"],
                canonical_text=canonical_text,
            )
    except CoreProblem as exc:
        if exc.code == "TRANSACTION_FAILED":
            raise
        raise _stored_result_invalid() from exc


def _require_model_metadata(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or frozenset(value) not in (
        frozenset({"provider", "model"}),
        frozenset({"provider", "model", "reasoningEffort"}),
    ):
        raise CoreProblem("INVALID_PARAMS", "model metadata is invalid")
    provider = value["provider"]
    model = value["model"]
    reasoning_effort = value.get("reasoningEffort")
    if (
        not isinstance(provider, str)
        or not MODEL_PROVIDER_MIN_CHARS <= len(provider) <= MODEL_PROVIDER_MAX_CHARS
        or not isinstance(model, str)
        or not MODEL_NAME_MIN_CHARS <= len(model) <= MODEL_NAME_MAX_CHARS
        or any(0xD800 <= ord(character) <= 0xDFFF for character in provider + model)
        or (
            "reasoningEffort" in value
            and (
                not isinstance(reasoning_effort, str)
                or not 1 <= len(reasoning_effort) <= MODEL_PROVIDER_MAX_CHARS
                or any(0xD800 <= ord(character) <= 0xDFFF for character in reasoning_effort)
            )
        )
    ):
        raise CoreProblem("INVALID_PARAMS", "model metadata is invalid")
    return {
        "provider": provider,
        "model": model,
        **({"reasoningEffort": reasoning_effort} if reasoning_effort is not None else {}),
    }


def _decode_model_metadata(value: object) -> dict[str, str]:
    try:
        if not isinstance(value, str):
            raise ValueError("model metadata is not encoded")
        decoded = json.loads(value)
        validated = _require_model_metadata(decoded)
        if _canonical_json(validated) != value:
            raise ValueError("model metadata is not canonical")
        return validated
    except (CoreProblem, TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise _derived_state_mismatch("generation model selection is invalid") from exc


def _generation_request_digest(
    run: dict[str, Any], attempt_number: int, model_selection: dict[str, str]
) -> str:
    digest_input = {
        "runId": run["job_id"],
        "attemptNumber": attempt_number,
        "documentSha256": run["document_sha256"],
        "schemaVersion": run["schema_version"],
        "schemaSha256": run["schema_sha256"],
        "promptVersion": run["prompt_version"],
        "modelSelection": model_selection,
    }
    return hashlib.sha256(_canonical_json(digest_input).encode("utf-8")).hexdigest()


def _require_run_document(con: sqlite3.Connection, run_id: str) -> dict[str, object]:
    stored = con.execute(
        "SELECT j.document_id,d.id AS stored_document_id,d.course_id,"
        "d.name AS filename,d.source_type,d.page_count,d.file_path,"
        "c.id AS chunk_id,c.seq AS chunk_seq,c.char_offset,c.state AS chunk_state,c.text "
        "FROM import_jobs j JOIN documents d ON d.id=j.document_id "
        "JOIN chunks c ON c.document_id=d.id WHERE j.id=? ORDER BY c.seq",
        (run_id,),
    ).fetchall()
    if len(stored) != 1:
        raise CoreProblem("DERIVED_STATE_MISMATCH", "run document projection is invalid")
    row = stored[0]
    return {
        "document_id": row["document_id"],
        "stored_document_id": row["stored_document_id"],
        "course_id": row["course_id"],
        "filename": row["filename"],
        "source_type": row["source_type"],
        "page_count": row["page_count"],
        "file_path": row["file_path"],
        "chunk_id": row["chunk_id"],
        "chunk_seq": row["chunk_seq"],
        "char_offset": row["char_offset"],
        "chunk_state": row["chunk_state"],
        "text": row["text"],
    }


def _derived_state_mismatch(message: str) -> CoreProblem:
    return CoreProblem("DERIVED_STATE_MISMATCH", message)


def _run_error_snapshot(
    row: dict[str, Any], latest_attempt: dict[str, Any] | None
) -> dict[str, object] | None:
    code = row["error_code"]
    if code is None:
        if row["status"] in ("failed_retryable", "failed_terminal"):
            raise _derived_state_mismatch("failed run error is missing")
        return None
    if (
        not isinstance(code, str)
        or code not in GENERATION_RETRYABILITY
        or row["status"] not in ("failed_retryable", "failed_terminal")
        or type(row["retry_count"]) is not int
        or row["retry_count"] not in (0, 1)
    ):
        raise _derived_state_mismatch("run error projection is invalid")
    retryable = bool(GENERATION_RETRYABILITY[code] and row["retry_count"] == 0)
    if retryable != (row["status"] == "failed_retryable"):
        raise _derived_state_mismatch("run error retryability is inconsistent")
    if (
        latest_attempt is None
        or latest_attempt["status"] != "failed"
        or latest_attempt["error_code"] != code
        or latest_attempt["attempt_number"] != row["retry_count"] + 1
    ):
        raise _derived_state_mismatch("failed run attempt is inconsistent")
    return {"code": code, "retryable": retryable}


def _decode_rejection_counts(value: object) -> dict[str, int]:
    try:
        if not isinstance(value, str) or len(value.encode("utf-8")) > 1_024:
            raise ValueError("invalid rejection-count encoding")
        decoded = json.loads(value)
        canonical = _canonical_json(decoded)
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise _derived_state_mismatch("run rejection counts are invalid") from exc
    if (
        not isinstance(decoded, dict)
        or canonical != value
        or any(
            code not in ("EVIDENCE_NOT_FOUND", "EVIDENCE_AMBIGUOUS")
            or type(count) is not int
            or count <= 0
            for code, count in decoded.items()
        )
    ):
        raise _derived_state_mismatch("run rejection counts are invalid")
    return decoded


def _validate_success_statistics(
    con: sqlite3.Connection,
    row: dict[str, Any],
    latest_attempt: dict[str, Any],
    contract: CandidateContract,
    canonical_text: str,
    valid_candidate_count: int,
) -> None:
    raw_json = latest_attempt["raw_output_json"]
    try:
        if not isinstance(raw_json, str):
            raise ValueError("missing successful output")
        encoded = raw_json.encode("utf-8")
        if len(encoded) > MAX_RAW_GENERATION_OUTPUT_BYTES:
            raise ValueError("successful output is too large")
        raw_output = json.loads(raw_json)
        canonical = _canonical_json(raw_output)
        validation_errors = contract.validate(raw_output)
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise _derived_state_mismatch("successful generation output is invalid") from exc
    if (
        not isinstance(raw_output, dict)
        or canonical != raw_json
        or validation_errors
    ):
        raise _derived_state_mismatch("successful generation output is invalid")
    raw_candidates = raw_output["candidates"]
    schema_evidence = sum(len(candidate["evidence"]) for candidate in raw_candidates)
    exact_evidence = 0
    valid_candidates = 0
    rejection_counts: dict[str, int] = {}
    expected_candidates: list[dict[str, object]] = []
    for ordinal, candidate in enumerate(raw_candidates):
        exact_rows: list[dict[str, object]] = []
        for seq, evidence in enumerate(candidate["evidence"]):
            try:
                located = locate_evidence(canonical_text, evidence)
            except CoreProblem as problem:
                if problem.code not in ("EVIDENCE_NOT_FOUND", "EVIDENCE_AMBIGUOUS"):
                    raise _derived_state_mismatch(
                        "successful generation evidence is invalid"
                    ) from problem
                rejection_counts[problem.code] = rejection_counts.get(problem.code, 0) + 1
            else:
                exact_evidence += 1
                exact_rows.append(
                    {
                        "seq": seq,
                        "quote": evidence["quote"],
                        "textStart": located.text_start,
                        "textEnd": located.text_end,
                        "contextBefore": located.context_before,
                        "contextAfter": located.context_after,
                    }
                )
        if exact_rows:
            valid_candidates += 1
            expected_candidates.append(
                {
                    "ordinal": ordinal,
                    "type": candidate["type"],
                    "title": candidate["title"],
                    "statement": candidate["statement"],
                    "evidence": exact_rows,
                }
            )
    stored_rejections = _decode_rejection_counts(row["rejection_counts_json"])
    if (
        row["raw_candidate_count"] != len(raw_candidates)
        or row["schema_valid_evidence_count"] != schema_evidence
        or row["exact_evidence_count"] != exact_evidence
        or run_candidate_evidence_count(con, str(row["job_id"])) != exact_evidence
        or valid_candidate_count != valid_candidates
        or stored_rejections != rejection_counts
    ):
        raise _derived_state_mismatch("successful generation statistics are inconsistent")
    stored_candidates = read_run_candidates(con, str(row["job_id"]))
    if len(stored_candidates) != len(expected_candidates):
        raise _derived_state_mismatch("retained generation candidates are inconsistent")
    for stored, expected in zip(stored_candidates, expected_candidates, strict=True):
        public = _candidate_snapshot(con, stored, canonical_text)
        if (
            stored["ordinal"] != expected["ordinal"]
            or stored["type"] != expected["type"]
            or public["evidence"] != expected["evidence"]
            or stored["review_status"] != "edited_and_accepted"
            and (
                stored["title"] != expected["title"]
                or stored["statement"] != expected["statement"]
            )
        ):
            raise _derived_state_mismatch(
                "retained generation candidates are inconsistent"
            )


def _validate_failed_attempt_output(
    attempt: dict[str, Any], contract: CandidateContract
) -> None:
    raw_json = attempt["raw_output_json"]
    if raw_json is None:
        return
    try:
        if (
            attempt["error_code"] != "GENERATION_SCHEMA_INVALID"
            or not isinstance(raw_json, str)
            or len(raw_json.encode("utf-8")) > MAX_RAW_GENERATION_OUTPUT_BYTES
        ):
            raise ValueError("unexpected failed output")
        raw_output = json.loads(raw_json)
        canonical = _canonical_json(raw_output)
        validation_errors = contract.validate(raw_output)
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise _derived_state_mismatch("failed generation output is invalid") from exc
    if (
        not isinstance(raw_output, dict)
        or canonical != raw_json
        or not validation_errors
    ):
        raise _derived_state_mismatch("failed generation output is invalid")


def _active_attempt_has_unwritten_defaults(attempt: dict[str, Any]) -> bool:
    return (
        attempt["status"] == "started"
        and attempt["error_code"] is None
        and attempt["raw_output_json"] is None
        and attempt["completed_at"] is None
    )


def _validate_generation_facts(
    con: sqlite3.Connection,
    row: dict[str, Any],
    contract: CandidateContract,
    canonical_text: str,
    valid_candidate_count: int,
) -> dict[str, Any] | None:
    retry_count = row["retry_count"]
    if (
        type(retry_count) is not int
        or retry_count not in (0, 1)
        or row["mode"] != "l1"
        or row["schema_version"] != contract.schema_version
        or row["schema_sha256"] != contract.schema_sha256
        or row["prompt_version"] != _PROMPT_VERSION
    ):
        raise _derived_state_mismatch("run contract or retry facts are invalid")
    latest = latest_run_attempt(con, str(row["job_id"]))
    attempt_count = run_attempt_count(con, str(row["job_id"]))
    status = row["status"]
    successful = status in ("review_pending", "completed")
    active = status in ("generating", "validating")
    failed = status in ("failed_retryable", "failed_terminal")
    initial = status in ("created", "document_ready", "awaiting_generation")
    expected_attempts = retry_count + 1 if (successful or active or failed) else retry_count
    if attempt_count != expected_attempts:
        raise _derived_state_mismatch("run attempts are inconsistent")
    if latest is not None:
        try:
            require_opaque_id(latest["id"], "att")
            model_selection = _decode_model_metadata(latest["model_metadata_json"])
            expected_digest = _generation_request_digest(
                row, latest["attempt_number"], model_selection
            )
            if (
                latest["request_digest"] != expected_digest
                or latest["provider_idempotency_key"] != "nobei:" + expected_digest
            ):
                raise CoreProblem(
                    "DERIVED_STATE_MISMATCH", "generation request identity is invalid"
                )
        except CoreProblem as exc:
            raise _derived_state_mismatch("run attempt identity is invalid") from exc
    if successful:
        if (
            latest is None
            or latest["attempt_number"] != retry_count + 1
            or latest["status"] != "succeeded"
            or latest["error_code"] is not None
        ):
            raise _derived_state_mismatch("successful run attempt is inconsistent")
        _validate_success_statistics(
            con, row, latest, contract, canonical_text, valid_candidate_count
        )
    elif active:
        if (
            latest is None
            or latest["attempt_number"] != retry_count + 1
            or not _active_attempt_has_unwritten_defaults(latest)
        ):
            raise _derived_state_mismatch("active run attempt is inconsistent")
    elif failed:
        if latest is None:
            raise _derived_state_mismatch("failed run attempt is missing")
        _validate_failed_attempt_output(latest, contract)
    elif initial and retry_count == 1:
        if (
            latest is None
            or latest["attempt_number"] != 1
            or latest["status"] != "failed"
            or latest["error_code"] not in GENERATION_RETRYABILITY
        ):
            raise _derived_state_mismatch("retried run attempt is inconsistent")
        _validate_failed_attempt_output(latest, contract)
    elif latest is not None:
        raise _derived_state_mismatch("unexpected generation attempt is present")
    if not successful and (
        row["raw_candidate_count"] != 0
        or row["schema_valid_evidence_count"] != 0
        or row["exact_evidence_count"] != 0
        or valid_candidate_count != 0
        or run_candidate_evidence_count(con, str(row["job_id"])) != 0
        or _decode_rejection_counts(row["rejection_counts_json"])
    ):
        raise _derived_state_mismatch("non-successful run statistics are inconsistent")
    return latest


def _run_count_snapshot(
    con: sqlite3.Connection,
    row: dict[str, Any],
    contract: CandidateContract,
    canonical_text: str,
) -> tuple[dict[str, int], dict[str, Any] | None]:
    stored = run_snapshot_counts(con, str(row["job_id"]))
    valid = stored["valid_candidates"]
    accepted = stored["accepted"]
    edited = stored["edited_and_accepted"]
    latest_attempt = _validate_generation_facts(
        con, row, contract, canonical_text, valid
    )
    if (
        any(type(value) is not int or value < 0 for value in stored.values())
        or valid
        != stored["pending"] + accepted + edited + stored["rejected"]
        or type(row["raw_candidate_count"]) is not int
        or row["raw_candidate_count"] < valid
        or type(row["accepted_candidate_count"]) is not int
        or row["accepted_candidate_count"] != accepted + edited
        or stored["knowledge_points"] != accepted + edited
    ):
        raise _derived_state_mismatch("run candidate counts are inconsistent")
    return {
        "rawCandidates": row["raw_candidate_count"],
        "validCandidates": valid,
        "pending": stored["pending"],
        "accepted": accepted,
        "editedAndAccepted": edited,
        "rejected": stored["rejected"],
        "knowledgePoints": stored["knowledge_points"],
    }, latest_attempt


def _validate_run_document(
    row: dict[str, Any], projected_document: dict[str, object]
) -> None:
    document_id = projected_document["document_id"]
    chunk_id = projected_document["chunk_id"]
    filename = projected_document["filename"]
    source_type = projected_document["source_type"]
    text = projected_document["text"]
    try:
        require_opaque_id(document_id, "doc")
        require_opaque_id(chunk_id, "ck")
        encoded = text.encode("utf-8") if isinstance(text, str) else None
    except (CoreProblem, UnicodeError) as exc:
        raise _derived_state_mismatch("run document projection is invalid") from exc
    if (
        not isinstance(filename, str)
        or not FILENAME_MIN_CHARS <= len(filename) <= FILENAME_MAX_CHARS
        or filename in (".", "..")
        or "/" in filename
        or "\\" in filename
        or "\x00" in filename
        or any(0xD800 <= ord(character) <= 0xDFFF for character in filename)
        or projected_document["stored_document_id"] != document_id
        or projected_document["course_id"] != FIXTURE_COURSE_ID
        or source_type not in _SOURCE_MEDIA_TYPES
        or projected_document["page_count"] is not None
        or projected_document["file_path"] is not None
        or projected_document["chunk_seq"] != 0
        or projected_document["char_offset"] != 0
        or projected_document["chunk_state"] != "parsed"
        or not isinstance(text, str)
        or not text
        or any(
            0xD800 <= ord(character) <= 0xDFFF
            or (ord(character) < 0x20 and character not in ("\t", "\n"))
            or character == "\r"
            for character in text
        )
        or encoded is None
        or len(encoded) > MAX_DOCUMENT_BYTES
        or type(row["byte_size"]) is not int
        or row["byte_size"] != len(encoded)
        or type(row["character_count"]) is not int
        or row["character_count"] != len(text)
        or row["document_sha256"] != hashlib.sha256(encoded).hexdigest()
    ):
        raise _derived_state_mismatch("run document projection is invalid")


def _validate_exact_evidence(
    evidence: list[dict[str, object]], canonical_text: str
) -> None:
    if not _valid_stored_evidence(evidence):
        raise _derived_state_mismatch("evidence projection is invalid")
    for item in evidence:
        start = int(item["textStart"])
        end = int(item["textEnd"])
        if (
            end > len(canonical_text)
            or canonical_text[start:end] != item["quote"]
            or canonical_text[
                max(0, start - EVIDENCE_CONTEXT_MAX_CHARS) : start
            ]
            != item["contextBefore"]
            or canonical_text[end : end + EVIDENCE_CONTEXT_MAX_CHARS]
            != item["contextAfter"]
        ):
            raise _derived_state_mismatch("evidence is not exact")


def _formal_content_hash(
    *,
    candidate_type: str,
    title: str,
    statement: str,
    document_id: str,
    evidence: list[dict[str, object]],
) -> str:
    return hashlib.sha256(
        _canonical_json(
            {
                "type": candidate_type,
                "title": title,
                "statement": statement,
                "documentId": document_id,
                "evidence": evidence,
            }
        ).encode("utf-8")
    ).hexdigest()


def _validate_formal_point(
    con: sqlite3.Connection,
    row: dict[str, Any],
    *,
    document_id: str,
    chunk_id: str,
    candidate_type: str,
    title: str,
    statement: str,
    evidence: list[dict[str, object]],
    canonical_text: str,
    reviewed_at: str | None = None,
) -> None:
    try:
        require_opaque_id(row["id"], "kp")
        require_opaque_id(row["document_id"], "doc")
        require_opaque_id(row["chunk_id"], "ck")
    except CoreProblem as exc:
        raise _derived_state_mismatch("knowledge point identifiers are invalid") from exc
    formal_evidence = knowledge_point_evidence(con, str(row["id"]))
    if (
        row["course_id"] != FIXTURE_COURSE_ID
        or row["document_id"] != document_id
        or row["chunk_id"] != chunk_id
        or row["type"] != candidate_type
        or row["title"] != title
        or row["content"] != statement
        or row["origin"] != "extracted"
        or row["status"] != "confirmed"
        or not isinstance(row["created_at"], str)
        or not row["created_at"]
        or row["updated_at"] != row["created_at"]
        or (
            reviewed_at is not None
            and row["created_at"] != reviewed_at
        )
        or not formal_evidence
        or any(
            item["chunk_id"] != chunk_id
            or item["align_method"] != "exact"
            or item["locator_confidence"] != 1.0
            for item in formal_evidence
        )
    ):
        raise _derived_state_mismatch("knowledge point projection is invalid")
    public_formal_evidence = _public_evidence(formal_evidence)
    _validate_exact_evidence(public_formal_evidence, canonical_text)
    if (
        public_formal_evidence != evidence
        or row["content_hash"]
        != _formal_content_hash(
            candidate_type=candidate_type,
            title=title,
            statement=statement,
            document_id=document_id,
            evidence=evidence,
        )
    ):
        raise _derived_state_mismatch("knowledge point content is inconsistent")


def _validate_candidate_lifecycle(con: sqlite3.Connection, row: dict[str, Any]) -> None:
    candidate_id = str(row["id"])
    run_id = str(row["job_id"])
    status = str(row["review_status"])
    accepted_kp_id = row["accepted_kp_id"]
    events = read_candidate_review_events(con, run_id, candidate_id)
    logs = read_candidate_confirmation_logs(
        con,
        candidate_id,
        str(accepted_kp_id) if accepted_kp_id is not None else None,
    )
    if status == "pending":
        valid = (
            row["revision"] == 1
            and row["reviewed_at"] is None
            and accepted_kp_id is None
            and not events
            and not logs
        )
    else:
        expected_event = {
            "accepted": "candidate.accepted",
            "edited_and_accepted": "candidate.edited_and_accepted",
            "rejected": "candidate.rejected",
        }.get(status)
        expected_action = {
            "accepted": "accepted_without_edit",
            "edited_and_accepted": "accepted_with_edit",
            "rejected": "rejected",
        }.get(status)
        expected_subject = candidate_id if status == "rejected" else accepted_kp_id
        expected_fields = (
            '["title","content"]' if status == "edited_and_accepted" else "[]"
        )
        valid = (
            expected_event is not None
            and expected_action is not None
            and row["revision"] == 2
            and isinstance(row["reviewed_at"], str)
            and bool(row["reviewed_at"])
            and events == [expected_event]
            and len(logs) == 1
            and logs[0]["subject_id"] == expected_subject
            and logs[0]["support_label"] is None
            and logs[0]["action"] == expected_action
            and logs[0]["edited_fields"] == expected_fields
            and logs[0]["merged_into"] is None
            and logs[0]["granularity"] is None
            and logs[0]["elapsed_sec"] is None
            and logs[0]["confirmed_at"] == row["reviewed_at"]
        )
        if logs:
            try:
                require_opaque_id(logs[0]["id"], "cfl")
            except CoreProblem:
                valid = False
    if not valid:
        raise _derived_state_mismatch("candidate review lifecycle is inconsistent")


def _run_snapshot(
    con: sqlite3.Connection, row: dict[str, Any], contract: CandidateContract
) -> dict[str, object]:
    projected_document = _require_run_document(con, row["job_id"])
    document_id = projected_document["document_id"]
    filename = projected_document["filename"]
    source_type = projected_document["source_type"]
    text = projected_document["text"]
    _validate_run_document(row, projected_document)
    last_event_seq = run_last_event_seq(con, str(row["job_id"]))
    if last_event_seq < 1:
        raise _derived_state_mismatch("run event sequence is invalid")
    counts, latest_attempt = _run_count_snapshot(con, row, contract, str(text))
    snapshot = {
        "runId": row["job_id"],
        "documentId": document_id,
        "status": row["status"],
        "stage": row["stage"],
        "revision": row["revision"],
        "retryCount": row["retry_count"],
        "lastEventSeq": last_event_seq,
        "counts": counts,
        "error": _run_error_snapshot(row, latest_attempt),
        "document": {
            "filename": filename,
            "mediaType": _SOURCE_MEDIA_TYPES[source_type],
            "byteSize": row["byte_size"],
            "characterCount": row["character_count"],
            "text": text,
        },
    }
    if latest_attempt is not None:
        snapshot["modelSelection"] = _decode_model_metadata(
            latest_attempt["model_metadata_json"]
        )
    return snapshot


def _candidate_snapshot(
    con: sqlite3.Connection, row: dict[str, Any], canonical_text: str
) -> dict[str, object]:
    try:
        require_opaque_id(row["id"], "cand")
        if row["accepted_kp_id"] is not None:
            require_opaque_id(row["accepted_kp_id"], "kp")
    except CoreProblem as exc:
        raise _derived_state_mismatch("candidate identifiers are invalid") from exc
    status = row["review_status"]
    accepted = status in ("accepted", "edited_and_accepted")
    if (
        not _valid_stored_id(row["job_id"], "job")
        or row["type"] not in CANDIDATE_TYPES
        or status not in CANDIDATE_REVIEW_STATUSES
        or not _valid_stored_text(row["title"], CANDIDATE_TITLE_MAX_CHARS)
        or not _valid_stored_text(
            row["statement"], CANDIDATE_STATEMENT_MAX_CHARS
        )
        or type(row["revision"]) is not int
        or row["revision"] < 1
        or accepted != (row["accepted_kp_id"] is not None)
        or (status in ("pending", "rejected") and row["accepted_kp_id"] is not None)
    ):
        raise _derived_state_mismatch("candidate projection is invalid")
    _validate_candidate_lifecycle(con, row)
    evidence = _public_evidence(candidate_evidence(con, str(row["id"])))
    _validate_exact_evidence(evidence, canonical_text)
    return _review_candidate_snapshot(row, evidence)


def _knowledge_point_snapshot(
    con: sqlite3.Connection,
    row: dict[str, Any],
    *,
    document_id: str,
    chunk_id: str,
    course_id: str,
    canonical_text: str,
) -> dict[str, object]:
    try:
        require_opaque_id(row["candidate_id"], "cand")
        require_opaque_id(row["id"], "kp")
        require_opaque_id(row["document_id"], "doc")
        require_opaque_id(row["chunk_id"], "ck")
    except CoreProblem as exc:
        raise _derived_state_mismatch("knowledge point identifiers are invalid") from exc
    if (
        row["review_status"] not in ("accepted", "edited_and_accepted")
        or row["accepted_kp_id"] != row["id"]
        or row["candidate_type"] != row["type"]
        or row["candidate_title"] != row["title"]
        or row["candidate_statement"] != row["content"]
        or row["course_id"] != course_id
        or row["document_id"] != document_id
        or row["chunk_id"] != chunk_id
        or row["origin"] != "extracted"
        or row["status"] != "confirmed"
        or not isinstance(row["candidate_reviewed_at"], str)
        or not row["candidate_reviewed_at"]
    ):
        raise _derived_state_mismatch("knowledge point projection is invalid")
    candidate_public_evidence = _public_evidence(
        candidate_evidence(con, str(row["candidate_id"]))
    )
    _validate_exact_evidence(candidate_public_evidence, canonical_text)
    _validate_formal_point(
        con,
        row,
        document_id=document_id,
        chunk_id=chunk_id,
        candidate_type=str(row["type"]),
        title=str(row["title"]),
        statement=str(row["content"]),
        evidence=candidate_public_evidence,
        canonical_text=canonical_text,
        reviewed_at=str(row["candidate_reviewed_at"]),
    )
    return _review_knowledge_point_snapshot(
        knowledge_point_id=str(row["id"]),
        candidate_type=str(row["type"]),
        title=str(row["title"]),
        statement=str(row["content"]),
        document_id=str(row["document_id"]),
        evidence=candidate_public_evidence,
    )


def _validate_event_semantics(
    con: sqlite3.Connection,
    *,
    run: dict[str, Any],
    counts: dict[str, int],
    run_id: str,
    document_id: str,
    event_type: str,
    event_stage: str,
    payload: dict[str, Any],
) -> None:
    expected_stage = (
        "confirm" if event_type == "candidates.ready" and payload["validCandidateCount"]
        else "verify" if event_type == "candidates.ready"
        else _EVENT_STAGES.get(event_type)
    )
    valid = expected_stage is not None and event_stage == expected_stage
    if event_type == "run.created":
        valid = valid and payload["runId"] == run_id
    elif event_type == "document.ready":
        valid = valid and payload["documentId"] == document_id
    elif event_type in (
        "generation.started",
        "generation.validating",
        "generation.failed",
    ):
        attempt = run_attempt_identity(con, run_id, str(payload["attemptId"]))
        valid = valid and attempt is not None
        if valid and event_type == "generation.started":
            valid = valid and attempt["attempt_number"] == payload["attemptNumber"]
        elif valid and event_type == "generation.failed":
            retryable = bool(
                GENERATION_RETRYABILITY[payload["code"]]
                and attempt["attempt_number"] == 1
            )
            valid = valid and (
                attempt["status"] == "failed"
                and attempt["error_code"] == payload["code"]
                and payload["retryable"] == retryable
            )
    elif event_type == "generation.awaiting":
        valid = valid and payload["retryCount"] == 0
    elif event_type == "generation.retry_requested":
        valid = valid and payload["retryCount"] == 1 and run["retry_count"] == 1
    elif event_type == "generation.interrupted":
        valid = valid and payload["reason"] == "core_interrupted"
    elif event_type == "candidates.ready":
        valid = valid and (
            payload["rawCandidateCount"] == counts["rawCandidates"]
            and payload["validCandidateCount"] == counts["validCandidates"]
        )
    elif event_type in (
        "candidate.accepted",
        "candidate.edited_and_accepted",
        "candidate.rejected",
    ):
        expected_status = {
            "candidate.accepted": "accepted",
            "candidate.edited_and_accepted": "edited_and_accepted",
            "candidate.rejected": "rejected",
        }[event_type]
        valid = valid and (
            candidate_run_status(con, run_id, str(payload["candidateId"]))
            == expected_status
        )
    elif event_type == "run.completed":
        valid = valid and (
            run["status"] == "completed"
            and (
                (
                    payload["reason"] == "zero_valid_candidates"
                    and counts["validCandidates"] == 0
                )
                or (
                    payload["reason"] == "reviewed_all"
                    and counts["validCandidates"] > 0
                    and counts["pending"] == 0
                )
            )
        )
    if not valid:
        raise _derived_state_mismatch("run event semantics are invalid")


def _valid_closed_model_metadata(value: object) -> bool:
    try:
        decoded = _decode_model_metadata(value)
    except CoreProblem:
        return False
    return bool(decoded)


def _validate_event_ledger(
    con: sqlite3.Connection,
    *,
    run: dict[str, Any],
    counts: dict[str, int],
    document_id: str,
    contract: CandidateContract,
) -> None:
    run_id = str(run["job_id"])
    ledger = read_run_event_ledger(con, run_id)
    attempts = read_run_attempts(con, run_id)
    attempt_by_id = {str(attempt["id"]): attempt for attempt in attempts}
    if (
        len(attempt_by_id) != len(attempts)
        or [attempt["attempt_number"] for attempt in attempts]
        != list(range(1, len(attempts) + 1))
        or len(ledger) < 3
    ):
        raise _derived_state_mismatch("run event ledger is invalid")
    state = "initial"
    active_attempt_id: str | None = None
    active_validating = False
    started_attempt_ids: set[str] = set()
    last_failed_attempt: dict[str, Any] | None = None
    prefix = ("run.created", "document.ready", "generation.awaiting")
    for index, event in enumerate(ledger):
        if event["seq"] != index + 1:
            raise _derived_state_mismatch("run event sequence is invalid")
        event_type = str(event["type"])
        payload = decode_event_payload(event_type, str(event["payload_json"]))
        _validate_event_semantics(
            con,
            run=run,
            counts=counts,
            run_id=run_id,
            document_id=document_id,
            event_type=event_type,
            event_stage=str(event["stage"]),
            payload=payload,
        )
        if index < 3:
            if event_type != prefix[index]:
                raise _derived_state_mismatch("run event prefix is invalid")
            if index == 2:
                state = "awaiting"
            continue
        if event_type == "generation.started":
            attempt_id = str(payload["attemptId"])
            attempt = attempt_by_id.get(attempt_id)
            expected_number = 1 if state == "awaiting" else 2
            if (
                state not in ("awaiting", "awaiting_retry")
                or active_attempt_id is not None
                or attempt is None
                or attempt["attempt_number"] != expected_number
                or attempt_id in started_attempt_ids
            ):
                raise _derived_state_mismatch("generation start lifecycle is invalid")
            active_attempt_id = attempt_id
            active_validating = False
            started_attempt_ids.add(attempt_id)
            state = "active"
        elif event_type == "generation.validating":
            if (
                state != "active"
                or str(payload["attemptId"]) != active_attempt_id
                or active_validating
            ):
                raise _derived_state_mismatch("generation validation lifecycle is invalid")
            active_validating = True
        elif event_type == "generation.failed":
            attempt = attempt_by_id.get(str(payload["attemptId"]))
            retryable = bool(
                GENERATION_RETRYABILITY[payload["code"]]
                and attempt is not None
                and attempt["attempt_number"] == 1
            )
            if (
                state != "active"
                or str(payload["attemptId"]) != active_attempt_id
                or attempt is None
                or attempt["status"] != "failed"
                or attempt["error_code"] != payload["code"]
                or payload["retryable"] != retryable
                or not _valid_closed_model_metadata(attempt["model_metadata_json"])
            ):
                raise _derived_state_mismatch("generation failure lifecycle is invalid")
            _validate_failed_attempt_output(attempt, contract)
            last_failed_attempt = attempt
            active_attempt_id = None
            active_validating = False
            state = "failed"
        elif event_type == "generation.interrupted":
            attempt = attempt_by_id.get(active_attempt_id or "")
            if (
                state != "active"
                or attempt is None
                or attempt["status"] != "failed"
                or attempt["error_code"] != "GENERATION_PROVIDER_ERROR"
                or not _valid_closed_model_metadata(attempt["model_metadata_json"])
                or attempt["raw_output_json"] is not None
            ):
                raise _derived_state_mismatch("generation recovery lifecycle is invalid")
            last_failed_attempt = attempt
            active_attempt_id = None
            active_validating = False
            state = "failed"
        elif event_type == "generation.retry_requested":
            if (
                state != "failed"
                or last_failed_attempt is None
                or last_failed_attempt["attempt_number"] != 1
                or not GENERATION_RETRYABILITY[str(last_failed_attempt["error_code"])]
            ):
                raise _derived_state_mismatch("generation retry lifecycle is invalid")
            state = "awaiting_retry"
        elif event_type == "candidates.ready":
            attempt = attempt_by_id.get(active_attempt_id or "")
            if (
                state != "active"
                or not active_validating
                or attempt is None
                or attempt["status"] != "succeeded"
                or attempt["error_code"] is not None
                or not _valid_closed_model_metadata(attempt["model_metadata_json"])
            ):
                raise _derived_state_mismatch("candidate-ready lifecycle is invalid")
            active_attempt_id = None
            active_validating = False
            state = "candidates"
        elif event_type in (
            "candidate.accepted",
            "candidate.edited_and_accepted",
            "candidate.rejected",
        ):
            if state != "candidates":
                raise _derived_state_mismatch("candidate review lifecycle is invalid")
        elif event_type == "run.completed":
            if state != "candidates":
                raise _derived_state_mismatch("run completion lifecycle is invalid")
            state = "completed"
        else:
            raise _derived_state_mismatch("run event lifecycle is invalid")
    expected_state = {
        "awaiting_generation": "awaiting_retry" if run["retry_count"] else "awaiting",
        "generating": "active",
        "validating": "active",
        "failed_retryable": "failed",
        "failed_terminal": "failed",
        "review_pending": "candidates",
        "completed": "completed",
    }.get(str(run["status"]))
    if (
        expected_state != state
        or started_attempt_ids != set(attempt_by_id)
        or (run["status"] == "generating" and active_validating)
        or (run["status"] == "validating" and not active_validating)
        or (
            active_attempt_id is not None
            and not _active_attempt_has_unwritten_defaults(
                attempt_by_id[active_attempt_id]
            )
        )
    ):
        raise _derived_state_mismatch("run event ledger terminal state is invalid")


def _submission_statistics(
    *,
    raw_candidate_count: int,
    schema_valid_evidence_count: int,
    exact_evidence_count: int,
    valid_candidate_count: int,
    rejection_counts: dict[str, int],
) -> dict[str, object]:
    exact_evidence_yield = (
        exact_evidence_count / schema_valid_evidence_count
        if schema_valid_evidence_count
        else 0.0
    )
    return {
        "rawCandidateCount": raw_candidate_count,
        "schemaValidEvidenceCount": schema_valid_evidence_count,
        "exactEvidenceCount": exact_evidence_count,
        "validCandidateCount": valid_candidate_count,
        "rejectionCounts": dict(sorted(rejection_counts.items())),
        "exactEvidenceYield": exact_evidence_yield,
    }


@contextmanager
def _transactional_write(database: Phase1Database, failure_message: str):
    try:
        with database.write_transaction() as con:
            yield con
    except CoreProblem:
        raise
    except Exception as exc:
        raise CoreProblem("TRANSACTION_FAILED", failure_message) from exc


def _create_import_in_transaction(
    con: sqlite3.Connection,
    contract: CandidateContract,
    *,
    filename: str,
    media_type: str,
    canonical: str,
    encoded: bytes,
) -> dict[str, object]:
    document_id = new_opaque_id("doc")
    chunk_id = new_opaque_id("ck")
    run_id = new_opaque_id("job")
    digest = hashlib.sha256(encoded).hexdigest()
    created_at = now_iso()
    con.execute(
        "INSERT INTO documents(id,course_id,name,source_type,page_count,imported_at,file_path) "
        "VALUES(?,?,?,?,?,?,?)",
        (
            document_id,
            FIXTURE_COURSE_ID,
            filename,
            _MEDIA_SOURCE_TYPES[media_type],
            None,
            created_at,
            None,
        ),
    )
    con.execute(
        "INSERT INTO chunks(id,document_id,seq,char_offset,text,state,created_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (chunk_id, document_id, 0, 0, canonical, "parsed", created_at),
    )
    con.execute(
        "INSERT INTO import_jobs(id,document_id,stage,status,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?)",
        (run_id, document_id, "source", "pending", created_at, created_at),
    )
    con.execute(
        "INSERT INTO p1_run_control("
        "job_id,mode,status,stage,revision,schema_version,schema_sha256,prompt_version,"
        "retry_count,document_sha256,byte_size,character_count,created_at,updated_at"
        ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            run_id,
            "l1",
            "created",
            "source",
            1,
            contract.schema_version,
            contract.schema_sha256,
            _PROMPT_VERSION,
            0,
            digest,
            len(encoded),
            len(canonical),
            created_at,
            created_at,
        ),
    )
    append_event(con, run_id, "run.created", "source", {"runId": run_id})
    _advance_import_milestone(con, run_id, "created", "document_ready")
    append_event(
        con,
        run_id,
        "document.ready",
        "parse",
        {"documentId": document_id},
    )
    _advance_import_milestone(con, run_id, "document_ready", "awaiting_generation")
    append_event(
        con,
        run_id,
        "generation.awaiting",
        "extract",
        {"retryCount": 0},
    )
    return {"documentId": document_id, "runId": run_id, "revision": 1}


def _prepare_generation_in_transaction(
    con: sqlite3.Connection,
    contract: CandidateContract,
    run_id: str,
    model_selection: dict[str, str] | None = None,
) -> dict[str, object]:
    row = require_run(con, run_id)
    if row["status"] != "awaiting_generation":
        raise CoreProblem("RUN_STATE_CONFLICT", "run is not awaiting generation")
    assert_projection(con, row)
    attempt_number = row["retry_count"] + 1
    if attempt_number not in (1, 2):
        raise CoreProblem("RUN_STATE_CONFLICT", "generation retry budget is exhausted")
    if attempt_number == 1:
        if model_selection is None:
            raise CoreProblem("INVALID_PARAMS", "model selection is required")
        persisted_model_selection = dict(model_selection)
    else:
        if model_selection is not None:
            raise CoreProblem("INVALID_PARAMS", "retry cannot replace model selection")
        first_attempt = con.execute(
            "SELECT model_metadata_json FROM p1_generation_attempts "
            "WHERE job_id=? AND attempt_number=1",
            (run_id,),
        ).fetchone()
        if first_attempt is None:
            raise CoreProblem("DERIVED_STATE_MISMATCH", "first generation attempt is missing")
        persisted_model_selection = _decode_model_metadata(
            first_attempt["model_metadata_json"]
        )
    model_metadata_json = _canonical_json(persisted_model_selection)
    document = _require_run_document(con, run_id)
    request_digest = _generation_request_digest(
        row, attempt_number, persisted_model_selection
    )
    attempt_id = new_opaque_id("att")
    provider_idempotency_key = "nobei:" + request_digest
    insert_generation_attempt(
        con,
        attempt_id=attempt_id,
        run_id=run_id,
        attempt_number=attempt_number,
        request_digest=request_digest,
        provider_idempotency_key=provider_idempotency_key,
        model_metadata_json=model_metadata_json,
    )
    transitioned = transition_run(
        con,
        run_id,
        "awaiting_generation",
        "generating",
        "generation.started",
        {"attemptId": attempt_id, "attemptNumber": attempt_number},
    )
    return {
        "runId": run_id,
        "attemptId": attempt_id,
        "attemptNumber": attempt_number,
        "revision": transitioned["revision"],
        "schemaVersion": contract.schema_version,
        "schemaSha256": contract.schema_sha256,
        "promptVersion": row["prompt_version"],
        "document": {"text": document["text"], "sha256": row["document_sha256"]},
        "requestDigest": request_digest,
        "providerIdempotencyKey": provider_idempotency_key,
        "modelSelection": dict(persisted_model_selection),
    }


def _request_retry_in_transaction(
    con: sqlite3.Connection,
    *,
    run_id: str,
    expected_revision: int,
) -> dict[str, Any]:
    row = require_run(con, run_id)
    if row["status"] != "failed_retryable" or row["retry_count"] != 0:
        raise CoreProblem("RUN_STATE_CONFLICT", "run cannot be retried")
    assert_projection(con, row)
    if row["revision"] != expected_revision:
        raise CoreProblem("RUN_STATE_CONFLICT", "run revision changed")
    request_retry(con, run_id=run_id, expected_revision=expected_revision)
    return transition_run(
        con,
        run_id,
        "failed_retryable",
        "awaiting_generation",
        "generation.retry_requested",
        {"retryCount": 1},
    )


class Phase1Core:
    """Small explicit seam over one opened database and one loaded contract."""

    def __init__(self, database: Phase1Database, contract: CandidateContract) -> None:
        self._database = database
        self._contract = contract

    def hello(self, params: object) -> dict[str, object]:
        command = _require_params(
            params,
            frozenset({"protocolVersion", "schemaVersion", "schemaSha256"}),
        )
        if (
            type(command["protocolVersion"]) is not int
            or command["protocolVersion"] != 3
            or type(command["schemaVersion"]) is not int
            or command["schemaVersion"] != self._contract.schema_version
            or not isinstance(command["schemaSha256"], str)
            or command["schemaSha256"] == "__RUNTIME_SCHEMA_SHA256__"
            or command["schemaSha256"] != self._contract.schema_sha256
        ):
            raise CoreProblem("PROTOCOL_MISMATCH", "protocol identity does not match")
        return {
            "protocolVersion": 3,
            "coreVersion": "phase1e",
            "databaseKind": "sqlite",
            "capabilities": [
                "l1-text-extraction",
                "atomic-generation-commands",
                "model-selection-snapshot",
            ],
            "schemaVersion": self._contract.schema_version,
            "schemaSha256": self._contract.schema_sha256,
            "dataRootKind": "isolated-phase1",
        }

    def import_text(self, params: object) -> dict[str, object]:
        filename, media_type, canonical, encoded = _normalize_document(params)
        with self._database.write_transaction() as con:
            return _create_import_in_transaction(
                con,
                self._contract,
                filename=filename,
                media_type=media_type,
                canonical=canonical,
                encoded=encoded,
            )

    def import_and_prepare_generation(self, params: object) -> dict[str, object]:
        command = _require_params(
            params, frozenset({"filename", "mediaType", "text", "modelSelection"})
        )
        model_selection = _require_model_metadata(command["modelSelection"])
        filename, media_type, canonical, encoded = _normalize_document(
            {
                "filename": command["filename"],
                "mediaType": command["mediaType"],
                "text": command["text"],
            }
        )
        with _transactional_write(self._database, "atomic import failed") as con:
            imported = _create_import_in_transaction(
                con,
                self._contract,
                filename=filename,
                media_type=media_type,
                canonical=canonical,
                encoded=encoded,
            )
            return _prepare_generation_in_transaction(
                con,
                self._contract,
                str(imported["runId"]),
                model_selection,
            )

    def prepare_generation(self, params: object) -> dict[str, object]:
        if not isinstance(params, dict) or frozenset(params) not in (
            frozenset({"runId"}),
            frozenset({"runId", "modelSelection"}),
        ):
            raise CoreProblem("INVALID_PARAMS", "command parameters are invalid")
        command = params
        run_id = require_opaque_id(command["runId"], "job")
        model_selection = (
            _require_model_metadata(command["modelSelection"])
            if "modelSelection" in command
            else None
        )
        with self._database.write_transaction() as con:
            return _prepare_generation_in_transaction(
                con, self._contract, run_id, model_selection
            )

    def fail_generation(self, params: object) -> dict[str, object]:
        command = _require_params(
            params,
            frozenset({"runId", "attemptId", "expectedRevision", "code"}),
        )
        run_id = require_opaque_id(command["runId"], "job")
        attempt_id = require_opaque_id(command["attemptId"], "att")
        expected_revision = _require_expected_revision(command["expectedRevision"])
        code = command["code"]
        if not isinstance(code, str) or code not in GENERATION_RETRYABILITY:
            raise CoreProblem("INVALID_PARAMS", "generation error code is invalid")
        with self._database.write_transaction() as con:
            row = require_run(con, run_id)
            if row["status"] not in ("generating", "validating"):
                raise CoreProblem("RUN_STATE_CONFLICT", "run is not generating")
            assert_projection(con, row)
            if row["revision"] != expected_revision:
                raise CoreProblem("RUN_STATE_CONFLICT", "run revision changed")
            attempt = require_current_attempt(con, run_id)
            if attempt["id"] != attempt_id or attempt["status"] != "started":
                raise CoreProblem("ATTEMPT_MISMATCH", "generation attempt is not current")
            _decode_model_metadata(attempt["model_metadata_json"])
            retryable = bool(GENERATION_RETRYABILITY[code] and row["retry_count"] == 0)
            target = "failed_retryable" if retryable else "failed_terminal"
            mark_attempt_failed(
                con,
                attempt_id=attempt_id,
                run_id=run_id,
                error_code=code,
            )
            set_run_error(
                con,
                run_id=run_id,
                expected_status=row["status"],
                expected_revision=expected_revision,
                error_code=code,
            )
            transitioned = transition_run(
                con,
                run_id,
                row["status"],
                target,
                "generation.failed",
                {"attemptId": attempt_id, "code": code, "retryable": retryable},
            )
            return {
                "run": _run_snapshot(con, transitioned, self._contract),
                "error": {"code": code, "retryable": retryable},
            }

    def submit_generation(self, params: object) -> dict[str, object]:
        command = _require_params(
            params,
            frozenset({"runId", "attemptId", "expectedRevision", "output"}),
        )
        run_id = require_opaque_id(command["runId"], "job")
        attempt_id = require_opaque_id(command["attemptId"], "att")
        expected_revision = _require_expected_revision(command["expectedRevision"])
        raw_output = command["output"]
        if not isinstance(raw_output, dict):
            raise CoreProblem("INVALID_PARAMS", "generation output must be an object")
        # Transaction A makes validation externally observable and leaves a state that
        # Task 6 can recover if this process exits before Transaction B.
        with _transactional_write(
            self._database, "candidate submission failed"
        ) as con:
            row = require_run(con, run_id)
            if row["status"] != "generating":
                raise CoreProblem("RUN_STATE_CONFLICT", "run is not generating")
            assert_projection(con, row)
            if row["revision"] != expected_revision:
                raise CoreProblem("RUN_STATE_CONFLICT", "run revision changed")
            attempt = require_current_attempt(con, run_id)
            if attempt["id"] != attempt_id or attempt["status"] != "started":
                raise CoreProblem("ATTEMPT_MISMATCH", "generation attempt is not current")
            _decode_model_metadata(attempt["model_metadata_json"])
            document = _require_run_document(con, run_id)
            validating = transition_run(
                con,
                run_id,
                "generating",
                "validating",
                "generation.validating",
                {"attemptId": attempt_id},
            )
            validating_revision = int(validating["revision"])
            canonical_document_id = str(document["document_id"])
            canonical_text = str(document["text"])
            canonical_document_sha256 = str(row["document_sha256"])

        raw_output_json: str | None = None
        validation_failed = False
        try:
            encoded = _canonical_json(raw_output)
            if len(encoded.encode("utf-8")) > MAX_RAW_GENERATION_OUTPUT_BYTES:
                validation_failed = True
            else:
                raw_output_json = encoded
        except (TypeError, ValueError, UnicodeError, RecursionError):
            validation_failed = True

        if not validation_failed and self._contract.validate(raw_output):
            validation_failed = True
        if validation_failed:
            return self._record_submission_failure(
                run_id=run_id,
                attempt_id=attempt_id,
                expected_revision=validating_revision,
                raw_output_json=raw_output_json,
            )

        candidates = raw_output["candidates"]
        schema_valid_evidence_count = sum(
            len(candidate["evidence"]) for candidate in candidates
        )
        exact_evidence_count = 0
        rejection_counts: dict[str, int] = {}
        surviving_candidates: list[dict[str, object]] = []
        for ordinal, candidate in enumerate(candidates):
            exact_rows: list[dict[str, object]] = []
            for seq, evidence in enumerate(candidate["evidence"]):
                try:
                    located = locate_evidence(canonical_text, evidence)
                except CoreProblem as problem:
                    if problem.code not in ("EVIDENCE_NOT_FOUND", "EVIDENCE_AMBIGUOUS"):
                        raise
                    rejection_counts[problem.code] = rejection_counts.get(problem.code, 0) + 1
                    continue
                exact_evidence_count += 1
                exact_rows.append(
                    {
                        "seq": seq,
                        "quote": evidence["quote"],
                        "text_start": located.text_start,
                        "text_end": located.text_end,
                        "context_before": located.context_before,
                        "context_after": located.context_after,
                    }
                )
            if exact_rows:
                surviving_candidates.append(
                    {
                        "id": new_opaque_id("cand"),
                        "ordinal": ordinal,
                        "type": candidate["type"],
                        "title": candidate["title"],
                        "statement": candidate["statement"],
                        "evidence": exact_rows,
                    }
                )

        statistics = _submission_statistics(
            raw_candidate_count=len(candidates),
            schema_valid_evidence_count=schema_valid_evidence_count,
            exact_evidence_count=exact_evidence_count,
            valid_candidate_count=len(surviving_candidates),
            rejection_counts=rejection_counts,
        )

        # Transaction B reasserts all identity/revision/document invariants before
        # atomically making any candidate or success fact visible.
        with _transactional_write(
            self._database, "candidate submission failed"
        ) as con:
            row = require_run(con, run_id)
            if row["status"] != "validating":
                raise CoreProblem("RUN_STATE_CONFLICT", "run is not validating")
            assert_projection(con, row)
            if row["revision"] != validating_revision:
                raise CoreProblem("RUN_STATE_CONFLICT", "run revision changed")
            attempt = require_current_attempt(con, run_id)
            if attempt["id"] != attempt_id or attempt["status"] != "started":
                raise CoreProblem("ATTEMPT_MISMATCH", "generation attempt is not current")
            current_document = _require_run_document(con, run_id)
            if (
                current_document["document_id"] != canonical_document_id
                or current_document["text"] != canonical_text
                or hashlib.sha256(str(current_document["text"]).encode("utf-8")).hexdigest()
                != canonical_document_sha256
                or row["document_sha256"] != canonical_document_sha256
            ):
                raise CoreProblem(
                    "DERIVED_STATE_MISMATCH", "run document projection changed"
                )
            mark_attempt_succeeded(
                con,
                attempt_id=attempt_id,
                run_id=run_id,
                raw_output_json=raw_output_json,
            )
            update_generation_statistics(
                con,
                run_id=run_id,
                expected_revision=validating_revision,
                raw_candidate_count=int(statistics["rawCandidateCount"]),
                schema_valid_evidence_count=int(statistics["schemaValidEvidenceCount"]),
                exact_evidence_count=int(statistics["exactEvidenceCount"]),
                valid_candidate_count=int(statistics["validCandidateCount"]),
                rejection_counts=rejection_counts,
            )
            for candidate in surviving_candidates:
                insert_candidate(
                    con,
                    candidate_id=str(candidate["id"]),
                    run_id=run_id,
                    ordinal=int(candidate["ordinal"]),
                    candidate_type=str(candidate["type"]),
                    title=str(candidate["title"]),
                    statement=str(candidate["statement"]),
                    evidence=candidate["evidence"],
                )
            valid_candidate_count = len(surviving_candidates)
            if valid_candidate_count:
                transitioned = transition_run(
                    con,
                    run_id,
                    "validating",
                    "review_pending",
                    "candidates.ready",
                    {
                        "rawCandidateCount": len(candidates),
                        "validCandidateCount": valid_candidate_count,
                    },
                )
            else:
                append_event(
                    con,
                    run_id,
                    "candidates.ready",
                    "verify",
                    {"rawCandidateCount": len(candidates), "validCandidateCount": 0},
                )
                transitioned = transition_run(
                    con,
                    run_id,
                    "validating",
                    "completed",
                    "run.completed",
                    {"reason": "zero_valid_candidates"},
                )
            return {
                "run": _run_snapshot(con, transitioned, self._contract),
                "statistics": statistics,
            }

    def _record_submission_failure(
        self,
        *,
        run_id: str,
        attempt_id: str,
        expected_revision: int,
        raw_output_json: str | None,
    ) -> dict[str, object]:
        code = "GENERATION_SCHEMA_INVALID"
        with _transactional_write(
            self._database, "candidate submission failed"
        ) as con:
            row = require_run(con, run_id)
            if row["status"] != "validating":
                raise CoreProblem("RUN_STATE_CONFLICT", "run is not validating")
            assert_projection(con, row)
            if row["revision"] != expected_revision:
                raise CoreProblem("RUN_STATE_CONFLICT", "run revision changed")
            attempt = require_current_attempt(con, run_id)
            if attempt["id"] != attempt_id or attempt["status"] != "started":
                raise CoreProblem("ATTEMPT_MISMATCH", "generation attempt is not current")
            retryable = bool(GENERATION_RETRYABILITY[code] and row["retry_count"] == 0)
            target = "failed_retryable" if retryable else "failed_terminal"
            mark_attempt_failed(
                con,
                attempt_id=attempt_id,
                run_id=run_id,
                error_code=code,
                raw_output_json=raw_output_json,
            )
            set_run_error(
                con,
                run_id=run_id,
                expected_status="validating",
                expected_revision=expected_revision,
                error_code=code,
            )
            transitioned = transition_run(
                con,
                run_id,
                "validating",
                target,
                "generation.failed",
                {"attemptId": attempt_id, "code": code, "retryable": retryable},
            )
            return {
                "run": _run_snapshot(con, transitioned, self._contract),
                "error": {"code": code, "retryable": retryable},
            }

    def review_candidate(self, params: object) -> dict[str, object]:
        command, candidate_id, expected_revision, idempotency_key = (
            _require_review_command(params)
        )
        action = str(command["action"])

        with _transactional_write(self._database, "candidate review failed") as con:
            replay = find_idempotency_result(con, idempotency_key)
            if replay is not None:
                restored = _decode_review_result(replay["result_json"])
                restored_candidate = restored["candidate"]
                if not isinstance(restored_candidate, dict):
                    raise _stored_result_invalid()
                digest_title = (
                    str(command["title"])
                    if action == "edited_and_accept"
                    else str(restored_candidate["title"])
                )
                digest_statement = (
                    str(command["statement"])
                    if action == "edited_and_accept"
                    else str(restored_candidate["statement"])
                )
                request_digest = _review_request_digest(
                    candidate_id=candidate_id,
                    action=action,
                    title=digest_title,
                    statement=digest_statement,
                    expected_revision=expected_revision,
                )
                if replay["request_digest"] != request_digest:
                    raise CoreProblem(
                        "IDEMPOTENCY_CONFLICT", "idempotency key was already used"
                    )
                _validate_replay_semantics(
                    restored,
                    command=command,
                    candidate_id=candidate_id,
                    action=action,
                    expected_revision=expected_revision,
                )
                _validate_replay_persistence(con, restored)
                return restored

            candidate = require_candidate(con, candidate_id)
            final_title = (
                str(command["title"])
                if action == "edited_and_accept"
                else str(candidate["title"])
            )
            final_statement = (
                str(command["statement"])
                if action == "edited_and_accept"
                else str(candidate["statement"])
            )
            request_digest = _review_request_digest(
                candidate_id=candidate_id,
                action=action,
                title=final_title,
                statement=final_statement,
                expected_revision=expected_revision,
            )

            if candidate["review_status"] != "pending":
                raise CoreProblem(
                    "CANDIDATE_ALREADY_REVIEWED", "candidate is already reviewed"
                )
            if candidate["revision"] != expected_revision:
                raise CoreProblem("REVISION_CONFLICT", "candidate revision changed")

            run_id = str(candidate["job_id"])
            run = require_run(con, run_id)
            if run["status"] != "review_pending":
                raise CoreProblem("RUN_STATE_CONFLICT", "run is not awaiting review")
            assert_projection(con, run)
            document = _require_run_document(con, run_id)
            document_id = str(document["document_id"])
            chunk_id = str(document["chunk_id"])
            stored_evidence = candidate_evidence(con, candidate_id)
            public_evidence = _public_evidence(stored_evidence)
            review_status, confirmation_action, event_type = REVIEW_ACTION_MAPPING[action]
            accepted = action != "reject"
            reviewed_at = now_iso()
            knowledge_point_id: str | None = None
            knowledge_point: dict[str, object] | None = None

            if accepted:
                knowledge_point_id = new_opaque_id("kp")
                content_hash = _formal_content_hash(
                    candidate_type=str(candidate["type"]),
                    title=final_title,
                    statement=final_statement,
                    document_id=document_id,
                    evidence=public_evidence,
                )
                extraction_model = latest_extraction_model(con, run_id)
                insert_formal_knowledge_point(
                    con,
                    knowledge_point_id=knowledge_point_id,
                    document_id=document_id,
                    chunk_id=chunk_id,
                    candidate_type=str(candidate["type"]),
                    title=final_title,
                    statement=final_statement,
                    extraction_model=extraction_model,
                    extraction_prompt_version=str(run["prompt_version"]),
                    content_hash=content_hash,
                    created_at=reviewed_at,
                )
                insert_formal_evidence(
                    con,
                    knowledge_point_id=knowledge_point_id,
                    chunk_id=chunk_id,
                    evidence=stored_evidence,
                )
                knowledge_point = _review_knowledge_point_snapshot(
                    knowledge_point_id=knowledge_point_id,
                    candidate_type=str(candidate["type"]),
                    title=final_title,
                    statement=final_statement,
                    document_id=document_id,
                    evidence=public_evidence,
                )

            insert_confirmation_log(
                con,
                subject_id=knowledge_point_id if accepted else candidate_id,
                action=confirmation_action,
                edited_fields_json=(
                    '["title","content"]'
                    if action == "edited_and_accept"
                    else "[]"
                ),
                confirmed_at=reviewed_at,
            )
            close_candidate_review(
                con,
                candidate_id=candidate_id,
                expected_revision=expected_revision,
                review_status=review_status,
                final_title=final_title,
                final_statement=final_statement,
                knowledge_point_id=knowledge_point_id,
                accepted_increment=1 if accepted else 0,
                reviewed_at=reviewed_at,
            )
            append_event(
                con,
                run_id,
                event_type,
                "confirm",
                {"candidateId": candidate_id},
                created_at=reviewed_at,
            )

            pending = con.execute(
                "SELECT COUNT(*) AS pending FROM p1_candidates "
                "WHERE job_id=? AND review_status='pending'",
                (run_id,),
            ).fetchone()
            if pending is None:
                raise CoreProblem(
                    "DERIVED_STATE_MISMATCH", "candidate review count is invalid"
                )
            complete = int(pending["pending"]) == 0
            updated_run = update_run_after_review(
                con,
                run_id=run_id,
                expected_revision=int(run["revision"]),
                accepted_increment=1 if accepted else 0,
                complete=complete,
                reviewed_at=reviewed_at,
            )

            updated_candidate = require_candidate(con, candidate_id)
            result = {
                "candidate": _review_candidate_snapshot(
                    updated_candidate, public_evidence
                ),
                "run": _run_snapshot(con, updated_run, self._contract),
                "knowledgePoint": knowledge_point,
            }
            result_json = _encode_review_result(result)
            store_idempotency_result(
                con,
                idempotency_key=idempotency_key,
                request_digest=request_digest,
                result_json=result_json,
                created_at=reviewed_at,
            )
            return json.loads(result_json)

    def retry(self, params: object) -> dict[str, object]:
        command = _require_params(params, frozenset({"runId", "expectedRevision"}))
        run_id = require_opaque_id(command["runId"], "job")
        expected_revision = _require_expected_revision(command["expectedRevision"])
        with self._database.write_transaction() as con:
            transitioned = _request_retry_in_transaction(
                con, run_id=run_id, expected_revision=expected_revision
            )
            return _run_snapshot(con, transitioned, self._contract)

    def retry_and_prepare_generation(self, params: object) -> dict[str, object]:
        command = _require_params(params, frozenset({"runId", "expectedRevision"}))
        run_id = require_opaque_id(command["runId"], "job")
        expected_revision = _require_expected_revision(command["expectedRevision"])
        with _transactional_write(self._database, "atomic retry failed") as con:
            _request_retry_in_transaction(
                con, run_id=run_id, expected_revision=expected_revision
            )
            return _prepare_generation_in_transaction(con, self._contract, run_id)

    def get_run(self, params: object) -> dict[str, object]:
        command = _require_params(params, frozenset({"runId"}))
        run_id = require_opaque_id(command["runId"], "job")
        with self._database.read_snapshot() as con:
            row = require_run(con, run_id)
            assert_projection(con, row)
            return _run_snapshot(con, row, self._contract)

    def list_events(self, params: object) -> dict[str, object]:
        command = _require_params(params, frozenset({"runId", "after"}))
        run_id = require_opaque_id(command["runId"], "job")
        after = command["after"]
        if type(after) is not int or not 0 <= after <= EVENT_AFTER_MAX:
            raise CoreProblem("INVALID_PARAMS", "event cursor is invalid")
        with self._database.read_snapshot() as con:
            row = require_run(con, run_id)
            assert_projection(con, row)
            document = _require_run_document(con, run_id)
            _validate_run_document(row, document)
            counts, _latest_attempt = _run_count_snapshot(
                con, row, self._contract, str(document["text"])
            )
            _validate_event_ledger(
                con,
                run=row,
                counts=counts,
                document_id=str(document["document_id"]),
                contract=self._contract,
            )
            stored = read_run_events(con, run_id, after, _EVENT_PAGE_LIMIT)
            events: list[dict[str, object]] = []
            previous = after
            for event in stored:
                seq = event["seq"]
                if type(seq) is not int or seq <= previous:
                    raise _derived_state_mismatch("run event projection is invalid")
                payload = decode_event_payload(
                    str(event["type"]), str(event["payload_json"])
                )
                events.append(
                    {
                        "seq": seq,
                        "type": event["type"],
                        "stage": event["stage"],
                        "payload": payload,
                    }
                )
                previous = seq
            return {
                "events": events,
                "nextAfter": previous,
            }

    def list_candidates(self, params: object) -> dict[str, object]:
        command = _require_params(params, frozenset({"runId"}))
        run_id = require_opaque_id(command["runId"], "job")
        with self._database.read_snapshot() as con:
            row = require_run(con, run_id)
            assert_projection(con, row)
            document = _require_run_document(con, run_id)
            _validate_run_document(row, document)
            counts, _latest_attempt = _run_count_snapshot(
                con, row, self._contract, str(document["text"])
            )
            point_rows = read_run_knowledge_points(con, run_id)
            points_by_candidate: dict[str, dict[str, Any]] = {}
            for point in point_rows:
                candidate_id = str(point["candidate_id"])
                if candidate_id in points_by_candidate:
                    raise _derived_state_mismatch(
                        "candidate knowledge point projection is ambiguous"
                    )
                points_by_candidate[candidate_id] = point
            candidates: list[dict[str, object]] = []
            for candidate in read_run_candidates(con, run_id):
                public = _candidate_snapshot(con, candidate, str(document["text"]))
                point = points_by_candidate.get(str(candidate["id"]))
                if candidate["accepted_kp_id"] is None:
                    if point is not None:
                        raise _derived_state_mismatch(
                            "unreviewed candidate has a knowledge point"
                        )
                elif point is None:
                    raise _derived_state_mismatch(
                        "accepted candidate knowledge point is missing"
                    )
                else:
                    projected_point = _knowledge_point_snapshot(
                        con,
                        point,
                        document_id=str(document["document_id"]),
                        chunk_id=str(document["chunk_id"]),
                        course_id=FIXTURE_COURSE_ID,
                        canonical_text=str(document["text"]),
                    )
                    if projected_point["knowledgePointId"] != public["knowledgePointId"]:
                        raise _derived_state_mismatch(
                            "candidate knowledge point identity is inconsistent"
                        )
                candidates.append(public)
            if len(candidates) != counts["validCandidates"]:
                raise _derived_state_mismatch("candidate list count is inconsistent")
            return {"candidates": candidates}

    def list_knowledge_points(self, params: object) -> dict[str, object]:
        command = _require_params(params, frozenset({"runId"}))
        run_id = require_opaque_id(command["runId"], "job")
        with self._database.read_snapshot() as con:
            row = require_run(con, run_id)
            assert_projection(con, row)
            document = _require_run_document(con, run_id)
            _validate_run_document(row, document)
            counts, _latest_attempt = _run_count_snapshot(
                con, row, self._contract, str(document["text"])
            )
            points = [
                _knowledge_point_snapshot(
                    con,
                    point,
                    document_id=str(document["document_id"]),
                    chunk_id=str(document["chunk_id"]),
                    course_id=FIXTURE_COURSE_ID,
                    canonical_text=str(document["text"]),
                )
                for point in read_run_knowledge_points(con, run_id)
            ]
            if len(points) != counts["knowledgePoints"]:
                raise _derived_state_mismatch("knowledge point list count is inconsistent")
            return {"knowledgePoints": points}
