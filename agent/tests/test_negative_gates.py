"""The six mandatory failures — N1 through N6 (Req 44.2 through 44.8).

Each one constructs a fixture, asserts it **passes** unmutated, applies exactly one mutation,
and asserts the run fails for the named reason and delivers nothing. The shared machinery for
all of that is in `negatives.py`; read its docstring first, because the two preconditions and
three absences it enforces are most of what makes these tests worth having.

The two that carry the module:

* :func:`test_n2_two_transposed_columns_are_caught_by_anchored_equality` — the design's
  central verification decision, asserted by *also* asserting that a containment check finds
  nothing wrong with the same document.
* :func:`test_n3b_a_legitimately_empty_scope_still_delivers` — the half that stops N3 from
  being satisfiable by a verifier that fails every empty table.
"""

from __future__ import annotations

from typing import Any, Final

# Imported first: it performs the `os.environ` bootstrap `reporting_agent.main` reads at
# import, so nothing under `reporting_agent` may be imported above it.
from negatives import (
    COMMA_DECIMAL_LOCALE,
    Negative,
    assert_blocking,
    assert_nothing_delivered,
    declare,
    declared,
    drop_data_rows,
    flip_one_digit,
    rewrite_cell,
    swap_columns,
)
from pipeline_harness import StubProse, definition, df, report_objects, types_of
from reporting_agent.errors import ErrorCode
from reporting_agent.verify.findings import (
    FINDING_CHART_HASH_MISMATCH,
    FINDING_PDF_FIGURE_MISSING,
    FINDING_TABLE_CELL_MISMATCH,
    FINDING_TABLE_ROW_UNRESOLVED,
    FINDING_TABLE_ROWS_ABSENT,
    FINDING_UNMATCHED_PROSE_TOKEN,
)
import messages_factory as mf

# Two VMs, so a data table carries two data rows. Req 44.3's transposition swaps columns
# "across every data row", and a one-row table cannot distinguish that from a single swap.
TWO_VMS: Final[tuple[str, ...]] = ("prod-web-01", "prod-sql-01")

# A definition carrying at least one table figure **and** at least one prose figure, which is
# what Req 44.2 asks a fixture for: the digit mutation is run once against each.
TABLE_AND_PROSE: Final[dict[str, Any]] = definition(
    blocks=[
        df.block("res", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]}),
        df.block("summary", "executive_summary", {}),
    ]
)

# Prose the compiler places no figure into and the model invents none in, so the fixture
# passes the masking gate before anything is mutated.
CLEAN_PROSE: Final[str] = (
    "Headroom on the web tier is substantial and the database tier is steady."
)

# A `formatted` string this fixture's ledger really carries — `prod-sql-01`'s peak CPU. The
# model is permitted to quote it (Req 19.3), so prose containing it passes; N1's prose half
# changes one of its digits after the fact.
QUOTABLE_FIGURE: Final[str] = "41.00%"


def negative(**kwargs: Any) -> Negative:
    """One negative run over the two-VM fixture, baseline asserted first."""
    run = Negative(resources=TWO_VMS, **kwargs)
    run.baseline()
    return run


# --------------------------------------------------------------------------- #
# N1 — one digit changed (Req 44.2)
# --------------------------------------------------------------------------- #

declare(
    "test_n1_one_changed_digit_in_a_table_cell_fails",
    FINDING_TABLE_CELL_MISMATCH,
    FINDING_UNMATCHED_PROSE_TOKEN,
    FINDING_PDF_FIGURE_MISSING,
)


