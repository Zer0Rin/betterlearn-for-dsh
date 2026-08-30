from __future__ import annotations

import pytest

from nobei_core.evidence import LocatedEvidence, locate_evidence
from nobei_core.errors import CoreProblem


@pytest.mark.parametrize(
    ("text", "evidence", "expected"),
    [
        ("甲乙丙", {"quote": "乙", "prefix": "甲", "suffix": "丙"}, (1, 2)),
        (
            "定义：能量。再次定义：能量。",
            {"quote": "能量", "prefix": "定义：", "suffix": "。"},
            "EVIDENCE_AMBIGUOUS",
        ),
        (
            "第一处：能量。第二处：能量！",
            {"quote": "能量", "prefix": "第二处：", "suffix": "！"},
            (11, 13),
        ),
        (
            "正文",
            {"quote": "不存在", "prefix": "", "suffix": ""},
            "EVIDENCE_NOT_FOUND",
        ),
        ("abc", {"quote": "", "prefix": "", "suffix": ""}, "EVIDENCE_NOT_FOUND"),
    ],
)
def test_exact_location(
    text: str,
    evidence: dict[str, str],
    expected: tuple[int, int] | str,
):
    if isinstance(expected, tuple):
        located = locate_evidence(text, evidence)
        assert (located.text_start, located.text_end) == expected
        assert text[located.text_start : located.text_end] == evidence["quote"]
    else:
        with pytest.raises(CoreProblem, match=expected):
            locate_evidence(text, evidence)


def test_returns_frozen_exact_span_with_stable_bounded_context():
    before = "前" * 240
    quote = "证据"
    after = "后" * 230

    located = locate_evidence(
        before + quote + after,
        {"quote": quote, "prefix": "", "suffix": ""},
    )

    assert located == LocatedEvidence(
        text_start=240,
        text_end=242,
        context_before="前" * 200,
        context_after="后" * 200,
    )
    assert len(located.context_before) == 200
    assert len(located.context_after) == 200
    with pytest.raises((AttributeError, TypeError)):
        located.text_start = 0  # type: ignore[misc]


def test_offsets_are_half_open_unicode_code_point_offsets():
    text = "甲😀乙𐀀丙"

    located = locate_evidence(
        text,
        {"quote": "乙𐀀", "prefix": "😀", "suffix": "丙"},
    )

    assert (located.text_start, located.text_end) == (2, 4)
    assert text[located.text_start : located.text_end] == "乙𐀀"
    assert located.context_before == "甲😀"
    assert located.context_after == "丙"


@pytest.mark.parametrize(
    ("text", "quote"),
    [
        ("ＡＢＣ", "ABC"),
        ("café", "café"),
        ("甲 乙", "甲乙"),
        ("甲\t乙", "甲 乙"),
        ("甲\n乙", "甲 乙"),
    ],
)
def test_does_not_normalize_or_fuzzily_align(text: str, quote: str):
    with pytest.raises(CoreProblem, match="EVIDENCE_NOT_FOUND"):
        locate_evidence(text, {"quote": quote, "prefix": "", "suffix": ""})


@pytest.mark.parametrize(
    "evidence",
    [
        {"quote": "能量", "prefix": "不存在", "suffix": "。"},
        {"quote": "能量", "prefix": "", "suffix": "！"},
    ],
)
def test_repeated_quote_without_a_unique_context_match_is_ambiguous(
    evidence: dict[str, str],
):
    with pytest.raises(CoreProblem, match="EVIDENCE_AMBIGUOUS"):
        locate_evidence("定义：能量。再次定义：能量。", evidence)


def test_unique_quote_does_not_require_model_context_to_match():
    text = "定义：唯一证据。"

    located = locate_evidence(
        text,
        {"quote": "唯一证据", "prefix": "错误：", "suffix": "！"},
    )

    assert (located.text_start, located.text_end) == (3, 7)
    assert text[located.text_start : located.text_end] == "唯一证据"


@pytest.mark.parametrize(
    ("evidence", "expected"),
    [
        (
            {"quote": "重复事实", "prefix": "甲段标题\n\n", "suffix": "。甲结论"},
            (6, 10),
        ),
        (
            {"quote": "重复事实", "prefix": "乙段标题\n\n", "suffix": "。乙结论"},
            (22, 26),
        ),
        (
            {"quote": "重复事实", "prefix": "甲段标题", "suffix": "。甲结论"},
            "EVIDENCE_AMBIGUOUS",
        ),
        (
            {"quote": "重复事实", "prefix": "乙段标题，\n\n", "suffix": "。乙结论"},
            "EVIDENCE_AMBIGUOUS",
        ),
        (
            {"quote": "重复事实", "prefix": "", "suffix": ""},
            "EVIDENCE_AMBIGUOUS",
        ),
    ],
)
def test_repeated_quote_requires_one_exact_adjacent_window(
    evidence: dict[str, str],
    expected: tuple[int, int] | str,
):
    text = "甲段标题\n\n重复事实。甲结论\n\n乙段标题\n\n重复事实。乙结论"
    if isinstance(expected, tuple):
        located = locate_evidence(text, evidence)
        assert (located.text_start, located.text_end) == expected
    else:
        with pytest.raises(CoreProblem, match=expected):
            locate_evidence(text, evidence)


def test_overlapping_occurrences_are_all_considered_for_ambiguity():
    with pytest.raises(CoreProblem, match="EVIDENCE_AMBIGUOUS"):
        locate_evidence("aaa", {"quote": "aa", "prefix": "", "suffix": ""})


def test_overlapping_context_windows_are_all_considered_for_ambiguity():
    with pytest.raises(CoreProblem, match="EVIDENCE_AMBIGUOUS"):
        locate_evidence(
            "ababa",
            {"quote": "b", "prefix": "a", "suffix": "a"},
        )


@pytest.mark.parametrize(
    "evidence",
    [
        None,
        [],
        {},
        {"quote": "x", "prefix": ""},
        {"quote": "x", "prefix": "", "suffix": "", "offset": 0},
        {"quote": 1, "prefix": "", "suffix": ""},
        {"quote": "x", "prefix": None, "suffix": ""},
        {"quote": "x", "prefix": "", "suffix": []},
        {"quote": "x" * 2001, "prefix": "", "suffix": ""},
        {"quote": "x", "prefix": "p" * 201, "suffix": ""},
        {"quote": "x", "prefix": "", "suffix": "s" * 201},
    ],
)
def test_rejects_non_closed_or_out_of_bounds_evidence(evidence: object):
    with pytest.raises(CoreProblem, match="GENERATION_SCHEMA_INVALID") as raised:
        locate_evidence("private canonical text", evidence)

    assert raised.value.public() == {"code": "GENERATION_SCHEMA_INVALID"}
    assert "private canonical text" not in raised.value.message


def test_rejects_non_string_canonical_text_without_leaking_evidence():
    private_quote = "private candidate evidence"

    with pytest.raises(CoreProblem, match="INVALID_DOCUMENT") as raised:
        locate_evidence(
            None,
            {"quote": private_quote, "prefix": "", "suffix": ""},
        )

    assert raised.value.public() == {"code": "INVALID_DOCUMENT"}
    assert private_quote not in raised.value.message
