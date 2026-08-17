"""Rendering: two emitters over one tree, plus the theme loader they both rest on.

`compile/` produces one AST and one ledger. This package turns that **same tree** into the
delivered `.docx` (`docx.py`), the `.pdf` converted from it (`pdf.py`), the in-app HTML
preview (`html.py`) and the chart images the document embeds (`charts.py`). Nothing here
computes a figure: every numeric string it writes comes from a ledger entry's `formatted`
value, which `compile/format.py` produced and the verifier matches against.

`themes.py` is the gate in front of all of it — a theme missing a style the compiled blocks
reference is a build failure, not a silently unstyled delivered document.
"""

from __future__ import annotations

__all__: tuple[str, ...] = ()
