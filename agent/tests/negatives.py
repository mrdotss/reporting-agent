"""The shared machinery of the mandatory negative suite (Req 44).

A gate that has never been observed to fail is not a gate. Every test built on this module
constructs a fixture, applies **exactly one** mutation, and asserts a failure — and the value
of that assertion rests entirely on two preconditions and three absences, which live here so
that no individual test can quietly omit one.

## The two preconditions

**The unmutated fixture passes first** (Req 44.13). :meth:`Negative.baseline` runs the same
definition through the same pipeline with no mutation at all and asserts a `pass` carrying
zero blocking findings, before the mutated run happens. Without it a broken fixture makes
every test in the suite green while proving nothing — the failure mode a negative suite is
uniquely prone to, because a negative test that fails for the wrong reason still fails.

**The recorded blocking types are exactly the declared set** (Req 44.14).
:func:`assert_blocking` compares sets rather than asking whether the named type is present.
`assert FINDING_X in types` passes on a document that recorded eleven other blocking findings
as well, which is how a transposition test passes against a verifier that failed the document
for an unrelated reason.

Declarations live in :data:`DECLARED`, keyed by test function name, rather than being passed
inline. Two reasons: task 14.8's meta-test reads that table to prove every one of the sixteen
blocking types is asserted somewhere, and :func:`declared` raises for a test that is not in
it — so a negative test cannot be added without declaring what it expects.

## The three absences (Req 44.12)

:func:`assert_nothing_delivered` asserts all three for every mutated run: **zero**
`report_file` events, **no** report artifact written under the run's prefix (so no key exists
to presign), and an empty `outcome.artifacts`. The web-app half of that criterion — that no
route, action or control returns a presigned URL for such a run — is asserted from the other
side of the boundary in `app/test/download-gate.negative.test.ts`, because it is a claim
about the app's own code paths and an agent-side assertion could only restate it.

## Why every test drives the whole pipeline

A mutation applied to a document the verifier is handed directly proves the verifier records
a finding. It does not prove the **run** failed, that no artifact was uploaded, or that the
terminal code is the one the requirement names — and those are three quarters of what Req
44.2 through 44.8 actually ask for. So the mutations here are injected into the production
path at the seam where the artifact is produced, and the assertions read the events, the
object store and the raised error that a real run would have produced.
"""

from __future__ import annotations

import io
import os
from collections.abc import Callable, Mapping, Sequence
from contextlib import ExitStack, contextmanager
from typing import Any, Final
from unittest import mock

from docx import Document as open_docx
from docx.oxml.ns import qn

from pipeline_harness import Pipeline, report_objects, types_of
from reporting_agent.errors import AgentError
from reporting_agent.verify.findings import SEVERITY_BLOCKING

__all__ = [
    "COMMA_DECIMAL_LOCALE",
    "DECLARED",
    "Negative",
    "append_paragraph",
    "assert_blocking",
    "assert_nothing_delivered",
    "blocking_types",
    "captioned_tables",
    "cell_text",
    "clone_table",
    "declare",
    "declared",
    "drop_data_rows",
    "drop_table",
    "flip_one_digit",
    "rewrite_cell",
    "set_cell_text",
    "swap_columns",
]

COMMA_DECIMAL_LOCALE: Final[str] = "en_DK.utf8"
"""A locale whose `LC_NUMERIC` decimal separator is a comma (Req 44.7).

`en_DK` rather than the `de_DE` the requirement's prose reaches for, because the base image
and the CI host both ship the `en_*` set and neither generates a German locale — and a test
that silently falls back to `C` when its locale is missing is a test that applies no mutation
while asserting one was caught.
"""

# --------------------------------------------------------------------------- #
# What each negative test declares (Req 44.14, and 14.8's meta-test reads it)
# --------------------------------------------------------------------------- #

DECLARED: Final[dict[str, frozenset[str]]] = {}
"""Populated by the negative modules at import time; see :func:`declare`.

A module-level table rather than a decorator's side effect on the test function, because
14.8's meta-test needs every declaration without running — or even collecting — any of them.
"""


