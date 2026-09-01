from __future__ import annotations

import re
from types import MappingProxyType

import pytest

from nobei_core.constants import (
    ALLOWED_TRANSITIONS,
    EVENT_TYPES,
    GENERATION_RETRYABILITY,
    MAX_DOCUMENT_BYTES,
    MAX_EVENT_PAYLOAD_BYTES,
    MAX_IDEMPOTENCY_RESULT_BYTES,
    MAX_RAW_GENERATION_OUTPUT_BYTES,
    MAX_RETRY_COUNT,
    PUBLIC_ERROR_CODES,
    RESOURCE_ID_PREFIXES,
    RPC_LINE_MAX_BYTES,
    RPC_METHODS,
)
from nobei_core.errors import CoreProblem
from nobei_core.ids import new_opaque_id, require_idempotency_key, require_opaque_id


def test_transition_graph_is_closed():
    assert ALLOWED_TRANSITIONS == {
        "created": frozenset({"document_ready"}),
        "document_ready": frozenset({"awaiting_generation"}),
        "awaiting_generation": frozenset({"generating"}),
        "generating": frozenset({"validating", "failed_retryable", "failed_terminal"}),
        "validating": frozenset({"review_pending", "completed", "failed_retryable", "failed_terminal"}),
        "review_pending": frozenset({"completed"}),
        "completed": frozenset(),
        "failed_retryable": frozenset({"awaiting_generation"}),
        "failed_terminal": frozenset(),
    }


def test_constants_with_mapping_values_are_immutable():
    assert isinstance(ALLOWED_TRANSITIONS, MappingProxyType)
    assert isinstance(RPC_METHODS, MappingProxyType)
    assert isinstance(GENERATION_RETRYABILITY, MappingProxyType)
    with pytest.raises(TypeError):
        ALLOWED_TRANSITIONS["new"] = frozenset()  # type: ignore[index]


def test_ids_are_opaque_and_prefix_checked():
    value = new_opaque_id("cand")
    assert re.fullmatch(r"cand_[0-9a-f]{20}", value)
    assert require_opaque_id(value, "cand") == value
    with pytest.raises(CoreProblem, match="INVALID_IDENTIFIER"):
        require_opaque_id("../cand_bad", "cand")


@pytest.mark.parametrize("prefix", [
    "doc", "ck", "job", "att", "cand", "kp", "ev", "cfl",
    "course", "unit", "asm", "latt",
])
def test_only_resource_id_prefixes_are_generated(prefix: str):
    assert prefix in RESOURCE_ID_PREFIXES
    assert re.fullmatch(rf"{prefix}_[0-9a-f]{{20}}", new_opaque_id(prefix))


def test_idempotency_keys_are_not_resource_ids():
    value = "idem_" + "a" * 20
    assert require_idempotency_key(value) == value
    with pytest.raises(CoreProblem, match="INVALID_IDENTIFIER"):
        new_opaque_id("idem")
    with pytest.raises(CoreProblem, match="INVALID_IDENTIFIER"):
        require_idempotency_key("idem_" + "A" * 20)


def test_event_types_are_closed():
    assert EVENT_TYPES == frozenset(
        {
            "run.created",
            "document.ready",
            "generation.awaiting",
            "generation.started",
            "generation.validating",
            "generation.failed",
            "generation.interrupted",
            "generation.retry_requested",
            "candidates.ready",
            "candidate.accepted",
            "candidate.edited_and_accepted",
            "candidate.rejected",
            "run.completed",
        }
    )


def test_limits_are_fixed_byte_limits():
    assert MAX_RETRY_COUNT == 1
    assert MAX_DOCUMENT_BYTES == 524_288
    assert MAX_RAW_GENERATION_OUTPUT_BYTES == 8_388_608
    assert MAX_EVENT_PAYLOAD_BYTES == 8_192
    assert MAX_IDEMPOTENCY_RESULT_BYTES == 16_777_216
    assert RPC_LINE_MAX_BYTES == 33_554_432


def test_rpc_methods_are_closed():
    assert RPC_METHODS == {
        "system.hello": "hello",
        "documents.preview": "preview_document",
        "documents.import_text": "import_text",
        "documents.import_and_prepare_generation": "import_and_prepare_generation",
        "runs.prepare_generation": "prepare_generation",
        "runs.submit_generation": "submit_generation",
        "runs.fail_generation": "fail_generation",
        "runs.get": "get_run",
        "runs.list": "list_runs",
        "runs.list_events": "list_events",
        "runs.delete": "delete_run",
        "runs.retry": "retry",
        "runs.retry_and_prepare_generation": "retry_and_prepare_generation",
        "candidates.list": "list_candidates",
        "candidates.review": "review_candidate",
        "knowledge_points.list_for_run": "list_knowledge_points",
        "knowledge_points.update": "update_knowledge_point",
        "learning_courses.sync": "sync_learning_course",
        "learning_courses.get": "get_learning_course",
        "learning_courses.delete": "delete_learning_course",
        "learning_attempts.submit": "submit_learning_attempt",
    }


