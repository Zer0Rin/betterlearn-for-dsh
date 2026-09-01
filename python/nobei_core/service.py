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
    EVENT_AFTER_MAX,
    FILENAME_MAX_CHARS,
    FILENAME_MIN_CHARS,
    GENERATION_RETRYABILITY,
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
from nobei_core.extraction import extraction_plan, pdf_text
from nobei_core.ids import (
    new_opaque_id,
    require_idempotency_key,
    require_opaque_id,
)
from nobei_core.learning import course_snapshot, delete_course, submit_attempt, sync_course
from nobei_core.repository import (
    append_event,
    candidate_evidence,
    close_candidate_review,
    delete_run_graph,
    find_idempotency_result,
    insert_candidate,
    insert_formal_evidence,
    insert_formal_knowledge_point,
    insert_generation_attempt,
    knowledge_point_evidence,
    latest_extraction_model,
    latest_run_attempt,
    mark_attempt_failed,
    mark_attempt_succeeded,
    now_iso,
    read_run_candidates,
    read_run_events,
    read_run_history,
    read_run_knowledge_points,
    reclassify_review_after_point_edit,
    request_retry,
    require_candidate,
    require_current_attempt,
    require_knowledge_point_for_update,
    require_run,
    run_last_event_seq,
    run_snapshot_counts,
    set_run_error,
    store_idempotency_result,
    transition_run,
    update_generation_statistics,
    update_formal_knowledge_point,
    update_run_after_review,
)



_DSH_CONVERSATION_MEDIA_TYPE = "application/vnd.betterlearn.dsh-conversation+markdown"
_SUPPORTED_MEDIA_TYPES = frozenset({
    "text/plain",
    "text/markdown",
    "application/pdf",
    _DSH_CONVERSATION_MEDIA_TYPE,
})
_EVENT_PAGE_LIMIT = 200
_PROMPT_VERSION = "l1-v3"
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

    if not isinstance(media_type, str) or media_type not in _SUPPORTED_MEDIA_TYPES:
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
        "runId": run["run_id"],
        "attemptNumber": attempt_number,
        "documentSha256": run["document_sha256"],
        "schemaVersion": run["contract_version"],
        "schemaSha256": run["contract_sha256"],
        "promptVersion": run["prompt_version"],
        "modelSelection": model_selection,
    }
    return hashlib.sha256(_canonical_json(digest_input).encode("utf-8")).hexdigest()


def _derived_state_mismatch(message: str) -> CoreProblem:
    return CoreProblem("DERIVED_STATE_MISMATCH", message)


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


