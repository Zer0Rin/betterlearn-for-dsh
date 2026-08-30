from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

GENERATION_SCHEMA_INVALID = "GENERATION_SCHEMA_INVALID"


def _contains_reference(value: object) -> bool:
    if isinstance(value, list):
        return any(_contains_reference(item) for item in value)
    if not isinstance(value, dict):
        return False
    return any(key == "$ref" or _contains_reference(item) for key, item in value.items())


def _json_path(path: object) -> str:
    result = "$"
    for part in path:
        result += f"[{part}]" if isinstance(part, int) else f".{part}"
    return result


@dataclass(frozen=True)
class CandidateContract:
    schema: dict[str, Any]
    schema_version: int
    schema_sha256: str
    _validator: Draft202012Validator

    def validate(self, value: object) -> list[dict[str, str]]:
        errors = sorted(
            self._validator.iter_errors(value),
            key=lambda error: (list(error.absolute_path), error.validator),
        )
        return [
            {"path": _json_path(error.absolute_path), "keyword": str(error.validator)}
            for error in errors
        ]


def load_candidate_contract(package_root: str | Path) -> CandidateContract:
    schema_path = Path(package_root) / "contracts" / "l1-candidate.schema.json"
    schema_bytes = schema_path.read_bytes()
    schema = json.loads(schema_bytes.decode("utf-8"))
    if _contains_reference(schema):
        raise ValueError("CANDIDATE_CONTRACT_REFERENCES_FORBIDDEN")
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    schema_version = schema["properties"]["schemaVersion"]["const"]
    if not isinstance(schema_version, int):
        raise ValueError("CANDIDATE_CONTRACT_SCHEMA_VERSION_MISSING")
    return CandidateContract(
        schema=schema,
        schema_version=schema_version,
        schema_sha256=hashlib.sha256(schema_bytes).hexdigest(),
        _validator=validator,
    )