def declare(name: str, *types: str) -> frozenset[str]:
    """Register a test's expected blocking finding types and return them."""
    expected = frozenset(types)
    existing = DECLARED.get(name)
    if existing is not None and existing != expected:
        raise AssertionError(
            f"{name} is declared twice with different expectations: "
            f"{sorted(existing)} then {sorted(expected)}"
        )
    DECLARED[name] = expected
    return expected


def declared(name: str) -> frozenset[str]:
    """The declared set for `name`, or an error naming the omission."""
    try:
        return DECLARED[name]
    except KeyError:
        raise AssertionError(
            f"{name} asserts a verification failure without declaring which blocking "
            f"finding types it expects. Every negative test declares its set through "
            f"negatives.declare(...), because Req 44.14 is a set equality and 14.8's "
            f"meta-test reads the declarations to prove every blocking type is exercised"
        ) from None


# --------------------------------------------------------------------------- #
# Assertions every negative test makes
# --------------------------------------------------------------------------- #


def blocking_types(result: Mapping[str, Any]) -> set[str]:
    return {
        str(finding["type"])
        for finding in result["findings"]
        if finding.get("severity") == SEVERITY_BLOCKING
    }


def assert_blocking(result: Mapping[str, Any], expected: frozenset[str]) -> None:
    """Req 44.14 — set equality, never membership.

    Also asserts the count the result carries agrees with the list it carries, because
    `build_result` derives `status` from the count and truncates the list: a test reading only
    the list would not notice the two disagreeing.
    """
    observed = blocking_types(result)
    assert result["status"] == "fail", result["findings"]
    assert observed == expected, (
        f"expected exactly {sorted(expected)}; recorded {sorted(observed)}. A negative "
        f"test that passes on an undeclared finding is passing for a reason other than "
        f"the one it is named after"
    )
    assert int(result["counts"]["blocking_findings_observed"]) >= len(observed)


def assert_nothing_delivered(run: Negative) -> None:
    """Req 44.12 — the three absences, for every negative run."""
    assert types_of(run.events).count("report_file") == 0, types_of(run.events)
    assert run.pipeline.outcome.artifacts == (), run.pipeline.outcome.artifacts
    delivered = [
        key
        for key in report_objects(run.pipeline.store)
        if not key.rsplit("/", 1)[-1].startswith("verification-")
    ]
    assert delivered == [], (
        f"a failing run left {delivered} under its report prefix; every one of those is a "
        f"key the app could be asked to presign"
    )


# --------------------------------------------------------------------------- #
# One mutated run
# --------------------------------------------------------------------------- #


