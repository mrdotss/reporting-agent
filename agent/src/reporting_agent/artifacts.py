"""The report artifacts: where each one is written, and what is scrubbed before it is.

Every object a run produces beyond its snapshot lands under one prefix:

    <actor_id>/reports/<runId>/report.docx
                              report.pdf
                              ledger.json
                              ast.json
                              prose.json
                              verification-<attemptId>.json
                              charts/<chartId>.png
                              charts/<chartId>.sidecar.json

**The actor id is the first segment**, matching `collect/snapshot.py`'s `snapshot_key`, and
that placement is load-bearing rather than tidy: the web app authorizes a download by
comparing the first segment against the signed-in user's id **segment-wise**. A prefix test
would authorize `alice-evil/...` for `alice`, and the fix people reach for — appending a
separator — still admits a key whose *second* segment is anything at all. So the second
segment is checked too, against exactly `snapshots` or exactly `reports`, and `previews` is
deliberately outside that set: the report download path is structurally unable to serve a
preview.

## Scrub before write, not after

Every JSON artifact goes through `redaction.scrub_deep` **on the way in** (Req 43.7, 43.10).
Not as a courtesy — a verification finding quotes service error text verbatim so a reviewer
can act on it, and an Azure error legitimately carries a request URL with a token in it. A
scrub applied after writing would leave the unredacted bytes at rest, which is the only copy
that matters.

A registered secret found in a finding is replaced with the fixed marker and **the finding is
retained** (Req 43.10). Dropping the finding would trade a leak for a hole in the audit
record, and the finding's value is its type and location rather than the quoted text.

## Why upload happens after the verification passes

`write_report_artifacts` is called by `report_pipeline.py` only on a passing verification, so
there is no window in which a `report_file` event names an object sitting beside a failure.
The verification result itself is the exception: it is written on **both** paths, because Req
25.10 requires the panel to present every finding for a run whose document was withheld.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final, cast

from reporting_agent.redaction import scrub_deep
from reporting_agent.storage.base import (
    JSON_CONTENT_TYPE,
    ObjectStore,
    owner_tags,
)

__all__ = [
    "ARTIFACT_KIND_DOCX",
    "ARTIFACT_KIND_PDF",
    "DOCX_CONTENT_TYPE",
    "HTML_CONTENT_TYPE",
    "PDF_CONTENT_TYPE",
    "PNG_CONTENT_TYPE",
    "REPORTS_SEGMENT",
    "ArtifactRef",
    "ast_to_plain",
    "canonical_json",
    "chart_image_key",
    "chart_sidecar_key",
    "preview_html_key",
    "preview_key",
    "report_prefix",
    "reports_key",
    "verification_key",
    "write_json_artifact",
    "write_report_artifacts",
    "write_verification_result",
]

REPORTS_SEGMENT: Final[str] = "reports"
PREVIEWS_SEGMENT: Final[str] = "previews"

DOCX_CONTENT_TYPE: Final[str] = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)
PDF_CONTENT_TYPE: Final[str] = "application/pdf"

HTML_CONTENT_TYPE: Final[str] = "text/html; charset=utf-8"
"""The emitted paper rendering.

Written as an artifact rather than regenerated in the browser, and that is Requirement
14.1's "no third layout definition" made structural: the app has the AST, so it *could*
walk it and produce its own markup — and then a heading's markup would be decided in two
places, in two languages, by two people who never compared them. The `Html_Emitter` emits
once, here, and the app injects what it emitted."""
PNG_CONTENT_TYPE: Final[str] = "image/png"

ARTIFACT_KIND_DOCX: Final[str] = "docx"
ARTIFACT_KIND_PDF: Final[str] = "pdf"


@dataclass(frozen=True, slots=True)
class ArtifactRef:
    """One written object, as a `report_file` event names it.

    Carries the key, the bucket, the kind and the byte count — and **no presigned URL and
    no content** (Req 42.3). A URL in an event would be a credential in a stream the browser
    keeps in memory and the relay may log; the app mints one server-side, per request, gated
    on the run's verification having passed.
    """

    key: str
    bucket: str
    kind: str
    bytes: int


# --------------------------------------------------------------------------- #
# Keys
# --------------------------------------------------------------------------- #


def _segment(label: str, value: str) -> str:
    """One key segment, refusing anything that would move the object elsewhere.

    A `/` in the actor id moves the object into another owner's namespace; a `/` in the run
    id or the chart id splits one artifact across two prefixes. Both are silent at write
    time and only visible when a download authorizes wrongly or a fetch 404s, so they are
    refused here.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string, got {value!r}")
    if "/" in value:
        raise ValueError(
            f"{label} must contain no '/', got {value!r}: an artifact key's first segment "
            f"is the owning actor id and authorization compares it segment-wise"
        )
    return value


