from __future__ import annotations

import json

from nobei_core.evidence_replay import replay_evidence_outputs, replay_qualification_passed


def test_replays_frozen_outputs_without_retaining_document_or_model_text():
    canonical_text = "唯一证据。重复。重复。"
    raw_output = json.dumps(
        {
            "candidates": [
                {
                    "evidence": [
                        {
                            "quote": "唯一证据",
                            "prefix": "模型改写的前缀",
                            "suffix": "！",
                        },
                        {"quote": "重复", "prefix": "", "suffix": "。"},
                        {"quote": "不存在", "prefix": "", "suffix": ""},
                    ]
                }
            ]
        },
        ensure_ascii=False,
    )

    report = replay_evidence_outputs(canonical_text, [raw_output])

    assert report == {
        "attemptCount": 1,
        "evidenceItemCount": 3,
        "exactEvidenceCount": 1,
        "rejectionCounts": {
            "EVIDENCE_AMBIGUOUS": 1,
            "EVIDENCE_NOT_FOUND": 1,
        },
        "exactEvidenceYield": 1 / 3,
    }
    encoded = json.dumps(report, ensure_ascii=False)
    assert canonical_text not in encoded
    assert "模型改写的前缀" not in encoded


def test_empty_replay_has_zero_yield():
    assert replay_evidence_outputs("正文", []) == {
        "attemptCount": 0,
        "evidenceItemCount": 0,
        "exactEvidenceCount": 0,
        "rejectionCounts": {},
        "exactEvidenceYield": 0.0,
    }


def test_replay_qualification_binds_attempt_and_evidence_counts_to_source_database():
    replay = {
        "attemptCount": 20,
        "evidenceItemCount": 133,
        "exactEvidenceYield": 1.0,
    }
    stored = {"runCount": 20, "schemaValidEvidenceCount": 133}

    assert replay_qualification_passed(replay, stored)
    assert not replay_qualification_passed(
        {**replay, "evidenceItemCount": 132}, stored
    )
    assert not replay_qualification_passed(
        replay, {**stored, "runCount": 19}
    )


def test_replay_cli_does_not_allow_callers_to_lower_the_frozen_gate(monkeypatch):
    from nobei_core import evidence_replay

    monkeypatch.setattr(
        "sys.argv",
        ["evidence-replay", "--database", "sample.db", "--document", "fixture.md"],
    )
    parsed = evidence_replay._parse_args()

    assert not hasattr(parsed, "minimum_yield")
    assert not hasattr(parsed, "expected_attempts")