def _prepare_generation_in_transaction(
    con: sqlite3.Connection,
    contract: CandidateContract,
    run_id: str,
    model_selection: dict[str, str] | None = None,
) -> dict[str, object]:
    row = require_run(con, run_id)
    if row["status"] != "awaiting_generation":
        raise CoreProblem("RUN_STATE_CONFLICT", "run is not awaiting generation")
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
            "SELECT model_metadata_json FROM generation_attempts "
            "WHERE run_id=? AND attempt_number=1",
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
        **({"extractionPlan": extraction_plan(document["text"])} if len(document["text"]) > 6000 else {}),
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

    def preview_document(self, params: object) -> dict[str, object]:
        pages = []
        if isinstance(params, dict) and 'contentBase64' in params:
            command = _require_params(params, frozenset({'filename', 'mediaType', 'contentBase64'}))
            if command['mediaType'] != 'application/pdf':
                raise CoreProblem('UNSUPPORTED_MEDIA_TYPE', 'base64 input requires PDF')
            text, pages = pdf_text(command['contentBase64'])
            params = {'filename': command['filename'], 'mediaType': command['mediaType'], 'text': text}
        filename, media_type, text, encoded = _normalize_document(params)
        return {'filename': filename, 'mediaType': media_type, 'text': text,
                'byteSize': len(encoded), 'characterCount': len(text), 'pages': pages,
                'extractionPlan': extraction_plan(text)}

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

        batches = raw_output.get('batches')
        batched = 'batches' in raw_output
        sources = []
        if not validation_failed:
            if batched:
                plan = extraction_plan(canonical_text)
                if set(raw_output) != {'batches'} or not isinstance(batches, list) or not batches or len(batches) > plan['maxCalls']:
                    validation_failed = True
                else:
                    for batch in batches:
                        if (not isinstance(batch, dict) or set(batch) != {'textStart', 'textEnd', 'output'}
                            or type(batch['textStart']) is not int or type(batch['textEnd']) is not int
                            or not 0 <= batch['textStart'] < batch['textEnd'] <= len(canonical_text)
                            or self._contract.validate(batch['output'])):
                            validation_failed = True
                            break
                        sources.extend((candidate, batch['textStart'], batch['textEnd']) for candidate in batch['output']['candidates'])
            elif self._contract.validate(raw_output):
                validation_failed = True
            else:
                sources = [(candidate, 0, len(canonical_text)) for candidate in raw_output['candidates']]
        if validation_failed:
            return self._record_submission_failure(
                run_id=run_id, attempt_id=attempt_id, expected_revision=validating_revision,
                raw_output_json=raw_output_json,
            )

        candidates = [candidate for candidate, _, _ in sources]
        schema_valid_evidence_count = sum(len(candidate['evidence']) for candidate in candidates)
        exact_evidence_count = 0
        rejection_counts: dict[str, int] = {}
        surviving_candidates: list[dict[str, object]] = []
        merged = {}
        for ordinal, (candidate, source_start, source_end) in enumerate(sources):
            exact_rows = []
            for seq, evidence in enumerate(candidate['evidence']):
                try:
                    located = locate_evidence(canonical_text[source_start:source_end], evidence)
                except CoreProblem as problem:
                    if problem.code not in ('EVIDENCE_NOT_FOUND', 'EVIDENCE_AMBIGUOUS'):
                        raise
                    rejection_counts[problem.code] = rejection_counts.get(problem.code, 0) + 1
                    continue
                exact_evidence_count += 1
                start, end = located.text_start + source_start, located.text_end + source_start
                exact_rows.append({'seq': seq, 'quote': evidence['quote'], 'text_start': start,
                    'text_end': end, 'context_before': canonical_text[max(0, start-200):start],
                    'context_after': canonical_text[end:end+200]})
            if exact_rows:
                key = (candidate['type'], candidate['title'], candidate['statement']) if batched else ordinal
                if key not in merged:
                    merged[key] = {'id': new_opaque_id('cand'), 'ordinal': len(merged) if batched else ordinal,
                        'type': candidate['type'], 'title': candidate['title'],
                        'statement': candidate['statement'], 'evidence': []}
                    surviving_candidates.append(merged[key])
                target = merged[key]['evidence']
                seen = {(e['text_start'], e['text_end'], e['quote']) for e in target}
                for evidence in exact_rows:
                    identity = (evidence['text_start'], evidence['text_end'], evidence['quote'])
                    if not batched or identity not in seen:
                        evidence['seq'] = len(target) if batched else evidence['seq']
                        target.append(evidence)
                        seen.add(identity)
                if len(target) > 64 or len(surviving_candidates) > 1000:
                    return self._record_submission_failure(run_id=run_id, attempt_id=attempt_id,
                        expected_revision=validating_revision, raw_output_json=raw_output_json)

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
                    "DERIVED_STATE_MISMATCH", "run document changed"
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
                restored = json.loads(replay["result_json"])
                restored_candidate = restored["candidate"]
                if not isinstance(restored_candidate, dict):
                    raise CoreProblem("TRANSACTION_FAILED", "stored review result is invalid")
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

            run_id = str(candidate["run_id"])
            run = require_run(con, run_id)
            if run["status"] != "review_pending":
                raise CoreProblem("RUN_STATE_CONFLICT", "run is not awaiting review")
            document = _require_run_document(con, run_id)
            document_id = str(document["document_id"])
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

            complete = run_snapshot_counts(con, run_id)["pending"] == 1
            updated_run = update_run_after_review(
                con,
                run_id=run_id,
                expected_revision=int(run["revision"]),
                accepted_increment=1 if accepted else 0,
                review_status=review_status,
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
        command = _require_params(params, frozenset({'runId'}))
        run_id = require_opaque_id(command['runId'], 'job')
        with self._database.read_snapshot() as con:
            return _run_snapshot(con, require_run(con, run_id), self._contract)

    def list_runs(self, params: object) -> dict[str, object]:
        _require_params(params, frozenset())
        with self._database.read_snapshot() as con:
            return {"runs": [{
                "runId": row["run_id"],
                "sourceType": (
                    "dsh_conversation"
                    if row["media_type"] == _DSH_CONVERSATION_MEDIA_TYPE
                    else "document"
                ),
                "sourceLabel": row["filename"],
                "status": row["status"],
                "stage": row["stage"],
                "updatedAt": row["updated_at"],
                "candidateCount": row["valid_candidate_count"],
                "knowledgePointCount": row["accepted_candidate_count"],
            } for row in read_run_history(con)]}

    def delete_run(self, params: object) -> dict[str, object]:
        command = _require_params(params, frozenset({"runId"}))
        run_id = require_opaque_id(command["runId"], "job")
        with _transactional_write(self._database, "run deletion failed") as con:
            delete_run_graph(con, run_id)
            return {"runId": run_id, "deleted": True}

    def list_events(self, params: object) -> dict[str, object]:
        command = _require_params(params, frozenset({'runId', 'after'}))
        run_id = require_opaque_id(command['runId'], 'job')
        after = command['after']
        if type(after) is not int or not 0 <= after <= EVENT_AFTER_MAX:
            raise CoreProblem('INVALID_PARAMS', 'event cursor is invalid')
        with self._database.read_snapshot() as con:
            require_run(con, run_id)
            rows = read_run_events(con, run_id, after, _EVENT_PAGE_LIMIT)
            return {'events': [{'seq': r['seq'], 'type': r['type'], 'stage': r['stage'],
                'payload': json.loads(r['payload_json'])} for r in rows],
                'nextAfter': rows[-1]['seq'] if rows else after}

    def list_candidates(self, params: object) -> dict[str, object]:
        command = _require_params(params, frozenset({'runId'}))
        run_id = require_opaque_id(command['runId'], 'job')
        with self._database.read_snapshot() as con:
            require_run(con, run_id)
            return {'candidates': [_review_candidate_snapshot(r, _public_evidence(candidate_evidence(con, r['id'])))
                for r in read_run_candidates(con, run_id)]}

    def list_knowledge_points(self, params: object) -> dict[str, object]:
        command = _require_params(params, frozenset({'runId'}))
        run_id = require_opaque_id(command['runId'], 'job')
        with self._database.read_snapshot() as con:
            require_run(con, run_id)
            return {'knowledgePoints': [_review_knowledge_point_snapshot(knowledge_point_id=r['id'],
                candidate_type=r['type'],title=r['title'],statement=r['statement'],document_id=r['document_id'],
                evidence=_public_evidence(knowledge_point_evidence(con, r['id'])))
                for r in read_run_knowledge_points(con, run_id)]}

    def update_knowledge_point(self, params: object) -> dict[str, object]:
        command = _require_params(
            params, frozenset({"knowledgePointId", "title", "statement"})
        )
        knowledge_point_id = require_opaque_id(
            command["knowledgePointId"], "kp"
        )
        title = _require_review_text(
            command["title"], maximum=CANDIDATE_TITLE_MAX_CHARS
        )
        statement = _require_review_text(
            command["statement"], maximum=CANDIDATE_STATEMENT_MAX_CHARS
        )
        with _transactional_write(
            self._database, "knowledge point update failed"
        ) as con:
            point = require_knowledge_point_for_update(con, knowledge_point_id)
            run = require_run(con, point["run_id"])
            if run["status"] != "completed":
                raise CoreProblem("RUN_STATE_CONFLICT", "run is not completed")
            evidence = knowledge_point_evidence(con, knowledge_point_id)
            public_evidence = _public_evidence(evidence)
            content_hash = _formal_content_hash(
                candidate_type=str(point["type"]),
                title=title,
                statement=statement,
                document_id=str(point["document_id"]),
                evidence=public_evidence,
            )
            edited_at = now_iso()
            update_formal_knowledge_point(
                con,
                knowledge_point_id=knowledge_point_id,
                title=title,
                statement=statement,
                content_hash=content_hash,
                updated_at=edited_at,
            )
            first_edit = reclassify_review_after_point_edit(
                con,
                candidate_id=str(point["candidate_id"]),
                title=title,
                statement=statement,
                edited_at=edited_at,
            )
            changed = con.execute(
                "UPDATE runs SET edited_candidate_count=edited_candidate_count+?,"
                "revision=revision+1,updated_at=? WHERE id=? AND status='completed'",
                (int(first_edit), edited_at, point["run_id"]),
            ).rowcount
            if changed != 1:
                raise CoreProblem("RUN_STATE_CONFLICT", "run is not completed")
            updated_run = require_run(con, str(point["run_id"]))
            return {
                "knowledgePoint": _review_knowledge_point_snapshot(
                    knowledge_point_id=knowledge_point_id,
                    candidate_type=str(point["type"]),
                    title=title,
                    statement=statement,
                    document_id=str(point["document_id"]),
                    evidence=public_evidence,
                ),
                "run": _run_snapshot(con, updated_run, self._contract),
            }

    def sync_learning_course(self, params: object) -> dict[str, object]:
        with _transactional_write(self._database, "learning course sync failed") as con:
            course_id = sync_course(con, params)
            return course_snapshot(con, course_id)

    def get_learning_course(self, params: object) -> dict[str, object]:
        command = _require_params(params, frozenset({"courseId"}))
        course_id = require_opaque_id(command["courseId"], "course")
        with self._database.read_snapshot() as con:
            return course_snapshot(con, course_id)

    def delete_learning_course(self, params: object) -> dict[str, object]:
        command = _require_params(params, frozenset({"courseId"}))
        with _transactional_write(self._database, "learning course delete failed") as con:
            return delete_course(con, command["courseId"])

    def submit_learning_attempt(self, params: object) -> dict[str, object]:
        with _transactional_write(self._database, "learning attempt failed") as con:
            return submit_attempt(con, params)


def _create_import_in_transaction(con, contract, *, filename, media_type, canonical, encoded):
    document_id, run_id, created_at = new_opaque_id('doc'), new_opaque_id('job'), now_iso()
    con.execute('INSERT INTO documents(id,filename,media_type,canonical_text,byte_size,character_count,text_sha256,created_at) VALUES(?,?,?,?,?,?,?,?)',
        (document_id,filename,media_type,canonical,len(encoded),len(canonical),hashlib.sha256(encoded).hexdigest(),created_at))
    con.execute("INSERT INTO runs(id,document_id,strategy,status,stage,revision,contract_version,contract_sha256,prompt_version,created_at,updated_at) VALUES(?,?,?,'awaiting_generation','extract',1,?,?,?,?,?)",
        (run_id,document_id,extraction_plan(canonical)['strategy'].lower(),contract.schema_version,contract.schema_sha256,_PROMPT_VERSION,created_at,created_at))
    append_event(con,run_id,'run.created','source',{'runId':run_id})
    append_event(con,run_id,'document.ready','parse',{'documentId':document_id})
    append_event(con,run_id,'generation.awaiting','extract',{'retryCount':0})
    return {'documentId':document_id,'runId':run_id,'revision':1}


def _require_run_document(con, run_id):
    return dict(con.execute('SELECT d.*, d.id AS document_id,d.canonical_text AS text FROM documents d JOIN runs r ON r.document_id=d.id WHERE r.id=?', (run_id,)).fetchone())


def _run_snapshot(con, row, contract):
    document = _require_run_document(con, row['run_id'])
    counts = run_snapshot_counts(con, row['run_id'])
    latest = latest_run_attempt(con, row['run_id'])
    result = {'runId':row['run_id'],'documentId':document['id'],'status':row['status'],
        'stage':row['stage'],'revision':row['revision'],'retryCount':row['retry_count'],
        'lastEventSeq':run_last_event_seq(con,row['run_id']),
        'counts': {'rawCandidates':row['raw_candidate_count'],'validCandidates':counts['valid_candidates'],
        'pending':counts['pending'],'accepted':counts['accepted'],'editedAndAccepted':counts['edited_and_accepted'],
        'rejected':counts['rejected'],'knowledgePoints':counts['knowledge_points']},
        'error': {'code':row['error_code'],'retryable':row['status']=='failed_retryable'} if row['error_code'] else None,
        'document':{'filename':document['filename'],'mediaType':document['media_type'],
        'byteSize':document['byte_size'],'characterCount':document['character_count'],'text':document['canonical_text']}}
    if latest:
        result['modelSelection'] = _decode_model_metadata(latest['model_metadata_json'])
    return result
