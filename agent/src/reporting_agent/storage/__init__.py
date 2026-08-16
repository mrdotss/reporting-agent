"""The `ObjectStore` protocol (`base.py`) and its boto3 implementation (`s3.py`).

The protocol is what lets `archive.py` and `snapshot.py` run against an in-memory store
in tests. It carries a conditional put and no delete: a written snapshot is never
modified, rewritten or removed.
"""
