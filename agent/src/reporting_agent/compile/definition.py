"""The block-type set and the per-type config schema — one contract, expressed in
two languages.

The declaration below is mirrored in `app/lib/templates/blocks.ts` (Req 2.5), and
a static guard in the web test suite (`app/test/mirror.static.test.ts`) extracts
the sentinel-delimited regions from both files and compares the block-type sets,
every type's config field names, every field's required status and every
enumerated field's permitted values (Req 2.6). That is why the declarations sit
on their own, between sentinel comments, as plain tuple and dict literals rather
than inside a `Pydantic` model or an `Enum`: the guard needs neither a Python
parser nor a TypeScript parser, so the guard itself cannot drift from what it
guards — the same reasoning `events.py` already applies to the SSE event
vocabulary.

**This module is declarations only.** The actual validator — the mirrored
`Pydantic`/dataclass-based `Block_Compiler` counterpart of
`lib/templates/definition.ts`'s zod schema, which reads `BLOCK_TYPES` and
`BLOCK_CONFIG` to accept or reject a submitted definition — lands in Task 5.1.
Keeping this module to the two sentinel-delimited declarations plus this
docstring is deliberate: the Mirror_Guard's declaration half needs something to
read from the moment this file exists, and nothing else.
"""

from typing import Final

# --- BEGIN BLOCK TYPES (mirrored in app/lib/templates/blocks.ts) ---
BLOCK_TYPES: Final[tuple[str, ...]] = (
    "cover",
    "executive_summary",
    "kpi_row",
    "resource_table",
    "top_n_table",
    "timeseries_chart",
    "distribution_chart",
    "capacity_vs_usage",
    "gaps_and_coverage",
    "comparison_delta",
    "verification_record",
    "appendix_methodology",
    "row",
    "page_break",
    "heading",
    "rich_text",
)
# --- END BLOCK TYPES ---

# --- BEGIN BLOCK CONFIG (mirrored in app/lib/templates/blocks.ts) ---
BLOCK_CONFIG: Final[dict[str, dict[str, object]]] = {
    "cover": {
        "required": [],
        "optional": ["subtitle"],
        "enums": {},
    },
    "executive_summary": {
        "required": [],
        "optional": [],
        "enums": {},
    },
    "kpi_row": {
        "required": ["metrics"],
        "optional": ["caption", "show_fidelity"],
        "enums": {},
    },
    "resource_table": {
        "required": ["columns"],
        "optional": ["caption", "show_fidelity"],
        "enums": {},
    },
    "top_n_table": {
        "required": ["columns", "order_by"],
        "optional": ["caption", "show_fidelity"],
        "enums": {"order_by_direction": ["descending", "ascending"]},
    },
    "timeseries_chart": {
        "required": ["metrics"],
        "optional": ["caption", "show_fidelity"],
        "enums": {},
    },
    "distribution_chart": {
        "required": ["metrics"],
        "optional": ["caption", "show_fidelity"],
        "enums": {},
    },
    "capacity_vs_usage": {
        "required": ["capacity_metric", "usage_metric"],
        "optional": ["caption", "show_fidelity"],
        "enums": {},
    },
    "gaps_and_coverage": {
        "required": [],
        "optional": ["caption"],
        "enums": {},
    },
    "comparison_delta": {
        "required": ["run_a", "run_b"],
        "optional": ["caption"],
        "enums": {},
    },
    "verification_record": {
        "required": [],
        "optional": ["caption"],
        "enums": {},
    },
    "appendix_methodology": {
        "required": [],
        "optional": ["caption"],
        "enums": {},
    },
    "row": {
        "required": [],
        "optional": [],
        "enums": {},
    },
    "page_break": {
        "required": [],
        "optional": [],
        "enums": {},
    },
    "heading": {
        "required": ["level", "text"],
        "optional": [],
        "enums": {},
    },
    "rich_text": {
        "required": ["text"],
        "optional": [],
        "enums": {},
    },
}
# --- END BLOCK CONFIG ---

# A declaration that contradicts itself is worth catching at import rather than
# at the first validation: every type is declared exactly once, and every type
# declared in BLOCK_TYPES has exactly one BLOCK_CONFIG entry, and vice versa.
assert len(set(BLOCK_TYPES)) == len(BLOCK_TYPES), BLOCK_TYPES
assert set(BLOCK_CONFIG.keys()) == set(BLOCK_TYPES), BLOCK_CONFIG.keys()
