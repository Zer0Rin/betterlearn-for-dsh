from __future__ import annotations

import json
from time import perf_counter_ns

import pytest

from nobei_core.evidence import locate_evidence
from nobei_core.errors import CoreProblem


MAX_BATCH_NS = 500_000_000
MAX_DOCUMENT = "a" * 65_536
MAX_QUOTE = "a" * 2_000
MAX_CONTEXT = "a" * 200


def _run_batch(evidence: dict[str, str]) -> int:
    started = perf_counter_ns()
    for _ in range(60):
        with pytest.raises(CoreProblem, match="EVIDENCE_AMBIGUOUS"):
            locate_evidence(MAX_DOCUMENT, evidence)
    return perf_counter_ns() - started


def test_maximum_shape_batch_with_multiple_eligible_matches_is_bounded():
    elapsed_ns = _run_batch(
        {"quote": MAX_QUOTE, "prefix": MAX_CONTEXT, "suffix": MAX_CONTEXT}
    )
    print(json.dumps({"benchmark": "evidence-max-shape-multiple", "elapsedMs": elapsed_ns / 1_000_000}))

    assert elapsed_ns < MAX_BATCH_NS, {"elapsedNs": elapsed_ns, "limitNs": MAX_BATCH_NS}


def test_maximum_shape_batch_with_zero_eligible_matches_is_bounded():
    elapsed_ns = _run_batch(
        {"quote": MAX_QUOTE, "prefix": "b" * 200, "suffix": MAX_CONTEXT}
    )
    print(json.dumps({"benchmark": "evidence-max-shape-zero", "elapsedMs": elapsed_ns / 1_000_000}))

    assert elapsed_ns < MAX_BATCH_NS, {"elapsedNs": elapsed_ns, "limitNs": MAX_BATCH_NS}
