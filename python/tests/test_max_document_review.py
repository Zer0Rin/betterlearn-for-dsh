"""Full-size valid inputs must remain reviewable and replayable."""
from __future__ import annotations

import json

import pytest

from nobei_core.constants import MAX_DOCUMENT_BYTES, MAX_IDEMPOTENCY_RESULT_BYTES
from nobei_core.contract import load_candidate_contract
from nobei_core.service import Phase1Core
from conftest import PYTHON_ROOT


@pytest.mark.parametrize("action", ["accept", "edited_and_accept", "reject"])
@pytest.mark.parametrize("padding", ["x", "\t"])
def test_maximum_document_review_preserves_full_snapshot_and_replay(database, action, padding):
    core = Phase1Core(database, load_candidate_contract(PYTHON_ROOT.parent))
    text = padding * (MAX_DOCUMENT_BYTES - 6) + "UNIQUE"
    prepared = core.import_and_prepare_generation({
        "filename": "maximum.txt", "mediaType": "text/plain", "text": text,
        "modelSelection": {"provider": "fake", "model": "fake"},
    })
    core.submit_generation({
        "runId": prepared["runId"], "attemptId": prepared["attemptId"],
        "expectedRevision": prepared["revision"],
        "output": {"schemaVersion": 1, "candidates": [{
            "type": "fact", "title": "Original", "statement": "Original statement",
            "evidence": [{"quote": "UNIQUE", "prefix": "", "suffix": ""}],
        }]},
    })
    candidate = core.list_candidates({"runId": prepared["runId"]})["candidates"][0]
    command = {
        "candidateId": candidate["candidateId"], "action": action,
        "expectedRevision": 1, "idempotencyKey": "idem_" + "a" * 20,
    }
    if action == "edited_and_accept":
        command.update(title="\t" * 120, statement="\t" * 2000)
    result = core.review_candidate(command)
    assert result["run"]["status"] == "completed"
    assert result["run"]["document"]["text"] == text
    assert result["run"]["document"]["byteSize"] == MAX_DOCUMENT_BYTES
    assert result["candidate"]["evidence"][0]["textStart"] == MAX_DOCUMENT_BYTES - 6
    stored = database.one("SELECT result_json FROM idempotency_records")["result_json"]
    assert 65_536 < len(stored.encode("utf-8")) <= MAX_IDEMPOTENCY_RESULT_BYTES
    assert json.loads(stored) == result
    before = (database.scalar("SELECT COUNT(*) FROM candidate_reviews"),
              database.scalar("SELECT COUNT(*) FROM knowledge_points"),
              database.scalar("SELECT COUNT(*) FROM run_events"))
    assert core.review_candidate(command) == result
    assert before == (database.scalar("SELECT COUNT(*) FROM candidate_reviews"),
                      database.scalar("SELECT COUNT(*) FROM knowledge_points"),
                      database.scalar("SELECT COUNT(*) FROM run_events"))
