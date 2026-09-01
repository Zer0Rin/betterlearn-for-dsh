from __future__ import annotations

import pytest

from nobei_core.contract import load_candidate_contract
from nobei_core.errors import CoreProblem
from nobei_core.service import Phase1Core

from conftest import PYTHON_ROOT


@pytest.fixture
def core(database):
    return Phase1Core(database, load_candidate_contract(PYTHON_ROOT.parent))


def _import(
    core: Phase1Core,
    filename: str,
    media_type: str = "text/markdown",
) -> dict[str, object]:
    return core.import_text(
        {"filename": filename, "mediaType": media_type, "text": f"# {filename}"}
    )


def test_list_runs_returns_empty_closed_result(core: Phase1Core):
    assert core.list_runs({}) == {"runs": []}


def test_list_runs_returns_global_summaries_in_updated_order(
    core: Phase1Core, database
):
    older = _import(core, "旧材料.md")
    newer = _import(core, "新材料.md")
    with database.write_transaction() as con:
        con.execute(
            "UPDATE runs SET updated_at='2026-09-01T01:00:00Z',"
            "valid_candidate_count=7,accepted_candidate_count=3 WHERE id=?",
            (older["runId"],),
        )
        con.execute(
            "UPDATE runs SET updated_at='2026-09-01T02:00:00Z',"
            "valid_candidate_count=11,accepted_candidate_count=5 WHERE id=?",
            (newer["runId"],),
        )

    result = core.list_runs({})

    assert [row["runId"] for row in result["runs"]] == [
        newer["runId"],
        older["runId"],
    ]
    assert result["runs"][0] == {
        "runId": newer["runId"],
        "sourceType": "document",
        "sourceLabel": "新材料.md",
        "status": "awaiting_generation",
        "stage": "extract",
        "updatedAt": "2026-09-01T02:00:00Z",
        "candidateCount": 11,
        "knowledgePointCount": 5,
    }


def test_list_runs_identifies_dsh_conversation_sources(core: Phase1Core, database):
    imported = _import(
        core,
        "DSH对话合集-复习主题.md",
        "application/vnd.betterlearn.dsh-conversation+markdown",
    )
    with database.write_transaction() as con:
        con.execute(
            "UPDATE runs SET updated_at='2026-09-01T03:00:00Z' WHERE id=?",
            (imported["runId"],),
        )

    assert core.list_runs({})["runs"][0] == {
        "runId": imported["runId"],
        "sourceType": "dsh_conversation",
        "sourceLabel": "DSH对话合集-复习主题.md",
        "status": "awaiting_generation",
        "stage": "extract",
        "updatedAt": "2026-09-01T03:00:00Z",
        "candidateCount": 0,
        "knowledgePointCount": 0,
    }


def test_list_runs_uses_stable_secondary_order(core: Phase1Core, database):
    first = _import(core, "甲.md")
    second = _import(core, "乙.md")
    with database.write_transaction() as con:
        con.execute(
            "UPDATE runs SET updated_at='2026-09-01T02:00:00Z',"
            "created_at='2026-09-01T01:00:00Z' WHERE id IN (?,?)",
            (first["runId"], second["runId"]),
        )

    observed = [row["runId"] for row in core.list_runs({})["runs"]]

    assert observed == sorted([first["runId"], second["runId"]], reverse=True)


@pytest.mark.parametrize(
    ("status", "stage"),
    [
        ("created", "source"),
        ("document_ready", "parse"),
        ("awaiting_generation", "extract"),
        ("generating", "extract"),
        ("validating", "verify"),
        ("review_pending", "confirm"),
        ("completed", "done"),
        ("failed_retryable", "failed"),
        ("failed_terminal", "failed"),
    ],
)
def test_list_runs_preserves_every_core_status(
    core: Phase1Core, database, status: str, stage: str
):
    imported = _import(core, f"{status}.md")
    with database.write_transaction() as con:
        con.execute(
            "UPDATE runs SET status=?,stage=? WHERE id=?",
            (status, stage, imported["runId"]),
        )

    summary = core.list_runs({})["runs"][0]

    assert (summary["status"], summary["stage"]) == (status, stage)


@pytest.mark.parametrize("params", [None, {"limit": 20}, [], ""])
def test_list_runs_rejects_non_empty_or_non_object_params(core: Phase1Core, params):
    with pytest.raises(CoreProblem) as caught:
        core.list_runs(params)

    assert caught.value.code == "INVALID_PARAMS"