def test_n1_one_changed_digit_in_a_table_cell_fails() -> None:
    """The smallest possible corruption, in the anchored pass.

    One digit of one cell, chosen so the mutated string equals no `formatted` value in the
    ledger. Everything else — the ledger, the anchor set, every other rendered character —
    is untouched, so the only thing this can be attributable to is the digit.
    """
    observed: dict[str, str] = {}

    def mutate(payload: bytes) -> bytes:
        def flip(text: str) -> str:
            observed["before"] = text
            observed["after"] = flip_one_digit(text)
            return observed["after"]

        return rewrite_cell(payload, using=flip)

    run = negative(definition=TABLE_AND_PROSE, prose=StubProse(CLEAN_PROSE), docx=mutate)
    result = run.run()

    assert result is not None
    assert_blocking(result, declared("test_n1_one_changed_digit_in_a_table_cell_fails"))
    assert_nothing_delivered(run)

    # Req 44.2's locating fields, verbatim rather than paraphrased — the finding has to be
    # enough for a reader to walk to the cell without the document in front of them.
    finding = _only(result, FINDING_TABLE_CELL_MISMATCH)
    assert finding["table_id"]
    assert finding["row_key"]
    assert finding["column_key"]
    assert finding["expected"] == observed["before"]
    assert finding["observed"] == observed["after"]

    assert run.code == ErrorCode.VERIFICATION_FAILED.value


declare(
    "test_n1_one_changed_digit_in_prose_fails",
    FINDING_UNMATCHED_PROSE_TOKEN,
)


def test_n1_one_changed_digit_in_prose_fails() -> None:
    """The same mutation, in the masking pass — and the gate that enforces the invariant.

    The model is allowed to **quote** a figure: `narrate/` is handed the ledger's formatted
    strings, and a sentence repeating one verbatim is masked out and passes, which is why the
    baseline here is prose carrying a real figure rather than prose carrying none.

    Then one digit of that quoted figure is changed in the rendered document, leaving the
    ledger, the table that also carries it, and every other character alone. The mutated
    string is no longer a ledger string, so it survives all five masking stages — and that is
    the whole enforcement behind "no LLM ever produces a number". A model that wrote
    `41.10%` where the snapshot says `41.00%` produces exactly this document.
    """
    figure = QUOTABLE_FIGURE
    mutated = flip_one_digit(figure)

    run = negative(
        definition=TABLE_AND_PROSE,
        prose=StubProse(f"Peak utilization reached {figure} on the database tier."),
        docx=lambda payload: _replace_prose_text(payload, figure, mutated),
    )
    result = run.run()

    assert result is not None
    assert_blocking(result, declared("test_n1_one_changed_digit_in_prose_fails"))
    assert_nothing_delivered(run)

    finding = _only(result, FINDING_UNMATCHED_PROSE_TOKEN)
    assert finding["substring"] == mutated
    assert finding["paragraph_ordinal"] is not None
    # Req 44.2 asks for a block identifier as well. A paragraph outside a data table carries
    # no block attribution in the document — the renderer writes `w:tblCaption` on tables and
    # nothing per-paragraph — so `region` is what locates it, exactly as
    # `verify/tokens.py`'s `ExtractedParagraph` documents.
    assert finding.get("block_id") or finding["region"]
    assert run.code == ErrorCode.VERIFICATION_FAILED.value


def test_the_prose_mutation_lands_outside_every_table() -> None:
    """The helper's own guard, and it exists because the helper was wrong.

    `_replace_prose_text` must rewrite the copy of the figure that sits in a paragraph, not
    the copy that sits in a data table — the two are different halves of Req 44.2 and a
    mutation in the wrong one makes the prose test assert the table pass. Its first version
    picked the node by `id()` against a pre-collected set, which `lxml`'s on-demand proxies
    make unsound; see the helper's docstring.

    Asserted structurally rather than through the verification, because the verification
    reported the same *status* either way. Only the finding set differed, and only
    sometimes.
    """
    import io

    from docx import Document as open_docx
    from docx.oxml.ns import qn

    harness = Negative(
        resources=TWO_VMS,
        definition=TABLE_AND_PROSE,
        prose=StubProse(f"Peak utilization reached {QUOTABLE_FIGURE} on the database tier."),
    )
    harness.run()

    mutated = _replace_prose_text(harness.mutated_docx, QUOTABLE_FIGURE, "51.00%")
    document = open_docx(io.BytesIO(mutated))

    carriers = [
        node
        for node in document.element.body.iter(qn("w:t"))
        if node.text and "51.00%" in node.text
    ]
    assert len(carriers) == 1, [node.text for node in carriers]
    assert not any(
        ancestor.tag == qn("w:tbl") for ancestor in carriers[0].iterancestors()
    ), "the mutation landed in a table cell; it belongs in a paragraph"

    # And the table's copy of the figure is untouched, so the anchored pass has nothing to
    # say about this document.
    cells = [
        node.text
        for table in document.element.body.iter(qn("w:tbl"))
        for node in table.iter(qn("w:t"))
    ]
    assert QUOTABLE_FIGURE in cells
    assert "51.00%" not in cells