class Negative:
    """One pipeline invocation carrying at most one mutation.

    Constructed with the mutation, then :meth:`baseline` and :meth:`run` are called in that
    order — `baseline` re-runs the identical definition with every hook removed, which is what
    makes Req 44.13's precondition a property of the harness rather than of each test's
    discipline.
    """

    def __init__(
        self,
        *,
        definition: Mapping[str, Any] | None = None,
        prose: Any | None = None,
        resources: Sequence[str] | None = None,
        docx: Callable[[bytes], bytes] | None = None,
        sidecars: Callable[[dict[str, bytes]], Mapping[str, bytes]] | None = None,
        archive: Callable[
            [tuple[tuple[int, bytes], ...]], tuple[tuple[int, bytes], ...]
        ]
        | None = None,
        pdf_text: Callable[[str], str] | None = None,
        conversion_locale: str | None = None,
        snapshot: Callable[[dict[str, Any]], Mapping[str, Any]] | None = None,
        compiled: Callable[[Any, Any], None] | None = None,
        verified_definition: Callable[[dict[str, Any]], Mapping[str, Any]] | None = None,
    ) -> None:
        self._definition = definition
        self._prose = prose
        self._resources = resources
        self._docx = docx
        self._sidecars = sidecars
        self._archive = archive
        self._pdf_text = pdf_text
        self._locale = conversion_locale
        self._snapshot = snapshot
        self._compiled = compiled
        self._verified_definition = verified_definition

        self.pipeline: Pipeline
        self.events: list[dict[str, Any]] = []
        self.error: Exception | None = None

        self.mutated_docx: bytes = b""
        """The `.docx` the run actually verified, mutation included.

        Held because a failing run uploads nothing, so the document the assertions need to
        read back is not in the object store — and reconstructing it by re-applying the
        mutation would be asserting against a second copy rather than the one under test.
        """

    # --- the two runs -----------------------------------------------------------

    def _pipeline(self) -> Pipeline:
        kwargs: dict[str, Any] = {}
        if self._prose is not None:
            kwargs["prose"] = self._prose
        if self._resources is not None:
            kwargs["resources"] = list(self._resources)
        pipeline = Pipeline(**kwargs)
        if self._definition is not None:
            pipeline.definition = dict(self._definition)
        return pipeline

    def baseline(self) -> Mapping[str, Any]:
        """Req 44.13 — the same fixture, unmutated, asserted passing with zero blocking
        findings before anything is broken."""
        pipeline = self._pipeline()
        pipeline.run()
        result = pipeline.outcome.verification
        assert result is not None, "the unmutated fixture produced no verification at all"
        assert result["status"] == "pass", (
            f"the unmutated fixture does not pass, so nothing this test observes afterwards "
            f"is attributable to its mutation: {result['findings']}"
        )
        assert blocking_types(result) == set(), result["findings"]
        return result

    def run(self) -> Mapping[str, Any] | None:
        """Drive the mutated run and return its verification result, if one was reached."""
        self.pipeline = self._pipeline()
        with self._mutations():
            self.events, self.error = self.pipeline.run()
        return self.pipeline.outcome.verification

    @property
    def code(self) -> str | None:
        """The terminal `error_code` the run reported, or `None` if it did not fail."""
        return self.error.code.value if isinstance(self.error, AgentError) else None

    # --- the seams ---------------------------------------------------------------

    @contextmanager
    def _mutations(self):
        """Patch the production path at the point each artifact is produced.

        Module attributes rather than injected arguments, because `_document_phases` resolves
        every one of these with a function-local import — which is what makes patching the
        module reach the real call site instead of a copy bound at import time.
        """
        import reporting_agent.render.docx as docx_module
        import reporting_agent.render.pdf as pdf_module
        import reporting_agent.report_pipeline as pipeline_module

        with ExitStack() as stack:
            # Wrapped unconditionally. `mutated_docx` is read by assertions that run on the
            # unmutated path too, and a failing run uploads nothing — so this wrapper is the
            # only place the document actually verified can be captured from.
            #
            # **Only the first render is mutated, and that is load-bearing.** Req 28.7 derives
            # the static-text allowlist by rendering the same pinned version with a null
            # context, so a run reaches this function twice: once for the document that gets
            # verified, and once for a document with no resources in it. Mutating the second
            # corrupts the allowlist rather than the report — which fails the verification
            # for a reason the test did not choose, and would have made every prose scenario
            # in this suite green for the wrong one.
            real_render = docx_module.render_document
            rendered = 0

            def render(*args: Any, **kwargs: Any):
                nonlocal rendered
                outcome = real_render(*args, **kwargs)
                rendered += 1
                if rendered > 1:
                    return outcome
                if self._docx is not None:
                    outcome.docx_bytes = self._docx(outcome.docx_bytes)
                if self._sidecars is not None:
                    outcome.chart_sidecars = self._sidecars(dict(outcome.chart_sidecars))
                self.mutated_docx = outcome.docx_bytes
                return outcome

            stack.enter_context(mock.patch.object(docx_module, "render_document", render))

            if self._compiled is not None:
                # Runs **after** `compile_document`'s own closing invariant, so a hook here
                # constructs the one state that invariant exists to prevent: a ledger entry
                # with nothing in the document behind it. That is Req 44.10's condition, and
                # it cannot be reached by editing the rendered `.docx` — Req 29.8 has
                # completeness stand down on any entry the anchored pass already faulted, so
                # deleting a rendered cell produces a `table_cell_mismatch` instead.
                import reporting_agent.compile.blocks as blocks_module

                real_compile = blocks_module.compile_document
                compiles = 0

                def compile_document(*args: Any, **kwargs: Any):
                    nonlocal compiles
                    outcome = real_compile(*args, **kwargs)
                    compiles += 1
                    # First call only, for the reason the render wrapper above gives: the
                    # allowlist derivation compiles the same version a second time against a
                    # null context, and a hook reaching that one breaks the allowlist rather
                    # than the report.
                    if compiles == 1:
                        self._compiled(outcome, kwargs.get("view"))
                    return outcome

                stack.enter_context(
                    mock.patch.object(
                        blocks_module, "compile_document", compile_document
                    )
                )

            if self._snapshot is not None:
                # The snapshot is an **input** to the document phases, so it is replaced on
                # the way in rather than edited on the way out. Three of the sixteen blocking
                # types — `scope_unverified`, `empty_scope`, `coverage_resource_absent` — are
                # claims about the snapshot itself, and the collection gates in front of them
                # exist precisely to stop a real run producing one. Constructing the snapshot
                # here reaches the verification gate without disabling the collection gate,
                # which is what keeps the two distinguishable.
                import dataclasses

                real_phases = pipeline_module._document_phases

                def phases(*args: Any, **kwargs: Any):
                    collected = kwargs["collected"]
                    kwargs["collected"] = dataclasses.replace(
                        collected, document=self._snapshot(dict(collected.document))
                    )
                    return real_phases(*args, **kwargs)

                stack.enter_context(
                    mock.patch.object(pipeline_module, "_document_phases", phases)
                )

            if self._verified_definition is not None:
                # Substitutes the pinned version the **verification** reads, leaving the one
                # the compile and the render used alone. That is the re-verification shape:
                # `run_verify_report` loads the stored version fresh, so a version that has
                # drifted from the one the document was built against reaches the gates
                # exactly here — and Req 32.2's fail-closed branch is the only route to
                # `coverage_resource_absent` that a run can take. See the test for why.
                real_verify = pipeline_module._verify

                async def verify_with(*args: Any, **kwargs: Any):
                    kwargs["definition"] = self._verified_definition(
                        dict(kwargs["definition"])
                    )
                    return await real_verify(*args, **kwargs)

                stack.enter_context(
                    mock.patch.object(pipeline_module, "_verify", verify_with)
                )

            if self._archive is not None:
                real_fetch = pipeline_module._fetch_archive

                async def fetch(*args: Any, **kwargs: Any):
                    return self._archive(await real_fetch(*args, **kwargs))

                stack.enter_context(
                    mock.patch.object(pipeline_module, "_fetch_archive", fetch)
                )

            if self._pdf_text is not None:
                real_text = pipeline_module._pdf_text

                def text(payload: bytes):
                    extracted, pages = real_text(payload)
                    return self._pdf_text(extracted), pages

                stack.enter_context(
                    mock.patch.object(pipeline_module, "_pdf_text", text)
                )

            if self._locale is not None:
                # Req 44.7's "bypassing the guard that would refuse it". The guard is the
                # thing under test: the point of the scenario is that a run which gets past
                # it produces a document the *fidelity* gate must catch, so the run has to
                # get past it.
                stack.enter_context(
                    mock.patch.object(pdf_module, "assert_lang_in_effect", lambda: None)
                )
                stack.enter_context(
                    mock.patch.dict(os.environ, {"LANG": self._locale, "LC_ALL": self._locale})
                )

            yield


