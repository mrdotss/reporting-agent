"""The declarative metric catalog: `metrics.v1.json` plus its loader.

The catalog is data, not code (Req 32.8): `metrics.v1.json` ships in the container
image and `loader.py` is the only module that reads it, validates every entry, and
freezes the result into a `LoadedCatalog`. Nothing here imports an Azure SDK, so the
catalog is unit-testable without a subscription.
"""
