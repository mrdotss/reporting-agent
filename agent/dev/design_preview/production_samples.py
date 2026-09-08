"""Render the real Word/styled-PDF pipeline for every existing appearance choice."""

import io
import json
import zipfile
from pathlib import Path

from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import DesignSettings
from reporting_agent.compile.messages import load_messages
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.render.docx import render_document
from reporting_agent.render.printpdf import render_print_pdf
from reporting_agent.verify.pdf import is_located, normalize
from reporting_agent.verify.tokens import read_pdf_text

root = Path(__file__).resolve().parents[3]
fixture = json.loads((Path(__file__).parent / "sample.json").read_text())
out = root / "artifacts/design-preview/production"
out.mkdir(parents=True, exist_ok=True)
messages = load_messages("en")
for theme in ["editorial", "corporate", "technical", "minimal"]:
    for style in ["stacked", "soft_area", "flat_area", "range_band", "columns", "sparkline"]:
        definition = json.loads(json.dumps(fixture["definition"]))
        definition["design"].update(
            preset=theme,
            chart_style=style,
            chart_font="monospace",
            accent_color="#1f6f78" if theme != "minimal" else "#30343b",
        )
        design = DesignSettings.from_plain(definition["design"])
        compiled = compile_document(definition, view=build_snapshot_view(fixture["snapshot"]))
        result = render_document(
            compiled.document, ledger=compiled.ledger, design=design, messages=messages
        )
        pdf = render_print_pdf(
            compiled.document,
            front_matter_sections=[],
            chart_vectors=result.chart_vectors,
            chart_tables=result.chart_tables,
            design=design,
            messages=messages,
            title="Sample report",
        )
        name = f"{theme}-{style}"
        (out / f"{name}.pdf").write_bytes(pdf.pdf_bytes)
        (out / f"{name}.docx").write_bytes(result.docx_bytes)
        (out / f"{name}.svg").write_text(next(iter(result.chart_vectors.values())))
        archive = zipfile.ZipFile(io.BytesIO(result.docx_bytes))
        image = next(n for n in archive.namelist() if n.startswith("word/media/"))
        (out / f"{name}.png").write_bytes(archive.read(image))
        text, pages = read_pdf_text(out / f"{name}.pdf")
        missing = [
            f.formatted
            for p, f in compiled.ledger.entries.items()
            if str(p) not in pdf.omitted_figure_paths
            and not is_located(normalize(f.formatted), text, decimal=".", grouping=",")
        ]
        assert not missing, (name, missing)
        print(name, pages, "pages; displayed figures verified", flush=True)