# --------------------------------------------------------------------------- #
# Document surgery
# --------------------------------------------------------------------------- #
#
# Every helper below reads and rewrites the `.docx` the renderer produced. None of them
# construct a document, because a document a test wrote is a document the renderer's own
# conventions — the `w:tblCaption` identity, the key column's ordinal, the header row — were
# never applied to, and a verifier can be made to fail one of those trivially.


def captioned_tables(document: Any) -> list[Any]:
    """Every data table, in document order. Chrome tables carry no caption identity."""
    from reporting_agent.verify.tokens import table_caption

    return [
        table
        for table in document.element.body.iter(qn("w:tbl"))
        if table_caption(table) is not None
    ]


def cell_text(cell: Any) -> str:
    return "".join(node.text or "" for node in cell.iter(qn("w:t")))


def set_cell_text(cell: Any, text: str) -> None:
    """Write `text` into a cell's first run and blank the rest.

    A cell's text is routinely split across several `w:t` runs by rsids and spell-check state,
    which is the same reason Req 26.6 tokenizes the concatenated paragraph rather than each
    run — so a helper that wrote only the first run would leave the tail behind.
    """
    nodes = list(cell.iter(qn("w:t")))
    if not nodes:
        return
    nodes[0].text = text
    for node in nodes[1:]:
        node.text = ""