def report_prefix(actor_id: str, run_id: str) -> str:
    """`<actor_id>/reports/<runId>/`."""
    return (
        f"{_segment('actor_id', actor_id)}/{REPORTS_SEGMENT}/"
        f"{_segment('run_id', run_id)}/"
    )


def reports_key(actor_id: str, run_id: str, name: str) -> str:
    """One object under a run's report prefix."""
    return f"{report_prefix(actor_id, run_id)}{_segment('name', name)}"


def verification_key(actor_id: str, run_id: str, attempt_id: str) -> str:
    """`verification-<attemptId>.json` — one per attempt (Req 36.3).

    Per attempt rather than per run, so a re-verification months later neither overwrites
    the original nor has to argue about which of two results the row refers to.
    """
    return reports_key(
        actor_id, run_id, f"verification-{_segment('attempt_id', attempt_id)}.json"
    )


def chart_image_key(actor_id: str, run_id: str, chart_id: str) -> str:
    """`charts/<chartId>.png`.

    `chart_id` is the chart's `cht:<path>` identity with `:` left intact — S3 admits it in a
    key and it is what the sidecar and the image's alt text already carry, so a reader
    holding a finding can find the object without a second mapping.
    """
    return f"{report_prefix(actor_id, run_id)}charts/{_segment('chart_id', chart_id)}.png"


def chart_sidecar_key(actor_id: str, run_id: str, chart_id: str) -> str:
    return (
        f"{report_prefix(actor_id, run_id)}charts/"
        f"{_segment('chart_id', chart_id)}.sidecar.json"
    )


def preview_key(actor_id: str, preview_id: str) -> str:
    """`<actor_id>/previews/<previewId>/preview.pdf`.

    A separate second segment on purpose. The report download predicate admits exactly
    `snapshots` and exactly `reports`, so it cannot serve a preview however the caller asks
    — and the preview route's own key template cannot name a report.
    """
    return f"{_preview_prefix(actor_id, preview_id)}/preview.pdf"


def preview_html_key(actor_id: str, preview_id: str) -> str:
    """`<actor_id>/previews/<previewId>/preview.html` — the same prefix as the `.pdf`.

    Deliberately under `previews/` rather than beside a report: the paper canvas shows a
    definition the consultant has not saved, so its rendering is not a report's and must
    not be reachable through anything that serves one.
    """
    return f"{_preview_prefix(actor_id, preview_id)}/preview.html"


def _preview_prefix(actor_id: str, preview_id: str) -> str:
    return (
        f"{_segment('actor_id', actor_id)}/{PREVIEWS_SEGMENT}/"
        f"{_segment('preview_id', preview_id)}"
    )


# --------------------------------------------------------------------------- #
# Writing
# --------------------------------------------------------------------------- #


