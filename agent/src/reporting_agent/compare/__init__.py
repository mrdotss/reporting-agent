"""Run-to-run comparison: `compare/delta.py` and nothing else.

Its own package rather than a module under `compile/`, because a delta reads **two** snapshots
where every other compile-stage module reads one. Keeping that asymmetry visible in the
directory layout is what stops a future block from quietly acquiring a second snapshot.

No Azure SDK, no client, no clock — a delta is computed from two stored snapshots and nothing
else (Req 16.7).
"""
