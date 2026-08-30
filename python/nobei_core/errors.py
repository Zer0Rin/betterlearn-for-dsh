"""Safe public domain errors for the Phase 1B Core."""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType
from typing import Any

from nobei_core.constants import PUBLIC_ERROR_CODES


_REQUEST_TOO_LARGE_DATA_KEYS = frozenset({"actualBytes", "maxBytes"})


class CoreProblem(Exception):
    """A domain failure whose public projection never includes its message."""

    def __init__(self, code: str, message: str, data: dict[str, Any] | None = None) -> None:
        if not isinstance(code, str) or code not in PUBLIC_ERROR_CODES:
            raise ValueError("CoreProblem code must be public")
        if data is not None:
            if code != "REQUEST_TOO_LARGE" or not isinstance(data, dict):
                raise ValueError("CoreProblem data is not public")
            if frozenset(data) != _REQUEST_TOO_LARGE_DATA_KEYS:
                raise ValueError("CoreProblem data is not public")
            if any(type(data[key]) is not int or data[key] < 0 for key in _REQUEST_TOO_LARGE_DATA_KEYS):
                raise ValueError("CoreProblem data is not public")
        super().__init__(code)
        self.code = code
        self.message = message
        self._data = MappingProxyType(dict(data)) if data is not None else None

    @property
    def data(self) -> Mapping[str, int] | None:
        """Expose validated public data without exposing mutable retained state."""
        return self._data

    def public(self) -> dict[str, object]:
        return {
            "code": self.code,
            **({"data": dict(self._data)} if self._data else {}),
        }