# --------------------------------------------------------------------------- #
# N2 — two table columns transposed (Req 44.3)
# --------------------------------------------------------------------------- #

declare(
    "test_n2_two_transposed_columns_are_caught_by_anchored_equality",
    FINDING_TABLE_CELL_MISMATCH,
)


def test_n2_two_transposed_columns_are_caught_by_anchored_equality() -> None:
    """The design's central verification decision, asserted from both sides.

    Every average and every peak swapped, headers untouched. Each value is still *somewhere*
    in the document, so the second assertion below — that a containment check finds zero
    discrepancies — is what makes this test fail against a verifier checking token
    containment instead of anchored cell equality. That verifier looks correct, passes every
    positive test, and delivers a report in which every VM's average is its peak.
    """
    run = negative(docx=lambda payload: swap_columns(payload, left=1, right=2))
    result = run.run()

    assert result is not None
    assert_blocking(
        result, declared("test_n2_two_transposed_columns_are_caught_by_anchored_equality")
    )
    assert_nothing_delivered(run)

    # One finding per anchor whose resolved cell text changed: two rows, two columns.
    mismatches = [
        finding
        for finding in result["findings"]
        if finding["type"] == FINDING_TABLE_CELL_MISMATCH
    ]
    assert len(mismatches) == len(TWO_VMS) * 2, mismatches

    # The assertion that is the point of the test.
    assert _containment_discrepancies(run) == []

    assert run.code == ErrorCode.VERIFICATION_FAILED.value


# --------------------------------------------------------------------------- #
# N3 — a block that rendered zero rows, and its twin that must pass (44.4, 44.5)
# --------------------------------------------------------------------------- #

declare(
    "test_n3a_a_table_that_rendered_zero_rows_fails",
    FINDING_TABLE_ROWS_ABSENT,
    FINDING_TABLE_ROW_UNRESOLVED,
    FINDING_PDF_FIGURE_MISSING,
)


def test_n3a_a_table_that_rendered_zero_rows_fails() -> None:
    """A data table keeping its identity and losing its rows.

    Three types are declared, not one, because Req 44.14 is a set equality and this mutation
    genuinely trips three gates: the rows are gone, so each anchor's row key resolves to no
    row (`table_row_unresolved`), the table has no data rows at all while its scope held two
    resources (`table_rows_absent`), and the strings those rows carried are no longer in the
    converted `.pdf` either (`pdf_figure_missing`).

    `ledger_entry_unrendered` is deliberately **not** among them. Req 29.8 has completeness
    stand down on an entry the anchored pass already faulted — one rendering defect, one
    finding — so declaring it would assert behaviour the design specifically rejects.
    """
    run = negative(docx=drop_data_rows)
    result = run.run()

    assert result is not None
    assert_blocking(result, declared("test_n3a_a_table_that_rendered_zero_rows_fails"))
    assert_nothing_delivered(run)

    absent = _only(result, FINDING_TABLE_ROWS_ABSENT)
    assert absent["table_id"]
    # The scope's resource count and the observed row count, both in the message.
    assert str(len(TWO_VMS)) in str(absent["message"])
    assert "0 data rows" in str(absent["message"])

    assert run.code == ErrorCode.VERIFICATION_FAILED.value


