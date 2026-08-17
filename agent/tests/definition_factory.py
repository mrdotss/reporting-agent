"""Template definitions for the compile-stage tests, built to the shape both validators accept.

Every definition these helpers produce is run through
:func:`~reporting_agent.compile.definition.assert_valid_pinned_definition` by :func:`definition`,
so a test cannot accidentally compile something the wizard could never have saved. That coupling
is the point: the compile stage's job is to compile **accepted** definitions, and a test fixture
the validator would reject proves nothing about it.

The config shapes here mirror `app/lib/templates/starters.ts`, which is what the builder actually
writes — see `compile/blocks/base.py`'s note on why a config value's *shape* is checked at compile
time rather than at save time.

Not a test module; a helper `tests/` modules import.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import snapshot_factory as sf
from reporting_agent.compile.definition import assert_valid_pinned_definition

__all__ = [
    "CPU_AVG",
    "CPU_MAX",
    "CPU_P95",
    "MEMORY_USED_PCT_AVG",
    "block",
    "definition",
    "scope",
]

CPU_AVG: Mapping[str, str] = {"metric": sf.CPU, "statistic": "avg"}
CPU_MAX: Mapping[str, str] = {"metric": sf.CPU, "statistic": "max"}
CPU_P95: Mapping[str, str] = {
    "metric": sf.CPU,
    "statistic": "p95",
    "estimator": "histogram_sketch_pt1h_interval_average",
    "fidelity_tier": "baseline",
}
MEMORY_USED_PCT_AVG: Mapping[str, str] = {
    "derived": sf.MEMORY_USED_PCT,
    "statistic": "avg",
}


def scope(
    *,
    resource_types: Sequence[str] | None = None,
    tag_filters: Sequence[Mapping[str, str]] = (),
    resource_groups: Sequence[str] = (),
    top_n: Mapping[str, object] | None = None,
    sort: str | None = None,
) -> dict[str, Any]:
    """A scope object with **every dimension present**, which is the shape the schema requires
    and the shape the mirrored Python validator reads. A key omitted here would be a key one side
    defaults and the other rejects."""
    return {
        "resource_types": list(resource_types if resource_types is not None else [sf.VM_TYPE]),
        "tag_filters": [dict(entry) for entry in tag_filters],
        "resource_groups": list(resource_groups),
        "top_n": dict(top_n) if top_n is not None else None,
        "sort": sort,
    }


def block(
    block_id: str,
    block_type: str,
    config: Mapping[str, object] | None = None,
    *,
    scope_override: Mapping[str, object] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": block_id,
        "type": block_type,
        "config": dict(config or {}),
    }
    if scope_override is not None:
        body["scope_override"] = dict(scope_override)
    return body


def definition(
    blocks: Sequence[Mapping[str, object]],
    *,
    name: str = "Compile fixture",
    template_scope: Mapping[str, object] | None = None,
    metrics: Mapping[str, Sequence[Mapping[str, object]]] | None = None,
    design: Mapping[str, object] | None = None,
    period: Mapping[str, object] | None = None,
    validate: bool = True,
) -> dict[str, Any]:
    """One definition, validated by default.

    `validate=False` exists for the handful of tests that deliberately drive the compiler with
    something the validator would refuse — a block type with no compiler, say — to prove the
    compiler's own refusal rather than the validator's.
    """
    body: dict[str, Any] = {
        "schema_version": 1,
        "identity": {"name": name, "report_title": name},
        "scope": dict(template_scope) if template_scope is not None else scope(),
        "period": dict(period) if period is not None else {"kind": "last_full_month"},
        "metrics": {
            resource_type: [dict(item) for item in items]
            for resource_type, items in (
                metrics if metrics is not None else {sf.VM_TYPE: [CPU_AVG, CPU_MAX, CPU_P95]}
            ).items()
        },
        "blocks": [dict(entry) for entry in blocks],
        "design": dict(design)
        if design is not None
        else {
            "preset": "editorial",
            "accent_color": "#1f6f78",
            "density": "normal",
            "table_style": "hairline",
            "number_format": {"decimal_places": 2, "group_thousands": True},
            "cover_page": True,
            "logo": None,
            "page_size": "A4",
        },
    }
    if validate:
        assert_valid_pinned_definition(body)
    return body
