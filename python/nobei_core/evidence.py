"""Exact-only evidence location against one canonical document string."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from nobei_core.constants import EVIDENCE_CONTEXT_MAX_CHARS, EVIDENCE_QUOTE_MAX_CHARS
from nobei_core.errors import CoreProblem


_EVIDENCE_FIELDS = frozenset({"quote", "prefix", "suffix"})


@dataclass(frozen=True, slots=True)
class LocatedEvidence:
    """One uniquely located literal quote and its bounded source context."""

    text_start: int
    text_end: int
    context_before: str
    context_after: str


def _require_evidence(evidence: object) -> tuple[str, str, str]:
    if not isinstance(evidence, dict) or frozenset(evidence) != _EVIDENCE_FIELDS:
        raise CoreProblem("GENERATION_SCHEMA_INVALID", "evidence object is invalid")

    value: dict[str, Any] = evidence
    quote = value["quote"]
    prefix = value["prefix"]
    suffix = value["suffix"]
    if (
        not isinstance(quote, str)
        or len(quote) > EVIDENCE_QUOTE_MAX_CHARS
        or not isinstance(prefix, str)
        or len(prefix) > EVIDENCE_CONTEXT_MAX_CHARS
        or not isinstance(suffix, str)
        or len(suffix) > EVIDENCE_CONTEXT_MAX_CHARS
    ):
        raise CoreProblem("GENERATION_SCHEMA_INVALID", "evidence fields are invalid")
    return quote, prefix, suffix


def locate_evidence(canonical_text: str, evidence: object) -> LocatedEvidence:
    """Locate exactly one literal quote without normalization or fuzzy alignment."""

    if not isinstance(canonical_text, str):
        raise CoreProblem("INVALID_DOCUMENT", "canonical document text is invalid")
    quote, prefix, suffix = _require_evidence(evidence)

    if not quote:
        raise CoreProblem("EVIDENCE_NOT_FOUND", "evidence quote was not found")

    first_quote = canonical_text.find(quote)
    if first_quote < 0:
        raise CoreProblem("EVIDENCE_NOT_FOUND", "evidence quote was not found")

    if canonical_text.find(quote, first_quote + 1) < 0:
        text_start = first_quote
    else:
        qualified_window = prefix + quote + suffix
        first_qualified = canonical_text.find(qualified_window)
        if (
            first_qualified < 0
            or canonical_text.find(qualified_window, first_qualified + 1) >= 0
        ):
            raise CoreProblem("EVIDENCE_AMBIGUOUS", "evidence quote is not unique")
        text_start = first_qualified + len(prefix)

    text_end = text_start + len(quote)
    if canonical_text[text_start:text_end] != quote:
        raise CoreProblem("EVIDENCE_NOT_FOUND", "evidence quote was not found")
    return LocatedEvidence(
        text_start=text_start,
        text_end=text_end,
        context_before=canonical_text[
            max(0, text_start - EVIDENCE_CONTEXT_MAX_CHARS) : text_start
        ],
        context_after=canonical_text[
            text_end : text_end + EVIDENCE_CONTEXT_MAX_CHARS
        ],
    )