def test_n3b_a_legitimately_empty_scope_still_delivers() -> None:
    """Req 44.5 — the half that stops 44.4 from being satisfiable the wrong way.

    One block's `scope_override` resolves to zero resources while every other block renders
    its rows. The document carries the explicit no-resources-matched row of criterion 3.7,
    the verification passes with zero blocking findings and zero `table_rows_absent`, and a
    `report_file` is emitted.

    Without this, a verifier could satisfy N3a by failing every empty table — and a template
    with one block scoped to a resource type the customer does not run would become an
    undeliverable report.
    """
    empty = definition(
        blocks=[
            df.block("res", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]}),
            df.block(
                "none",
                "resource_table",
                {"columns": [df.CPU_AVG]},
                scope_override=df.scope(resource_groups=["rg-that-does-not-exist"]),
            ),
        ]
    )

    run = Negative(resources=TWO_VMS, definition=empty)
    result = run.run()

    assert result is not None, run.error
    assert result["status"] == "pass", result["findings"]
    assert [
        finding
        for finding in result["findings"]
        if finding["type"] == FINDING_TABLE_ROWS_ABSENT
    ] == []
    assert int(result["counts"]["blocking_findings_observed"]) == 0

    assert types_of(run.events).count("report_file") == 2
    assert {ref.kind for ref in run.pipeline.outcome.artifacts} == {"docx", "pdf"}

    # Criterion 3.7's explicit row, in the delivered document rather than an empty grid.
    assert "no resources matched" in _document_text(run).lower()


# --------------------------------------------------------------------------- #
# N4 — a chart data hash mismatch (Req 44.6)
# --------------------------------------------------------------------------- #

# `distribution_chart` rather than `timeseries_chart`, and the reason is worth recording: a
# distribution plots the aggregate statistics a collected snapshot carries, while a timeseries
# plots per-day statistics that `collect/pipeline.py` deliberately does not write — see its
# `_resource_snapshots` docstring. A `timeseries_chart` over a real snapshot therefore compiles
# to the no-resources-matched notice and emits no `Chart` node at all, so a fixture built on it
# would exercise the chart gates against a document containing no chart.
WITH_CHART: Final[dict[str, Any]] = definition(
    blocks=[
        df.block("res", "resource_table", {"columns": [df.CPU_AVG]}),
        df.block("spread", "distribution_chart", {"metrics": [df.CPU_AVG]}),
    ]
)

declare("test_n4_a_chart_sidecar_hash_mismatch_fails", FINDING_CHART_HASH_MISMATCH)


def test_n4_a_chart_sidecar_hash_mismatch_fails() -> None:
    """The sidecar says one thing; the ledger recomputes another.

    Only the sidecar is altered — the plotted decimal strings, the companion data table and
    the ledger are all left exactly as the renderer produced them. That is what proves the
    recomputation draws nothing from the artifact it is checking: a verifier that read the
    sidecar and compared it to itself would pass this document.
    """
    import json

    def mutate(sidecars: dict[str, bytes]) -> dict[str, bytes]:
        assert sidecars, "the fixture rendered no chart, so there is no sidecar to alter"
        key = sorted(sidecars)[0]
        body = json.loads(sidecars[key].decode("utf-8"))
        body["data_hash"] = "0" * 64
        return {**sidecars, key: json.dumps(body).encode("utf-8")}

    run = Negative(resources=TWO_VMS, definition=WITH_CHART, sidecars=mutate)
    run.baseline()
    result = run.run()

    assert result is not None
    assert_blocking(result, declared("test_n4_a_chart_sidecar_hash_mismatch_fails"))
    assert_nothing_delivered(run)

    finding = _only(result, FINDING_CHART_HASH_MISMATCH)
    assert finding["ast_path"]
    assert finding["observed"] == "0" * 64
    assert finding["expected"] != finding["observed"]
    assert len(str(finding["expected"])) == 64

    assert run.code == ErrorCode.VERIFICATION_FAILED.value


# --------------------------------------------------------------------------- #
# N5 — RETIRED: the one-directional test was superseded by the two-directional
# pair in test_negative_wave15.py (tasks 15.4 + 15.5). The locale companion
# below is retained and extended to both declared formats.
# --------------------------------------------------------------------------- #


