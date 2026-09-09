"""Render the selected-metric regression fixture through the actual report pipeline.

Run from the repository root with PYTHONPATH=agent/src:agent/tests.
"""

import argparse
from pathlib import Path

from reporting_agent.catalog.loader import load_section_catalogue
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import DesignSettings
from reporting_agent.compile.messages import load_messages
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.render.docx import render_document
from reporting_agent.render.printpdf import render_print_pdf
from reporting_agent.verify.pdf import is_located, normalize
from reporting_agent.verify.tokens import read_pdf_text
from test_selected_metric_output import selected_fixture


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--postgresql", action="store_true")
    args = parser.parse_args()
    if args.postgresql:
        from test_postgresql_inventory import postgresql_fixture
        definition, snapshot = postgresql_fixture()
    else:
        definition, snapshot = selected_fixture()
    filename = "postgresql-inventory" if args.postgresql else "selected-metrics"
    definition["design"]["number_format"] = {"bytes_as_gib": True}
    design = DesignSettings.from_plain(definition["design"])
    messages = load_messages("en")
    compiled = compile_document(
        definition, view=build_snapshot_view(snapshot), catalogue=load_section_catalogue()
    )
    word = render_document(
        compiled.document, ledger=compiled.ledger, design=design, messages=messages
    )
    pdf = render_print_pdf(
        compiled.document,
        front_matter_sections=[],
        chart_vectors=word.chart_vectors,
        chart_tables=word.chart_tables,
        design=design,
        messages=messages,
        title="Sample PostgreSQL inventory" if args.postgresql else "Sample selected metrics",
    )
    root = Path(__file__).resolve().parents[3] / "artifacts/design-preview/production"
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{filename}.pdf"
    path.write_bytes(pdf.pdf_bytes)
    (root / f"{filename}.docx").write_bytes(word.docx_bytes)
    text, pages = read_pdf_text(path)
    missing = [
        figure.formatted
        for key, figure in compiled.ledger.entries.items()
        if str(key) not in pdf.omitted_figure_paths
        and not is_located(normalize(figure.formatted), text, decimal=".", grouping=",")
    ]
    assert not missing, missing
    print(f"{pages} pages; {len(word.chart_vectors)} charts; all displayed figures verified")


if __name__ == "__main__":
    main()