def test_generation_retryability_is_fixed_to_one_explicit_retry():
    assert GENERATION_RETRYABILITY == {
        "GENERATION_TIMEOUT": True,
        "GENERATION_SCHEMA_INVALID": True,
        "GENERATION_NO_OUTPUT": True,
        "GENERATION_OUTPUT_LIMIT": True,
        "GENERATION_PROVIDER_ERROR": True,
    }
    assert all(configured and retry_count == 0 for configured in GENERATION_RETRYABILITY.values() for retry_count in (0,))
    assert all(not (configured and retry_count == 0) for configured in GENERATION_RETRYABILITY.values() for retry_count in (1, 2))


def test_public_error_codes_are_closed():
    assert PUBLIC_ERROR_CODES == frozenset(
        {
            "UNSUPPORTED_MEDIA_TYPE",
            "REQUEST_TOO_LARGE",
            "INVALID_DOCUMENT",
            "PDF_MALFORMED",
            "PDF_ENCRYPTED",
            "PDF_NO_TEXT",
            "INVALID_IDENTIFIER",
            "CORE_INSTANCE_CONFLICT",
            "PROTOCOL_MISMATCH",
            "RPC_MESSAGE_TOO_LARGE",
            "INVALID_REQUEST",
            "INVALID_PARAMS",
            "METHOD_NOT_FOUND",
            "GENERATION_TIMEOUT",
            "GENERATION_SCHEMA_INVALID",
            "GENERATION_NO_OUTPUT",
            "GENERATION_OUTPUT_LIMIT",
            "GENERATION_PROVIDER_ERROR",
            "RUN_STATE_CONFLICT",
            "DERIVED_STATE_MISMATCH",
            "REVISION_CONFLICT",
            "ATTEMPT_MISMATCH",
            "EVIDENCE_NOT_FOUND",
            "EVIDENCE_AMBIGUOUS",
            "CANDIDATE_ALREADY_REVIEWED",
            "IDEMPOTENCY_CONFLICT",
            "LEARNING_COURSE_NOT_FOUND",
            "LEARNING_ASSESSMENT_NOT_FOUND",
            "LEARNING_COURSE_CONFLICT",
            "LEARNING_STATE_CONFLICT",
            "DATABASE_UNAVAILABLE",
            "TRANSACTION_FAILED",
        }
    )


def test_core_problem_public_projection_excludes_message():
    problem = CoreProblem(
        "REQUEST_TOO_LARGE",
        "internal path /secret",
        {"actualBytes": 65_537, "maxBytes": 65_536},
    )
    assert str(problem) == "REQUEST_TOO_LARGE"
    assert problem.public() == {
        "code": "REQUEST_TOO_LARGE",
        "data": {"actualBytes": 65_537, "maxBytes": 65_536},
    }
    assert CoreProblem("INVALID_IDENTIFIER", "internal path /secret").public() == {"code": "INVALID_IDENTIFIER"}


def test_core_problem_public_data_cannot_alias_retained_data():
    problem = CoreProblem("REQUEST_TOO_LARGE", "internal", {"actualBytes": 2, "maxBytes": 1})
    first_projection = problem.public()
    first_projection["data"]["path"] = "/secret"  # type: ignore[index]

    assert problem.public() == {
        "code": "REQUEST_TOO_LARGE",
        "data": {"actualBytes": 2, "maxBytes": 1},
    }
    assert problem.data is not None
    with pytest.raises(TypeError):
        problem.data["path"] = "/secret"  # type: ignore[index]


@pytest.mark.parametrize(
    ("code", "data"),
    [
        ("INTERNAL_ERROR", None),
        ("INVALID_IDENTIFIER", {"path": "/secret"}),
        ("INVALID_DOCUMENT", {"candidate": "private candidate text"}),
        ("REQUEST_TOO_LARGE", {}),
        ("REQUEST_TOO_LARGE", {"actualBytes": 1}),
        ("REQUEST_TOO_LARGE", {"actualBytes": 1, "maxBytes": 0, "path": "/secret"}),
        ("REQUEST_TOO_LARGE", {"actualBytes": True, "maxBytes": 0}),
        ("REQUEST_TOO_LARGE", {"actualBytes": 0, "maxBytes": False}),
        ("REQUEST_TOO_LARGE", {"actualBytes": -1, "maxBytes": 0}),
        ("REQUEST_TOO_LARGE", {"actualBytes": 0, "maxBytes": -1}),
    ],
)
def test_core_problem_rejects_non_public_codes_and_unsafe_data(code: str, data: object):
    with pytest.raises(ValueError):
        CoreProblem(code, "internal detail", data)  # type: ignore[arg-type]