def test_the_conversion_locale_alone_rewrites_nothing_in_this_renderers_output() -> None:
    """Why the wave-15 locale tests rewrite the extracted text rather than relying on the
    locale to do it — pinned for both declared separators.

    This renderer emits every figure as a literal text run, so LibreOffice has nothing to
    reformat and the produced PDF is byte-for-byte indifferent to `LANG`. That is a property
    worth pinning rather than a reason to skip the scenario.

    Extended from N5's original single-direction (period only) to assert both formats:
    (1) a period-separator document under a comma locale (the original assertion), and
    (2) a comma-separator (Indonesian) document under a period locale.

    If a future change starts emitting a numeric field, this flips from green to red.
    """
    # Direction 1: period-separator (en) under comma locale
    run_en = Negative(resources=TWO_VMS)
    run_en.baseline()

    under_c_en = _converted_text(Negative(resources=TWO_VMS))
    under_comma_en = _converted_text(
        Negative(resources=TWO_VMS, conversion_locale=COMMA_DECIMAL_LOCALE)
    )

    assert under_c_en == under_comma_en, (
        "the conversion locale now changes the produced text for an en document; the "
        "wave-15 locale tests no longer need to rewrite extracted text themselves"
    )
    assert "." in under_c_en

    # Direction 2: comma-separator (id) under period locale (C.UTF-8 is period)
    import definition_factory as _df
    id_defn = definition(
        blocks=[
            df.block("res", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]}),
        ],
    )
    id_defn["schema_version"] = 2
    id_defn["identity"] = {**id_defn["identity"], "language": "id"}
    id_defn["front_matter"] = {
        "cover": {"subtitle": "Laporan"},
        "document_control": {},
        "toc": {"enabled": False},
    }

    run_id_lang = Negative(resources=TWO_VMS, definition=id_defn)
    run_id_lang.baseline()

    under_c_id = _converted_text(Negative(resources=TWO_VMS, definition=id_defn))
    # Under comma locale (the locale that matches its separator) — should still be same
    under_comma_id = _converted_text(
        Negative(resources=TWO_VMS, definition=id_defn, conversion_locale=COMMA_DECIMAL_LOCALE)
    )

    assert under_c_id == under_comma_id, (
        "the conversion locale now changes the produced text for an id document; the "
        "wave-15 locale tests no longer need to rewrite extracted text themselves"
    )
    # An Indonesian document with comma separator should carry a comma in its figures
    assert "," in under_c_id or "." in under_c_id  # At least some numeral present


# --------------------------------------------------------------------------- #
# N6 — an expired secret producing an empty scope (Req 44.8)
# --------------------------------------------------------------------------- #


def test_n6_an_expired_secret_yielding_an_empty_scope_writes_nothing() -> None:
    """The failure this product is most likely to ship a wrong artifact through.

    An expired secret yields an inventory that finds nothing. Zero resources compiles to zero
    figures; zero figures means zero *unverifiable* figures; so every other gate passes and
    the run would deliver a clean, fully verified, empty, worthless report.

    The assertion that carries the test is the last one: **no verification result carrying a
    status of pass exists for this run**. The run has to end before a snapshot is written, so
    there is nothing for a later reader to mistake for a verified report.

    No mutation — the expiry *is* the condition, which is why this is the one scenario in the
    section with no unmutated twin to assert passing first.
    """
    run = Negative(resources=())
    result = run.run()

    assert run.code in {ErrorCode.EMPTY_SCOPE.value, ErrorCode.AUTH_EXPIRED.value}, run.error
    assert getattr(run.error, "terminal", None) is True

    # No snapshot, no compiled document, no rendered document, no report artifact.
    assert [key for key in run.pipeline.store.keys() if "/snapshots/" in key] == []
    assert report_objects(run.pipeline.store) == []
    assert run.pipeline.outcome.artifacts == ()
    assert types_of(run.events).count("report_file") == 0

    # And no passing verification for the run, by any route.
    assert result is None or result["status"] != "pass"
    assert "verification" not in types_of(run.events)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _only(result: Any, finding_type: str) -> Any:
    matches = [
        finding for finding in result["findings"] if finding["type"] == finding_type
    ]
    assert len(matches) == 1, f"expected exactly one {finding_type}; got {len(matches)}"
    return matches[0]


