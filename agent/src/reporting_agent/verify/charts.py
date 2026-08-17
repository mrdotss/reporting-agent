"""Chart verification — an image tied to the numbers beside it (Req 30).

A PNG is opaque to every other pass in this package. The token extractor cannot read it, the
anchored pass cannot resolve a cell inside it, and the PDF gate cannot find a `formatted`
string in it. So without this module, "every number in the document is traceable" is simply
false for the one element a reader is most likely to trust at a glance.

Two gates, and **both are required** (Req 30.5):

* The **companion table** goes through the anchored-equality pass, which proves the numbers
  printed beside the image are the ledger's.
* The **data hash** is recomputed from the ledger and compared against the sidecar written
  when the image was drawn, which proves the image was drawn from those same numbers.

Either alone is insufficient, and in a specific way. The table gate alone passes a document
whose embedded image is stale — the table was re-rendered, the picture was not. The hash gate
alone passes a document whose companion table carries a value the ledger never emitted, since
the hash says nothing about what got typed into the grid.

## Two rules that look like details and are not

**Pairing is by identity, never by proximity** (Req 30.1). The image's alt text and the
table's `w:tblCaption` both carry `cht:<path>`, derived from one AST path, so they cannot
disagree. Pairing by "the table immediately after the picture" would survive exactly as long
as nobody inserts a paragraph between them.

**The recomputation draws nothing from the sidecar or the image** (Req 30.2). A digest
recomputed from the artifact it is checking proves nothing at all — it is the check that
always passes. Every contribution comes from the ledger's `Figure` objects, reached through
the AST's chart nodes, which is why this module takes the AST rather than the rendered
package.
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Final

from reporting_agent.compile.ast import Chart, child_nodes
from reporting_agent.verify.anchors import AnchorPass, TableGrid
from reporting_agent.verify.findings import (
    FINDING_CHART_HASH_MISMATCH,
    FINDING_CHART_TABLE_MISSING,
    Finding,
    record_finding,
)

__all__ = [
    "SIDECAR_SUFFIX",
    "ChartPass",
    "chart_nodes",
    "check_charts",
    "sidecar_digest",
]

SIDECAR_SUFFIX: Final[str] = ".chart.json"
"""Mirrors `render/charts.py`'s suffix, so the key the renderer wrote is the key read here.

Restated rather than imported for the same reason `verify/anchors.py` restates the key-column
ordinal: importing `render/charts.py` at module scope would put matplotlib on the import graph
of every module that touches a finding, and a one-word constant is not worth that.
"""

_SHA256_LENGTH: Final[int] = 64
_SHA256_ALPHABET: Final[frozenset[str]] = frozenset("0123456789abcdef")


@dataclass(frozen=True, slots=True)
class ChartPass:
    """What one chart pass observed (Req 30.7).

    `verified` holds the identities where **both** gates were clean, which is the only
    definition of a verified chart this module recognises.
    """

    findings: tuple[Finding, ...]
    charts_checked: int
    hashes_matched: int
    verified: frozenset[str]
    blocking_identities: frozenset[str]


def chart_nodes(node: object) -> Iterator[Chart]:
    """Every `Chart` in `node`'s subtree, in document order.

    Descends through `LayoutColumn` — unlike `compile/figures.py`'s `walk_figures`, which
    stops there because a figure's *path* is rooted at the block that emitted it. A chart's
    identity is likewise rooted at its own block, so descending here recomputes nothing and
    a chart inside a `row` block's column is checked like any other.
    """
    if isinstance(node, Chart):
        yield node
        return
    for child in child_nodes(node):
        yield from chart_nodes(child)


def sidecar_digest(payload: object) -> str | None:
    """The `data_hash` a sidecar records, or `None` where there is no readable digest.

    One return value for three distinct failures — absent sidecar, unparsable JSON, and a
    `data_hash` that is not 64 lowercase hex characters — because Req 30.6 gives them one
    outcome: a chart whose image cannot be tied to its data fails the same way as one that
    disagrees with it. Distinguishing them here would invite a caller to treat "no sidecar"
    as less serious than "wrong sidecar", which is exactly the softening the requirement
    forbids.
    """
    if not isinstance(payload, (bytes, bytearray)):
        return None
    try:
        document = json.loads(bytes(payload).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(document, Mapping):
        return None
    digest = document.get("data_hash")
    if (
        not isinstance(digest, str)
        or len(digest) != _SHA256_LENGTH
        or not _SHA256_ALPHABET.issuperset(digest)
    ):
        return None
    return digest


def check_charts(
    ast: object,
    *,
    grids: Sequence[TableGrid],
    sidecars: Mapping[str, bytes],
    table_pass: AnchorPass,
) -> ChartPass:
    """Check every chart node of `ast` (Req 30.7), never stopping at the first failure.

    `table_pass` is the anchored-equality pass already run over the whole document. It is
    taken as an argument rather than re-run per chart because a companion table is an
    ordinary data table: running it twice would double every finding it records, and running
    a *second* implementation over charts alone would be a second definition of what an
    anchored check means.
    """
    from reporting_agent.render.charts import chart_data_hash

    identities = {grid.identity for grid in grids}
    findings: list[Finding] = []
    verified: set[str] = set()
    blocking: set[str] = set()
    charts_checked = 0
    hashes_matched = 0

    for node in chart_nodes(ast):
        charts_checked += 1
        identity = node.anchor_id
        path = str(node.path)
        table_clean = identity in identities and identity not in table_pass.blocking_identities

        if identity not in identities:
            blocking.add(identity)
            findings.append(
                record_finding(
                    FINDING_CHART_TABLE_MISSING,
                    f"the chart at {path} has no companion data table captioned "
                    f"{identity!r}; an image with no table beside it carries numbers no "
                    f"pass in this package can read",
                    ast_path=path,
                    table_id=identity,
                )
            )

        recomputed = chart_data_hash(node)
        observed = sidecar_digest(sidecars.get(f"{identity}{SIDECAR_SUFFIX}"))
        if observed == recomputed:
            hashes_matched += 1
        else:
            blocking.add(identity)
            findings.append(
                record_finding(
                    FINDING_CHART_HASH_MISMATCH,
                    f"the chart at {path} recomputes to {recomputed} from the figure "
                    f"ledger, but its sidecar records "
                    f"{observed if observed is not None else 'no readable digest'}",
                    ast_path=path,
                    table_id=identity,
                    expected=recomputed,
                    observed=observed if observed is not None else "",
                )
            )

        if table_clean and observed == recomputed:
            verified.add(identity)

    return ChartPass(
        findings=tuple(sorted(findings, key=_sort_key)),
        charts_checked=charts_checked,
        hashes_matched=hashes_matched,
        verified=frozenset(verified),
        blocking_identities=frozenset(blocking),
    )


def _sort_key(finding: Finding) -> tuple[str, str]:
    """Ordered by chart identity, then by type, for the same reason Req 27.14 orders the
    table findings: two verifications of one document must produce one result."""
    return (str(finding.get("table_id", "")), str(finding.get("type", "")))
