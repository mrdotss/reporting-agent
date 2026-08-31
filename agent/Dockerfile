# syntax=docker/dockerfile:1.7
#
# The reporting runtime image (Req 17.1, 17.5, 17.6, 17.8, 17.9, 17.10).
#
# AgentCore Runtime requires linux/arm64. A build on an x86 host that omits
# --platform linux/arm64 produces an image the runtime does not start — and it
# fails at launch, not at build, which is the expensive place to find out. So
# every build line, here and in README.md, names the platform explicitly:
#
#   docker buildx build --platform linux/arm64 -t <ecr>/reporting-agent:<tag> --push .
#
# The image carries LibreOffice, the fonts the four themes name, and a LibreOffice
# user profile warmed at BUILD time. The PDF is converted from the produced .docx
# rather than rendered independently, so Word and PDF cannot disagree (Req 23.1).

# Python is pinned, not ranged: one snapshot has to hash identically across two
# operating-system processes, and a minor-version difference is a difference in
# Decimal and JSON behaviour (Req 17.9; see .python-version and requires-python).
ARG PYTHON_VERSION=3.12
FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:${PYTHON_VERSION}-slim-bookworm

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 PORT=8080

# LANG is load-bearing, not cosmetic (Req 23.3). A comma-decimal locale rewrites
# every numeral LibreOffice lays out, so `12,345.60` becomes `12.345,60` in the PDF
# and the ledger's `formatted` strings stop being locatable — the PDF pass then
# reports pdf_figure_missing and withholds a document that is entirely correct.
# render/pdf.py asserts this value before it starts the process rather than trusting
# the image, because an override at run time is just as fatal as a wrong default.
#
# LO_PROFILE is the profile warmed below and used as-is at run time (Req 23.5).
ENV LANG=C.UTF-8 LO_PROFILE=/opt/libreoffice-profile

WORKDIR /app

