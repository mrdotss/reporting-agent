"""The static-text allowlist, derived afresh on every verification run.

**Derived, never maintained** (Req 28.11). Stage 5 of the masking pass has to let the
document's own chrome through — a heading reading `Top 10 by average CPU`, a
methodology paragraph naming the grain, an axis label, a cover page's period. Every
one of those carries a digit and none of them is a measurement. A hand-maintained list
of those strings would be wrong the first time a template version added a heading, and
the failure would be a spurious blocking finding on a correct document, which is the
expensive direction to be wrong in.

So the allowlist is *computed*: compile the **pinned** template version against a
**null context** — the run's own snapshot with its resources and gaps emptied, and no
prose provider — then render it and take every numeric-bearing string in the output.
With no resources there is no data for a block to draw on, so no `Figure` is
constructed and nothing in the result is a measurement; every numeric that survives is
by definition chrome. Chrome added in a later template version is allowed without an
edit to the verifier, and chrome removed stops being allowed on the same run.

**Why the run's own snapshot rather than a fabricated one.** Emptying `resources` and
`gaps` keeps the window, the timezone, the grain and the subscription real, so period
and grain chrome renders exactly as it does in the document under verification. A
hand-built minimal snapshot would be a second definition of the snapshot shape, free
to drift from the real one — and the day it drifted, the allowlist would be derived
from a document that renders differently from the one being checked.

## The assumption this rests on, stated so it can be violated deliberately

**A block's chrome *shape* is independent of whether data exists.** The null-context render
is only a source of truth about chrome if a block emits the same headings, captions, column
headers and prose whether it has two hundred resources or none — differing only in the
figures, which are absent here by construction. That holds for `cover`, `heading`,
`rich_text`, every table's headers, the period and grain sentences, and the explicit
"No resources matched this scope" row.

**`appendix_methodology` is the one deliberate exception, and it is handled.** It emits a
methodology sentence only for a method the *real* ledger actually used (Req 16.6), so its
paragraphs genuinely do depend on what was measured. A resource-free render therefore emits
none of them, and `0-100` — static prose from the declared sketch vocabulary, carrying no
`snapshot_path` and belonging to no figure — never reached the allowlist. Every report whose
data produced an estimated percentile was withheld with a spurious `unmatched_prose_token`.
:func:`declared_method_phrases` closes that by enumerating the phrase vocabulary from the
constants and unioning it in unconditionally, rather than by making the render data-aware.

**A new block must not add a second exception.** `tests/test_verify_masking.py` asserts, per
block type, that the numeric chrome a real-data render emits is a subset of what the
null-context render emits plus that vocabulary — so a block whose chrome appears only when
data does fails the suite rather than a customer's report.

**A failed derivation fails the verification** (Req 28.11). If the null-context render
raises, this module raises :class:`VerificationFailedError` rather than returning an
empty allowlist. An empty allowlist is not a safe default in either direction: it
would make every chrome string a blocking survivor and fail a correct document, and a
caller that caught the error and skipped the prose pass entirely would pass a document
nothing checked. Neither is an outcome worth defaulting to, so there is no default.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

from reporting_agent.compile.snapshot_view import CARDINALITY_NAMESPACE, pointer
from reporting_agent.errors import VerificationFailedError

if TYPE_CHECKING:
    # Type-only, so `verify/` does not gain the *rest* of the compile stage on its import
    # graph. `snapshot_view` itself is plain data — no `python-docx`, no compiler, nothing
    # the replay-purity closure walk would flag — which is why `CARDINALITY_NAMESPACE` and
    # `pointer` above are real imports rather than joining this block. `derive_allowlist`
    # still imports the compiler and renderer lazily inside the function for that cost.
    from reporting_agent.compile.snapshot_view import SnapshotView

__all__ = [
    "declared_method_phrases",
    "derive_allowlist",
    "null_context_snapshot",
    "numeric_strings_in",
]

_DIGIT: Final[re.Pattern[str]] = re.compile(r"\d")

_CARDINALITY_PREFIX: Final[str] = pointer(CARDINALITY_NAMESPACE) + "/"
"""Every derived-cardinality figure's `snapshot_path` starts with this — `/$counts/` —
because :func:`reporting_agent.compile.snapshot_view._cardinality_value` mints every one
of them under `pointer(CARDINALITY_NAMESPACE, *tokens, CARDINALITY_TOKEN)`. Checked as a
prefix rather than a fixed set of tokens, so a cardinality added later (a new fidelity
tier, a new gap type) is recognized without an edit here."""


def null_context_snapshot(snapshot: Mapping[str, object]) -> dict[str, object]:
    """The run's snapshot with every resource, gap and archived-object count removed.

    A shallow copy with the keys that carry a measurement replaced: everything that
    describes *when* and *where* the collection happened is kept, and everything that
    counts something is dropped. The original is never mutated — it is the immutable,
    content-addressed artifact the whole product rests on, and a derivation that edited
    it in place would invalidate its own digest.

    `raw_archive.object_count` is cleared alongside `resources` and `gaps`, not left
    alone. Every other cardinality under `CARDINALITY_NAMESPACE` — `statistics`,
    `day_buckets`, `fidelity_tier/<tier>`, `gaps/by_type/<type>` — is *derived* from the
    resources and gaps this function already empties, so it collapses to zero for free.
    `raw_archive.object_count` does not: `compile/snapshot_view.py`'s `_raw_archive_count`
    reads it straight off the document, so leaving it alone would let a real, non-zero
    count of archived objects survive the null render and be admitted below as though it
    were chrome. `raw_archive.complete` is left untouched — it drives wording the document
    under verification also renders, and changing it here would derive the allowlist from
    a document that renders differently from the one being checked.
    """
    null = dict(snapshot)
    null["resources"] = []
    null["gaps"] = []
    raw_archive = snapshot.get("raw_archive")
    if isinstance(raw_archive, Mapping):
        null["raw_archive"] = {**raw_archive, "object_count": 0}
    return null


@dataclass(frozen=True, slots=True)
class _NullComparison:
    """A `ComparisonSource` answering every run id with the null-context view.

    Without one, a definition carrying a `comparison_delta` block could **never pass
    verification**. `compile/blocks/comparison.py` refuses when no comparison source is
    configured — correctly, because a delta that silently rendered one run's numbers would
    look like a delta of zero — so the null-context render below raised, `derive_allowlist`
    turned that into `VERIFICATION_FAILED`, and every report containing a comparison block
    was withheld permanently. The document rendered fine; only the gate rejected it, and the
    message blamed the allowlist rather than naming the block.

    Answering with the null view is the right null context rather than a workaround: every
    other block is compiled against a snapshot stripped of resources and gaps, and this gives
    the delta block the same treatment on both of its operands. It contributes the block's
    chrome — column headers, the not-comparable note, the snapshot anchor labels — and no
    figure, because a view with no resources resolves no value to subtract. The
    `figure_count` assertion below is what holds that to account.
    """

    view: SnapshotView

    def snapshot_for(self, run_id: str) -> SnapshotView:
        return self.view


def declared_method_phrases() -> tuple[str, ...]:
    """Every methodology phrase `appendix_methodology` can emit, for **any** run.

    The full declared vocabulary, enumerated from the constants rather than observed from a
    run: the percentile cross-product of
    :data:`~reporting_agent.compile.estimators.DECLARED_SKETCH_KINDS` x
    :data:`~reporting_agent.compile.estimators.DECLARED_GRAIN_PHRASES` x
    :data:`~reporting_agent.compile.estimators.FOLDED_STATISTIC_PHRASES`, plus every exact,
    compare and declared estimator's phrase. Twenty phrases today, contributing exactly two
    numeric tokens between them — `0-100` from the fixed histogram and `15-minute` from the
    grain a non-whole-hour timezone offset drops to.

    **Why enumerated rather than read from the run's ledger.** `appendix_methodology` emits a
    phrase only for a method the *real* ledger actually used (Req 16.6, and correct — the
    appendix describes this report, not the product's full repertoire). That makes it the one
    block whose chrome *shape* depends on whether data exists, so the null-context render
    cannot discover its phrases: with no resources there is no percentile figure, so no
    percentile phrase, so `0-100` never entered the allowlist and a correct report carrying an
    estimated p95 was withheld.

    Reading the real ledger would fix that instance and leave two problems. It would make the
    allowlist depend on the artifact being checked — deriving the verifier's expected values
    from the document's own figures is the shape of a check that agrees with itself — and it
    would not fix `15-minute`, which is dormant only because every fixture runs at `PT1H`.
    Enumerating the vocabulary removes the data-dependence instead of narrowing it:
    :func:`derive_allowlist` stays a function of the definition, the snapshot's shape and this
    code, with no path from a measurement into the allowlist.

    `estimator_label` is deliberately **not** enumerated here. Its output is
    `p95, est. from hourly averages`, whose only numeric token is the `p95` that masking
    stage 2 already consumes from the figure's own `formatted` string.
    """
    from reporting_agent.compile.estimators import (
        COMPARE_ESTIMATORS,
        DECLARED_GRAIN_PHRASES,
        DECLARED_METHOD_PHRASES,
        DECLARED_SKETCH_KINDS,
        EXACT_ESTIMATORS,
        FOLDED_STATISTIC_PHRASES,
        method_phrase,
    )

    # The estimator string `collect/snapshot.py` composes is `<sketch>_<grain>_<folded>`, built
    # from the declaration *keys*; the phrases are the values. Composing the key here rather
    # than hand-writing estimator strings means a new sketch kind or grain is picked up by
    # enumeration, and the guard test asserts its numeric tokens reach the allowlist.
    phrases = [
        method_phrase(f"{sketch}_{grain}_{folded}")
        for sketch, _ in DECLARED_SKETCH_KINDS
        for grain, _ in DECLARED_GRAIN_PHRASES
        for folded, _ in FOLDED_STATISTIC_PHRASES
    ]
    phrases.extend(
        method_phrase(estimator) for estimator in sorted(EXACT_ESTIMATORS | COMPARE_ESTIMATORS)
    )
    phrases.extend(method_phrase(estimator) for estimator in sorted(DECLARED_METHOD_PHRASES))
    return tuple(phrases)


def numeric_strings_in(texts: object) -> frozenset[str]:
    """Every maximal whitespace-delimited substring carrying a digit.

    The same tokenization the masking pass uses, so a string this function admits is
    exactly a string stage 5 can mask — the two agreeing is the whole point, and they
    agree by using one rule rather than two implementations of one rule.
    """
    found: set[str] = set()
    for text in texts:  # type: ignore[union-attr]
        if not isinstance(text, str):
            continue
        for match in re.finditer(r"\S+", text):
            token = match.group()
            if _DIGIT.search(token) is not None:
                found.add(token)
    return frozenset(found)


def derive_allowlist(
    definition: Mapping[str, object],
    snapshot: Mapping[str, object],
    *,
    subscription_display_name: str = "",
    catalog_scales: Mapping[str, int] | None = None,
) -> frozenset[str]:
    """Compile and render `definition` with no data, and return its numeric chrome.

    Imports the compile and render stages lazily. `verify/` is on the replay-purity
    closure walk, and importing the renderer at module scope would put `python-docx`
    and `matplotlib` on the import graph of every module that touches a finding — a
    cost paid on every verification for a function most passes never call.
    """
    from reporting_agent.compile.blocks import compile_document
    from reporting_agent.compile.blocks.base import DesignSettings
    from reporting_agent.compile.snapshot_view import build_snapshot_view
    from reporting_agent.render.docx import render_document
    from reporting_agent.verify.tokens import paragraph_texts

    try:
        view = build_snapshot_view(null_context_snapshot(snapshot))
        compiled = compile_document(
            definition,
            view=view,
            subscription_display_name=subscription_display_name,
            prose=None,
            comparison_source=_NullComparison(view),
            catalog_scales=catalog_scales,
        )
        # `CompiledDocument` carries no design — `compile_document` derives one from the
        # definition and keeps it internal — so the same derivation is repeated here
        # rather than reaching into the compiler for it.
        outcome = render_document(
            compiled.document,
            ledger=compiled.ledger,
            design=DesignSettings.from_plain(definition.get("design")),
            preview=False,
        )
    except VerificationFailedError:
        raise
    except Exception as exc:
        raise VerificationFailedError(
            "the null-context render used to derive the static-text allowlist failed "
            f"({type(exc).__name__}); no allowlist was derived and no prose paragraph "
            "was checked, so the verification fails rather than reporting a document "
            "nothing examined"
        ) from exc

    cardinality_formatted: set[str] = set()
    for figure in compiled.ledger.entries.values():
        if not figure.snapshot_path.startswith(_CARDINALITY_PREFIX):
            # Anything outside `$counts/...` is a measurement: a null context has no
            # resources for a block to draw on, so no ordinary `Figure` should exist, and
            # finding one here means a block sourced a number from outside the snapshot —
            # the invariant this product exists to enforce.
            raise VerificationFailedError(
                f"the null-context render produced a figure at {figure.snapshot_path!r} "
                f"(formatted {figure.formatted!r}) from a snapshot carrying no resources; "
                "a block is sourcing a number from outside the snapshot and the derived "
                "allowlist would admit it as static text"
            )
        if figure.value != "0":
            # A cardinality figure is legitimate over an emptied snapshot — "Resources in
            # scope: 0" is a correct figure with a real, re-resolvable `snapshot_path` —
            # but only at zero. A non-zero cardinality here (`raw_archive.object_count`
            # left populated was exactly this) is real data smuggled past the resources
            # and gaps this function is supposed to have emptied, and admitting it would
            # let the verifier later accept that same digit as static chrome anywhere in
            # the document's prose.
            raise VerificationFailedError(
                f"the null-context render produced a non-zero cardinality figure at "
                f"{figure.snapshot_path!r} (value {figure.value!r}) from a snapshot "
                "whose resources and gaps were emptied; a real count survived the null "
                "context and the derived allowlist would admit it as static text"
            )
        cardinality_formatted.add(figure.formatted)

    document = _open_bytes(outcome)
    rendered = numeric_strings_in(p.text for p in paragraph_texts(document))

    # `appendix_methodology`'s phrases cannot be observed from a resource-free render — see
    # `declared_method_phrases` — so the declared vocabulary is unioned in unconditionally,
    # for every run, whether or not this definition carries the block. Unconditional is the
    # point: it makes the allowlist independent of what the run measured.
    vocabulary = numeric_strings_in(declared_method_phrases())

    # Even a correct zero — "0" or "0.0" — must not be admitted as chrome: it is still a
    # figure with provenance, and the masking pass treats the allowlist as "definitely not
    # a measurement". Excluding every cardinality figure's own `formatted` string keeps
    # that pass blind to whether a "0" in the real document came from this namespace or
    # from an actual measurement that happened to resolve to zero. Subtracted last, after the
    # union, so nothing a figure formatted to can be admitted by either source. The two are
    # disjoint in practice — `format.py` emits a bare numeral, and every numeric token in the
    # vocabulary carries a `-` or a letter — so this removes a phrase's token only if that
    # ceases to be true, which is the direction worth failing in.
    return (rendered | vocabulary) - cardinality_formatted


def _open_bytes(outcome: object) -> object:
    """Open `RenderOutcome.docx_bytes` without touching the filesystem.

    In memory deliberately: the allowlist derivation is a side computation of a
    verification, and writing a throwaway document beside the real artifacts would put
    a file under `reports/<runId>/` that is neither the delivered document nor
    something any later pass should ever read.
    """
    import io

    from docx import Document

    payload = getattr(outcome, "docx_bytes", None)
    if not isinstance(payload, (bytes, bytearray)):
        raise VerificationFailedError(
            "the null-context render returned no document bytes to derive an "
            f"allowlist from (got {type(outcome).__name__})"
        )
    return Document(io.BytesIO(bytes(payload)))