def flip_one_digit(text: str) -> str:
    """Replace exactly one digit character with a different digit (Req 44.2).

    The first digit, changed by one, wrapping `9` to `8` so the result is never a leading
    zero — `04.20%` and `4.20%` differ as strings but a reader would call that a formatting
    change, and the requirement asks for the smallest possible *corruption*.
    """
    for index, character in enumerate(text):
        if character.isdigit():
            replacement = "8" if character == "9" else str(int(character) + 1)
            return text[:index] + replacement + text[index + 1 :]
    raise AssertionError(f"{text!r} carries no digit to change")


def rewrite_cell(
    payload: bytes, *, row: int = 1, column: int = -1, using: Callable[[str], str]
) -> bytes:
    """Rewrite one cell of the first data table through `using`."""
    document = open_docx(io.BytesIO(payload))
    tables = captioned_tables(document)
    assert tables, "the rendered document carries no captioned data table"
    rows = tables[0].findall(qn("w:tr"))
    cells = rows[row].findall(qn("w:tc"))
    target = cells[column]
    set_cell_text(target, using(cell_text(target)))
    return _save(document)


def swap_columns(payload: bytes, *, left: int, right: int, table: int = 0) -> bytes:
    """Swap two columns' cell text across every **data** row (Req 44.3).

    The header row is left alone deliberately: swapping it too would relabel the columns and
    the document would once again be telling the truth, which is a different scenario. What
    this produces is the one that matters — every heading correct, every value under the
    wrong one.
    """
    document = open_docx(io.BytesIO(payload))
    tables = captioned_tables(document)
    assert len(tables) > table, "the rendered document has no such captioned data table"
    for row in tables[table].findall(qn("w:tr"))[1:]:
        cells = row.findall(qn("w:tc"))
        if len(cells) <= max(left, right):
            continue
        held = cell_text(cells[left])
        set_cell_text(cells[left], cell_text(cells[right]))
        set_cell_text(cells[right], held)
    return _save(document)


def drop_data_rows(payload: bytes, *, table: int = 0) -> bytes:
    """Remove every data row of one captioned table, keeping its caption and header.

    Req 44.4's mutation: the table still declares its identity, so the anchors still resolve
    to it, and it carries neither data nor the explicit no-resources-matched row that a
    legitimately empty scope would have produced.
    """
    document = open_docx(io.BytesIO(payload))
    tables = captioned_tables(document)
    assert len(tables) > table
    for row in tables[table].findall(qn("w:tr"))[1:]:
        row.getparent().remove(row)
    return _save(document)


def drop_table(payload: bytes, *, table: int = 0) -> bytes:
    """Remove one captioned data table outright."""
    document = open_docx(io.BytesIO(payload))
    tables = captioned_tables(document)
    assert len(tables) > table
    element = tables[table]
    element.getparent().remove(element)
    return _save(document)


def clone_table(payload: bytes, *, table: int = 0) -> bytes:
    """Duplicate one captioned table, so two tables share one caption identity."""
    import copy

    document = open_docx(io.BytesIO(payload))
    tables = captioned_tables(document)
    assert len(tables) > table
    element = tables[table]
    element.addnext(copy.deepcopy(element))
    return _save(document)


def append_paragraph(payload: bytes, text: str) -> bytes:
    document = open_docx(io.BytesIO(payload))
    document.add_paragraph(text)
    return _save(document)


def _save(document: Any) -> bytes:
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()