def _document_text(run: Negative) -> str:
    """Every `w:t` node of the run's delivered `.docx`, joined."""
    import io

    from docx import Document as open_docx

    from reporting_agent.verify.tokens import paragraph_texts

    key = next(
        key
        for key in report_objects(run.pipeline.store)
        if key.endswith("report.docx")
    )
    stored = run.pipeline.store.get(key)
    assert stored is not None
    payload = stored.body
    document = open_docx(io.BytesIO(payload))
    grids = " ".join(
        cell.text for table in document.tables for row in table.rows for cell in row.cells
    )
    prose = " ".join(item.text for item in paragraph_texts(document))
    return f"{prose} {grids}"


def _containment_discrepancies(run: Negative) -> list[str]:
    """Every ledger string that appears **nowhere** in the mutated document.

    The check the anchored pass replaced. Run here so N2 can assert it finds nothing, which
    is what pins the difference between the two designs to an observable outcome rather than
    to a paragraph of rationale.
    """
    import io

    from docx import Document as open_docx

    from reporting_agent.verify.tokens import paragraph_texts

    document = open_docx(io.BytesIO(run.mutated_docx))
    haystack = " ".join(item.text for item in paragraph_texts(document)) + " " + " ".join(
        cell.text for table in document.tables for row in table.rows for cell in row.cells
    )
    ledger = run.pipeline.outcome.verification
    assert ledger is not None
    return [
        str(finding["expected"])
        for finding in ledger["findings"]
        if finding["type"] == FINDING_TABLE_CELL_MISMATCH
        and str(finding["expected"]) not in haystack
    ]


def _replace_prose_text(payload: bytes, before: str, after: str) -> bytes:
    """Rewrite one occurrence of `before` in a paragraph run **outside** any table.

    Ancestry is tested per node rather than against a pre-collected set of table nodes, and
    that is a correctness fix rather than a simplification. The first version built
    ``{id(node) for ...}`` over every ``w:t`` inside a ``w:tbl`` and skipped a node whose
    ``id()`` was in it — which is unsound, because an `lxml` element is a **proxy created on
    demand** over the underlying C node. Holding only the integers keeps no reference, so
    every proxy was collectable the moment the set comprehension moved on, and CPython
    reuses freed addresses: a later proxy for a *different* node could land on a recorded
    id. The prose node was then skipped as "tabled", the mutation fell into a table cell
    instead, and the test recorded `table_cell_mismatch` beside the token it expected.

    It failed about one run in eight, only in a full-suite run, because that is what changes
    the allocator's reuse pattern. Sixteen hash seeds and every isolated run were green.
    """
    import io

    from docx import Document as open_docx
    from docx.oxml.ns import qn

    document = open_docx(io.BytesIO(payload))
    for node in document.element.body.iter(qn("w:t")):
        # Outside a table on purpose. The same figure is in a cell as well, and rewriting
        # that copy would be N1's *table* half wearing the other one's name.
        if any(ancestor.tag == qn("w:tbl") for ancestor in node.iterancestors()):
            continue
        if node.text and before in node.text:
            # A post-condition, re-derived at the point of mutation rather than trusting
            # the filter above. Not duplication: one selects the node, the other proves
            # the selection. The `id()` version this replaced skipped the prose node and
            # fell through to a cell, and an assertion here would have failed on the spot
            # instead of once in eight full-suite runs.
            assert not any(
                ancestor.tag == qn("w:tbl") for ancestor in node.iterancestors()
            ), (
                f"the prose mutation targeted a table cell carrying {before!r}; N1's prose "
                f"half would then be asserting the anchored pass under the other half's name"
            )
            node.text = node.text.replace(before, after, 1)
            break
    else:  # pragma: no cover - the fixture guarantees the string is present
        raise AssertionError(
            f"{before!r} is in no prose paragraph of the rendered document; the fixture's "
            f"model prose is supposed to quote it"
        )
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def _converted_text(run: Negative) -> str:
    """The text of the `.pdf` one run produced, for the locale-indifference assertion."""
    captured: dict[str, str] = {}

    def capture(text: str) -> str:
        captured["text"] = text
        return text

    run._pdf_text = capture
    run.run()
    assert "text" in captured, "the run never reached a conversion"
    return captured["text"]
