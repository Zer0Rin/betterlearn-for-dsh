from __future__ import annotations

import json
import math
from statistics import median
from time import perf_counter_ns

from nobei_core.contract import load_candidate_contract
from nobei_core.database import Phase1Database
from nobei_core.ownership import initialize_owned_root
from nobei_core.service import Phase1Core

from conftest import PYTHON_ROOT


SAMPLE_COUNT = 30
MAX_SUBMIT_MS = 2_000


def _maximum_shape_fixture() -> tuple[str, dict[str, object]]:
    prefix = "p" * 200
    quote = "q" * 2_000
    suffix = "s" * 200
    window = prefix + quote + suffix
    text = window + "x" * (65_536 - len(window))
    evidence = {"quote": quote, "prefix": prefix, "suffix": suffix}
    output = {
        "schemaVersion": 1,
        "candidates": [
            {
                "type": "fact",
                "title": f"Maximum evidence candidate {index}",
                "statement": "Maximum-shape exact evidence remains bounded.",
                "evidence": [dict(evidence) for _ in range(3)],
            }
            for index in range(20)
        ],
    }
    return text, output


def test_real_submit_maximum_shape_has_a_measured_two_second_upper_bound(
    tmp_path, ownership_token: str
):
    text, output = _maximum_shape_fixture()
    contract = load_candidate_contract(PYTHON_ROOT.parent)
    samples_ms: list[float] = []

    for sample in range(SAMPLE_COUNT):
        owned_root = tmp_path / f"owned-{sample}"
        owned_root.mkdir()
        initialize_owned_root(owned_root, ownership_token)
        database = Phase1Database.open(
            owned_root,
            ownership_token,
        )
        try:
            core = Phase1Core(database, contract)
            imported = core.import_text(
                {
                    "filename": "maximum-shape.md",
                    "mediaType": "text/markdown",
                    "text": text,
                }
            )
            run_id = str(imported["runId"])
            prepared = core.prepare_generation({
                "runId": run_id,
                "modelSelection": {
                    "provider": "benchmark-fake",
                    "model": "maximum-shape",
                },
            })
            started = perf_counter_ns()
            result = core.submit_generation(
                {
                    "runId": run_id,
                    "attemptId": prepared["attemptId"],
                    "expectedRevision": prepared["revision"],
                    "output": output,
                }
            )
            samples_ms.append((perf_counter_ns() - started) / 1_000_000)
            assert result["statistics"]["exactEvidenceCount"] == 60
        finally:
            database.close()

    ordered = sorted(samples_ms)
    metrics = {
        "sampleCount": len(ordered),
        "medianMs": median(ordered),
        "p95Ms": ordered[math.ceil(len(ordered) * 0.95) - 1],
        "maxMs": max(ordered),
    }
    print(json.dumps(metrics, sort_keys=True, separators=(",", ":")))
    assert metrics["maxMs"] <= MAX_SUBMIT_MS, metrics
