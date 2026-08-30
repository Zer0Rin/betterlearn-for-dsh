"""Opaque Core resource identifiers and client idempotency-key validation."""

from __future__ import annotations

import re
import secrets

from nobei_core.constants import IDEMPOTENCY_KEY_PREFIX, OPAQUE_ID_HEX_LENGTH, RESOURCE_ID_PREFIXES
from nobei_core.errors import CoreProblem


def _identifier_problem() -> CoreProblem:
    return CoreProblem("INVALID_IDENTIFIER", "invalid opaque identifier")


def _matches(value: object, prefix: str) -> bool:
    return isinstance(value, str) and re.fullmatch(rf"{re.escape(prefix)}_[0-9a-f]{{{OPAQUE_ID_HEX_LENGTH}}}", value) is not None


def new_opaque_id(prefix: str) -> str:
    """Create a Core-owned resource ID from the closed resource-prefix set."""
    if prefix not in RESOURCE_ID_PREFIXES:
        raise _identifier_problem()
    return f"{prefix}_{secrets.token_hex(OPAQUE_ID_HEX_LENGTH // 2)}"


def require_opaque_id(value: object, prefix: str) -> str:
    """Return a syntactically valid Core resource ID for the requested prefix."""
    if prefix not in RESOURCE_ID_PREFIXES or not _matches(value, prefix):
        raise _identifier_problem()
    return value


def require_idempotency_key(value: object) -> str:
    """Return a client review key; it is deliberately not a Core resource ID."""
    if not _matches(value, IDEMPOTENCY_KEY_PREFIX):
        raise _identifier_problem()
    return value
