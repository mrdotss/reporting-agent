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
from typing import Final

from reporting_agent.errors import VerificationFailedError

__all__ = ["derive_allowlist", "null_context_snapshot", "numeric_strings_in"]

_DIGIT: Final[re.Pattern[str]] = re.compile(r"\d")


def null_context_snapshot(snapshot: Mapping[str, object]) -> dict[str, object]:
    """The run's snapshot with every resource and gap removed.

    A shallow copy with two keys replaced: everything that describes *when* and *where*
    the collection happened is kept, and everything that carries a measurement is
    dropped. The original is never mutated — it is the immutable, content-addressed
    artifact the whole product rests on, and a derivation that edited it in place would
    invalidate its own digest.
    """
    null = dict(snapshot)
    null["resources"] = []
    null["gaps"] = []
    return null


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

    if compiled.figure_count:
        # A null context produced a figure, which means a block sourced a number from
        # somewhere other than the snapshot. That is the invariant this product exists
        # to enforce, and finding it here means the allowlist would admit a real
        # measurement as chrome.
        raise VerificationFailedError(
            f"the null-context render produced {compiled.figure_count} figure(s) from a "
            "snapshot carrying no resources; a block is sourcing a number from outside "
            "the snapshot and the derived allowlist would admit it as static text"
        )

    document = _open_bytes(outcome)
    return numeric_strings_in(p.text for p in paragraph_texts(document))


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
