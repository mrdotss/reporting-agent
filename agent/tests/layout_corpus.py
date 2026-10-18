"""The runtime's reading of each v4 section layout in `fixtures/layouts.json`, as JSON.

**Not a test module.** `app/test/builder-layout-mirror.static.test.ts` spawns it and holds
the builder's port of the layout rules (`app/lib/builder/model.ts`) to the same answer,
the way `definition_corpus.py` holds the two validators to one verdict. A canvas that laid
a section out one way while the report printed it another would be wrong without failing
anything else.

```
PYTHONPATH=src .venv/bin/python tests/layout_corpus.py
```
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Final

CASES_PATH: Final[Path] = Path(__file__).resolve().parent / "fixtures" / "layouts.json"


def visible_layout(provider: str, section: dict[str, Any]) -> list[Any]:
    """What `_v4_layout` prints: a slot name, an added block's id, or the group's slots."""
    from reporting_agent.catalog.loader import load_section_catalogue
    from reporting_agent.compile.sections import _v4_layout

    entry = load_section_catalogue(provider=provider).by_key(section["type"])
    assert entry is not None, section["type"]
    result: list[Any] = []
    for item in _v4_layout(section, entry):
        if item.group:
            result.append([child.expansion.slot for child in item.group if child.expansion])
        elif item.expansion is None:
            result.append(item.settings["id"])
        else:
            result.append(item.expansion.slot)
    return result


def print_order(provider: str, sections: list[dict[str, Any]]) -> list[str]:
    """The section ids in the order `expand_sections` prints them."""
    from reporting_agent.catalog.loader import load_section_catalogue
    from reporting_agent.compile.sections import _section_sort_key

    catalogue = load_section_catalogue(provider=provider)
    fixed = {entry.key: index for index, entry in enumerate(catalogue.fixed_entries)}
    keyed = [(section, catalogue.by_key(section["type"])) for section in sections]
    keyed.sort(key=lambda pair: _section_sort_key(pair[0], pair[1], fixed))
    return [section["id"] for section, _ in keyed]


def payload() -> dict[str, Any]:
    document = json.loads(CASES_PATH.read_text())
    return {
        "layouts": {
            case["name"]: visible_layout(case["provider"], case["section"])
            for case in document["cases"]
        },
        "orders": {
            case["name"]: print_order(case["provider"], case["sections"])
            for case in document["orders"]
        },
    }


if __name__ == "__main__":
    json.dump(payload(), sys.stdout, ensure_ascii=False, sort_keys=True)
    sys.stdout.write("\n")