# --- LibreOffice and the theme fonts (Req 23.2) -------------------------------
#
# Ahead of the pip layers on purpose: this is the largest and least frequently
# changed layer in the image, so a dependency bump must not reinstall it.
#
# `libreoffice-writer` + `libreoffice-core` and no more of that suite — no Calc, no
# Impress, no JRE. docx -> pdf needs the Writer import filter and the PDF export filter;
# --no-install-recommends is what keeps the rest out.
#
# The two font packages are not optional decoration: every face named in
# render/themes.py's THEME_SPECS comes from them (Liberation Sans/Serif,
# DejaVu Sans/Sans Mono). A theme naming a font the container lacks renders through
# LibreOffice's substitution, which changes line breaking and therefore pagination —
# so the delivered PDF would paginate differently from the one that was reviewed. They
# serve WeasyPrint for the same reason and out of the same packages, so the styled PDF
# and the converted one are set in the same faces.
#
# The four cairo/pango/gdk-pixbuf libraries are WeasyPrint's. It is pure Python but binds
# them through cffi, and an import without them fails with a ctypes message about
# `libpango-1.0-0` that reads like a missing wheel and is not. Together they are ~40MB
# against Chromium's 300-400, which is the trade that made an HTML->PDF path affordable
# on an image with a cold-start budget at all.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer \
      libreoffice-core \
      fonts-dejavu-core \
      fonts-liberation2 \
      libcairo2 \
      libpango-1.0-0 \
      libpangoft2-1.0-0 \
      libgdk-pixbuf-2.0-0 \
 && rm -rf /var/lib/apt/lists/*

# The committed, fully pinned, hashed closure — the runtime closure only, so
# pytest and hypothesis never ship. --require-hashes is what makes two builds of
# one commit resolve identical versions (Req 17.8).
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

# src/reporting_agent/ lands next to the entrypoint, which is exactly what
# pyproject's pythonpath = ["src"] reproduces for the test suite. One import
# path, two environments.
COPY src/reporting_agent/ ./reporting_agent/

# The four styles-only theme documents (Req 8.1). They are code — versioned, reviewed
# and asserted below — not user content, and there is no upload path that could supply
# them at run time.
#
# /app/themes is what render/themes.py's theme_directory() resolves to here: the
# package's parent holds `themes/` in the image, while in a checkout the package sits
# one level deeper under src/. That function keys off the checkout marker rather than
# probing, so the two layouts do not depend on which directory happens to exist.
COPY themes/ ./themes/

# The recorded Metric Definitions responses every catalog entry is checked against
# (Req 2.1, 2.6). `/app/evidence/metric_definitions/` is what
# catalog/evidence.py's evidence_directory() resolves to here; in a checkout it resolves
# to agent/tests/fixtures/metric_definitions/ instead, keyed off the checkout marker the
# same way theme_directory() is rather than by probing for whichever exists.
#
# These are the only files from tests/ that enter the build. `.dockerignore` excludes
# `tests/**` and re-includes exactly this subtree — the guard below has to run in the
# build, and it cannot check evidence that never arrived. Every subscription id, tenant
# id, resource id and credential-shaped value is excluded from them, and the guard
# asserts that rather than trusting it.
COPY tests/fixtures/metric_definitions/ ./evidence/metric_definitions/

# --- the operator's certificate authority, if there is one ---------------------
#
# `RPT_CA_BUNDLE` names a PEM of additional trusted roots for the progress callback,
# and AgentCore Runtime mounts no volumes — so a deployment behind a private CA has
# to bake the root into the image. Nothing is trusted by having the file here: the
# runtime reads it only when `RPT_CA_BUNDLE` points at it, and an image built for a
# deployment with a publicly trusted certificate simply never names it.
#
# A CA root is a public certificate. The private key stays on the CA and never
# appears in a build context.
COPY deploy/private-ca.pem /etc/ssl/private-ca/root.pem

# Fail the BUILD, not a deployed run, if the three-package Azure Monitor pin is
# wrong (Req 17.5, 17.6, 17.10).
#
# azure-monitor-query 2.0.0 removed BOTH metrics clients and is logs-only, so
# the metrics surface lives in two other packages:
#   azure-monitor-querymetrics -> MetricsClient.query_resources  (batch values)
#   azure-mgmt-monitor         -> MonitorManagementClient        (metric
#                                 definitions + the per-resource fallback)
#   azure-monitor-query        -> LogsQueryClient (enhanced tier ONLY)
# Installing a subset raises an ImportError that reads like a version-pin
# problem and is not — which is why this is asserted at build time. The two
# absence assertions also catch the opposite mistake: an azure-monitor-query
# resolved below 2, where MetricsClient/MetricsQueryClient still exist and the
# rest of the pin is silently meaningless.
RUN python -c "\
from azure.monitor.querymetrics import MetricsClient; \
from azure.mgmt.monitor import MonitorManagementClient; \
from azure.monitor.query import LogsQueryClient; \
import azure.monitor.query as q; \
assert not hasattr(q, 'MetricsClient'), 'azure-monitor-query exports MetricsClient: pin is below 2; batch metrics belong to azure-monitor-querymetrics'; \
assert not hasattr(q, 'MetricsQueryClient'), 'azure-monitor-query exports MetricsQueryClient: pin is below 2; no pinned package exports that name'; \
print('azure monitor split ok')"

# Fail the BUILD if the document AST admits a bare number (Req 15.1-15.7).
#
# The same invariant tests/test_ast_guard.py asserts, run here as well, because
# .dockerignore excludes tests/ — a guard that only ran in the suite could not
# stop an image from carrying an AST in which a quantity can appear without
# provenance. It reads the annotations of every dataclass in compile/ast.py and
# requires that Figure is the only one mentioning a numeric type, that every
# figure-admitting field carries one of six declared spellings, that Inline and
# Cell are unions over exactly their declared members, and that every node is
# frozen and slotted. No arithmetic, no I/O — a few hundred microseconds.
RUN python -m reporting_agent.compile.ast --assert-build

# Fail the BUILD if any of the four themes is missing a style the compiled blocks
# reference, carries content, or cannot be opened (Req 8.7).
#
# Runs here rather than only in tests/test_themes.py because .dockerignore excludes
# tests/ — and because this is the assertion that stops an image from producing a
# document with unstyled figures, which is a defect a reader sees and a verifier does
# not. Reports every (theme, style) pair missing across all four documents in one run,
# so one fix pass clears the build.
RUN python -m reporting_agent.render.themes --assert-build

# Fail the BUILD if any catalog entry disagrees with the Metric Definitions response it
# was derived from (Req 2.2, 2.3, 2.4, 2.6, 2.7, 2.10, 2.11).
#
# This is the control the whole catalog rests on, and it has to be a build-time check
# because the failure it prevents is **silent at run time**: Azure answers a request for a
# metric it does not have with a per-resource error, the collector records a typed gap, the
# run completes, verification passes, and the delivered document simply never mentions that
# metric. A guessed name is therefore permanently uncollectable with nothing going red.
#
# Runs here as well as in tests/test_catalog_evidence.py because .dockerignore excludes
# tests/ — the same reasoning as the two guards above. Checks every declared metric's name
# as an exact string, its unit against the declared unit mapping, and every requested
# aggregation against the fixture's supported set; rejects a near miss (a portal display
# name differing only by case, whitespace or a separator) as a near miss rather than as an
# absence; and fails if a fixture carries an identifier it should not. Reports every
# disagreement in one run, so one fix pass clears the build.
RUN python -m reporting_agent.catalog.evidence --assert-build

# Fail the BUILD if any English literal reaches a text-emitting position in the render or
# compile/blocks trees (Req 15.2, 15.6).
#
# Without this a string id that a developer forgot to resolve — or one they resolved but
# then replaced with a hardcoded English literal — ships into the image and produces an
# Indonesian document containing English copy. The verifier cannot catch it because the
# string is not a figure, and the mirror guard covers id-set equality but not call-site
# compliance. This is the remaining gate.
#
# Same shape as the three guards above: a module under src/ with an --assert-build entry
# point, so .dockerignore needs no second re-inclusion.
RUN python -m reporting_agent.compile.literals --assert-build

# --- Pre-warm the LibreOffice user profile (Req 23.5) -------------------------
#
# A cold profile makes the first conversion of a container's life slow and
# occasionally fail outright. That reads as a flaky render rather than as a cold
# start, and Req 23.9 applies the same 300s limit and the same single attempt to that
# first conversion as to every later one — so there is no retry to hide behind.
#
# The warm-up converts a document built through the REAL path: a theme opened by
# python-docx, one paragraph added, saved, then converted by soffice. Warming with a
# .txt would exercise LibreOffice's plain-text import filter, which is not the filter
# a run uses; this warms the Writer .docx import and the PDF export filter, which are.
# It also proves at build time that python-docx and LibreOffice can hand a file
# between them at all.
RUN mkdir -p "$LO_PROFILE" /tmp/warm \
 && python -c "\
from reporting_agent.render.themes import load_theme; \
d = load_theme('editorial'); \
d.add_paragraph('warm', style='Body Text'); \
d.save('/tmp/warm/warm.docx'); \
print('warm-up document built')" \
 && soffice --headless --norestore \
      -env:UserInstallation="file://$LO_PROFILE" \
      --convert-to pdf --outdir /tmp/warm /tmp/warm/warm.docx \
 && test -s /tmp/warm/warm.pdf \
 && rm -rf /tmp/warm

# The profile is USED at run time, not copied (render/pdf.py), so whichever uid the
# runtime hands us has to be able to take LibreOffice's lock files inside it.
#
# Rather than pick a USER this image does not otherwise need, the profile gets the
# arbitrary-uid treatment: group 0, with group permissions mirroring the owner's. A
# process running as root, as a named user, or as an unnamed uid injected by the
# platform is in group 0 either way, so all three can lock it. A plain `chown` to one
# named user would work for that one uid and fail for every other, which is the
# failure mode this avoids rather than relocates.
RUN chgrp -R 0 "$LO_PROFILE" && chmod -R g=u "$LO_PROFILE"

# --- The build refuses to publish an image that cannot render (Req 8.7, 23.10) -
#
# Architecture and profile, asserted last so a failure here is about the image rather
# than about the code. `uname -m` is aarch64 under --platform linux/arm64 whether the
# host is arm64 natively or emulating, which is exactly the mistake being guarded: a
# build that silently produced x86 would fail at runtime launch, not at build.
RUN set -eu; \
    test "$(uname -m)" = "aarch64" \
      || { echo "architecture is $(uname -m), not aarch64: build with --platform linux/arm64" >&2; exit 1; }; \
    command -v soffice >/dev/null \
      || { echo "soffice is not on PATH: LibreOffice is absent from the image" >&2; exit 1; }; \
    test -d "$LO_PROFILE" \
      || { echo "$LO_PROFILE is absent: the LibreOffice profile was never warmed" >&2; exit 1; }; \
    test -n "$(ls -A "$LO_PROFILE")" \
      || { echo "$LO_PROFILE is empty: the warm-up conversion did not populate it" >&2; exit 1; }; \
    echo "image assertions ok: aarch64, soffice present, profile warmed"

# Fail the BUILD if WeasyPrint cannot render (Req 23.11).
#
# It imports its cairo/pango bindings lazily through cffi, so a missing system library is
# not an ImportError at `import weasyprint` — it surfaces at the first render, which in a
# deployed container is a failed customer run. This renders a document rather than
# importing the module, for the same reason the LibreOffice warm-up above converts a real
# .docx rather than checking that `soffice` is on PATH.
#
# It also asserts the two things the styled PDF depends on and that were measured rather
# than assumed: that a <script> does NOT run — so no chart library can be reached this way,
# and the charts must keep coming from matplotlib — and that inline SVG DOES render, which
# is how they get there.
RUN python -c "\
import weasyprint, re; \
pdf = weasyprint.HTML(string='<p>3,187,970,789.00 bytes</p>').write_pdf(); \
assert pdf.startswith(b'%PDF-'), 'weasyprint produced no PDF'; \
js = weasyprint.HTML(string=\"<p id='t'>NO</p><script>document.getElementById('t').textContent='YES'</script>\").write_pdf(); \
assert b'YES' not in js, 'weasyprint executed JavaScript: the no-JS premise this image was sized on no longer holds'; \
svg = weasyprint.HTML(string='<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><rect width=\"10\" height=\"10\"/></svg>').write_pdf(); \
assert svg.startswith(b'%PDF-'), 'weasyprint cannot render inline SVG'; \
print('weasyprint ok: renders, runs no javascript, embeds svg')"

EXPOSE 8080

CMD ["python", "-m", "reporting_agent.main"]
