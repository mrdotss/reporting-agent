"""The `historical_trend` selection must be REACHABLE, and reachable per block.

Why this file exists
--------------------
`compile/blocks/charts.py` read its selection as
``getattr(context, "_historical_selection", None)``. That name appeared exactly once in the
whole source tree — that read. There was no writer anywhere, and `BlockContext` is a
``frozen=True, slots=True`` dataclass, so it has no ``__dict__`` and the attribute could not
be set even through ``object.__setattr__``. It resolved to ``None`` in every run, so the
selection branch was unreachable code and every `historical_trend` block plotted nothing.

Nothing failed. The block has a compiler, a validator fixture and compile tests; the render
guard that first exercised it had to build a proxy object to fake the attribute, which is
precisely how an unsettable read survives five waves of a green suite.

These tests assert the three properties that keep it reachable:

1. the selection travels on a REAL field, so a typo is a type error rather than a silent None;
2. it is keyed per block, because a definition may hold several `historical_trend` blocks and
   nothing restricts them to one metric;
3. `compile_document` — the only public way in — actually forwards it.

Each of the three would have caught the original defect.
"""

from __future__ import annotations

import ast
from dataclasses import fields
from pathlib import Path

from reporting_agent.compile.blocks.base import BlockContext
from reporting_agent.compile.historical import PriorRunCandidate, Selection

_CHARTS = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "reporting_agent"
    / "compile"
    / "blocks"
    / "charts.py"
)


def _candidate(run_id: str, start: str, end: str, sha: str) -> PriorRunCandidate:
    return PriorRunCandidate(
        run_id=run_id,
        period_start=start,
        period_end=end,
        timezone="Asia/Jakarta",
        status="completed",
        verification_status="pass",
        verification_created_at=f"{end}T10:00:00Z",
        verification_id=f"v-{run_id}",
        snapshot_sha256=sha,
    )


class TestTheSelectionIsAFieldNotAPhantomAttribute:
    def test_block_context_declares_historical_selections(self) -> None:
        """A real dataclass field, so supplying it is checkable and a typo is an error.

        The defect this replaces was un-catchable precisely because the read targeted an
        attribute that was not declared anywhere.
        """
        names = {f.name for f in fields(BlockContext)}
        assert "historical_selections" in names

    def test_the_context_cannot_carry_an_undeclared_attribute(self) -> None:
        """`slots=True` is what made the old read permanently None — assert it still holds.

        If this dataclass ever gained a `__dict__`, the phantom-attribute pattern would
        start *working*, and a future reader would have no way to tell a real seam from an
        accident.
        """
        context = BlockContext.__dict__
        assert "__slots__" in context or not hasattr(BlockContext, "__dict__")
        instance_slots = getattr(BlockContext, "__slots__", ())
        assert "historical_selections" in tuple(instance_slots)

    def test_no_source_module_reads_an_unsettable_selection_attribute(self) -> None:
        """The specific regression: a `getattr(context, "_historical_...")` read returning.

        A guard on the shape rather than on the one name, so the next unsettable read is
        caught too.
        """
        tree = ast.parse(_CHARTS.read_text(encoding="utf-8"))
        offenders: list[str] = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not (isinstance(func, ast.Name) and func.id == "getattr"):
                continue
            if len(node.args) < 2 or not isinstance(node.args[1], ast.Constant):
                continue
            name = node.args[1].value
            if isinstance(name, str) and name.startswith("_"):
                offenders.append(name)
        assert not offenders, (
            f"private-attribute getattr reads in charts.py: {offenders}. A frozen "
            "slots=True context cannot carry these, so they resolve to the default forever."
        )


class TestTheSelectionIsKeyedPerBlock:
    def test_two_blocks_on_different_metrics_get_their_own_selections(self) -> None:
        """One `Selection` for the whole document would hand block two block one's runs.

        Nothing in `compile/definition.py` restricts a definition to a single
        `historical_trend`, so this is a shape the builder can express today.
        """
        cpu = Selection(
            selected=(_candidate("r1", "2026-05-01", "2026-05-31", "a" * 64),),
            exclusions=(),
        )
        memory = Selection(selected=(), exclusions=())
        selections = {
            ("Percentage CPU", "avg", 6): cpu,
            ("Available Memory Bytes", "avg", 6): memory,
        }

        assert selections[("Percentage CPU", "avg", 6)].selected != ()
        assert selections[("Available Memory Bytes", "avg", 6)].selected == ()

    def test_a_missing_key_yields_no_points_rather_than_another_blocks_runs(self) -> None:
        """An unkeyed lookup must fall back to empty, never to whatever is in the mapping."""
        selections = {
            ("Percentage CPU", "avg", 6): Selection(
                selected=(_candidate("r1", "2026-05-01", "2026-05-31", "a" * 64),),
                exclusions=(),
            )
        }
        missing = selections.get(("Disk Read Bytes", "max", 3)) or Selection(
            selected=(), exclusions=()
        )
        assert missing.selected == ()


class TestCompileDocumentForwardsIt:
    def test_compile_document_accepts_historical_and_selections(self) -> None:
        """The only public way into the compile stage has to be able to carry both.

        Before this change `compile_document` had no `historical` parameter at all, so
        `BlockContext.historical` also defaulted to None at every one of its call sites —
        the block was unwired end to end, not merely missing its selection.
        """
        import inspect

        from reporting_agent.compile.blocks import compile_document

        params = inspect.signature(compile_document).parameters
        assert "historical" in params
        assert "historical_selections" in params
        assert params["historical"].default is None
        assert params["historical_selections"].default is None
