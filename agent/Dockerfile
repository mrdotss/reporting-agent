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
# LibreOffice, the theme fonts and a pre-warmed LibreOffice profile are NOT
# installed here. They belong to the render spec; adding them now would bake a
# several-hundred-megabyte layer for code that does not exist yet.

# Python is pinned, not ranged: one snapshot has to hash identically across two
# operating-system processes, and a minor-version difference is a difference in
# Decimal and JSON behaviour (Req 17.9; see .python-version and requires-python).
ARG PYTHON_VERSION=3.12
FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:${PYTHON_VERSION}-slim-bookworm

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 PORT=8080

WORKDIR /app

# The committed, fully pinned, hashed closure — the runtime closure only, so
# pytest and hypothesis never ship. --require-hashes is what makes two builds of
# one commit resolve identical versions (Req 17.8).
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

# src/reporting_agent/ lands next to the entrypoint, which is exactly what
# pyproject's pythonpath = ["src"] reproduces for the test suite. One import
# path, two environments.
COPY src/reporting_agent/ ./reporting_agent/

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

EXPOSE 8080

CMD ["python", "-m", "reporting_agent.main"]
