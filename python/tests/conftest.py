from __future__ import annotations

from pathlib import Path

import pytest

from nobei_core.database import Phase1Database
from nobei_core.ownership import initialize_owned_root


PYTHON_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_ROOT = PYTHON_ROOT / "nobei_core" / "sql" / "v8"
PHASE1_SCHEMA_PATH = PYTHON_ROOT / "nobei_core" / "sql" / "phase1_schema.sql"


@pytest.fixture
def ownership_token() -> str:
    return "phase1-test-ownership-token"


@pytest.fixture
def owned_root(tmp_path: Path, ownership_token: str) -> Path:
    root = tmp_path / "owned"
    root.mkdir()
    initialize_owned_root(root, ownership_token)
    return root


@pytest.fixture
def database(owned_root: Path, ownership_token: str):
    opened = Phase1Database.open(
        owned_root,
        ownership_token,
        MIGRATIONS_ROOT,
        PHASE1_SCHEMA_PATH,
    )
    try:
        yield opened
    finally:
        opened.close()