def canonical_json(document: object) -> bytes:
    """A JSON artifact's bytes: scrubbed, key-sorted, UTF-8.

    `sort_keys` rather than insertion order, so two writes of one document produce identical
    bytes and a digest taken over them means something. This is **not** RFC 8785 — the
    snapshot and the ledger are canonicalized with `rfc8785` where a cross-language digest
    is the point; these artifacts are read by one reader and need only be stable.
    """
    return json.dumps(
        scrub_deep(document),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


async def write_json_artifact(
    store: ObjectStore, key: str, document: object, *, actor_id: str
) -> int:
    """Write one scrubbed JSON artifact, returning its byte count."""
    payload = canonical_json(document)
    await store.put_bytes(
        key, payload, content_type=JSON_CONTENT_TYPE, tags=owner_tags(actor_id)
    )
    return len(payload)


async def write_verification_result(
    store: ObjectStore,
    result: Mapping[str, Any],
    *,
    actor_id: str,
    run_id: str,
) -> tuple[str, int]:
    """Write `verification-<attemptId>.json` and return `(key, bytes)`.

    Written on **both** the passing and the failing path, unlike every other artifact here.
    Req 25.10 requires the panel to present every finding for a run whose document was
    withheld, and a result the app cannot read is a panel that can only say "it failed".
    """
    key = verification_key(actor_id, run_id, str(result.get("attempt_id") or ""))
    written = await write_json_artifact(store, key, result, actor_id=actor_id)
    return key, written


async def write_report_artifacts(
    store: ObjectStore,
    *,
    actor_id: str,
    run_id: str,
    bucket: str,
    docx_bytes: bytes,
    pdf_bytes: bytes,
    ledger_bytes: bytes,
    ast: object,
    prose: object,
    html: str,
    chart_images: Mapping[str, bytes] | None = None,
    chart_sidecars: Mapping[str, bytes] | None = None,
) -> tuple[ArtifactRef, ...]:
    """Write every artifact of a **passing** run, returning the two downloadable ones.

    `ledger_bytes` arrives already serialized — `FigureLedger.serialize()` produces the RFC
    8785 canonical form whose digest the verification result records, and re-serializing
    here would risk writing bytes whose digest is not the one recorded (Req 17.6).

    The returned refs are the `.docx` and the `.pdf` only. The ledger, the AST, the prose,
    the emitted HTML, the charts and their sidecars are written because a re-verification
    and the in-app paper rendering read them, not because anyone downloads them, so no
    `report_file` event names them.

    `html` is the `Html_Emitter`'s output for **this** compilation — the same AST the
    `.docx` was emitted from. Stored rather than regenerated, so the in-app rendering of an
    archived report is the markup that was emitted when the report was produced rather than
    whatever today's emitter would make of the same tree.
    """
    tags = owner_tags(actor_id)

    await store.put_bytes(
        reports_key(actor_id, run_id, "report.docx"),
        docx_bytes,
        content_type=DOCX_CONTENT_TYPE,
        tags=tags,
    )
    await store.put_bytes(
        reports_key(actor_id, run_id, "report.pdf"),
        pdf_bytes,
        content_type=PDF_CONTENT_TYPE,
        tags=tags,
    )
    await store.put_bytes(
        reports_key(actor_id, run_id, "ledger.json"),
        ledger_bytes,
        content_type=JSON_CONTENT_TYPE,
        tags=tags,
    )
    await write_json_artifact(
        store, reports_key(actor_id, run_id, "ast.json"), ast, actor_id=actor_id
    )
    await write_json_artifact(
        store, reports_key(actor_id, run_id, "prose.json"), prose, actor_id=actor_id
    )
    await store.put_bytes(
        reports_key(actor_id, run_id, "document.html"),
        html.encode("utf-8"),
        content_type=HTML_CONTENT_TYPE,
        tags=tags,
    )

    for chart_id, image in sorted((chart_images or {}).items()):
        await store.put_bytes(
            chart_image_key(actor_id, run_id, chart_id),
            image,
            content_type=PNG_CONTENT_TYPE,
            tags=tags,
        )
    for chart_id, sidecar in sorted((chart_sidecars or {}).items()):
        await store.put_bytes(
            chart_sidecar_key(actor_id, run_id, chart_id),
            sidecar,
            content_type=JSON_CONTENT_TYPE,
            tags=tags,
        )

    return (
        ArtifactRef(
            key=reports_key(actor_id, run_id, "report.docx"),
            bucket=bucket,
            kind=ARTIFACT_KIND_DOCX,
            bytes=len(docx_bytes),
        ),
        ArtifactRef(
            key=reports_key(actor_id, run_id, "report.pdf"),
            bucket=bucket,
            kind=ARTIFACT_KIND_PDF,
            bytes=len(pdf_bytes),
        ),
    )


def ast_to_plain(node: object) -> Any:
    """The compiled tree as plain JSON data, for `ast.json`.

    Dataclass by dataclass, with the class name carried as `node`, so the in-app paper
    rendering can dispatch on it without re-deriving the tree's shape. Every `Decimal` is
    rendered as its own digit string rather than through `float`, for the reason every other
    serialization in this product does it: a value that round-trips through binary floating
    point is a different value.
    """
    import dataclasses
    from decimal import Decimal

    if isinstance(node, Decimal):
        return str(node)
    if isinstance(node, (str, bool, int, float)) or node is None:
        return node
    if dataclasses.is_dataclass(node) and not isinstance(node, type):
        plain: dict[str, Any] = {"node": type(node).__name__}
        for field in dataclasses.fields(node):
            plain[field.name] = ast_to_plain(getattr(node, field.name))
        return plain
    if isinstance(node, Mapping):
        return {str(key): ast_to_plain(value) for key, value in node.items()}
    if isinstance(node, Sequence):
        return [ast_to_plain(item) for item in node]
    return cast("Any", str(node))
