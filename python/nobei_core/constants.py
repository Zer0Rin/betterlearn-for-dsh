"""Stable Phase 1B domain vocabulary and protocol limits."""

from __future__ import annotations

from types import MappingProxyType


RUN_STAGES = MappingProxyType(
    {
        "created": "source",
        "document_ready": "parse",
        "awaiting_generation": "extract",
        "generating": "extract",
        "validating": "verify",
        "review_pending": "confirm",
        "completed": "done",
        "failed_retryable": "failed",
        "failed_terminal": "failed",
    }
)

ALLOWED_TRANSITIONS = MappingProxyType(
    {
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
)

RPC_METHODS = MappingProxyType(
    {
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
    }
)

GENERATION_RETRYABILITY = MappingProxyType(
    {
        "GENERATION_TIMEOUT": True,
        "GENERATION_SCHEMA_INVALID": True,
        "GENERATION_NO_OUTPUT": True,
        "GENERATION_OUTPUT_LIMIT": True,
        "GENERATION_PROVIDER_ERROR": True,
    }
)

RESOURCE_ID_PREFIXES = frozenset({"doc", "ck", "job", "att", "cand", "kp", "ev", "cfl"})
OPAQUE_ID_HEX_LENGTH = 20
IDEMPOTENCY_KEY_PREFIX = "idem"

EVENT_TYPES = frozenset(
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
COMPLETION_REASONS = frozenset({"zero_valid_candidates", "reviewed_all"})

CANDIDATE_TYPES = frozenset(
    {"concept", "process", "comparison", "formula", "fact", "code"}
)
REVIEW_ACTIONS = frozenset({"accept", "edited_and_accept", "reject"})
CANDIDATE_REVIEW_STATUSES = frozenset(
    {"pending", "accepted", "edited_and_accepted", "rejected"}
)
CONFIRMATION_ACTIONS = frozenset(
    {"accepted_without_edit", "accepted_with_edit", "rejected"}
)
REVIEW_ACTION_MAPPING = MappingProxyType(
    {
        "accept": ("accepted", "accepted_without_edit", "candidate.accepted"),
        "edited_and_accept": (
            "edited_and_accepted",
            "accepted_with_edit",
            "candidate.edited_and_accepted",
        ),
        "reject": ("rejected", "rejected", "candidate.rejected"),
    }
)

PUBLIC_ERROR_CODES = frozenset(
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
        "DATABASE_UNAVAILABLE",
        "TRANSACTION_FAILED",
    }
)

MAX_RETRY_COUNT = 1
PHASE1E_EXPECTED_RUN_COUNT = 20
PHASE1E_MINIMUM_EXACT_EVIDENCE_YIELD = 0.90
MAX_DOCUMENT_BYTES = 524_288
MAX_RAW_GENERATION_OUTPUT_BYTES = 8_388_608
MAX_EVENT_PAYLOAD_BYTES = 8_192
# A review stores the full document snapshot, candidate, and optional knowledge point.
# Allow JSON escaping and maximum valid review text/evidence within a bounded record.
MAX_IDEMPOTENCY_RESULT_BYTES = 16_777_216
RPC_LINE_MAX_BYTES = 33_554_432

FILENAME_MIN_CHARS = 1
FILENAME_MAX_CHARS = 255
IDEMPOTENCY_KEY_MIN_CHARS = 1
IDEMPOTENCY_KEY_MAX_CHARS = 128
MODEL_PROVIDER_MIN_CHARS = 1
MODEL_PROVIDER_MAX_CHARS = 64
MODEL_NAME_MIN_CHARS = 1
MODEL_NAME_MAX_CHARS = 128
SCHEMA_SHA256_HEX_LENGTH = 64
EVENT_AFTER_MAX = 2**31 - 1
CANDIDATE_MAX_COUNT = 20
CANDIDATE_EVIDENCE_MIN_COUNT = 1
CANDIDATE_EVIDENCE_MAX_COUNT = 3
CANDIDATE_TITLE_MAX_CHARS = 120
CANDIDATE_STATEMENT_MAX_CHARS = 2_000
EVIDENCE_QUOTE_MAX_CHARS = 2_000
EVIDENCE_CONTEXT_MAX_CHARS = 200

FIELD_BYTE_LIMITS = MappingProxyType(
    {
        "documentText": MAX_DOCUMENT_BYTES,
        "rawGenerationOutput": MAX_RAW_GENERATION_OUTPUT_BYTES,
        "eventPayload": MAX_EVENT_PAYLOAD_BYTES,
        "idempotencyResult": MAX_IDEMPOTENCY_RESULT_BYTES,
        "rpcLine": RPC_LINE_MAX_BYTES,
    }
)
