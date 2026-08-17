"""`MetricRequeryPort` — the one place verification touches a cloud (Req 25.7, 34.7).

`verify/` may not import an Azure SDK. Every other pass in this package is a pure function
over the snapshot, the ledger and the rendered artifacts, which is what lets the whole
verification suite run without a subscription — and what lets a re-verification of a
two-year-old report work at all, since the credential that collected it is long expired.

The bounded drift sample is the single exception, and it is expressed as a **port** rather
than as an import for that reason. The consequence is worth stating plainly: `requery=None`
is a legitimate, complete verification. Drift is advisory (Req 34.6, 34.10), so a
verification that could not re-query anything reaches exactly the same status as one that
re-queried twenty-five resources and found them all unchanged.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol, runtime_checkable

__all__ = ["MetricRequeryPort", "RequeriedValue"]


@dataclass(frozen=True, slots=True)
class RequeriedValue:
    """One re-queried statistic.

    `value` is a `Decimal`, never a `float`, for the same reason nothing else on this path
    is: the comparison is against a decimal string the snapshot recorded, and a binary
    float round trip would manufacture a difference at the last digit and report drift on a
    value that never moved.
    """

    resource_id: str
    metric: str
    statistic: str
    value: Decimal


@runtime_checkable
class MetricRequeryPort(Protocol):
    """Re-query one metric for a bounded set of resources, over one window at one grain.

    The signature takes the **sample** rather than a scope, so the port cannot be used to
    re-collect: there is no argument that could name the whole subscription, which makes
    Req 34.2's "no full re-query" a property of the interface rather than a rule an
    implementation is trusted to follow.

    An implementation returns a value per resource it could answer for, and simply omits a
    resource it could not. Omission is not an error (Req 34.9): the resource is recorded as
    not re-queried, no finding is recorded, and the remaining re-queries continue.
    """

    async def requery(
        self,
        *,
        resource_ids: Sequence[str],
        metric: str,
        statistic: str,
        window: dict[str, str],
        grain: str,
    ) -> Sequence[RequeriedValue]: ...
