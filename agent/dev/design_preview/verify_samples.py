"""Check the actual generated samples; run after the Node sample generator."""
import json
from pathlib import Path
from pypdf import PdfReader
from reporting_agent.verify.pdf import is_located, normalize
from reporting_agent.verify.tokens import read_pdf_text

root = Path(__file__).resolve().parents[3] / "artifacts/design-preview"
hashes = set()
for name in ("corporate", "editorial", "technical", "minimal", "long-name", "missing", "empty", "low", "overflow", "tuned"):
    path = root / f"{name}.pdf"
    if not path.exists():
        if name in ("corporate", "editorial", "technical", "minimal"):
            raise AssertionError(f"Missing required sample: {path}")
        continue
    manifest = json.loads(path.with_suffix(".manifest.json").read_text())
    text, pages = read_pdf_text(path)
    for figure in manifest["displayed_figures"]:
        assert is_located(normalize(figure["formatted"]), text, decimal=".", grouping=","), (name, figure)
    pdf = PdfReader(path)
    assert all(page.extract_text().strip() for page in pdf.pages), name
    assert "SAMPLE OUTPUT" in text, name
    if name in ("corporate", "editorial", "technical", "minimal"):
        assert pages == 2, (name, pages)
        hashes.add(manifest["chart_data_hash"])
    if name == "overflow":
        assert pages > 2
        assert text.count("Daily averages remain low") == 32
    if name == "long-name":
        assert "long-resource-name" in text
    width = float(pdf.pages[0].mediabox.width)
    assert abs(width - (612 if manifest["settings"]["page_size"] == "Letter" else 595.276)) < 1
    if name != "empty":
        svg = path.with_suffix(".svg").read_text()
        assert "<path" in svg and "<image" not in svg and "NaN" not in svg
        assert "Daily" in text and "CPU" in text
    print(f"{name}: {pages} pages; {len(manifest['displayed_figures'])} displayed figures located; page size and SVG checked")
assert len(hashes) == 1, "Theme selection changed chart data"
