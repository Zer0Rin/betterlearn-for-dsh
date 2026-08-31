"""Zero-provider-call replay for frozen Phase 1 evidence outputs."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from collections import Counter
from pathlib import Path
from typing import Any, Sequence

from nobei_core.constants import (
    PHASE1E_EXPECTED_RUN_COUNT,
    PHASE1E_MINIMUM_EXACT_EVIDENCE_YIELD,
)
from nobei_core.errors import CoreProblem
from nobei_core.evidence import locate_evidence


_LOCATOR_REJECTIONS = frozenset({"EVIDENCE_AMBIGUOUS", "EVIDENCE_NOT_FOUND"})


def _require_raw_evidence(raw_output: str) -> list[object]:
    try:
        decoded = json.loads(raw_output)
    except (json.JSONDecodeError, TypeError) as error:
        raise ValueError("raw output is not valid JSON") from error
    if not isinstance(decoded, dict) or not isinstance(decoded.get("candidates"), list):
        raise ValueError("raw output candidates are invalid")

    evidence_items: list[object] = []
    for candidate in decoded["candidates"]:
        if not isinstance(candidate, dict) or not isinstance(candidate.get("evidence"), list):
            raise ValueError("raw output evidence is invalid")
        evidence_items.extend(candidate["evidence"])
    return evidence_items


def replay_evidence_outputs(
    canonical_text: str,
    raw_outputs: Sequence[str],
) -> dict[str, Any]:
    """Recompute locator outcomes without retaining source or model text."""

    evidence_count = 0
    exact_count = 0
    rejections: Counter[str] = Counter()
    for raw_output in raw_outputs:
        for evidence in _require_raw_evidence(raw_output):
            evidence_count += 1
            try:
                locate_evidence(canonical_text, evidence)
            except CoreProblem as problem:
                if problem.code not in _LOCATOR_REJECTIONS:
                    raise ValueError("raw output contains non-contract evidence") from problem
                rejections[problem.code] += 1
            else:
                exact_count += 1

    return {
        "attemptCount": len(raw_outputs),
        "evidenceItemCount": evidence_count,
        "exactEvidenceCount": exact_count,
        "rejectionCounts": dict(sorted(rejections.items())),
        "exactEvidenceYield": exact_count / evidence_count if evidence_count else 0.0,
    }


def replay_qualification_passed(
    replay: dict[str, Any],
    stored: dict[str, Any],
) -> bool:
    """Bind a replay result to the source run and evidence cardinalities."""

    return bool(
        replay.get("attemptCount") == PHASE1E_EXPECTED_RUN_COUNT
        and stored.get("runCount") == PHASE1E_EXPECTED_RUN_COUNT
        and replay.get("evidenceItemCount") == stored.get("schemaValidEvidenceCount")
        and isinstance(replay.get("exactEvidenceYield"), (int, float))
        and replay["exactEvidenceYield"] >= PHASE1E_MINIMUM_EXACT_EVIDENCE_YIELD
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_source_database(database_path: Path) -> tuple[list[str], dict[str, Any]]:
    connection = sqlite3.connect(
        f"{database_path.resolve().as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    try:
        raw_outputs = [
            row[0]
            for row in connection.execute(
                "SELECT raw_output_json FROM generation_attempts "
                "WHERE status='succeeded' AND raw_output_json IS NOT NULL "
                "ORDER BY run_id,attempt_number"
            ).fetchall()
        ]
        control_rows = connection.execute(
            "SELECT d.text_sha256,r.schema_valid_evidence_count,"
            "r.exact_evidence_count,r.rejection_counts_json FROM runs r JOIN documents d ON d.id=r.document_id "
            "ORDER BY r.id"
        ).fetchall()
    finally:
        connection.close()

    document_hashes = sorted({row[0] for row in control_rows})
    stored_rejections: Counter[str] = Counter()
    for row in control_rows:
        decoded = json.loads(row[3])
        if not isinstance(decoded, dict):
            raise ValueError("stored rejection counts are invalid")
        stored_rejections.update({str(key): int(value) for key, value in decoded.items()})
    return raw_outputs, {
        "runCount": len(control_rows),
        "documentSha256Values": document_hashes,
        "schemaValidEvidenceCount": sum(int(row[1]) for row in control_rows),
        "exactEvidenceCount": sum(int(row[2]) for row in control_rows),
        "rejectionCounts": dict(sorted(stored_rejections.items())),
    }


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--document", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--source-artifact-sha256")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    database_path: Path = args.database.resolve()
    document_path: Path = args.document.resolve()
    canonical_text = document_path.read_text(encoding="utf-8")
    document_sha256 = _sha256_file(document_path)
    raw_outputs, stored = _read_source_database(database_path)
    if stored["documentSha256Values"] != [document_sha256]:
        raise SystemExit("REPLAY_DOCUMENT_DIGEST_MISMATCH")

    replay = replay_evidence_outputs(canonical_text, raw_outputs)
    passed = replay_qualification_passed(
        replay,
        stored,
    )
    locator_path = Path(__file__).with_name("evidence.py")
    constants_path = Path(__file__).with_name("constants.py")
    report = {
        "formatVersion": 1,
        "kind": "phase1e-locator-replay",
        "status": (
            "PHASE1E_LOCATOR_REPLAY_GO" if passed else "PHASE1E_LOCATOR_REPLAY_NO_GO"
        ),
        "source": {
            "databaseSha256": _sha256_file(database_path),
            "documentSha256": document_sha256,
            "sourceArtifactSha256": args.source_artifact_sha256,
            "storedStatistics": stored,
        },
        "replay": replay,
        "criteria": {
            "expectedAttempts": PHASE1E_EXPECTED_RUN_COUNT,
            "minimumExactEvidenceYield": PHASE1E_MINIMUM_EXACT_EVIDENCE_YIELD,
            "criteriaSource": "nobei_core.constants",
            "requiresStoredEvidenceCountMatch": True,
        },
        "locatorImplementationSha256": _sha256_file(locator_path),
        "criteriaImplementationSha256": _sha256_file(constants_path),
        "providerCalls": 0,
        "limitations": [
            "Replays frozen model outputs against the current locator only.",
            "Does not requalify the source artifact or claim a new real-model run.",
        ],
    }
    encoded = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    if args.output is None:
        print(encoded, end="")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
