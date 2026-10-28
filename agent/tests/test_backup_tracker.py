"""The backup tracker's reading of AWS recovery points, without a report around it.

What must hold, and why each is here:

* the strip reads back exactly the days the collector wrote, complete and partial apart,
  because a mark is a claim that a backup ran;
* a part it cannot read marks nothing rather than a guess;
* the collected text never passes the fact bound, and over it the oldest month goes first,
  because the newest days are the ones a report's period reads;
* the strip is one glyph per day, weeks a space apart, and carries no digit, so it adds
  nothing the verifier would have to admit.
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime, timedelta

from reporting_agent.aws.facts import MAX_TEXT, recovery_point_days
from reporting_agent.compile.blocks.backup import STRIP_GLYPHS, _glyphs, recovery_days


def _point(day: date, status: str = "COMPLETED") -> dict[str, object]:
    return {"CreationDate": datetime(day.year, day.month, day.day, 2, tzinfo=UTC), "Status": status}


def test_the_strip_reads_back_what_the_collector_wrote() -> None:
    points = [_point(date(2026, 9, d)) for d in range(1, 15)] + [
        _point(date(2026, 9, 15), "PARTIAL"),
        *(_point(date(2026, 9, d)) for d in range(16, 31)),
        _point(date(2026, 10, 1)),
    ]
    text = recovery_point_days(points, UTC)
    assert text == "2026-09 1-14,~15,16-30; 2026-10 1"

    days = recovery_days(text)
    assert days[date(2026, 9, 15)] is False
    assert all(days[date(2026, 9, d)] for d in (*range(1, 15), *range(16, 31)))
    assert days[date(2026, 10, 1)] is True
    assert len(days) == 31


def test_none_and_a_malformed_part_mark_nothing() -> None:
    assert recovery_days("none") == {}
    assert recovery_days("2026-09 1-3,x,~31; garbage") == {
        date(2026, 9, 1): True,
        date(2026, 9, 2): True,
        date(2026, 9, 3): True,
    }


def test_the_text_keeps_the_newest_months_within_the_bound() -> None:
    """Alternate complete and partial days for three months is the longest text there is."""
    start = date(2026, 7, 1)
    points = [
        _point(start + timedelta(days=n), "PARTIAL" if n % 2 else "COMPLETED")
        for n in range((date(2026, 9, 30) - start).days + 1)
    ]
    text = recovery_point_days(points, UTC)
    assert len(text) <= MAX_TEXT
    assert text.endswith(recovery_point_days([p for p in points if p["CreationDate"].month == 9], UTC))  # type: ignore[union-attr]
    assert not text.startswith("2026-07")


def test_the_strip_is_a_glyph_a_day_and_no_digit() -> None:
    days = tuple(date(2026, 9, 1) + timedelta(days=n) for n in range(30))
    strip = _glyphs(days, {date(2026, 9, 1): True, date(2026, 9, 2): False})
    assert strip.split(" ")[0] == STRIP_GLYPHS["full"] + STRIP_GLYPHS["partial"] + STRIP_GLYPHS["none"] * 5
    assert [len(week) for week in strip.split(" ")] == [7, 7, 7, 7, 2]
    assert re.search(r"\d", strip) is None
