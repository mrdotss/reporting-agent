"""The verifier — the delivery gate.

Nothing in this package may reach the network or a cloud SDK. `verify/replay.py`
proves the snapshot reproduces from its archived responses, and a replay that can
re-query is not proving determinism, it is re-collecting; the boundary guard in
`agent/tests/test_boundaries.py` enforces that as an import-closure walk rather
than as a convention.
"""
