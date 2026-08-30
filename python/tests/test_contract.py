import hashlib
from pathlib import Path

import pytest

from nobei_core.contract import GENERATION_SCHEMA_INVALID, load_candidate_contract


@pytest.fixture
def package_root() -> Path:
    return Path(__file__).resolve().parents[2]


def valid_candidates() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "candidates": [
            {
                "type": "concept",
                "title": "Photosynthesis",
                "statement": "Plants convert light energy into chemical energy.",
                "evidence": [
                    {
                        "quote": "Plants convert light energy into chemical energy.",
                        "prefix": "",
                        "suffix": "",
                    }
                ],
            }
        ],
    }


def test_contract_loads_draft_2020_12_resource_and_sha(package_root: Path):
    contract = load_candidate_contract(package_root)
    schema_path = package_root / "contracts" / "l1-candidate.schema.json"

    assert contract.schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert contract.schema_sha256 == hashlib.sha256(schema_path.read_bytes()).hexdigest()
    assert GENERATION_SCHEMA_INVALID == "GENERATION_SCHEMA_INVALID"


def test_contract_parses_the_bytes_used_for_its_sha(tmp_path: Path, package_root: Path, monkeypatch):
    schema_path = tmp_path / "contracts" / "l1-candidate.schema.json"
    schema_path.parent.mkdir()
    original_bytes = (package_root / "contracts" / "l1-candidate.schema.json").read_bytes()
    replacement_bytes = original_bytes.replace(b'"const": 1', b'"const": 2', 1)
    schema_path.write_bytes(original_bytes)
    original_read_text = Path.read_text

    def replace_before_read(self: Path, *args, **kwargs):
        if self == schema_path:
            self.write_bytes(replacement_bytes)
        return original_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", replace_before_read)

    contract = load_candidate_contract(tmp_path)

    assert contract.schema_version == 1
    assert contract.schema_sha256 == hashlib.sha256(original_bytes).hexdigest()


def test_contract_accepts_empty_candidates_and_rejects_extra_fields(package_root):
    contract = load_candidate_contract(package_root)
    assert contract.schema_version == 1
    assert contract.validate({"schemaVersion": 1, "candidates": []}) == []
    errors = contract.validate({"schemaVersion": 1, "candidates": [], "extra": True})
    assert errors == [{"path": "$", "keyword": "additionalProperties"}]


def test_contract_rejects_overlong_and_unknown_candidate_fields(package_root):
    value = valid_candidates()
    value["candidates"][0]["title"] = "x" * 121
    value["candidates"][0]["databaseId"] = "kp_forbidden"
    assert load_candidate_contract(package_root).validate(value) == [
        {"path": "$.candidates[0]", "keyword": "additionalProperties"},
        {"path": "$.candidates[0].title", "keyword": "maxLength"},
    ]


def test_contract_rejects_future_references(tmp_path: Path):
    schema_path = tmp_path / "contracts" / "l1-candidate.schema.json"
    schema_path.parent.mkdir()
    schema_path.write_text(
        '{"$schema":"https://json-schema.org/draft/2020-12/schema","$ref":"https://example.invalid/schema.json"}',
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="CANDIDATE_CONTRACT_REFERENCES_FORBIDDEN"):
        load_candidate_contract(tmp_path)
