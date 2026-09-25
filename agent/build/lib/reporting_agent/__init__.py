"""The deterministic utilization collector that runs on Bedrock AgentCore Runtime.

No module in this package calls a model. `config.py`, `errors.py`, `events.py`,
`redaction.py`, `heartbeat.py`, `progress.py` and `main.py` are in place; the two
command handlers `main.py` routes to are seams filled in by the preflight and
collection tasks. This file exists so the package is importable from the moment the
tree does.

It also owns one piece of environment: matplotlib's backend (Req 22.14).
"""

from __future__ import annotations

import os
import sys

# The only backend a headless container can use, and the only one that renders
# reproducibly. Never an interactive backend, in any environment.
_CHART_BACKEND = "Agg"
_CHART_BACKEND_ENV_VAR = "MPLBACKEND"


def _select_chart_backend() -> None:
    """Pin matplotlib to Agg, whether or not matplotlib is already imported.

    Matplotlib resolves its backend **once**, when it is first imported, from
    `MPLBACKEND` — falling back to whatever GUI toolkit it can find, which on a
    developer machine with a display is an interactive backend. So the variable has to
    be in place before that import, and this is the earliest point every process
    shares: the container entrypoint is `python -m reporting_agent.main`, the suite puts
    `src` on the path, and either way this package's `__init__` runs before any module
    of ours can import matplotlib.

    Deliberately here rather than in a test fixture or only as a Dockerfile `ENV`: a
    fixture would prove nothing about the image, and an image-only variable would leave
    the suite asserting a backend it did not configure.

    The second half is what makes the guarantee **structural rather than ordering-
    dependent**. A process that imported matplotlib before importing us — a test module
    that touches matplotlib and nothing of ours, a future entrypoint that imports a
    third-party library first — has already resolved a backend, and setting the
    variable afterwards would be silently too late. Forcing it closes that window; the
    branch is dead in the container, where nothing imports matplotlib before this file
    runs.

    `setdefault`, not assignment, so an explicit `MPLBACKEND=…` still wins for local
    experimentation. This is the default, not the determinism guarantee: the chart
    renderer freezes the backend and one `rcParams` block at use, and that is where
    byte-identical images are enforced.
    """
    os.environ.setdefault(_CHART_BACKEND_ENV_VAR, _CHART_BACKEND)
    preloaded = sys.modules.get("matplotlib")
    if preloaded is not None:
        preloaded.use(os.environ[_CHART_BACKEND_ENV_VAR], force=True)


_select_chart_backend()
